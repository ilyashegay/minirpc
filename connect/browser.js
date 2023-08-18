/** @type {import('./index').connect} */
export async function connect(url, protocols, onMessage, signal) {
	signal.throwIfAborted()
	const ws = new WebSocket(url, protocols)
	ws.binaryType = 'arraybuffer'
	await /** @type {Promise<void>} */ (
		new Promise((resolve, reject) => {
			const onOpen = () => {
				ws.removeEventListener('error', onError)
				signal.removeEventListener('abort', onAbort)
				resolve()
			}
			/** @param {unknown} error */
			const onError = (error) => {
				ws.removeEventListener('open', onOpen)
				signal.removeEventListener('abort', onAbort)
				reject(error)
			}
			const onAbort = () => {
				ws.removeEventListener('open', onOpen)
				ws.removeEventListener('error', onError)
				ws.close(1000, String(signal.reason))
				reject(signal.reason)
			}
			ws.addEventListener('open', onOpen)
			ws.addEventListener('error', onError)
			signal.addEventListener('abort', onAbort)
		})
	)
	ws.addEventListener('message', (event) => {
		onMessage(event.data)
	})
	return {
		protocol: ws.protocol,
		extensions: ws.extensions,
		closed: new Promise((resolve) => {
			/** @param {CloseEvent} event */
			const onClose = (event) => {
				signal.removeEventListener('abort', onAbort)
				resolve({ code: event.code, reason: event.reason })
			}
			const onAbort = () => {
				const reason = String(signal.reason)
				ws.removeEventListener('close', onClose)
				ws.close(1000, reason)
				resolve({ code: 1000, reason })
			}
			ws.addEventListener('close', onClose)
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
