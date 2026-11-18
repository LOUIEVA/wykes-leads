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

// 1. Field names, pipeline and stages
const fieldsRes = await api(`/locations/${L}/customFields?model=contact`);
const fieldKey = Object.fromEntries((fieldsRes.customFields || []).map(f => [f.id, (f.fieldKey || '').replace(/^contact\./, '')]));
const { pipelines = [] } = await api(`/opportunities/pipelines?locationId=${L}`);
const pipe = pipelines.find(p => p.name.trim().toLowerCase() === PIPELINE_NAME.toLowerCase());
if (!pipe) throw new Error(`Pipeline "${PIPELINE_NAME}" not found`);
const stages = pipe.stages.map(s => ({ id: s.id, name: s.name }));
const stageName = id => (stages.find(s => s.id === id) || {}).name || 'Unknown';
const stageIs = (o, re) => re.test(stageName(o.pipelineStageId));

// 2. Opportunities in the pipeline
let opps = [];
for (let page = 1; page <= 20; page++) {
  const r = await api(`/opportunities/search?location_id=${L}&pipeline_id=${pipe.id}&limit=100&page=${page}`);
  opps.push(...(r.opportunities || []));
  if ((r.opportunities || []).length < 100) break;
}
opps = opps.filter(o => !((o.contact && o.contact.tags) || []).includes('owner'));
opps.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));

// 3. Conversations (latest per contact)
const convByContact = {};
for (let page = 0, startAfter = ''; page < 5; page++) {
  const r = await api(`/conversations/search?locationId=${L}&limit=100&sort=desc&sortBy=last_message_date${startAfter}`, { version: '2021-04-15' });
  const list = r.conversations || [];
  for (const c of list) if (c.contactId && !convByContact[c.contactId]) convByContact[c.contactId] = c;
  if (list.length < 100) break;
  const last = list[list.length - 1]; startAfter = `&startAfterDate=${encodeURIComponent(last.lastMessageDate || last.dateUpdated || '')}`;
}
const isRealMsg = t => t && !/ACTIVITY|NO_SHOW|CUSTOM_PROVIDER/i.test(String(t));

// 4. Details for recent leads: custom fields, and whether they ever replied
const DETAIL_LIMIT = 60;
const leads = [];
for (const [i, o] of opps.entries()) {
  const cid = o.contactId || (o.contact && o.contact.id);
  const conv = convByContact[cid];
  const lead = {
    id: o.id, contactId: cid, name: o.name || (o.contact && o.contact.name) || 'Unnamed lead',
    phone: (o.contact && o.contact.phone) || '', email: (o.contact && o.contact.email) || '',
    stage: stageName(o.pipelineStageId), status: o.status, value: Number(o.monetaryValue) || 0,
    createdAt: o.createdAt, updatedAt: o.updatedAt || o.lastStageChangeAt || o.createdAt,
    tags: ((o.contact && o.contact.tags) || []).filter(t => /lead|nurture|area|human|owner-answered|waiting/i.test(t)),
    needsReply: !!(conv && conv.lastMessageDirection === 'inbound' && isRealMsg(conv.lastMessageType)),
    unread: conv ? Number(conv.unreadCount) || 0 : 0,
    lastMessage: conv && conv.lastMessageDate ? { dir: conv.lastMessageDirection, at: conv.lastMessageDate, type: String(conv.lastMessageType || '').replace('TYPE_', '').toLowerCase(), text: short(conv.lastMessageBody, 110) } : null,
    replied: false,
  };
  if (i < DETAIL_LIMIT && cid) {
    try {
      const { contact = {} } = await api(`/contacts/${cid}`);
      const f = Object.fromEntries((contact.customFields || []).map(cf => [fieldKey[cf.id] || cf.id, cf.value ?? cf.fieldValue]));
      Object.assign(lead, {
        town: short(f.town_or_eircode || contact.city || '', 40), service: short(f.service_requested, 40), timeframe: short(f.timeframe, 30),
        size: short(f.job_size, 40), message: short(f.job_message, 160), ballpark: short(f.ballpark_text, 60), grade: short(f.lead_grade, 12),
        source: short(contact.source || (contact.attributionSource && contact.attributionSource.sessionSource) || f.utm_source || '', 30),
      });
      if (!lead.phone) lead.phone = contact.phone || '';
    } catch (e) { console.warn('contact', e.message); }
    if (conv) {
      try {
        const m = await api(`/conversations/${conv.id}/messages?limit=100`, { version: '2021-04-15' });
        const msgs = (m.messages && m.messages.messages) || m.messages || [];
        const inbound = msgs.filter(x => x.direction === 'inbound' && isRealMsg(x.messageType));
        lead.replied = inbound.length > 0;
        if (inbound.length) lead.repliedAt = inbound.map(x => x.dateAdded).sort().pop();
      } catch (e) { lead.replied = lead.needsReply; }
    }
  }
  leads.push(lead);
}

