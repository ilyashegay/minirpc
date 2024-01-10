import * as devalue from 'devalue';
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function makeMessenger(send, signal, transforms) {
    const inboundStreams = new Map();
    const outboundStreams = new Map();
    let nextStreamId = 1;
    let expectedChunk;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reducers = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const revivers = {};
    if (transforms) {
        for (const key of Object.keys(transforms)) {
            reducers[key] = transforms[key][0];
            revivers[key] = transforms[key][1];
        }
    }
    reducers.ReadableStream = (value) => {
        if (!(value instanceof ReadableStream))
            return;
        const id = nextStreamId++;
        setImmediate(() => void sendStream(id, value));
        return id;
    };
    revivers.ReadableStream = (id) => {
        return new ReadableStream({
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
                streamSend({ id, stream: 'cancel' });
            },
        });
    };
    signal.addEventListener('abort', () => {
        for (const stream of inboundStreams.values()) {
            stream.controller.error(signal.reason);
            stream.canceled = true;
        }
        for (const stream of outboundStreams.values()) {
            stream.abort(signal.reason);
        }
    });
    function streamSend(message, chunk) {
        send(JSON.stringify(message));
        if (chunk)
            send(chunk);
    }
    function receiveChunk(data, meta) {
        const stream = inboundStreams.get(meta.id);
        invariant(stream, `Unknown stream id ${meta.id}`);
        if (stream.canceled)
            return;
        if (meta.binary) {
            invariant(typeof data !== 'string', 'Expected binary chunk. Received string');
            invariant(data.byteLength === meta.length, `Stream Length: Expected ${meta.length} bytes. Received ${data.byteLength}`);
        }
        else {
            invariant(typeof data === 'string', 'Expected string chunk. Received binary');
            invariant(data.length === meta.length, `Stream Length: Expected ${meta.length} bytes. Received ${data.length}`);
        }
        stream.controller.enqueue(data);
        stream.read += meta.length;
        stream.count += 1;
    }
    function receiveMessage(data) {
        if (expectedChunk) {
            receiveChunk(data, expectedChunk);
            expectedChunk = undefined;
            return;
        }
        invariant(typeof data === 'string', 'Unexpected binary message');
        if (data === 'heartbeat') {
            return data;
        }
        const message = JSON.parse(data);
        if (Array.isArray(message)) {
            return devalue.unflatten(message, revivers);
        }
        invariant('stream' in message, 'Unknown message');
        if (message.stream === 'cancel') {
            const stream = outboundStreams.get(message.id);
            invariant(stream, `Unknown stream id ${message.id}`);
            stream.abort('Stream closed by consumer');
            return;
        }
        const stream = inboundStreams.get(message.id);
        invariant(stream, `Unknown stream id ${message.id}`);
        if (message.stream === 'event') {
            if (stream.canceled)
                return;
            invariant(stream.count === message.index, `Expected chunk index ${stream.count}. Got ${message.index}`);
            stream.controller.enqueue(devalue.unflatten(message.data));
            stream.count += 1;
        }
        if (message.stream === 'chunk') {
            invariant(stream.count === message.index, `Expected chunk index ${stream.count}. Got ${message.index}`);
            expectedChunk = {
                id: message.id,
                length: message.length,
                binary: message.binary,
            };
        }
        if (message.stream === 'done') {
            inboundStreams.delete(message.id);
            if (stream.canceled)
                return;
            invariant(stream.read === message.length, `Stream Length: Expected ${message.length} bytes. Received ${stream.read}`);
            stream.controller.close();
        }
        if (message.stream === 'error') {
            inboundStreams.delete(message.id);
            if (stream.canceled)
                return;
            stream.controller.error(message.error);
        }
    }
    async function sendStream(id, stream) {
        const controller = new AbortController();
        outboundStreams.set(id, controller);
        controller.signal.addEventListener('abort', () => {
            void reader.cancel(controller.signal.reason);
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
                    read += length;
                    streamSend({
                        stream: 'chunk',
                        id,
                        length,
                        binary,
                        index: count++,
                    }, value);
                }
                else if (typeof value === 'string') {
                    length = value.length;
                    binary = false;
                    read += length;
                    streamSend({
                        stream: 'chunk',
                        id,
                        length,
                        binary,
                        index: count++,
                    }, value);
                }
                else {
                    streamSend({
                        stream: 'event',
                        id,
                        index: count++,
                        data: JSON.parse(devalue.stringify(value)),
                    });
                }
            }
            streamSend({
                stream: 'done',
                id,
                length: read,
                count,
            });
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
            // console.error(error)
            streamSend({
                stream: 'error',
                id,
                error: String(error),
            });
        }
        finally {
            reader.releaseLock();
            outboundStreams.delete(id);
        }
    }
    return {
        parse: receiveMessage,
        send: (message) => {
            send(devalue.stringify(message, reducers));
        },
    };
}
