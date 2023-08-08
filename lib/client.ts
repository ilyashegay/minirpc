import { EtherealValue, controlledDuplex } from './utils'

export {
	createRPCClient,
	createRPCClientStream,
	RPCClientError,
	type SafeRouter,
	controlledDuplex,
	asyncForEach,
	Observable,
} from './utils'

export type WebSocketStreamOptions = {
	protocols?: string[]
	signal?: AbortSignal
	onerror?: (error: unknown) => void
}

type WebSocketStreamConnection = {
	protocol: string
	extensions: string
	closed: Promise<CloseEvent>
}

export class WebSocketStreamette<
	T extends Uint8Array | string = Uint8Array | string,
> {
	readonly url: string
	readonly opened: AsyncIterable<WebSocketStreamConnection>
	readonly readable: ReadableStream<T>
	readonly writable: WritableStream<T>

	constructor(url: string, options: WebSocketStreamOptions = {}) {
		if (options.signal?.aborted) {
			throw new DOMException('This operation was aborted', 'AbortError')
		}

		let done = false
		const socket = new EtherealValue<WebSocket>()
		const onerror = options.onerror ?? (() => undefined)
		this.url = url

		options.signal?.addEventListener('abort', () => {
			done = true
			socket.then((ws) => {
				ws.close()
			})
		})

		const duplex = controlledDuplex<T, T>({
			async transform(chunk) {
				const ws = await socket
				ws.send(chunk)
			},
			async flush() {
				done = true
				const ws = await socket
				ws.close()
			},
		})

		function wait() {
			if (done) return
			return new Promise((resolve) => {
				setTimeout(resolve, 5000)
			})
		}

		async function* connections(): AsyncIterable<WebSocketStreamConnection> {
			try {
				while (!done) {
					const ws = new WebSocket(url, options.protocols ?? [])
					ws.addEventListener('message', ({ data }) => {
						duplex.controller.enqueue(data as T)
					})
					const opened = new Promise<void>((resolve, reject) => {
						ws.addEventListener('open', () => {
							resolve()
							ws.removeEventListener('error', reject)
						})
						ws.addEventListener('error', reject)
					})
					const closed = new Promise<CloseEvent>((resolve, reject) => {
						ws.addEventListener('error', (error) => {
							socket.reset()
							reject(error)
						})
						ws.addEventListener('close', (event) => {
							socket.reset()
							resolve(event)
						})
					})
					socket.set(ws)
					try {
						await opened
					} catch (error) {
						onerror(error)
						await wait()
						continue
					}
					yield {
						closed,
						protocol: ws.protocol,
						extensions: ws.extensions,
					}
					await closed.catch(onerror)
					await wait()
				}
			} finally {
				duplex.controller.terminate()
			}
		}

		this.readable = duplex.readable
		this.writable = duplex.writable
		this.opened = connections()
	}
}
