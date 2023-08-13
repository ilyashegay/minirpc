import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import {
	type SafeRouter,
	type UnsafeRouter,
	type Request,
	type Response,
	RPCClientError,
	makeMessageParser,
	stringifySimple,
	makeMessageSender,
} from './utils.js'

export * from './utils.js'

function safety<P extends unknown[], R extends Promise<unknown>>(
	fn: (...args: P) => R,
) {
	return async (...args: P) => {
		try {
			return await fn(...args)
		} catch (error) {
			return Promise.reject<R>(error)
		}
	}
}

export type Connection<T> = {
	send(event: T): void
	close(code?: number, data?: string | Buffer): void
	terminate(): void
}

export function createServer<T>(onError: (error: unknown) => void) {
	const methods: SafeRouter = {}
	let wss: WebSocketServer | undefined

	function handleMessage(
		methods: SafeRouter,
		request: Request,
		callback: (response: Response, error?: unknown) => void,
	) {
		if (!(request.method in methods)) {
			callback({ id: request.id, error: `Unknown method: ${request.method}` })
			return
		}
		methods[request.method](...request.params)
			.then((result) => {
				callback({ id: request.id, result: result ?? null })
			})
			.catch((error: unknown) => {
				let message: string | true = true
				if (error instanceof RPCClientError) {
					message = error.message
					error = undefined
				}
				callback({ id: request.id, error: message }, error)
			})
	}

	function router<Router extends UnsafeRouter>(router: Router) {
		const result = {} as SafeRouter<Router>
		for (const key of Object.keys(router)) {
			if (key in methods) throw new Error(`Duplicate method ${key}`)
			methods[key] = result[key as keyof Router] = safety(router[key])
		}
		return result
	}

	function broadcast(event: T) {
		if (!wss?.clients.size) return
		const message = stringifySimple({ event })
		for (const ws of wss.clients) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(message)
			}
		}
	}

	function listen(options: {
		port?: number
		signal?: AbortSignal
		authenticate?: (request: http.IncomingMessage) => boolean
		onRequest?: http.RequestListener
		onConnection: (
			connection: Connection<T>,
		) => ((event: WebSocket.CloseEvent) => void) | undefined
	}) {
		const alive = new WeakSet<WebSocket>()
		const wss = new WebSocketServer({ noServer: true })
		wss.on('connection', (ws) => {
			const parser = makeMessageParser()
			const sender = makeMessageSender((data) => {
				ws.send(data)
			})
			ws.on('message', (data, isBinary) => {
				if (!Buffer.isBuffer(data)) {
					throw new Error('Wrong Buffer Type')
				}
				const request = parser(data, isBinary) as
					| Request
					| 'heartbeat'
					| undefined
				if (request === 'heartbeat') {
					alive.add(ws)
					return
				}
				if (request === undefined) return
				handleMessage(methods, request, (response, error) => {
					if (error) onError(error)
					sender(response)
				})
			})
			const unsubscribe = options.onConnection({
				send(event) {
					sender({ event })
				},
				close(code, data) {
					ws.close(code, data)
				},
				terminate() {
					ws.terminate()
				},
			})
			if (unsubscribe) {
				ws.once('close', unsubscribe)
			}
		})
		const interval = setInterval(() => {
			for (const ws of wss.clients) {
				if (!alive.has(ws)) {
					ws.terminate()
					continue
				}
				alive.delete(ws)
			}
		}, 30000)
		const server = http.createServer(
			options.onRequest ??
				((req, res) => {
					const body = http.STATUS_CODES[426]
					res.writeHead(426, {
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						'Content-Length': body!.length,
						'Content-Type': 'text/plain',
					})
					res.end(body)
				}),
		)
		server.on('upgrade', (request, socket, head) => {
			socket.on('error', onError)
			try {
				if (options.authenticate && !options.authenticate(request)) {
					socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
					socket.destroy()
					return
				}
			} catch (error) {
				onError(error)
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
				socket.destroy()
				return
			}
			wss.handleUpgrade(request, socket, head, (ws) =>
				wss.emit('connection', ws, request),
			)
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

	return { router, broadcast, listen }
}
