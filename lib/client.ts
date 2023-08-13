import {
	type SafeRouter,
	type Request,
	type ServerMessage,
	Observable,
	sleep,
	makeMessageParser,
	makeMessageSender,
} from './utils.js'

export * from './utils.js'

export type WebSocketClientOptions = {
	protocols?: string[]
	signal?: AbortSignal
	backoff?: BackoffOptions
	WebSocket?: WebSocketLike
}

export type WebSocketClientConnection = {
	protocol: string
	extensions: string
	closed: Promise<CloseEvent>
	send(message: string | Uint8Array): void
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

export function createClient<T, Router extends SafeRouter>() {
	let nextRequestId = 1
	const queries = new Map<number, PromiseHandle<unknown>>()
	const events = new Observable<T>()
	const requests = new Observable<Request>()

	function handleMessage(message: ServerMessage<T>) {
		if ('event' in message) {
			events.next(message.event)
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
			requests.next({ id, method, params } satisfies Request<P>)
			queries.set(id, { resolve, reject } as PromiseHandle<unknown>)
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
		handler: (
			connection: WebSocketClientConnection,
		) => void | PromiseLike<void>,
		options: WebSocketClientOptions = {},
	) {
		const parser = makeMessageParser()
		const client = createWebSocketClient({
			url,
			onConnection: handler,
			onMessage(data, isBinary) {
				const message = parser(data, isBinary) as ServerMessage<T> | undefined
				if (message === undefined) return
				handleMessage(message)
			},
			...options,
		})
		requests.subscribe(makeMessageSender(client.send))
		setInterval(() => {
			client.send('heartbeat')
		}, 20000)
		return client.listen()
	}

	return { router, events, listen }
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
				sleep(getBackoffDelay(attempt, options.backoff)),
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

export function createWebSocketClient(
	options: WebSocketClientOptions & {
		url: string
		onConnection?: (
			connection: WebSocketClientConnection,
		) => void | PromiseLike<void>
		onMessage: (message: string | Uint8Array, isBinary: boolean) => void
	},
) {
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
	let queue: (string | Uint8Array)[] | undefined
	let connection: WebSocketClientConnection | undefined
	function send(message: string | Uint8Array) {
		if (connection) {
			connection.send(message)
		} else {
			queue ??= []
			queue.push(message)
		}
	}
	function onMessageEvent(message: MessageEvent<string | Uint8Array>) {
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
					send(data: string | Uint8Array) {
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
