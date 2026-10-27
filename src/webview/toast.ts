import { h, icon } from './dom';

let region: HTMLElement | undefined;

/** Non-blocking, screen-reader friendly notifications. */
export function toast(message: string, level: 'info' | 'error' | 'success' = 'info'): void {
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  const el = h('div', { class: ['toast', `toast-${level}`] },
    icon(level === 'error' ? 'error' : level === 'success' ? 'pass' : 'info'), h('span', null, message));
  region.appendChild(el);
  setTimeout(() => el.classList.add('leaving'), level === 'error' ? 6000 : 2600);
  setTimeout(() => el.remove(), level === 'error' ? 6400 : 3000);
}

export function reportError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), 'error');
}
