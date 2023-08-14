import * as devalue from 'devalue';
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function makeMessageParser() {
    const streams = new Map();
    let activeId;
    return function parse(data, isBinary) {
        if (isBinary) {
            invariant(activeId !== undefined, 'Unexpected binary message');
            const stream = streams.get(activeId);
            invariant(stream, `Unknown stream id ${activeId}`);
            if (stream.canceled)
                return;
            if (data instanceof ArrayBuffer) {
                data = new Uint8Array(data);
            }
            invariant(typeof data !== 'string', 'Binary chunk is of type string');
            invariant(ArrayBuffer.isView(data), 'Unknown chunk type');
            stream.controller.enqueue(data);
            stream.read += data.byteLength;
            return;
        }
        const str = String(data);
        if (str === 'heartbeat') {
            return str;
        }
        const json = JSON.parse(str);
        if ('stream' in json) {
            if (json.stream === 'start') {
                invariant(activeId === undefined, 'Stream not closed');
                activeId = json.id;
            }
            if (json.stream === 'done') {
                invariant(activeId === json.id, 'Wrong Stream closed');
                const stream = streams.get(json.id);
                invariant(stream, 'Unexpected stream end');
                if (stream.canceled)
                    return;
                invariant(stream.read === json.length, `Stream Length: Expected ${json.length} bytes. Received ${stream.read}`);
                stream.controller.close();
                activeId = undefined;
            }
            if (json.stream === 'error') {
                invariant(activeId === json.id, 'Wrong Stream closed');
                const stream = streams.get(json.id);
                invariant(stream, 'Unexpected stream end');
                if (stream.canceled)
                    return;
                stream.controller.error(json.error);
                activeId = undefined;
            }
        }
        const revivers = {
            URL: (href) => new URL(href),
            ReadableStream: (id) => {
                new ReadableStream({
                    start(controller) {
                        streams.set(id, { controller, read: 0, canceled: false });
                    },
                    cancel() {
                        const stream = streams.get(id);
                        invariant(stream);
                        stream.canceled = true;
                    },
                });
            },
        };
        if (Array.isArray(json)) {
            return devalue.unflatten(json, revivers);
        }
    };
}
export function makeMessageSender(send) {
    let nextId = 1;
    let streamActive = false;
    const queue = [];
    async function sendStream() {
        if (!queue.length)
            return;
        streamActive = true;
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
                else if (ArrayBuffer.isView(value)) {
                    read += value.byteLength;
                    send(value);
                }
                else if (typeof value === 'string') {
                    read += value.length;
                    send(new TextEncoder().encode(value));
                }
                else {
                    throw new Error('Unexpected value');
                }
            }
            send(JSON.stringify({ stream: 'done', id, length: read }));
        }
        catch (error) {
            console.error(error);
            send(JSON.stringify({ stream: 'error', id, error: String(error) }));
        }
        finally {
            reader.releaseLock();
            queue.shift();
            streamActive = false;
            if (queue.length)
                void sendStream();
        }
    }
    return (message) => {
        send(devalue.stringify(message, {
            URL: (val) => val instanceof URL && val.href,
            ReadableStream: (val) => {
                if (!(val instanceof ReadableStream))
                    return;
                const id = nextId++;
                queue.push({
                    id,
                    stream: val,
                });
                return id;
            },
        }));
        if (!streamActive && queue.length) {
            sendStream().catch((error) => {
                console.error(error);
            });
        }
    };
}
export function stringifySimple(value) {
    return devalue.stringify(value, {
        URL: (val) => val instanceof URL && val.href,
    });
}
