/**
 * Nyhedsvagtens værktøjskasse · Cloudflare Worker
 * Henter ODIN 112-puls, politiets meldinger (Ritzau), Vejdirektoratet, DR P4 Trafik
 * og lokale medier, filtrerer til Faxe, Sorø, Næstved, Vordingborg og Slagelse
 * og returnerer én samlet JSON-liste med CORS, så webappen kan læse den fra alle enheder.
 *
 * Endpoints:
 *   GET /api/feed    → { updated, items:[...], sources:[...] }
 *   GET /            → kort status
 *
 * Ret kilder og byer i CONFIG herunder. Intet andet skal ændres.
 */

const CONFIG = {
  // ODIN RSS pr. beredskab. "areaDefault" = hændelser regnes som lokale, medmindre stationen ligger uden for området.
  odin: [
    { id: '1082', label: 'Slagelse Brand & Redning', areaDefault: true },
    { id: '1201', label: 'Midt- og Sydsjællands Brand & Redning', areaDefault: true },
    { id: '0000', label: 'Landsdækkende', areaDefault: false }, // backup: filtreres på stationsnavn
  ],
  // Politiets korte meldinger (POLITI | UPDATE) via Ritzau. Alle fem kommuner hører under Sydsjællands og Lolland-Falsters Politi.
  politi: [
    { url: 'https://via.ritzau.dk/rss/short-messages/latest?publisherId=90594', label: 'Sydsjællands og Lolland-Falsters Politi', areaDefault: false },
  ],
  // Vejdirektoratets offentlige data bag trafikkort.vejdirektoratet.dk
  vd: {
    events: 'https://storage.googleapis.com/trafikkort-data/geojson/big-screen-events.json',
    critical: 'https://storage.googleapis.com/trafikkort-data/geojson/critical-announcements.json',
    maxKm: 9, // hændelser tættere end dette på en by i listen regnes som lokale
  },
  // DR P4 Trafik har intet officielt feed. Siden læses "best effort".
  dr: { url: 'https://www.dr.dk/trafik' },
  // Lokale medier (RSS). Tilføj/fjern frit. Status vises i appen, så du kan se om et feed virker.
  media: [
    { url: 'https://www.tvoest.dk/rss', label: 'TV ØST' },
    // { url: 'https://www.sn.dk/rss/...', label: 'sn.dk' },  // indsæt sn.dk's RSS-adresse, hvis I har den
  ],
  cacheSeconds: 60,
};

