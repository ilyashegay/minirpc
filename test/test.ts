import { listen, createRPCServerStream } from '../lib/server'

const rpc = createRPCServerStream()

listen({ port: 3000 }, (ws) =>
	ws.readable.pipeThrough(rpc.connect()).pipeTo(ws.writable),
)
