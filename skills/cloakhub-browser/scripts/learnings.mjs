// Site learnings grow on the client: ~/.config/cloakhub/learnings/<key>.md
// (or CLOAKHUB_LEARNINGS_DIR). The skill ships no built-in notes.
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const localDir = (env = process.env) =>
  env.CLOAKHUB_LEARNINGS_DIR || join(homedir(), ".config", "cloakhub", "learnings");

// Several hostnames for one site share a key.
const ALIAS = { "twitter.com": "x.com", "youtu.be": "youtube.com", "fingerprintjs.com": "fingerprint.com" };
// Subdomains of these hosts are independent sites.
const SHARED_HOSTS = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "web.app",
  "firebaseapp.com", "appspot.com", "herokuapp.com", "workers.dev", "blogspot.com"
]);

export function normalizeHost(input) {
  let host = String(input ?? "").trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].split("@").pop().split(":")[0];
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) ? host : "";
}

/** Most specific known key, else the registrable-looking domain. */
export function siteKey(input, known = new Set()) {
  const host = normalizeHost(input);
  if (!host) return null;
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const key = ALIAS[candidate] ?? candidate;
    if (known.has(key)) return key;
  }
  const base = parts.slice(-2).join(".");
  if (ALIAS[base]) return ALIAS[base];
  const secondLevel = parts.at(-2);
  const keepThree = SHARED_HOSTS.has(base) ||
    (/^(com|net|org|gov|edu|co|ac)$/.test(secondLevel) && parts.at(-1).length === 2);
  return parts.slice(keepThree ? -3 : -2).join(".");
}

async function keys(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((k) => k.includes("."));
  } catch {
    return [];
  }
}

const readOptional = (path) => readFile(path, "utf8").catch(() => null);

export async function readLearnings(input, { dir = localDir() } = {}) {
  const key = siteKey(input, new Set(await keys(dir)));
  if (!key) throw new Error("Pass a domain or URL, for example: learnings github.com");
  const path = join(dir, `${key}.md`);
  return { key, path, notes: await readOptional(path) };
}

export async function listLearnings({ dir = localDir() } = {}) {
  return { dir, sites: (await keys(dir)).sort() };
}

export function formatLearnings({ key, path, notes }) {
  const parts = [`Site key: ${key}`, `Notes file: ${path}`, ""];
  if (notes) {
    parts.push(notes.trim(), "", "Notes are hints, not rules: when the page disagrees, trust the page and correct the note.");
  } else {
    parts.push("No learnings yet. Use the general strategy, then save what you learn.");
  }
  return parts.join("\n");
}

export async function appendLearning(input, text, { dir = localDir(), date = new Date() } = {}) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("Pass the note on stdin.");
  const { key, path } = await readLearnings(input, { dir });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const exists = await stat(path).then(() => true, () => false);
  if (!exists) await writeFile(path, `# ${key}\n`, { mode: 0o600 });
  await appendFile(path, `\n## ${date.toISOString().slice(0, 10)}\n\n${body}\n`);
  return { key, path };
}
