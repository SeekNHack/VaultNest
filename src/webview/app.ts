import { ITEM_TYPE_INFO, ITEM_TYPES, type EntrySummary, type HealthIssue, type ItemType, type VaultInfo } from '../shared/model';
import type { DashboardState, View } from '../shared/protocol';
import { confirmDialog } from './dialog';
import { button, h, hostOf, icon, iconButton, replace } from './dom';
import { rpc, vscodeApi } from './rpc';
import { reportError } from './toast';

export interface Filter {
  kind: 'all' | 'favorites' | 'totp' | 'trash' | 'type' | 'folder' | 'tag' | 'issue';
  value?: string;
}

export interface NewItemPreset {
  type?: string;
  password?: string;
  folderId?: string;
}

interface PersistedUi {
  view: View;
  filter: Filter;
  selectedId: string | null;
  sort: 'name' | 'modified';
  navCollapsed: boolean;
}

/** Global UI state. Contains no secret values (see the protocol notes). */
export const app = {
  data: null as DashboardState | null,
  view: 'items' as View,
  filter: { kind: 'all' } as Filter,
  search: '',
  selectedId: null as string | null,
  mode: 'view' as 'view' | 'edit' | 'new',
  newItem: undefined as NewItemPreset | undefined,
  sort: 'name' as 'name' | 'modified',
  navCollapsed: false,
  /** Set by the editor while it has unsaved changes. */
  confirmLeave: undefined as (() => boolean) | undefined,
};

export const ISSUE_LABELS: Record<HealthIssue, { label: string; icon: string }> = {
  weak: { label: 'Weak password', icon: 'warning' },
  reused: { label: 'Reused password', icon: 'copy' },
  old: { label: 'Old password', icon: 'history' },
  expired: { label: 'Expired', icon: 'calendar' },
  insecureUrl: { label: 'Insecure URL (http)', icon: 'unlock' },
};

const saved = vscodeApi.getState<PersistedUi>();
if (saved) {
  app.view = saved.view ?? 'items';
  app.filter = saved.filter ?? { kind: 'all' };
  app.selectedId = saved.selectedId ?? null;
  app.sort = saved.sort ?? 'name';
  app.navCollapsed = saved.navCollapsed ?? false;
}

export function persist(): void {
  vscodeApi.setState<PersistedUi>({ view: app.view, filter: app.filter, selectedId: app.selectedId, sort: app.sort, navCollapsed: app.navCollapsed });
}

export function activeVault(): VaultInfo | undefined {
  return app.data?.vaults.find((v) => v.id === app.data?.activeVaultId);
}

export function isUnlocked(): boolean {
  const v = activeVault();
  return !!v && !v.locked;
}

export function entryById(id: string | null): EntrySummary | undefined {
  return id ? app.data?.entries.find((e) => e.id === id) : undefined;
}

