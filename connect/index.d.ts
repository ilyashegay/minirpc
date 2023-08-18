export type Connection = {
	protocol: string
	extensions: string
	closed: Promise<{ code?: number; reason?: string }>
	send(message: string | ArrayBufferLike | ArrayBufferView): void
	close(code?: number, reason?: string): void
}

export declare function connect(
	url: string,
	protocols: undefined | string | string[],
	onMessage: (data: string | ArrayBufferLike | ArrayBufferView) => void,
	signal: AbortSignal,
): Promise<Connection>
