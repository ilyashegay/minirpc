import * as devalue from 'devalue';
export class RPCClientError extends Error {
}
export class Observable {
    observers = [];
    subscribe(observer) {
        this.observers.push(observer);
    }
    next(value) {
        for (const observer of this.observers) {
            observer(value);
        }
    }
}
export class MiniSignal {
    static resolve(value) {
        const signal = new MiniSignal();
        signal.resolve(value);
        return signal;
    }
    #s = false;
    #v;
    #h;
    #p;
    resolve(value) {
        const h = this.#h;
        this.#s = true;
        this.#v = value;
        this.#h = undefined;
        if (typeof h === 'function') {
            h(value);
        }
        else if (typeof h !== 'undefined') {
            for (const i of h)
                i(value);
        }
    }
    then(handler) {
        if (this.#s) {
            handler(this.#v);
        }
        else if (typeof this.#h === 'undefined') {
            this.#h = handler;
        }
        else if (typeof this.#h === 'function') {
            this.#h = [this.#h, handler];
        }
        else {
            this.#h.push(handler);
        }
    }
    get promise() {
        return (this.#p ??= this.#s
            ? Promise.resolve(this.#v)
            : new Promise((resolve) => {
                this.then(resolve);
            }));
    }
}
export async function asyncForEach(iterable, handle) {
    if (iterable instanceof ReadableStream) {
        for (const reader = iterable.getReader();;) {
            const { value, done } = await reader.read();
            if (value !== undefined)
                await handle(value);
            if (done)
                return;
        }
    }
    for await (const connection of iterable) {
        await handle(connection);
    }
}
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function sleep(ms) {
    const signal = new MiniSignal();
    setTimeout(() => {
        signal.resolve();
    }, ms);
    return signal;
}
export function makeMessageParser() {
    const streams = new Map();
    let activeId;
    return function parse(data, isBinary) {
        if (isBinary) {
            invariant(activeId !== undefined, 'Unexpected binary message');
            const stream = streams.get(activeId);
            invariant(stream, `Unknown stream id ${activeId}`);
            invariant(ArrayBuffer.isView(data), 'Binary chunk is of type string');
            stream.controller.enqueue(data);
            stream.read += data.byteLength;
            return;
        }
        const json = JSON.parse(String(data));
        if ('stream' in json) {
            if (json.stream === 'start') {
                invariant(activeId === undefined, 'Stream not closed');
                activeId = json.id;
            }
            if (json.stream === 'done') {
                invariant(activeId === json.id, 'Wrong Stream closed');
                const stream = streams.get(json.id);
                invariant(stream, 'Unexpected stream end');
                invariant(stream.read === json.length, `Stream Length: Expected ${json.length} bytes. Received ${stream.read}`);
                stream.controller.close();
                activeId = undefined;
            }
            if (json.stream === 'error') {
                invariant(activeId === json.id, 'Wrong Stream closed');
                const stream = streams.get(json.id);
                invariant(stream, 'Unexpected stream end');
                stream.controller.error(json.error);
                activeId = undefined;
            }
        }
        const revivers = {
            URL: (href) => new URL(href),
            Stream: (id) => new ReadableStream({
                start(controller) {
                    streams.set(id, { controller, read: 0 });
                },
            }),
        };
        if (Array.isArray(json)) {
            return devalue.unflatten(json, revivers);
        }
    };
}
export function makeMessageSender(send) {
    let nextId = 1;
    const queue = [];
    async function sendStream() {
        const { id, stream } = queue[0];
        const reader = stream.getReader();
        let read = 0;
        try {
            send(JSON.stringify({ stream: 'start', id }));
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value instanceof ArrayBuffer) {
                    read += value.byteLength;
                    send(value);
                }
                if (ArrayBuffer.isView(value)) {
                    read += value.byteLength;
                    send(value);
                }
                if (typeof value === 'string') {
                    read += value.length;
                    send(new TextEncoder().encode(value));
                }
                throw new Error('Unexpected value');
            }
            send(JSON.stringify({ stream: 'done', id, length: read }));
        }
        catch (error) {
            send(JSON.stringify({ stream: 'error', id, error }));
        }
        finally {
            reader.releaseLock();
            queue.shift();
            if (queue.length)
                void sendStream();
        }
    }
    return (message) => {
        send(devalue.stringify(message, {
            URL: (val) => val instanceof URL && val.href,
            Stream: (val) => {
                if (!(val instanceof ReadableStream))
                    return;
                const id = nextId++;
                queue.push({
                    id,
                    stream: val,
                });
                if (queue.length === 1) {
                    sendStream().catch((error) => {
                        console.error(error);
                    });
                }
                return id;
            },
        }));
    };
}
export function stringifySimple(value) {
    return devalue.stringify(value, {
        URL: (val) => val instanceof URL && val.href,
    });
}
