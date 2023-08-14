import { test } from 'uvu'
import * as assert from 'uvu/assert'
import { createServer } from '../lib/server'

export type Router = typeof router

export type Alert = {
	type: 'greeting'
	name: string
}

const server = createServer<Alert>((error) => {
	console.error(error)
})

const router = server.router({
	add(a: number, b: number) {
		return a + b
	},
	greetEveryone(name: string) {
		server.broadcast({
			type: 'greeting',
			name,
		})
	},
})

await server.listen({
	port: 3000,
	signal: new AbortController().signal,
	authenticate(request) {
		const url = new URL(request.url!)
		return url.searchParams.get('key') === 'password'
	},
	onRequest(request, response) {
		response.end('Hello World')
	},
	onConnection(connection) {
		connection.send({
			type: 'greeting',
			name: 'new connection',
		})
		// connection.close(1000, 'done')
		// connection.terminate()
		return () => {
			console.log('closed')
		}
	},
})
console.log('listening')

import { createClient } from '../lib/client'

const client = createClient<Alert, Router>()
const api = client.router

client.subscribe((event) => {
	console.log(event) // { type: 'greeting', name: string }
})

void client.listen(
	'ws://localhost:3000',
	async (connection) => {
		console.log('connection opened')
		await connection.closed // wait for connection to close
		console.log('connection closed')
	},
	{
		WebSocket: window.WebSocket,
		protocols: [],
		signal: new AbortController().signal,
		backoff: {
			jitter: false,
			maxDelay: Infinity,
			numOfAttempts: 10,
			retry: () => true,
			startingDelay: 100,
			timeMultiple: 2,
		},
	},
)

test('add', async () => {
	assert.is(await api.add(123, 456), 579)
})
