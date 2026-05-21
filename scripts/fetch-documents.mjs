// Document pipeline — download filing PDFs from the scraped BSE feed and extract their text.
// node scripts/fetch-documents.mjs   (processes every company in data/registry.json)
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const REGISTRY = 'data/registry.json';
const MAX_ANNOUNCEMENTS = 100;
const MAX_ANNUAL_REPORTS = 6;
const MAX_PDF_BYTES = 120 * 1024 * 1024;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: '*/*',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same browser-header + 403/429 backoff approach as the scraper.
async function fetchWithRetry(url) {
  const MAX_ATTEMPTS = 4;
  let res;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, { headers: HEADERS });
    if ((res.status === 403 || res.status === 429) && attempt < MAX_ATTEMPTS) {
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    return res;
  }
  return res;
}

// BSE serves recent filings from AttachLive and archives older ones to AttachHis.
function attachmentUrls(attachmentName) {
  const name = String(attachmentName || '').replace(/^[\\/]+/, '').trim();
  if (!name) return [];
  return [
    `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${name}`,
    `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${name}`,
  ];
}

// Annual-report file names come in two shapes; build candidate download URLs for each.
function annualReportUrls(scrip, fileName) {
  const clean = String(fileName || '').replace(/^[\\/]+/, '').trim();
  if (!clean) return [];
  if (/^[0-9]+\.pdf$/i.test(clean) && scrip) {
    return [`https://www.bseindia.com/bseplus/AnnualReport/${scrip}/${clean}`];
  }
  return attachmentUrls(`${clean.replace(/(\.pdf)+$/i, '')}.pdf`);
}

function announcementDocs(scrapeData) {
  const rows = scrapeData?.categories?.announcements?.rows ?? [];
  return rows
    .filter((r) => r && r.NEWSID && r.ATTACHMENTNAME)
    .slice(0, MAX_ANNOUNCEMENTS)
    .map((r) => ({
      id: `ann-${r.NEWSID}`,
      type: 'announcement',
      title: r.HEADLINE || r.NEWSSUB || 'Announcement',
      date: r.NEWS_DT || r.DT_TM || null,
      category: r.CATEGORYNAME || null,
      urlConfidence: 'confirmed',
      candidateUrls: attachmentUrls(r.ATTACHMENTNAME),
    }));
}

function annualReportDocs(scrapeData) {
  const rows = scrapeData?.categories?.annualReports?.rows ?? [];
  const scrip = scrapeData?.scripCode;
  return rows
    .filter((r) => r && r.year && r.file_name)
    .slice(0, MAX_ANNUAL_REPORTS)
    .map((r) => ({
      id: `ar-${r.year}`,
      type: 'annual-report',
      title: `Annual Report ${r.year}`,
      date: r.dt_tm || null,
      category: null,
      urlConfidence: 'constructed',
      candidateUrls: annualReportUrls(scrip, r.file_name),
    }));
}

async function extractText(pdfPath) {
  const { stdout } = await execFileP(
    'pdftotext',
    ['-enc', 'UTF-8', '-nopgbrk', pdfPath, '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

async function processDoc(doc, textDir) {
  const textFile = `${doc.id}.txt`;
  const textPath = join(textDir, textFile);
  const base = {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    date: doc.date,
    category: doc.category,
    urlConfidence: doc.urlConfidence,
    candidateUrls: doc.candidateUrls,
    textFile,
  };

  // incremental: a filing's text never changes once published, so skip what we already have
  try {
    const st = await stat(textPath);
    if (st.size > 0) return { ...base, status: 'cached', textChars: st.size };
  } catch {
    // not extracted yet
  }

  if (doc.candidateUrls.length === 0) {
    return { ...base, status: 'failed', error: 'no download URL could be constructed' };
  }

  let lastError = null;
  for (const url of doc.candidateUrls) {
    const tmpPdf = join(tmpdir(), `${doc.id.replace(/[^a-z0-9-]/gi, '_')}-${Date.now()}.pdf`);
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        lastError = 'response was not a PDF';
        continue;
      }
      if (buf.length > MAX_PDF_BYTES) {
        lastError = `PDF too large (${buf.length} bytes)`;
        continue;
      }
      await writeFile(tmpPdf, buf);
      const text = await extractText(tmpPdf);
      await rm(tmpPdf, { force: true });
      await writeFile(textPath, text);
      return {
        ...base,
        status: 'ok',
        resolvedUrl: url,
        pdfBytes: buf.length,
        textChars: text.length,
      };
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      await rm(tmpPdf, { force: true }).catch(() => {});
    }
  }
  return { ...base, status: 'failed', error: lastError || 'download failed' };
}

async function processCompany(company) {
  const scrapePath = `data/bse-${company.slug}.json`;
  let scrapeData;
  try {
    scrapeData = JSON.parse(await readFile(scrapePath, 'utf8'));
  } catch {
    console.error(`[${company.slug}] no scrape file at ${scrapePath} — run the scraper first; skipping.`);
    return;
  }

  const textDir = `data/text/${company.slug}`;
  await mkdir(textDir, { recursive: true });

  const docs = [...annualReportDocs(scrapeData), ...announcementDocs(scrapeData)];
  console.log(`[${company.slug}] ${docs.length} document(s) to process`);

  const manifest = { slug: company.slug, updatedAt: new Date().toISOString(), documents: [] };
  let ok = 0;
  let cached = 0;
  let failed = 0;
  for (const doc of docs) {
    const entry = await processDoc(doc, textDir);
    manifest.documents.push(entry);
    if (entry.status === 'ok') ok++;
    else if (entry.status === 'cached') cached++;
    else failed++;
    console.log(`  [${doc.id}] ${entry.status}${entry.error ? ` — ${entry.error}` : ''}`);
  }

  await writeFile(join(textDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[${company.slug}] ${ok} extracted, ${cached} cached, ${failed} failed`);
}

const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
const companies = Array.isArray(registry.companies) ? registry.companies : [];
if (companies.length === 0) {
  console.error(`No companies listed in ${REGISTRY}.`);
  process.exit(1);
}

for (const company of companies) {
  console.log(`\n=== ${company.name} — ${company.slug} ===`);
  try {
    await processCompany(company);
  } catch (err) {
    console.error(`[${company.slug}] failed — ${err && err.message ? err.message : err}`);
  }
}

process.exit(0);
