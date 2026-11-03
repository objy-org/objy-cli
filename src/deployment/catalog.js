// Shared by the browser, terminal wizard, and server validation.
export const targets = [
  { value: 'hetzner', label: 'Hetzner Cloud', description: 'Create a cluster in your cloud account.' },
  { value: 'docker', label: 'Local Docker', description: 'Run a cluster and storage with Docker.' },
  { value: 'node-process', label: 'Local Node.js', description: 'Run directly on this computer.' },
  { value: 'vm', label: 'Existing virtual machines', description: 'Install on your Linux machines over SSH.' },
];
export const presets = [
  { value: 'tiny', label: 'Tiny', description: '1 node · 2 GiB per node', shards: 1, replicas: 1, heapMb: 2048 },
  { value: 'small', label: 'Small', description: '3 nodes · 2 GiB per node', shards: 1, replicas: 3, heapMb: 2048 },
  { value: 'medium', label: 'Medium', description: '6 nodes · 4 GiB per node', shards: 2, replicas: 3, heapMb: 4096 },
  { value: 'large', label: 'Large', description: '12 nodes · 8 GiB per node', shards: 4, replicas: 3, heapMb: 8192 },
  { value: 'custom', label: 'Custom', description: 'Choose your cluster size.' },
];
export const steps = ['Where?', 'How big?', 'Finish setup'];
export const regions = [
  { value: 'fsn1', label: 'Falkenstein, Germany' },
  { value: 'nbg1', label: 'Nuremberg, Germany' },
  { value: 'hel1', label: 'Helsinki, Finland' },
];
const field = (id, label, options = {}) => ({ id, label, type: 'text', required: true, ...options });
const secret = (id, label, options = {}) => field(id, label, { type: 'password', secret: true, ...options });
const select = (id, label, options, defaultValue) => field(id, label, { type: 'select', options, defaultValue });

export function capacity(values) {
  const preset = presets.find(p => p.value === (values.preset || 'tiny'));
  return preset && preset.value !== 'custom'
    ? { shards: preset.shards, replicas: preset.replicas, heapMb: preset.heapMb, nodes: preset.shards * preset.replicas }
    : { shards: Number(values.shards || 1), replicas: Number(values.replicas || 1), heapMb: Number(values.heapMb || 4096), nodes: Number(values.shards || 1) * Number(values.replicas || 1) };
}

export function storageChoices(target) {
  return [
    ...(target === 'docker' ? [{ value: 'docker-minio', label: 'Included local storage' }] : []),
    ...(target === 'hetzner' ? [{ value: 'hetzner-object-storage', label: 'Hetzner Object Storage' }] : []),
    { value: 'external-s3', label: 'Existing S3-compatible storage' },
  ];
}

export function wizardFields(values = {}, step) {
  const target = values.target || 'docker';
  if (step === 0) return [
    field('name', 'Cluster name', { maxLength: 48 }),
    select('target', 'Where should your cluster run?', targets, 'docker'),
    ...(target === 'hetzner' ? [select('region', 'Location', regions, 'fsn1'), secret('cloudToken', 'Hetzner API token')] : []),
  ];
  if (step === 1) return [
    select('preset', 'Cluster size', presets, 'tiny'),
    ...((values.preset || 'tiny') === 'custom' ? [
      field('shards', 'Shards', { type: 'number', defaultValue: 1, min: 1, max: 32, help: 'Shards divide your data across nodes.' }),
      field('replicas', 'Replicas per shard', { type: 'number', defaultValue: 1, min: 1, max: 3, help: 'Replicas are copies of each shard.' }),
      field('heapMb', 'Memory per node (MiB)', { type: 'number', defaultValue: 4096, min: 512, max: 262144 }),
    ] : []),
  ];
  if (step !== 2) return [];
  const storages = storageChoices(target);
  const storage = storages.some(s => s.value === values.storage) ? values.storage : storages[0].value;
  const connections = [];
  if (target === 'vm') for (let i = 0; i < Math.min(capacity(values).nodes, 64); i++) {
    const prefix = `vm${i}`;
    const group = `Machine ${i + 1}`;
    connections.push(
      field(`${prefix}Host`, 'Address', { group }),
      field(`${prefix}User`, 'SSH user', { group, defaultValue: 'root' }),
      field(`${prefix}Port`, 'SSH port', { group, type: 'number', defaultValue: 22, min: 1, max: 65535 }),
      { ...select(`${prefix}Auth`, 'Authentication', [
        { value: 'key', label: 'SSH private key' }, { value: 'password', label: 'Password' }, { value: 'agent', label: 'SSH agent' },
      ], 'key'), group },
    );
    const auth = values[`${prefix}Auth`] || 'key';
    if (auth === 'key') connections.push(field(`${prefix}Key`, 'Private key file', { group }), secret(`${prefix}Passphrase`, 'Key passphrase', { group, required: false }));
    if (auth === 'password') connections.push(secret(`${prefix}Password`, 'SSH password', { group }));
  }
  return [
    ...connections,
    select('storage', 'Storage', storages, storages[0].value),
    ...(storage === 'external-s3' ? [
      field('s3Endpoint', 'Storage endpoint', { type: 'url', placeholder: 'https://s3.example.com' }),
      field('s3Region', 'Storage region', { defaultValue: 'us-east-1' }),
      field('s3Bucket', 'Existing bucket'),
    ] : []),
    ...(storage !== 'docker-minio' ? [secret('accessKey', 'Storage access key'), secret('secretKey', 'Storage secret key')] : []),
    select('protocol', 'Connection', [{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }], 'http'),
    ...(target === 'hetzner' && values.protocol === 'https' ? [field('domain', 'Domain name', {
      maxLength: 253, placeholder: 'db.yourdomain.com',
      help: 'Required for HTTPS. Use Hetzner DNS or delegate certificate validation to it before setup. Hetzner manages the certificate on the load balancer.',
    })] : []),
    secret('adminPassword', 'Administrator password', { minLength: 8, help: 'Sign in as admin. Use at least 8 characters.' }),
  ];
}

