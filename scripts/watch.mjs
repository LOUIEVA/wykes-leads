// Watches GoHighLevel for changes and starts the dashboard refresh when something changes.
// Runs inside a long GitHub Actions job (public repo, so minutes are free), because
// GitHub's own cron schedule often skips runs for hours.
//
// API budget: the sub-account key allows 10,000 GoHighLevel calls a day, shared with the
// refresh job. This watcher uses 3 calls a minute, plus 2 note checks every third minute (about 5,300 a day),
// and slows to every 15 minutes once fewer than 2,500 calls are left. Refreshes start at most every 90 seconds.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const PIT = process.env.GHL_PIT, L = process.env.GHL_LOCATION_ID;
const GH = process.env.GH_TOKEN, REPO = process.env.REPO;
const MINUTES = Number(process.env.WATCH_MINUTES || 340);   // stay under the 6h job limit
const EVERY_S = 60;                                          // how often to look at GHL
const NOTE_CONTACTS = 2;                                     // dashboard updates arrive as notes on these
const MIN_GAP_S = 90;                                        // never start refreshes closer than this
const NOTE_EVERY = 3;                                        // check dashboard notes every 3rd round
let round = 0, lastNotes = '';
if (!PIT || !L || !GH || !REPO) { console.error('Missing GHL_PIT, GHL_LOCATION_ID, GH_TOKEN or REPO'); process.exit(1); }

const BASE = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class DailyCap extends Error { constructor(ms) { super('daily API limit reached'); this.resetMs = ms; } }
let dailyLeft = Infinity;                                    // calls GHL says are left today
const LOW = 2500, SLOW_EVERY_S = 900;                        // under 2,500 left: look every 15 min instead
async function ghl(path, { body, version = '2021-07-28' } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${PIT}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 wykes-leads-watcher' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const left = r.headers.get('x-ratelimit-daily-remaining');
    if (left !== null && left !== '') dailyLeft = Number(left);
    if (r.status === 429 && r.headers.get('x-ratelimit-daily-remaining') === '0') throw new DailyCap(Number(r.headers.get('x-ratelimit-daily-reset') || 0));
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`${path} kept failing`);
}

async function fingerprint() {
  const parts = [];
  const s = await ghl('/contacts/search', { body: { locationId: L, pageLimit: 20, sort: [{ field: 'dateUpdated', direction: 'desc' }] } });
  const contacts = s.contacts || [];
  parts.push('c', s.total, ...contacts.map((c) => `${c.id}:${c.dateUpdated}:${(c.tags || []).join(',')}`));
  const o = await ghl(`/opportunities/search?location_id=${L}&limit=20`);
  parts.push('o', o.meta?.total, ...(o.opportunities || []).map((x) => `${x.id}:${x.updatedAt}:${x.status}:${x.pipelineStageId}:${x.monetaryValue}`));
  const cv = await ghl(`/conversations/search?locationId=${L}&limit=20&sortBy=last_message_date&sort=desc`, { version: '2021-04-15' });
  parts.push('m', ...(cv.conversations || []).map((x) => `${x.id}:${x.lastMessageDate}:${x.unreadCount}`));
  if (round++ % NOTE_EVERY === 0) {
    const np = [];
    for (const c of contacts.slice(0, NOTE_CONTACTS)) {
      const n = await ghl(`/contacts/${c.id}/notes`);
      const notes = n.notes || [];
      np.push(`n${c.id}`, notes.length, ...notes.map((x) => `${x.id}:${(x.body || '').length}`));
    }
    lastNotes = np.join('|');
  }
  parts.push(lastNotes);
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
let last = null, lastRefresh = 0, failures = 0;
while (Date.now() - started < MINUTES * 60_000) {
  let wait = EVERY_S * 1000;
  try {
    const fp = await fingerprint();
    failures = 0;
    const gapOk = Date.now() - lastRefresh > MIN_GAP_S * 1000;
    if (last && fp !== last && gapOk) {
      if (await startRefresh('change in GHL')) lastRefresh = Date.now();
    }
    if (!last || gapOk) last = fp;   // a change inside the gap is picked up next round
    if (dailyLeft < LOW) {
      wait = SLOW_EVERY_S * 1000;
      console.log(new Date().toISOString(), `only ${dailyLeft} GHL calls left today, checking every ${SLOW_EVERY_S / 60} min`);
    }
  } catch (e) {
    if (e instanceof DailyCap) {
      const left = MINUTES * 60_000 - (Date.now() - started);
      wait = Math.min(Math.max(e.resetMs, 60_000) + 60_000, Math.max(left, 1000));
      console.log(new Date().toISOString(), `GoHighLevel daily API limit reached, pausing ${Math.round(wait / 60000)} min`);
    } else {
      failures++;
      console.log(new Date().toISOString(), 'check failed:', e.message);
      if (failures >= 20) { console.error('Too many failures in a row, stopping'); process.exit(1); }
    }
  }
  await sleep(wait);
}
// Only a watcher that ran its full time hands over to the next one (stops a fast fail loop).
await writeFile('.watch-ok', String(Date.now()));
console.log('watch window finished');