// Byer → kommune + koordinater (lat, lon). Bruges til at placere og filtrere hændelser.
const PLACES = [
  // Slagelse
  ['Slagelse', 'Slagelse', 55.402, 11.354], ['Korsør', 'Slagelse', 55.330, 11.139], ['Halsskov', 'Slagelse', 55.343, 11.118],
  ['Skælskør', 'Slagelse', 55.250, 11.293], ['Vemmelev', 'Slagelse', 55.364, 11.255], ['Boeslunde', 'Slagelse', 55.296, 11.276],
  ['Dalmose', 'Slagelse', 55.288, 11.425], ['Slots Bjergby', 'Slagelse', 55.372, 11.318], ['Gimlinge', 'Slagelse', 55.331, 11.384],
  ['Hashøj', 'Slagelse', 55.315, 11.452], ['Stigsnæs', 'Slagelse', 55.215, 11.255], ['Agersø', 'Slagelse', 55.210, 11.195],
  ['Omø', 'Slagelse', 55.160, 11.140], ['Forlev', 'Slagelse', 55.370, 11.268], ['Svenstrup', 'Slagelse', 55.433, 11.290],
  ['Storebæltsbroen', 'Slagelse', 55.338, 11.050], ['Storebælt', 'Slagelse', 55.338, 11.080],
  // Sorø
  ['Sorø', 'Sorø', 55.432, 11.556], ['Dianalund', 'Sorø', 55.531, 11.495], ['Ruds Vedby', 'Sorø', 55.546, 11.385],
  ['Stenlille', 'Sorø', 55.539, 11.592], ['Fjenneslev', 'Sorø', 55.430, 11.680], ['Pedersborg', 'Sorø', 55.445, 11.548],
  ['Munke Bjergby', 'Sorø', 55.493, 11.553], ['Lynge', 'Sorø', 55.468, 11.476],
  // Næstved
  ['Næstved', 'Næstved', 55.229, 11.761], ['Fensmark', 'Næstved', 55.280, 11.805], ['Holme-Olstrup', 'Næstved', 55.262, 11.857],
  ['Glumsø', 'Næstved', 55.352, 11.693], ['Fuglebjerg', 'Næstved', 55.304, 11.549], ['Karrebæksminde', 'Næstved', 55.177, 11.653],
  ['Herlufmagle', 'Næstved', 55.322, 11.758], ['Tappernøje', 'Næstved', 55.155, 11.989], ['Mogenstrup', 'Næstved', 55.186, 11.836],
  ['Rønnebæk', 'Næstved', 55.205, 11.795], ['Sandved', 'Næstved', 55.270, 11.495], ['Hyllinge', 'Næstved', 55.266, 11.623],
  ['Karrebæk', 'Næstved', 55.200, 11.650], ['Lundby', 'Vordingborg', 55.113, 11.889],
  // Faxe
  ['Faxe Ladeplads', 'Faxe', 55.218, 12.163], ['Faxe', 'Faxe', 55.255, 12.119], ['Fakse', 'Faxe', 55.255, 12.119],
  ['Haslev', 'Faxe', 55.324, 11.966], ['Rønnede', 'Faxe', 55.258, 12.017], ['Karise', 'Faxe', 55.303, 12.215],
  ['Dalby', 'Faxe', 55.271, 12.029], ['Terslev', 'Faxe', 55.316, 12.052], ['Kongsted', 'Faxe', 55.292, 12.083],
  ['Jystrup', 'Ringsted', 55.519, 11.866],
  // Vordingborg
  ['Vordingborg', 'Vordingborg', 55.008, 11.911], ['Præstø', 'Vordingborg', 55.124, 12.045], ['Stege', 'Vordingborg', 54.986, 12.284],
  ['Kalvehave', 'Vordingborg', 55.000, 12.165], ['Nyråd', 'Vordingborg', 55.030, 11.957], ['Stensved', 'Vordingborg', 55.065, 12.033],
  ['Mern', 'Vordingborg', 55.050, 12.063], ['Bogø', 'Vordingborg', 54.930, 12.050], ['Klintholm', 'Vordingborg', 54.952, 12.463],
  ['Borre', 'Vordingborg', 54.993, 12.428], ['Møn', 'Vordingborg', 54.970, 12.300], ['Ørslev', 'Vordingborg', 55.042, 11.965],
  ['Jungshoved', 'Vordingborg', 55.085, 12.105], ['Masnedø', 'Vordingborg', 54.990, 11.885], ['Farøbroerne', 'Vordingborg', 54.948, 11.990],
  ['Dronning Alexandrines Bro', 'Vordingborg', 54.994, 12.200],
  // Nabobyer uden for området (bruges kun til at sortere fra)
  ['Ringsted', null, 55.442, 11.790], ['Køge', null, 55.457, 12.182], ['Holbæk', null, 55.717, 11.713],
  ['Kalundborg', null, 55.681, 11.089], ['Nykøbing F', null, 54.766, 11.873], ['Stevns', null, 55.330, 12.380],
  ['Store Heddinge', null, 55.311, 12.389], ['Nyborg', null, 55.312, 10.790],
];
// Ringsted, Jystrup og Lundby-rettelse: Jystrup er Ringsted → uden for. Lundby (Vordingborg) ok.
PLACES.forEach(p => { if (p[1] === 'Ringsted') p[1] = null; });

const KOMMUNER = ['Faxe', 'Sorø', 'Næstved', 'Vordingborg', 'Slagelse'];

// ───────────────────────── helpers ─────────────────────────

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACE_RX = PLACES
  .slice()
  .sort((a, b) => b[0].length - a[0].length) // længste navn først ("Faxe Ladeplads" før "Faxe")
  .map(p => ({ p, rx: new RegExp('(?<![\\p{L}])' + esc(p[0]) + '(?![\\p{L}])', 'iu') }));
