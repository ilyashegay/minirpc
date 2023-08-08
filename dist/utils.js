import superjson from 'superjson';
function safety(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        }
        catch (error) {
            return Promise.reject(error);
        }
    };
}
export class RPCClientError extends Error {
}
export function createRPCClient() {
    let nextRequestId = 1;
    const queries = new Map();
    const events = new Observable();
    const requests = new Observable();
    function message(msg) {
        if (typeof msg === 'string') {
            msg = superjson.parse(msg);
        }
        if ('event' in msg) {
            events.next(msg.event);
            return;
        }
        const handle = queries.get(msg.id);
        if (!handle) {
            console.error(`Unknown response ID: ${msg.id}`);
            return;
        }
        queries.delete(msg.id);
        if ('result' in msg) {
            handle.resolve(msg.result);
        }
        else {
            handle.reject(typeof msg.error === 'string' ? msg.error : 'request failed');
        }
    }
    function query(method, params) {
        return new Promise((resolve, reject) => {
            const id = nextRequestId++;
            requests.next({ id, method, params });
            queries.set(id, { resolve, reject });
        });
    }
    const router = new Proxy({}, {
        get(_, prop) {
            return (...args) => {
                if (typeof prop === 'string') {
                    return query(prop, args);
                }
            };
        },
    });
    return { router, message, events, requests };
}
export function createRPCClientStream() {
    const client = createRPCClient();
    const duplex = controlledDuplex({
        start(controller) {
            client.requests.subscribe((request) => {
                controller.enqueue(superjson.stringify(request));
            });
        },
        transform(chunk) {
            client.message(superjson.parse(String(chunk)));
        },
    });
    return {
        router: client.router,
        events: client.events,
        readable: duplex.readable,
        writable: duplex.writable,
    };
}
export function createRPCServer() {
    const methods = {};
    function message(req, callback) {
        const request = typeof req === 'string' ? superjson.parse(req) : req;
        if (!(request.method in methods)) {
            callback({
                id: request.id,
                method: request.method,
                error: `Unknown method: ${request.method}`,
            });
            return;
        }
        methods[request.method](...request.params)
            .then((result) => {
            callback({
                id: request.id,
                method: request.method,
                result: result ?? null,
            });
        })
            .catch((error) => {
            let message = true;
            if (error instanceof RPCClientError) {
                message = error.message;
                error = undefined;
            }
            callback({
                id: request.id,
                method: request.method,
                error: message,
            }, error);
        });
    }
    function router(router) {
        const result = {};
        for (const key of Object.keys(router)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            methods[key] = result[key] = safety(router[key]);
        }
        return result;
    }
    return { router, message };
}
export function createRPCServerStream(options) {
    const server = createRPCServer();
    const clients = new Set();
    const events = options.eventSource((event) => {
        if (!clients.size)
            return;
        const message = superjson.stringify({ event });
        for (const controller of clients) {
            controller.enqueue(message);
        }
    });
    function connect() {
        return new TransformStream({
            start(controller) {
                clients.add(controller);
                controller.enqueue(superjson.stringify({ event: events.subscribe() }));
            },
            transform(chunk, controller) {
                const request = superjson.parse(String(chunk));
                server.message(request, (response, error) => {
                    if (error)
                        options.onerror?.(error);
                    controller.enqueue(superjson.stringify(response));
                });
            },
            flush(controller) {
                clients.delete(controller);
                events.unsubscribe();
            },
        });
    }
    return {
        router: server.router,
        connect,
    };
}
export function controlledDuplex(transformer, writableStrategy, readableStrategy) {
    let controller;
    const { readable, writable } = new TransformStream({
        ...transformer,
        start(c) {
            controller = c;
            return transformer?.start?.(c);
        },
    }, writableStrategy, readableStrategy);
    invariant(controller);
    return { controller, readable, writable };
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
export class StrictMap extends Map {
    initializer;
    constructor(initializer = 'Missing key') {
        super();
        this.initializer = initializer;
    }
    get(key) {
        if (!this.has(key)) {
            if (typeof this.initializer === 'string') {
                throw new Error(`StrictMap: ${this.initializer}: ${String(key)}`);
            }
            this.set(key, this.initializer(key));
        }
        return super.get(key);
    }
}
export class Deferred {
    // @ts-expect-error assigned in promise body
    resolve;
    // @ts-expect-error assigned in promise body
    reject;
    promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });
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
}
export class EtherealValue {
    #s = false;
    #v;
    #h;
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
    set(value) {
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
    reset() {
        this.#s = false;
        this.#v = undefined;
    }
}
export function invariant(condition, message) {
    if (!condition) {
        throw new Error(message ?? 'Invariant failed');
    }
}
