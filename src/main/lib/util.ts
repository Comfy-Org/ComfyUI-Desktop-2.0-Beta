export function parseUrl(raw: string | null | undefined): { href: string; hostname: string; port: number } | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return {
      href: url.href.replace(/\/+$/, ""),
      hostname: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
    };
  } catch {
    return null;
  }
}

export function formatTime(secs: number): string {
  if (secs < 0 || !isFinite(secs)) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function extractPort(args: string[], defaultPort = 8188): number {
  let port = defaultPort
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10) || defaultPort
      i++
    } else {
      const m = args[i]!.match(/^--port=(\d+)$/)
      if (m) port = parseInt(m[1]!, 10) || defaultPort
    }
  }
  return port
}

export function parseArgs(str: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}
