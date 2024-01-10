import { test } from 'uvu'
import * as assert from 'uvu/assert'
import { createServer } from '../lib/server'

export type Router = typeof router

export type Alert = {
	type: 'greeting'
	name: string
}

const abortController = new AbortController()

const server = createServer((error) => {
	console.error(error)
})

const router = server.router({
	add(a: number, b: number) {
		return a + b
	},
	list(a: number) {
		return new ReadableStream<number>({
			start(controller) {
				controller.enqueue(a)
				controller.enqueue(a + 1)
				controller.enqueue(a + 2)
				controller.enqueue(a + 3)
				controller.close()
			},
		})
	},
})

await server.listen({
	port: 3000,
	signal: abortController.signal,
	onRequest(request, response) {
		response.end('Hello World')
	},
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	onUpgrade(request, socket, head) {
		console.log('upgrading')
		return 101
	},
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	onConnection(connection) {
		console.log('new connection')
		return () => {
			console.log('closed')
		}
	},
})
console.log('listening')

import { createClient } from '../lib/client'

const client = createClient<Router>({})
const api = client.router

void client.listen(
	'ws://localhost:3000',
	async (connection) => {
		console.log('connection opened')
		await connection.closed // wait for connection to close
		console.log('connection closed')
	},
	{
		protocols: [],
		signal: abortController.signal,
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
test('list', async () => {
	const list: number[] = []
	await api.list(10).subscribe((n) => {
		list.push(n)
	})
	assert.equal(list, [10, 11, 12, 13])
})

test.run()
