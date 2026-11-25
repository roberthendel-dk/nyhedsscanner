/**
 * Update by RH · Cloudflare Worker
 * Henter ODIN 112-puls, politiets meldinger (Ritzau), Vejdirektoratet, DSB, Lokaltog (Østbanen), DMI-varsler
 * og lokale medier, filtrerer til Faxe, Sorø, Næstved, Vordingborg og Slagelse
 * og returnerer én samlet JSON-liste med CORS, så webappen kan læse den fra alle enheder.
 *
 * Endpoints:
 *   GET /api/feed    → { updated, items:[...], sources:[...] }
 *   GET /            → kort status
 *
 * Ret kilder og byer i CONFIG herunder. Intet andet skal ændres.
 */

const VERSION = '32';

const CONFIG = {
  // ODIN RSS pr. beredskab. "areaDefault" = hændelser regnes som lokale, medmindre stationen ligger uden for området.
  odin: [
    { id: '1082', label: 'Slagelse Brand & Redning', areaDefault: true },
    { id: '1201', label: 'Midt- og Sydsjællands Brand & Redning', areaDefault: true },
    { id: '0000', label: 'Landsdækkende', areaDefault: false }, // backup: filtreres på stationsnavn
  ],
  // Politiets korte meldinger (POLITI | UPDATE) via Ritzau. Alle fem kommuner hører under Sydsjællands og Lolland-Falsters Politi.
  politi: [
    { url: 'https://via.ritzau.dk/rss/short-messages/latest?publisherId=90594', label: 'Sydsjællands og Lolland-Falsters Politi', areaDefault: true, alwaysShow: true }, // vises altid, uanset sted
  ],
  // Vejdirektoratets offentlige data bag trafikkort.vejdirektoratet.dk
  vd: {
    events: 'https://storage.googleapis.com/trafikkort-data/geojson/big-screen-events.json',
    critical: 'https://storage.googleapis.com/trafikkort-data/geojson/critical-announcements.json',
    maxKm: 9, // hændelser tættere end dette på en by i listen regnes som lokale
  },
  // DSB's side med akutte ændringer (ingen RSS – siden læses)
  dsb: { url: 'https://www.dsb.dk/trafikinformation/' },
  // Lokaltog (Østbanen Køge–Faxe Ladeplads): meddelelser via Ritzau + planlagte ændringer på lokaltog.dk
  lokaltog: {
    rss: [
      'https://via.ritzau.dk/rss/short-messages/latest?publisherId=13563063',
      'https://via.ritzau.dk/rss/releases/latest?publisherId=13563063',
    ],
    planned: 'https://www.lokaltog.dk/trafikinformation/planlagte-aendringer/',
    plannedDaysAhead: 3,
  },
  // DMI's officielle vejrvarsler (CAP via MeteoAlarm)
  dmi: {
    url: 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-denmark',
    // Varselsområder der dækker jeres kommuner
    areaRx: /(vestsjælland|sydsjælland|midtsjælland|sjælland(?!s odde)|zealand|møn|storebælt|great belt|smålandsfarvandet|faxe|næstved|slagelse|sorø|vordingborg|hele landet|danmark|denmark)/i,
  },
  // DMI's målinger (metObs): kun usædvanlige værdier i området de seneste timer
  dmiObs: {
    url: 'https://opendataapi.dmi.dk/v2/metObs/collections/observation/items',
    bbox: '11.0,54.9,12.6,55.6', // vest,syd,øst,nord – dækker de fem kommuner
    hours: 6,
    maxKm: 15,
    rules: [
      { param: 'wind_gust_always_past1h', min: 20, title: v => `Kraftige vindstød: ${v} m/s`, unit: 'm/s' },
      { param: 'wind_speed_past1h', min: 17, title: v => `Stormende kuling: middelvind ${v} m/s`, unit: 'm/s' },
      { param: 'precip_past1h', min: 10, title: v => `Kraftig regn: ${v} mm på en time`, unit: 'mm' },
      { param: 'temp_max_past1h', min: 28, title: v => `Høj temperatur: ${v} °C`, unit: '°C' },
      { param: 'temp_min_past1h', max: -10, title: v => `Streng frost: ${v} °C`, unit: '°C' },
      { param: 'visibility', max: 200, title: v => `Tæt tåge: sigtbarhed ${v} m`, unit: 'm' },
    ],
  },
  // DMI lyn: nedslag i området den seneste time, samlet pr. kommune
  dmiLightning: {
    url: 'https://opendataapi.dmi.dk/v2/lightningdata/collections/observation/items',
    bbox: '11.0,54.9,12.6,55.6', minutes: 60, maxKm: 12,
  },
  // DMI vandstand (havnemålere): usædvanligt høj eller lav vandstand de seneste timer
  dmiSea: {
    url: 'https://opendataapi.dmi.dk/v2/oceanObs/collections/observation/items',
    bbox: '11.0,54.9,12.6,55.6', hours: 6, maxKm: 12,
    high: 90, low: -80, // cm i forhold til normal (DVR90)
  },
  // Sund & Bælt (Storebæltsbroen): pressemeddelelser via Ritzau – kun Storebælt, ikke Øresund/Femern
  storebaelt: {
    rss: ['https://via.ritzau.dk/rss/releases/latest?publisherId=13559443', 'https://via.ritzau.dk/rss/short-messages/latest?publisherId=13559443'],
  },
  // Strømafbrydelser fra elnetselskabernes fælles platform (Green Power Denmark) – Cerius m.fl.
  el: {
    url: 'https://api.elnet.greenpowerdenmark.dk/api/incidents?showType=2&supplierId=0',
    maxKm: 10,
    hoursAhead: 24, // varslede afbrydelser vises, når de starter inden for så mange timer
    // Postnumre i de fem kommuner (bruges hvis koordinater mangler)
    zip: {
      Slagelse: ['4200','4220','4230','4241','4242','4243','4261','4291'],
      Sorø: ['4180','4293','4295','4173'],
      Næstved: ['4160','4171','4250','4262','4700','4684','4733','4736'],
      Faxe: ['4640','4653','4654','4683','4690'],
      Vordingborg: ['4720','4735','4750','4760','4771','4772','4773','4780','4791','4792','4793'],
    },
  },
  // Agersø-Omø-færgerne: ændringer i sejlplanen
  faerger: { url: 'https://aofaerger.slagelse.dk/da/sejlplan/aendringer-i-sejlplan/', daysAhead: 3 },
  // Politiets RSS har ingen brødtekst – den hentes fra selve meldingen for de nyeste (koster én forespørgsel pr. melding)
  politiBody: { maxItems: 6, maxHours: 48 },
  // Politimeldinger vises altid – undtagen når de nævner et af disse steder (ordet må gerne fortsætte, fx Rødbyhavn, Guldborgsund)
  politiExclude: ['Nakskov', 'Gedser', 'Guldborg', 'Rødby', 'Nykøbing F', 'Nyk. F'],
  // Lokale medier (RSS). Tilføj/fjern frit. Status vises i appen, så du kan se om et feed virker.
  // Kun artikler om hændelser (brand, uheld, politi osv.) fra medierne. Sæt til false for at få alle lokale artikler.
  mediaOnlyIncidents: true,
  mediaMaxChars: 200, // højst så mange anslag fra artiklen ud over overskriften
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
  ['Vestbanen', 'Sorø', 55.432, 11.556], ['Østbanen', 'Faxe', 55.255, 12.119], ['Faxe Syd', 'Faxe', 55.245, 12.130], ['110R', 'Faxe', 55.255, 12.119], ['Næstved St', 'Næstved', 55.229, 11.761],
  // Nabobyer uden for området (bruges kun til at sortere fra)
  ['Ringsted', null, 55.442, 11.790], ['Køge', null, 55.457, 12.182], ['Holbæk', null, 55.717, 11.713],
  ['Kalundborg', null, 55.681, 11.089], ['Nykøbing F', null, 54.766, 11.873], ['Stevns', null, 55.330, 12.380],
  ['Store Heddinge', null, 55.311, 12.389], ['Nyborg', null, 55.312, 10.790],
  // Lolland-Falster (samme politikreds, men uden for området)
  ['Lolland', null, 54.770, 11.500], ['Falster', null, 54.800, 11.950], ['Guldborgsund', null, 54.770, 11.870],
  ['Nyk. F', null, 54.766, 11.873], ['Nykøbing Falster', null, 54.766, 11.873], ['Nakskov', null, 54.831, 11.136],
  ['Maribo', null, 54.776, 11.500], ['Sakskøbing', null, 54.799, 11.645], ['Rødby', null, 54.695, 11.390],
  ['Nysted', null, 54.664, 11.736], ['Stubbekøbing', null, 54.887, 12.041], ['Gedser', null, 54.575, 11.928],
  ['Marielyst', null, 54.680, 11.960], ['Nørre Alslev', null, 54.897, 11.885], ['Holeby', null, 54.710, 11.460],
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

/** Forkorter tekst til højst n anslag, afbrudt ved et helt ord, med … til sidst. */
function shorten(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

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

/** Henter en kilde. Bruger ikke Cloudflares cache-API pr. kilde, da hvert opslag tæller med i
 *  gratisplanens grænse på 50 udgående forespørgsler pr. kørsel. I stedet caches hele feedet (se handler). */
async function fetchText(url, ctx) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Update by RH; redaktionelt overblik)', 'Accept': '*/*' },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  }).catch(e => { throw new Error(e && e.name === 'TimeoutError' ? 'svarede ikke inden ' + CONFIG.timeoutMs / 1000 + ' sek.' : (e && e.message) || 'netværksfejl'); });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
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
          time: parseDate(it.pubDate), title: it.title,
          text: source === 'medier' ? shorten(it.description, CONFIG.mediaMaxChars) : it.description.slice(0, 1200),
          url: it.link, place: pm ? pm.place : '', kommune: pm ? pm.kommune : null,
          lat: pm && pm.lat, lon: pm && pm.lon, inArea: pm ? pm.inArea : !!f.areaDefault, category,
        });
      }
    } catch (e) { errors.push(f.label + ': ' + e.message); }
  }));
  if (source === 'politi' && CONFIG.politiBody) {
    const minT = Date.now() - CONFIG.politiBody.maxHours * 36e5;
    const recent = items.filter(i => !i.text && i.url && i.time && Date.parse(i.time) >= minT)
      .sort((a, b) => b.time.localeCompare(a.time)).slice(0, CONFIG.politiBody.maxItems);
    await Promise.all(recent.map(async i => {
      try {
        const body = await politiBody(i.url, i.title);
        if (!body) return;
        i.text = body.slice(0, 1200);
        if (!i.kommune) { // stedet står ofte først i brødteksten
          // Fjern politikredsens navn og "Sydsjælland og Lolland-Falster" – det er afsender, ikke sted
          const clean = body.replace(/sydsjællands? og lolland-falsters? politi/gi, ' ').replace(/(sydsjælland|midt- og vestsjælland)\s+og\s+lolland-falster/gi, ' ')
            .replace(/lolland-falster/gi, ' ').replace(/politikreds\w*/gi, ' ')
            .replace(/(?<![\p{L}])(lolland|falster|guldborgsund)(?![\p{L}])/giu, ' '); // regionsord afgør ikke stedet
          const pm = matchPlace(clean);
          if (pm) {
            i.place = pm.place; i.kommune = pm.kommune; i.lat = pm.lat; i.lon = pm.lon; i.inArea = pm.inArea;
          }
        }
      } catch (_) { /* behold meldingen uden brødtekst */ }
    }));
  }
  if (list.some(f => f.alwaysShow)) { // politikredsens meldinger vises altid, undtagen de fravalgte steder
    const ex = new RegExp('(?<![\\p{L}])(' + (CONFIG.politiExclude || []).map(esc).join('|') + ')', 'iu');
    items.forEach(i => {
      // Retten i Nykøbing Falster er ikke hændelsens sted – fjern den, før der tjekkes
      const txt = (i.title + ' ' + (i.text || '')).replace(/retten\s+i\s+nykøbing\s+(f\.?|falster)/gi, ' ');
      // Nævner meldingen en by i området, vises den altid
      const local = PLACE_RX.some(({ p, rx }) => p[1] && rx.test(txt)) || KOMMUNE_RX.some(({ rx }) => rx.test(txt));
      if (local && !i.kommune) { const pm = matchPlace(txt); if (pm && pm.inArea) { i.kommune = pm.kommune; i.place = pm.place; } }
      i.inArea = local || !(CONFIG.politiExclude || []).length || !ex.test(txt);
    });
  }
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

