/* eslint-disable @typescript-eslint/no-explicit-any */
import * as devalue from 'devalue';
export function isClientMessage(message) {
    return (typeof message.id === 'number' &&
        typeof message.method === 'string' &&
        Array.isArray(message.params));
}
export function isServerMessage(message) {
    return (typeof message.id === 'number' &&
        ('result' in message || 'error' in message));
}
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function createTransport(send, transforms) {
    const inboundStreams = new Map();
    const outboundStreams = new Map();
    let nextStreamId = 1;
    let expectedChunkId;
    let lastMessageTime = 0;
    let closed = false;
    const reducers = {};
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
                    canceled: false,
                });
            },
            cancel(reason) {
                const stream = inboundStreams.get(id);
                invariant(stream);
                stream.canceled = true;
                send(JSON.stringify({ id, stream: 'cancel', reason: String(reason) }));
            },
        });
    };
    function receiveMessage(data) {
        invariant(!closed);
        lastMessageTime = Date.now();
        if (expectedChunkId) {
            const stream = inboundStreams.get(expectedChunkId);
            invariant(stream, `Unknown stream id ${expectedChunkId}`);
            expectedChunkId = undefined;
            if (stream.canceled)
                return;
            stream.controller.enqueue(data);
            return;
        }
        invariant(typeof data === 'string', 'Unexpected binary message');
        if (data === 'ping') {
            send('pong');
            return;
        }
        if (data === 'pong') {
            return;
        }
        const message = JSON.parse(data);
        if (Array.isArray(message)) {
            return devalue.unflatten(message, revivers);
        }
        invariant('stream' in message, 'Unknown message');
        if (message.stream === 'cancel') {
            const stream = outboundStreams.get(message.id);
            invariant(stream, `Unknown stream id ${message.id}`);
            stream.abort(message.reason);
            return;
        }
        if (message.stream === 'chunk') {
            expectedChunkId = message.id;
            return;
        }
        const stream = inboundStreams.get(message.id);
        invariant(stream, `Unknown stream id ${message.id}`);
        if (message.stream === 'event') {
            if (stream.canceled)
                return;
            stream.controller.enqueue(devalue.unflatten(message.data));
        }
        if (message.stream === 'done') {
            inboundStreams.delete(message.id);
            if (stream.canceled)
                return;
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
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (typeof value === 'string' ||
                    value instanceof ArrayBuffer ||
                    ArrayBuffer.isView(value)) {
                    send(JSON.stringify({ stream: 'chunk', id }));
                    send(value);
                }
                else {
                    const data = JSON.parse(devalue.stringify(value));
                    send(JSON.stringify({ stream: 'event', id, data }));
                }
            }
            send(JSON.stringify({ stream: 'done', id }));
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
            send(JSON.stringify({ stream: 'error', id, error: String(error) }));
        }
        finally {
            reader.releaseLock();
            outboundStreams.delete(id);
        }
    }
    return {
        parse: receiveMessage,
        send: (message) => {
            invariant(!closed);
            send(devalue.stringify(message, reducers));
        },
        close(reason) {
            invariant(!closed);
            closed = true;
            for (const stream of inboundStreams.values()) {
                stream.controller.error(reason);
                stream.canceled = true;
            }
            for (const stream of outboundStreams.values()) {
                stream.abort(reason);
            }
        },
        getTimeUntilExpectedExpiry(interval) {
            return lastMessageTime + interval - Date.now();
        },
        ping(latency, onResult) {
            invariant(!closed);
            send('ping');
            const pingTime = Date.now();
            setTimeout(() => {
                if (!closed)
                    onResult(lastMessageTime >= pingTime);
            }, latency);
        },
    };
}
