import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import superjson from 'superjson'
import {
	type SafeRouter,
	type UnsafeRouter,
	type Request,
	type Response,
	RPCClientError,
} from './utils.js'

export * from './utils'

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

function handleMessage(
	methods: SafeRouter,
	req: Request | string,
	callback: (response: Response, error?: unknown) => void,
) {
	const request = typeof req === 'string' ? superjson.parse<Request>(req) : req
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

export type Connection<T> = {
	send(event: T): void
	close(code?: number, data?: string | Buffer): void
	terminate(): void
}

export function createServer<T>(onError: (error: unknown) => void) {
	const methods: SafeRouter = {}
	let wss: WebSocketServer | undefined

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
		const message = superjson.stringify({ event })
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
			ws.on('message', (data) => {
				handleMessage(methods, String(data), (response, error) => {
					if (error) onError(error)
					ws.send(superjson.stringify(response))
				})
			})
			ws.on('pong', () => {
				alive.add(ws)
			})
			const unsubscribe = options.onConnection({
				send(event) {
					ws.send(superjson.stringify({ event }))
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
				ws.ping()
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
