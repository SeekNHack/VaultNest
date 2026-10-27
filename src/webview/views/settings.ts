import type { VaultCommand } from '../../shared/protocol';
import { activeVault, app } from '../app';
import { button, formatDate, h, icon, replace } from '../dom';
import { rpc } from '../rpc';
import { reportError } from '../toast';

export function renderSettings(pane: HTMLElement): void {
  const v = activeVault();
  if (!v?.details) return;
  const d = v.details;
  const cmd = (command: VaultCommand) => () => void rpc('vaultCommand', { vaultId: v.id, command }).catch(reportError);
  const row = (label: string, value: string | HTMLElement) => h('div', { class: 'kv' }, h('span', { class: 'kv-key' }, label), h('span', { class: 'kv-value' }, value));
  const isV4 = d.kdbxVersion.startsWith('4');
  const weakKdf = d.kdf === 'AES-KDF' || (d.kdfMemoryMiB !== undefined && d.kdfMemoryMiB < 16);

  replace(pane, h('div', { class: 'tool' },
    h('div', { class: 'tool-header' }, h('h1', null, icon('settings-gear'), ` ${v.name}`), h('p', { class: 'muted path' }, v.path)),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Vault'),
      row('Name', h('span', { class: 'row gap-s' }, v.name, button('Rename', cmd('rename'), { icon: 'edit' }))),
      row('Description', h('span', { class: 'row gap-s' }, d.description || '—', button('Edit', cmd('editDescription'), { icon: 'edit' }))),
      row('Items', String(d.entryCount)),
      row('Listed', v.scope === 'global' ? 'Globally (all windows)' : 'In this workspace only'),
      row('Last saved', d.lastSaved ? formatDate(d.lastSaved) : 'Not modified in this session')),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Security'),
      row('Format', `KDBX ${d.kdbxVersion}`),
      row('Encryption', d.cipher),
      row('Key derivation', `${d.kdf}${d.kdfMemoryMiB ? ` · ${d.kdfMemoryMiB} MiB` : ''}${d.kdfIterations ? ` · ${d.kdfIterations} iterations` : ''}`),
      row('Key file', d.hasKeyFile ? (v.keyFilePath ?? 'Yes') : 'Not used'),
      row('Auto-lock', h('span', { class: 'row gap-s wrap' },
        d.autoLockMinutes === 0 ? 'Never' : `After ${d.autoLockMinutes < 60 ? `${d.autoLockMinutes} min` : `${d.autoLockMinutes / 60} h`} without activity`,
        button('Change…', cmd('autoLock'), { icon: 'edit', title: 'Requires the master password' }))),
      !isV4 || weakKdf ? h('div', { class: 'callout warn' }, icon('warning'),
        h('span', null, !isV4 ? 'This vault uses the legacy KDBX 3.1 format. ' : 'The key derivation settings are weak. ', 'Upgrading re-encrypts it with KDBX 4 and Argon2id.'),
        button('Upgrade', cmd('upgradeFormat'), { variant: 'primary' })) : null,
      h('div', { class: 'row wrap gap-s' },
        button('Change master password…', cmd('changeMasterPassword'), { icon: 'key' }),
        button('Lock now', () => void rpc('lock', { vaultId: v.id }).catch(reportError), { icon: 'lock' }))),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Data'),
      h('p', { class: 'muted' }, 'Every save is verified and written atomically; rotating encrypted backups are kept automatically.'),
      h('div', { class: 'row wrap gap-s' },
        button('Back up now', cmd('backupNow'), { icon: 'save-as' }),
        button('Backup folder', cmd('openBackupFolder'), { icon: 'folder' }),
        button('Reload from disk', cmd('sync'), { icon: 'sync', title: 'Merge changes made by other apps (e.g. KeePassXC or a sync client)' }),
        button('Import…', cmd('import'), { icon: 'cloud-download' }),
        button('Export…', cmd('export'), { icon: 'cloud-upload' }),
        button('Reveal file', cmd('reveal'), { icon: 'file' }))),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'All vaults'),
      (app.data?.vaults ?? []).map((x) => h('div', { class: 'vault-row' },
        icon(x.locked ? 'lock' : 'unlock'),
        h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, x.name), h('div', { class: 'item-sub path' }, x.path)),
        x.locked
          ? button('Unlock', () => void rpc('unlock', { vaultId: x.id }).catch(reportError), { icon: 'unlock' })
          : button('Lock', () => void rpc('lock', { vaultId: x.id }).catch(reportError), { icon: 'lock' }),
        button('Remove', () => void rpc('vaultCommand', { vaultId: x.id, command: 'remove' }).catch(reportError), { icon: 'close', title: 'Remove from the list (the file is kept)' }))),
      h('div', { class: 'row wrap gap-s' },
        button('New vault…', () => void rpc('createVault', {}).catch(reportError), { icon: 'add' }),
        button('Open .kdbx…', () => void rpc('openVault', {}).catch(reportError), { icon: 'folder-opened' }))),
    h('div', { class: 'card' },
      h('div', { class: 'card-title' }, 'Preferences'),
      h('p', { class: 'muted' }, 'Auto-lock timeout, clipboard clearing, backups, key derivation strength and more are regular VS Code settings.'),
      button('Open VaultNest settings', () => void rpc('openSettings', {}).catch(reportError), { icon: 'gear' }))));
}
