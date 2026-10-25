/**
 * Publish the prebuilt static demo (`dist-pages/`) to the `gh-pages` branch.
 *
 * GitHub Pages is static hosting: it can serve the React build but cannot run the
 * Worker or Durable Object. The bundle is pre-built with VITE_API_BASE pointing at the
 * deployed API, so this script only uploads files.
 *
 *   GITHUB_TOKEN=... node scripts/publish-gh-pages.mjs --repo owner/name
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = argOf('repo');
const BRANCH = argOf('branch', 'gh-pages');
const DIR = argOf('dir', 'dist-pages');

if (!TOKEN || !REPO) {
  console.error('Usage: GITHUB_TOKEN=... node scripts/publish-gh-pages.mjs --repo owner/name [--branch gh-pages]');
  process.exit(1);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: `token ${TOKEN}`,
  'User-Agent': 'pixel-commons-publisher',
  Accept: 'application/vnd.github+json',
};

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split('\\').join('/'));
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
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

async function main() {
  const files = walk(DIR);
  console.log(`publishing ${files.length} files from ${DIR} to ${REPO}#${BRANCH}`);

  let parentSha = null;
  try {
    const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
  } catch {
    console.log('creating the gh-pages branch');
  }

  const entries = [];
  for (const rel of files) {
    const buffer = readFileSync(join(DIR, rel));
    const isBinary = /\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(rel);
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buffer.toString(isBinary ? 'base64' : 'utf-8'), encoding: isBinary ? 'base64' : 'utf-8' }),
    });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: entries }),
  });

  const hash = createHash('sha1').update(JSON.stringify(entries.map((e) => e.sha))).digest('hex').slice(0, 8);
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `docs: publish static demo (${hash})`,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    }),
  });

  if (parentSha) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    await api(`/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    });
  }

  console.log(`published ${commit.sha}`);
  console.log(`https://github.com/${REPO}/tree/${BRANCH}`);
}

main().catch((error) => {
  console.error('PUBLISH FAILED', error.message);
  process.exitCode = 1;
});
