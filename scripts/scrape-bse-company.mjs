// BSE company data scraper — node scripts/scrape-bse-company.mjs <6-digit-scripCode> <slug>
import { mkdir, writeFile } from 'node:fs/promises';

const [, , scripArg, slugArg] = process.argv;

if (!scripArg || !slugArg) {
  console.error('Usage: node scripts/scrape-bse-company.mjs <6-digit-scripCode> <slug>');
  process.exit(1);
}
if (!/^\d{6}$/.test(scripArg)) {
  console.error(`Invalid scripCode "${scripArg}" — expected exactly 6 digits.`);
  process.exit(1);
}
if (!/^[a-z0-9-]+$/i.test(slugArg)) {
  console.error(`Invalid slug "${slugArg}" — use letters, digits and hyphens only.`);
  process.exit(1);
}

const scrip = scripArg;
const slug = slugArg.toLowerCase();

// 90-day rolling window, formatted YYYYMMDD
const ymd = (d) =>
  `${d.getUTCFullYear()}` +
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
  `${String(d.getUTCDate()).padStart(2, '0')}`;

const now = new Date();
const past = new Date(now);
past.setUTCDate(past.getUTCDate() - 90);
const from = ymd(past);
const to = ymd(now);

const API = 'https://api.bseindia.com/BseIndiaAPI/api';
const PDF_BASE = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive';

const endpoints = {
  announcements: {
    tag: 'confirmed',
    url: `${API}/AnnGetData/w?pageno=1&strCat=-1&strPrevDate=${from}&strScrip=${scrip}&strSearch=P&strToDate=${to}&strType=C`,
  },
  corpActions: {
    tag: 'confirmed',
    url: `${API}/DefaultData/w?Fdate=${from}&TDate=${to}&Purposecode=&ddlcategorys=E&ddlindustrys=&scripcode=${scrip}&segment=0&strSearch=S`,
  },
  boardMeetings: {
    tag: 'confirmed',
    url: `${API}/Corpforthresults/w?fromdate=${from}&todate=${to}&scripcode=${scrip}`,
  },
  annualReports: {
    tag: 'confirmed',
    url: `${API}/AnnualReport/w?scripcode=${scrip}`,
  },
};

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// BSE blocks plain clients; send browser headers and retry HTTP 403/429 with backoff.
async function fetchJson(url) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if ((res.status === 403 || res.status === 429) && attempt < MAX_ATTEMPTS) {
      await sleep(2000 * 2 ** (attempt - 1)); // 2s, 4s, 8s
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      throw new Error('non-JSON response (HTML / <!DOCTYPE>) — wrong endpoint path');
    }
    return JSON.parse(text);
  }
  throw new Error('retries exhausted');
}

// BSE endpoints return either a bare array or an object wrapping a Table array.
function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.Table)) return payload.Table;
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

const output = {
  scripCode: scrip,
  slug,
  scrapedAt: now.toISOString(),
  window: { from, to },
  categories: {},
};

// pass 1: URL-backed categories
for (const [name, { url, tag }] of Object.entries(endpoints)) {
  try {
    let rows = extractRows(await fetchJson(url));
    if (name === 'announcements') {
      rows = rows.map((row) =>
        row && row.ATTACHMENTNAME
          ? { ...row, PDF_URL: `${PDF_BASE}/${row.ATTACHMENTNAME}` }
          : row,
      );
    }
    output.categories[name] = { ok: true, url, count: rows.length, tag, error: null, rows };
    console.log(`[${name}] ok — ${rows.length} rows (${tag})`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    output.categories[name] = { ok: false, url, count: 0, tag, error: message, rows: [] };
    console.error(`[${name}] failed — ${message}`);
  }
}

// pass 2: derived categories
const announcements = output.categories.announcements;
if (announcements.ok) {
  const rows = announcements.rows.filter((row) =>
    /result/i.test(String((row && row.CATEGORYNAME) || '')),
  );
  output.categories.results = {
    ok: true,
    url: null,
    count: rows.length,
    tag: 'derived',
    error: null,
    rows,
  };
  console.log(`[results] ok — ${rows.length} rows (derived)`);
} else {
  output.categories.results = {
    ok: false,
    url: null,
    count: 0,
    tag: 'derived',
    error: 'announcements unavailable',
    rows: [],
  };
  console.error('[results] failed — announcements unavailable');
}

await mkdir('data', { recursive: true });
const outPath = `data/bse-${slug}.json`;
await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outPath}`);

process.exit(0);
