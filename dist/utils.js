import * as devalue from 'devalue';
import { makeStreamTransport, } from './streams.js';
export function invariant(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function stringifySimple(value) {
    return devalue.stringify(value, {
        URL: (val) => val instanceof URL && val.href,
    });
}
export function makeServerMessenger(send, signal, transforms) {
    const messenger = makeMessenger(send, signal, transforms);
    return {
        parse: messenger.parse,
        send: messenger.send,
    };
}
export function makeClientMessenger(send, transforms) {
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
            messenger = makeMessenger(send, controller.signal, transforms);
            queue?.forEach(messenger.send);
            queue = undefined;
        },
        close() {
            controller.abort();
            messenger = undefined;
        },
    };
}
function makeMessenger(send, signal, transforms) {
    let expectedChunk;
    const streams = makeStreamTransport((message, chunk) => {
        send(JSON.stringify(message));
        if (chunk)
            send(chunk);
    });
    signal.addEventListener('abort', () => {
        streams.abort(signal.reason);
    });
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
    reducers.ReadableStream = streams.reduce;
    revivers.ReadableStream = streams.revive;
    return {
        parse: (data) => {
            if (expectedChunk) {
                streams.receiveChunk(data, expectedChunk);
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
            expectedChunk = streams.receiveMessage(message);
        },
        send: (message) => {
            send(devalue.stringify(message, reducers));
        },
    };
}