// 5. Summary numbers
const within = (v, days) => ts(v) >= now - days * DAY;
const dublinNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
const dublinMidnight = new Date(dublinNow); dublinMidnight.setHours(0, 0, 0, 0);
const startOfToday = now - (dublinNow - dublinMidnight); // time elapsed since midnight in Ireland
const open = o => o.status === 'open';
const count = re => opps.filter(o => open(o) && stageIs(o, re)).length;
const won = opps.filter(o => o.status === 'won' || stageIs(o, /^won$/i));
const quotes = opps.filter(o => open(o) && stageIs(o, /quote/i));
const kpis = {
  newToday: opps.filter(o => ts(o.createdAt) >= startOfToday).length,
  new7: opps.filter(o => within(o.createdAt, 7)).length,
  new30: opps.filter(o => within(o.createdAt, 30)).length,
  needsReply: leads.filter(l => l.needsReply && l.status === 'open').length,
  replied30: leads.filter(l => l.replied && within(l.repliedAt || l.updatedAt, 30)).length,
  sentToOwner: count(/sent to owner/i),
  visitsBooked: count(/site visit/i),
  quotesOut: quotes.length, quotesValue: quotes.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0),
  won30: won.filter(o => within(o.lastStatusChangeAt || o.updatedAt, 30)).length,
  wonValue30: won.filter(o => within(o.lastStatusChangeAt || o.updatedAt, 30)).reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0),
  wonAll: won.length, nurture: count(/nurture/i), lost: opps.filter(o => o.status === 'lost' || stageIs(o, /^lost$/i)).length,
  totalLeads: opps.length,
};
const stageCounts = stages.map(s => ({ name: s.name, count: opps.filter(o => o.pipelineStageId === s.id && o.status !== 'abandoned').length, value: opps.filter(o => o.pipelineStageId === s.id).reduce((a, o) => a + (Number(o.monetaryValue) || 0), 0) }));
const weekly = Array.from({ length: 8 }, (_, i) => {
  const end = now - i * 7 * DAY, start = end - 7 * DAY;
  return { start: new Date(start).toISOString(), count: opps.filter(o => ts(o.createdAt) > start && ts(o.createdAt) <= end).length };
}).reverse();
const srcCount = {};
leads.forEach(l => { const k = l.source || 'Website form'; srcCount[k] = (srcCount[k] || 0) + 1; });
const sources = Object.entries(srcCount).map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count).slice(0, 6);

const data = {
  generatedAt: new Date().toISOString(), pipeline: pipe.name, ghlBase: `https://app.gohighlevel.com/v2/location/${L}`,
  kpis, stages: stageCounts, weekly, sources, leads: leads.slice(0, 60),
};

// 6. Encrypt with the passcode (PBKDF2-SHA256 -> AES-256-GCM) and write the site
const enc = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
const ITER = 310000;
const base = await crypto.subtle.importKey('raw', enc.encode(PASS.trim().toUpperCase()), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
const b64 = u => Buffer.from(u).toString('base64');
await mkdir(OUT, { recursive: true });
await cp('site', OUT, { recursive: true });
await writeFile(`${OUT}/data.enc.json`, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), at: data.generatedAt }));
console.log(`OK: ${opps.length} leads in "${pipe.name}", ${Object.keys(convByContact).length} conversations, ${calls} API calls`);
console.log('KPIs', JSON.stringify(kpis));
