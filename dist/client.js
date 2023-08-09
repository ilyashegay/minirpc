import { EtherealValue, controlledDuplex } from './utils.js';
export { createRPCClient, createRPCClientStream, RPCClientError, controlledDuplex, asyncForEach, Observable, } from './utils.js';
export class WebSocketStreamette {
    url;
    opened;
    readable;
    writable;
    constructor(url, options = {}) {
        if (options.signal?.aborted) {
            throw new DOMException('This operation was aborted', 'AbortError');
        }
        let done = false;
        const socket = new EtherealValue();
        const onerror = options.onerror ?? (() => undefined);
        this.url = url;
        options.signal?.addEventListener('abort', () => {
            done = true;
            socket.then((ws) => {
                ws.close();
            });
        });
        const duplex = controlledDuplex({
            async write(chunk) {
                const ws = await socket;
                ws.send(chunk);
            },
            async close() {
                done = true;
                const ws = await socket;
                ws.close();
            },
        });
        function wait() {
            if (done)
                return;
            return new Promise((resolve) => {
                setTimeout(resolve, 5000);
            });
        }
        async function* connections() {
            try {
                while (!done) {
                    const ws = new WebSocket(url, options.protocols ?? []);
                    ws.addEventListener('message', ({ data }) => {
                        duplex.controller.enqueue(data);
                    });
                    const opened = new Promise((resolve, reject) => {
                        ws.addEventListener('open', () => {
                            resolve();
                            ws.removeEventListener('error', reject);
                        });
                        ws.addEventListener('error', reject);
                    });
                    const closed = new Promise((resolve, reject) => {
                        ws.addEventListener('error', (error) => {
                            socket.reset();
                            reject(error);
                        });
                        ws.addEventListener('close', (event) => {
                            socket.reset();
                            resolve(event);
                        });
                    });
                    socket.set(ws);
                    try {
                        await opened;
                    }
                    catch (error) {
                        onerror(error);
                        await wait();
                        continue;
                    }
                    yield {
                        closed,
                        protocol: ws.protocol,
                        extensions: ws.extensions,
                    };
                    await closed.catch(onerror);
                    await wait();
                }
            }
            finally {
                duplex.controller.close();
            }
        }
        this.readable = duplex.readable;
        this.writable = duplex.writable;
        this.opened = connections();
    }
}
