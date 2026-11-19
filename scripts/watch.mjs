// Watches GoHighLevel for changes and starts the dashboard refresh when something changes.
// Runs inside a long GitHub Actions job (public repo, so minutes are free), because
// GitHub's own cron schedule often skips runs for hours.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const PIT = process.env.GHL_PIT, L = process.env.GHL_LOCATION_ID;
const GH = process.env.GH_TOKEN, REPO = process.env.REPO;
const MINUTES = Number(process.env.WATCH_MINUTES || 340);   // stay under the 6h job limit
const EVERY_S = 60;                                          // how often to look at GHL
const SAFETY_MIN = 15;                                       // full refresh at least this often
const NOTE_CONTACTS = 25;                                    // check notes on the most recently updated leads
if (!PIT || !L || !GH || !REPO) { console.error('Missing GHL_PIT, GHL_LOCATION_ID, GH_TOKEN or REPO'); process.exit(1); }

const BASE = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ghl(path, { body, version = '2021-07-28' } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${PIT}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 wykes-leads-watcher' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`${path} kept failing`);
}

async function fingerprint() {
  const parts = [];
  const s = await ghl('/contacts/search', { body: { locationId: L, pageLimit: 100, sort: [{ field: 'dateUpdated', direction: 'desc' }] } });
  const contacts = s.contacts || [];
  parts.push('c', s.total, ...contacts.map((c) => `${c.id}:${c.dateUpdated}:${(c.tags || []).join(',')}`));
  const o = await ghl(`/opportunities/search?location_id=${L}&limit=100`);
  parts.push('o', o.meta?.total, ...(o.opportunities || []).map((x) => `${x.id}:${x.updatedAt}:${x.status}:${x.pipelineStageId}:${x.monetaryValue}`));
  const cv = await ghl(`/conversations/search?locationId=${L}&limit=20&sortBy=last_message_date&sort=desc`, { version: '2021-04-15' });
  parts.push('m', ...(cv.conversations || []).map((x) => `${x.id}:${x.lastMessageDate}:${x.unreadCount}`));
  for (const c of contacts.slice(0, NOTE_CONTACTS)) {
    const n = await ghl(`/contacts/${c.id}/notes`);
    const notes = n.notes || [];
    parts.push(`n${c.id}`, notes.length, ...notes.map((x) => `${x.id}:${(x.body || '').length}`));
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

async function startRefresh(why) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/refresh.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wykes-leads-watcher' },
    body: JSON.stringify({ ref: 'main' }),
  });
  console.log(new Date().toISOString(), `refresh requested (${why}) -> ${r.status}`);
  return r.status === 204;
}

const started = Date.now();
let last = null, lastRefresh = Date.now(), failures = 0;
while (Date.now() - started < MINUTES * 60_000) {
  try {
    const fp = await fingerprint();
    failures = 0;
    if (last && fp !== last) { if (await startRefresh('change in GHL')) lastRefresh = Date.now(); }
    else if (Date.now() - lastRefresh > SAFETY_MIN * 60_000) { if (await startRefresh('safety refresh')) lastRefresh = Date.now(); }
    last = fp;
  } catch (e) {
    failures++;
    console.log(new Date().toISOString(), 'check failed:', e.message);
    if (failures >= 20) { console.error('Too many failures in a row, stopping'); process.exit(1); }
  }
  await sleep(EVERY_S * 1000);
}
// Only a watcher that ran its full time hands over to the next one (stops a fast fail loop).
await writeFile('.watch-ok', String(Date.now()));
console.log('watch window finished');
