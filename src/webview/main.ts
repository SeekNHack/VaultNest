import './styles.css';
import { ITEM_TYPE_INFO, ITEM_TYPES } from '../shared/model';
import type { HostEvent, View } from '../shared/protocol';
import {
  activeVault, app, canLeave, entrySubtitle, emptyState, isUnlocked, ISSUE_LABELS, lockScreen, persist, render, selectEntry,
  setFilter, setRenderers, startNewItem, typeIcon, visibleEntries, type Filter, goView,
} from './app';
import { button, h, icon, iconButton, replace } from './dom';
import { onHostEvent, rpc } from './rpc';
import { reportError, toast } from './toast';
import { renderDetail } from './views/detail';
import { renderGenerator } from './views/generator';
import { renderHealth } from './views/health';
import { renderSettings } from './views/settings';

const root = document.getElementById('app')!;

// Persistent shell elements (kept across renders so focus/search text survive).
const searchInput = h('input', {
  type: 'search', class: 'search-input', placeholder: 'Search vault', 'aria-label': 'Search items', spellcheck: false, autocomplete: 'off',
  onInput: () => {
    app.search = searchInput.value;
    if (app.view !== 'items') {
      app.view = 'items';
      render.full();
      searchInput.focus();
      return;
    }
    const list = visibleEntries();
    if (app.mode === 'view' && !list.some((e) => e.id === app.selectedId)) app.selectedId = list[0]?.id ?? null;
    renderList();
    if (app.mode === 'view') renderDetail(detailEl);
  },
  onKeydown: (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      listEl.querySelector<HTMLElement>('.item.selected, .item')?.focus();
    } else if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      app.search = '';
      renderList();
    }
  },
});
const vaultSelect = h('select', { class: 'select vault-select', 'aria-label': 'Active vault' });
function switchVault(vaultId: string): void {
  if (!canLeave(() => switchVault(vaultId))) {
    vaultSelect.value = app.data?.activeVaultId ?? '';
    return;
  }
  app.selectedId = null;
  void rpc('setActiveVault', { vaultId }).catch(reportError);
}
vaultSelect.addEventListener('change', () => switchVault(vaultSelect.value));
const navEl = h('nav', { class: 'nav', 'aria-label': 'Vault navigation' });
const listEl = h('section', { class: 'list-pane', 'aria-label': 'Items' });
const detailEl = h('section', { class: 'detail-pane', 'aria-label': 'Item details' });
const mainEl = h('main', { class: 'main' });

function topbar(): HTMLElement {
  const v = activeVault();
  replace(vaultSelect, (app.data?.vaults ?? []).map((x) => h('option', { value: x.id }, `${x.name}${x.locked ? ' (locked)' : ''}`)));
  vaultSelect.value = v?.id ?? '';
  return h('header', { class: 'topbar' },
    iconButton('menu', 'Toggle navigation', () => {
      const shell = root.querySelector('.shell');
      if (window.innerWidth <= 760) {
        shell?.classList.toggle('nav-open');
        return;
      }
      app.navCollapsed = !app.navCollapsed;
      persist();
      shell?.classList.toggle('nav-collapsed', app.navCollapsed);
    }, { class: 'nav-toggle' }),
    h('div', { class: 'brand' }, icon('shield'), h('span', null, 'VaultNest')),
    vaultSelect,
    h('div', { class: 'search' }, icon('search'), searchInput),
    h('div', { class: 'topbar-actions' },
      button('New', () => startNewItem({}), { icon: 'add', variant: 'primary', title: 'New item (Ctrl+N)' }),
      iconButton('lock', 'Lock vault (Ctrl+L)', () => v && void rpc('lock', { vaultId: v.id }).catch(reportError))));
}

function navItem(label: string, iconName: string, filter: Filter | null, count?: number, view?: View): HTMLElement {
  const active = view ? app.view === view : app.view === 'items' && filter !== null && app.filter.kind === filter.kind && app.filter.value === filter.value;
  return h('button', {
    type: 'button', class: ['nav-item', active && 'active'], 'aria-current': active ? 'page' : undefined, title: label,
    onClick: () => (view ? goView(view) : filter && setFilter(filter)),
  }, icon(iconName), h('span', { class: 'nav-label' }, label), count !== undefined && count > 0 ? h('span', { class: 'count' }, String(count)) : null);
}

