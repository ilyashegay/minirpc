import { makeMessenger, invariant, } from './utils.js';
export {};
export class RPCClientError extends Error {
}
export function createServer(options) {
    const methods = {};
    let interval;
    function router(routes) {
        for (const key of Object.keys(routes)) {
            if (key in methods)
                throw new Error(`Duplicate method ${key}`);
            methods[key] = routes[key];
        }
        return {};
    }
    function run({ signal } = {}) {
        invariant(!interval, 'Already Listening');
        const clients = new Set();
        const heartbeats = new WeakMap();
        interval = setInterval(() => {
            const limit = Date.now() - (options.heartbeat ?? 60e3);
            for (const client of clients) {
                if (heartbeats.get(client) < limit) {
                    client.terminate();
                }
            }
        }, 10e3);
        signal?.addEventListener('abort', () => {
            clearInterval(interval);
            interval = undefined;
        });
        return (client) => {
            clients.add(client);
            const abortController = new AbortController();
            const messenger = makeMessenger(client.send, abortController.signal, options.transforms);
            heartbeats.set(client.key, Date.now());
            return {
                message(data) {
                    const request = messenger.parse(data);
                    if (request === 'heartbeat') {
                        heartbeats.set(client.key, Date.now());
                        return;
                    }
                    if (request === undefined)
                        return;
                    try {
                        const { id, method, params } = request;
                        if (!(method in methods)) {
                            messenger.send({ id, error: `Unknown method: ${method}` });
                            return;
                        }
                        Ctx.currentClient = client.key;
                        Promise.resolve(methods[method](...params))
                            .then((result) => {
                            messenger.send({ id, result: result ?? null });
                        })
                            .catch((error) => {
                            if (error instanceof RPCClientError) {
                                messenger.send({ id: request.id, error: error.message });
                            }
                            else {
                                messenger.send({ id: request.id, error: true });
                                options.onError(error);
                            }
                        });
                        Ctx.currentClient = undefined;
                    }
                    catch (error) {
                        if (error instanceof RPCClientError) {
                            messenger.send({ id: request.id, error: error.message });
                        }
                        else {
                            messenger.send({ id: request.id, error: true });
                            options.onError(error);
                        }
                    }
                },
                close(code, reason) {
                    clients.delete(client);
                    abortController.abort(reason.toString());
                },
            };
        };
    }
    return { router, run };
}
export function createChannel(onpull) {
    const subs = new Set();
    return {
        get size() {
            return subs.size;
        },
        push: (payload) => {
            for (const controller of subs) {
                controller.enqueue(payload);
            }
        },
        pull: () => {
            let c;
            return new ReadableStream({
                start(controller) {
                    c = controller;
                    subs.add(controller);
                    if (onpull) {
                        controller.enqueue(onpull(subs.size === 1));
                    }
                },
                cancel() {
                    subs.delete(c);
                },
            });
        },
    };
}
class Ctx {
    static currentClient;
    static data = new WeakMap();
    #value;
    constructor(initialValue) {
        this.#value = initialValue;
    }
    get() {
        return this.#value;
    }
    set(value) {
        this.#value = value;
    }
    update(updateFn) {
        this.#value = updateFn(this.#value);
    }
}
export function getContextKey() {
    invariant(Ctx.currentClient, 'Context accessed out of bounds');
    return Ctx.currentClient;
}
export function createContext(initialValue) {
    const reader = (key) => {
        key ??= getContextKey();
        let contextData = Ctx.data.get(key);
        if (!contextData) {
            contextData = new WeakMap();
            Ctx.data.set(key, contextData);
        }
        let context = contextData.get(reader);
        if (!context) {
            context = new Ctx(initialValue);
            contextData.set(reader, context);
        }
        return context;
    };
    return reader;
}
