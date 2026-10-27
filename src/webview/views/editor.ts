import { ITEM_TYPE_INFO, ITEM_TYPES, isItemType, type CustomFieldInput, type EntryDetail, type EntryInput, type FieldValueInput, type ItemType } from '../../shared/model';
import { activeVault, app, render, selectEntry, strengthMeter, type NewItemPreset } from '../app';
import { confirmDialog } from '../dialog';
import { button, debounce, h, icon, iconButton, replace } from '../dom';
import { rpc } from '../rpc';
import { reportError, toast } from '../toast';

/**
 * A secret input that starts in "unchanged" state for existing items: the
 * current value is NOT sent to the webview unless the user clicks reveal.
 */
interface SecretInput {
  el: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  value(): FieldValueInput;
  set(value: string): void;
  dirty(): boolean;
}

function secretInput(opts: {
  id: string; existing: boolean; reveal?: () => Promise<string>; multiline?: boolean; placeholder?: string;
  onInput?: (v: string) => void; generate?: () => Promise<string>;
}): SecretInput {
  let keep = opts.existing;
  let loaded = !opts.existing;
  let changed = false;
  const input = opts.multiline
    ? h('textarea', { id: opts.id, class: 'input mono', rows: 5, spellcheck: false, autocomplete: 'off' })
    : h('input', { id: opts.id, type: 'password', class: 'input mono', spellcheck: false, autocomplete: 'new-password' });
  input.placeholder = opts.existing ? '•••••••• (unchanged — click the eye to show)' : (opts.placeholder ?? '');
  const markChanged = () => {
    keep = false;
    loaded = true;
    changed = true;
    opts.onInput?.(input.value);
  };
  input.addEventListener('input', markChanged);
  const show = (visible: boolean) => {
    if (input instanceof HTMLInputElement) input.type = visible ? 'text' : 'password';
    else input.classList.toggle('masked', !visible);
    eye.replaceChildren(icon(visible ? 'eye-closed' : 'eye'));
    eye.title = visible ? 'Hide' : 'Show';
  };
  let visible = false;
  if (input instanceof HTMLTextAreaElement) input.classList.add('masked');
  const eye = iconButton('eye', 'Show', async () => {
    if (!loaded && opts.reveal) {
      try {
        input.value = await opts.reveal();
        loaded = true;
        opts.onInput?.(input.value);
      } catch (err) {
        reportError(err);
        return;
      }
    }
    visible = !visible;
    show(visible);
  });
  const gen = opts.generate ? iconButton('sync', 'Generate', async () => {
    try {
      input.value = await opts.generate!();
      markChanged();
      visible = true;
      show(true);
    } catch (err) {
      reportError(err);
    }
  }) : null;
  const el = h('div', { class: 'input-group' }, input, h('div', { class: 'input-actions' }, eye, gen));
  return {
    el, input,
    value: () => (keep ? { keep: true } : input.value),
    set: (v) => { input.value = v; markChanged(); visible = true; show(true); },
    dirty: () => changed,
  };
}

interface CustomRow {
  originalName?: string;
  name: HTMLInputElement;
  protect: HTMLInputElement;
  plain: HTMLInputElement | HTMLTextAreaElement;
  secret: SecretInput;
  el: HTMLElement;
}