function renderNav(): void {
  const data = app.data!;
  const active = data.entries.filter((e) => !e.trashed);
  const trash = data.entries.filter((e) => e.trashed).length;
  const issues = new Set(active.filter((e) => e.issues.length).map((e) => e.id)).size;
  const v = activeVault()!;
  const folders = data.folders.filter((f) => !f.isRoot && !f.isTrash);
  const rootFolder = data.folders.find((f) => f.isRoot);
  replace(navEl,
    h('div', { class: 'nav-section' },
      navItem('All items', 'list-flat', { kind: 'all' }, active.length),
      navItem('Favorites', 'star-full', { kind: 'favorites' }, active.filter((e) => e.favorite).length),
      navItem('With 2FA', 'shield', { kind: 'totp' }, active.filter((e) => e.hasTotp).length),
      navItem('Trash', 'trash', { kind: 'trash' }, trash)),
    h('div', { class: 'nav-section' },
      h('div', { class: 'nav-heading' }, 'Types'),
      ITEM_TYPES.map((t) => navItem(ITEM_TYPE_INFO[t].plural, ITEM_TYPE_INFO[t].icon, { kind: 'type', value: t }, active.filter((e) => e.type === t).length))),
    h('div', { class: 'nav-section' },
      h('div', { class: 'nav-heading' }, h('span', null, 'Folders'),
        iconButton('new-folder', 'New folder', () => void rpc('createFolder', { vaultId: v.id, parentId: null }).catch(reportError), { class: 'mini' })),
      rootFolder ? navItem('No folder', 'folder-library', { kind: 'folder', value: rootFolder.id }, rootFolder.entryCount) : null,
      folders.map((f) => {
        const item = navItem(f.name, 'folder', { kind: 'folder', value: f.id }, f.entryCount);
        item.style.paddingLeft = `${8 + (f.depth - 1) * 14}px`;
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          void rpc('renameFolder', { vaultId: v.id, folderId: f.id }).catch(reportError);
        });
        const actions = h('span', { class: 'nav-item-actions' },
          iconButton('edit', `Rename ${f.name}`, (e) => { e.stopPropagation(); void rpc('renameFolder', { vaultId: v.id, folderId: f.id }).catch(reportError); }, { class: 'mini' }),
          iconButton('new-folder', `New subfolder in ${f.name}`, (e) => { e.stopPropagation(); void rpc('createFolder', { vaultId: v.id, parentId: f.id }).catch(reportError); }, { class: 'mini' }),
          iconButton('trash', `Delete ${f.name}`, (e) => { e.stopPropagation(); void rpc('deleteFolder', { vaultId: v.id, folderId: f.id }).catch(reportError); }, { class: 'mini' }));
        item.appendChild(actions);
        return item;
      })),
    data.tags.length ? h('div', { class: 'nav-section' },
      h('div', { class: 'nav-heading' }, 'Tags'),
      data.tags.map((t) => navItem(t, 'tag', { kind: 'tag', value: t }, active.filter((e) => e.tags.includes(t)).length))) : null,
    h('div', { class: 'nav-section' },
      h('div', { class: 'nav-heading' }, 'Tools'),
      navItem('Generator', 'wand', null, undefined, 'generator'),
      navItem('Password health', 'pulse', null, issues, 'health'),
      navItem('Vault settings', 'settings-gear', null, undefined, 'settings')),
  );
}

function filterTitle(): string {
  const f = app.filter;
  switch (f.kind) {
    case 'favorites': return 'Favorites';
    case 'totp': return 'With 2FA';
    case 'trash': return 'Trash';
    case 'type': return ITEM_TYPE_INFO[f.value as keyof typeof ITEM_TYPE_INFO]?.plural ?? 'Items';
    case 'folder': {
      const folder = app.data?.folders.find((x) => x.id === f.value);
      return folder?.isRoot ? 'No folder' : folder?.name ?? 'Folder';
    }
    case 'tag': return `#${f.value}`;
    case 'issue': return ISSUE_LABELS[f.value as keyof typeof ISSUE_LABELS]?.label ?? 'Issues';
    default: return 'All items';
  }
}

