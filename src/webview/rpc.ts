import type { HostEvent, HostMessage, RpcMethod, RpcParams, RpcResult } from '../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi = acquireVsCodeApi();

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners: ((e: HostEvent) => void)[] = [];

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'response') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'Unknown error'));
  } else if (msg.kind === 'event') {
    for (const l of listeners) l(msg);
  }
});

export function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscodeApi.postMessage({ kind: 'request', id, method, params });
  });
}

export function onHostEvent(fn: (e: HostEvent) => void): void {
  listeners.push(fn);
}
