import {
	type ClientRoutes,
	type ServerRoutes,
	type DevalueTransforms,
	type SocketData,
	type ClientMessage,
	type ServerMessage,
	makeMessenger,
	invariant,
} from './utils.js'

export { type DevalueTransforms }

export class RPCClientError extends Error {}

export type MiniRPCServer = {
	router<R extends ServerRoutes>(routes: R): ClientRoutes<R>
	run(options: { signal?: AbortSignal }): Connector
}

export type Context<T> = {
	get(): T
	set(value: T): void
	update(updateFn: (value: T) => T): void
}

type Client = {
	key: WeakKey
	send: (data: SocketData) => void
	terminate(): void
}

type Connector = (client: Client) => {
	message: (data: SocketData) => void
	close: (code: number, reason: string | Buffer) => void
}

export function createServer(options: {
	heartbeat?: number
	transforms?: DevalueTransforms
	onError: (error: unknown) => void
}): MiniRPCServer {
	const methods: ServerRoutes = {}
	let interval: ReturnType<typeof setInterval> | undefined

	function router<R extends ServerRoutes>(routes: R) {
		for (const key of Object.keys(routes)) {
			if (key in methods) throw new Error(`Duplicate method ${key}`)
			methods[key] = routes[key]
		}
		return {} as ClientRoutes<R>
	}

	function run({ signal }: { signal?: AbortSignal } = {}): Connector {
		invariant(!interval, 'Already Listening')
		const clients = new Set<Client>()
		const heartbeats = new WeakMap<WeakKey, number>()
		interval = setInterval(() => {
			const limit = Date.now() - (options.heartbeat ?? 60e3)
			for (const client of clients) {
				if (heartbeats.get(client)! < limit) {
					client.terminate()
				}
			}
		}, 10e3)
		signal?.addEventListener('abort', () => {
			clearInterval(interval)
			interval = undefined
		})
		return (client) => {
			clients.add(client)
			const abortController = new AbortController()
			const messenger = makeMessenger(
				client.send,
				abortController.signal,
				options.transforms,
			) as {
				parse: (data: SocketData) => ClientMessage | 'heartbeat' | undefined
				send: (message: ServerMessage) => void
			}
			heartbeats.set(client.key, Date.now())
			return {
				message(data) {
					const request = messenger.parse(data)
					if (request === 'heartbeat') {
						heartbeats.set(client.key, Date.now())
						return
					}
					if (request === undefined) return
					try {
						const { id, method, params } = request
						if (!(method in methods)) {
							messenger.send({ id, error: `Unknown method: ${method}` })
							return
						}
						Ctx.currentClient = client.key
						Promise.resolve(methods[method](...params))
							.then((result) => {
								messenger.send({ id, result: result ?? null })
							})
							.catch((error) => {
								if (error instanceof RPCClientError) {
									messenger.send({ id: request.id, error: error.message })
								} else {
									messenger.send({ id: request.id, error: true })
									options.onError(error)
								}
							})
						Ctx.currentClient = undefined
					} catch (error) {
						if (error instanceof RPCClientError) {
							messenger.send({ id: request.id, error: error.message })
						} else {
							messenger.send({ id: request.id, error: true })
							options.onError(error)
						}
					}
				},
				close(code, reason) {
					clients.delete(client)
					abortController.abort(reason.toString())
				},
			}
		}
	}

	return { router, run }
}

export function createChannel<T>(onpull?: (first: boolean) => T) {
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
		pull: () => {
			let c: ReadableStreamDefaultController<T>
			return new ReadableStream<T>({
				start(controller) {
					c = controller
					subs.add(controller)
					if (onpull) {
						controller.enqueue(onpull(subs.size === 1))
					}
				},
				cancel() {
					subs.delete(c)
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