function renderList(): void {
  const list = visibleEntries();
  const v = activeVault()!;
  const header = h('div', { class: 'list-header' },
    h('h2', null, filterTitle(), h('span', { class: 'count' }, String(list.length))),
    h('div', { class: 'row gap-s' },
      app.filter.kind === 'trash' && list.length ? iconButton('trash', 'Empty trash', () => void rpc('emptyTrash', { vaultId: v.id }).catch(reportError)) : null,
      h('select', {
        class: 'select compact', 'aria-label': 'Sort', value: app.sort,
        onChange: (e: Event) => { app.sort = (e.target as HTMLSelectElement).value as 'name' | 'modified'; persist(); renderList(); },
      }, h('option', { value: 'name' }, 'Name'), h('option', { value: 'modified' }, 'Recent'))));
  if (!list.length) {
    replace(listEl, header, app.search
      ? emptyState('search', 'No results', `Nothing matches "${app.search}".`)
      : app.filter.kind === 'trash'
        ? emptyState('trash', 'Trash is empty', 'Deleted items stay here until you empty the trash.')
        : emptyState('key', 'No items yet', 'Add a login, API key, token, SSH key, card or secure note.', button('New item', () => startNewItem({ folderId: app.filter.kind === 'folder' ? app.filter.value : undefined, type: app.filter.kind === 'type' ? app.filter.value : undefined }), { icon: 'add', variant: 'primary' })));
    return;
  }
  const ul = h('ul', { class: 'items', role: 'listbox', 'aria-label': 'Items' });
  for (const e of list) {
    const selected = e.id === app.selectedId && app.mode !== 'new';
    const li = h('li', {
      class: ['item', selected && 'selected'], role: 'option', 'aria-selected': selected ? 'true' : 'false', tabIndex: 0, dataset: { id: e.id },
      onClick: () => selectEntry(e.id),
      onDblclick: () => !e.trashed && selectEntry(e.id, 'edit'),
      onKeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') selectEntry(e.id);
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const sib = (ev.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling) as HTMLElement | null;
          if (sib) {
            sib.focus();
            selectEntry(sib.dataset.id!);
            (listEl.querySelector(`[data-id="${CSS.escape(sib.dataset.id!)}"]`) as HTMLElement | null)?.focus();
          } else if (ev.key === 'ArrowUp') searchInput.focus();
        }
      },
    },
    typeIcon(e.type),
    h('div', { class: 'item-text' },
      h('div', { class: 'item-title' }, e.title || '(untitled)'),
      h('div', { class: 'item-sub' }, entrySubtitle(e))),
    h('div', { class: 'item-badges' },
      e.favorite ? h('span', { class: 'badge fav', title: 'Favorite' }, icon('star-full')) : null,
      e.hasTotp ? h('span', { class: 'badge', title: 'Has authenticator code' }, icon('watch')) : null,
      e.issues.length ? h('span', { class: 'badge warn', title: e.issues.map((i) => ISSUE_LABELS[i].label).join(', ') }, icon('warning')) : null),
    !e.trashed ? h('div', { class: 'item-actions' },
      e.username ? iconButton('person', 'Copy username', (ev) => { ev.stopPropagation(); void rpc('copyField', { vaultId: v.id, entryId: e.id, field: 'UserName' }).catch(reportError); }) : null,
      e.hasPassword ? iconButton('key', 'Copy password', (ev) => { ev.stopPropagation(); void rpc('copyField', { vaultId: v.id, entryId: e.id, field: 'Password' }).catch(reportError); }) : null) : null);
    ul.appendChild(li);
  }
  replace(listEl, header, ul);
}

