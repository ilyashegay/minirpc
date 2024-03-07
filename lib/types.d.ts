import http from 'node:http'
import WebSocket from 'ws'

export type DevalueTransforms = Record<
	string,
	[(value: unknown) => unknown, (value: any) => unknown]
>

export type SocketData = string | ArrayBuffer | ArrayBufferView

export type ClientMessage = { id: number; method: string; params: unknown[] }

export type ServerMessage =
	| { id: number; result: unknown }
	| { id: number; error: unknown }

export type StreamMessage =
	| { id: number; stream: 'chunk'; data: unknown[] }
	| { id: number; stream: 'chunk'; type: string }
	| { id: number; stream: 'done' }
	| { id: number; stream: 'error'; error: string }
	| { id: number; stream: 'cancel'; reason: string }

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
						error?: (error: unknown) => void
					},
				) => void
		  }
		: Record<string, never>)

export const connectionClosedException: DOMException

export type Connection = {
	closed: Promise<{ code?: number; reason?: string }>
	close(code?: number, reason?: string): void
}

export type Client<Router extends ClientRoutes> = {
	router: Router
	connect(options: ConnectOptions): Promise<Connection>
}

export type ConnectOptions = {
	url: string
	signal?: AbortSignal
	backoff?: Partial<BackoffOptions>
	transforms?: DevalueTransforms
	pingInterval?: number
	pongTimeout?: number
	adapter?: Adapter
	error?: (error: unknown) => void
}

export type Adapter = (options: {
	url: string
	signal: AbortSignal
	message: (data: SocketData) => void
	close: (code: number, reason: string) => void
}) => Promise<{
	message: (data: SocketData) => void
	close: (code?: number, reason?: string) => void
}>

export type BackoffOptions = {
	jitter: boolean
	maxDelay: number
	numOfAttempts: number
	retry: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>
	startingDelay: number
	timeMultiple: number
}

export function connect<Router extends ClientRoutes>(
	options: ConnectOptions & {
		client?: Client<Router>
		connection?: (connection: Connection) => void | PromiseLike<void>
	},
): Router

export function createClient<Router extends ClientRoutes>(): Client<Router>

export class RPCClientError extends Error {}

export type Context<T> = {
	get(): T
	set(value: T): void
	update(updateFn: (value: T) => T): void
}

export type Ware = {
	use(fn: () => void): Ware
	routes<R extends ServerRoutes>(routes: R): ClientRoutes<R>
}

export function createChannel<T, P extends unknown[] = []>(
	subscribe?: (...args: P) => T | Promise<T>,
	unsubscribe?: () => unknown,
): {
	readonly size: number
	push: (payload: T) => void
	pull: (...args: P) => ReadableStream<T>
}

export function getContextKey(): WeakKey

export function createContext<T = undefined>(): (
	key?: WeakKey,
) => Context<T | undefined>

export function createContext<T>(initialValue: T): (key?: WeakKey) => Context<T>

export type ServerServeOptions = {
	port?: number
	signal?: AbortSignal
	transforms?: DevalueTransforms
	pingTimeout?: number
	pongTimeout?: number
	request?: http.RequestListener
	upgrade?: (ctx: {
		request: http.IncomingMessage
		url: URL
		cookies: Record<string, string | undefined>
		upgrade(): WebSocket
		reject(code: number): void
	}) => unknown
	error?: (error: unknown) => void
}

export type ServeConnectOptions = {
	key: WeakKey
	transforms?: DevalueTransforms
	pingTimeout?: number
	pongTimeout?: number
	message: (data: SocketData) => void
	close(): void
	error?: (error: unknown) => void
}

export function createServer(): {
	serve: (options?: ServerServeOptions) => Promise<void>
	connect: (client: ServeConnectOptions) => {
		message(data: SocketData): void
		close(reason: string | Error): void
	}
	router: <R extends ServerRoutes>(routes: R) => ClientRoutes<R>
	use: (fn: () => void) => Ware
}
