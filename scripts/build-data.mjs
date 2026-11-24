// Pulls Wykes leads from GoHighLevel, summarises them and writes an encrypted data file for the dashboard.
// Secrets come from the environment (GitHub Actions secrets). Nothing sensitive is written in plain text.
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile, cp, readFile, appendFile } from 'node:fs/promises';

// Per-lead details are kept between runs (GitHub Actions cache) so a refresh only asks
// GoHighLevel about leads that changed. The sub-account API key allows 10,000 calls a day.
// The repo is public, so the cache is encrypted with a key derived from the GHL secret.
const PIT = process.env.GHL_PIT, L = process.env.GHL_LOCATION_ID, PASS = process.env.DASH_PASSCODE;
const CACHE_FILE = '.cache/details.json';
const cacheKey = PIT ? await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wykes-cache|' + L + '|' + PIT)), 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
let cache = {};
try {
  const box = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64') }, cacheKey, Buffer.from(box.ct, 'base64'));
  cache = JSON.parse(new TextDecoder().decode(plain));
} catch { cache = {}; }   // no cache, or made with an old key: fetch everything once
async function saveCache() {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cacheKey, new TextEncoder().encode(JSON.stringify(cache)));
    await mkdir('.cache', { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') }));
  } catch (e) { console.warn('cache save failed:', e.message); }
}

const PIPELINE_NAME = process.env.PIPELINE_NAME || 'Website Leads';
const OUT = process.env.OUT_DIR || 'dist';
if (!PIT || !L || !PASS) { console.error('Missing GHL_PIT, GHL_LOCATION_ID or DASH_PASSCODE'); process.exit(1); }

const API = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0, dailyLeft = Infinity, budgetChecked = false;
// Keep this many calls of the 10,000 a day in reserve: once fewer are left, refreshes stop
// until the daily reset so the cap is never hit (the watcher slows down at the same point).
const RESERVE = Number(process.env.API_RESERVE || 800);
async function stopForToday(resetMs, why) {
  const h = Math.round(Number(resetMs || 0) / 36e5 * 10) / 10;
  console.log(`${why} (resets in about ${h} h). Keeping the last published leads.`);
  await saveCache();
  // If the page itself changed (new commit), still publish it with the last published lead data.
  const pageOnly = await publishPageOnly().catch(e => { console.warn('page-only publish failed:', e.message); return false; });
  if (!pageOnly && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'skip=true\n');
  process.exit(0);
}
async function api(path, { method = 'GET', body, version = '2021-07-28' } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    calls++;
    const res = await fetch(API + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${PIT}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; WykesLeadsDashboard/1.0)' },
    });
    const left = res.headers.get('x-ratelimit-daily-remaining');
    if (left !== null && left !== '') dailyLeft = Number(left);
    if (res.status === 429 && left === '0') await stopForToday(res.headers.get('x-ratelimit-daily-reset'), 'GoHighLevel daily API limit reached');
    if (!budgetChecked && Number.isFinite(dailyLeft)) {
      budgetChecked = true;
      if (dailyLeft < RESERVE) await stopForToday(res.headers.get('x-ratelimit-daily-reset'), `Only ${dailyLeft} GoHighLevel API calls left today, saving them`);
    }
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error(`${path.split('?')[0]} kept failing`);
}

