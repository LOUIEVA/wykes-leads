// Pulls Wykes leads from GoHighLevel, summarises them and writes an encrypted data file for the dashboard.
// Secrets come from the environment (GitHub Actions secrets). Nothing sensitive is written in plain text.
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile, cp } from 'node:fs/promises';

const PIT = process.env.GHL_PIT, L = process.env.GHL_LOCATION_ID, PASS = process.env.DASH_PASSCODE;
const PIPELINE_NAME = process.env.PIPELINE_NAME || 'Website Leads';
const OUT = process.env.OUT_DIR || 'dist';
if (!PIT || !L || !PASS) { console.error('Missing GHL_PIT, GHL_LOCATION_ID or DASH_PASSCODE'); process.exit(1); }

const API = 'https://services.leadconnectorhq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function api(path, { method = 'GET', body, version = '2021-07-28' } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    calls++;
    const res = await fetch(API + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${PIT}`, Version: version, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; WykesLeadsDashboard/1.0)' },
    });
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error(`${path.split('?')[0]} kept failing`);
}

const DAY = 864e5, now = Date.now();
const ts = v => (v ? new Date(v).getTime() : 0);
const short = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 1. Field names and every pipeline
const fieldsRes = await api(`/locations/${L}/customFields?model=contact`);
const fieldKey = Object.fromEntries((fieldsRes.customFields || []).map(f => [f.id, (f.fieldKey || '').replace(/^contact\./, '')]));
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
const internal = c => (c.tags || []).some(t => /^(owner|internal|test)$/i.test(t)) || /internal|not a lead/i.test(c.source || '');
contacts = contacts.filter(c => !internal(c));
contacts.sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded));

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
  note:          {},
};
let applied = 0;
for (const c of contacts.slice(0, DETAIL_LIMIT)) {
  let notes = [];
  try { notes = (await api(`/contacts/${c.id}/notes`)).notes || []; } catch (e) { console.warn('notes', e.message); }
  notesByContact[c.id] = notes;
  const pending = notes.filter(n => /^\s*\[Dashboard\]/.test(stripHtml(n.body))).sort((a, b) => ts(a.dateAdded) - ts(b.dateAdded));
  for (const n of pending) {
    const body = stripHtml(n.body);
    const key = (body.match(/#s=([a-z_]+)/) || [])[1] || 'note';
    const remind = (body.match(/;r=([0-9T:.\-Z+]+)/) || [])[1];
    const act = ACTIONS[key] || ACTIONS.note;
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || 'lead';
    try {
      if (act.tag) await api(`/contacts/${c.id}/tags`, { method: 'POST', body: { tags: [act.tag] } });
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
for (const [i, c] of contacts.entries()) {
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
  if (i < DETAIL_LIMIT && !Object.keys(f).length) {
    try { const { contact = {} } = await api(`/contacts/${c.id}`); f = Object.fromEntries((contact.customFields || []).map(cf => [fieldKey[cf.id] || cf.id, cf.value ?? cf.fieldValue])); } catch (e) { console.warn('contact', e.message); }
  }
  Object.assign(lead, {
    town: short(f.town_or_eircode || c.city || '', 40), service: short(f.service_requested, 40), timeframe: short(f.timeframe, 30),
    size: short(f.job_size, 40), message: short(f.job_message, 160), ballpark: short(f.ballpark_text, 60),
    source: short(c.source || (c.attributionSource && (c.attributionSource.sessionSource || c.attributionSource.medium)) || f.utm_source || '', 30),
  });
  if (i < DETAIL_LIMIT) {
    const strip = h => String(h || '').replace(/<br\s*\/?>(?!$)/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    const nList = notesByContact[c.id] || [];
    lead.notes = nList.slice().sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded)).slice(0, 4).map(x => ({ text: short(strip(x.body).replace(/\s*\|?\s*#s=.*$/, ''), 300), at: x.dateAdded }));
    lead.noteCount = nList.length;
    try {
      const t = await api(`/contacts/${c.id}/tasks`);
      lead.tasks = (t.tasks || []).filter(x => !x.completed).sort((a, b) => ts(a.dueDate) - ts(b.dueDate)).slice(0, 5).map(x => ({ title: short(x.title, 120), body: short(strip(x.body), 160), due: x.dueDate }));
    } catch (e) { lead.tasks = []; }
    try {
      const a = await api(`/contacts/${c.id}/appointments`);
      lead.appointments = (a.events || []).filter(x => ts(x.endTime || x.startTime) >= now - DAY && !/cancel/i.test(x.appointmentStatus || '')).sort((a2, b2) => ts(a2.startTime) - ts(b2.startTime)).slice(0, 3).map(x => ({ title: short(x.title, 80), start: x.startTime, status: x.appointmentStatus || '' }));
    } catch (e) { lead.appointments = []; }
  }
  if (i < DETAIL_LIMIT && conv) {
    try {
      const m = await api(`/conversations/${conv.id}/messages?limit=100`, { version: '2021-04-15' });
      const msgs = (m.messages && m.messages.messages) || m.messages || [];
      const inbound = msgs.filter(x => x.direction === 'inbound' && isRealMsg(x.messageType));
      lead.replied = inbound.length > 0;
      if (inbound.length) lead.repliedAt = inbound.map(x => x.dateAdded).sort().pop();
    } catch (e) { lead.replied = lead.needsReply; }
  }
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
  kpis, reminders, visits, stages: stageCounts, weekly, sources, leads: leads.slice(0, 80),
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
await writeFile(`${OUT}/data.enc.json`, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), at: data.generatedAt }));
console.log(`OK: ${leads.length} leads (contacts), ${opps.length} deals in ${pipelines.length} pipelines, ${Object.keys(convByContact).length} conversations, ${reminders.length} open reminders, ${leads.reduce((n, l) => n + (l.noteCount || 0), 0)} notes, ${visits.length} upcoming visits, ${calls} API calls`);
console.log('KPIs', JSON.stringify(kpis));
