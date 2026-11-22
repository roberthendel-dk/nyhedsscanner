/**
 * Nyhedsvagtens værktøjskasse · Cloudflare Worker
 * Henter ODIN 112-puls, politiets meldinger (Ritzau), Vejdirektoratet, DSB
 * og lokale medier, filtrerer til Faxe, Sorø, Næstved, Vordingborg og Slagelse
 * og returnerer én samlet JSON-liste med CORS, så webappen kan læse den fra alle enheder.
 *
 * Endpoints:
 *   GET /api/feed    → { updated, items:[...], sources:[...] }
 *   GET /            → kort status
 *
 * Ret kilder og byer i CONFIG herunder. Intet andet skal ændres.
 */

const VERSION = '9';

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
  // DSB's side med akutte ændringer (ingen RSS – siden læses)
  dsb: { url: 'https://www.dsb.dk/trafikinformation/' },
  // Lokale medier (RSS). Tilføj/fjern frit. Status vises i appen, så du kan se om et feed virker.
  // Kun artikler om hændelser (brand, uheld, politi osv.) fra medierne. Sæt til false for at få alle lokale artikler.
  mediaOnlyIncidents: true,
  media: [
    { url: 'https://www.tv2east.dk/rss', label: 'TV2 Øst' },
    // { url: 'https://www.sn.dk/rss/...', label: 'sn.dk' },  // indsæt sn.dk's RSS-adresse, hvis I har den
  ],
  cacheSeconds: 60,
  maxAgeDays: 7, // ældre meldinger vises ikke
  timeoutMs: 8000, // en kilde, der ikke svarer inden da, springes over i denne runde
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
  // Togstrækninger og stationer
  ['Lille Syd', 'Faxe', 55.324, 11.966], ['Tureby', 'Faxe', 55.360, 12.020], ['Sydbanen', 'Næstved', 55.229, 11.761],
  ['Vestbanen', 'Sorø', 55.432, 11.556], ['Næstved St', 'Næstved', 55.229, 11.761],
  // Nabobyer uden for området (bruges kun til at sortere fra)
  ['Ringsted', null, 55.442, 11.790], ['Køge', null, 55.457, 12.182], ['Holbæk', null, 55.717, 11.713],
  ['Kalundborg', null, 55.681, 11.089], ['Nykøbing F', null, 54.766, 11.873], ['Stevns', null, 55.330, 12.380],
  ['Store Heddinge', null, 55.311, 12.389], ['Nyborg', null, 55.312, 10.790],
];
// Ringsted, Jystrup og Lundby-rettelse: Jystrup er Ringsted → uden for. Lundby (Vordingborg) ok.
PLACES.forEach(p => { if (p[1] === 'Ringsted') p[1] = null; });

const KOMMUNER = ['Faxe', 'Sorø', 'Næstved', 'Vordingborg', 'Slagelse'];

// Ord der tyder på en hændelse (bruges til at sortere medieartikler)
const INCIDENT_RX = /(?<![\p{L}])(brand|brande|brændt|brændte|ildspåsættelse|røgudvikling|eksplosion|ulykke|færdselsuheld|uheld|påkørt|påkørsel|kollision|frontalt|væltet|kørt galt|politiet|politi(?![\p{L}])|anholdt|anholdelse|sigtet|varetægtsfængslet|efterlyser|efterlysning|savnet|eftersøgning|indbrud|tyveri|røveri|vold|overfald|knivstik|skud|skyderi|dræbt|dødsulykke|omkom|omkommet|livløs|druknet|redningsaktion|reddet|ambulance|brandvæsen|beredskab|112|spærret|evakueret|gasudslip|bombetrussel|kvæstet|tilskadekomne|kom til skade)(?![\p{L}])/iu;
// Sektioner i medie-URL'er → kommune (null = kendt sektion uden for området)
const URL_SECTIONS = { faxe: 'Faxe', soroe: 'Sorø', soro: 'Sorø', naestved: 'Næstved', vordingborg: 'Vordingborg', slagelse: 'Slagelse',
  ringsted: null, koege: null, stevns: null, holbaek: null, kalundborg: null, odsherred: null, lolland: null, guldborgsund: null, roskilde: null, lejre: null, greve: null, solroed: null };

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
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  }).catch(e => { throw new Error(e && e.name === 'TimeoutError' ? 'svarede ikke inden ' + CONFIG.timeoutMs / 1000 + ' sek.' : (e && e.message) || 'netværksfejl'); });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  ctx && ctx.waitUntil && ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Cache-Control': 'max-age=' + CONFIG.cacheSeconds } })).catch(() => {}));
  return body;
}