const TRAIN_DISRUPT_RX = /(togbus|aflys|indstill|forsink|nedbrud|signalfejl|sporarbejde|ingen tog|kører ikke|færre tog|ændret køreplan|driftsforstyrr)/i;

/** Lokaltog: driftsmeddelelser/pressemeddelelser (Ritzau) og planlagte ændringer på Østbanen. */
async function srcLokaltog(ctx) {
  const items = [], errors = [];
  const cfg = CONFIG.lokaltog;
  await Promise.all(cfg.rss.map(async u => {
    try {
      for (const it of parseRss(await fetchText(u, ctx))) {
        const full = it.title + ' ' + it.description;
        const pm = matchPlace(full);
        const local = !!(pm && pm.inArea) || /østbanen/i.test(full);
        if (!local && !TRAIN_DISRUPT_RX.test(full)) continue; // fx udbud, festival-nyheder
        items.push({
          id: 'lokaltog-' + hash(((it.link || it.guid || it.title) + '').split('#')[0]), source: 'lokaltog', sourceLabel: 'Lokaltog',
          time: parseDate(it.pubDate), title: it.title, text: it.description.slice(0, 1200), url: it.link,
          place: pm ? pm.place : (local ? 'Østbanen' : ''), kommune: pm && pm.inArea ? pm.kommune : (local ? 'Faxe' : null),
          lat: pm && pm.lat, lon: pm && pm.lon, inArea: local, category: 'tog',
        });
      }
    } catch (e) { errors.push('Meddelelser: ' + e.message); }
  }));
  try {
    const html = await fetchText(cfg.planned, ctx);
    const now = Date.now(), horizon = now + cfg.plannedDaysAhead * 864e5;
    const seen = new Set();
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = stripHtml(m[2]).replace(/\s+/g, ' ').trim();
      if (!/østbanen/i.test(text) || text.length < 15) continue;
      const dates = [...text.matchAll(/(\d{1,2})\.\s*([a-zæøå]+)\.?\s*(\d{4})/gi)]
        .map(d => DA_MONTHS[d[2].slice(0, 3).toLowerCase()] ? danishLocalToIso(+d[3], DA_MONTHS[d[2].slice(0, 3).toLowerCase()], +d[1], 0, 0, 0) : null).filter(Boolean);
      const start = dates[0] ? Date.parse(dates[0]) : null;
      const end = dates[1] ? Date.parse(dates[1]) + 864e5 : (start ? start + 864e5 : null);
      if (start && (start > horizon || end < now)) continue; // kun igangværende eller snart kommende
      const href = m[1].startsWith('http') ? m[1] : 'https://www.lokaltog.dk' + (m[1].startsWith('/') ? '' : '/') + m[1];
      if (seen.has(href)) continue; seen.add(href);
      const faxeLine = /110R|faxe/i.test(text);
      items.push({
        id: 'lokaltog-' + hash(href + text), source: 'lokaltog', sourceLabel: 'Lokaltog · planlagt',
        time: dates[0] || null, until: dates[1] ? new Date(end).toISOString() : null,
        title: text.replace(/^[\d/R ]+Østbanen\s*/i, 'Østbanen: ').slice(0, 160), text,
        url: href, place: 'Østbanen', kommune: faxeLine ? 'Faxe' : null, inArea: faxeLine, category: 'tog',
      });
    }
  } catch (e) { errors.push('Planlagte ændringer: ' + e.message); }
  return { items, errors };
}

