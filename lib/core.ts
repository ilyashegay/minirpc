import * as devalue from 'devalue'
import type {
	DevalueTransforms,
	SocketData,
	ClientMessage,
	ServerMessage,
	StreamMessage,
	ServerRoutes,
	ClientRoutes,
	Result,
	Connection,
	Client,
	BackoffOptions,
	ConnectOptions,
	Adapter,
	Context,
	Ware,
	ServeConnectOptions,
} from './types'

export const connectionClosedException = new DOMException(
	'Connection closed',
	'WebSocketConnectionClosedError',
)

function isClientMessage(
	message: Record<string, unknown>,
): message is ClientMessage {
	return (
		typeof message.id === 'number' &&
		typeof message.method === 'string' &&
		Array.isArray(message.params)
	)
}

function isServerMessage(
	message: Record<string, unknown>,
): message is ServerMessage {
	return (
		typeof message.id === 'number' &&
		('result' in message || 'error' in message)
	)
}

function invariant(condition: unknown, message?: string): asserts condition {
	if (!condition) throw new Error(message)
}

const ArrayBufferViews: Record<
	string,
	new (
		buffer: ArrayBuffer,
		byteOffset: number,
		byteLength: number,
	) => ArrayBufferView
> = {
	DataView,
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
}

function createTransport(
	send: (data: SocketData) => void,
	transforms?: DevalueTransforms,
) {
	type InboundStream = {
		controller: ReadableStreamDefaultController<unknown>
		canceled: boolean
	}
	const inboundStreams = new Map<number, InboundStream>()
	const outboundStreams = new Map<number, AbortController>()
	let expectedChunk: { id: number; type: string } | undefined
	let lastMessageTime = 0
	let nextStreamId = 1
	let closed = false

	const reducers: Record<string, (value: any) => any> = {}
	const revivers: Record<string, (value: any) => any> = {}
	if (transforms) {
		for (const key of Object.keys(transforms)) {
			reducers[key] = transforms[key][0]
			revivers[key] = transforms[key][1]
		}
	}
	reducers.ReadableStream = (value: unknown) => {
		if (!(value instanceof ReadableStream)) return
		const id = nextStreamId++
		void sendStream(id, value as ReadableStream<unknown>)
		return id
	}
	revivers.ReadableStream = (id: number) => {
		return new ReadableStream<unknown>({
			start(controller) {
				inboundStreams.set(id, {
					controller,
					canceled: false,
				})
			},
			cancel(reason) {
				const stream = inboundStreams.get(id)
				invariant(stream)
				stream.canceled = true
				send(JSON.stringify({ id, stream: 'cancel', reason: String(reason) }))
			},
		})
	}

	async function sendStream(id: number, stream: ReadableStream<unknown>) {
		const controller = new AbortController()
		outboundStreams.set(id, controller)
		controller.signal.addEventListener('abort', () => {
			void reader.cancel(controller.signal.reason)
		})
		const reader = stream.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				if (
					typeof value === 'string' ||
					value instanceof ArrayBuffer ||
					ArrayBuffer.isView(value)
				) {
					let type =
						typeof value === 'string'
							? 'string'
							: value instanceof ArrayBuffer
							? 'ArrayBuffer'
							: value.constructor.name
					if (type === 'Buffer') type = 'Uint8Array'
					send(`{"stream":"chunk","id":${id},"type":"${type}"}`)
					send(value)
				} else {
					const data = devalue.stringify(value)
					send(`{"stream":"chunk","id":${id},"data":${data}}`)
				}
			}
			send(`{"stream":"done","id":${id}}`)
		} catch (error) {
			if (controller.signal.aborted) return
			send(JSON.stringify({ stream: 'error', id, error: String(error) }))
		} finally {
			reader.releaseLock()
			outboundStreams.delete(id)
		}
	}

	function convertBufferType(data: SocketData, type: string) {
		if (typeof data === 'string') {
			invariant(type === 'string')
			return data
		}
		if (type === 'ArrayBuffer') {
			return data instanceof ArrayBuffer
				? data
				: data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
				? data.buffer
				: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
		}
		const View = ArrayBufferViews[type]
		invariant(View)
		return data instanceof ArrayBuffer
			? new View(data, 0, data.byteLength)
			: new View(data.buffer, data.byteOffset, data.byteLength)
	}

	function receiveMessage(
		data: SocketData,
	): ClientMessage | ServerMessage | undefined {
		invariant(!closed)
		lastMessageTime = Date.now()
		if (expectedChunk) {
			const stream = inboundStreams.get(expectedChunk.id)
			invariant(stream)
			const type = expectedChunk.type
			expectedChunk = undefined
			if (stream.canceled) return
			stream.controller.enqueue(convertBufferType(data, type))
			return
		}
		invariant(typeof data === 'string')
		if (data === 'ping') {
			send('pong')
			return
		}
		if (data === 'pong') {
			return
		}
		const message = JSON.parse(data) as StreamMessage | unknown[]
		if (Array.isArray(message)) {
			return devalue.unflatten(message, revivers) as
				| ClientMessage
				| ServerMessage
		}
		invariant('stream' in message)
		if (message.stream === 'cancel') {
			const stream = outboundStreams.get(message.id)
			invariant(stream)
			stream.abort(message.reason)
			return
		}
		if (message.stream === 'chunk') {
			if ('type' in message) {
				expectedChunk = message
				return
			}
			const stream = inboundStreams.get(message.id)
			invariant(stream)
			if (stream.canceled) return
			stream.controller.enqueue(devalue.unflatten(message.data))
		}
		if (message.stream === 'done') {
			const stream = inboundStreams.get(message.id)
			invariant(stream)
			inboundStreams.delete(message.id)
			if (stream.canceled) return
			stream.controller.close()
		}
		if (message.stream === 'error') {
			const stream = inboundStreams.get(message.id)
			invariant(stream)
			inboundStreams.delete(message.id)
			if (stream.canceled) return
			stream.controller.error(message.error)
		}
	}

	return {
		parse: receiveMessage,
		send: (message: ClientMessage | ServerMessage) => {
			invariant(!closed)
			send(devalue.stringify(message, reducers))
		},
		close(reason?: string | Error) {
			invariant(!closed)
			closed = true
			for (const stream of inboundStreams.values()) {
				stream.controller.error(reason)
				stream.canceled = true
			}
			for (const stream of outboundStreams.values()) {
				stream.abort(reason)
			}
		},
		getTimeSinceLastMessage() {
			return Date.now() - lastMessageTime
		},
		ping(latency: number, onResult: (alive: boolean) => void) {
			invariant(!closed)
			send('ping')
			const pingTime = Date.now()
			setTimeout(() => {
				if (!closed) onResult(lastMessageTime >= pingTime)
			}, latency)
		},
	}
}

