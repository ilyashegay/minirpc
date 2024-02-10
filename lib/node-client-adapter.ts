import WebSocket from 'ws'
import type { Adapter } from './client.js'

export default (): Adapter =>
	async ({ url, protocols, signal, onMessage }) => {
		signal.throwIfAborted()
		const ws = new WebSocket(url, protocols)
		ws.binaryType = 'nodebuffer'
		await new Promise<void>((resolve, reject) => {
			const onOpen = () => {
				ws.off('error', onError)
				signal.removeEventListener('abort', onAbort)
				resolve()
			}
			const onError = (error: unknown) => {
				ws.off('open', onOpen)
				signal.removeEventListener('abort', onAbort)
				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
				reject(error)
			}
			const onAbort = () => {
				ws.off('open', onOpen)
				ws.off('error', onError)
				ws.close(1000, String(signal.reason))
				// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
				reject(signal.reason)
			}
			ws.once('open', onOpen)
			ws.once('error', onError)
			signal.addEventListener('abort', onAbort)
		})
		ws.on('message', (data: Buffer, isBinary: boolean) => {
			onMessage(isBinary ? data : data.toString())
		})
		return {
			protocol: ws.protocol,
			extensions: ws.extensions,
			closed: new Promise((resolve) => {
				const onClose = (code: number, reason: Buffer) => {
					signal.removeEventListener('abort', onAbort)
					resolve({ code, reason: String(reason) })
				}
				const onAbort = () => {
					const reason = String(signal.reason)
					ws.off('close', onClose)
					ws.close(1000, reason)
					resolve({ code: 1000, reason })
				}
				ws.once('close', onClose)
				signal.addEventListener('abort', onAbort)
			}),
			send(data) {
				ws.send(data)
			},
			close(code, reason) {
				ws.close(code, reason)
			},
		}
	}
