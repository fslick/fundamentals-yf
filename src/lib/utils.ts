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

export function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
    return Object.keys(obj).reduce((acc: Record<string, unknown>, k: string) => {
        const pre = prefix.length ? prefix + "." : "";
        if (typeof obj[k] === "object" && obj[k] !== null && !Array.isArray(obj[k]) && !(obj[k] instanceof Date) && !DateTime.isDateTime(obj[k])) {
            Object.assign(acc, flattenObject(obj[k] as Record<string, unknown>, pre + k));
        } else {
            acc[pre + k] = obj[k];
        }
        return acc;
    }, {});
}