const nativeAdapter: Adapter = async (options) => {
	options.signal.throwIfAborted()
	const ws = new WebSocket(options.url)
	ws.binaryType = 'arraybuffer'
	await new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			ws.removeEventListener('error', onError)
			options.signal.removeEventListener('abort', onAbort)
			resolve()
		}
		const onError = () => {
			ws.removeEventListener('open', onOpen)
			options.signal.removeEventListener('abort', onAbort)
			reject(new Error('Connection failed'))
		}
		const onAbort = () => {
			ws.removeEventListener('open', onOpen)
			ws.removeEventListener('error', onError)
			ws.close(1000)
			reject(options.signal.reason as Error)
		}
		ws.addEventListener('open', onOpen)
		ws.addEventListener('error', onError)
		options.signal.addEventListener('abort', onAbort)
	})
	ws.addEventListener('message', (event) => {
		options.message(event.data as SocketData)
	})
	ws.addEventListener('close', (event) => {
		options.close(event.code, event.reason)
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

export function connect<Router extends ClientRoutes>(
	options: ConnectOptions & {
		client?: Client<Router>
		connection?: (connection: Connection) => void | PromiseLike<void>
	},
) {
	function handleError(error: unknown) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			return true
		}
		if (options.error) {
			options.error(error)
		} else {
			console.error(error)
		}
		return false
	}
	const client = options.client ?? createClient()
	void (async () => {
		for (;;) {
			let connection: Connection
			try {
				connection = await client.connect(options)
			} catch (error) {
				handleError(error)
				break
			}
			try {
				await options.connection?.(connection)
			} catch (error) {
				if (handleError(error)) break
			}
			await connection.closed
		}
	})()
	return client.router
}

