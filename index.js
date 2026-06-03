const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Detect frontend HTML location: same dir (Render/GitHub root) or parent dir (local dev with server/ subfolder)
const fs = require('fs');
const htmlInSameDir = path.join(__dirname, 'classement_kdramas-1.html');
const htmlInParentDir = path.join(__dirname, '..', 'classement_kdramas-1.html');
const htmlFile = fs.existsSync(htmlInSameDir) ? htmlInSameDir
               : fs.existsSync(htmlInParentDir) ? htmlInParentDir
               : null;
const frontendPath = htmlFile ? path.dirname(htmlFile) : null;

if (frontendPath) {
  app.use(express.static(frontendPath));
  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'classement_kdramas-1.html'));
  });
} else {
  // Fallback: frontend is hosted separately (Netlify)
  app.get('/', (req, res) => {
    res.json({ name: 'Kdrama API', status: 'ok', endpoints: ['/api/health', '/api/votes/:title', '/api/comments/:title', '/api/aggregates', '/api/dramas/sort'] });
  });
}

// Postgres connection via DATABASE_URL (e.g. Supabase)
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_URL || null;
if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL not set. The API will run but requests that use the DB will fail.');
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      user_id TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      "user" TEXT,
      text TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_votes_title ON votes(title)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_comments_title ON comments(title)');
    await client.query(`CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT,
  year TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, title)
)`);
await client.query('CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id)');
await client.query(`CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, title)
)`);
await client.query('CREATE INDEX IF NOT EXISTS idx_statuses_user ON statuses(user_id)');
  } finally {
    client.release();
  }
}

