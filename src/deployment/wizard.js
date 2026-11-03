import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { steps, wizardFields, validateField, normalizeAnswers, capacity, summary } from './catalog.js';

export async function runWizard({ input = process.stdin, output = process.stdout, ask, initial = {} } = {}) {
  let terminal;
  let sink;
  const abort = new AbortController();
  if (!ask) {
    if (!input.isTTY || !output.isTTY) throw new Error('Run objy deploy in an interactive terminal');
    sink = new Writable({ write(chunk, _encoding, callback) { if (!sink.muted) output.write(chunk); callback(); } });
    sink.isTTY = true; sink.columns = output.columns;
    terminal = createInterface({ input, output: sink, terminal: true });
    terminal.on('SIGINT', () => { abort.abort(); terminal.close(); });
    ask = async (field, prompt) => {
      const pending = terminal.question(prompt, { signal: abort.signal });
      sink.muted = Boolean(field.secret);
      try { return await pending; }
      finally { sink.muted = false; if (field.secret) output.write('\n'); }
    };
  }
  const values = {};
  try {
    output.write('\nobjy · Deploy a cluster\n');
    for (let step = 0; step < steps.length; step++) {
      output.write(`\n${step + 1}. ${steps[step]}\n`);
      const visited = new Set();
      let group;
      while (true) {
        const f = wizardFields(values, step).find(f => !visited.has(f.id));
        if (!f) break;
        if (initial[f.id] !== undefined) { values[f.id] = validateField(f, initial[f.id]); visited.add(f.id); continue; }
        if (f.group && f.group !== group) { output.write(`\n${f.group}\n`); group = f.group; }
        if (f.help) output.write(`${f.help}\n`);
        if (f.options) f.options.forEach((o, i) => output.write(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}\n`));
        const defaultValue = initial[f.id] ?? f.defaultValue;
        const defaultLabel = f.options?.find(o => o.value === defaultValue)?.label ?? defaultValue;
        while (true) {
          const prompt = `${f.label}${defaultValue !== undefined && !f.secret ? ` [${defaultLabel}]` : f.required ? '' : ' (optional)'}: `;
          let value = await ask(f, prompt);
          if (f.options && /^\d+$/.test(value.trim())) value = f.options[Number(value.trim()) - 1]?.value || value;
          if (value === '' && defaultValue !== undefined) value = defaultValue;
          try { values[f.id] = validateField(f, value); break; }
          catch (error) { output.write(`${error.message}\n`); }
        }
        visited.add(f.id);
      }
      if (step === 1) {
        if (capacity(values).nodes > 64) { output.write('Choose at most 64 total nodes.\n'); step--; continue; }
        output.write(`\n${summary(values)}\n`);
      }
    }
    const normalized = normalizeAnswers(values);
    output.write(`\n${normalized.name}\n${summary(normalized)}\n${normalized.protocol.toUpperCase()} · Sign in as admin\n`);
    const answer = await ask({ id: 'confirm', label: 'Create cluster' }, 'Deploy cluster? [y/N]: ');
    return /^y(es)?$/i.test(answer.trim()) ? normalized : null;
  } finally { terminal?.close(); }
}