// ───────────────────────── kilder ─────────────────────────

async function srcOdin(ctx) {
  const out = [];
  const errors = [];
  await Promise.all(CONFIG.odin.map(async f => {
    try {
      let xml;
      try { xml = await fetchText('http://www.odin.dk/RSS/RSS.aspx?beredskabsID=' + f.id, ctx); }
      catch (e1) { xml = await fetchText('https://www.odin.dk/RSS/RSS.aspx?beredskabsID=' + f.id, ctx); }
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
        if (source === 'medier' && CONFIG.mediaOnlyIncidents && !INCIDENT_RX.test(it.title + ' ' + it.description.slice(0, 250))) continue;
        let pm = matchPlace(full);
        const sec = ((it.link || '').match(/^https?:\/\/[^/]+\/([a-z-]+)\//i) || [])[1];
        if (sec && Object.prototype.hasOwnProperty.call(URL_SECTIONS, sec)) {
          const k = URL_SECTIONS[sec];
          if (k) { if (!pm || pm.kommune !== k) pm = { place: pm && pm.kommune === k ? pm.place : k, kommune: k, inArea: true }; }
          else if (!pm || !pm.inArea) pm = { place: pm ? pm.place : '', kommune: null, inArea: false };
        }
        items.push({
          id: source + '-' + hash(((it.link || it.guid || it.title) + '').split('#')[0]),
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

/** Samme hændelse fra flere feeds/opdateringer → samme nøgle. */
function dupKey(i) {
  const t = String(i.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (i.source === 'odin') return 'odin|' + t + '|' + String(i.time || '').slice(0, 16);
  if (i.source === 'vd') return 'vd|' + t + '|' + (i.lat != null ? (+i.lat).toFixed(2) + ',' + (+i.lon).toFixed(2) : String(i.text || '').slice(0, 80));
  return i.source + '|' + t;
}
function better(a, b) { // er a bedre end b?
  return (a.time || '') > (b.time || '') || ((a.time || '') === (b.time || '') && (a.text || '').length > (b.text || '').length);
}

const DA_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
/** "i dag kl. 11:29", "i går kl. 9.05", "11. sept. 13:34", "22. november 2026 kl. 08:10" → ISO */
function parseDaDate(s) {
  if (!s) return null;
  const now = new Date(Date.now() + 36e5); // grov dansk dato
  let y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1, d = now.getUTCDate();
  const tm = s.match(/(\d{1,2})[:.](\d{2})(?!\d)/);
  if (/i går/i.test(s)) { const g = new Date(now - 864e5); y = g.getUTCFullYear(); mo = g.getUTCMonth() + 1; d = g.getUTCDate(); }
  else {
    const dm = s.match(/(\d{1,2})\.\s*([a-zæøå]{3})[a-zæøå]*\.?(?:\s*(\d{4}))?/i);
    if (dm && DA_MONTHS[dm[2].toLowerCase()]) { d = +dm[1]; mo = DA_MONTHS[dm[2].toLowerCase()]; if (dm[3]) y = +dm[3]; else if (mo > now.getUTCMonth() + 2) y -= 1; }
    else if (!/i dag/i.test(s) && !tm) return null;
  }
  return danishLocalToIso(y, mo, d, tm ? +tm[1] : 0, tm ? +tm[2] : 0, 0);
}

/** DSB: akutte ændringer læses fra trafikinformationssiden. */
async function srcDsb(ctx) {
  const items = [], errors = [];
  try {
    const html = await fetchText(CONFIG.dsb.url, ctx);
    const a = html.search(/Akutte ændringer/i);
    const b = html.search(/Planlagte ændringer/i);
    const sec = a >= 0 ? html.slice(a, b > a ? b : a + 40000) : html;
    if (/Ingen akutte ændringer/i.test(stripHtml(sec).slice(0, 400))) return { items, errors };
    const seen = new Set();
    for (const m of sec.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const parts = m[2].split(/<\/(?:h\d|p|div|span|time|strong)>|<br\s*\/?>/i).map(stripHtml).filter(Boolean);
      const text = parts.join(' · ').replace(/\s+/g, ' ').trim();
      if (text.length < 15 || /^(læs mere|se alle|se mere)/i.test(text)) continue;
      const href = m[1].startsWith('http') ? m[1] : 'https://www.dsb.dk' + (m[1].startsWith('/') ? '' : '/') + m[1];
      if (seen.has(href + text)) continue; seen.add(href + text);
      const before = stripHtml(sec.slice(Math.max(0, m.index - 500), m.index));
      const upd = (text.match(/(?:opdateret|seneste opdatering)[^·]*/i) || before.match(/(?:opdateret|seneste opdatering)[^.]*?(?:kl\.\s*)?\d{1,2}[:.]\d{2}/gi)?.slice(-1) || [])[0];
      const title = parts.filter(x => !/^(opdateret|seneste opdatering)/i.test(x)).sort((x, y) => y.length - x.length)[0] || text;
      const route = parts.find(x => / - | – /.test(x) && x.length < 80) || '';
      const pm = matchPlace(route + ' ' + text);
      items.push({
        id: 'dsb-' + hash(href + title), source: 'dsb', sourceLabel: 'DSB',
        time: parseDaDate(upd || ''), title: title.slice(0, 160),
        text: [route && route !== title ? 'Strækning: ' + route : '', upd || ''].filter(Boolean).join(' · '),
        url: href, place: pm ? pm.place : route, kommune: pm ? pm.kommune : null,
        lat: pm && pm.lat, lon: pm && pm.lon, inArea: pm ? pm.inArea : false, category: 'tog',
      });
    }
    if (!items.length) errors.push('Fandt ingen ændringer i siden – DSB har måske ændret opbygning');
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
    ['dsb', 'DSB', () => srcDsb(ctx)],
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
  const now = Date.now(), minTime = now - CONFIG.maxAgeDays * 864e5;
  const byId = new Map();
  for (const i of results.flatMap(r => r.items)) {
    if (i.time && Date.parse(i.time) < minTime) continue;      // for gammel
    if (i.until && Date.parse(i.until) < now) continue;         // udløbet trafikmelding
    const k = dupKey(i), prev = byId.get(k);
    // samme hændelse flere gange: behold den nyeste / mest udførlige version
    if (!prev || better(i, prev)) byId.set(k, i);
  }
  const items = [...byId.values()]
    .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
    .slice(0, 400);
  for (const r of results) { r.items = r.items.filter(i => byId.get(dupKey(i)) === i); }
  return {
    updated: new Date().toISOString(),
    version: VERSION,
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
      let body;
      try { body = await buildFeed(ctx); }
      catch (e) { body = { updated: new Date().toISOString(), items: [], sources: [], error: String(e && e.stack || e) }; }
      return new Response(JSON.stringify(body), {
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=20' },
      });
    }
    return new Response('Nyhedsvagtens værktøjskasse: worker kører (version ' + VERSION + '). Data: /api/feed', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

// Eksporter til test i Node (ignoreres af Cloudflare)
export const _test = { parseRss, parseDate, matchPlace, nearestPlace, stripHtml, srcOdin, srcVd, srcDsb, parseDaDate, srcRss, buildFeed, CONFIG };
