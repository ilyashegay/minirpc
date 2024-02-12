/* eslint-disable @typescript-eslint/no-explicit-any */
import * as devalue from 'devalue'

export type DevalueTransforms = Record<
	string,
	[(value: unknown) => unknown, (value: any) => unknown]
>

export type ClientMessage = { id: number; method: string; params: unknown[] }

export type ServerMessage =
	| { id: number; result: unknown }
	| { id: number; error: unknown }

export type SocketData = string | ArrayBuffer | ArrayBufferView

export type ServerRoutes = Record<string, (...args: any[]) => any>

export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
	[key in keyof R]: (
		...args: Parameters<R[key]>
	) => Result<Awaited<ReturnType<R[key]>>>
}

export type Result<T> = Promise<T> &
	(T extends ReadableStream<infer R>
		? {
				subscribe: (
					observer: (value: R) => unknown,
					options?: {
						signal?: AbortSignal
						onError?: (error: unknown) => void
					},
				) => void
		  }
		: Record<string, never>)

export const connectionClosedException = new DOMException(
	'Connection closed',
	'WebSocketConnectionClosedError',
)

export function isClientMessage(
	message: Record<string, unknown>,
): message is ClientMessage {
	return (
		typeof message.id === 'number' &&
		typeof message.method === 'string' &&
		Array.isArray(message.params)
	)
}

export function isServerMessage(
	message: Record<string, unknown>,
): message is ServerMessage {
	return (
		typeof message.id === 'number' &&
		('result' in message || 'error' in message)
	)
}

export function invariant(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) throw new Error(message)
}

export function createTransport(
	send: (data: SocketData) => void,
	transforms?: DevalueTransforms,
) {
	type StreamMessage =
		| { id: number; stream: 'item'; data: null | unknown[] }
		| { id: number; stream: 'done' }
		| { id: number; stream: 'cancel'; reason: string }
		| { id: number; stream: 'error'; error: string }

	type InboundStream = {
		controller: ReadableStreamDefaultController<unknown>
		canceled: boolean
	}

	const inboundStreams = new Map<number, InboundStream>()
	const outboundStreams = new Map<number, AbortController>()
	let nextStreamId = 1
	let expectedChunkId: number | undefined
	let lastMessageTime = 0
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
		setImmediate(() => void sendStream(id, value as ReadableStream<unknown>))
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

	function receiveMessage(
		data: SocketData,
	): ClientMessage | ServerMessage | undefined {
		invariant(!closed)
		lastMessageTime = Date.now()
		if (expectedChunkId) {
			const stream = inboundStreams.get(expectedChunkId)
			invariant(stream)
			expectedChunkId = undefined
			if (stream.canceled) return
			stream.controller.enqueue(data)
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
		if (message.stream === 'item') {
			if (!Array.isArray(message.data)) {
				expectedChunkId = message.id
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
					send(`{"stream":"item","id":${id},"data":null}`)
					send(value)
				} else {
					const data = devalue.stringify(value)
					send(`{"stream":"item","id":${id},"data":${data}}`)
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
