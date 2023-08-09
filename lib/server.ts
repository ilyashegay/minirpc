import * as ws from 'ws'
import { controlledDuplex } from './utils.js'

export {
	createRPCServer,
	createRPCServerStream,
	RPCClientError,
	type SafeRouter,
	controlledDuplex,
	asyncForEach,
	Observable,
} from './utils.js'

export class WebSocketClient<
	T extends Uint8Array | string = Uint8Array | string,
> {
	readonly readable: ReadableStream<T>
	readonly writable: WritableStream<T>
	readonly closed: Promise<{ code?: number; reason?: string }>

	constructor(ws: ws.WebSocket) {
		const duplex = controlledDuplex<T, T>({
			start(controller) {
				ws.addEventListener('message', ({ data }) => {
					controller.enqueue(data as T)
				})
				ws.addEventListener('close', () => {
					controller.close()
				})
			},
			write(chunk) {
				ws.send(chunk)
			},
			close() {
				ws.close()
			},
		})
		this.readable = duplex.readable
		this.writable = duplex.writable
		this.closed = new Promise((resolve) => {
			ws.addEventListener('close', (event) => {
				resolve(event)
			})
		})
	}
}

export function listen<T extends Uint8Array | string = Uint8Array | string>(
	options: ws.ServerOptions,
	onConnection: (socket: WebSocketClient<T>) => unknown,
) {
	new ws.WebSocketServer(options).on('connection', (ws) => {
		onConnection(new WebSocketClient<T>(ws))
	})
}
