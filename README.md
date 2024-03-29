## Basic Usage

Server:

```ts
import { createServer } from 'minirpc'

const server = createServer()

const router = server.router({
	greet(name: string) {
		return `Hello ${name}`
	},
})

export type Router = typeof router

await server.serve({ port: 3000 })
```

Client:

```ts
import createClient from 'minirpc'
import type { Router } from './server'

const api = createClient<Router>({
	url: 'ws://localhost:3000',
})

console.log(await api.greet('World')) // Hello World
```

## Subscriptions

Server:

```ts
import { createChannel } from 'minirpc'

const channel = createChannel((name: string) => {
	return `Welcome ${name} to this channel`
})

setInterval(() => {
	channel.push(`This channel has ${channel.size} subscribers`)
}, 1000)

router({
	getEvents: channel.pull,
})
```

Client:

```ts
api.getEvents('John Doe').subscribe((event) => {
	// Welcome John Doe to this channel
	// This channel has 1 subscribers
	console.log(event)
})
```

## Context

```ts
import { createContext, RPCClientError } from 'minirpc'

const userIdContext = createContext<string>()

router({
	logIn(username: string, password: string) {
		const userId = userIdContext()
		if (username === 'Admin' && password === '123456') {
			userId.set('admin')
		} else {
			throw new RPCClientError('Wrong credentials')
		}
	},
	getAdminData() {
		const userId = userIdContext()
		if (userId.get() === 'admin') {
			return 'secret'
		} else {
			throw new RPCClientError('Expected Admin')
		}
	},
})
```

## Connection Options

Server:

```ts
server.serve({
	onUpgrade(ctx) {
		if (ctx.request.url === '/forbidden') {
			ctx.error(401)
			return
		}
		const ws = ctx.upgrade()
		console.log('connection open')
		ws.on('close', (code, reason) => {
			console.log('connection closed')
		})
	},
})
```

Client:

```ts
const api = createClient<Router>({
	url: 'ws://localhost:3000',
	backoff: {
		jitter: false,
		maxDelay: Infinity,
		numOfAttempts: 10,
		retry: () => true,
		startingDelay: 100,
		timeMultiple: 2,
	},
	onConnection((connection) => {
		console.log('connection opened')
		await connection.closed // wait for connection to close
		console.log('connection closed')
	})
})
```

## Pruning Stale Connections

Server:

```ts
const server = createServer({
	pingTimeout: 60_000,
	pongTimeout: 1_000,
})
```

Client:

```ts
const api = createClient({
	pingInterval: 30_000,
	pongTimeout: 1_000,
})
```
