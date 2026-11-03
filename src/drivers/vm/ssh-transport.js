import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cliHome } from '../../deployment/state.js';
import ssh2 from "ssh2";

const { Client } = ssh2;

export function createSshTransport({ ClientClass = Client, read = readFile, knownHostsDirectory = join(cliHome(), 'ssh', 'known-hosts') } = {}) {
  return {
    async run(connection, command, { input, timeoutMs = 600000 } = {}) {
      return withClient(connection, async (client) => {
        let timer;
        try { return await new Promise((resolve, reject) => {
        timer = setTimeout(() => { client.end(); reject(new Error('Remote command timed out; its outcome must be inspected before retrying')); }, timeoutMs);
        client.exec(command, (error, stream) => {
          if (error) return reject(error);
          let stdout = "";
          let stderr = "";
          stream.setEncoding("utf8");
          stream.stderr.setEncoding("utf8");
          stream.on("data", (chunk) => { stdout += chunk; });
          stream.stderr.on("data", (chunk) => { stderr += chunk; });
          stream.once("error", reject);
          stream.once("close", (code, signal) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr.trim() || stdout.trim() || `remote command exited with ${code ?? signal}`));
          });
          stream.end(input);
        });
        }); } finally { clearTimeout(timer); }
      });
    },

    async upload(connection, source, destination) {
      return withClient(connection, (client) => new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) return reject(error);
          sftp.fastPut(source, destination, (uploadError) => uploadError ? reject(uploadError) : resolve());
        });
      }));
    },

    async follow(connection, command, { stdout = process.stdout, stderr = process.stderr } = {}) {
      return withClient(connection, (client) => new Promise((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) return reject(error);
          stream.pipe(stdout, { end: false });
          stream.stderr.pipe(stderr, { end: false });
          stream.once("error", reject);
          stream.once("close", (code, signal) => code === 0 || code === null
            ? resolve()
            : reject(new Error(`remote log stream exited with ${code ?? signal}`)));
        });
      }));
    },
  };

  async function withClient(connection, operation) {
    const client = new ClientClass();
    const config = await clientConfig(connection);
    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      if (connection.password) {
        client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
          finish(prompts.map(() => connection.password));
        });
      }
      client.connect(config);
    }).catch((error) => {
      client.end();
      throw new Error(`SSH connection to ${connection.username}@${connection.host}:${connection.port} failed: ${error.message}`);
    });
    try {
      return await operation(client);
    } catch (error) {
      throw new Error(`SSH operation on ${connection.host} failed: ${error.message}`);
    } finally {
      client.end();
    }
  }

  async function clientConfig(connection) {
    const config = {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      readyTimeout: 10_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (fingerprint, callback) => {
        pinHostKey(knownHostsDirectory, connection, fingerprint).then(callback, () => callback(false));
      },
    };
    if (connection.password) return { ...config, password: connection.password, tryKeyboard: true };
    if (connection.identityFile) {
      return {
        ...config,
        privateKey: await read(connection.identityFile),
        ...(connection.passphrase ? { passphrase: connection.passphrase } : {}),
      };
    }
    if (connection.agent) return { ...config, agent: connection.agent };
    throw new Error(`SSH authentication is not configured for ${connection.host}`);
  }
}

export async function pinHostKey(directory, connection, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(`${connection.host}:${connection.port}`).digest('hex');
  const path = join(directory, key);
  try { await writeFile(path, fingerprint, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return await readFile(path, 'utf8') === fingerprint;
}