export function renderEditor(pane: HTMLElement, detail: EntryDetail | null, preset: NewItemPreset): void {
  const vault = activeVault()!;
  const isNew = detail === null;
  let type: ItemType = detail?.type ?? (isItemType(preset.type) ? preset.type : 'login');
  let dirty = false;
  const markDirty = () => { dirty = true; };
  const uid = (s: string) => `f-${s}`;

  // ---- inputs
  const title = h('input', { id: uid('title'), class: 'input', value: detail?.title ?? '', required: true, autocomplete: 'off', onInput: markDirty });
  const username = h('input', { id: uid('user'), class: 'input mono', value: detail?.username ?? '', autocomplete: 'off', spellcheck: false, onInput: markDirty });
  const url = h('input', { id: uid('url'), class: 'input', value: detail?.url ?? '', autocomplete: 'off', spellcheck: false, placeholder: 'https://', onInput: markDirty });
  const notes = h('textarea', { id: uid('notes'), class: 'input', rows: 5, value: detail?.notes ?? '', onInput: markDirty });
  const tags = h('input', { id: uid('tags'), class: 'input', value: (detail?.tags ?? []).join(', '), placeholder: 'work, personal, …', autocomplete: 'off', onInput: markDirty });
  const favorite = h('input', { id: uid('fav'), type: 'checkbox', checked: detail?.favorite ?? false, onChange: markDirty });
  const expires = h('input', { id: uid('exp'), type: 'date', class: 'input', value: detail?.expires ? new Date(detail.expires).toISOString().slice(0, 10) : '', onInput: markDirty });
  const folders = app.data?.folders.filter((f) => !f.isTrash) ?? [];
  const defaultFolder = detail?.folderId ?? preset.folderId ?? (app.filter.kind === 'folder' ? app.filter.value : undefined) ?? folders.find((f) => f.isRoot)?.id ?? '';
  const folder = h('select', { id: uid('folder'), class: 'select', value: defaultFolder, onChange: markDirty },
    folders.map((f) => h('option', { value: f.id }, f.isRoot ? 'No folder' : `${'  '.repeat(f.depth - 1)}${f.name}`)));

  const strengthEl = h('div', { class: 'strength-slot' });
  const updateStrength = debounce((v: string) => {
    if (!app.data?.prefs.showPasswordStrength) return;
    if (!v) return replace(strengthEl);
    rpc('strength', { value: v }).then((s) => replace(strengthEl, strengthMeter(s.score, s.label, s.warning || `${s.crackTime} to crack`))).catch(() => undefined);
  }, 200);

  const generate = async () => {
    const options = await rpc('getGeneratorOptions', {});
    return (await rpc('generate', { options })).value;
  };
  const password = secretInput({
    id: uid('pw'), existing: !!detail?.hasPassword,
    reveal: () => rpc('reveal', { vaultId: vault.id, entryId: detail!.id, field: 'Password' }),
    onInput: (v) => { markDirty(); updateStrength(v); }, generate,
  });
  if (preset.password) password.set(preset.password);
  // ---- 2FA: the setup key (or an otpauth:// link) shown by the website
  const totp = secretInput({
    id: uid('totp'), existing: !!detail?.hasTotp, placeholder: 'Setup key or otpauth:// URI',
    reveal: () => rpc('reveal', { vaultId: vault.id, entryId: detail!.id, field: 'otp' }), onInput: markDirty,
  });

  // ---- custom fields
  const customList = h('div', { class: 'custom-fields' });
  const rows: CustomRow[] = [];
  const addRow = (f: { name: string; protected: boolean; value?: string; hasValue?: boolean; multiline?: boolean; existing?: boolean }) => {
    const name = h('input', { class: 'input', value: f.name, placeholder: 'Field name', 'aria-label': 'Field name', onInput: markDirty });
    const plain = f.multiline
      ? h('textarea', { class: 'input mono', rows: 4, value: f.value ?? '', 'aria-label': 'Field value', onInput: markDirty })
      : h('input', { class: 'input', value: f.value ?? '', 'aria-label': 'Field value', autocomplete: 'off', onInput: markDirty });
    const secret = secretInput({
      id: `cf-${rows.length}-${Date.now()}`, existing: !!(f.existing && f.protected && f.hasValue), multiline: f.multiline,
      reveal: () => rpc('reveal', { vaultId: vault.id, entryId: detail!.id, field: f.name }), onInput: markDirty,
    });
    const protect = h('input', { type: 'checkbox', checked: f.protected, title: 'Hidden (protected) field' });
    const row: CustomRow = { originalName: f.existing ? f.name : undefined, name, protect, plain, secret, el: h('div') };
    const valueSlot = h('div', { class: 'cf-value' });
    const sync = () => replace(valueSlot, protect.checked ? secret.el : plain);
    protect.addEventListener('change', async () => {
      markDirty();
      // Moving a value between plain/secret inputs: make sure the current content is known.
      if (protect.checked) {
        secret.set(plain.value);
      } else {
        const v = secret.value();
        if (typeof v === 'object') {
          try {
            plain.value = await rpc('reveal', { vaultId: vault.id, entryId: detail!.id, field: row.originalName ?? name.value });
          } catch (err) {
            reportError(err);
            protect.checked = true;
            return;
          }
        } else plain.value = v;
      }
      sync();
    });
    sync();
    row.el = h('div', { class: 'cf-row' },
      h('div', { class: 'cf-name' }, name),
      valueSlot,
      h('label', { class: 'cf-protect', title: 'Hide the value (protected field)' }, protect, h('span', null, 'Hidden')),
      iconButton('close', 'Remove field', () => {
        rows.splice(rows.indexOf(row), 1);
        row.el.remove();
        markDirty();
      }));
    rows.push(row);
    customList.appendChild(row.el);
  };
  if (detail) {
    for (const f of detail.customFields) addRow({ ...f, existing: true });
  } else {
    for (const t of ITEM_TYPE_INFO[type].templateFields) addRow({ name: t.name, protected: t.protected, multiline: t.multiline });
  }

  // ---- type selector (new items) – rebuilds labels and template fields
  const labels: Record<'user' | 'pw' | 'url', HTMLElement> = {
    user: h('label', { class: 'field-label', for: uid('user') }),
    pw: h('label', { class: 'field-label', for: uid('pw') }),
    url: h('label', { class: 'field-label', for: uid('url') }),
  };
  const groups = {
    user: h('div', { class: 'field' }, labels.user, username),
    pw: h('div', { class: 'field' }, labels.pw, password.el, strengthEl),
    url: h('div', { class: 'field' }, labels.url, url),
  };
  const applyType = () => {
    const info = ITEM_TYPE_INFO[type];
    labels.user.textContent = info.usernameLabel ?? 'Username';
    labels.pw.textContent = info.passwordLabel ?? 'Password';
    labels.url.textContent = info.urlLabel ?? 'URL';
    // Hide standard fields that are irrelevant for the type, unless they already hold data.
    groups.user.hidden = !info.usernameLabel && !username.value;
    groups.pw.hidden = !info.passwordLabel && !detail?.hasPassword && !password.dirty();
    groups.url.hidden = !info.urlLabel && !url.value;
  };
  const typeSelect = h('div', { class: 'type-picker', role: 'radiogroup', 'aria-label': 'Item type' },
    ITEM_TYPES.map((t) => h('button', {
      type: 'button', role: 'radio', class: ['type-option', t === type && 'active'], 'aria-checked': t === type ? 'true' : 'false',
      onClick: (ev: Event) => {
        if (t === type) return;
        const prevTemplate = new Set(ITEM_TYPE_INFO[type].templateFields.map((x) => x.name));
        // drop untouched template fields of the previous type
        for (const r of [...rows]) {
          const untouched = prevTemplate.has(r.name.value) && !r.plain.value && !r.secret.dirty();
          if (untouched) { rows.splice(rows.indexOf(r), 1); r.el.remove(); }
        }
        type = t;
        for (const tf of ITEM_TYPE_INFO[t].templateFields) {
          if (!rows.some((r) => r.name.value === tf.name)) addRow({ name: tf.name, protected: tf.protected, multiline: tf.multiline });
        }
        typeSelect.querySelectorAll('.type-option').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
        (ev.currentTarget as HTMLElement).classList.add('active');
        (ev.currentTarget as HTMLElement).setAttribute('aria-checked', 'true');
        applyType();
        markDirty();
      },
    }, icon(ITEM_TYPE_INFO[t].icon), h('span', null, ITEM_TYPE_INFO[t].label))));
  applyType();

  // ---- save / cancel
  const collect = (): EntryInput => {
    const custom: CustomFieldInput[] = rows.map((r) => ({
      name: r.name.value.trim(),
      originalName: r.originalName,
      protected: r.protect.checked,
      value: r.protect.checked ? r.secret.value() : r.plain.value,
    }));
    return {
      type,
      title: title.value.trim(),
      username: username.value,
      password: password.value(),
      url: url.value.trim(),
      notes: notes.value,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      favorite: favorite.checked,
      folderId: folder.value || null,
      expires: expires.value ? new Date(`${expires.value}T23:59:59`).getTime() : null,
      totp: totp.value(),
      customFields: custom.filter((c) => c.name || (typeof c.value === 'string' && c.value)),
    };
  };
  let saving = false;
  const save = async () => {
    if (saving) return;
    const input = collect();
    if (!input.title) {
      title.focus();
      title.classList.add('invalid');
      toast('A name is required', 'error');
      return;
    }
    const names = input.customFields.map((c) => c.name);
    if (names.some((n) => !n)) return toast('Custom fields need a name', 'error');
    if (new Set(names).size !== names.length) return toast('Custom field names must be unique', 'error');
    saving = true;
    saveBtn.disabled = true;
    try {
      const id = await rpc('saveEntry', { vaultId: vault.id, entryId: detail?.id ?? null, input });
      app.confirmLeave = undefined;
      dirty = false;
      app.newItem = undefined;
      toast(isNew ? 'Item created' : 'Changes saved', 'success');
      app.mode = 'view';
      app.selectedId = id;
      selectEntry(id);
    } catch (err) {
      reportError(err);
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  };
  const close = () => {
    app.confirmLeave = undefined;
    app.newItem = undefined;
    app.mode = 'view';
    if (isNew) render.list();
    render.detail();
  };
  const cancel = () => {
    if (!dirty) return close();
    void confirmDialog('Discard your unsaved changes?', 'Discard changes', { danger: true, cancelLabel: 'Keep editing' }).then((ok) => ok && close());
  };
  // Reports "dirty" to the navigation guard in app.ts.
  app.confirmLeave = () => dirty;

  const saveBtn = button(isNew ? 'Create' : 'Save', () => void save(), { icon: 'check', variant: 'primary', title: 'Save (Ctrl+S)' });
  const field = (label: string, forId: string, ...content: (HTMLElement | null)[]) =>
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: forId }, label), content);

  const form = h('form', {
    class: 'editor', 'aria-label': isNew ? 'New item' : `Edit ${detail.title}`,
    onSubmit: (e: Event) => { e.preventDefault(); void save(); },
    onKeydown: (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    },
  },
  h('div', { class: 'detail-header' },
    iconButton('arrow-left', 'Back', cancel, { class: 'back-btn' }),
    h('div', { class: 'detail-title' }, h('h1', null, isNew ? 'New item' : 'Edit item')),
    h('div', { class: 'detail-actions' }, button('Cancel', cancel), saveBtn)),
  isNew ? h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Type'), typeSelect) : null,
  h('div', { class: 'card' },
    field('Name', uid('title'), title),
    groups.user, groups.pw, groups.url),
  h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Custom fields'),
    customList,
    button('Add field', () => { addRow({ name: '', protected: false }); markDirty(); rows[rows.length - 1].name.focus(); }, { icon: 'add' })),
  h('div', { class: 'card' },
    field('Two-factor authentication (TOTP)', uid('totp'), totp.el,
      h('div', { class: 'field-hint muted' }, 'Type or paste the setup key shown by the website when you enable two-factor authentication (usually under "Can\'t scan the QR code?").')),
    field('Notes', uid('notes'), notes)),
  h('div', { class: 'card grid-2' },
    field('Folder', uid('folder'), folder),
    field('Tags (comma separated)', uid('tags'), tags),
    field('Expires', uid('exp'), expires),
    h('div', { class: 'field' }, h('label', { class: 'checkbox', for: uid('fav') }, favorite, icon('star-full'), ' Favorite'))));

  replace(pane, form);
  title.focus();
  if (isNew && preset.password) updateStrength(preset.password);
}
