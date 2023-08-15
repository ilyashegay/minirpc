import * as devalue from 'devalue'

export type Request<T extends unknown[] = unknown[]> = {
	id: number
	method: string
	params: T
}

type ResultResponse<T = unknown> = {
	id: number
	result: T
}

type ErrorResponse = {
	id: number
	error: unknown
}

type EventMessage<T> = {
	event: T
}

type StreamMessage =
	| { id: number; stream: 'start' }
	| { id: number; stream: 'done'; length: number }
	| { id: number; stream: 'error'; error: string }

export type Response = ResultResponse | ErrorResponse
export type ServerMessage<T = unknown> = Response | EventMessage<T>

export type SocketData = string | ArrayBuffer | ArrayBufferView

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerRoutes = Record<string, (...args: any[]) => any>

export type ClientRoutes<R extends ServerRoutes = ServerRoutes> = {
	[key in keyof R]: (
		...args: Parameters<R[key]>
	) => Promise<Awaited<ReturnType<R[key]>>>
}

export function invariant(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) throw new Error(message)
}

export function makeMessageParser() {
	const streams = new Map<
		number,
		{
			controller: ReadableStreamDefaultController<ArrayBufferView>
			canceled: boolean
			read: number
		}
	>()
	let activeId: number | undefined
	return function parse(
		data: SocketData,
		isBinary: boolean,
	): Request | ServerMessage | 'heartbeat' | undefined {
		if (isBinary) {
			invariant(activeId !== undefined, 'Unexpected binary message')
			const stream = streams.get(activeId)
			invariant(stream, `Unknown stream id ${activeId}`)
			if (stream.canceled) return
			if (data instanceof ArrayBuffer) {
				data = new Uint8Array(data)
			}
			invariant(typeof data !== 'string', 'Binary chunk is of type string')
			invariant(ArrayBuffer.isView(data), 'Unknown chunk type')
			stream.controller.enqueue(data)
			stream.read += data.byteLength
			return
		}
		const str = String(data)
		if (str === 'heartbeat') {
			return str
		}
		const json = JSON.parse(str) as StreamMessage | unknown[]
		if ('stream' in json) {
			if (json.stream === 'start') {
				invariant(activeId === undefined, 'Stream not closed')
				activeId = json.id
			}
			if (json.stream === 'done') {
				invariant(activeId === json.id, 'Wrong Stream closed')
				const stream = streams.get(json.id)
				invariant(stream, 'Unexpected stream end')
				if (stream.canceled) return
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
				if (stream.canceled) return
				stream.controller.error(json.error)
				activeId = undefined
			}
		}
		const revivers = {
			URL: (href: string) => new URL(href),
			ReadableStream: (id: number) => {
				new ReadableStream<ArrayBufferView>({
					start(controller) {
						streams.set(id, { controller, read: 0, canceled: false })
					},
					cancel() {
						const stream = streams.get(id)
						invariant(stream)
						stream.canceled = true
					},
				})
			},
		}
		if (Array.isArray(json)) {
			return devalue.unflatten(json, revivers) as Request | ServerMessage
		}
	}
}

export function makeMessageSender(send: (data: SocketData) => void) {
	let nextId = 1
	let streamActive = false
	const queue: { id: number; stream: ReadableStream<SocketData> }[] = []

	async function sendStream() {
		if (!queue.length) return
		streamActive = true
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
				} else if (ArrayBuffer.isView(value)) {
					read += value.byteLength
					send(value)
				} else if (typeof value === 'string') {
					read += value.length
					send(new TextEncoder().encode(value))
				} else {
					throw new Error('Unexpected value')
				}
			}
			send(JSON.stringify({ stream: 'done', id, length: read }))
		} catch (error) {
			console.error(error)
			send(JSON.stringify({ stream: 'error', id, error: String(error) }))
		} finally {
			reader.releaseLock()
			queue.shift()
			streamActive = false
			if (queue.length) void sendStream()
		}
	}

	return (message: Request | ServerMessage) => {
		send(
			devalue.stringify(message, {
				URL: (val) => val instanceof URL && val.href,
				ReadableStream: (val) => {
					if (!(val instanceof ReadableStream)) return
					const id = nextId++
					queue.push({
						id,
						stream: val as ReadableStream<SocketData>,
					})
					return id
				},
			}),
		)
		if (!streamActive && queue.length) {
			sendStream().catch((error) => {
				console.error(error)
			})
		}
	}
}

export function stringifySimple(value: unknown) {
	return devalue.stringify(value, {
		URL: (val) => val instanceof URL && val.href,
	})
}