const DMI_EVENTS = [
  [/thunder|torden/i, 'Torden'], [/rain|regn|skybrud/i, 'Kraftig regn'], [/snow|ice|sne|is(?![\p{L}])|glat/iu, 'Sne og is'],
  [/wind|vind|storm/i, 'Vind/storm'], [/fog|tåge/i, 'Tåge'], [/coastal|flood|vandstand|stormflod|oversvøm/i, 'Høj vandstand/stormflod'],
  [/high.?temp|heat|hede|varme/i, 'Hedebølge'], [/low.?temp|cold|frost|kulde/i, 'Kulde'], [/forest|fire|brand/i, 'Brandfare'],
];
const DMI_LEVEL = { minor: 'Mindre', moderate: 'Moderat', severe: 'Kraftigt', extreme: 'Ekstremt' };

/** DMI: officielle vejrvarsler (CAP/Atom via MeteoAlarm). */
async function srcDmi(ctx) {
  const items = [], errors = [];
  try {
    const xml = await fetchText(CONFIG.dmi.url, ctx);
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const b of entries) {
      const area = stripHtml(tag(b, 'cap:areaDesc'));
      const event = stripHtml(tag(b, 'cap:event')) || stripHtml(tag(b, 'title'));
      const sev = (tag(b, 'cap:severity') || '').toLowerCase();
      const issued = parseDate(tag(b, 'cap:effective') || tag(b, 'cap:sent') || tag(b, 'updated') || tag(b, 'published'));
      const onset = parseDate(tag(b, 'cap:onset')) || issued;
      const fmt = d => new Date(d).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const expires = parseDate(tag(b, 'cap:expires'));
      const msgType = tag(b, 'cap:message_type') || tag(b, 'cap:msgType');
      if (/cancel/i.test(msgType)) continue;
      const kind = (DMI_EVENTS.find(([rx]) => rx.test(event)) || [null, event])[1];
      const level = DMI_LEVEL[sev] || '';
      const local = CONFIG.dmi.areaRx.test(area) && !/^(nordsjælland|north zealand|københavn|copenhagen|bornholm)$/i.test(area.trim());
      const pm = matchPlace(area);
      let link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
      items.push({
        id: 'dmi-' + hash(kind + area + (onset || '')), source: 'dmi', sourceLabel: 'DMI-varsel',
        time: issued || onset, until: expires,
        title: (level ? level + ' varsel: ' : 'Varsel: ') + kind.toLowerCase(),
        text: [area && 'Område: ' + area, (onset || expires) && 'Gælder ' + (onset ? 'fra ' + fmt(onset) + ' ' : '') + (expires ? 'til ' + fmt(expires) : ''), event !== kind ? '(' + event + ')' : ''].filter(Boolean).join(' · '),
        url: 'https://www.dmi.dk/varsler/', place: area, kommune: pm && pm.inArea ? pm.kommune : null,
        lat: null, lon: null, inArea: local, category: 'vejr',
      });
    }
  } catch (e) { errors.push(e.message); }
  return { items, errors };
}