const KOMMUNE_RX = KOMMUNER.map(k => ({ k, rx: new RegExp('(?<![\\p{L}])' + esc(k) + '\\s+[Kk]ommune', 'u') }));

/** Find første kendte sted i en tekst. Returnerer {place, kommune, lat, lon, inArea} eller null. */
function matchPlace(text) {
  if (!text) return null;
  for (const { k, rx } of KOMMUNE_RX) if (rx.test(text)) return { place: k + ' Kommune', kommune: k, inArea: true };
  for (const { p, rx } of PLACE_RX) {
    if (rx.test(text)) return { place: p[0], kommune: p[1], lat: p[2], lon: p[3], inArea: !!p[1] };
  }
  return null;
}

function km(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestPlace(lat, lon) {
  let best = null;
  for (const p of PLACES) {
    const d = km(lat, lon, p[2], p[3]);
    if (!best || d < best.d) best = { d, p };
  }
  return best;
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&aelig;/g, 'æ').replace(/&oslash;/g, 'ø').replace(/&aring;/g, 'å')
    .replace(/&AElig;/g, 'Æ').replace(/&Oslash;/g, 'Ø').replace(/&Aring;/g, 'Å')
    .replace(/&amp;/g, '&');
}

const stripHtml = s => decodeEntities(String(s || '')).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Minimal RSS/Atom-parser (Workers har ingen DOMParser). */
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, 'link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    items.push({
      title: stripHtml(tag(b, 'title')),
      description: stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')),
      link: link.trim(),
      guid: tag(b, 'guid') || tag(b, 'id'),
      pubDate: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'),
    });
  }
  return items;
}

/** Tolker danske datoformater som "22-11-2026 12:22:54", "22.11.2026 kl. 12.22", ISO og RFC. */
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:\D+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    return danishLocalToIso(+y, +mo, +d, +h, +mi, +se);
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString();
}

