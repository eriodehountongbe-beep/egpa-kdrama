// migrate_lowdb_to_pg.js
// Usage: set DATABASE_URL and run `node migrate_lowdb_to_pg.js`

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Please set DATABASE_URL in environment');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const file = path.join(__dirname, 'data.json');
  if (!fs.existsSync(file)) {
    console.error('No data.json found in server/');
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  const votes = content.votes || [];
  const comments = content.comments || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of votes) {
      await client.query('INSERT INTO votes (title, user_id, vote_type, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [v.title, v.user_id, v.vote_type, v.created_at || new Date().toISOString()]);
    }
    for (const c of comments) {
      await client.query('INSERT INTO comments (title, "user", text, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [c.title, c.user || 'Anonyme', c.text, c.created_at || new Date().toISOString()]);
    }
    await client.query('COMMIT');
    console.log(`Imported ${votes.length} votes and ${comments.length} comments`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
