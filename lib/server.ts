import http from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
	type ClientRoutes,
	type ServerRoutes,
	type DevalueTransforms,
	type SocketData,
	type ClientMessage,
	type ServerMessage,
	makeMessenger,
	invariant,
} from './utils.js'

export { type DevalueTransforms }

export class RPCClientError extends Error {}

export type Connection = {
	close: (code?: number, data?: string | Buffer) => void
	terminate: () => void
}

export type Options = {
	port?: number
	signal?: AbortSignal
	heartbeat?: number
	onRequest?: http.RequestListener
	onUpgrade?: (
		request: http.IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => number | undefined | Promise<number | undefined>
	onConnection?: (
		connection: Connection,
	) => ((event: { code: number; reason: string }) => void) | undefined
}

export function createServer(
	onError: (error: unknown) => void,
	transforms?: DevalueTransforms,
) {
	const methods: ServerRoutes = {}
	let wss: WebSocketServer

	function router<Routes extends ServerRoutes>(routes: Routes) {
		for (const key of Object.keys(routes)) {
			if (key in methods) throw new Error(`Duplicate method ${key}`)
			methods[key] = routes[key]
		}
		return {} as ClientRoutes<Routes>
	}

	function listen(options: Options = {}) {
		invariant(!wss, 'Already Listening')
		const heartbeats = new WeakMap<WebSocket, number>()
		wss = new WebSocketServer({ noServer: true })
		wss.on('connection', (ws) => {
			const abortController = new AbortController()
			const messenger = makeMessenger(
				(data) => {
					ws.send(data)
				},
				abortController.signal,
				transforms,
			) as {
				parse: (data: SocketData) => ClientMessage | 'heartbeat' | undefined
				send: (message: ServerMessage) => void
			}
			heartbeats.set(ws, Date.now())
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			ws.on('message', async (data, isBinary) => {
				invariant(Buffer.isBuffer(data))
				const request = messenger.parse(isBinary ? data : data.toString())
				if (request === 'heartbeat') {
					heartbeats.set(ws, Date.now())
					return
				}
				if (request === undefined) return
				try {
					const { id, method, params } = request
					if (method in methods) {
						const result: unknown = await methods[method](...params)
						messenger.send({ id, result: result ?? null })
					} else {
						messenger.send({ id, error: `Unknown method: ${method}` })
					}
				} catch (error) {
					if (error instanceof RPCClientError) {
						messenger.send({ id: request.id, error: error.message })
					} else {
						messenger.send({ id: request.id, error: true })
						onError(error)
					}
				}
			})
			const unsubscribe = options.onConnection?.({
				close: ws.close.bind(ws),
				terminate: ws.terminate.bind(ws),
			})
			if (unsubscribe) {
				ws.once('close', (code, reason) => {
					abortController.abort(reason.toString())
					unsubscribe({ code, reason: reason.toString() })
				})
			}
		})
		const interval = setInterval(() => {
			const limit = Date.now() - (options.heartbeat ?? 60e3)
			for (const ws of wss.clients) {
				if (heartbeats.get(ws)! < limit) {
					ws.terminate()
					continue
				}
			}
		}, 10e3)
		const server = http.createServer(
			options.onRequest ??
				((req, res) => {
					const body = http.STATUS_CODES[426]
					res.writeHead(426, {
						'Content-Length': body!.length,
						'Content-Type': 'text/plain',
					})
					res.end(body)
				}),
		)
		const checkUpgrade = async (
			request: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => {
			if (!options.onUpgrade) return 101
			socket.on('error', onError)
			try {
				return await options.onUpgrade(request, socket, head)
			} catch (error) {
				onError(error)
				return 403
			}
		}
		const handleUpgrade = async (
			request: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => {
			let code = await checkUpgrade(request, socket, head)
			if (!code || socket.destroyed) return
			if (code === 101) {
				wss.handleUpgrade(request, socket, head, (ws) =>
					wss.emit('connection', ws, request),
				)
			} else {
				if (code < 400 || !(code in http.STATUS_CODES)) code = 500
				socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n\r\n`)
				socket.destroy()
			}
		}
		server.on('upgrade', (request, socket, head) => {
			void handleUpgrade(request, socket, head)
		})
		server.on('error', onError)
		options.signal?.addEventListener('abort', () => {
			clearInterval(interval)
			server.close()
			wss.close()
		})
		return new Promise<void>((resolve) => {
			server.listen(options.port ?? process.env.PORT ?? 3000, resolve)
		})
	}

	return { router, listen }
}
