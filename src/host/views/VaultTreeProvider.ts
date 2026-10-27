import * as vscode from 'vscode';
import { EntrySummary, ITEM_TYPE_INFO } from '../../shared/model';
import { VaultManager } from '../VaultManager';

export type TreeNode =
  | { kind: 'vault'; vaultId: string }
  | { kind: 'favorites'; vaultId: string }
  | { kind: 'folder'; vaultId: string; folderId: string; trash: boolean }
  | { kind: 'entry'; vaultId: string; entry: EntrySummary };

/**
 * Sidebar tree: vaults → favorites / folders / items / trash.
 * Tree items never contain secret values (only titles and usernames).
 */
export class VaultTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: VaultManager) {
    this.sub = manager.onDidChange((c) => { if (c.kind !== 'health') this.refresh(); });
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.manager.refs().map((r) => ({ kind: 'vault', vaultId: r.id }));
    const { vaultId } = node;
    if (!this.manager.isUnlocked(vaultId)) return [];
    const doc = this.manager.doc(vaultId);
    const entries = doc.listEntries();
    const sortEntries = (list: EntrySummary[]) => list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const folders = doc.listFolders();
    const childFolders = (parentId: string): TreeNode[] => folders
      .filter((f) => f.parentId === parentId)
      .map((f) => ({ kind: 'folder', vaultId, folderId: f.id, trash: f.isTrash }));
    switch (node.kind) {
      case 'vault': {
        const rootId = doc.root.uuid.id;
        const out: TreeNode[] = [];
        if (entries.some((e) => e.favorite && !e.trashed)) out.push({ kind: 'favorites', vaultId });
        const subs = childFolders(rootId);
        out.push(...subs.filter((n) => n.kind === 'folder' && !n.trash));
        out.push(...sortEntries(entries.filter((e) => e.folderId === rootId)).map((entry) => ({ kind: 'entry' as const, vaultId, entry })));
        out.push(...subs.filter((n) => n.kind === 'folder' && n.trash));
        return out;
      }
      case 'favorites':
        return sortEntries(entries.filter((e) => e.favorite && !e.trashed)).map((entry) => ({ kind: 'entry', vaultId, entry }));
      case 'folder':
        return [
          ...childFolders(node.folderId),
          ...sortEntries(entries.filter((e) => e.folderId === node.folderId)).map((entry) => ({ kind: 'entry' as const, vaultId, entry })),
        ];
      default:
        return [];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'vault': {
        const ref = this.manager.ref(node.vaultId);
        const unlocked = this.manager.isUnlocked(node.vaultId);
        const item = new vscode.TreeItem(ref.name, unlocked ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.id = `vault:${ref.id}:${unlocked}`;
        item.iconPath = new vscode.ThemeIcon(unlocked ? 'unlock' : 'lock', new vscode.ThemeColor(unlocked ? 'charts.green' : 'disabledForeground'));
        item.description = `${unlocked ? 'unlocked' : 'locked'}${ref.scope === 'workspace' ? ' · workspace' : ''}`;
        item.tooltip = new vscode.MarkdownString(`**${ref.name}**\n\n\`${ref.path}\`${ref.keyFilePath ? '\n\nKey file: `' + ref.keyFilePath + '`' : ''}`);
        item.contextValue = unlocked ? 'vault-unlocked' : 'vault-locked';
        if (!unlocked) item.command = { command: 'vaultnest.unlock', title: 'Unlock', arguments: [node] };
        return item;
      }
      case 'favorites': {
        const item = new vscode.TreeItem('Favorites', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `fav:${node.vaultId}`;
        item.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
        item.contextValue = 'favorites';
        return item;
      }
      case 'folder': {
        const doc = this.manager.doc(node.vaultId);
        const f = doc.listFolders().find((x) => x.id === node.folderId);
        const item = new vscode.TreeItem(node.trash ? 'Trash' : (f?.name ?? 'Folder'), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `folder:${node.vaultId}:${node.folderId}`;
        item.iconPath = new vscode.ThemeIcon(node.trash ? 'trash' : 'folder');
        item.description = f && f.entryCount ? String(f.entryCount) : undefined;
        item.contextValue = node.trash ? 'trash' : 'folder';
        return item;
      }
      case 'entry': {
        const e = node.entry;
        const info = ITEM_TYPE_INFO[e.type];
        const item = new vscode.TreeItem(e.title || '(untitled)', vscode.TreeItemCollapsibleState.None);
        item.id = `entry:${node.vaultId}:${e.id}:${e.trashed}`;
        item.iconPath = new vscode.ThemeIcon(e.favorite && !e.trashed ? 'star-full' : info.icon);
        item.description = e.username || (e.url ? hostname(e.url) : info.label);
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`$(${info.icon}) **${escapeMd(e.title)}** — ${info.label}\n\n`);
        if (e.username) md.appendMarkdown(`${info.usernameLabel ?? 'Username'}: \`${escapeMd(e.username)}\`\n\n`);
        if (e.url) md.appendMarkdown(`${escapeMd(e.url)}\n\n`);
        if (e.tags.length) md.appendMarkdown(`Tags: ${e.tags.map(escapeMd).join(', ')}\n\n`);
        if (e.folderPath) md.appendMarkdown(`Folder: ${escapeMd(e.folderPath)}`);
        md.isTrusted = false;
        item.tooltip = md;
        item.contextValue = `entry-${e.trashed ? 'trashed' : 'active'}${e.url ? '-url' : ''}${e.hasTotp ? '-totp' : ''}`;
        item.command = { command: 'vaultnest.openItem', title: 'Open', arguments: [node] };
        return item;
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, '\\$&');
}
