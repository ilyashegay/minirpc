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

export type Response = ResultResponse | ErrorResponse

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

export function sleep(ms: number) {
	const signal = new MiniSignal<void>()
	setTimeout(() => {
		signal.resolve()
	}, ms)
	return signal
}
