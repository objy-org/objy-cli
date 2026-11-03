import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createManager } from './manager.js';
import { doctor, targetId, targetName } from './doctor.js';
import { runWizard } from './deployment/wizard.js';

const optionTypes = {
  help: 'boolean', version: 'boolean', json: 'boolean', yes: 'boolean', follow: 'boolean',
  home: 'string', config: 'string', name: 'string', size: 'string', region: 'string', protocol: 'string', domain: 'string',
  shards: 'string', replicas: 'string', memory: 'string', storage: 'string', 's3-endpoint': 'string', 's3-region': 'string', 's3-bucket': 'string',
  'release-manifest': 'string', node: 'string', lines: 'string',
};
const shorts = { help: 'h', version: 'v', yes: 'y', follow: 'f' };
const deployOptions = ['config', 'name', 'size', 'region', 'protocol', 'domain', 'shards', 'replicas', 'memory', 'storage', 's3-endpoint', 's3-region', 's3-bucket', 'release-manifest', 'yes'];
const allowed = { deploy: deployOptions, logs: ['follow', 'node', 'lines'], doctor: ['protocol'], start: [], stop: [], restart: [], resume: [], list: [], status: [], help: [], version: [] };

export function parseCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: Object.fromEntries(Object.entries(optionTypes).map(([name, type]) => [name, { type, ...(shorts[name] ? { short: shorts[name] } : {}) }])) });
  const [command, subject, ...extra] = positionals;
  if (extra.length) throw new Error('Too many arguments. Run objy --help.');
  if (command && !allowed[command]) throw new Error(`Unknown command: ${command}. Run objy --help.`);
  for (const name of Object.keys(values)) {
    if (['help', 'version', 'home', 'json'].includes(name)) continue;
    if (!allowed[command]?.includes(name)) throw new Error(`--${name} is not valid for ${command || 'the menu'}`);
  }
  if (subject && ['list', 'help', 'version'].includes(command)) throw new Error(`${command} does not take a deployment name`);
  return { command, subject, options: values };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, error = process.stderr, environment = process.env, managerFactory = createManager, doctorImpl = doctor } = {}) {
  let parsed;
  try {
    parsed = parseCommand(argv);
    return await execute();
  } catch (failure) {
    if (argv.includes('--json')) { output.write(JSON.stringify({ error: failure.message }) + '\n'); return 1; }
    throw failure;
  }
  async function execute() {
    let { command, subject, options } = parsed;
    if (options.version || command === 'version') {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
      output.write(options.json ? JSON.stringify({ version: pkg.version }) + '\n' : `${pkg.version}\n`); return 0;
    }
    if (options.help || command === 'help') { output.write(options.json ? JSON.stringify({ help }) + '\n' : help); return 0; }
    if (!command && options.json) throw new Error('Specify a command with --json, for example objy list --json.');
    if (!command && (!input.isTTY || !output.isTTY)) { output.write(help); return 0; }
    const manager = managerFactory({ root: options.home, environment });
    const interactive = input.isTTY && output.isTTY && !options.json;
    const ask = async (prompt, choices) => {
      if (!interactive) throw new Error('Specify a deployment name. Run objy list --json to see saved deployments.');
      const terminal = createInterface({ input, output });
      const abort = new AbortController();
      terminal.on('SIGINT', () => { abort.abort(); terminal.close(); });
      try {
        output.write(`\n${prompt}\n`);
        choices.forEach((choice, i) => output.write(`  ${i + 1}  ${choice.label}\n`));
        while (true) {
          const answer = await terminal.question('\nChoose: ', { signal: abort.signal });
          const choice = choices[Number(answer) - 1] || choices.find(c => c.value === answer);
          if (choice) return choice.value;
          output.write('Choose one of the options above.\n');
        }
      } finally { terminal.close(); }
    };
    if (!command) {
      output.write('\nobjy\n');
      command = await ask('What would you like to do?', [
        { value: 'deploy', label: 'Deploy a cluster' },
        { value: 'manage', label: 'Manage deployments' },
        { value: 'doctor', label: 'Check setup' },
      ]);
    }
    const pickDeployment = async () => {
      const records = await manager.list();
      if (!records.length) throw new Error('No deployments yet. Start with objy deploy.');
      return ask('Choose a deployment', records.map(r => ({ value: r.name, label: `${r.name} · ${r.target} · ${r.state}` })));
    };
    if (command === 'manage') {
      subject = await pickDeployment();
      const record = await manager.status(subject);
      const pending = record.phase !== 'ready' || record.management?.operation?.status === 'pending';
      command = await ask(subject, [
        { value: 'status', label: 'View status and topology' },
        ...(pending ? [{ value: 'resume', label: 'Resume deployment or operation' }] : [
          { value: 'start', label: 'Start' }, { value: 'stop', label: 'Stop' }, { value: 'restart', label: 'Restart' },
        ]),
        { value: 'logs', label: 'View logs' },
      ]);
    }
    const emit = event => { if (!options.json) error.write(`  ${event.message}\n`); };
    let result;
    if (command === 'deploy') {
      let values = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : {};
      if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('The deployment config must be a JSON object');
      const mapping = { name: 'name', size: 'preset', region: 'region', protocol: 'protocol', domain: 'domain', shards: 'shards', replicas: 'replicas', memory: 'heapMb', storage: 'storage', 's3-endpoint': 's3Endpoint', 's3-region': 's3Region', 's3-bucket': 's3Bucket' };
      for (const [key, destination] of Object.entries(mapping)) if (options[key] !== undefined) values[destination] = options[key];
      if (['shards', 'replicas', 'memory'].some(key => options[key] !== undefined) && values.preset !== 'custom') throw new Error('Use --size custom with --shards, --replicas or --memory.');
      if (subject) values.target = subject;
      if (values.target) values.target = targetId(values.target);
      for (const [field, candidates] of Object.entries({
        cloudToken: ['HCLOUD_TOKEN'], adminPassword: ['OBJY_ADMIN_PASSWORD'],
        accessKey: ['OBJY_S3_ACCESS_KEY', 'TF_VAR_s3_access_key'], secretKey: ['OBJY_S3_SECRET_KEY', 'TF_VAR_s3_secret_key'],
      })) if (values[field] === undefined) {
        const value = candidates.map(key => environment[key]).find(value => value !== undefined);
        if (value !== undefined) values[field] = value;
      }
      if (interactive && !options.yes) {
        values = await runWizard({ input, output, initial: values });
        if (!values) { output.write('Cancelled.\n'); return 0; }
      } else {
        if (!options.yes) throw new Error('Noninteractive deployment requires --yes and all required settings. Run objy deploy in a terminal for guided setup.');
        if (!values.target || !values.name || !values.preset) throw new Error('Specify the target, --name and --size (tiny, small, medium, large or custom).');
      }
      result = await manager.deploy(values, { releaseFile: options['release-manifest'], onEvent: emit });
    } else if (command === 'doctor') {
      subject ||= interactive ? await ask('Check setup for', ['local', 'docker', 'vm', 'hetzner'].map(value => ({ value, label: value }))) : 'local';
      result = await doctorImpl(subject, { environment, protocol: options.protocol });
      if (options.json) output.write(JSON.stringify(result, null, 2) + '\n');
      else {
        output.write(`\n${result.target}\n`);
        for (const check of result.checks) output.write(`  ${check.ok ? '✓' : '×'} ${check.name}${check.ok ? '' : ` — ${check.detail}${check.install ? `\n    ${check.install}` : ''}`}\n`);
      }
      return result.ok ? 0 : 1;
    } else if (command === 'list') result = await manager.list();
    else {
      subject ||= await pickDeployment();
      if (command === 'status') result = await manager.status(subject);
      else if (command === 'resume') result = await manager.resume(subject, { onEvent: emit });
      else if (['start', 'stop', 'restart'].includes(command)) result = await manager.act(subject, command, { onEvent: emit });
      else if (command === 'logs') {
        if (options.json && options.follow) throw new Error('--follow cannot be combined with --json');
        const logOptions = { node: options.node, tail: options.lines === undefined ? 100 : Number(options.lines) };
        let previous = await manager.logs(subject, logOptions);
        output.write(options.json ? JSON.stringify({ logs: previous }) + '\n' : previous);
        if (options.follow) {
          const abort = new AbortController();
          const stop = () => abort.abort();
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          try {
            while (!abort.signal.aborted) {
              await delay(1000, undefined, { signal: abort.signal });
              const next = await manager.logs(subject, logOptions);
              output.write(logDelta(previous, next)); previous = next;
            }
          } catch (failure) { if (failure.name !== 'AbortError') throw failure; }
          finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
        }
        return 0;
      }
    }
    if (options.json) output.write(JSON.stringify(result, null, 2) + '\n');
    else output.write(format(result));
    return 0;
  }
}

