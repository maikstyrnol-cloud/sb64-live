export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate');

  const source = req.query.source || 'sideevents';

  try {
    if (source === 'sideevents') {
      const url = 'https://seors.unfccc.int/reports/events_list.html?session_id=SB%2064';
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SB64Observer/1.0)', 'Accept': 'text/html' }
      });
      if (!response.ok) throw new Error('SEORS fetch failed: ' + response.status);
      const html = await response.text();
      const events = parseSEORS(html);
      return res.status(200).json({ source: 'seors', fetchedAt: new Date().toISOString(), events });
    }

    if (source === 'negotiations') {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const key = process.env.BROWSERLESS_KEY;
      if (!key) throw new Error('No BROWSERLESS_KEY set');

      // Use Browserless to render the UNFCCC schedule page with JS
      const targetUrl = `https://unfccc.int/sb64/schedule?date=${date}`;

      const browserlessRes = await fetch(`https://production-sfo.browserless.io/content?token=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          gotoOptions: { waitUntil: 'networkidle2', timeout: 15000 }
        })
      });

      if (!browserlessRes.ok) {
        const err = await browserlessRes.text();
        throw new Error('Browserless error: ' + browserlessRes.status + ' ' + err.slice(0, 200));
      }

      const bodyText = await browserlessRes.text();

      const sessions = parseSchedulePage(bodyText, date);
      return res.status(200).json({ source: 'unfccc-schedule', date, fetchedAt: new Date().toISOString(), sessions });
    }

    return res.status(400).json({ error: 'Unknown source' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── PARSE UNFCCC SCHEDULE PAGE HTML ─────────────────────────────
function parseSchedulePage(html, date) {
  const sessions = [];

  // Strip HTML tags to get plain text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');

  const FOREST_KW = ['forest','deforest','redd','lulucf','land use','nairobi work','nwp',
    'nature-based','nature based','nbs ','ecosystem','biodiversity','restoration','landscape',
    'mangrove','wetland','peatland','rio convention','synerg','unccd','cbd','taff','woodland',
    'agroforest','savanna','conservation','habitat','agriculture','food','sjwa','koronivia',
    'mountain','adaptation','resilience','loss and damage','article 6'];

  // Match time patterns like "10:00 - 11:00" or "10:00–11:00"
  const timeRegex = /(\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}:\d{2})/g;
  const chunks = text.split(timeRegex);

  for (let i = 1; i < chunks.length - 1; i += 3) {
    const startTime = chunks[i];
    const endTime   = chunks[i + 1];
    const body      = (chunks[i + 2] || '').slice(0, 400).trim();

    if (!startTime || !endTime) continue;

    const lower = body.toLowerCase();
    const isForest = FOREST_KW.some(kw => lower.includes(kw));
    const isOpen   = lower.includes('open') || lower.includes('plenary') || lower.includes('webcast');
    const isNego   = lower.includes('contact group') || lower.includes('informal') ||
                     lower.includes('sbsta') || lower.includes('sbi ');

    // Extract a reasonable title from the body text (first 80 chars, clean up)
    const title = body.replace(/\s+/g, ' ').slice(0, 100).trim();
    // Try to find room (usually a word like "Nairobi", "Wien", "Plenary", "Berlin", "Bonn")
    const roomMatch = body.match(/\b(Nairobi|Wien|Genf|Berlin|Bonn|Plenary Hall|New York|Paris|Sydney|Bern)\b/i);

    if (isNego || isForest) {
      sessions.push({
        time: startTime + '\u2013' + endTime,
        title: title,
        room: roomMatch ? roomMatch[1] : '',
        isForest,
        isOpen,
        isNego
      });
    }
  }

  return sessions;
}

// ── PARSE SEORS HTML ─────────────────────────────────────────────
function parseSEORS(html) {
  const events = [];
  const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g, ' ').trim();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length < 3) continue;

    const dateCell = cells[0] || '';
    const timeRoom = cells[1] || '';
    const orgTitle = cells[2] || '';

    const dateMatch = dateCell.match(/(\w+day),?\s+(\d{2}\s+\w+\s+\d{4})/);
    const timeMatch = timeRoom.match(/(\d{2}:\d{2}[^a-zA-Z\d]*\d{2}:\d{2})/);
    const roomMatch = timeRoom.match(/\d{2}:\d{2}[^\n]*\n?\s*([A-Za-z][^\n]{1,30})/);

    const titleMatch = row.match(/<strong>([^<]{10,200})<\/strong>/);

    if (titleMatch) {
      events.push({
        date: dateMatch ? dateMatch[2].trim() : '',
        weekday: dateMatch ? dateMatch[1].trim() : '',
        time: timeMatch ? timeMatch[1].replace(/[–—]/g, '–').trim() : '',
        room: roomMatch ? roomMatch[1].trim() : timeRoom.slice(0, 30),
        title: stripTags(titleMatch[1]),
        orgs: orgTitle.slice(0, 150)
      });
    }
  }

  return events;
}
