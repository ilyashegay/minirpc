Server:

```ts
import { createServer } from 'minirpc/server'

export type Router = typeof router

export type Alert = {
	type: 'greeting'
	name: string
}

const rpc = createServer<Alert>()

const router = rpc.router({
	greetEveryone(name: string) {
		rpc.broadcast({
			type: 'greeting',
			name,
		})
	},
})

await rpc.listen({
	port: 3000,
	signal: new AbortController().signal,
	authenticate(request) {
		const url = new URL(request.url)
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
```

Client:

```ts
import { createClient } from 'minirpc/client'
import type { Alert, Router } from './server'

const rpc = createClient<Router>()
export default rpc.router

rpc.subscribe<Alert>((event) => {
	console.log(event) // { type: 'greeting', name: string }
})

await rpc.listen(
	'ws://localhost:3000',
	async (connection) => {
		console.log('connection opened')
		await connection.closed // wait for connection to close
		console.log('connection closed')
	},
	{
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
```
