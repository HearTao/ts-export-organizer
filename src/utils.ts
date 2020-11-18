import { Node, SyntaxKind } from 'typescript';

export function isDef<T>(v: T | null | undefined): v is T {
    return v !== null && v !== undefined;
}

export function assertDef<T>(v: T | null | undefined): T {
    if (isDef(v)) {
        return v;
    }
    throw new Error('invalid assert def');
}

export function first<T>(list: readonly T[] | undefined): T {
    if (!list || !list.length) {
        throw new Error('out of index');
    }
    return list[0];
}

export function lastOrUndefined<T>(
    list: readonly T[] | undefined
): T | undefined {
    if (!list || !list.length) {
        return undefined;
    }
    return list[list.length - 1];
}

export function cast<T extends Node, U extends T>(
    node: T,
    cb: (v: T) => v is U
): U {
    if (!cb(node)) {
        throw new Error('invalid cast: ' + SyntaxKind[node.kind]);
    }
    return node;
}

export function partition<T, U extends keyof any>(
    items: readonly T[],
    cb: (v: T) => U
): Partial<Record<U, T[]>> {
    const result: Partial<Record<U, T[]>> = {};
    items.forEach(item => {
        const key = cb(item);
        const group: T[] = result[key] ?? [];
        group.push(item);
        result[key] = group;
    });
    return result;
}

export function map<T, U>(v: T[] | null | undefined, cb: (v: T) => U): U[] {
    if (!v) {
        return [];
    }
    return v.map(cb);
}
