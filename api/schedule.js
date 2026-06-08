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

      const browserlessRes = await fetch(`https://chrome.browserless.io/scrape?token=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          waitFor: 3000, // wait 3s for JS to load
          elements: [{ selector: 'body' }]
        })
      });

      if (!browserlessRes.ok) {
        const err = await browserlessRes.text();
        throw new Error('Browserless error: ' + browserlessRes.status + ' ' + err.slice(0, 200));
      }

      const data = await browserlessRes.json();
      const bodyText = data?.data?.[0]?.results?.[0]?.text || '';

      const sessions = parseSchedulePage(bodyText, date);
      return res.status(200).json({ source: 'unfccc-schedule', date, fetchedAt: new Date().toISOString(), sessions });
    }

    return res.status(400).json({ error: 'Unknown source' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── PARSE UNFCCC SCHEDULE PAGE TEXT ─────────────────────────────
// The rendered page text contains lines like:
// "10:00 - 11:00  SBSTA 64 opening plenary  Plenary Hall  Open"
function parseSchedulePage(text, date) {
  const sessions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);

  const FOREST_KW = ['forest','deforest','redd','lulucf','land use','nairobi work','nwp',
    'nature-based','nature based','nbs','ecosystem','biodiversity','restoration','landscape',
    'mangrove','wetland','peatland','rio convention','synerg','unccd','cbd','taff','woodland',
    'agroforest','savanna','conservation','habitat','agriculture','food','sjwa','koronivia',
    'mountains','mountain','adaptation','resilience','loss and damage','article 6'];

  const timeRegex = /^(\d{1,2}:\d{2})\s*[–\-—to]+\s*(\d{1,2}:\d{2})/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const timeMatch = line.match(timeRegex);

    if (timeMatch) {
      // Collect context: this line + next few lines
      const block = lines.slice(i, i + 5).join(' ');
      const lower = block.toLowerCase();

      const isForest = FOREST_KW.some(kw => lower.includes(kw));
      const isOpen = lower.includes('open') || lower.includes('plenary') || lower.includes('webcast');
      const isNego = lower.includes('contact group') || lower.includes('informal') ||
                     lower.includes('negotiat') || lower.includes('sbsta') || lower.includes('sbi');

      sessions.push({
        time: timeMatch[1] + '–' + timeMatch[2],
        title: lines[i + 1] || block.slice(0, 80),
        room: lines[i + 2] || '',
        isForest,
        isOpen,
        isNego,
        raw: block.slice(0, 200)
      });
      i += 3;
    } else {
      i++;
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