/** DMI-målinger: henter observationer og melder kun dem, der passerer en tærskel. */
async function srcDmiObs(ctx) {
  const items = [], errors = [];
  const cfg = CONFIG.dmiObs;
  const end = Math.ceil(Date.now() / 6e5) * 6e5; // rundet op til 10 min, så svaret kan caches
  const to = new Date(end), from = new Date(end - cfg.hours * 36e5);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  await Promise.all(cfg.rules.map(async rule => {
    try {
      const u = `${cfg.url}?parameterId=${rule.param}&bbox=${cfg.bbox}&datetime=${iso(from)}/${iso(to)}&limit=2000`;
      const data = JSON.parse(await fetchText(u, ctx));
      const best = new Map(); // station → mest ekstreme måling
      for (const f of (data.features || [])) {
        const p = f.properties || {}, v = +p.value;
        if (!isFinite(v)) continue;
        const hit = rule.min != null ? v >= rule.min : v <= rule.max;
        if (!hit) continue;
        const prev = best.get(p.stationId);
        const more = !prev || (rule.min != null ? v > prev.v : v < prev.v);
        if (more) best.set(p.stationId, { v, at: p.observed, c: centroid(f.geometry) });
      }
      for (const [station, m] of best) {
        let place = 'station ' + station, kommune = null, inArea = false, lat = null, lon = null;
        if (m.c) {
          lat = m.c.lat; lon = m.c.lon;
          const n = nearestPlace(lat, lon);
          if (n && n.d <= cfg.maxKm) { place = n.p[0] + (n.d > 3 ? ' (' + n.d.toFixed(0) + ' km)' : ''); kommune = n.p[1]; inArea = !!n.p[1]; }
        }
        const val = String(Math.round(m.v * 10) / 10).replace('.', ',');
        items.push({
          id: 'dmiobs-' + hash(station + rule.param + String(m.at || '').slice(0, 10)), source: 'dmi', sourceLabel: 'DMI-måling',
          time: parseDate(m.at), title: rule.title(val),
          text: `Målt ved DMI-station ${station}${place ? ' nær ' + place.replace(/^station \d+$/, '') : ''}. Rå måling, ikke kvalitetskontrolleret af DMI.`.replace(' nær .', '.'),
          url: 'https://www.dmi.dk/vejrarkiv/', place, kommune, lat, lon, inArea, category: 'vejr',
        });
      }
    } catch (e) { errors.push('Målinger (' + rule.param + '): ' + e.message); }
  }));
  return { items, errors };
}

