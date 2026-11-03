import { isIP } from "node:net";

export const HTTP = "http";
export const HTTPS = "https";

export function usesHttps(value) {
  return value?.public?.protocol === HTTPS || value?.installation?.public?.protocol === HTTPS;
}

export function localAccessHost(bindAddress) {
  return ["0.0.0.0", "::", "[::]", "127.0.0.1", "::1", "[::1]"].includes(bindAddress)
    ? "localhost"
    : stripBrackets(bindAddress);
}

export function publicUrl(protocol, host, port) {
  const suffix = port && !isDefaultPort(protocol, port) ? `:${port}` : "";
  return `${protocol}://${urlHost(host)}${suffix}`;
}

export function renderCaddyfile({ host, port = 443, upstreams }) {
  if (!Array.isArray(upstreams) || !upstreams.length) throw new Error("Caddy requires at least one OBJY DB upstream");
  const name = stripBrackets(host);
  const address = port === 443 ? urlHost(name) : `${urlHost(name)}:${port}`;
  const tls = tlsDirective(name);
  return `{
	admin off
}

${address} {
${tls}	reverse_proxy ${upstreams.join(" ")} {
		health_uri /health
		health_interval 10s
	}
}
`;
}

export function caddySystemdSetupCommand() {
  return `CADDY_VERSION=$(caddy version 2>/dev/null | sed -E 's/^v([^ ]+).*/\\1/' || true)
if ! command -v caddy >/dev/null 2>&1 || ! dpkg --compare-versions "\${CADDY_VERSION:-0}" ge 2.10.1; then
  command -v apt-get >/dev/null 2>&1 || { echo "Caddy 2.10.1 or newer is required; install it before enabling HTTPS" >&2; exit 1; }
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
fi
id -u caddy >/dev/null 2>&1 || sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
sudo systemctl disable --now caddy.service >/dev/null 2>&1 || true`;
}

function tlsDirective(host) {
  if (isLocalIdentity(host)) return "\ttls internal\n";
  if (isIP(host)) {
    return `\ttls {
\t\tissuer acme {
\t\t\tdir https://acme-v02.api.letsencrypt.org/directory
\t\t\tprofile shortlived
\t\t}
\t}
`;
  }
  return "";
}

export function isLocalIdentity(host) {
  const lower = host.toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(lower)) return true;
  if ([".localhost", ".local", ".internal", ".test", ".invalid", ".example"].some((suffix) => lower.endsWith(suffix))) return true;
  if (!isIP(lower)) return !lower.includes(".");
  if (isIP(lower) === 4) {
    const [first, second] = lower.split(".").map(Number);
    return first === 10 || first === 127 || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

function stripBrackets(value) {
  const source = String(value || "").trim();
  return source.startsWith("[") && source.endsWith("]") ? source.slice(1, -1) : source;
}

function urlHost(value) {
  const host = stripBrackets(value);
  return host.includes(":") ? `[${host}]` : host;
}

function isDefaultPort(protocol, port) {
  return (protocol === HTTP && Number(port) === 80) || (protocol === HTTPS && Number(port) === 443);
}
