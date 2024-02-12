import {
	type ClientRoutes,
	type SocketData,
	type DevalueTransforms,
	type Result,
	type ClientMessage,
	createTransport,
	isServerMessage,
	invariant,
	connectionClosedException,
} from './utils.js'

export type { DevalueTransforms }

export type Connection = {
	protocol: string
	extensions: string
	closed: Promise<{ code?: number; reason?: string }>
	send(message: SocketData): void
	close(code?: number, reason?: string): void
}

export type Adapter = (options: {
	url: string
	protocols?: string | string[]
	signal: AbortSignal
	onMessage: (data: SocketData) => void
}) => Promise<Connection>

type BackoffOptions = {
	jitter: boolean
	maxDelay: number
	numOfAttempts: number
	retry: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>
	startingDelay: number
	timeMultiple: number
}

const nativeAdapter: Adapter = async ({
	url,
	protocols,
	signal,
	onMessage,
}) => {
	signal.throwIfAborted()
	const ws = new WebSocket(url, protocols)
	ws.binaryType = 'arraybuffer'
	await new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			ws.removeEventListener('error', onError)
			signal.removeEventListener('abort', onAbort)
			resolve()
		}
		const onError = () => {
			ws.removeEventListener('open', onOpen)
			signal.removeEventListener('abort', onAbort)
			reject(new Error('Connection failed'))
		}
		const onAbort = () => {
			ws.removeEventListener('open', onOpen)
			ws.removeEventListener('error', onError)
			ws.close(1000)
			reject(signal.reason as Error)
		}
		ws.addEventListener('open', onOpen)
		ws.addEventListener('error', onError)
		signal.addEventListener('abort', onAbort)
	})
	ws.addEventListener('message', (event) => {
		onMessage(event.data as SocketData)
	})
	return {
		protocol: ws.protocol,
		extensions: ws.extensions,
		closed: new Promise((resolve) => {
			const onClose = (event: CloseEvent) => {
				signal.removeEventListener('abort', onAbort)
				resolve({ code: event.code, reason: event.reason })
			}
			const onAbort = () => {
				ws.removeEventListener('close', onClose)
				ws.addEventListener('close', (event) => {
					resolve({ code: event.code, reason: event.reason })
				})
				ws.close(1000)
			}
			ws.addEventListener('close', onClose)
			signal.addEventListener('abort', onAbort)
		}),
		send(data) {
			ws.send(data)
		},
		close(code, reason) {
			ws.close(code, reason)
		},
	}
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
			reject(signal.reason as Error)
		}
		signal.addEventListener('abort', onAbort)
	})
}

export default <Router extends ClientRoutes>(options: {
	url: string
	protocols?: string | string[]
	signal?: AbortSignal
	backoff?: Partial<BackoffOptions>
	transforms?: DevalueTransforms
	heartbeat?: { interval?: number; latency?: number }
	adapter?: Adapter
	onConnection?: (connection: Connection) => void | PromiseLike<void>
	onError?: (error: unknown) => void
}) => {
	type PromiseHandle<T> = {
		resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
		reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const queries = new Map<number, PromiseHandle<any>>()
	let nextRequestId = 1

	let transport: ReturnType<typeof createTransport> | undefined
	let messageQueue: ClientMessage[] | undefined

	const onError = options.onError ?? console.error.bind(console)

	const backOffOptions: BackoffOptions = {
		jitter: false,
		maxDelay: Infinity,
		numOfAttempts: 10,
		retry: () => true,
		startingDelay: 100,
		timeMultiple: 2,
		...(options.backoff ?? {}),
	}
	const heartbeat = {
		interval: 10e3,
		latency: 1e3,
		...(options.heartbeat ?? {}),
	}

	const controller = new AbortController()
	if (options.signal) {
		const signal = options.signal
		signal.throwIfAborted()
		signal.addEventListener('abort', () => {
			if (signal.reason instanceof Error) {
				controller.abort(signal.reason)
			} else {
				controller.abort()
			}
		})
	}

	const isAbortError = (error: unknown) =>
		error instanceof DOMException && error.name === 'AbortError'

	void listen().catch((error) => {
		if (!isAbortError(error)) onError(error)
	})

	async function connect() {
		for (let attempt = 0; ; ) {
			try {
				return await (options.adapter ?? nativeAdapter)({
					url: options.url,
					protocols: options.protocols,
					signal: controller.signal,
					onMessage: receiveSocketData,
				})
			} catch (error) {
				await backoff(error, ++attempt, backOffOptions, controller.signal)
			}
		}
	}

	async function listen() {
		for (;;) {
			const connection = await connect()
			const interval = setInterval(() => {
				transport?.ping(heartbeat.latency, (alive) => {
					if (!alive) connection.close(1001)
				})
			}, heartbeat.interval)
			void connection.closed.then(() => {
				clearInterval(interval)
				transport?.close(connectionClosedException)
				transport = undefined
				for (const handle of queries.values()) {
					handle.reject(connectionClosedException)
				}
			})
			try {
				transport = createTransport((data) => {
					connection.send(data)
				}, options.transforms)
				messageQueue?.forEach(transport.send)
				messageQueue = undefined
				await options.onConnection?.(connection)
				await connection.closed
			} catch (error) {
				if (isAbortError(error)) break
				onError(error)
			}
		}
	}

	function receiveSocketData(data: SocketData) {
		try {
			invariant(transport)
			const message = transport.parse(data)
			if (message === undefined) return
			invariant(isServerMessage(message))
			const handle = queries.get(message.id)
			invariant(handle, `Unknown response ID: ${message.id}`)
			queries.delete(message.id)
			if ('result' in message) {
				handle.resolve(message.result)
			} else {
				handle.reject(
					typeof message.error === 'string' ? message.error : 'request failed',
				)
			}
		} catch (error) {
			onError(error)
		}
	}

	function query<P extends unknown[], R>(method: string, params: P): Result<R> {
		const promise = new Promise<R>((resolve, reject) => {
			const id = nextRequestId++
			const message = { id, method, params }
			if (transport) {
				transport.send(message)
			} else {
				messageQueue ??= []
				messageQueue.push(message)
			}
			queries.set(id, { resolve, reject })
		}) as unknown as Result<R>
		promise.subscribe = (observer, options = {}) => {
			const handleError = options.onError ?? onError
			promise
				.then(async (stream) => {
					invariant(stream instanceof ReadableStream, 'Expected ReadableStream')
					const reader = (stream as ReadableStream<R>).getReader()
					const onAbort = () => {
						void reader.cancel(options.signal?.reason)
					}
					options.signal?.addEventListener('abort', onAbort)
					try {
						for (;;) {
							const { done, value } = await reader.read()
							if (done) break
							try {
								Promise.resolve(observer(value)).catch(handleError)
							} catch (error) {
								handleError(error)
							}
						}
					} finally {
						reader.releaseLock()
						options.signal?.removeEventListener('abort', onAbort)
					}
				})
				.catch((error) => {
					if (error === connectionClosedException) {
						query<P, R>(method, params).subscribe(observer, options)
						return
					}
					handleError(error)
				})
		}
		return promise
	}

	return new Proxy({} as Router, {
		get(_, prop) {
			return (...args: unknown[]) => {
				if (typeof prop === 'string') {
					return query(prop, args)
				}
			}
		},
	})
}