export function validateField(field, raw) {
  const value = raw === undefined || raw === '' ? (field.defaultValue ?? '') : raw;
  if (field.required && (typeof value === 'string' ? !value.trim() : value === null)) throw new Error(`${field.label} is required`);
  if (!field.required && value === '') return '';
  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < field.min || n > field.max) throw new Error(`${field.label} must be between ${field.min} and ${field.max}`);
    return n;
  }
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${field.label} contains invalid characters`);
  if (value.length > (field.maxLength || 4096)) throw new Error(`${field.label} is too long`);
  if (field.minLength && value.length < field.minLength) throw new Error(`${field.label} needs at least ${field.minLength} characters`);
  if (field.options && !field.options.some(option => option.value === value)) throw new Error(`Choose a valid ${field.label.toLowerCase()}`);
  if (field.id === 'name' && !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('Use a name starting with a lowercase letter, followed by lowercase letters, digits or hyphens');
  if (field.id === 'domain') return normalizeDomain(value);
  if (field.type === 'url') {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${field.label} must be an HTTP or HTTPS URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${field.label} must be an HTTP or HTTPS URL without credentials or a query`);
  }
  return field.secret ? value : value.trim();
}

export function normalizeDomain(value) {
  const domain = String(value).trim().toLowerCase();
  if (!domain) return '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
    || /\.(localhost|local|internal|test|invalid|example)$/.test(domain)) {
    throw new Error('Enter a public domain name such as db.yourdomain.com, without https:// or a path');
  }
  return domain;
}

export function normalizeAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Setup answers are required');
  const values = {};
  for (let step = 0; step < steps.length; step++) {
    // Re-evaluate after every selection: dependent fields share the same defaults everywhere.
    const visited = new Set();
    while (true) {
      const next = wizardFields(values, step).find(f => !visited.has(f.id));
      if (!next) break;
      values[next.id] = validateField(next, input[next.id]);
      visited.add(next.id);
    }
    if (step === 1 && capacity(values).nodes > 64) throw new Error('A cluster can have at most 64 nodes');
  }
  return values;
}

export function splitAnswers(values) {
  const secrets = {}, settings = {};
  const secretIds = new Set(steps.flatMap((_, i) => wizardFields(values, i)).filter(f => f.secret).map(f => f.id));
  for (const [key, value] of Object.entries(values)) (secretIds.has(key) ? secrets : settings)[key] = value;
  return { settings, secrets };
}

export function summary(values) {
  const size = capacity(values);
  return `${targets.find(t => t.value === values.target)?.label || ''} · ${size.nodes} node${size.nodes === 1 ? '' : 's'} · ${size.shards} shard${size.shards === 1 ? '' : 's'} · ${size.replicas} replica${size.replicas === 1 ? '' : 's'} per shard · ${size.heapMb} MiB per node`;
}