/** Dansk lokal tid → ISO (håndterer sommertid: sidste søndag i marts/oktober kl. 01 UTC). */
function danishLocalToIso(y, mo, d, h, mi, se) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, se);
  const lastSun = month => { const dt = new Date(Date.UTC(y, month + 1, 0)); return Date.UTC(y, month, dt.getUTCDate() - dt.getUTCDay(), 1); };
  const dstStart = lastSun(2), dstEnd = lastSun(9);
  const offset = (guess - 2 * 3600e3 >= dstStart && guess - 2 * 3600e3 < dstEnd) ? 2 : 1;
  return new Date(guess - offset * 3600e3).toISOString();
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function fetchText(url, ctx) {
  const cache = caches.default;
  const key = new Request(url, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Nyhedsvagtens vaerktoejskasse; redaktionelt overblik)', 'Accept': '*/*' },
    cf: { cacheTtl: CONFIG.cacheSeconds },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  ctx && ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Cache-Control': 'max-age=' + CONFIG.cacheSeconds } })));
  return body;
}

// ───────────────────────── kilder ─────────────────────────

async function srcOdin(ctx) {
  const out = [];
  const errors = [];
  await Promise.all(CONFIG.odin.map(async f => {
    try {
      const xml = await fetchText('https://www.odin.dk/RSS/RSS.aspx?beredskabsID=' + f.id, ctx);
      for (const it of parseRss(xml)) {
        const all = (it.title + ' ' + it.description).replace(/\s+/g, ' ');
        const melding = (all.match(/Førstemelding:\s*(.*?)\s*(?:Station:|$)/i) || [])[1] || it.title;
        const station = ((all.match(/Station:\s*(.*?)(?:\s*\d{1,2}-\d{1,2}-\d{4}|$)/i) || [])[1] || '').trim();
        const beredskab = ((all.match(/Beredskab:\s*(.*?)(?:Station:|$)/i) || [])[1] || f.label).trim();
        const time = parseDate(it.pubDate) || parseDate(all);
        const pm = matchPlace(station) || matchPlace(all);
        let inArea = pm ? pm.inArea : f.areaDefault;
        if (!pm && !f.areaDefault) continue; // landsfeed: kun kendte stationer
        out.push({
          id: 'odin-' + hash(station + melding + (time || it.pubDate)),
          source: 'odin', sourceLabel: 'ODIN 112-puls',
          time, title: melding.trim(),
          text: [station && 'Station: ' + station, beredskab].filter(Boolean).join(' · '),
          url: 'https://www.odin.dk/112puls/',
          place: station || (pm && pm.place) || '', kommune: pm ? pm.kommune : null,
          lat: pm && pm.lat, lon: pm && pm.lon, inArea,
          category: 'udrykning',
        });
      }
    } catch (e) { errors.push(f.label + ': ' + e.message); }
  }));
  // dedupe (samme alarm kan stå i både lokal- og landsfeed)
  const seen = new Set();
  const items = out.filter(i => !seen.has(i.id) && seen.add(i.id));
  return { items, errors };
}

async function srcRss(list, source, sourceLabelFn, category, ctx) {
  const items = [], errors = [];
  await Promise.all(list.map(async f => {
    try {
      const xml = await fetchText(f.url, ctx);
      for (const it of parseRss(xml)) {
        const full = it.title + '\n' + it.description;
        const pm = matchPlace(full);
        items.push({
          id: source + '-' + hash(it.guid || it.link || it.title),
          source, sourceLabel: sourceLabelFn(f),
          time: parseDate(it.pubDate), title: it.title, text: it.description.slice(0, 1200),
          url: it.link, place: pm ? pm.place : '', kommune: pm ? pm.kommune : null,
          lat: pm && pm.lat, lon: pm && pm.lon, inArea: pm ? pm.inArea : !!f.areaDefault, category,
        });
      }
    } catch (e) { errors.push(f.label + ': ' + e.message); }
  }));
  return { items, errors };
}

function centroid(geom) {
  if (!geom || !geom.coordinates) return null;
  let c = geom.coordinates;
  while (Array.isArray(c[0])) c = c[Math.floor(c.length / 2)];
  return (typeof c[0] === 'number') ? { lon: c[0], lat: c[1] } : null;
}

async function srcVd(ctx) {
  const items = [], errors = [];
  const handleFeature = (feat, layer, critical) => {
    const p = feat.properties || {};
    const c = centroid(feat.geometry);
    const title = stripHtml(p.title || p.header || p.name || layer || 'Trafikmelding');
    const text = stripHtml([p.header !== p.title ? p.header : '', p.description].filter(Boolean).join('\n'));
    let place = '', kommune = null, inArea = false, lat = null, lon = null;
    if (c) {
      lat = c.lat; lon = c.lon;
      const n = nearestPlace(lat, lon);
      if (n && n.d <= CONFIG.vd.maxKm) { place = n.p[0] + (n.d > 2 ? ' (' + n.d.toFixed(0) + ' km)' : ''); kommune = n.p[1]; inArea = !!n.p[1]; }
    } else {
      const pm = matchPlace(title + ' ' + text);
      if (pm) { place = pm.place; kommune = pm.kommune; inArea = pm.inArea; }
    }
    if (!inArea && !kommune && !place) return; // resten af landet springes over
    items.push({
      id: 'vd-' + hash(String(p.featureId || p.id || '') + title + (lat || '') + (lon || '')),
      source: 'vd', sourceLabel: 'Vejdirektoratet',
      time: parseDate(p.validFrom || p.beginPeriod || p.startTime || p.created),
      until: parseDate(p.endPeriod || p.validTo),
      title, text: text.slice(0, 1200), url: 'https://trafikkort.vejdirektoratet.dk/',
      place, kommune, lat, lon, inArea,
      category: critical ? 'varsel' : /vejarbejde|roadwork/i.test(layer + title) ? 'vejarbejde' : 'trafik',
    });
  };
  try {
    const data = JSON.parse(await fetchText(CONFIG.vd.events, ctx));
    const colls = Array.isArray(data) ? data : [data];
    for (const fc of colls) for (const f of (fc.features || [])) handleFeature(f, fc.layerName || '', false);
  } catch (e) { errors.push('Hændelser: ' + e.message); }
  try {
    const data = JSON.parse(await fetchText(CONFIG.vd.critical, ctx));
    for (const f of (data.features || [])) handleFeature(f, (f.properties || {}).category || '', true);
  } catch (e) { errors.push('Varsler: ' + e.message); }
  return { items, errors };
}

/** DR P4 Trafik: læser JSON indlejret i siden og samler tekstmeldinger. Eksperimentel. */
async function srcDr(ctx) {
  const items = [], errors = [];
  try {
    const html = await fetchText(CONFIG.dr.url, ctx);
    const blobs = [];
    for (const m of html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)) blobs.push(m[1]);
    for (const m of html.matchAll(/window\.__[A-Za-z_]+__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/g)) blobs.push(m[1]);
    const found = new Map();
    const TEXT = ['text', 'body', 'description', 'message', 'content', 'summary', 'teaser', 'title'];
    const TIME = ['time', 'date', 'published', 'publishedAt', 'created', 'createdAt', 'updated', 'updatedAt', 'timestamp', 'startTime', 'startDate'];
    const walk = (o, depth) => {
      if (!o || depth > 14) return;
      if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
      if (typeof o !== 'object') return;
      const keys = Object.keys(o);
      const tk = TEXT.find(k => typeof o[k] === 'string' && stripHtml(o[k]).length >= 25 && keys.some(x => TIME.includes(x)));
      if (tk) {
        const text = stripHtml(o[tk]);
        const timeKey = TIME.find(k => o[k]);
        const region = [o.region, o.area, o.location, o.regionName].filter(x => typeof x === 'string').join(' ');
        if (!found.has(text)) found.set(text, { text, time: parseDate(o[timeKey]), region });
      }
      keys.forEach(k => walk(o[k], depth + 1));
    };
    for (const b of blobs) { try { walk(JSON.parse(b), 0); } catch (_) { /* ikke JSON */ } }
    if (!blobs.length) errors.push('Fandt ingen data i siden – DR har måske ændret opbygning');
    for (const { text, time, region } of found.values()) {
      const pm = matchPlace(text) || matchPlace(region);
      if (!pm) continue;
      items.push({
        id: 'dr-' + hash(text), source: 'dr', sourceLabel: 'P4 Trafik',
        time, title: text.split(/(?<=[.!?])\s/)[0].slice(0, 140), text,
        url: CONFIG.dr.url, place: pm.place, kommune: pm.kommune, lat: pm.lat, lon: pm.lon, inArea: pm.inArea,
        category: 'trafik',
      });
    }
  } catch (e) { errors.push(e.message); }
  return { items, errors };
}

