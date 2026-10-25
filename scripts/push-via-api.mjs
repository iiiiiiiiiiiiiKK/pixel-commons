/**
 * Publish the working tree to GitHub using the REST "git data" API.
 *
 * Node's `git push` cannot reach github.com from this host (port 443 to
 * github.com is blocked, while api.github.com is reachable), so the repository is
 * published through the API instead: blobs → tree → commit → ref update.
 *
 *   GITHUB_TOKEN=... node scripts/push-via-api.mjs --repo owner/name --branch main
 *
 * It is idempotent: unchanged files are reused by comparing blob SHAs, so re-running
 * only creates a new commit when something actually changed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = argOf('repo');
const BRANCH = argOf('branch', 'main');
const MESSAGE = argOf('message', 'chore: sync from working tree');
const ROOT = process.cwd();

if (!TOKEN || !REPO) {
  console.error('Usage: GITHUB_TOKEN=... node scripts/push-via-api.mjs --repo owner/name [--branch main] [--message "..."]');
  process.exit(1);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: `token ${TOKEN}`,
  'User-Agent': 'pixel-commons-publisher',
  Accept: 'application/vnd.github+json',
};

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-pages',
  '.wrangler',
  'test-results',
  'playwright-report',
  'coverage',
  'build-check',
]);
const IGNORED_FILES = new Set(['.dev.vars', 'secrets.production.txt']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split('\\').join('/');
    if (IGNORED_DIRS.has(entry) || IGNORED_FILES.has(entry)) continue;
    if (entry.endsWith('.log') || entry.endsWith('.sqlite') || entry.endsWith('.db')) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(rel);
  }
  return out;
}

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return body;
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

async function main() {
  const files = walk(ROOT);
  console.log(`publishing ${files.length} files to ${REPO}#${BRANCH}`);

  // Current head (may not exist yet on an empty repo).
  let parentSha = null;
  let baseTree = null;
  try {
    const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    const commit = await api(`/repos/${REPO}/git/commits/${parentSha}`);
    baseTree = commit.tree.sha;
    console.log(`existing head ${parentSha.slice(0, 8)}`);
  } catch {
    console.log('empty repository — creating the first commit');
  }

  // Reuse blob SHAs for unchanged files to keep the tree diff minimal.
  const previous = new Map();
  if (baseTree) {
    const tree = await api(`/repos/${REPO}/git/trees/${baseTree}?recursive=1`);
    for (const entry of tree.tree) if (entry.type === 'blob') previous.set(entry.path, entry.sha);
  }

  const entries = [];
  let created = 0;
  let reused = 0;

  for (const rel of files) {
    const buffer = readFileSync(join(ROOT, rel));
    // Git's own blob hash: sha1("blob <len>\0" + content)
    const hash = createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
    const known = previous.get(rel);
    if (known === hash) {
      entries.push({ path: rel, mode: '100644', type: 'blob', sha: known });
      reused++;
      continue;
    }
    const encoding = isBinary(buffer) ? 'base64' : 'utf-8';
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buffer.toString(encoding), encoding }),
    });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    created++;
  }

  // Files deleted from the working tree must disappear from the tree too.
  const removed = [...previous.keys()].filter((p) => !files.includes(p));

  console.log(`blobs: ${created} new, ${reused} unchanged, ${removed.length} removed`);
  if (created === 0 && removed.length === 0 && parentSha) {
    console.log('nothing changed — no commit created');
    return;
  }

  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: entries }),
  });

  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: MESSAGE,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    }),
  });

  if (parentSha) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } else {
    await api(`/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    });
  }

  console.log(`pushed commit ${commit.sha}`);
  console.log(`https://github.com/${REPO}/commit/${commit.sha}`);
}

main().catch((error) => {
  console.error('PUBLISH FAILED', error.message);
  process.exitCode = 1;
});
