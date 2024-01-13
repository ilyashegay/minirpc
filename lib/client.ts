import { connect, type Connection } from '@minirpc/connect'
import {
	type ClientRoutes,
	type SocketData,
	type DevalueTransforms,
	type ObservablePromise,
	type ClientMessage,
	type ServerMessage,
	makeMessenger,
	invariant,
} from './utils.js'

export type { Connection, DevalueTransforms }

export type Options = {
	protocols?: string[]
	signal?: AbortSignal
	backoff?: Partial<BackoffOptions>
}

export type WebSocketClientOptions = Options & {
	url: string
	onConnection?: (connection: Connection) => void | PromiseLike<void>
	onMessage: (message: SocketData) => void
}

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

export function createClient<Router extends ClientRoutes>({
	transforms,
}: {
	transforms?: DevalueTransforms
} = {}) {
	let started = false
	let nextRequestId = 1
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const queries = new Map<number, PromiseHandle<any>>()
	let messenger: ReturnType<typeof makeMessenger> | undefined
	let queue: ClientMessage[] | undefined

	const connectionClosedException = new DOMException(
		'Connection closed',
		'WebSocketConnectionClosedError',
	)

	function query<P extends unknown[], R>(
		method: string,
		params: P,
	): ObservablePromise<R> {
		const promise = new Promise<R>((resolve, reject) => {
			const id = nextRequestId++
			const message = { id, method, params }
			if (messenger) {
				messenger.send(message)
			} else {
				queue ??= []
				queue.push(message)
			}
			queries.set(id, { resolve, reject })
		}) as unknown as ObservablePromise<R>
		promise.subscribe = async (observer, signal) => {
			const stream = await promise
			invariant(stream instanceof ReadableStream)
			const reader = stream.getReader() as ReadableStreamDefaultReader<
				R extends ReadableStream<infer P> ? P : never
			>
			const onAbort = () => {
				void reader.cancel(signal?.reason)
			}
			signal?.addEventListener('abort', onAbort)
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					observer(value)
				}
			} catch (error) {
				if (error === connectionClosedException) {
					return
				}
				throw error
			} finally {
				reader.releaseLock()
				signal?.removeEventListener('abort', onAbort)
			}
		}
		return promise
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
		invariant(!started, 'Already listening')
		started = true

		const client = createWebSocketClient({
			url,
			async onConnection(connection) {
				const controller = new AbortController()
				try {
					messenger = makeMessenger(client.send, controller.signal, transforms)
					queue?.forEach(messenger.send)
					queue = undefined
					await handler(connection)
				} finally {
					controller.abort(connectionClosedException)
					messenger = undefined
					for (const handle of queries.values()) {
						handle.reject(connectionClosedException)
					}
				}
			},
			onMessage(data) {
				invariant(messenger)
				const message = messenger.parse(data) as ServerMessage | undefined
				if (message === undefined) return
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
						typeof message.error === 'string'
							? message.error
							: 'request failed',
					)
				}
			},
			...options,
		})
		const interval = setInterval(() => {
			client.send('heartbeat')
		}, 15e3)
		options.signal?.addEventListener('abort', () => {
			clearInterval(interval)
		})
		return client.listen()
	}

	return { router, listen }
}

async function backoff(
	error: unknown,
	attempt: number,
	options: BackoffOptions,
	signal: AbortSignal,
) {
	signal.throwIfAborted()
	const shouldRetry = await options.retry(error, attempt)
	if (!shouldRetry || attempt >= options.numOfAttempts) {
		throw error
	}
	let delay = Math.min(
		options.startingDelay * Math.pow(options.timeMultiple, attempt - 1),
		options.maxDelay,
	)
	if (options.jitter) {
		delay = Math.round(Math.random() * delay)
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, delay)
		const onAbort = () => {
			clearTimeout(timeout)
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort)
	})
}

export function createWebSocketClient(options: WebSocketClientOptions) {
	const abortController = new AbortController()
	if (options.signal) {
		const signal = options.signal
		signal.throwIfAborted()
		signal.addEventListener('abort', () => {
			abortController.abort(signal.reason)
		})
	}
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
	function send(message: SocketData, enqueue = false) {
		if (connection) {
			connection.send(message)
		} else if (enqueue) {
			queue ??= []
			queue.push(message)
		} else {
			throw new Error('no websocket connection')
		}
	}
	async function listen() {
		try {
			for (;;) {
				for (let attempt = 0; ; ) {
					try {
						connection = await connect(
							options.url,
							options.protocols,
							options.onMessage,
							abortController.signal,
						)
						break
					} catch (error) {
						await backoff(
							error,
							++attempt,
							backOffOptions,
							abortController.signal,
						)
					}
				}
				if (queue?.length) {
					for (const message of queue) {
						connection.send(message)
					}
					queue = undefined
				}
				await options.onConnection?.(connection)
				await connection.closed
				connection = undefined
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return
			}
			throw error
		} finally {
			connection?.close()
		}
	}

	return { send, listen }
}