export function logDelta(previous, next) {
  if (previous === next) return '';
  if (next.startsWith(previous)) return next.slice(previous.length);
  const old = previous.replace(/\n$/, '').split('\n'), current = next.replace(/\n$/, '').split('\n');
  for (let count = Math.min(old.length, current.length); count > 0; count--) {
    if (old.slice(-count).join('\n') === current.slice(0, count).join('\n')) {
      const added = current.slice(count);
      return added.length ? added.join('\n') + (next.endsWith('\n') ? '\n' : '') : '';
    }
  }
  return next;
}

function format(value) {
  if (Array.isArray(value)) return value.length ? '\n' + value.map(r => `${r.name.padEnd(22)} ${r.target.padEnd(9)} ${r.state}`).join('\n') + '\n' : 'No deployments yet. Start with objy deploy.\n';
  let text = `\n${value.name} · ${value.target} · ${value.state}\n`;
  if (value.release) text += `Server: ${value.release.version}\n`;
  if (value.topology?.endpoint) text += `Endpoint: ${value.topology.endpoint}\n`;
  if (value.stale) text += 'Live status unavailable; showing the last saved topology.\n';
  if (value.dns) text += `DNS: point ${value.dns.domain} to ${value.dns.address}\n`;
  if (value.error) text += `${value.error}\n`;
  if (value.management?.operation?.error) text += `${value.management.operation.error}\n`;
  if (value.topology?.nodes?.length) text += '\n' + value.topology.nodes.map(n => `${n.id}  ${n.address || 'Address unavailable'}  ${n.status}`).join('\n') + '\n';
  return text;
}

const help = `
objy — deploy and manage your clusters

  objy                         Open the interactive menu
  objy deploy [target]         Deploy a cluster
  objy list                    List your deployments
  objy status [name]           Show health and topology
  objy start [name]            Start database nodes
  objy stop [name]             Stop nodes; retain infrastructure and data
  objy restart [name]          Stop, then start nodes
  objy logs [name] [-f]        Read or follow logs
  objy resume [name]           Continue interrupted work
  objy doctor [target]         Check dependencies

Targets: local, docker, vm, hetzner
Sizes:   tiny, small, medium, large, custom

  objy deploy docker --name dev --size tiny
  objy deploy hetzner --name production --size small

Deploy: --name, --size, --region, --protocol http|https, --domain
Custom: --shards, --replicas, --memory <MiB>
Storage: --storage, --s3-endpoint, --s3-region, --s3-bucket
Advanced: --config <json>, --release-manifest <json>, --yes
Logs: --node <id>, --lines <count>, --follow
Global: --home <directory>, --json, --help, --version

Credentials: OBJY_ADMIN_PASSWORD, HCLOUD_TOKEN,
             OBJY_S3_ACCESS_KEY, OBJY_S3_SECRET_KEY
State: ~/.objy (override with OBJY_HOME or --home)
`;