const isoMin = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const roundedNow = () => Math.ceil(Date.now() / 3e5) * 3e5; // 5 min, så svar kan caches

/** DMI lyn: tæller nedslag pr. kommune den seneste time. */
async function srcDmiLightning(ctx) {
  const items = [], errors = [];
  const cfg = CONFIG.dmiLightning;
  try {
    const end = roundedNow(), start = end - cfg.minutes * 6e4;
    const u = `${cfg.url}?bbox=${cfg.bbox}&datetime=${isoMin(start)}/${isoMin(end)}&limit=5000`;
    const data = JSON.parse(await fetchText(u, ctx));
    const per = new Map(); // kommune → {n, last, places}
    for (const f of (data.features || [])) {
      const c = centroid(f.geometry); if (!c) continue;
      const n = nearestPlace(c.lat, c.lon);
      if (!n || n.d > cfg.maxKm || !n.p[1]) continue;
      const k = n.p[1], p = f.properties || {};
      const e = per.get(k) || { n: 0, last: null, places: new Map() };
      e.n += Math.max(1, +p.strokes || 1);
      if (!e.last || (p.observed || '') > e.last) e.last = p.observed;
      e.places.set(n.p[0], (e.places.get(n.p[0]) || 0) + 1);
      per.set(k, e);
    }
    for (const [k, e] of per) {
      const top = [...e.places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
      items.push({
        id: 'dmilyn-' + hash(k + String(e.last || '').slice(0, 13)), source: 'dmi', sourceLabel: 'DMI-lyn',
        time: parseDate(e.last), title: `Lyn: ${e.n} nedslag i ${k} Kommune seneste time`,
        text: 'Flest nær ' + top.join(', ') + '. Registreret af DMI\'s lynpejlere.',
        url: 'https://www.dmi.dk/lynkort/', place: top[0], kommune: k, inArea: true, category: 'vejr',
      });
    }
  } catch (e) { errors.push('Lyn: ' + e.message); }
  return { items, errors };
}

/** DMI vandstand: melder usædvanligt høj/lav vandstand ved havnemålerne i området. */
async function srcDmiSea(ctx) {
  const items = [], errors = [];
  const cfg = CONFIG.dmiSea;
  try {
    const end = roundedNow(), start = end - cfg.hours * 36e5;
    const u = `${cfg.url}?parameterId=sealev_dvr&bbox=${cfg.bbox}&datetime=${isoMin(start)}/${isoMin(end)}&limit=5000`;
    const data = JSON.parse(await fetchText(u, ctx));
    const best = new Map(); // station → mest ekstreme
    for (const f of (data.features || [])) {
      const p = f.properties || {}, v = +p.value; if (!isFinite(v)) continue;
      if (v < cfg.high && v > cfg.low) continue;
      const prev = best.get(p.stationId);
      if (!prev || Math.abs(v) > Math.abs(prev.v)) best.set(p.stationId, { v, at: p.observed, c: centroid(f.geometry) });
    }
    for (const [st, m] of best) {
      const n = m.c ? nearestPlace(m.c.lat, m.c.lon) : null;
      const ok = n && n.d <= cfg.maxKm;
      const place = ok ? n.p[0] : 'station ' + st, kommune = ok ? n.p[1] : null;
      const high = m.v > 0;
      items.push({
        id: 'dmihav-' + hash(st + (high ? 'h' : 'l') + String(m.at || '').slice(0, 10)), source: 'dmi', sourceLabel: 'DMI-vandstand',
        time: parseDate(m.at), title: `${high ? 'Høj' : 'Lav'} vandstand: ${high ? '+' : ''}${Math.round(m.v)} cm ved ${place}`,
        text: `Højeste udsving målt ved havnemåler ${st} de seneste ${cfg.hours} timer (cm i forhold til normal vandstand, DVR90). Rå måling.`,
        url: 'https://www.dmi.dk/hav-og-is/temaforside-hav/vandstand/', place, kommune, lat: m.c && m.c.lat, lon: m.c && m.c.lon,
        inArea: !!kommune, category: 'vejr',
      });
    }
  } catch (e) { errors.push('Vandstand: ' + e.message); }
  return { items, errors };
}

/** Sund & Bælt: meddelelser om Storebæltsbroen. */
async function srcStorebaelt(ctx) {
  const items = [], errors = [];
  await Promise.all(CONFIG.storebaelt.rss.map(async u => {
    try {
      for (const it of parseRss(await fetchText(u, ctx))) {
        const full = it.title + ' ' + it.description;
        if (!/storebælt|korsør|halsskov|sprogø|vestbro|østbro/i.test(full)) continue; // Øresund, Femern m.m. springes over
        items.push({
          id: 'storebaelt-' + hash(((it.link || it.guid || it.title) + '').split('#')[0]), source: 'storebaelt', sourceLabel: 'Sund & Bælt',
          time: parseDate(it.pubDate), title: it.title, text: it.description.slice(0, 1200), url: it.link,
          place: 'Storebæltsbroen', kommune: 'Slagelse', lat: 55.338, lon: 11.05, inArea: true, category: 'trafik',
        });
      }
    } catch (e) { errors.push(e.message); }
  }));
  return { items, errors };
}

/** Strømafbrydelser: aktive og snarligt varslede afbrydelser i området. */
async function srcEl(ctx) {
  const items = [], errors = [];
  const cfg = CONFIG.el;
  // tider uden tidszone er dansk lokal tid
  const local = s => { if (!s) return null; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? danishLocalToIso(+m[1], +m[2], +m[3], +m[4], +m[5], 0) : parseDate(s); };
  const fmt = iso => new Date(iso).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  try {
    const data = JSON.parse(await fetchText(cfg.url, ctx));
    const now = Date.now();
    for (const r of (Array.isArray(data) ? data : (data.value || data.items || []))) {
      if (r.incidentStatusId != null && r.incidentStatusId !== 1) continue; // kun aktive
      const start = local(r.startDate), end = local(r.endDate), expected = local(r.expectedDowntime);
      if (start && Date.parse(start) > now + cfg.hoursAhead * 36e5) continue;
      if (end && Date.parse(end) < now) continue;
      let place = '', kommune = null, inArea = false;
      if (r.centerLat && r.centerLng) {
        const n = nearestPlace(+r.centerLat, +r.centerLng);
        if (n && n.d <= cfg.maxKm) { place = n.p[0]; kommune = n.p[1]; inArea = !!n.p[1]; }
      }
      const zips = String(r.zipcodes || '').split(/[,; ]+/).filter(Boolean);
      if (!inArea) {
        const k = Object.keys(cfg.zip).find(k => zips.some(z => cfg.zip[k].includes(z)));
        if (k) { inArea = true; kommune = k; place = place || 'postnr. ' + zips.join(', '); }
      }
      if (!inArea) { const pm = matchPlace(r.title || ''); if (pm && pm.inArea) { inArea = true; place = pm.place; kommune = pm.kommune; } }
      if (!inArea) continue; // resten af landet springes over
      const n = +r.effectedCustomers || 0;
      const title = (r.title || 'Strømafbrydelse').trim() + (n ? ` – ${n.toLocaleString('da-DK')} kunder` : '');
      const text = [
        [r.incidentType, r.supplierName].filter(Boolean).join(' · '),
        start && 'Start: ' + fmt(start), (end || expected) && (end ? 'Slut: ' : 'Forventet slut: ') + fmt(end || expected),
        zips.length && 'Postnr.: ' + zips.join(', '),
        r.cause && stripHtml(r.cause), r.comment && stripHtml(r.comment),
      ].filter(Boolean).join('\n');
      const web = r.supplierWeb ? (/^https?:/.test(r.supplierWeb) ? r.supplierWeb : 'https://' + r.supplierWeb.replace(/^\/+/, '')) : '';
      items.push({
        id: 'el-' + (r.id || hash(title + start)), source: 'el', sourceLabel: 'Strømafbrydelse',
        time: start || local(r.created), until: end || null, title, text: text.slice(0, 1200),
        url: /cerius/i.test(r.supplierName || '') ? 'https://cerius.dk/stroemafbrydelse/' : (web || 'https://elnet.dk/'),
        place, kommune, lat: +r.centerLat || null, lon: +r.centerLng || null, inArea, category: 'forsyning',
      });
    }
  } catch (e) { errors.push(e.message); }
  return { items, errors };
}

/** Agersø-Omø-færgerne: ændringer i sejlplanen, læst som tekst fra siden. */
async function srcFaerger(ctx) {
  const items = [], errors = [];
  try {
    const html = await fetchText(CONFIG.faerger.url, ctx);
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<picture[\s\S]*?<\/picture>/gi, ' ');
    const lines = decodeEntities(body.replace(/<[^>]+>/g, '\n')).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let a = lines.findIndex(l => /^få overblik over/i.test(l)); if (a < 0) a = lines.findIndex(l => /^ændringer i sejlplan$/i.test(l));
    let b = lines.findIndex((l, k) => k > a && /^agersø omø færgerne$/i.test(l)); if (b < 0) b = lines.length;
    const now = Date.now(), horizon = now + CONFIG.faerger.daysAhead * 864e5;
    let ferry = '', cur = null;
    const flush = () => {
      if (!cur) return;
      const dm = cur.title.match(/(\d{1,2})[./](\d{1,2})[-./](\d{4})/);
      const date = dm ? danishLocalToIso(+dm[3], +dm[2], +dm[1], 0, 0, 0) : null;
      const day = date ? Date.parse(date) : null;
      if (!day || (day <= horizon && day + 864e5 >= now)) {
        items.push({
          id: 'faerge-' + hash(ferry + cur.title + cur.lines.join('|')), source: 'faerger', sourceLabel: ferry || 'Agersø-Omø-færgerne',
          time: date, until: day ? new Date(day + 864e5).toISOString() : null,
          title: cur.title, text: cur.lines.join('\n'), url: CONFIG.faerger.url,
          place: /omø/i.test(ferry) ? 'Omø' : 'Agersø', kommune: 'Slagelse', inArea: true, category: 'faerge',
        });
      }
      cur = null;
    };
    for (const l of lines.slice(a + 1, b)) {
      if (/^(agersø|omø)færgen$/i.test(l)) { flush(); ferry = l; continue; }
      if (/sejler ikke|aflys|ændr|ekstra|erstatning|reduceret|dok|værft|nødsejlplan|ingen afgang|indstill/i.test(l) && !/^(stigsnæs|agersø|omø) kl/i.test(l)) { flush(); cur = { title: l, lines: [] }; continue; }
      if (cur) cur.lines.push(l);
    }
    flush();
  } catch (e) { errors.push(e.message); }
  return { items, errors };
}

