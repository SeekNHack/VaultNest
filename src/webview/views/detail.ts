import { ITEM_TYPE_INFO, type EntryDetail } from '../../shared/model';
import { activeVault, app, emptyState, ISSUE_LABELS, selectEntry, startNewItem, typeIcon, colorizedSecret, render } from '../app';
import { button, formatDate, h, hostOf, icon, iconButton, replace } from '../dom';
import { rpc } from '../rpc';
import { reportError, toast } from '../toast';
import { renderEditor } from './editor';

/** Revealed values are re-masked automatically after this delay. */
const REVEAL_TIMEOUT_MS = 30_000;

let totpTimer: ReturnType<typeof setInterval> | undefined;
let renderToken = 0;

export function stopDetailTimers(): void {
  if (totpTimer) clearInterval(totpTimer);
  totpTimer = undefined;
}

export function renderDetail(pane: HTMLElement): void {
  stopDetailTimers();
  const token = ++renderToken;
  const vault = activeVault();
  if (!vault) return;
  if (app.mode === 'new') {
    renderEditor(pane, null, app.newItem ?? {});
    return;
  }
  if (!app.selectedId) {
    replace(pane, emptyState('shield', 'Select an item', 'Choose an item from the list to see its details, or create a new one.',
      button('New item', () => startNewItem({}), { icon: 'add', variant: 'primary' })));
    return;
  }
  const id = app.selectedId;
  rpc('getEntry', { vaultId: vault.id, entryId: id }).then((detail) => {
    if (token !== renderToken) return; // a newer render started meanwhile
    if (app.mode === 'edit' && !detail.trashed) renderEditor(pane, detail, {});
    else renderView(pane, detail);
  }).catch((err) => {
    if (token !== renderToken) return;
    replace(pane, emptyState('error', 'Item not available', String(err instanceof Error ? err.message : err)));
  });
}

function copy(vaultId: string, entryId: string, field: string): void {
  void rpc('copyField', { vaultId, entryId, field }).catch(reportError);
}

/** A masked secret with reveal/copy actions. Plaintext is fetched only on explicit reveal. */
function secretValue(vaultId: string, entryId: string, field: string, length: number, multiline = false): HTMLElement {
  const masked = '•'.repeat(Math.min(Math.max(length, 8), 24));
  const valueEl = h('span', { class: ['value', 'mono', multiline && 'multiline'] }, masked);
  let revealed = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    revealed = false;
    replace(valueEl, masked);
    eye.replaceChildren(icon('eye'));
    eye.title = 'Reveal';
    eye.setAttribute('aria-label', 'Reveal');
    if (hideTimer) clearTimeout(hideTimer);
  };
  const eye = iconButton('eye', 'Reveal', () => {
    if (revealed) return hide();
    rpc('reveal', { vaultId, entryId, field }).then((value) => {
      revealed = true;
      replace(valueEl, multiline ? value : colorizedSecret(value));
      eye.replaceChildren(icon('eye-closed'));
      eye.title = 'Hide';
      eye.setAttribute('aria-label', 'Hide');
      hideTimer = setTimeout(hide, REVEAL_TIMEOUT_MS);
    }).catch(reportError);
  });
  return h('div', { class: 'value-row' }, valueEl, h('div', { class: 'value-actions' }, eye, iconButton('copy', 'Copy', () => copy(vaultId, entryId, field))));
}

function fieldBlock(label: string, ...content: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), content);
}

function plainValue(text: string, actions: HTMLElement[] = [], opts: { mono?: boolean; multiline?: boolean } = {}): HTMLElement {
  return h('div', { class: 'value-row' },
    h('span', { class: ['value', opts.mono && 'mono', opts.multiline && 'multiline'] }, text),
    actions.length ? h('div', { class: 'value-actions' }, actions) : null);
}

function totpBlock(vaultId: string, entryId: string): HTMLElement {
  const codeEl = h('span', { class: 'value mono totp-code' }, '••• •••');
  const ring = h('span', { class: 'totp-ring', 'aria-hidden': 'true' });
  const secs = h('span', { class: 'muted totp-secs' });
  let remaining = 0;
  let period = 30;
  const refresh = () => rpc('getTotp', { vaultId, entryId }).then((r) => {
    if (!r) return;
    const half = Math.ceil(r.code.length / 2);
    codeEl.textContent = `${r.code.slice(0, half)} ${r.code.slice(half)}`;
    remaining = r.remaining;
    period = r.period;
    tick(false);
  }).catch(() => { codeEl.textContent = 'invalid key'; stopDetailTimers(); });
  const tick = (dec = true) => {
    if (dec) remaining--;
    if (remaining <= 0) {
      void refresh();
      return;
    }
    secs.textContent = `${remaining}s`;
    ring.style.setProperty('--p', String(remaining / period));
    ring.classList.toggle('low', remaining <= 5);
  };
  void refresh();
  totpTimer = setInterval(() => tick(), 1000);
  return fieldBlock('Verification code (TOTP)',
    h('div', { class: 'value-row' }, h('span', { class: 'row gap-s' }, ring, codeEl, secs),
      h('div', { class: 'value-actions' }, iconButton('copy', 'Copy code', () => copy(vaultId, entryId, 'otp')))));
}

