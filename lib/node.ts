import http from 'node:http'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import * as lib from './core.js'
import type { ClientRoutes, Client, Adapter, ServerServeOptions } from './types'

export {
	RPCClientError,
	connectionClosedException,
	createChannel,
	getContextKey,
	createContext,
} from './core.js'

const adapter: Adapter = async (options) => {
	options.signal.throwIfAborted()
	const ws = new WebSocket(options.url)
	ws.binaryType = 'nodebuffer'
	await new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			ws.off('error', onError)
			options.signal.removeEventListener('abort', onAbort)
			resolve()
		}
		const onError = (error: Error) => {
			ws.off('open', onOpen)
			options.signal.removeEventListener('abort', onAbort)
			reject(error)
		}
		const onAbort = () => {
			ws.off('open', onOpen)
			ws.off('error', onError)
			ws.close(1000)
			reject(options.signal.reason as Error)
		}
		ws.once('open', onOpen)
		ws.once('error', onError)
		options.signal.addEventListener('abort', onAbort)
	})
	ws.on('message', (data: Buffer, isBinary: boolean) => {
		options.message(isBinary ? data : data.toString())
	})
	ws.on('close', (code, reason) => {
		options.close(code, reason.toString())
	})
	return {
		message: (data) => {
			ws.send(data)
		},
		close: (code, reason) => {
			ws.close(code, reason)
		},
	}
}

export const connect: typeof lib.connect = (options) =>
	lib.connect('WebSocket' in globalThis ? options : { ...options, adapter })

export function createClient<Router extends ClientRoutes>(): Client<Router> {
	const client = lib.createClient<Router>()
	if ('WebSocket' in globalThis) return client
	return {
		router: client.router,
		connect: (options) => client.connect({ ...options, adapter }),
	}
}

export function createServer() {
	const server = lib.createServer()

	async function serve(options: ServerServeOptions = {}) {
		options.signal?.throwIfAborted()
		const onError = options.error ?? console.error.bind(console)
		const wss = new WebSocketServer({ noServer: true })
		const hts = http.createServer(
			options.request ??
				((req, res) => {
					const body = http.STATUS_CODES[426]
					res.writeHead(426, {
						'Content-Length': body!.length,
						'Content-Type': 'text/plain',
					})
					res.end(body)
				}),
		)
		hts.on('upgrade', (request, socket, head) => {
			if (!options.upgrade) {
				wss.handleUpgrade(request, socket, head, (ws) => {
					wss.emit('connection', ws, request)
				})
				return
			}
			function upgrade() {
				let result: WebSocket | undefined
				wss.handleUpgrade(request, socket, head, (ws) => {
					result = ws
					wss.emit('connection', ws, request)
				})
				return result!
			}
			function reject(code: number) {
				if (code < 400 || !(code in http.STATUS_CODES)) code = 500
				const status = http.STATUS_CODES[code]!
				const head = [
					`HTTP/1.1 ${code} ${status}`,
					'Connection: close',
					'Content-Type: text/plain',
					`Content-Length: ${Buffer.byteLength(status)}`,
				]
				socket.once('finish', () => socket.destroy())
				socket.end(`${head.join('\r\n')}\r\n\r\n${status}`)
			}
			void (async () => {
				await options.upgrade!({ request, upgrade, reject })
			})().catch((error) => {
				onError(error)
				reject(500)
			})
		})
		wss.on('connection', (ws) => {
			const client = server.connect({
				key: ws,
				transforms: options.transforms,
				pingTimeout: options.pingTimeout,
				pongTimeout: options.pongTimeout,
				message: (data) => {
					ws.send(data)
				},
				close: () => {
					ws.terminate()
				},
				error: options.error,
			})
			ws.on('message', (data: Buffer, isBinary) => {
				client.message(isBinary ? data : data.toString())
			})
			ws.on('close', () => {
				client.close(lib.connectionClosedException)
			})
		})
		options.signal?.addEventListener('abort', () => {
			hts.close()
			wss.close()
		})
		hts.listen(options.port ?? process.env.PORT ?? 3000)
		await once(hts, 'listening')
		hts.on('error', onError)
		wss.on('error', onError)
	}

	return { ...server, serve }
}
