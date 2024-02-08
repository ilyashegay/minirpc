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
	) => ObservablePromise<Awaited<ReturnType<R[key]>>>
}

export type ObservablePromise<T> = Promise<T> &
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
	type StreamMessage =
		| { stream: 'event'; id: number; data: unknown[] }
		| { stream: 'chunk'; id: number }
		| { stream: 'done'; id: number }
		| { stream: 'cancel'; id: number; reason: string }
		| { stream: 'error'; id: number; error: string }

	type InboundStream = {
		controller: ReadableStreamDefaultController<unknown>
		canceled: boolean
	}

	const inboundStreams = new Map<number, InboundStream>()
	const outboundStreams = new Map<number, AbortController>()
	let nextStreamId = 1
	let expectedChunkId: number | undefined

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

	signal.addEventListener('abort', () => {
		for (const stream of inboundStreams.values()) {
			stream.controller.error(signal.reason)
			stream.canceled = true
		}
		for (const stream of outboundStreams.values()) {
			stream.abort(signal.reason)
		}
	})

	function receiveMessage(
		data: SocketData,
	): ClientMessage | ServerMessage | 'heartbeat' | undefined {
		if (expectedChunkId) {
			const stream = inboundStreams.get(expectedChunkId)
			invariant(stream, `Unknown stream id ${expectedChunkId}`)
			expectedChunkId = undefined
			if (stream.canceled) return
			stream.controller.enqueue(data)
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
			stream.abort(message.reason)
			return
		}
		if (message.stream === 'chunk') {
			expectedChunkId = message.id
			return
		}
		const stream = inboundStreams.get(message.id)
		invariant(stream, `Unknown stream id ${message.id}`)
		if (message.stream === 'event') {
			if (stream.canceled) return
			stream.controller.enqueue(devalue.unflatten(message.data))
		}
		if (message.stream === 'done') {
			inboundStreams.delete(message.id)
			if (stream.canceled) return
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
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				if (
					typeof value === 'string' ||
					value instanceof ArrayBuffer ||
					ArrayBuffer.isView(value)
				) {
					send(JSON.stringify({ stream: 'chunk', id }))
					send(value)
				} else {
					const data = JSON.parse(devalue.stringify(value)) as unknown[]
					send(JSON.stringify({ stream: 'event', id, data }))
				}
			}
			send(JSON.stringify({ stream: 'done', id }))
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
			send(devalue.stringify(message, reducers))
		},
	}
}
