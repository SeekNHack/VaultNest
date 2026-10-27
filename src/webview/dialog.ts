import { button, h, icon } from './dom';

/** Accessible in-webview confirmation dialog (native confirm() is not available in webviews). */
export function confirmDialog(message: string, confirmLabel: string, opts: { danger?: boolean; cancelLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (result: boolean) => {
      overlay.remove();
      previous?.focus?.();
      resolve(result);
    };
    const ok = button(confirmLabel, () => close(true), { variant: opts.danger ? 'danger' : 'primary' });
    const cancel = button(opts.cancelLabel ?? 'Cancel', () => close(false));
    const dialog = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-msg' },
      h('div', { class: 'dialog-body' }, icon(opts.danger ? 'warning' : 'question'), h('p', { id: 'dlg-msg' }, message)),
      h('div', { class: 'dialog-actions' }, cancel, ok));
    const overlay = h('div', {
      class: 'overlay',
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        if (e.key === 'Tab') { // simple focus trap
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      },
      onClick: (e: Event) => { if (e.target === overlay) close(false); },
    }, dialog);
    document.body.appendChild(overlay);
    cancel.focus();
  });
}
