// Registry-driven BSE scrape — runs scrape-bse-company.mjs for every company in data/registry.json
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const REGISTRY = 'data/registry.json';
const SCRIPT = 'scripts/scrape-bse-company.mjs';

const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
const companies = Array.isArray(registry.companies) ? registry.companies : [];

if (companies.length === 0) {
  console.error(`No companies listed in ${REGISTRY}.`);
  process.exit(1);
}

function scrape(company) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, company.bseScripCode, company.slug], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`spawn failed for ${company.slug}: ${err.message}`);
      resolve(1);
    });
  });
}

let nonZero = 0;
for (const company of companies) {
  console.log(`\n=== ${company.name} — ${company.bseScripCode} / ${company.slug} ===`);
  const code = await scrape(company);
  if (code !== 0) nonZero++;
}

console.log(`\nScraped ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} — ${nonZero} non-zero exit(s).`);
process.exit(0);
