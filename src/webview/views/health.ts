import type { HealthIssue } from '../../shared/model';
import { activeVault, app, emptyState, entryById, ISSUE_LABELS, selectEntry, setFilter, typeIcon, entrySubtitle } from '../app';
import { button, h, icon, replace } from '../dom';
import { rpc } from '../rpc';
import { reportError } from '../toast';

const ORDER: HealthIssue[] = ['weak', 'reused', 'expired', 'old', 'insecureUrl'];
const HELP: Record<HealthIssue, string> = {
  weak: 'Easy to guess with dictionaries and common patterns. Replace with a generated password.',
  reused: 'The same password is used in several items: one breach exposes all of them.',
  expired: 'The expiry date set on the item has passed.',
  old: 'Not changed for a long time (configurable in settings).',
  insecureUrl: 'The website uses http:// — credentials may travel unencrypted.',
};

export function renderHealth(pane: HTMLElement): void {
  const vault = activeVault();
  if (!vault) return;
  replace(pane, h('div', { class: 'loading' }, icon('loading', 'codicon-modifier-spin'), ' Analysing passwords…'));
  rpc('health', { vaultId: vault.id }).then((report) => {
    const score = report.total ? Math.round(100 * (1 - new Set(report.items.filter((i) => i.issues.some((x) => x === 'weak' || x === 'reused')).map((i) => i.id)).size / report.total)) : 100;
    const grade = score >= 90 ? 'good' : score >= 70 ? 'fair' : 'poor';
    const sections = ORDER.filter((k) => report.counts[k] > 0).map((k) => {
      const items = report.items.filter((i) => i.issues.includes(k));
      return h('div', { class: 'card' },
        h('div', { class: 'card-title row' }, icon(ISSUE_LABELS[k].icon), ` ${ISSUE_LABELS[k].label} `, h('span', { class: 'count' }, String(items.length)),
          h('span', { class: 'spacer' }), button('Show in list', () => setFilter({ kind: 'issue', value: k }), { icon: 'filter' })),
        h('p', { class: 'muted' }, HELP[k]),
        h('ul', { class: 'items compact' }, items.map((i) => {
          const e = entryById(i.id);
          if (!e) return null;
          return h('li', { class: 'item', tabIndex: 0, role: 'button', onClick: () => selectEntry(e.id), onKeydown: (ev: KeyboardEvent) => ev.key === 'Enter' && selectEntry(e.id) },
            typeIcon(e.type), h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, e.title), h('div', { class: 'item-sub' }, entrySubtitle(e))),
            i.reusedCount ? h('span', { class: 'chip' }, `used ${i.reusedCount}×`) : null,
            h('button', { type: 'button', class: 'btn btn-secondary', onClick: (ev: Event) => { ev.stopPropagation(); selectEntry(e.id, 'edit'); } }, icon('edit'), h('span', null, 'Fix')));
        })));
    });
    replace(pane, h('div', { class: 'tool' },
      h('div', { class: 'tool-header' }, h('h1', null, icon('pulse'), ' Password health'),
        h('p', { class: 'muted' }, 'Analysed locally on this machine. Passwords are never sent to breach-check services.')),
      h('div', { class: 'health-summary' },
        h('div', { class: ['score-ring', grade], style: { '--score': String(score) } }, h('span', null, String(score)), h('small', null, '/100')),
        h('div', { class: 'stat-grid' }, ORDER.map((k) => h('button', {
          type: 'button', class: ['stat', report.counts[k] ? 'has' : ''], onClick: () => report.counts[k] && setFilter({ kind: 'issue', value: k }),
        }, h('span', { class: 'stat-num' }, String(report.counts[k])), h('span', { class: 'stat-label' }, icon(ISSUE_LABELS[k].icon), ` ${ISSUE_LABELS[k].label}`))))),
      h('p', { class: 'muted' }, `${report.total} password${report.total === 1 ? '' : 's'} analysed.`),
      sections.length ? sections : emptyState('pass', 'All good!', 'No weak, reused, old or expired passwords found.')));
  }).catch((err) => {
    reportError(err);
    replace(pane, emptyState('error', 'Could not analyse the vault', String(err)));
  });
  void app;
}
