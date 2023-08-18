import * as devalue from 'devalue'
import {
	type StreamMessage,
	type StreamChunkMeta,
	makeStreamTransport,
} from './streams.js'

export type DevalueTransforms = Record<
	string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[(value: unknown) => unknown, (value: any) => unknown]
>

type ClientMessage = {
	id: number
	method: string
	params: unknown[]
}

type ServerMessage =
	| { id: number; result: unknown }
	| { id: number; error: unknown }
	| { event: unknown }

type AnyMessage = ClientMessage | ServerMessage

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

export function stringifySimple(value: unknown) {
	return devalue.stringify(value, {
		URL: (val) => val instanceof URL && val.href,
	})
}

export function makeServerMessenger(
	send: (data: SocketData, enqueue?: boolean) => void,
	signal: AbortSignal,
	transforms?: DevalueTransforms,
) {
	const messenger = makeMessenger(send, signal, transforms)
	return {
		parse: messenger.parse as (
			data: SocketData,
		) => ClientMessage | 'heartbeat' | undefined,
		send: messenger.send as (message: ServerMessage) => void,
	}
}

export function makeClientMessenger(
	send: (data: SocketData, enqueue?: boolean) => void,
	transforms?: DevalueTransforms,
) {
	let controller: AbortController
	let messenger: ReturnType<typeof makeMessenger> | undefined
	let queue: ClientMessage[] | undefined
	setInterval(() => {
		send('heartbeat')
	}, 15e3)
	return {
		parse(data: SocketData) {
			invariant(messenger)
			return messenger.parse(data) as ServerMessage | undefined
		},
		send(message: ClientMessage) {
			if (messenger) {
				messenger.send(message)
			} else {
				queue ??= []
				queue.push(message)
			}
		},
		open() {
			controller = new AbortController()
			messenger = makeMessenger(send, controller.signal, transforms)
			queue?.forEach(messenger.send)
			queue = undefined
		},
		close() {
			controller.abort()
			messenger = undefined
		},
	}
}

function makeMessenger(
	send: (data: SocketData, enqueue?: boolean) => void,
	signal: AbortSignal,
	transforms?: DevalueTransforms,
) {
	let expectedChunk: StreamChunkMeta | undefined
	const streams = makeStreamTransport((message, chunk) => {
		send(JSON.stringify(message))
		if (chunk) send(chunk)
	})

	signal.addEventListener('abort', () => {
		streams.abort(signal.reason)
	})

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
	reducers.ReadableStream = streams.reduce
	revivers.ReadableStream = streams.revive

	return {
		parse: (data: SocketData): AnyMessage | 'heartbeat' | undefined => {
			if (expectedChunk) {
				streams.receiveChunk(data, expectedChunk)
				expectedChunk = undefined
				return
			}
			invariant(typeof data === 'string', 'Unexpected binary message')
			if (data === 'heartbeat') {
				return data
			}
			const message = JSON.parse(data) as StreamMessage | unknown[]
			if (Array.isArray(message)) {
				return devalue.unflatten(message, revivers) as AnyMessage
			}
			invariant('stream' in message, 'Unknown message')
			expectedChunk = streams.receiveMessage(message)
		},
		send: (message: AnyMessage) => {
			send(devalue.stringify(message, reducers))
		},
	}
}