// Publish the current page with the lead data that is already live (used when the API cap is reached).
async function publishPageOnly() {
  const LIVE = process.env.LIVE_URL || 'https://louieva.github.io/wykes-leads/';
  const BUILD = (process.env.GITHUB_SHA || 'local').slice(0, 12);
  const res = await fetch(LIVE + 'data.enc.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('live data ' + res.status);
  const file = await res.json();
  if (file.build === BUILD) return false;   // page already live: nothing new to publish
  file.build = BUILD;
  await mkdir(OUT, { recursive: true });
  await cp('site', OUT, { recursive: true });
  await writeFile(`${OUT}/index.html`, (await readFile(`${OUT}/index.html`, 'utf8')).replace('__BUILD__', BUILD));
  await writeFile(`${OUT}/data.enc.json`, JSON.stringify(file));
  console.log('Published the updated page with the last published leads.');
  return true;
}

const DAY = 864e5, now = Date.now();
const ts = v => (v ? new Date(v).getTime() : 0);
const short = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 1. Field names and every pipeline
const fieldsRes = await api(`/locations/${L}/customFields?model=contact`);
const fieldKey = Object.fromEntries((fieldsRes.customFields || []).map(f => [f.id, (f.fieldKey || '').replace(/^contact\./, '')]));
const fieldName = Object.fromEntries((fieldsRes.customFields || []).map(f => [(f.fieldKey || '').replace(/^contact\./, ''), f.name || '']));
// Fields used for routing or shown elsewhere on the card; everything else the lead filled in is listed under "Their enquiry".
const HIDE_FIELDS = /^(owner_question_code|owner_answer|ballpark_(high|low)|utm_|fbclid|gclid|lead_page_url|town_or_eircode|service_requested|timeframe|job_size|job_message|job_details_message|ballpark_text|project_address|job_photo|owner_question)/;
// Facebook lead form answers land in fields matched by name (keys differ per field), so find them by name.
const keyByName = re => Object.keys(fieldName).find(k => re.test(fieldName[k])) || '';
const FB = {
  service: keyByName(/^service type$/i), length: keyByName(/fence length/i), timeframe: keyByName(/preferred time ?frame/i),
  owns: keyByName(/owns? the property/i), intent: keyByName(/100% set|where are you at/i), form: keyByName(/facebook form name/i),
};
const FB_USED = new Set(Object.values(FB).filter(Boolean));
const FB_META = /facebook (lead|form) id|lead submission details|^product type$|^page details$/i;
const fieldText = v => Array.isArray(v) ? v.map(fieldText).filter(Boolean).join(', ') : (v && typeof v === 'object') ? Object.values(v).map(fieldText).filter(Boolean).join(', ') : String(v ?? '').trim();
const photoUrls = v => { const out = []; const walk = x => { if (!x) return; if (typeof x === 'string') { (x.match(/https?:\/\/[^\s,"']+/g) || []).forEach(u => out.push(u)); } else if (Array.isArray(x)) x.forEach(walk); else if (typeof x === 'object') Object.entries(x).forEach(([k, y]) => { if (/^https?:/.test(k)) out.push(k); walk(y); }); }; walk(v); return [...new Set(out)].slice(0, 8); };
const { pipelines = [] } = await api(`/opportunities/pipelines?locationId=${L}`);
const stageInfo = {};
pipelines.forEach(p => p.stages.forEach((s, i) => { stageInfo[s.id] = { pipeline: p.name, pipelineId: p.id, stage: s.name, order: i }; }));
const mainPipe = pipelines.find(p => p.name.trim().toLowerCase() === PIPELINE_NAME.toLowerCase()) || pipelines[0];

// 2. Every contact in the sub-account (these are the leads)
let contacts = [];
for (let page = 1; page <= 20; page++) {
  const r = await api('/contacts/search', { method: 'POST', body: { locationId: L, pageLimit: 100, page, sort: [{ field: 'dateAdded', direction: 'desc' }] } });
  contacts.push(...(r.contacts || []));
  if ((r.contacts || []).length < 100) break;
}
// Not leads: the owner, internal/test contacts, and suppliers / job seekers / sales pitches the AI tagged not-a-lead
const internal = c => (c.tags || []).some(t => /^(owner|internal|test|not-a-lead)$/i.test(t)) || /internal|not a lead/i.test(c.source || '');
contacts = contacts.filter(c => !internal(c));
// Fresh start (21 Nov 2026): the dashboard only shows leads created from FRESH_START on,
// plus older contacts that come back (GHL tags anyone who replies "reactivated") or send a new enquiry.
// Nothing is deleted in GHL; tag an old contact "show-on-dashboard" to bring it back by hand.
const FRESH_START = ts(process.env.FRESH_START || '2026-11-21T08:10:00Z');
const BACK_TAGS = ['reactivated', 'show-on-dashboard'];

// 3. Every opportunity in every pipeline, latest one per contact
let opps = [];
for (let page = 1; page <= 20; page++) {
  const r = await api(`/opportunities/search?location_id=${L}&limit=100&page=${page}`);
  opps.push(...(r.opportunities || []));
  if ((r.opportunities || []).length < 100) break;
}
const oppByContact = {};
opps.sort((a, b) => ts(b.updatedAt || b.createdAt) - ts(a.updatedAt || a.createdAt))
  .forEach(o => { const cid = o.contactId || (o.contact && o.contact.id); if (cid && !oppByContact[cid]) oppByContact[cid] = o; });

// An older contact who sends a new enquiry (for example a Facebook lead form) gets a new
// opportunity but keeps their old "date added". Count them from the new enquiry instead.
const newOppAt = {};
opps.forEach(o => { const cid = o.contactId || (o.contact && o.contact.id); const t = ts(o.createdAt); if (cid && t >= FRESH_START && t > (newOppAt[cid] || 0)) newOppAt[cid] = t; });
contacts.forEach(c => { if (ts(c.dateAdded) < FRESH_START && newOppAt[c.id]) { c.firstAdded = c.dateAdded; c.dateAdded = new Date(newOppAt[c.id]).toISOString(); } });
contacts = contacts.filter(c => ts(c.dateAdded) >= FRESH_START || (c.tags || []).some(t => BACK_TAGS.includes(String(t).toLowerCase())));
contacts.sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded));

// 3b. Apply updates sent from the dashboard. They arrive as notes starting with "[Dashboard]"
// (written by the GHL inbound-webhook workflow). Each is applied once, then rewritten with a tick.
const DETAIL_LIMIT = 80;
const stripHtml = h => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const notesByContact = {};
const ACTIONS = {
  called:        { tag: 'called' },
  no_answer:     { tag: 'no-answer' },
  qualified:     { tag: 'qualified-lead', stage: /sent to owner/i, status: 'open' },
  not_qualified: { tag: 'not-qualified', stage: /^lost$/i, status: 'lost' },
  visit_booked:  { tag: 'site-visit-booked', stage: /site visit/i, status: 'open' },
  quote_sent:    { tag: 'quote-sent', stage: /quote/i, status: 'open' },
  won:           { tag: 'won', stage: /^won$/i, status: 'won' },
  lost:          { tag: 'lost', stage: /^lost$/i, status: 'lost' },
  shopping:      { tag: 'shopping-around', stage: /nurture/i, status: 'open' },
  delete:        { del: true },   // the owner pressed Delete on the dashboard: remove the contact and its deal
  note:          {},
};
const deleted = new Set();
let applied = 0, notesFetched = 0;
// Notes are re-read only for leads that changed, plus the few most recently updated ones
// (dashboard updates arrive as notes and may not change the contact's update time).
const recentlyUpdated = new Set(contacts.slice().sort((a, b) => ts(b.dateUpdated) - ts(a.dateUpdated)).slice(0, 4).map(c => c.id));
for (const c of contacts.slice(0, DETAIL_LIMIT)) {
  const cc = cache[c.id] || (cache[c.id] = {});
  let notes = cc.notes || [];
  if (!cc.notes || cc.nStamp !== c.dateUpdated || recentlyUpdated.has(c.id)) {
    try { notes = (await api(`/contacts/${c.id}/notes`)).notes || []; cc.notes = notes; cc.nStamp = c.dateUpdated; notesFetched++; }
    catch (e) { console.warn('notes', e.message); }
  }
  notesByContact[c.id] = notes;
  const pending = notes.filter(n => /^\s*\[Dashboard\]/.test(stripHtml(n.body))).sort((a, b) => ts(a.dateAdded) - ts(b.dateAdded));
  for (const n of pending) {
    const body = stripHtml(n.body);
    const key = (body.match(/#s=([a-z_]+)/) || [])[1] || 'note';
    const remind = (body.match(/;r=([0-9T:.\-Z+]+)/) || [])[1];
    const visit = (body.match(/;v=([0-9T:.\-Z+]+)/) || [])[1];
    const act = ACTIONS[key] || ACTIONS.note;
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || 'lead';
    try {
      if (act.del) {
        await api(`/contacts/${c.id}`, { method: 'DELETE' });
        deleted.add(c.id); delete cache[c.id]; applied++;
        console.log('Deleted a lead from the dashboard');
        break;
      }
      if (act.tag) await api(`/contacts/${c.id}/tags`, { method: 'POST', body: { tags: [act.tag] } });
      // Any update from the dashboard means the owner has acted: stop the "owner has not answered" chase (WF6).
      if ((c.tags || []).includes('waiting-owner')) {
        await api(`/contacts/${c.id}/tags`, { method: 'DELETE', body: { tags: ['waiting-owner'] } });
        await api(`/contacts/${c.id}/tags`, { method: 'POST', body: { tags: ['owner-answered'] } });
        c.tags = c.tags.filter(t => t !== 'waiting-owner');
      }
      if (act.stage && mainPipe) {
        const stage = mainPipe.stages.find(s => act.stage.test(s.name));
        if (stage) {
          const o = oppByContact[c.id];
          if (o) {
            await api(`/opportunities/${o.id}`, { method: 'PUT', body: { pipelineId: mainPipe.id, pipelineStageId: stage.id, status: act.status } });
            Object.assign(o, { pipelineId: mainPipe.id, pipelineStageId: stage.id, status: act.status, updatedAt: new Date().toISOString(), lastStatusChangeAt: new Date().toISOString() });
          } else {
            const r = await api('/opportunities/', { method: 'POST', body: { locationId: L, pipelineId: mainPipe.id, pipelineStageId: stage.id, status: act.status, contactId: c.id, name: `${name} - ${mainPipe.name}` } });
            const no = r.opportunity || r; no.contactId = c.id; no.updatedAt = no.createdAt = new Date().toISOString(); oppByContact[c.id] = no; opps.push(no);
          }
        }
      }
      if (remind && !isNaN(Date.parse(remind))) {
        const title = `Call back ${name}`;
        const existing = ((await api(`/contacts/${c.id}/tasks`)).tasks || []).some(t => t.title === title && Math.abs(ts(t.dueDate) - Date.parse(remind)) < 6e4);
        if (!existing) await api(`/contacts/${c.id}/tasks`, { method: 'POST', body: { title, body: short(body.replace(/\s*\|?\s*#s=.*$/, '').replace(/^\[Dashboard\]\s*/, ''), 300), dueDate: new Date(remind).toISOString(), completed: false } });
      }
      if (visit && !isNaN(Date.parse(visit))) {
        const town = ((c.customFields || []).find(cf => fieldKey[cf.id] === 'town_or_eircode') || {}).value || c.city || '';
        const title = `Site visit: ${name}${town ? ', ' + town : ''}`;
        const existing = ((await api(`/contacts/${c.id}/tasks`)).tasks || []).some(t => /^site visit/i.test(t.title) && Math.abs(ts(t.dueDate) - Date.parse(visit)) < 6e4);
        if (!existing) await api(`/contacts/${c.id}/tasks`, { method: 'POST', body: { title, body: short(body.replace(/\s*\|?\s*#s=.*$/, '').replace(/^\[Dashboard\]\s*/, ''), 300), dueDate: new Date(visit).toISOString(), completed: false } });
      }
      const clean = '✓ ' + body.replace(/^\[Dashboard\]\s*/, '').replace(/\s*\|?\s*#s=.*$/, '') + ' (from the leads dashboard)';
      await api(`/contacts/${c.id}/notes/${n.id}`, { method: 'PUT', body: { body: clean } });
      n.body = clean; applied++;
    } catch (e) { console.warn('apply update failed:', e.message); }
  }
}
if (applied) console.log(`Applied ${applied} dashboard update(s) to the CRM`);

// 4. Conversations (latest per contact)
const convByContact = {};
for (let page = 0, startAfter = ''; page < 5; page++) {
  const r = await api(`/conversations/search?locationId=${L}&limit=100&sort=desc&sortBy=last_message_date${startAfter}`, { version: '2021-04-15' });
  const list = r.conversations || [];
  for (const c of list) if (c.contactId && !convByContact[c.contactId]) convByContact[c.contactId] = c;
  if (list.length < 100) break;
  const last = list[list.length - 1]; startAfter = `&startAfterDate=${encodeURIComponent(last.lastMessageDate || last.dateUpdated || '')}`;
}
const isRealMsg = t => t && !/ACTIVITY|NO_SHOW|CUSTOM_PROVIDER/i.test(String(t));

// Where a lead is, in plain words
function bucketOf(o) {
  if (!o) return 'new';
  const st = (stageInfo[o.pipelineStageId] || {}).stage || '';
  if (o.status === 'won' || /^won$|closed won/i.test(st)) return 'won';
  if (o.status === 'lost' || o.status === 'abandoned' || /lost/i.test(st)) return 'lost';
  if (/sent to owner/i.test(st)) return 'owner';
  if (/site visit|appointment|booked/i.test(st)) return 'booked';
  if (/quote|proposal|negotiat/i.test(st)) return 'quote';
  if (/nurture/i.test(st)) return 'nurture';
  return 'new';
}

// 5. Build each lead
const leads = [];
let staleBudget = 2, detailsFetched = 0, svcTagBudget = 10, svcTagsAdded = 0;   // also re-check up to 2 unchanged leads a run whose details are over 6 h old
for (const [i, c] of contacts.entries()) {
  if (deleted.has(c.id)) continue;
  const o = oppByContact[c.id], conv = convByContact[c.id], si = o ? stageInfo[o.pipelineStageId] || {} : {};
  let f = Object.fromEntries((c.customFields || []).map(cf => [fieldKey[cf.id] || cf.id, cf.value ?? cf.fieldValue]));
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || c.companyName || c.email || c.phone || 'Unnamed lead';
  const lead = {
    contactId: c.id, name, phone: c.phone || '', email: c.email || '',
    createdAt: c.dateAdded, updatedAt: (o && o.updatedAt) || c.dateUpdated || c.dateAdded,
    pipeline: si.pipeline || '', stage: si.stage || '', status: o ? o.status : '', value: o ? Number(o.monetaryValue) || 0 : 0,
    bucket: bucketOf(o), oppAt: o ? o.lastStatusChangeAt || o.updatedAt : null,
    tags: (c.tags || []).slice(0, 6),
    needsReply: !!(conv && conv.lastMessageDirection === 'inbound' && isRealMsg(conv.lastMessageType)),
    unread: conv ? Number(conv.unreadCount) || 0 : 0,
    lastMessage: conv && conv.lastMessageDate && isRealMsg(conv.lastMessageType) ? { dir: conv.lastMessageDirection, at: conv.lastMessageDate, type: String(conv.lastMessageType || '').replace('TYPE_', '').toLowerCase(), text: short(conv.lastMessageBody, 110) } : null,
    replied: false,
  };
  const cc = cache[c.id] || (cache[c.id] = {});
  const stamp = `${c.dateUpdated || ''}|${conv ? conv.lastMessageDate || '' : ''}|${o ? o.updatedAt || '' : ''}`;
  const need = i < DETAIL_LIMIT && (cc.dStamp !== stamp || (now - (cc.dAt || 0) > 6 * 36e5 && staleBudget-- > 0));
  if (need) detailsFetched++;
  if (i < DETAIL_LIMIT && !Object.keys(f).length) {
    if (need || !cc.fields) {
      try { const { contact = {} } = await api(`/contacts/${c.id}`); f = Object.fromEntries((contact.customFields || []).map(cf => [fieldKey[cf.id] || cf.id, cf.value ?? cf.fieldValue])); cc.fields = f; } catch (e) { console.warn('contact', e.message); }
    } else f = cc.fields;
  }
  // Facebook lead form answers (fence type, length, timing, owner, how ready they are) and the ad they came from.
  const pick = k => (k ? fieldText(f[k]) : '');
  const at = c.attributionSource || {};
  const adCampaign = [at.utmCampaign || at.campaign, at.utmContent || at.adName].filter(Boolean).join(' / ');
  const fbForm = pick(FB.form) || (/facebook/i.test(c.source || at.utmSource || '') && /lead form/i.test(adCampaign) ? adCampaign : '');
  const topic = /grass/i.test(fbForm) ? 'Artificial grass' : /fenc/i.test(fbForm) ? 'Fencing' : '';
  const fbType = pick(FB.service);
  Object.assign(lead, {
    town: short(f.town_or_eircode || [c.city, c.postalCode].filter(Boolean).join(' ') || '', 40),
    service: short((s => (s ? (topic === 'Fencing' && !/fenc|gate/i.test(s) ? `${s} fence` : s) : topic))(fieldText(f.service_requested) || fbType), 40),
    timeframe: short(f.timeframe || pick(FB.timeframe), 30),
    size: short(f.job_size || pick(FB.length), 40), message: short(f.job_message, 160), ballpark: short(f.ballpark_text, 60),
    owns: short(pick(FB.owns), 20), intent: short(pick(FB.intent), 80),
    source: short(c.source || at.sessionSource || at.medium || f.utm_source || '', 30),
  });
  // The full enquiry: job address, everything they wrote, every answered field, photos and where they came from.
  const street = [c.address1, c.city, c.postalCode].filter(Boolean).join(', ');
  const addr = f.project_address ? [f.project_address, ...[c.city, c.postalCode].filter(x => x && !String(f.project_address).toLowerCase().includes(String(x).toLowerCase()))] : [];
  Object.assign(lead, {
    address: short(f.project_address ? addr.join(', ') : street, 160),
    message: short(f.job_message || f.job_details_message || '', 1200),
    ownerQuestion: short(f.owner_question, 300),
    photos: photoUrls([f.job_photos, f.job_photo_uploads]),
    campaign: short([f.utm_campaign, f.utm_content, f.utm_term].filter(Boolean).join(' / ') || adCampaign, 120),
    page: short(f.lead_page_url || at.url || '', 160),
    answers: Object.entries(f).filter(([k, v]) => fieldName[k] && !HIDE_FIELDS.test(k) && !FB_USED.has(k) && !FB_META.test(fieldName[k]) && fieldText(v)).slice(0, 25).map(([k, v]) => [short(fieldName[k], 60), short(fieldText(v), 400)]),
  });
  if (fbForm) lead.fbForm = topic ? `${topic} lead form` : 'Facebook lead form';
  if (i < DETAIL_LIMIT) {
    const strip = h => String(h || '').replace(/<br\s*\/?>(?!$)/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    const nList = notesByContact[c.id] || [];
    lead.notes = nList.slice().sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded)).slice(0, 4).map(x => ({ text: short(strip(x.body).replace(/\s*\|?\s*#s=.*$/, ''), 300), at: x.dateAdded }));
    lead.noteCount = nList.length;
    if (!need && cc.tasks) {
      lead.tasks = cc.tasks; lead.visitTasks = (cc.visitTasks || []).filter(x => ts(x.start) >= now - 12 * 36e5); lead.appointments = (cc.appointments || []).filter(x => ts(x.start) >= now - DAY);
    } else {
    try {
      const t = await api(`/contacts/${c.id}/tasks`);
      const open = (t.tasks || []).filter(x => !x.completed).sort((a, b) => ts(a.dueDate) - ts(b.dueDate));
      lead.tasks = open.filter(x => !/^site visit/i.test(x.title)).slice(0, 5).map(x => ({ title: short(x.title, 120), body: short(strip(x.body), 160), due: x.dueDate }));
      lead.visitTasks = open.filter(x => /^site visit/i.test(x.title) && ts(x.dueDate) >= now - 12 * 36e5).slice(0, 3).map(x => ({ title: 'Site visit', start: x.dueDate, status: 'booked', note: short(strip(x.body), 160) }));
    } catch (e) { lead.tasks = []; lead.visitTasks = []; }
    try {
      const a = await api(`/contacts/${c.id}/appointments`);
      lead.appointments = (a.events || []).filter(x => ts(x.endTime || x.startTime) >= now - DAY && !/cancel/i.test(x.appointmentStatus || '')).sort((a2, b2) => ts(a2.startTime) - ts(b2.startTime)).slice(0, 3).map(x => ({ title: short(x.title, 80), start: x.startTime, status: x.appointmentStatus || '' }));
    } catch (e) { lead.appointments = []; }
    cc.tasks = lead.tasks; cc.visitTasks = lead.visitTasks; cc.appointments = lead.appointments;
    }
    lead.appointments = (lead.appointments || []).concat(lead.visitTasks || []).sort((a2, b2) => ts(a2.start) - ts(b2.start)).slice(0, 3);
    delete lead.visitTasks;
  }
  if (i < DETAIL_LIMIT && conv) {
    if (!need && cc.replied !== undefined && cc.chat !== undefined) {
      lead.replied = cc.replied; if (cc.repliedAt) lead.repliedAt = cc.repliedAt;
    } else {
      try {
        const m = await api(`/conversations/${conv.id}/messages?limit=100`, { version: '2021-04-15' });
        const msgs = (m.messages && m.messages.messages) || m.messages || [];
        const inbound = msgs.filter(x => x.direction === 'inbound' && isRealMsg(x.messageType));
        lead.replied = inbound.length > 0;
        if (inbound.length) lead.repliedAt = inbound.map(x => x.dateAdded).sort().pop();
        cc.replied = lead.replied; cc.repliedAt = lead.repliedAt || null;
        // The whole chat, oldest first, so the owner reads the enquiry exactly as it happened.
        cc.chat = msgs.filter(x => isRealMsg(x.messageType) && (x.body || (x.attachments || []).length))
          .sort((a, b) => ts(a.dateAdded) - ts(b.dateAdded)).slice(-40)
          .map(x => ({ d: x.direction === 'inbound' ? 'in' : 'out', t: short(x.body, 600), a: (x.attachments || []).slice(0, 4), at: x.dateAdded }));
      } catch (e) { lead.replied = lead.needsReply; }
    }
  }
  if (cc.chat && cc.chat.length) lead.chat = cc.chat;
  if (need) { cc.dStamp = stamp; cc.dAt = now; }

  // Where the lead came in, in plain words
  const tagsAll = (c.tags || []).map(t => String(t).toLowerCase());
  const page = String((c.attributionSource && (c.attributionSource.url || c.attributionSource.referrer)) || (c.lastAttributionSource && c.lastAttributionSource.url) || '').toLowerCase();
  const chat = tagsAll.includes('website-chat-lead');
  lead.channel = lead.fbForm ? lead.fbForm
    : /wykes-lp-artificial|artificial|grass\./.test(page) ? (chat ? 'Grass page chat' : 'Grass landing page')
    : /wykes-lp-fencing|fencing\./.test(page) ? (chat ? 'Fencing page chat' : 'Fencing landing page')
    : chat ? 'Website chat or voice'
    : tagsAll.includes('website-lead') ? 'Website quote form'
    : (lead.source || 'Other');
  if (!lead.source || /^(direct traffic|crm ui)$/i.test(lead.source)) lead.source = lead.channel;

  // Service tags (service-fencing, service-artificial-grass, ...) from what they asked for and the page they came from.
  // Added once per lead, in one API call, so contacts can be filtered by service in GHL.
  const svcText = `${f.service_requested || ''} ${lead.service || ''} ${f.job_message || ''} ${lead.channel}`.toLowerCase();
  const svcTags = [
    [/grass/, 'service-artificial-grass'],
    [/resin|driveway/, 'service-resin-driveway'],
    [/paving|patio|block pav|groundwork|drainage/, 'service-paving'],
    [/palisade|rigid mesh|security|commercial|stock fenc|school|farm/, 'service-commercial-fencing'],
    [/material|shop|supply only|post 10|collection/, 'service-materials'],
    [/fenc|timber|composite|concrete|pvc|featheredge|slatted|panel|gate/, 'service-fencing'],
  ].filter(([re]) => re.test(svcText)).map(([, t]) => t).slice(0, 3);
  const missingSvc = svcTags.filter(t => !tagsAll.includes(t));
  if (i < DETAIL_LIMIT && missingSvc.length && svcTagBudget > 0 && cc.svcTagged !== missingSvc.join(',')) {
    svcTagBudget--;
    try { await api(`/contacts/${c.id}/tags`, { method: 'POST', body: { tags: missingSvc } }); tagsAll.push(...missingSvc); svcTagsAdded++; }
    catch (e) { console.warn('service tag', e.message); }
    cc.svcTagged = missingSvc.join(',');
  }
  lead.services = svcTags.map(t => t.replace('service-', '').replace(/-/g, ' '));

  // Qualification in three plain groups:
  //   qualified  = handed to the owner (interested, visit booked, quoted or won)
  //   qualifying = still being qualified (new enquiry or the AI is talking to them)
  //   not        = not qualified, shopping around or lost
  const QUAL_TAGS = ['qualified-lead', 'hot-lead', 'waiting-owner', 'owner-answered', 'site-visit-booked', 'quote-sent', 'won'];
  const NOT_TAGS = ['not-qualified', 'shopping-around', 'nurture', 'lost'];
  lead.qual = ['owner', 'booked', 'quote', 'won'].includes(lead.bucket) ? 'qualified'
    : ['nurture', 'lost'].includes(lead.bucket) ? 'not'
    : tagsAll.some(t => NOT_TAGS.includes(t)) ? 'not'
    : tagsAll.some(t => QUAL_TAGS.includes(t)) ? 'qualified'
    : 'qualifying';

  // Does a person need to step in? Each reason is a short plain sentence.
  const stillOpen = !['won', 'lost', 'nurture'].includes(lead.bucket);
  const why = [];
  if (stillOpen) {
    // Why the AI handed over, from the reason tag it added (chat handover / stop-bot scenarios, voice post-call routing)
    const REASONS = {
      'enquiry-complaint': 'Complaint about a job: call them first',
      'enquiry-call-request': 'Asked for a call',
      'enquiry-price-date': 'Asked for a fixed price, a discount or a date',
      'enquiry-outside-area': 'Outside the usual area: check if you can cover it',
      'enquiry-shop': 'Shop order question',
      'enquiry-question': 'Asked something the assistant could not answer',
    };
    const reasons = Object.keys(REASONS).filter(t => tagsAll.includes(t)).map(t => REASONS[t]);
    if (reasons.length) why.push(...reasons);
    else if (tagsAll.includes('needs-human') || tagsAll.includes('human handover')) why.push('The assistant handed this one to you');
    if (lead.needsReply) why.push('Their last message has no reply');
    if (lead.bucket === 'owner' || tagsAll.includes('waiting-owner')) why.push('Interested: pick a site visit day');
    if ((lead.tasks || []).some(t => t.due && ts(t.due) < now)) why.push('A reminder is overdue');
    const contacted = tagsAll.some(t => ['called', 'no-answer', 'owner-answered', 'quote-sent', 'site-visit-booked'].includes(t));
    // 24-hour follow-up check. Stops once the lead is qualified and handed to the owner.
    const noFollowUp = lead.qual === 'qualifying' && !contacted && !lead.replied && ts(c.dateAdded) < now - DAY && ts(c.dateAdded) > now - 21 * DAY;
    if (noFollowUp || (lead.qual === 'qualifying' && tagsAll.includes('no-followup-24h') && !contacted)) why.push('No follow-up within 24 hours');
  }
  lead.why = why;
  lead.isNew = ts(c.dateAdded) >= now - 2 * DAY;
  leads.push(lead);
}

// 6. Summary numbers
const within = (v, days) => ts(v) >= now - days * DAY;
const dublinNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
const dublinMidnight = new Date(dublinNow); dublinMidnight.setHours(0, 0, 0, 0);
const startOfToday = now - (dublinNow - dublinMidnight); // time elapsed since midnight in Ireland
const inB = b => leads.filter(l => l.bucket === b);
const sum = list => list.reduce((s, l) => s + (l.value || 0), 0);
const won30 = inB('won').filter(l => within(l.oppAt || l.updatedAt, 30));
const kpis = {
  newToday: leads.filter(l => ts(l.createdAt) >= startOfToday).length,
  new7: leads.filter(l => within(l.createdAt, 7)).length,
  new30: leads.filter(l => within(l.createdAt, 30)).length,
  needsReply: leads.filter(l => l.needsReply && !['won', 'lost'].includes(l.bucket)).length,
  replied30: leads.filter(l => l.replied && within(l.repliedAt || l.updatedAt, 30)).length,
  sentToOwner: inB('owner').length, visitsBooked: inB('booked').length,
  quotesOut: inB('quote').length, quotesValue: sum(inB('quote')),
  won30: won30.length, wonValue30: sum(won30), wonAll: inB('won').length,
  nurture: inB('nurture').length, lost: inB('lost').length, totalLeads: leads.length,
  needsYou: leads.filter(l => l.why && l.why.length).length,
  new48: leads.filter(l => l.isNew).length,
  qualified: leads.filter(l => l.qual === 'qualified' && l.bucket !== 'won').length,
  qualifying: leads.filter(l => l.qual === 'qualifying').length,
  notQualified: leads.filter(l => l.qual === 'not').length,
  noFollowUp: leads.filter(l => (l.why || []).includes('No follow-up within 24 hours')).length,
};
const dublinEndOfToday = startOfToday + DAY;
const reminders = leads.flatMap(l => (l.tasks || []).map(t => ({ title: t.title, body: t.body, due: t.due, contactId: l.contactId, name: l.name, phone: l.phone })))
  .sort((a, b) => (ts(a.due) || 9e15) - (ts(b.due) || 9e15)).slice(0, 25);
const visits = leads.flatMap(l => (l.appointments || []).map(a => ({ title: a.title, start: a.start, status: a.status, contactId: l.contactId, name: l.name, town: l.town })))
  .sort((a, b) => ts(a.start) - ts(b.start)).slice(0, 10);
Object.assign(kpis, {
  remindersOpen: reminders.length,
  remindersOverdue: reminders.filter(r => r.due && ts(r.due) < now).length,
  remindersToday: reminders.filter(r => r.due && ts(r.due) >= now && ts(r.due) < dublinEndOfToday).length,
  upcomingVisits: visits.length,
});
const stageCounts = [];
pipelines.forEach(p => {
  const inPipe = leads.filter(l => l.pipeline === p.name);
  if (p !== mainPipe && !inPipe.length) return;
  p.stages.forEach(s => stageCounts.push({ pipeline: p.name, name: s.name, count: inPipe.filter(l => l.stage === s.name).length }));
});
const noDeal = leads.filter(l => !l.pipeline).length;
if (noDeal) stageCounts.push({ pipeline: 'Not in a pipeline yet', name: 'Contacts only', count: noDeal });
const weekly = Array.from({ length: 8 }, (_, i) => {
  const end = now - i * 7 * DAY, start = end - 7 * DAY;
  return { start: new Date(start).toISOString(), count: leads.filter(l => ts(l.createdAt) > start && ts(l.createdAt) <= end).length };
}).reverse();
const srcCount = {};
leads.forEach(l => { const k = l.source || 'Not recorded'; srcCount[k] = (srcCount[k] || 0) + 1; });
const sources = Object.entries(srcCount).map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count).slice(0, 6);

const data = {
  generatedAt: new Date().toISOString(), hook: process.env.DASH_HOOK_URL || '', pipeline: mainPipe ? mainPipe.name : '', ghlBase: `https://app.gohighlevel.com/v2/location/${L}`,
  kpis, reminders, visits, stages: stageCounts, weekly, sources, leads: leads.filter((l, i) => i < 80 || (l.why && l.why.length)),
};

// 7. Encrypt with the passcode (PBKDF2-SHA256 -> AES-256-GCM) and write the site
const enc = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
const ITER = 310000;
const base = await crypto.subtle.importKey('raw', enc.encode(PASS.trim().toUpperCase()), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
const b64 = u => Buffer.from(u).toString('base64');
await mkdir(OUT, { recursive: true });
await cp('site', OUT, { recursive: true });
const BUILD = (process.env.GITHUB_SHA || 'local').slice(0, 12);
await writeFile(`${OUT}/index.html`, (await readFile(`${OUT}/index.html`, 'utf8')).replace('__BUILD__', BUILD));
await writeFile(`${OUT}/data.enc.json`, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), at: data.generatedAt, build: BUILD }));
await saveCache();
if (svcTagsAdded) console.log(`Added service tags to ${svcTagsAdded} lead(s)`);
console.log(`Re-read notes for ${notesFetched} and details for ${detailsFetched} lead(s); the rest came from the cache.`);
console.log(`Facebook lead form leads on the dashboard: ${leads.filter(l => l.fbForm).length} (${leads.filter(l => l.fbForm).map(l => [l.fbForm, l.size || '-', l.intent || '-'].join(' | ')).join('; ')})`);
console.log(`OK: ${leads.length} leads (contacts), ${opps.length} deals in ${pipelines.length} pipelines, ${Object.keys(convByContact).length} conversations, ${reminders.length} open reminders, ${leads.reduce((n, l) => n + (l.noteCount || 0), 0)} notes, ${visits.length} upcoming visits, ${calls} API calls`);
console.log('KPIs', JSON.stringify(kpis));