export function createClient<Router extends ClientRoutes>(): Client<Router> {
	type PromiseHandle<T> = {
		resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
		reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
	}

	const queries = new Map<number, PromiseHandle<any>>()
	let nextRequestId = 1
	let transport: ReturnType<typeof createTransport> | undefined
	let messageQueue: ClientMessage[] | undefined
	let onError: (error: unknown) => void

	async function connect(options: ConnectOptions): Promise<Connection> {
		onError = options.error ?? console.error.bind(console)
		const backOffOptions: BackoffOptions = {
			jitter: false,
			maxDelay: Infinity,
			numOfAttempts: 10,
			retry: () => true,
			startingDelay: 100,
			timeMultiple: 2,
			...(options.backoff ?? {}),
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
		for (let attempt = 0; ; ) {
			try {
				let closedHandle: PromiseHandle<{ code: number; reason: string }>
				const closed = new Promise<{ code: number; reason: string }>(
					(resolve, reject) => {
						closedHandle = { resolve, reject }
					},
				)
				const onAbort = () => {
					connection.close(1000)
				}
				controller.signal.addEventListener('abort', onAbort)
				const connection = await (options.adapter ?? nativeAdapter)({
					url: options.url,
					signal: controller.signal,
					message: receiveSocketData,
					close(code, reason) {
						controller.signal.removeEventListener('abort', onAbort)
						clearInterval(interval)
						transport?.close(connectionClosedException)
						transport = undefined
						for (const handle of queries.values()) {
							handle.reject(connectionClosedException)
						}
						closedHandle.resolve({ code, reason })
					},
				})
				const interval = setInterval(() => {
					transport?.ping(options.pongTimeout ?? 1e3, (alive) => {
						if (!alive) connection.close(1001)
					})
				}, options.pingInterval ?? 10e3)
				transport = createTransport(connection.message, options.transforms)
				messageQueue?.forEach(transport.send)
				messageQueue = undefined
				return { closed, close: connection.close }
			} catch (error) {
				if (controller.signal.aborted) throw controller.signal.reason
				await backoff(error, ++attempt, backOffOptions, controller.signal)
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
			const message: ClientMessage = { id, method, params }
			if (transport) {
				transport.send(message)
			} else {
				messageQueue ??= []
				messageQueue.push(message)
			}
			queries.set(id, { resolve, reject })
		}) as unknown as Result<R>
		promise.subscribe = (observer, options = {}) => {
			async function safeObserver(value: R) {
				try {
					await observer(value)
				} catch (error) {
					if (options.error) {
						options.error(error)
					} else {
						onError(error)
					}
				}
			}
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
							void safeObserver(value)
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
					if (options.error) {
						options.error(error)
					} else {
						onError(error)
					}
				})
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

	return { router, connect }
}

export class RPCClientError extends Error {}

function makeWare(stack: (() => void)[]): Ware {
	return {
		use(fn) {
			return makeWare([...stack, fn])
		},
		routes<R extends ServerRoutes>(routes: R) {
			const methods: Record<string, unknown> = {}
			for (const key of Object.keys(routes)) {
				methods[key] = (...args: unknown[]) => {
					for (const fn of stack) {
						fn()
					}
					// eslint-disable-next-line @typescript-eslint/no-unsafe-return
					return routes[key](...args)
				}
			}
			return methods as R
		},
	}
}

export function createChannel<T, P extends unknown[] = []>(
	onSubscribe?: (...args: P) => T | Promise<T>,
	onUnsubscribe?: () => unknown,
) {
	const subs = new Set<ReadableStreamDefaultController<T>>()
	return {
		get size() {
			return subs.size
		},
		push: (payload: T) => {
			for (const controller of subs) {
				controller.enqueue(payload)
			}
		},
		pull: (...args: P) => {
			let c: ReadableStreamDefaultController<T>
			return new ReadableStream<T>({
				async start(controller) {
					c = controller
					if (onSubscribe) {
						controller.enqueue(await onSubscribe(...args))
					}
					subs.add(controller)
				},
				async cancel() {
					subs.delete(c)
					await onUnsubscribe?.()
				},
			})
		},
	}
}

class Ctx<T> implements Context<T> {
	static currentClient: WeakKey | undefined
	static data = new WeakMap<
		WeakKey,
		WeakMap<() => Context<unknown>, Context<unknown>>
	>()
	#value: T
	constructor(initialValue: T) {
		this.#value = initialValue
	}
	get(): T {
		return this.#value
	}
	set(value: T): void {
		this.#value = value
	}
	update(updateFn: (value: T) => T): void {
		this.#value = updateFn(this.#value)
	}
}

export function getContextKey(): WeakKey {
	invariant(Ctx.currentClient, 'Context accessed out of bounds')
	return Ctx.currentClient
}

export function createContext<T = undefined>(): (
	key?: WeakKey,
) => Context<T | undefined>
export function createContext<T>(initialValue: T): (key?: WeakKey) => Context<T>
export function createContext<T>(initialValue?: T) {
	const reader = (key?: WeakKey): Context<T> => {
		key ??= getContextKey()
		let contextData = Ctx.data.get(key)
		if (!contextData) {
			contextData = new WeakMap()
			Ctx.data.set(key, contextData)
		}
		let context = contextData.get(reader) as Context<T> | undefined
		if (!context) {
			context = new Ctx(initialValue as T)
			contextData.set(reader, context)
		}
		return context
	}
	return reader
}

export function createServer() {
	type MethodHandler = (
		id: number,
		params: unknown[],
		respond: (message: ServerMessage) => void,
		onError: (error: unknown) => void,
	) => Promise<void>
	const methods: Record<string, MethodHandler> = {}

	const use = (fn: () => void): Ware => makeWare([fn])

	function router<R extends ServerRoutes>(routes: R) {
		for (const key of Object.keys(routes)) {
			if (key in methods) throw new Error(`Duplicate method ${key}`)
			const fn = routes[key]
			methods[key] = async (id, params, respond, onError) => {
				try {
					respond({ id, result: await fn(...params) })
				} catch (error) {
					if (error instanceof RPCClientError) {
						respond({ id, error: error.message })
					} else {
						respond({ id, error: true })
						onError(error)
					}
				}
			}
		}
		return {} as ClientRoutes<R>
	}

	function connect(client: ServeConnectOptions) {
		const onError = client.error ?? console.error.bind(console)
		const transport = createTransport(client.message, client.transforms)
		let activityTimeout: ReturnType<typeof setTimeout> | undefined
		const pingTimeout = client.pingTimeout ?? 60e3
		function setActivityTimer() {
			if (activityTimeout) return
			activityTimeout = setTimeout(
				checkActivity,
				pingTimeout - transport.getTimeSinceLastMessage(),
			)
		}
		function onPong(alive: boolean) {
			if (alive) {
				setActivityTimer()
			} else {
				client.close()
			}
		}
		function checkActivity() {
			if (transport.getTimeSinceLastMessage() < pingTimeout) {
				setActivityTimer()
			} else {
				transport.ping(client.pongTimeout ?? 1e3, onPong)
			}
		}
		return {
			message(data: SocketData) {
				try {
					setActivityTimer()
					const request = transport.parse(data)
					if (request === undefined) return
					invariant(isClientMessage(request), 'Unknown message format')
					if (!(request.method in methods)) {
						transport.send({
							id: request.id,
							error: `Unknown method: ${request.method}`,
						})
						return
					}
					Ctx.currentClient = client.key
					void methods[request.method](
						request.id,
						request.params,
						transport.send,
						onError,
					)
					Ctx.currentClient = undefined
				} catch (error) {
					onError(error)
				}
			},
			close(reason: string | Error) {
				clearTimeout(activityTimeout)
				transport.close(reason)
			},
		}
	}

	return { connect, router, use }
}
