import {
	type ClientRoutes,
	type ServerRoutes,
	type DevalueTransforms,
	type SocketData,
	createTransport,
	isClientMessage,
	invariant,
} from './utils.js'

export { type DevalueTransforms }

export class RPCClientError extends Error {}

export type Server = ReturnType<typeof createServer>

export type Context<T> = {
	get(): T
	set(value: T): void
	update(updateFn: (value: T) => T): void
}

type Ware = {
	use(fn: () => void): Ware
	routes<R extends ServerRoutes>(routes: R): ClientRoutes<R>
}

export function createServer(
	options: {
		heartbeat?: { interval?: number; latency?: number }
		transforms?: DevalueTransforms
		onError?: (error: unknown) => void
	} = {},
) {
	const methods: ServerRoutes = {}
	const onError = options.onError ?? console.error.bind(console)

	const use = (fn: () => void): Ware => makeWare([fn])

	function router<R extends ServerRoutes>(routes: R) {
		for (const key of Object.keys(routes)) {
			if (key in methods) throw new Error(`Duplicate method ${key}`)
			methods[key] = routes[key]
		}
		return {} as ClientRoutes<R>
	}

	function connect(client: {
		key: WeakKey
		send: (data: SocketData) => void
		close(): void
	}) {
		const transport = createTransport(client.send, options.transforms)
		let activityTimeout: ReturnType<typeof setTimeout> | undefined
		const heartbeatInterval = options.heartbeat?.interval ?? 60e3
		function setActivityTimer() {
			activityTimeout ??= setTimeout(
				checkActivity,
				heartbeatInterval - transport.getTimeSinceLastMessage(),
			)
		}
		function checkActivity() {
			if (transport.getTimeSinceLastMessage() < heartbeatInterval) {
				setActivityTimer()
				return
			}
			transport.ping(options.heartbeat?.latency ?? 1e3, (alive) => {
				if (alive) {
					setActivityTimer()
				} else {
					client.close()
				}
			})
		}
		return {
			message(data: SocketData) {
				let request: ReturnType<typeof transport.parse>
				try {
					request = transport.parse(data)
					if (request === undefined) return
					invariant(isClientMessage(request), 'Unknown message format')
				} catch (error) {
					onError(error)
					return
				}
				try {
					setActivityTimer()
					const { id, method, params } = request
					if (!(method in methods)) {
						transport.send({ id, error: `Unknown method: ${method}` })
						return
					}
					Ctx.currentClient = client.key
					Promise.resolve(methods[method](...params))
						.then((result: unknown) => {
							transport.send({ id, result })
						})
						.catch((error) => {
							if (error instanceof RPCClientError) {
								transport.send({ id, error: error.message })
							} else {
								transport.send({ id, error: true })
								onError(error)
							}
						})
					Ctx.currentClient = undefined
				} catch (error) {
					if (error instanceof RPCClientError) {
						transport.send({ id: request.id, error: error.message })
					} else {
						transport.send({ id: request.id, error: true })
						onError(error)
					}
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
