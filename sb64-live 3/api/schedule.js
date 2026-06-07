// api/schedule.js
// Vercel serverless function — runs on Vercel's servers, bypasses CORS
// Fetches two UNFCCC sources and returns clean JSON to the browser

export default async function handler(req, res) {
  // Allow the browser to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate'); // 3-min cache on Vercel edge

  const source = req.query.source || 'sideevents';

  try {
    if (source === 'sideevents') {
      // SEORS is plain HTML — we can scrape it
      const url = 'https://seors.unfccc.int/seors/reports/events_list.html?session_id=SB%2064';
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SB64Observer/1.0)',
          'Accept': 'text/html'
        }
      });

      if (!response.ok) {
        return res.status(502).json({ error: 'SEORS fetch failed', status: response.status });
      }

      const html = await response.text();
      const events = parseSEORS(html);
      return res.status(200).json({ source: 'seors', fetchedAt: new Date().toISOString(), events });
    }

    if (source === 'glance') {
      // The meetings-at-a-glance page — try to get the raw HTML (partially useful)
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const url = `https://unfccc.int/sb64/meetings-at-a-glance`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SB64Observer/1.0)' }
      });
      const html = await response.text();
      // The actual meeting data is loaded by JS so we can't parse it here.
      // We return a status ping so the frontend knows the site is reachable.
      return res.status(200).json({
        source: 'glance',
        fetchedAt: new Date().toISOString(),
        reachable: response.ok,
        note: 'Meetings-at-a-glance is JS-rendered. Use the direct link.'
      });
    }

    return res.status(400).json({ error: 'Unknown source. Use ?source=sideevents or ?source=glance' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── SEORS HTML PARSER ────────────────────────────────────────────
// Extracts side events from the SEORS table HTML
function parseSEORS(html) {
  const events = [];

  // Extract table rows — each scheduled event is a table row with date, time, room, organiser, title
  // Pattern: rows in the main schedule table
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Find the date headers and event rows
  // SEORS uses a specific structure: date in first column, time/room, organiser, title
  const dateHeaderRegex = /(\w+),\s+(\d{1,2}\s+\w+\s+202\d)/g;

  let currentDate = null;
  const lines = html.split('\n');

  // Parse via regex on the full HTML — look for the event table structure
  // Each event block looks like: Monday, 08 Jun 2026 | 10:30-11:45 Room | Organiser | Title
  const eventBlockRegex = /(\w+day,\s+\d{2}\s+\w+\s+202\d)[\s\S]*?(\d{2}:\d{2}[–\-—]\d{2}:\d{2})\s+([\w\s]+?)\s*\|[\s\S]*?<strong>([^<]+)<\/strong>/g;

  // Simpler approach: find all <td> content in sequence and group by 5s
  // Extract all table data cells
  const allTds = [];
  let tdMatch;
  const tdRe = /<td[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  while ((tdMatch = tdRe.exec(html)) !== null) {
    allTds.push(stripTags(tdMatch[1]));
  }

  // The real reliable parse: look for date+time+room patterns
  // Format in SEORS: "Monday,   08 Jun 2026" then "10:30—11:45   Berlin" then organiser block then title block
  const dateTimePattern = /(\w+day),\s+(\d{2}\s+\w+\s+\d{4})/g;
  const timeRoomPattern = /(\d{2}:\d{2}[^\d]+\d{2}:\d{2})\s+([\w]+)/;

  // Best approach for SEORS: parse the known structure
  // Split on day headers
  const dayBlocks = html.split(/(?=\|\s*\w+day,\s+\d{2}\s+\w+\s+\d{4})/);

  // Extract structured data using a targeted regex for the SEORS format
  // Each event: date, time+room, organiser(s) with contact, title+description
  const masterPattern = /(\w+day),\s+(\d{2}\s+\w+\s+\d{4})[\s\S]*?(\d{2}:\d{2}[^<\d]{1,10}\d{2}:\d{2})\s*([\w\s]{2,20}?)\s*(?:<br|<\/td)[\s\S]*?<strong>([^<]{10,200})<\/strong>\s*([\s\S]*?)(?=(?:\w+day,\s+\d{2}\s+\w+)|$)/g;

  let m;
  while ((m = masterPattern.exec(html)) !== null) {
    const [, weekday, dateStr, time, room, title, rest] = m;
    // Extract description from rest
    const descMatch = rest.match(/<\/strong>\s*([\s\S]*?)(?=<\/td|<tr|$)/);
    const desc = descMatch ? stripTags(descMatch[1]).slice(0, 300) : '';

    events.push({
      date: dateStr.trim(),
      weekday: weekday.trim(),
      time: time.replace(/[–—]/g, '–').trim(),
      room: room.trim(),
      title: title.trim(),
      desc: desc.trim(),
      raw: false
    });
  }

  // If the complex regex got nothing, fall back to a simpler title-only extraction
  if (events.length === 0) {
    const titleOnly = /<strong>([^<]{15,200})<\/strong>/g;
    let t;
    let i = 0;
    while ((t = titleOnly.exec(html)) !== null && i < 100) {
      const title = stripTags(t[1]);
      if (title.length > 15 && !title.includes('©') && !title.includes('UNFCCC')) {
        events.push({ title, raw: true });
        i++;
      }
    }
  }

  return events;
}
