import WebSocket from 'ws'
import * as browser from './browser'

/** @type {import('./index').connect} */
export async function connect(url, protocols, onMessage, signal) {
	if (globalThis.WebSocket) {
		return browser.connect(url, protocols, onMessage, signal)
	}
	signal.throwIfAborted()
	const ws = new WebSocket(url, protocols)
	ws.binaryType = 'nodebuffer'
	await /** @type {Promise<void>} */ (
		new Promise((resolve, reject) => {
			const onOpen = () => {
				ws.off('error', onError)
				signal.removeEventListener('abort', onAbort)
				resolve()
			}
			/** @param {unknown} error */
			const onError = (error) => {
				ws.off('open', onOpen)
				signal.removeEventListener('abort', onAbort)
				reject(error)
			}
			const onAbort = () => {
				ws.off('open', onOpen)
				ws.off('error', onError)
				ws.close(1000, String(signal.reason))
				reject(signal.reason)
			}
			ws.once('open', onOpen)
			ws.once('error', onError)
			signal.addEventListener('abort', onAbort)
		})
	)
	ws.on(
		'message',
		/** @type {(data: Buffer, isBinary: boolean) => void} */ (
			data,
			isBinary,
		) => {
			onMessage(isBinary ? data : data.toString())
		},
	)
	return {
		protocol: ws.protocol,
		extensions: ws.extensions,
		closed: new Promise((resolve) => {
			/**
			 * @param {number} code
			 * @param {Buffer} reason
			 */
			const onClose = (code, reason) => {
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