/** Applies the current filter + search query. */
export function visibleEntries(): EntrySummary[] {
  const entries = app.data?.entries ?? [];
  const f = app.filter;
  let list = entries.filter((e) => {
    if (f.kind === 'trash') return e.trashed;
    if (e.trashed) return false;
    switch (f.kind) {
      case 'favorites': return e.favorite;
      case 'totp': return e.hasTotp;
      case 'type': return e.type === f.value;
      case 'folder': return e.folderId === f.value;
      case 'tag': return e.tags.includes(f.value ?? '');
      case 'issue': return e.issues.includes(f.value as HealthIssue);
      default: return true;
    }
  });
  const q = app.search.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((e) => {
      const hay = [e.title, e.username, e.url, e.folderPath, ITEM_TYPE_INFO[e.type].label, ...e.tags.map((t) => `#${t}`), ...e.fieldNames].join('\n').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  return list.sort(app.sort === 'modified'
    ? (a, b) => b.modified - a.modified
    : (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

// ------------------------------------------------------------ navigation

const renderers: { full?: () => void; list?: () => void; detail?: () => void; nav?: () => void } = {};
export function setRenderers(r: typeof renderers): void {
  Object.assign(renderers, r);
}
export const render = {
  full: () => renderers.full?.(),
  list: () => renderers.list?.(),
  detail: () => renderers.detail?.(),
  nav: () => renderers.nav?.(),
};

/**
 * Returns true if navigation may proceed now. If the editor has unsaved
 * changes, asks the user and re-runs `retry` once they choose to discard.
 */
export function canLeave(retry?: () => void): boolean {
  const isDirty = app.confirmLeave?.();
  if (!isDirty) {
    app.confirmLeave = undefined;
    return true;
  }
  void confirmDialog('You have unsaved changes. Discard them?', 'Discard changes', { danger: true, cancelLabel: 'Keep editing' }).then((discard) => {
    if (!discard) return;
    app.confirmLeave = undefined;
    retry?.();
  });
  return false;
}

export function goView(view: View): void {
  if (!canLeave(() => goView(view))) return;
  app.view = view;
  app.mode = 'view';
  persist();
  render.full();
}

export function setFilter(filter: Filter): void {
  if (!canLeave(() => setFilter(filter))) return;
  app.filter = filter;
  app.view = 'items';
  app.mode = 'view';
  const list = visibleEntries();
  if (!list.some((e) => e.id === app.selectedId)) app.selectedId = list[0]?.id ?? null;
  persist();
  render.full();
}

export function selectEntry(id: string | null, mode: 'view' | 'edit' = 'view'): void {
  if (!canLeave(() => selectEntry(id, mode))) return;
  app.selectedId = id;
  app.mode = mode;
  app.view = 'items';
  persist();
  render.list();
  render.detail();
}

export function startNewItem(preset: NewItemPreset = {}): void {
  if (!canLeave(() => startNewItem(preset))) return;
  app.view = 'items';
  app.mode = 'new';
  app.newItem = preset;
  if (app.filter.kind === 'trash') app.filter = { kind: 'all' };
  persist();
  render.full();
}

// ------------------------------------------------------------ shared widgets

export function typeIcon(type: ItemType, favorite = false): HTMLElement {
  return h('span', { class: ['type-icon', `type-${type}`] }, icon(favorite ? 'star-full' : ITEM_TYPE_INFO[type].icon));
}

export function emptyState(iconName: string, title: string, text: string, ...actions: HTMLElement[]): HTMLElement {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('h2', null, title),
    h('p', null, text),
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

export function strengthMeter(score: number, label: string, detail?: string): HTMLElement {
  return h('div', { class: ['strength', `strength-${score}`], role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 4, 'aria-valuenow': score, 'aria-label': `Strength: ${label}` },
    h('div', { class: 'strength-bar' }, [0, 1, 2, 3].map((i) => h('span', { class: i < Math.max(1, score) ? 'on' : '' }))),
    h('span', { class: 'strength-label' }, label, detail ? h('span', { class: 'muted' }, ` · ${detail}`) : null));
}

/** Colourises a generated/revealed password: digits and symbols get distinct colours. */
export function colorizedSecret(value: string): HTMLElement {
  const out = h('span', { class: 'secret-color' });
  for (const ch of value) {
    const cls = /[0-9]/.test(ch) ? 'ch-digit' : /[A-Za-z]/.test(ch) ? 'ch-letter' : 'ch-symbol';
    out.appendChild(h('span', { class: cls }, ch));
  }
  return out;
}

export function lockScreen(root: HTMLElement): void {
  const data = app.data;
  const vaults = data?.vaults ?? [];
  const active = activeVault();
  if (!vaults.length) {
    replace(root, h('div', { class: 'lock-screen' },
      h('div', { class: 'lock-card' },
        h('div', { class: 'brand-mark' }, icon('shield')),
        h('h1', null, 'Welcome to PasswdVault'),
        h('p', { class: 'muted' }, 'Store passwords, API keys, tokens and notes in an encrypted KeePass-compatible (KDBX 4) file that never leaves your machine.'),
        h('div', { class: 'stack' },
          button('Create a new vault', () => void rpc('createVault', {}).catch(reportError), { icon: 'add', variant: 'primary' }),
          button('Open an existing .kdbx file', () => void rpc('openVault', {}).catch(reportError), { icon: 'folder-opened' })),
        h('ul', { class: 'feature-list' },
          h('li', null, icon('lock'), 'AES-256 / ChaCha20 encryption, Argon2id key derivation'),
          h('li', null, icon('file-binary'), 'Opens in KeePassXC, KeePass, KeeWeb, Strongbox…'),
          h('li', null, icon('cloud-upload'), 'No cloud, no account, no telemetry')))));
    return;
  }
  const unlock = () => {
    if (!active) return;
    void rpc('unlock', { vaultId: active.id }).catch(reportError);
  };
  replace(root, h('div', { class: 'lock-screen' },
    h('div', { class: 'lock-card' },
      h('div', { class: 'brand-mark locked' }, icon('lock')),
      h('h1', null, active ? active.name : 'PasswdVault'),
      h('p', { class: 'muted path' }, active?.path ?? ''),
      vaults.length > 1 ? h('label', { class: 'field-label', for: 'vault-select' }, 'Vault') : null,
      vaults.length > 1 ? h('select', {
        id: 'vault-select', class: 'select', value: active?.id ?? '',
        onChange: (e: Event) => void rpc('setActiveVault', { vaultId: (e.target as HTMLSelectElement).value }).catch(reportError),
      }, vaults.map((v) => h('option', { value: v.id }, `${v.name}${v.locked ? ' (locked)' : ' (unlocked)'}`))) : null,
      h('div', { class: 'stack' },
        button('Unlock', unlock, { icon: 'unlock', variant: 'primary' }),
        h('p', { class: 'hint' }, 'You will be asked for the master password in a secure VS Code prompt.')),
      h('div', { class: 'row center gap' },
        button('New vault', () => void rpc('createVault', {}).catch(reportError), { icon: 'add' }),
        button('Open .kdbx', () => void rpc('openVault', {}).catch(reportError), { icon: 'folder-opened' })))));
  root.querySelector<HTMLButtonElement>('.btn-primary')?.focus();
}

export function entrySubtitle(e: EntrySummary): string {
  return e.username || (e.url ? hostOf(e.url) : ITEM_TYPE_INFO[e.type].label);
}

export { ITEM_TYPES, iconButton };