function renderView(pane: HTMLElement, e: EntryDetail): void {
  const vaultId = activeVault()!.id;
  const info = ITEM_TYPE_INFO[e.type];
  const header = h('div', { class: 'detail-header' },
    iconButton('arrow-left', 'Back to list', () => selectEntry(null), { class: 'back-btn' }),
    typeIcon(e.type),
    h('div', { class: 'detail-title' },
      h('h1', null, e.title || '(untitled)'),
      h('div', { class: 'muted' }, info.label, e.folderPath ? ` · ${e.folderPath}` : '', e.trashed ? ' · in trash' : '')),
    h('div', { class: 'detail-actions' },
      e.trashed
        ? button('Restore', () => void rpc('restoreEntry', { vaultId, entryId: e.id }).then(() => toast('Item restored', 'success')).catch(reportError), { icon: 'discard', variant: 'primary' })
        : button('Edit', () => selectEntry(e.id, 'edit'), { icon: 'edit', variant: 'primary', title: 'Edit (E)' }),
      !e.trashed ? iconButton(e.favorite ? 'star-full' : 'star-empty', e.favorite ? 'Remove from favorites' : 'Add to favorites',
        () => void rpc('toggleFavorite', { vaultId, entryId: e.id }).catch(reportError), { class: e.favorite ? 'fav on' : 'fav' }) : null,
      iconButton('trash', e.trashed ? 'Delete permanently' : 'Move to trash', () => void rpc('deleteEntry', { vaultId, entryId: e.id }).then((ok) => {
        if (ok) {
          toast(e.trashed ? 'Item deleted' : 'Moved to trash', 'success');
          if (app.selectedId === e.id) { app.selectedId = null; render.detail(); }
        }
      }).catch(reportError))));

  const issues = e.issues.length ? h('div', { class: 'issues' }, e.issues.map((i) => h('span', { class: 'chip warn' }, icon(ISSUE_LABELS[i].icon), ISSUE_LABELS[i].label))) : null;

  const credentials: (HTMLElement | null)[] = [];
  if (info.usernameLabel || e.username) {
    credentials.push(e.username ? fieldBlock(info.usernameLabel ?? 'Username', plainValue(e.username, [iconButton('copy', 'Copy', () => copy(vaultId, e.id, 'UserName'))], { mono: true })) : null);
  }
  if (e.hasPassword) credentials.push(fieldBlock(info.passwordLabel ?? 'Password', secretValue(vaultId, e.id, 'Password', e.passwordLength)));
  if (e.hasTotp && !e.trashed) credentials.push(totpBlock(vaultId, e.id));
  else if (!e.trashed && e.type !== 'note') {
    credentials.push(fieldBlock('Two-factor authentication', h('div', { class: 'value-row' },
      h('span', { class: 'muted' }, 'Not set up'),
      button('Set up 2FA…', () => selectEntry(e.id, 'edit'), { icon: 'shield', title: 'Add an authenticator key by scanning the QR code shown by the website' }))));
  }
  if (e.url) {
    credentials.push(fieldBlock(info.urlLabel ?? 'URL', plainValue(e.url, [
      iconButton('link-external', 'Open', () => void rpc('openUrl', { url: e.url }).catch(reportError)),
      iconButton('copy', 'Copy', () => copy(vaultId, e.id, 'URL')),
    ])));
  }
  const custom = e.customFields.map((f) => fieldBlock(f.name, f.protected
    ? (f.hasValue ? secretValue(vaultId, e.id, f.name, 12, f.multiline) : plainValue('—'))
    : plainValue(f.value ?? '', f.value ? [iconButton('copy', 'Copy', () => copy(vaultId, e.id, f.name))] : [], { multiline: f.multiline, mono: f.multiline }),
  ));

  const card = (title: string | null, ...children: (HTMLElement | null)[]) => {
    const kids = children.filter(Boolean);
    return kids.length ? h('div', { class: 'card' }, title ? h('div', { class: 'card-title' }, title) : null, kids) : null;
  };

  replace(pane, h('div', { class: 'detail' },
    header,
    issues,
    card(null, ...credentials),
    card('Custom fields', ...custom),
    e.notes ? card('Notes', h('div', { class: 'notes' }, e.notes)) : null,
    e.tags.length ? card('Tags', h('div', { class: 'chips' }, e.tags.map((t) => h('span', { class: 'chip' }, icon('tag'), t)))) : null,
    e.attachments.length ? card('Attachments', ...e.attachments.map((a) => h('div', { class: 'muted' }, icon('file'), ` ${a.name} (${Math.ceil(a.size / 1024)} KB) — managed in KeePass clients`))) : null,
    h('div', { class: 'meta' },
      h('span', null, 'Created ', formatDate(e.created)),
      h('span', null, 'Updated ', formatDate(e.modified)),
      e.expires ? h('span', { class: e.expires < Date.now() ? 'warn-text' : '' }, 'Expires ', formatDate(e.expires)) : null,
      e.historyCount ? h('span', null, `${e.historyCount} previous version${e.historyCount > 1 ? 's' : ''}`) : null,
      e.url ? h('span', null, hostOf(e.url)) : null)));
}

// "E" shortcut to edit the selected item when not typing.
document.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'e' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (app.view === 'items' && app.mode === 'view' && app.selectedId) {
    const entry = app.data?.entries.find((x) => x.id === app.selectedId);
    if (entry && !entry.trashed) selectEntry(app.selectedId, 'edit');
  }
});
