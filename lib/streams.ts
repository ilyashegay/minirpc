import { type SocketData, invariant } from './utils.js'

export type StreamChunkMeta = { id: number; length: number; binary: boolean }

export type StreamMessage =
	| { id: number; stream: 'cancel' }
	| (StreamChunkMeta & { stream: 'chunk'; index: number })
	| { id: number; stream: 'done'; count: number; length: number }
	| { id: number; stream: 'error'; error: string }

export function makeStreamTransport(
	send: (message: StreamMessage, chunk?: SocketData) => void,
) {
	type InboundStream = {
		controller: ReadableStreamDefaultController<SocketData>
		canceled: boolean
		read: number
		count: number
	}
	const inboundStreams = new Map<number, InboundStream>()
	const outboundStreams = new Map<number, AbortController>()
	let nextStreamId = 1

	function abort(reason: unknown) {
		for (const stream of inboundStreams.values()) {
			stream.controller.error(reason)
			stream.canceled = true
		}
		for (const stream of outboundStreams.values()) {
			stream.abort(reason)
		}
	}

	function reduce(value: unknown) {
		if (!(value instanceof ReadableStream)) return
		const id = nextStreamId++
		setImmediate(() => void sendStream(id, value as ReadableStream<SocketData>))
		return id
	}

	function revive(id: number) {
		return new ReadableStream<SocketData>({
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
				send({ id, stream: 'cancel' })
			},
		})
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

	function receiveMessage(message: StreamMessage): StreamChunkMeta | undefined {
		if (message.stream === 'cancel') {
			const stream = outboundStreams.get(message.id)
			invariant(stream, `Unknown stream id ${message.id}`)
			stream.abort()
			return
		}
		const stream = inboundStreams.get(message.id)
		invariant(stream, `Unknown stream id ${message.id}`)
		if (message.stream === 'chunk') {
			invariant(
				stream.count === message.index,
				`Expected chunk index ${stream.count}. Got ${message.index}`,
			)
			return {
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

	async function sendStream(id: number, stream: ReadableStream<SocketData>) {
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
				} else if (typeof value === 'string') {
					length = value.length
					binary = false
				} else {
					throw new Error('Unexpected value')
				}
				read += length
				send(
					{
						stream: 'chunk',
						id,
						length,
						binary,
						index: count++,
					},
					value,
				)
			}
			send({
				stream: 'done',
				id,
				length: read,
				count,
			})
		} catch (error) {
			if (controller.signal.aborted) return
			// console.error(error)
			send({
				stream: 'error',
				id,
				error: String(error),
			})
		} finally {
			reader.releaseLock()
			outboundStreams.delete(id)
		}
	}

	return { abort, reduce, revive, receiveChunk, receiveMessage }
}
