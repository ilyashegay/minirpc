import {
	type ClientRoutes,
	type ServerMessage,
	type SocketData,
	makeMessageParser,
	makeMessageSender,
	invariant,
} from './utils.js'

export type Options = {
	protocols?: string[]
	signal?: AbortSignal
	backoff?: BackoffOptions
	WebSocket?: WebSocketLike
}

export type WebSocketClientOptions = Options & {
	url: string
	onConnection?: (connection: Connection) => void | PromiseLike<void>
	onMessage: (message: SocketData, isBinary: boolean) => void
}

export type Connection = {
	protocol: string
	extensions: string
	closed: Promise<CloseEvent>
	send(message: SocketData): void
	close(code?: number, reason?: string): void
}

type WebSocketLike = new (
	url: string,
	protocols?: string | string[],
) => WebSocket

type BackoffOptions = {
	jitter: boolean
	maxDelay: number
	numOfAttempts: number
	retry: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>
	startingDelay: number
	timeMultiple: number
}

type PromiseHandle<T> = {
	resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
	reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
}

export function createClient<Router extends ClientRoutes>() {
	let nextRequestId = 1
	let sender: ReturnType<typeof makeMessageSender>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const queries = new Map<number, PromiseHandle<any>>()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const observers = new Set<(value: any) => void>()

	function subscribe<T>(observer: (value: T) => void, signal?: AbortSignal) {
		observers.add(observer)
		signal?.addEventListener('abort', () => {
			observers.delete(observer)
		})
	}

	function handleMessage(message: ServerMessage) {
		if ('event' in message) {
			for (const observer of observers) {
				observer(message.event)
			}
			return
		}
		const handle = queries.get(message.id)
		if (!handle) {
			console.error(`Unknown response ID: ${message.id}`)
			return
		}
		queries.delete(message.id)
		if ('result' in message) {
			handle.resolve(message.result)
		} else {
			handle.reject(
				typeof message.error === 'string' ? message.error : 'request failed',
			)
		}
	}

	function query<P extends unknown[], R>(method: string, params: P) {
		return new Promise<R>((resolve, reject) => {
			const id = nextRequestId++
			sender({ id, method, params })
			queries.set(id, { resolve, reject })
		})
	}

	const router = new Proxy({} as Router, {
		get(_, prop) {
			return (...args: unknown[]) => {
				if (typeof prop === 'string') {
					return query(prop, args)
				}
			}
		},
	})

	async function listen(
		url: string,
		handler: (connection: Connection) => void | PromiseLike<void>,
		options: Options = {},
	) {
		invariant(!sender, 'Already listening')
		const parser = makeMessageParser()
		const client = createWebSocketClient({
			url,
			onConnection: handler,
			onMessage(data, isBinary) {
				const message = parser(data, isBinary) as ServerMessage | undefined
				if (message === undefined) return
				handleMessage(message)
			},
			...options,
		})
		sender = makeMessageSender(client.send)
		setInterval(() => {
			client.send('heartbeat')
		}, 15_000)
		return client.listen()
	}

	return { router, subscribe, listen }
}

function getBackoffDelay(attempt: number, options: BackoffOptions) {
	const delay = Math.min(
		options.startingDelay * Math.pow(options.timeMultiple, attempt),
		options.maxDelay,
	)
	return options.jitter ? Math.round(Math.random() * delay) : delay
}

async function connect(
	url: string,
	options: {
		WebSocket: WebSocketLike
		aborted: Promise<never>
		protocols?: string | string[]
		backoff: BackoffOptions
	},
) {
	for (let attempt = 0; ; ) {
		const ws = new options.WebSocket(url, options.protocols)
		if (ws.binaryType === 'blob') {
			ws.binaryType = 'arraybuffer'
		}
		try {
			await Promise.race([
				options.aborted,
				new Promise<void>((resolve, reject) => {
					ws.addEventListener('open', () => {
						resolve()
						ws.removeEventListener('error', reject)
					})
					ws.addEventListener('error', reject)
				}),
			])
			return ws
		} catch (error) {
			attempt++
			const shouldRetry = await options.backoff.retry(error, attempt)
			if (!shouldRetry || attempt >= options.backoff.numOfAttempts) {
				throw error
			}
			await Promise.race([
				new Promise<void>((resolve) => {
					setTimeout(resolve, getBackoffDelay(attempt, options.backoff))
				}),
				options.aborted,
			])
		}
	}
}

function abortSignalToRejectedPromise(signal?: AbortSignal) {
	if (!signal) return new Promise<never>(() => undefined)
	if (signal.aborted) {
		throw new DOMException('This operation was aborted', 'AbortError')
	}
	return new Promise<never>((_, reject) => {
		signal.addEventListener('abort', () => {
			reject(new DOMException('This operation was aborted', 'AbortError'))
		})
	})
}

export function createWebSocketClient(options: WebSocketClientOptions) {
	const aborted = abortSignalToRejectedPromise(options.signal)
	const backOffOptions = {
		jitter: false,
		maxDelay: Infinity,
		numOfAttempts: 10,
		retry: () => true,
		startingDelay: 100,
		timeMultiple: 2,
		...(options.backoff ?? {}),
	}
	let queue: SocketData[] | undefined
	let connection: Connection | undefined
	function send(message: SocketData) {
		if (connection) {
			connection.send(message)
		} else {
			queue ??= []
			queue.push(message)
		}
	}
	function onMessageEvent(message: MessageEvent<SocketData>) {
		options.onMessage(message.data, typeof message.data !== 'string')
	}
	async function listen() {
		try {
			for (;;) {
				const ws = await connect(options.url, {
					WebSocket: options.WebSocket ?? WebSocket,
					aborted,
					protocols: options.protocols,
					backoff: backOffOptions,
				})
				ws.addEventListener('message', onMessageEvent)
				if (queue?.length) {
					for (const message of queue) {
						ws.send(message)
					}
					queue = undefined
				}
				connection = {
					protocol: ws.protocol,
					extensions: ws.extensions,
					closed: Promise.race([
						aborted,
						new Promise<CloseEvent>((resolve) => {
							ws.addEventListener('close', resolve)
						}),
					]),
					send(data: SocketData) {
						ws.send(data)
					},
					close(code?: number, reason?: string) {
						ws.close(code, reason)
					},
				}
				await options.onConnection?.(connection)
				await connection.closed
				connection = undefined
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return
			}
		} finally {
			connection?.close()
		}
	}

	return { send, listen }
}
