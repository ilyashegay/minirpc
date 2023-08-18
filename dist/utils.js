import * as devalue from 'devalue';
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function stringifySimple(value) {
    return devalue.stringify(value, {
        URL: (val) => val instanceof URL && val.href,
    });
}
export function makeServerMessenger(send, signal) {
    const messenger = makeMessenger(send, signal);
    return {
        parse: messenger.parse,
        send: messenger.send,
    };
}
export function makeClientMessenger(send) {
    let controller;
    let messenger;
    let queue;
    setInterval(() => {
        send('heartbeat');
    }, 15e3);
    return {
        parse(data) {
            invariant(messenger);
            return messenger.parse(data);
        },
        send(message) {
            if (messenger) {
                messenger.send(message);
            }
            else {
                queue ??= [];
                queue.push(message);
            }
        },
        open() {
            controller = new AbortController();
            messenger = makeMessenger(send, controller.signal);
            queue?.forEach(messenger.send);
            queue = undefined;
        },
        close() {
            controller.abort();
            messenger = undefined;
        },
    };
}
function makeMessenger(send, signal) {
    const inboundStreams = new Map();
    const outboundStreams = new Map();
    let expectedChunk;
    let nextStreamId = 1;
    const reducers = {
        URL: (val) => val instanceof URL && val.href,
        ReadableStream: (val) => {
            if (!(val instanceof ReadableStream))
                return;
            const id = nextStreamId++;
            setImmediate(() => void sendStream(id, val));
            return id;
        },
    };
    const revivers = {
        URL: (href) => new URL(href),
        ReadableStream: (id) => {
            new ReadableStream({
                start(controller) {
                    inboundStreams.set(id, {
                        controller,
                        read: 0,
                        count: 0,
                        canceled: false,
                    });
                },
                cancel() {
                    const stream = inboundStreams.get(id);
                    invariant(stream);
                    stream.canceled = true;
                    send(JSON.stringify({ id, stream: 'cancel' }));
                },
            });
        },
    };
    signal.addEventListener('abort', () => {
        for (const stream of inboundStreams.values()) {
            stream.controller.error(signal.reason);
            stream.canceled = true;
        }
        for (const stream of outboundStreams.values()) {
            stream.abort();
        }
    });
    function parse(data) {
        if (expectedChunk) {
            const stream = inboundStreams.get(expectedChunk.id);
            invariant(stream, `Unknown stream id ${expectedChunk.id}`);
            if (stream.canceled)
                return;
            if (expectedChunk.binary) {
                invariant(typeof data !== 'string', 'Expected binary chunk. Received string');
                invariant(data.byteLength === expectedChunk.length, `Stream Length: Expected ${expectedChunk.length} bytes. Received ${data.byteLength}`);
            }
            else {
                invariant(typeof data === 'string', 'Expected string chunk. Received binary');
                invariant(data.length === expectedChunk.length, `Stream Length: Expected ${expectedChunk.length} bytes. Received ${data.length}`);
            }
            stream.controller.enqueue(data);
            stream.read += expectedChunk.length;
            expectedChunk = undefined;
            return;
        }
        invariant(typeof data === 'string', 'Unexpected binary message');
        if (data === 'heartbeat') {
            return data;
        }
        const json = JSON.parse(data);
        if ('stream' in json) {
            if (json.stream === 'cancel') {
                const stream = outboundStreams.get(json.id);
                invariant(stream, `Unknown stream id ${json.id}`);
                stream.abort();
            }
            if (json.stream === 'chunk') {
                const stream = inboundStreams.get(json.id);
                invariant(stream, `Unknown stream id ${json.id}`);
                invariant(stream.count === json.index, `Expected chunk index ${stream.count}. Got ${json.index}`);
                expectedChunk = {
                    id: json.id,
                    length: json.length,
                    binary: json.binary,
                };
            }
            if (json.stream === 'done') {
                const stream = inboundStreams.get(json.id);
                invariant(stream, `Unknown stream id ${json.id}`);
                inboundStreams.delete(json.id);
                if (stream.canceled)
                    return;
                invariant(stream.read === json.length, `Stream Length: Expected ${json.length} bytes. Received ${stream.read}`);
                stream.controller.close();
                inboundStreams.delete(json.id);
            }
            if (json.stream === 'error') {
                const stream = inboundStreams.get(json.id);
                invariant(stream, `Unknown stream id ${json.id}`);
                inboundStreams.delete(json.id);
                if (stream.canceled)
                    return;
                stream.controller.error(json.error);
            }
            return;
        }
        if (Array.isArray(json)) {
            return devalue.unflatten(json, revivers);
        }
    }
    async function sendStream(id, stream) {
        const controller = new AbortController();
        outboundStreams.set(id, controller);
        controller.signal.addEventListener('abort', () => {
            void reader.cancel(signal.reason);
        });
        const reader = stream.getReader();
        let read = 0;
        let count = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                let length = 0;
                let binary = true;
                if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                    length = value.byteLength;
                }
                else if (typeof value === 'string') {
                    length = value.length;
                    binary = false;
                }
                else {
                    throw new Error('Unexpected value');
                }
                read += length;
                send(JSON.stringify({
                    stream: 'chunk',
                    id,
                    length,
                    binary,
                    index: count++,
                }));
                send(value);
            }
            send(JSON.stringify({
                stream: 'done',
                id,
                length: read,
                count,
            }));
        }
        catch (error) {
            if (signal.aborted)
                return;
            console.error(error);
            send(JSON.stringify({
                stream: 'error',
                id,
                error: String(error),
            }));
        }
        finally {
            reader.releaseLock();
            outboundStreams.delete(id);
        }
    }
    return {
        parse,
        send: (message) => {
            send(devalue.stringify(message, reducers));
        },
    };
}
