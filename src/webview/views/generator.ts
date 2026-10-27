import { DEFAULT_GENERATOR_OPTIONS, type GeneratorOptions } from '../../shared/model';
import { app, colorizedSecret, startNewItem, strengthMeter } from '../app';
import { button, debounce, h, icon, iconButton, replace } from '../dom';
import { rpc } from '../rpc';
import { reportError, toast } from '../toast';

/** Bitwarden-style generator: all randomness comes from the extension host's CSPRNG. */
export function renderGenerator(pane: HTMLElement): void {
  let options: GeneratorOptions = { ...DEFAULT_GENERATOR_OPTIONS };
  let current = '';
  const output = h('div', { class: 'gen-output mono', 'aria-live': 'polite', 'aria-label': 'Generated password' });
  const strengthSlot = h('div', { class: 'gen-strength' });
  const optionsEl = h('div', { class: 'gen-options' });

  const persist = debounce(() => void rpc('saveGeneratorOptions', { options }).catch(() => undefined), 400);
  const regenerate = async () => {
    try {
      const r = await rpc('generate', { options });
      current = r.value;
      replace(output, colorizedSecret(r.value));
      replace(strengthSlot, strengthMeter(r.strength.score, r.strength.label, `~${r.strength.entropyBits} bits of entropy`));
    } catch (err) {
      reportError(err);
    }
  };
  const update = (patch: Partial<GeneratorOptions>) => {
    options = { ...options, ...patch };
    persist();
    renderOptions();
    void regenerate();
  };

  const toggle = (label: string, key: 'uppercase' | 'lowercase' | 'digits' | 'symbols' | 'avoidAmbiguous' | 'capitalize' | 'includeNumber', hint?: string) =>
    h('label', { class: 'checkbox' },
      h('input', { type: 'checkbox', checked: options[key], onChange: (e: Event) => update({ [key]: (e.target as HTMLInputElement).checked }) }),
      h('span', null, label), hint ? h('span', { class: 'muted mono' }, ` ${hint}`) : null);

  const range = (label: string, key: 'length' | 'words', min: number, max: number) => {
    const valueEl = h('input', {
      type: 'number', class: 'input num', min, max, value: String(options[key]), 'aria-label': label,
      onChange: (e: Event) => update({ [key]: Number((e.target as HTMLInputElement).value) || min }),
    });
    const slider = h('input', {
      type: 'range', min, max, value: String(options[key]), 'aria-label': label,
      onInput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        valueEl.value = String(v);
        options = { ...options, [key]: v };
        persist();
        void regenerate();
      },
    });
    return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), h('div', { class: 'range-row' }, slider, valueEl));
  };

  const number = (label: string, key: 'minDigits' | 'minSymbols', disabled: boolean) => h('label', { class: 'inline-num' }, h('span', null, label),
    h('input', { type: 'number', class: 'input num', min: 0, max: 9, value: String(options[key]), disabled, onChange: (e: Event) => update({ [key]: Number((e.target as HTMLInputElement).value) || 0 }) }));

  const renderOptions = () => {
    const isPw = options.mode === 'password';
    replace(optionsEl,
      h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Generator type' },
        h('button', { type: 'button', role: 'tab', class: isPw ? 'active' : '', 'aria-selected': String(isPw), onClick: () => update({ mode: 'password' }) }, icon('key'), ' Password'),
        h('button', { type: 'button', role: 'tab', class: !isPw ? 'active' : '', 'aria-selected': String(!isPw), onClick: () => update({ mode: 'passphrase' }) }, icon('whole-word'), ' Passphrase')),
      isPw
        ? h('div', { class: 'card' },
          range('Length', 'length', 4, 128),
          h('div', { class: 'grid-2' },
            toggle('Uppercase', 'uppercase', 'A-Z'),
            toggle('Lowercase', 'lowercase', 'a-z'),
            toggle('Numbers', 'digits', '0-9'),
            toggle('Special characters', 'symbols', '!@#$%^&*'),
            number('Minimum numbers', 'minDigits', !options.digits),
            number('Minimum special', 'minSymbols', !options.symbols)),
          toggle('Avoid ambiguous characters', 'avoidAmbiguous', 'I l 1 O 0 o |'))
        : h('div', { class: 'card' },
          range('Number of words', 'words', 3, 20),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'gen-sep' }, 'Word separator'),
            h('input', { id: 'gen-sep', class: 'input num', maxLength: 3, value: options.separator, onChange: (e: Event) => update({ separator: (e.target as HTMLInputElement).value }) })),
          toggle('Capitalize', 'capitalize'),
          toggle('Include number', 'includeNumber'),
          h('p', { class: 'hint' }, 'Words come from the EFF large wordlist (7,776 words, ~12.9 bits each).')),
    );
  };

  replace(pane, h('div', { class: 'tool' },
    h('div', { class: 'tool-header' }, h('h1', null, icon('wand'), ' Password generator'),
      h('p', { class: 'muted' }, 'Generated locally with a cryptographically secure random generator. Nothing is stored or sent anywhere.')),
    h('div', { class: 'card gen-card' },
      output,
      h('div', { class: 'gen-actions' },
        iconButton('refresh', 'Regenerate', () => void regenerate()),
        button('Copy', () => current && void rpc('copyText', { text: current, sensitive: true }).catch(reportError), { icon: 'copy', variant: 'primary' }),
        app.data?.activeVaultId ? button('Save as new item', () => current && startNewItem({ password: current }), { icon: 'add' }) : null),
      strengthSlot),
    optionsEl));

  rpc('getGeneratorOptions', {}).then((o) => {
    options = o;
    renderOptions();
    void regenerate();
  }).catch((err) => {
    toast('Using default generator options', 'info');
    reportError(err);
    renderOptions();
    void regenerate();
  });
}
