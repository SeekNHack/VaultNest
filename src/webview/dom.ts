/**
 * Tiny DOM builder. All text is inserted with textContent / properties, never
 * as HTML, so data coming from vault files cannot inject markup or scripts.
 */
export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (ev: Event) => void;
export type Props = Record<string, unknown> & { class?: string | (string | false | null | undefined)[] };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let deferredValue: unknown;
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'value' && tag === 'select') {
        deferredValue = value; // options must exist before the value can be selected
        continue;
      }
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') {
        el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as Handler);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value as Record<string, string>)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v);
          else (el.style as unknown as Record<string, string>)[prop] = v;
        }
      } else if (key in el && !key.includes('-') && key !== 'list' && key !== 'form') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  if (deferredValue !== undefined) (el as HTMLSelectElement).value = String(deferredValue);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function icon(name: string, extra = ''): HTMLElement {
  return h('i', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function iconButton(name: string, label: string, onClick: (ev: Event) => void, extra: Props = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: ['icon-btn', extra.class as string], title: label, 'aria-label': label, onClick, ...omit(extra, 'class') }, icon(name));
}

export function button(label: string, onClick: (ev: Event) => void, opts: { icon?: string; variant?: 'primary' | 'secondary' | 'danger'; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', {
    type: 'button', class: ['btn', `btn-${opts.variant ?? 'secondary'}`], onClick, title: opts.title, disabled: opts.disabled,
  }, opts.icon ? icon(opts.icon) : null, h('span', null, label));
}

function omit(o: Props, ...keys: string[]): Props {
  const r: Props = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) r[k] = v;
  return r;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
