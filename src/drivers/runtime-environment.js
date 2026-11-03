import { secretEnvironmentNames } from "../core/secrets.js";

export function runtimeEnvironmentFile(plan, environment = process.env) {
  return `${runtimeEnvironmentEntries(plan, environment).map(([name, value]) => {
    return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join("\n")}\n`;
}

export function containerEnvironmentFile(plan, environment = process.env) {
  return `${runtimeEnvironmentEntries(plan, environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runtimeEnvironmentEntries(plan, environment) {
  const names = secretEnvironmentNames(plan.database);
  return names.map((name) => {
    const value = environment[name];
    if (typeof value !== "string" || !value) throw new Error(`required secret is missing: ${name}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`${name} contains unsupported line breaks`);
    return [name, value];
  });
}
