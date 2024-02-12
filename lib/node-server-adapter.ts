import http from 'node:http'
import { once } from 'node:events'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Server } from './server.js'
import { invariant, connectionClosedException } from './utils.js'

type UpgradeContext = {
	request: http.IncomingMessage
	upgrade(): WebSocket
	error(code: number): void
}

export default async function serve(
	server: Server,
	options: {
		port?: number
		signal?: AbortSignal
		onRequest?: http.RequestListener
		onUpgrade?: (ctx: UpgradeContext) => unknown
		onError?: (error: unknown) => void
	} = {},
) {
	options.signal?.throwIfAborted()
	const onError = options.onError ?? console.error.bind(console)
	const wss = new WebSocketServer({ noServer: true })
	const hts = http.createServer(
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
	hts.on('upgrade', (request, socket, head) => {
		if (!options.onUpgrade) {
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit('connection', ws, request)
			})
			return
		}
		const ctx: UpgradeContext = {
			request,
			upgrade() {
				let result: WebSocket | undefined
				wss.handleUpgrade(request, socket, head, (ws) => {
					result = ws
					wss.emit('connection', ws, request)
				})
				invariant(result)
				return result
			},
			error(code) {
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
			},
		}
		try {
			Promise.resolve(options.onUpgrade(ctx)).catch((error) => {
				onError(error)
				ctx.error(500)
			})
		} catch (error) {
			onError(error)
			ctx.error(500)
		}
	})
	wss.on('connection', (ws) => {
		const client = server.connect({
			key: ws,
			send: (data) => {
				ws.send(data)
			},
			close: () => {
				ws.terminate()
			},
		})
		ws.on('message', (data, isBinary) => {
			invariant(Buffer.isBuffer(data))
			client.message(isBinary ? data : data.toString())
		})
		ws.on('close', () => {
			client.close(connectionClosedException)
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
