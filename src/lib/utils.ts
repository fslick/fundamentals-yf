import { DateTime } from "luxon";

export function log(text: string) {
    const timestamp = DateTime.now().toFormat("HH:mm:ss.SSS");
    console.log(`${timestamp} >> ${text}`);
}

export function memoize<T>(fn: (arg: string) => Promise<T>): (arg: string) => Promise<T> {
    const cache = new Map<string, Promise<T>>();
    return (arg: string) => {
        if (cache.has(arg)) {
            return cache.get(arg)!;
        }
        const promise = fn(arg);
        cache.set(arg, promise);
        return promise;
    };
}