// Helpers
async function getAggregates(title) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT vote_type, COUNT(*) as cnt FROM votes WHERE title = $1 GROUP BY vote_type', [title]);
    const agg = { up: 0, down: 0, perfect: 0 };
    res.rows.forEach(r => { if (r.vote_type === 'up') agg.up = parseInt(r.cnt); else if (r.vote_type === 'down') agg.down = parseInt(r.cnt); else if (r.vote_type === 'perfect') agg.perfect = parseInt(r.cnt); });
    agg.net = agg.up - agg.down;
    return agg;
  } finally { client.release(); }
}

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Votes: get aggregates and optionally the caller's vote
app.get('/api/votes/:title', async (req, res) => {
  const title = req.params.title;
  const userId = req.query.userId || null;
  try {
    const agg = await getAggregates(title);
    let voted = null;
    if (userId) {
      const client = await pool.connect();
      try {
        const r = await client.query('SELECT vote_type FROM votes WHERE title = $1 AND user_id = $2 LIMIT 1', [title, userId]);
        if (r.rows[0]) voted = r.rows[0].vote_type;
      } finally { client.release(); }
    }
    res.json(Object.assign({ voted }, agg));
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
});

// Cast vote (toggle semantics: same vote removes it)
app.post('/api/votes/:title', async (req, res) => {
  const title = req.params.title;
  const { userId, vote } = req.body || {};
  if (!userId || !vote) return res.status(400).json({ error: 'userId and vote required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query('SELECT id, vote_type FROM votes WHERE title = $1 AND user_id = $2 LIMIT 1', [title, userId]);
    const existing = existingRes.rows[0];
    if (existing && existing.vote_type === vote) {
      await client.query('DELETE FROM votes WHERE id = $1', [existing.id]);
    } else if (existing) {
      await client.query('UPDATE votes SET vote_type = $1, created_at = now() WHERE id = $2', [vote, existing.id]);
    } else {
      await client.query('INSERT INTO votes (title, user_id, vote_type) VALUES ($1, $2, $3)', [title, userId, vote]);
    }
    await client.query('COMMIT');
    const agg = await getAggregates(title);
    const userRowRes = await client.query('SELECT vote_type FROM votes WHERE title = $1 AND user_id = $2 LIMIT 1', [title, userId]);
    const userRow = userRowRes.rows[0];
    res.json(Object.assign({ voted: userRow ? userRow.vote_type : null }, agg));
  } catch (err) { await client.query('ROLLBACK'); console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

// Comments: list
app.get('/api/comments/:title', async (req, res) => {
  const title = req.params.title;
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT id, "user", text, created_at FROM comments WHERE title = $1 ORDER BY created_at ASC', [title]);
    res.json(r.rows.map(row => ({ id: row.id, user: row.user, text: row.text, created_at: row.created_at })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

// Comments: post
app.post('/api/comments/:title', async (req, res) => {
  const title = req.params.title;
  const { user, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const client = await pool.connect();
  try {
    const r = await client.query('INSERT INTO comments (title, "user", text) VALUES ($1, $2, $3) RETURNING id, "user", text, created_at', [title, user || 'Anonyme', text]);
    // return full list
    const rows = await client.query('SELECT id, "user", text, created_at FROM comments WHERE title = $1 ORDER BY created_at ASC', [title]);
    res.json(rows.rows.map(row => ({ id: row.id, user: row.user, text: row.text, created_at: row.created_at })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});
// ── BOOKMARKS ─────────────────────────────────────────────────────────────
app.get('/api/bookmarks/:userId', async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT title, genre, year FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

app.post('/api/bookmarks', async (req, res) => {
  const { userId, title, genre, year } = req.body || {};
  if (!userId || !title) return res.status(400).json({ error: 'userId and title required' });
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO bookmarks (user_id, title, genre, year) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, title) DO NOTHING',
      [userId, title, genre || '', year || '']
    );
    const r = await client.query('SELECT title, genre, year FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

app.delete('/api/bookmarks', async (req, res) => {
  const { userId, title } = req.body || {};
  if (!userId || !title) return res.status(400).json({ error: 'userId and title required' });
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM bookmarks WHERE user_id = $1 AND title = $2', [userId, title]);
    const r = await client.query('SELECT title, genre, year FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});
// ── STATUTS ─────────────────────────────────────────────────────────────
app.get('/api/statuses/:userId', async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT title, status FROM statuses WHERE user_id = $1',
      [userId]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

app.post('/api/statuses', async (req, res) => {
  const { userId, title, status } = req.body || {};
  if (!userId || !title) return res.status(400).json({ error: 'userId and title required' });
  const client = await pool.connect();
  try {
    if (!status) {
      await client.query('DELETE FROM statuses WHERE user_id = $1 AND title = $2', [userId, title]);
    } else {
      await client.query(
        'INSERT INTO statuses (user_id, title, status) VALUES ($1, $2, $3) ON CONFLICT (user_id, title) DO UPDATE SET status = $3',
        [userId, title, status]
      );
    }
    const r = await client.query('SELECT title, status FROM statuses WHERE user_id = $1', [userId]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});
// ── NEWS ─────────────────────────────────────────────────────────────────────
const RSSParser = require('rss-parser');
const rssParser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'media:content', {keepArray: false}],
      ['media:thumbnail', 'media:thumbnail', {keepArray: false}],
      ['content:encoded', 'content:encoded'],
      'enclosure'
    ]
  }
});

let newsCache = { items: [], lastFetch: 0 };
const NEWS_TTL = 6 * 60 * 60 * 1000; // 6h

const RSS_FEEDS = [
  { url: 'https://www.kdrama-fr.com/feed/', lang: 'fr' },
  { url: 'https://seriesaddict.fr/news/feed/', lang: 'fr' },
  { url: 'https://www.soompi.com/feed/', lang: 'en' },
  { url: 'https://dramabeans.com/feed/', lang: 'en' },
];

async function fetchNews() {
  if (Date.now() - newsCache.lastFetch < NEWS_TTL && newsCache.items.length > 0) {
    return newsCache.items;
  }
  const allItems = [];
  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      parsed.items.forEach(item => {
        allItems.push({
          title: item.title || '',
          link: item.link || '',
          date: item.pubDate || item.isoDate || '',
          excerpt: item.contentSnippet || item.summary || '',
          image: item['media:content']?.$?.url
            || item['media:thumbnail']?.$?.url
            || item.enclosure?.url
            || extractImageFromContent(item['content:encoded'] || '')
            || extractImageFromContent(item.content || '')
            || extractImageFromContent(item.summary || '')
            || null,
          source: parsed.title || feed.url,
          lang: feed.lang
        });
      });
    } catch(e) {
      console.error('RSS fetch error for', feed.url, e.message);
    }
  }
  // Trier par date décroissante et limiter à 30
  allItems.sort((a, b) => new Date(b.date) - new Date(a.date));
  newsCache = { items: allItems.slice(0, 30), lastFetch: Date.now() };
  return newsCache.items;
}

function extractImageFromContent(content) {
  if (!content) return null;
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

app.get('/api/news', async (req, res) => {
  try {
    const items = await fetchNews();
    res.json(items);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'news fetch failed' });
  }
});

// Prefetch au démarrage
fetchNews().catch(console.error);

// Proxy images pour éviter le CORS
app.get('/api/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end();
  try {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (imgRes) => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      imgRes.pipe(res);
    }).on('error', () => res.status(404).end());
  } catch(e) { res.status(500).end(); }
});

// ── CLASSEMENT VOTES (Sans classement → catégorie) ─────────────────────────
app.get('/api/classvotes/:title', async (req, res) => {
  const title = decodeURIComponent(req.params.title);
  const userId = req.query.userId;
  try {
    const result = await pool.query(
      'SELECT cat, COUNT(*) as count FROM classvotes WHERE title=$1 GROUP BY cat',
      [title]
    );
    const votes = { M:0, TB:0, B:0, AB:0, P:0 };
    result.rows.forEach(r => { votes[r.cat] = parseInt(r.count); });
    let voted = null;
    if (userId) {
      const v = await pool.query(
        'SELECT cat FROM classvotes WHERE title=$1 AND user_id=$2',
        [title, userId]
      );
      if (v.rows.length > 0) voted = v.rows[0].cat;
    }
    res.json({ ...votes, voted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/classvotes/:title', async (req, res) => {
  const title = decodeURIComponent(req.params.title);
  const { userId, cat } = req.body;
  try {
    // Toggle
    const existing = await pool.query(
      'SELECT cat FROM classvotes WHERE title=$1 AND user_id=$2',
      [title, userId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM classvotes WHERE title=$1 AND user_id=$2',
        [title, userId]
      );
    } else {
      await pool.query(
        'INSERT INTO classvotes (title, user_id, cat) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [title, userId, cat]
      );
    }
    const result = await pool.query(
      'SELECT cat, COUNT(*) as count FROM classvotes WHERE title=$1 GROUP BY cat',
      [title]
    );
    const votes = { M:0, TB:0, B:0, AB:0, P:0 };
    result.rows.forEach(r => { votes[r.cat] = parseInt(r.count); });
    let voted = null;
    const v = await pool.query(
      'SELECT cat FROM classvotes WHERE title=$1 AND user_id=$2',
      [title, userId]
    );
    if (v.rows.length > 0) voted = v.rows[0].cat;
    res.json({ ...votes, voted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NOUVEAUX EN COURS ──────────────────────────────────────────────────────
app.get('/api/nouveaux', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM nouveaux_dramas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nouveaux', async (req, res) => {
  const { tmdb_id, title, synopsis, genre, eps, year, poster, platforms } = req.body;
  try {
    await pool.query(
      `INSERT INTO nouveaux_dramas (tmdb_id, title, synopsis, genre, eps, year, poster, platforms, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'encours')
       ON CONFLICT (tmdb_id) DO NOTHING`,
      [tmdb_id, title, synopsis, genre, eps, year, poster, JSON.stringify(platforms || [])]
    );
    const result = await pool.query('SELECT * FROM nouveaux_dramas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/nouveaux/:tmdb_id/complet', async (req, res) => {
  const { tmdb_id } = req.params;
  try {
    await pool.query(
      'UPDATE nouveaux_dramas SET status=$1 WHERE tmdb_id=$2',
      ['complet', tmdb_id]
    );
    const result = await pool.query('SELECT * FROM nouveaux_dramas WHERE tmdb_id=$1', [tmdb_id]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VISITEURS EN LIGNE ─────────────────────────────────────────────
const activeVisitors = new Map(); // sessionId -> timestamp

app.post('/api/ping', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  activeVisitors.set(sessionId, Date.now());
  res.json({ ok: true });
});

app.get('/api/visitors', (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== (process.env.ADMIN_KEY || 'kdrama-admin-2026')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const now = Date.now();
  // Nettoyer les sessions inactives depuis plus de 90 secondes
  for (const [id, ts] of activeVisitors.entries()) {
    if (now - ts > 90000) activeVisitors.delete(id);
  }
  res.json({ count: activeVisitors.size });
});
const PORT = process.env.PORT || 3000;

async function start() {
  if (DATABASE_URL) {
    try {
      await ensureSchema();
      console.log('Database schema OK');
    } catch (err) {
      console.error('Schema creation failed:', err.message);
    }
  }
  app.listen(PORT, () => console.log(`Kdrama API listening on http://localhost:${PORT}`));
}

start();

// Return aggregates for all titles present in votes
app.get('/api/aggregates', async (req, res) => {
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT title, vote_type, COUNT(*) as cnt FROM votes GROUP BY title, vote_type');
    const aggMap = {};
    r.rows.forEach(v => {
      if (!aggMap[v.title]) aggMap[v.title] = { up:0, down:0, perfect:0 };
      if (v.vote_type === 'up') aggMap[v.title].up = parseInt(v.cnt);
      else if (v.vote_type === 'down') aggMap[v.title].down = parseInt(v.cnt);
      else if (v.vote_type === 'perfect') aggMap[v.title].perfect = parseInt(v.cnt);
    });
    Object.keys(aggMap).forEach(t => { aggMap[t].net = aggMap[t].up - aggMap[t].down; });
    res.json(aggMap);
  } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
  finally { client.release(); }
});

// Sort a provided list of titles by server-side aggregates and return sorted list with aggregates
app.post('/api/dramas/sort', (req, res) => {
  // Titles must be provided in body
  (async () => {
    const titles = (req.body && Array.isArray(req.body.titles)) ? req.body.titles : [];
    const client = await pool.connect();
    try {
      if (titles.length === 0) return res.json([]);
      // fetch aggregates for provided titles
      const r = await client.query('SELECT title, vote_type, COUNT(*) as cnt FROM votes WHERE title = ANY($1) GROUP BY title, vote_type', [titles]);
      const aggMap = {};
      r.rows.forEach(v => {
        if (!aggMap[v.title]) aggMap[v.title] = { up:0, down:0, perfect:0 };
        if (v.vote_type === 'up') aggMap[v.title].up = parseInt(v.cnt);
        else if (v.vote_type === 'down') aggMap[v.title].down = parseInt(v.cnt);
        else if (v.vote_type === 'perfect') aggMap[v.title].perfect = parseInt(v.cnt);
      });
      const out = titles.map(title => ({ title, aggregates: aggMap[title] ? Object.assign({ net: aggMap[title].up - aggMap[title].down }, aggMap[title]) : { up:0, down:0, perfect:0, net:0 } }));
      out.sort((a,b) => {
        if (b.aggregates.net !== a.aggregates.net) return b.aggregates.net - a.aggregates.net;
        if (b.aggregates.perfect !== a.aggregates.perfect) return b.aggregates.perfect - a.aggregates.perfect;
        return b.aggregates.up - a.aggregates.up;
      });
      res.json(out);
    } catch (err) { console.error(err); res.status(500).json({ error: 'db' }); }
    finally { client.release(); }
  })();
});
