import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from '../lib/client'
import { createServer, createContext, createChannel } from '../lib/server'
import serve from '../lib/node-server-adapter'
import nodePRCClientAdapter from '../lib/node-client-adapter'

const abortController = new AbortController()

const server = createServer({
	onError: (error) => {
		console.error(error)
	},
})

await serve(server, {
	port: 3000,
	signal: abortController.signal,
	onRequest(request, response) {
		response.end('Hello World')
	},
	onUpgrade(ctx) {
		console.log('upgrading')
		const ws = ctx.upgrade()
		numberContext(ws).set(9)
		console.log('new connection')
		ws.on('close', (code, reason) => {
			console.log('closed', code, reason.toString())
		})
	},
	onError(error) {
		console.error(error)
	},
})
console.log('listening')

const api = connect<typeof router>({
	url: 'ws://localhost:3000',
	protocols: [],
	signal: abortController.signal,
	adapter: nodePRCClientAdapter(),
	backoff: {
		jitter: false,
		maxDelay: Infinity,
		numOfAttempts: 10,
		retry: () => true,
		startingDelay: 100,
		timeMultiple: 2,
	},
	async onConnection(connection) {
		console.log('connection opened')
		await connection.closed // wait for connection to close
		console.log('connection closed')
	},
	onError: (error) => {
		console.error(error)
	},
})

const channel = createChannel((a: number, b: number): number => {
	const interval = setInterval(() => {
		channel.push(++a + channel.size)
		if (a === b) {
			channel.push(0)
			clearInterval(interval)
		}
	}, 50)
	return a + channel.size
})

const numberContext = createContext(0)
const mwCounterCtx = createContext(0)

const router = server.router({
	voidReturn() {
		return
	},
	nullReturn() {
		return null
	},
	getRangeChannel: channel.pull,
	...server
		.use(() => {
			mwCounterCtx().update((n) => n + 1)
		})
		.routes({
			readMwCounterCtx() {
				return mwCounterCtx().get()
			},
		}),
	set(val: number) {
		numberContext().set(val)
	},
	get() {
		return numberContext().get()
	},
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
				controller.enqueue(numberContext().get())
				controller.close()
			},
		})
	},
})

await test('voidReturn', async () => {
	// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
	assert.equal(await api.voidReturn(), undefined)
})
await test('nullReturn', async () => {
	assert.equal(await api.nullReturn(), null)
})
await test('add', async () => {
	assert.equal(await api.add(123, 456), 579)
})
await test('get', async () => {
	assert.equal(await api.get(), 9)
})
await test('set', async () => {
	await api.set(100)
	assert.equal(await api.get(), 100)
})
await test('list', async () => {
	const list: number[] = []
	const stream = await api.list(10)
	const reader = stream.getReader()
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		list.push(value)
	}
	assert.deepEqual(list, [10, 11, 12, 13, 100])
})
await test('mwCounterCtx', async () => {
	assert.equal(await api.readMwCounterCtx(), 1)
	assert.equal(await api.readMwCounterCtx(), 2)
	assert.equal(await api.readMwCounterCtx(), 3)
})
await test('getRangeChannel', async () => {
	const list: number[] = []
	await new Promise<void>((resolve) => {
		api.getRangeChannel(3, 7).subscribe((n) => {
			list.push(n)
			if (n === 0) resolve()
		})
	})
	assert.deepEqual(list, [3, 5, 6, 7, 8, 0])
})

abortController.abort()
