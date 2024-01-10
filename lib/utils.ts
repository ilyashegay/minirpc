import * as devalue from 'devalue'

export type DevalueTransforms = Record<
	string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[(value: unknown) => unknown, (value: any) => unknown]
>

export type ClientMessage = { id: number; method: string; params: unknown[] }

export type ServerMessage =
	| { id: number; result: unknown }
	| { id: number; error: unknown }

export type SocketData = string | ArrayBuffer | ArrayBufferView

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRoutes = Record<string, (...args: any[]) => any>

export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
	[key in keyof R]: (
		...args: Parameters<R[key]>
	) => ObservablePromise<Awaited<ReturnType<R[key]>>>
}

export type ObservablePromise<T> = Promise<T> &
	(T extends ReadableStream<infer R>
		? {
				subscribe: (
					observer: (value: R) => void,
					signal?: AbortSignal,
				) => Promise<void>
		  }
		: Record<string, never>)

export function invariant(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) throw new Error(message)
}

export function makeMessenger(
	send: (data: SocketData, enqueue?: boolean) => void,
	signal: AbortSignal,
	transforms?: DevalueTransforms,
) {
	type StreamChunkMeta = { id: number; length: number; binary: boolean }

	type StreamMessage =
		| { stream: 'cancel'; id: number }
		| ({ stream: 'chunk'; index: number } & StreamChunkMeta)
		| { stream: 'event'; index: number; id: number; data: unknown[] }
		| { stream: 'done'; id: number; count: number; length: number }
		| { stream: 'error'; id: number; error: string }

	type InboundStream = {
		controller: ReadableStreamDefaultController<unknown>
		canceled: boolean
		read: number
		count: number
	}

	const inboundStreams = new Map<number, InboundStream>()
	const outboundStreams = new Map<number, AbortController>()
	let nextStreamId = 1
	let expectedChunk: StreamChunkMeta | undefined

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const reducers: Record<string, (value: any) => any> = {}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
		setImmediate(() => void sendStream(id, value as ReadableStream<unknown>))
		return id
	}
	revivers.ReadableStream = (id: number) => {
		return new ReadableStream<unknown>({
			start(controller) {
				inboundStreams.set(id, {
					controller,
					read: 0,
					count: 0,
					canceled: false,
				})
			},
			cancel() {
				const stream = inboundStreams.get(id)
				invariant(stream)
				stream.canceled = true
				streamSend({ id, stream: 'cancel' })
			},
		})
	}

	signal.addEventListener('abort', () => {
		for (const stream of inboundStreams.values()) {
			stream.controller.error(signal.reason)
			stream.canceled = true
		}
		for (const stream of outboundStreams.values()) {
			stream.abort(signal.reason)
		}
	})

	function streamSend(message: StreamMessage, chunk?: SocketData) {
		send(JSON.stringify(message))
		if (chunk) send(chunk)
	}

	function receiveChunk(data: SocketData, meta: StreamChunkMeta) {
		const stream = inboundStreams.get(meta.id)
		invariant(stream, `Unknown stream id ${meta.id}`)
		if (stream.canceled) return
		if (meta.binary) {
			invariant(
				typeof data !== 'string',
				'Expected binary chunk. Received string',
			)
			invariant(
				data.byteLength === meta.length,
				`Stream Length: Expected ${meta.length} bytes. Received ${data.byteLength}`,
			)
		} else {
			invariant(
				typeof data === 'string',
				'Expected string chunk. Received binary',
			)
			invariant(
				data.length === meta.length,
				`Stream Length: Expected ${meta.length} bytes. Received ${data.length}`,
			)
		}
		stream.controller.enqueue(data)
		stream.read += meta.length
		stream.count += 1
	}

	function receiveMessage(
		data: SocketData,
	): ClientMessage | ServerMessage | 'heartbeat' | undefined {
		if (expectedChunk) {
			receiveChunk(data, expectedChunk)
			expectedChunk = undefined
			return
		}
		invariant(typeof data === 'string', 'Unexpected binary message')
		if (data === 'heartbeat') {
			return data
		}
		const message = JSON.parse(data) as StreamMessage | unknown[]
		if (Array.isArray(message)) {
			return devalue.unflatten(message, revivers) as
				| ClientMessage
				| ServerMessage
		}
		invariant('stream' in message, 'Unknown message')
		if (message.stream === 'cancel') {
			const stream = outboundStreams.get(message.id)
			invariant(stream, `Unknown stream id ${message.id}`)
			stream.abort('Stream closed by consumer')
			return
		}
		const stream = inboundStreams.get(message.id)
		invariant(stream, `Unknown stream id ${message.id}`)
		if (message.stream === 'event') {
			if (stream.canceled) return
			invariant(
				stream.count === message.index,
				`Expected chunk index ${stream.count}. Got ${message.index}`,
			)
			stream.controller.enqueue(devalue.unflatten(message.data))
			stream.count += 1
		}
		if (message.stream === 'chunk') {
			invariant(
				stream.count === message.index,
				`Expected chunk index ${stream.count}. Got ${message.index}`,
			)
			expectedChunk = {
				id: message.id,
				length: message.length,
				binary: message.binary,
			}
		}
		if (message.stream === 'done') {
			inboundStreams.delete(message.id)
			if (stream.canceled) return
			invariant(
				stream.read === message.length,
				`Stream Length: Expected ${message.length} bytes. Received ${stream.read}`,
			)
			stream.controller.close()
		}
		if (message.stream === 'error') {
			inboundStreams.delete(message.id)
			if (stream.canceled) return
			stream.controller.error(message.error)
		}
	}

	async function sendStream(id: number, stream: ReadableStream<unknown>) {
		const controller = new AbortController()
		outboundStreams.set(id, controller)
		controller.signal.addEventListener('abort', () => {
			void reader.cancel(controller.signal.reason)
		})
		const reader = stream.getReader()
		let read = 0
		let count = 0
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				let length = 0
				let binary = true
				if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
					length = value.byteLength
					read += length
					streamSend(
						{
							stream: 'chunk',
							id,
							length,
							binary,
							index: count++,
						},
						value,
					)
				} else if (typeof value === 'string') {
					length = value.length
					binary = false
					read += length
					streamSend(
						{
							stream: 'chunk',
							id,
							length,
							binary,
							index: count++,
						},
						value,
					)
				} else {
					streamSend({
						stream: 'event',
						id,
						index: count++,
						data: JSON.parse(devalue.stringify(value)) as unknown[],
					})
				}
			}
			streamSend({
				stream: 'done',
				id,
				length: read,
				count,
			})
		} catch (error) {
			if (controller.signal.aborted) return
			// console.error(error)
			streamSend({
				stream: 'error',
				id,
				error: String(error),
			})
		} finally {
			reader.releaseLock()
			outboundStreams.delete(id)
		}
	}

	return {
		parse: receiveMessage,
		send: (message: ClientMessage | ServerMessage) => {
			send(devalue.stringify(message, reducers))
		},
	}
}
