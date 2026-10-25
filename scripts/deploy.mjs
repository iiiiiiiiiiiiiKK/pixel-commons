/**
 * Deployment helper.
 *
 * Deploys the Worker (Durable Object + API) and, when asked, the Pages project
 * that serves the static front-end and proxies /api + /ws to the Worker.
 *
 *   node scripts/deploy.mjs            # worker only
 *   node scripts/deploy.mjs --pages    # worker + pages + functions
 *
 * Requires CLOUDFLARE_API_TOKEN (Workers Scripts:Edit, Pages:Edit,
 * Workers R2 Storage:Edit) and CLOUDFLARE_ACCOUNT_ID, or an authenticated
 * `wrangler login` session.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const withPages = args.includes('--pages');
const withBuild = !args.includes('--skip-build');

function run(command, commandArgs, label) {
  process.stdout.write(`\n▸ ${label}\n`);
  execFileSync(command, commandArgs, { stdio: 'inherit' });
}

if (!existsSync('node_modules')) {
  console.error('Install dependencies first: npm install');
  process.exit(1);
}

if (withBuild) run('npm', ['run', 'build'], 'build front-end + typecheck');

run('npx', ['wrangler', 'deploy'], 'deploy Worker (Durable Object + API)');

if (withPages) {
  run(
    'npx',
    ['wrangler', 'pages', 'deploy', 'dist', '--project-name', 'pixel-commons', '--branch', 'main', '--commit-dirty=true'],
    'deploy Pages project (static site + functions proxy)',
  );
}

console.log('\nDone.');
console.log('  Worker : https://pixel-commons.<your-subdomain>.workers.dev');
console.log('  Pages  : https://pixel-commons.pages.dev');
console.log('\nRemember the two production secrets:');
console.log('  wrangler secret put SESSION_SECRET   # signs anonymous session cookies');
console.log('  wrangler secret put ADMIN_TOKEN      # enables the admin console');
