import * as ws from 'ws';
import { controlledDuplex } from './utils.js';
export { createRPCServer, createRPCServerStream, RPCClientError, controlledDuplex, asyncForEach, Observable, } from './utils.js';
export class WebSocketClient {
    readable;
    writable;
    closed;
    constructor(ws) {
        const duplex = controlledDuplex({
            start(controller) {
                ws.addEventListener('message', ({ data }) => {
                    controller.enqueue(data);
                });
                ws.addEventListener('close', () => {
                    controller.close();
                });
            },
            write(chunk) {
                ws.send(chunk);
            },
            close() {
                ws.close();
            },
        });
        this.readable = duplex.readable;
        this.writable = duplex.writable;
        this.closed = new Promise((resolve) => {
            ws.addEventListener('close', (event) => {
                resolve(event);
            });
        });
    }
}
export function listen(options, onConnection) {
    new ws.WebSocketServer(options).on('connection', (ws) => {
        onConnection(new WebSocketClient(ws));
    });
}