function renderFull(): void {
  if (!app.data) return;
  if (!isUnlocked()) {
    app.confirmLeave = undefined;
    lockScreen(root);
    return;
  }
  let shell = root.querySelector<HTMLElement>('.shell');
  if (!shell) {
    shell = h('div', { class: ['shell', app.navCollapsed && 'nav-collapsed'] });
    replace(root, shell);
  }
  replace(shell, topbar(), h('div', { class: 'body' }, navEl, mainEl));
  renderNav();
  if (app.view === 'items') {
    mainEl.className = 'main items-view';
    mainEl.classList.toggle('show-detail', app.mode !== 'view' || !!app.selectedId);
    replace(mainEl, listEl, detailEl);
    renderList();
    renderDetail(detailEl);
  } else {
    mainEl.className = 'main tool-view';
    const pane = h('div', { class: 'tool-pane' });
    replace(mainEl, pane);
    if (app.view === 'generator') renderGenerator(pane);
    else if (app.view === 'health') renderHealth(pane);
    else renderSettings(pane);
  }
}

setRenderers({
  full: renderFull,
  list: () => {
    renderList();
    mainEl.classList.toggle('show-detail', app.mode !== 'view' || !!app.selectedId);
  },
  detail: () => renderDetail(detailEl),
  nav: renderNav,
});

// ------------------------------------------------------------ host events

onHostEvent((e) => {
  switch (e.type) {
    case 'state': {
      const prevVault = app.data?.activeVaultId;
      const wasUnlocked = isUnlocked();
      app.data = e.state;
      const vaultChanged = prevVault !== e.state.activeVaultId || wasUnlocked !== isUnlocked();
      if (vaultChanged) {
        app.confirmLeave = undefined;
        app.mode = 'view';
        if (!e.state.entries.some((x) => x.id === app.selectedId)) app.selectedId = null;
        if (app.filter.kind === 'folder' && !e.state.folders.some((f) => f.id === app.filter.value)) app.filter = { kind: 'all' };
        renderFull();
      } else if (!isUnlocked()) {
        renderFull();
      } else {
        // Content changed: refresh everything except an open editor (keeps the user's input).
        if (app.mode === 'view' && app.selectedId && !e.state.entries.some((x) => x.id === app.selectedId)) app.selectedId = null;
        renderNav();
        if (app.view === 'items') {
          renderList();
          if (app.mode === 'view') renderDetail(detailEl);
        } else if (app.view !== 'generator') {
          renderFull();
        }
        topbar();
      }
      break;
    }
    case 'locked':
      app.confirmLeave = undefined;
      app.mode = 'view';
      // Drop any revealed value immediately.
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input, textarea'))) el.value = '';
      break;
    case 'navigate':
      handleNavigate(e);
      break;
    case 'toast':
      toast(e.message, e.level);
      break;
  }
});

function handleNavigate(e: Extract<HostEvent, { type: 'navigate' }>): void {
  // Ask before discarding unsaved edits; re-run the navigation once the user agrees.
  if (!canLeave(() => handleNavigate(e))) return;
  if (e.view !== 'items') {
    app.view = e.view;
    app.mode = 'view';
    persist();
    renderFull();
  } else if (e.newItem) {
    startNewItem(e.newItem);
  } else if (e.entryId) {
    app.view = 'items';
    const target = app.data?.entries.find((x) => x.id === e.entryId);
    if (!visibleEntries().some((x) => x.id === e.entryId)) {
      app.filter = { kind: target?.trashed ? 'trash' : 'all' };
      app.search = '';
      searchInput.value = '';
    }
    app.selectedId = e.entryId;
    app.mode = e.edit && !target?.trashed ? 'edit' : 'view';
    persist();
    renderFull();
  } else {
    app.view = 'items';
    renderFull();
  }
}

// ------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!isUnlocked()) return;
  if ((mod && e.key.toLowerCase() === 'f') || (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
    e.preventDefault();
    startNewItem({});
  } else if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    const v = activeVault();
    if (v) void rpc('lock', { vaultId: v.id }).catch(reportError);
  } else if (mod && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    goView('generator');
  }
});

// ------------------------------------------------------------ boot

replace(root, h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), ' Loading…'));
rpc('ready', {}).then((state) => {
  app.data = state;
  if (app.selectedId && !state.entries.some((e) => e.id === app.selectedId)) app.selectedId = null;
  renderFull();
}).catch(reportError);
