# kdrama-api

Simple Node API for votes and comments (Postgres / Supabase)

Install & run locally:

```powershell
cd server
npm install
DATABASE_URL="postgres://..." npm start
```

This server expects a `DATABASE_URL` environment variable (use Supabase or any Postgres DB).

API endpoints (default host http://localhost:3000):
- `GET /api/votes/:title?userId=...` — get aggregates and caller vote
- `POST /api/votes/:title` — body `{ userId, vote }` vote ∈ ["up","down","perfect"]
- `GET /api/comments/:title` — list comments
- `POST /api/comments/:title` — body `{ user, text }` add comment
- `GET /api/aggregates` — returns aggregated counts for all titles
- `POST /api/dramas/sort` — body `{ titles: [...] }` returns titles sorted by server aggregates

Tables will be created automatically on startup if they do not exist. For Supabase you can also run the following SQL in the Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS votes (
	id SERIAL PRIMARY KEY,
	title TEXT NOT NULL,
	user_id TEXT NOT NULL,
	vote_type TEXT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
	id SERIAL PRIMARY KEY,
	title TEXT NOT NULL,
	"user" TEXT,
	text TEXT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
```

Deployment notes:
- Use Render, Railway or a small VPS to host the Node service and set `DATABASE_URL` to your Supabase connection string.
- The server serves static files from the project root, so the frontend `classement_kdramas-1.html` is accessible at `/`.
