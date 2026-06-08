export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate');

  const source = req.query.source || 'sideevents';
  const key = process.env.BROWSERLESS_KEY;

  try {

    // ── 1. SEORS SIDE EVENTS (plain HTML, no browser needed) ──────
    if (source === 'sideevents') {
      const url = 'https://seors.unfccc.int/reports/events_list.html?session_id=SB%2064';
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SB64Observer/1.0)' }
      });
      if (!r.ok) throw new Error('SEORS fetch failed: ' + r.status);
      const html = await r.text();
      const events = parseSEORS(html);
      return res.status(200).json({ source: 'seors', fetchedAt: new Date().toISOString(), events });
    }

    // ── 2. UNFCCC SPECIAL/MANDATED EVENTS (JS-rendered, needs browser) ──
    if (source === 'specials') {
      if (!key) throw new Error('No BROWSERLESS_KEY');
      // Fetch the UNFCCC calendar filtered to June 2026
      const html = await browserlessGet(
        'https://unfccc.int/calendar/events-list',
        key
      );
      const events = parseCalendarPage(html);
      return res.status(200).json({ source: 'specials', fetchedAt: new Date().toISOString(), events });
    }

    // ── 3. UNFCCC NEGOTIATIONS SCHEDULE (JS-rendered, needs browser) ──
    if (source === 'negotiations') {
      if (!key) throw new Error('No BROWSERLESS_KEY');
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const debug = req.query.debug === '1';
      const html = await browserlessGet('https://unfccc.int/sb64/schedule?date=' + date, key);
      if (debug) {
        return res.status(200).json({ debug: true, htmlLength: html.length, preview: html.slice(0, 3000) });
      }
      const sessions = parseSchedulePage(html);
      return res.status(200).json({ source: 'unfccc-schedule', date, fetchedAt: new Date().toISOString(), sessions });
    }

    return res.status(400).json({ error: 'Unknown source. Use sideevents, specials, or negotiations' });

  } catch (err) {
    console.error('[schedule]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── BROWSERLESS HELPER ───────────────────────────────────────────
async function browserlessGet(url, key) {
  // Use /unblock which handles bot detection (UNFCCC blocks basic headless browsers)
  const endpoint = 'https://production-sfo.browserless.io/unblock?token=' + key;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify({
      url: url,
      browserWSEndpoint: false,
      cookies: false,
      content: true,
      screenshot: false,
      ttl: 10000
    })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error('Browserless ' + r.status + ': ' + body.slice(0, 300));
  }
  const data = await r.json();
  return data.content || '';
}

// ── STRIP HTML TAGS ──────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── PARSE UNFCCC SCHEDULE PAGE ───────────────────────────────────
function parseSchedulePage(html) {
  const sessions = [];
  const text = stripHtml(html);

  // Split on time patterns: "10:00 - 11:00" or "10:00–11:00"
  const parts = text.split(/(\d{1,2}:\d{2}\s*[-–—]+\s*\d{1,2}:\d{2})/);

  for (let i = 1; i < parts.length - 1; i += 2) {
    const time = parts[i].replace(/\s+/g, '').replace('--','-').replace('—','-').replace('–','-');
    const body = parts[i + 1].slice(0, 300).trim();
    if (!body || body.length < 5) continue;

    const lower = body.toLowerCase();

    // Skip clearly non-session content
    if (lower.includes('back to sb') || lower.includes('filter') || lower.includes('footer')) continue;

    const isForest = FOREST_KW.some(kw => lower.includes(kw));
    const isOpen   = lower.includes('open') || lower.includes('plenary') || lower.includes('webcast');
    const isNego   = lower.includes('contact group') || lower.includes('informal') ||
                     lower.includes('sbsta') || lower.includes('sbi ') || lower.includes('negotiat');

    const roomMatch = body.match(/\b(Nairobi|Wien|Genf|Berlin|Bonn|Plenary|New York|Paris|Sydney|Bern|Hall)\b/i);
    const title = body.replace(/\s+/g, ' ').slice(0, 120).trim();

    sessions.push({
      time,
      title,
      room: roomMatch ? roomMatch[0] : '',
      isForest,
      isOpen,
      isNego
    });
  }

  return sessions;
}

// ── PARSE UNFCCC CALENDAR PAGE (special/mandated events) ─────────
function parseCalendarPage(html) {
  const events = [];
  const text = stripHtml(html);

  // Look for date patterns: "09 Jun 2026" or "June 9, 2026"
  const datePattern = /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+202\d)/gi;
  const chunks = text.split(datePattern);

  for (let i = 1; i < chunks.length - 1; i += 2) {
    const dateStr = chunks[i].trim();
    const body = chunks[i + 1].slice(0, 400).trim();

    // Only include June 2026 events
    if (!dateStr.match(/Jun/i)) continue;

    const lower = body.toLowerCase();

    // Extract time if present
    const timeMatch = body.match(/(\d{1,2}:\d{2})\s*h?\s*[-–]\s*(\d{1,2}:\d{2})/);
    const time = timeMatch ? timeMatch[1] + '-' + timeMatch[2] : '';

    // Get title — first meaningful chunk of text
    const title = body.replace(/\s+/g, ' ').slice(0, 150).trim();

    // Extract location if present
    const roomMatch = body.match(/(?:Bonn|Berlin|Nairobi|UN Campus|Lower Conference|Plenary)[^\n,.]*/i);

    events.push({
      date: dateStr,
      time,
      title,
      room: roomMatch ? roomMatch[0].trim().slice(0, 60) : 'Bonn',
      isForest: FOREST_KW.some(kw => lower.includes(kw)),
      isSpecial: true
    });
  }

  return events;
}

// ── PARSE SEORS HTML ─────────────────────────────────────────────
function parseSEORS(html) {
  const events = [];
  const strip = s => s.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cell;
    while ((cell = cellRe.exec(row[1])) !== null) cells.push(strip(cell[1]));
    if (cells.length < 2) continue;

    const titleMatch = row[1].match(/<strong>([^<]{10,200})<\/strong>/);
    if (!titleMatch) continue;

    const dateCell = cells[0] || '';
    const timeRoom = cells[1] || '';
    const dateMatch = dateCell.match(/(\w+day),?\s+(\d{2}\s+\w+\s+\d{4})/);
    const timeMatch = timeRoom.match(/(\d{2}:\d{2}[^a-zA-Z\d]*\d{2}:\d{2})/);
    const roomMatch = timeRoom.replace(/\d{2}:\d{2}[^\n]*/, '').trim().slice(0, 30);

    events.push({
      date: dateMatch ? dateMatch[2].trim() : '',
      weekday: dateMatch ? dateMatch[1].trim() : '',
      time: timeMatch ? timeMatch[1].replace(/[–—]/g,'–') : '',
      room: roomMatch,
      title: strip(titleMatch[1])
    });
  }
  return events;
}

// ── FOREST KEYWORDS ──────────────────────────────────────────────
const FOREST_KW = [
  'forest','deforest','redd','lulucf','land use','nairobi work','nwp',
  'nature-based','nature based','nbs ','nbs,','ecosystem','biodiversity',
  'restoration','landscape','mangrove','wetland','peatland','taff',
  'rio convention','synerg','unccd','cbd','woodland','agroforest',
  'savanna','conservation','habitat','agriculture','food','sjwa',
  'koronivia','mountain','adaptation','resilience','loss and damage',
  'article 6','gga','global goal','turning the tide','presidency roadmap',
  'halting','deforestation roadmap','forest roadmap'
];