/** Henter brødteksten til en politimelding fra Ritzaus side (tekst efter overskriften, før "Abonner på ..."). */
async function politiBody(link, title) {
  const html = await fetchText(link.split('#')[0]);
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<head[\s\S]*?<\/head>/i, ' ');
  const lines = decodeEntities(clean.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const t = (title || '').trim().toLowerCase();
  let a = lines.findIndex(l => l.toLowerCase() === t);
  if (a < 0) a = lines.findIndex(l => t && l.toLowerCase().includes(t.slice(0, 40)));
  if (a < 0) return '';
  const out = [];
  for (const l of lines.slice(a + 1)) {
    if (/^abonner\b|^flere meddelelser|^følg pressemeddelelser|^kontakter?$/i.test(l)) break;
    if (/^\d{1,2}\.\d{1,2}\.\d{4} \d{1,2}:\d{2}/.test(l) || /\| (myndighedsmeddelelse|pressemeddelelse)$/i.test(l) || /politi$/i.test(l) && l.length < 60 && !out.length) continue; // dato- og afsenderlinje
    if (l.toLowerCase() === t) continue;
    if (/^(sydsjællands og lolland-falsters politi|midt- og vestsjællands politi)$/i.test(l)) continue; // afsenderlinje
    out.push(l);
    if (out.join(' ').length > 1200) break;
  }
  return out.join('\n').trim();
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
    ['lokaltog', 'Lokaltog', () => srcLokaltog(ctx)],
    ['storebaelt', 'Sund & Bælt', () => srcStorebaelt(ctx)],
    ['faerger', 'Færger', () => srcFaerger(ctx)],
    ['el', 'Strøm', () => srcEl(ctx)],
    ['dmi', 'DMI', async () => {
      const parts = await Promise.all([srcDmi(ctx), srcDmiObs(ctx), srcDmiLightning(ctx), srcDmiSea(ctx)]);
      return { items: parts.flatMap(p => p.items), errors: parts.flatMap(p => p.errors) };
    }],
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
    if (url.pathname === '/api/debug-pol') {
      // Midlertidig testside (runde 2): læser listesidens datamodel og prøver /api/news/getNewsResults
      const get = async (u, ms = 9000) => {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'da-DK,da', 'Referer': 'https://politi.dk/doegnrapporter' }, signal: AbortSignal.timeout(ms) });
          return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
        } catch (e) { return { error: String(e && e.message || e) }; }
      };
      const out = { version: VERSION };
      const list = await get('https://politi.dk/doegnrapporter?district=Sydsjaellands-og-Lolland-Falsters-Politi');
      const lt = decodeEntities(list.text || '');
      const around = k => { const i = lt.indexOf(k); return i >= 0 ? lt.slice(Math.max(0, i - 300), i + 1500) : null; };
      out.model_hints = { ListId: around('ListId'), DistrictsList: around('DistrictsList'), NewsTypesList: around('NewsTypesList'), ngInit: (lt.match(/ng-init="[^"]{0,1500}/) || [null])[0] };
      // forsøg at finde værdierne
      const listId = (lt.match(/"ListId"\s*:\s*"?([^",}]+)/) || [])[1];
      const lang = (lt.match(/"Language"\s*:\s*"([^"]+)"/) || [])[1] || 'da';
      const dm = [...lt.matchAll(/\{\s*"Id"\s*:\s*"?([^",}]+)"?\s*,\s*"Name"\s*:\s*"([^"]+)"/g)].map(m => ({ id: m[1], name: m[2] }));
      const sydsj = dm.find(d => /sydsjælland|sydsjaelland/i.test(d.name));
      const types = [...new Set([...lt.matchAll(/"(?:Name|Title|TabTitle)"\s*:\s*"([^"]*[Dd]øgn[^"]*)"/g)].map(m => m[1]))];
      out.found = { listId, lang, districts: dm.slice(0, 20), sydsj, types };
      out.tries = [];
      const base = 'https://politi.dk/api/news/getNewsResults';
      const combos = [];
      const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      for (const nt of (types.length ? types : ['Døgnrapport', 'Døgnrapporter'])) {
        combos.push({ page: 0, pageSize: 10, newsType: nt, itemId: listId || '', language: lang, districtQuery: sydsj ? sydsj.id : '', isNewsList: true });
        combos.push({ page: 0, pageSize: 10, fromDate: from, toDate: to, newsType: nt, itemId: listId || '', language: lang, districtQuery: sydsj ? sydsj.id : '', isNewsList: true });
      }
      for (const c of combos.slice(0, 4)) {
        const qs = new URLSearchParams(Object.entries(c).map(([k, v]) => [k, String(v)])).toString();
        const r = await get(base + '?' + qs);
        out.tries.push({ qs, status: r.status, type: r.type, error: r.error, start: (r.text || '').slice(0, 1500) });
      }
      return new Response(JSON.stringify(out, null, 1), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (url.pathname === '/api/feed') {
      // Hele feedet caches i CONFIG.cacheSeconds, så mange samtidige brugere ikke henter alle kilder hver gang.
      const cache = caches.default;
      const key = new Request(url.origin + '/api/feed?v=' + VERSION, { method: 'GET' });
      try { const hit = await cache.match(key); if (hit) return hit; } catch (_) {}
      let body;
      try { body = await buildFeed(ctx); }
      catch (e) { body = { updated: new Date().toISOString(), items: [], sources: [], error: String(e && e.stack || e) }; }
      const res = new Response(JSON.stringify(body), {
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + CONFIG.cacheSeconds },
      });
      try { ctx.waitUntil(cache.put(key, res.clone())); } catch (_) {}
      return res;
    }
    return new Response('Update by RH: worker kører (version ' + VERSION + '). Data: /api/feed', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

// Eksporter til test i Node (ignoreres af Cloudflare)
export const _test = { parseRss, parseDate, matchPlace, nearestPlace, stripHtml, srcOdin, srcVd, srcDsb, srcLokaltog, srcStorebaelt, srcEl, srcFaerger, srcDmi, srcDmiObs, srcDmiLightning, srcDmiSea, parseDaDate, srcRss, buildFeed, CONFIG };
