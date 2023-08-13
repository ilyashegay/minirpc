import * as devalue from 'devalue'

export type Request<T extends unknown[] = unknown[]> = {
	id: number
	method: string
	params: T
}

export type ResultResponse<T = unknown> = {
	id: number
	result: T
}

export type ErrorResponse = {
	id: number
	error: unknown
}

export type EventMessage<T> = {
	event: T
}

export type Response = ResultResponse | ErrorResponse
export type ServerMessage<T> = Response | EventMessage<T>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UnsafeRouter = Record<string, (...args: any[]) => any>

export type SafeRouter<R extends UnsafeRouter = UnsafeRouter> = {
	[key in keyof R]: (
		...args: Parameters<R[key]>
	) => Promise<Awaited<ReturnType<R[key]>>>
}

export class RPCClientError extends Error {}

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

export class MiniSignal<T> {
	static resolve<T>(value: T) {
		const signal = new MiniSignal<T>()
		signal.resolve(value)
		return signal
	}
	#s = false
	#v?: T
	#h?: ((value: T) => void) | ((value: T) => void)[]
	#p?: Promise<T>
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
	get promise() {
		return (this.#p ??= this.#s
			? Promise.resolve(this.#v as T)
			: new Promise<T>((resolve) => {
					this.then(resolve)
			  }))
	}
}

export async function asyncForEach<T>(
	iterable: AsyncIterable<T> | ReadableStream<T>,
	handle: (value: T) => PromiseLike<void> | void,
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

export function invariant(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) throw new Error(message)
}

export function sleep(ms: number) {
	const signal = new MiniSignal<void>()
	setTimeout(() => {
		signal.resolve()
	}, ms)
	return signal
}

type StreamMessage =
	| { id: number; stream: 'start' }
	| { id: number; stream: 'done'; length: number }
	| { id: number; stream: 'error'; error: string }

export function makeMessageParser() {
	const streams = new Map<
		number,
		{
			controller: ReadableStreamDefaultController<Uint8Array>
			read: number
		}
	>()
	let activeId: number | undefined
	return function parse(
		data: string | Uint8Array,
		isBinary: boolean,
	): Request | ServerMessage<unknown> | undefined {
		if (isBinary) {
			invariant(activeId !== undefined, 'Unexpected binary message')
			const stream = streams.get(activeId)
			invariant(stream, `Unknown stream id ${activeId}`)
			invariant(ArrayBuffer.isView(data), 'Binary chunk is of type string')
			stream.controller.enqueue(data)
			stream.read += data.byteLength
			return
		}
		const json = JSON.parse(String(data)) as StreamMessage | unknown[]
		if ('stream' in json) {
			if (json.stream === 'start') {
				invariant(activeId === undefined, 'Stream not closed')
				activeId = json.id
			}
			if (json.stream === 'done') {
				invariant(activeId === json.id, 'Wrong Stream closed')
				const stream = streams.get(json.id)
				invariant(stream, 'Unexpected stream end')
				invariant(
					stream.read === json.length,
					`Stream Length: Expected ${json.length} bytes. Received ${stream.read}`,
				)
				stream.controller.close()
				activeId = undefined
			}
			if (json.stream === 'error') {
				invariant(activeId === json.id, 'Wrong Stream closed')
				const stream = streams.get(json.id)
				invariant(stream, 'Unexpected stream end')
				stream.controller.error(json.error)
				activeId = undefined
			}
		}
		const revivers = {
			URL: (href: string) => new URL(href),
			Stream: (id: number) =>
				new ReadableStream({
					start(controller) {
						streams.set(id, { controller, read: 0 })
					},
				}),
		}
		if (Array.isArray(json)) {
			return devalue.unflatten(json, revivers) as
				| Request
				| ServerMessage<unknown>
		}
	}
}

export function makeMessageSender<T>(
	send: (data: string | Uint8Array) => void,
) {
	let nextId = 1
	const queue: { id: number; stream: ReadableStream<string | Uint8Array> }[] =
		[]

	async function sendStream() {
		const { id, stream } = queue[0]
		const reader = stream.getReader()
		let read = 0
		try {
			send(JSON.stringify({ stream: 'start', id }))
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				if (value instanceof ArrayBuffer) {
					read += value.byteLength
					send(value)
				}
				if (ArrayBuffer.isView(value)) {
					read += value.byteLength
					send(value)
				}
				if (typeof value === 'string') {
					read += value.length
					send(new TextEncoder().encode(value))
				}
				throw new Error('Unexpected value')
			}
			send(JSON.stringify({ stream: 'done', id, length: read }))
		} catch (error) {
			send(JSON.stringify({ stream: 'error', id, error }))
		} finally {
			reader.releaseLock()
			queue.shift()
			if (queue.length) void sendStream()
		}
	}

	return (message: T) => {
		send(
			devalue.stringify(message, {
				URL: (val) => val instanceof URL && val.href,
				Stream: (val) => {
					if (!(val instanceof ReadableStream)) return
					const id = nextId++
					queue.push({
						id,
						stream: val as ReadableStream<string | Uint8Array>,
					})
					if (queue.length === 1) {
						sendStream().catch((error) => {
							console.error(error)
						})
					}
					return id
				},
			}),
		)
	}
}

export function stringifySimple(value: unknown) {
	return devalue.stringify(value, {
		URL: (val) => val instanceof URL && val.href,
	})
}
