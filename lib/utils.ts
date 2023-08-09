import superjson from 'superjson'

type Request<T extends unknown[] = unknown[]> = {
	id: number
	method: string
	params: T
}

type ResultResponse<T = unknown> = {
	id: number
	method: string
	result: T
}

type ErrorResponse = {
	id: number
	method: string
	error: unknown
}

type EventMessage<T> = {
	event: T
}

type ServerMessage<T> = ResultResponse | ErrorResponse | EventMessage<T>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnsafeRouter = Record<string, (...args: any[]) => any>

export type SafeRouter<R extends UnsafeRouter = UnsafeRouter> = {
	[key in keyof R]: (
		...args: Parameters<R[key]>
	) => Promise<Awaited<ReturnType<R[key]>>>
}

type PromiseHandle<T> = {
	resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
	reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
}

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

export class RPCClientError extends Error {}

export function createRPCClient<T, Router extends SafeRouter>() {
	let nextRequestId = 1
	const queries = new Map<number, PromiseHandle<unknown>>()
	const events = new Observable<T>()
	const requests = new Observable<Request>()

	function message(msg: ServerMessage<T> | string) {
		if (typeof msg === 'string') {
			msg = superjson.parse<ServerMessage<T>>(msg)
		}
		if ('event' in msg) {
			events.next(msg.event)
			return
		}
		const handle = queries.get(msg.id)
		if (!handle) {
			console.error(`Unknown response ID: ${msg.id}`)
			return
		}
		queries.delete(msg.id)
		if ('result' in msg) {
			handle.resolve(msg.result)
		} else {
			handle.reject(
				typeof msg.error === 'string' ? msg.error : 'request failed',
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

	return { router, message, events, requests }
}

export function createRPCClientStream<T, Router extends SafeRouter>() {
	const client = createRPCClient<T, Router>()
	const duplex = controlledDuplex<string, Uint8Array | string>({
		start(controller) {
			client.requests.subscribe((request) => {
				controller.enqueue(superjson.stringify(request))
			})
		},
		write(chunk) {
			client.message(superjson.parse(String(chunk)))
		},
	})
	return {
		router: client.router,
		events: client.events,
		readable: duplex.readable,
		writable: duplex.writable,
	}
}

export function createRPCServer() {
	const methods: SafeRouter = {}

	function message(
		req: Request | string,
		callback: (
			response: ResultResponse | ErrorResponse,
			error?: unknown,
		) => void,
	) {
		const request =
			typeof req === 'string' ? superjson.parse<Request>(req) : req
		if (!(request.method in methods)) {
			callback({
				id: request.id,
				method: request.method,
				error: `Unknown method: ${request.method}`,
			})
			return
		}
		methods[request.method](...request.params)
			.then((result) => {
				callback({
					id: request.id,
					method: request.method,
					result: result ?? null,
				})
			})
			.catch((error: unknown) => {
				let message: string | true = true
				if (error instanceof RPCClientError) {
					message = error.message
					error = undefined
				}
				callback(
					{
						id: request.id,
						method: request.method,
						error: message,
					},
					error,
				)
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

	return { router, message }
}

type EventSource<T> = (publish: (data: T) => void) => {
	subscribe(): T
	unsubscribe(): void
}

export function createRPCServerStream<T>(options: {
	eventSource: EventSource<T>
	onerror?: (error: unknown) => void
}) {
	const server = createRPCServer()
	const clients = new Set<{ enqueue: (chunk: string) => void }>()
	const events = options.eventSource((event) => {
		if (!clients.size) return
		const message = superjson.stringify({ event })
		for (const controller of clients) {
			controller.enqueue(message)
		}
	})
	function connect() {
		return new TransformStream<Uint8Array | string, string>({
			start(controller) {
				clients.add(controller)
				controller.enqueue(superjson.stringify({ event: events.subscribe() }))
			},
			transform(chunk, controller) {
				const request = superjson.parse<Request>(String(chunk))
				server.message(request, (response, error) => {
					if (error) options.onerror?.(error)
					controller.enqueue(superjson.stringify(response))
				})
			},
			flush(controller) {
				clients.delete(controller)
				events.unsubscribe()
			},
		})
	}
	return {
		router: server.router,
		connect,
	}
}

console.log('Yo')

export function controlledDuplex<I, O>(source: {
	start?(
		controller: ReadableStreamDefaultController<I>,
	): void | PromiseLike<void>
	write(
		chunk: O,
		controller: ReadableStreamDefaultController<I>,
	): void | PromiseLike<void>
	close?(
		controller: ReadableStreamDefaultController<I>,
	): void | PromiseLike<void>
}) {
	let controller: ReadableStreamDefaultController<I> | undefined
	const readable = new ReadableStream<I>({
		async start(c) {
			controller = c
			await source.start?.(controller)
		},
	})
	const writable = new WritableStream<O>({
		write(chunk) {
			invariant(controller)
			return source.write(chunk, controller)
		},
		close() {
			invariant(controller)
			return source.close?.(controller)
		},
	})
	invariant(controller)
	return { controller, readable, writable }
}

export async function asyncForEach<T>(
	iterable: AsyncIterable<T> | ReadableStream<T>,
	handle: (value: T) => Promise<void> | void,
) {
	if (iterable instanceof ReadableStream) {
		for (const reader = iterable.getReader(); ; ) {
			const { value, done } = await reader.read()
			if (value !== undefined) await handle(value)
			if (done) return
		}
	}
	for await (const connection of iterable) {
		await handle(connection)
	}
}

type Observer<T> = (value: T) => void
export class Observable<T> {
	private observers: Observer<T>[] = []
	subscribe(observer: Observer<T>) {
		this.observers.push(observer)
	}
	next(value: T) {
		for (const observer of this.observers) {
			observer(value)
		}
	}
}

export class StrictMap<K, V> extends Map<K, V> {
	constructor(private initializer: ((key: K) => V) | string = 'Missing key') {
		super()
	}
	get(key: K): V {
		if (!this.has(key)) {
			if (typeof this.initializer === 'string') {
				throw new Error(`StrictMap: ${this.initializer}: ${String(key)}`)
			}
			this.set(key, this.initializer(key))
		}
		return super.get(key) as V
	}
}

export type Future<T> = {
	resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
	reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
}

export class Deferred<T> {
	// @ts-expect-error assigned in promise body
	resolve: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[0]
	// @ts-expect-error assigned in promise body
	reject: Parameters<ConstructorParameters<typeof Promise<T>>[0]>[1]
	promise = new Promise<T>((resolve, reject) => {
		this.resolve = resolve
		this.reject = reject
	})
}

export class MiniSignal<T> {
	static resolve<T>(value: T) {
		const signal = new MiniSignal<T>()
		signal.resolve(value)
		return signal
	}
	#s = false
	#v?: T
	#h?: ((value: T) => void) | ((value: T) => void)[]
	resolve(value: T) {
		const h = this.#h
		this.#s = true
		this.#v = value
		this.#h = undefined
		if (typeof h === 'function') {
			h(value)
		} else if (typeof h !== 'undefined') {
			for (const i of h) i(value)
		}
	}
	then(handler: (value: T) => void) {
		if (this.#s) {
			handler(this.#v as T)
		} else if (typeof this.#h === 'undefined') {
			this.#h = handler
		} else if (typeof this.#h === 'function') {
			this.#h = [this.#h, handler]
		} else {
			this.#h.push(handler)
		}
	}
}

export class EtherealValue<T> {
	#s = false
	#v?: T
	#h?: ((value: T) => void) | ((value: T) => void)[]
	then(handler: (value: T) => void) {
		if (this.#s) {
			handler(this.#v as T)
		} else if (typeof this.#h === 'undefined') {
			this.#h = handler
		} else if (typeof this.#h === 'function') {
			this.#h = [this.#h, handler]
		} else {
			this.#h.push(handler)
		}
	}
	set(value: T) {
		const h = this.#h
		this.#s = true
		this.#v = value
		this.#h = undefined
		if (typeof h === 'function') {
			h(value)
		} else if (typeof h !== 'undefined') {
			for (const i of h) i(value)
		}
	}
	reset() {
		this.#s = false
		this.#v = undefined
	}
}

export function invariant(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) {
		throw new Error(message ?? 'Invariant failed')
	}
}