// ───────────────────────── handler ─────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function buildFeed(ctx) {
  const defs = [
    ['odin', 'ODIN 112-puls', () => srcOdin(ctx)],
    ['politi', 'Politiet', () => srcRss(CONFIG.politi, 'politi', f => 'Politi · ' + f.label.replace(' Politi', ''), 'politi', ctx)],
    ['vd', 'Vejdirektoratet', () => srcVd(ctx)],
    ['dr', 'P4 Trafik', () => srcDr(ctx)],
    ['medier', 'Lokale medier', () => srcRss(CONFIG.media, 'medier', f => f.label, 'medier', ctx)],
  ];
  const results = await Promise.all(defs.map(async ([key, label, fn]) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      return { key, label, items: r.items, errors: r.errors, ms: Date.now() - t0 };
    } catch (e) {
      return { key, label, items: [], errors: [e.message], ms: Date.now() - t0 };
    }
  }));
  const items = results.flatMap(r => r.items)
    .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
    .slice(0, 400);
  return {
    updated: new Date().toISOString(),
    area: KOMMUNER,
    items,
    sources: results.map(r => ({
      key: r.key, label: r.label, count: r.items.length, local: r.items.filter(i => i.inArea).length,
      ok: r.errors.length === 0, errors: r.errors, ms: r.ms,
    })),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/feed') {
      const body = await buildFeed(ctx);
      return new Response(JSON.stringify(body), {
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=20' },
      });
    }
    return new Response('Nyhedsvagtens værktøjskasse: worker kører. Data: /api/feed', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

// Eksporter til test i Node (ignoreres af Cloudflare)
export const _test = { parseRss, parseDate, matchPlace, nearestPlace, stripHtml, srcOdin, srcVd, srcDr, srcRss, buildFeed, CONFIG };
