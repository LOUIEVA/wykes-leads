// Local preview only: builds dist-mock/ with made-up sample leads so the layout can be checked
// without calling GoHighLevel. Passcode for the preview: TEST-PREVIEW
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
const now = Date.now(), H = 36e5, iso = ms => new Date(ms).toISOString();
const L = (o) => Object.assign({ contactId: 'c' + Math.random().toString(36).slice(2, 8), phone: '087 000 0000', email: 'sample@example.com', tags: [], notes: [], tasks: [], appointments: [], value: 0, replied: false, needsReply: false, why: [], isNew: false, stage: 'New enquiry', pipeline: 'Website Leads', status: 'open', bucket: 'new' }, o);
const leads = [
  L({ name: 'Sample Grass Lead', createdAt: iso(now - 2 * H), service: 'Artificial grass', town: 'Moate', channel: 'Grass page chat', isNew: true, address: '14 Sample Road, Moate, Co. Westmeath, N37 X000', message: 'Back garden about 60 sq m, currently uneven lawn. Want it done before Christmas if possible.', answers: [['Describe your project', 'Back garden, dog friendly please'], ['Enquiry Reason', 'Saw the Facebook ad']], campaign: 'grass-nov / video-1', page: 'grass.wykescontracts.com/', photos: ['https://example.com/a.jpg'], chat: [{ d: 'in', t: 'Hi, how much for artificial grass?', at: iso(now - 2 * H) }, { d: 'out', t: 'Hi! We give a written price after a quick look. What size is the area?', at: iso(now - 2 * H + 60000) }, { d: 'in', t: 'About 60 square metres', at: iso(now - 2 * H + 120000) }] }),
  L({ name: 'Sample Form Lead', createdAt: iso(now - 30 * H), service: 'Composite fence', town: 'Athlone', channel: 'Website quote form', isNew: true, why: ['No one has called them yet'] }),
  L({ name: 'Sample Handover', createdAt: iso(now - 50 * H), service: 'Resin driveway', town: 'Mullingar', channel: 'Website chat or voice', why: ['The assistant handed this one to you', 'Their last message has no reply'], needsReply: true, lastMessage: { dir: 'inbound', at: iso(now - 3 * H), type: 'live_chat', text: 'Can someone call me about the price?' } }),
  L({ name: 'Sample Interested', createdAt: iso(now - 80 * H), service: 'Timber fence', town: 'Ballinasloe', channel: 'Fencing page chat', bucket: 'owner', stage: 'Sent to owner (interested)', why: ['Interested: pick a site visit day'], value: 2500 }),
  L({ name: 'Sample Quoted', createdAt: iso(now - 200 * H), service: 'Patio', town: 'Athlone', channel: 'Website quote form', bucket: 'quote', stage: 'Quote sent', value: 4200 }),
];
const kpis = { newToday: 1, new7: 4, new30: 5, needsReply: 1, replied30: 1, sentToOwner: 1, visitsBooked: 0, quotesOut: 1, quotesValue: 4200, won30: 0, wonValue30: 0, wonAll: 0, nurture: 0, lost: 0, totalLeads: 5, needsYou: 3, new48: 2, remindersOpen: 0, remindersOverdue: 0, remindersToday: 0, upcomingVisits: 0 };
const data = { generatedAt: iso(now), hook: '', pipeline: 'Website Leads', ghlBase: 'https://app.gohighlevel.com/v2/location/SAMPLE', kpis, reminders: [], visits: [],
  stages: [{ pipeline: 'Website Leads', name: 'New enquiry', count: 3 }, { pipeline: 'Website Leads', name: 'Sent to owner (interested)', count: 1 }, { pipeline: 'Website Leads', name: 'Quote sent', count: 1 }],
  weekly: Array.from({ length: 8 }, (_, i) => ({ start: iso(now - (8 - i) * 7 * 864e5), count: i === 7 ? 4 : i % 3 })), sources: [{ name: 'Website quote form', count: 2 }, { name: 'Grass page chat', count: 1 }], leads };
const enc = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), ITER = 310000;
const base = await crypto.subtle.importKey('raw', enc.encode('TEST-PREVIEW'), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
const b64 = u => Buffer.from(u).toString('base64');
await mkdir('dist-mock', { recursive: true }); await cp('site', 'dist-mock', { recursive: true });
await writeFile('dist-mock/index.html', (await readFile('dist-mock/index.html', 'utf8')).replace('__BUILD__', 'mock'));
await writeFile('dist-mock/data.enc.json', JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), at: data.generatedAt, build: 'mock' }));
console.log('dist-mock ready');
