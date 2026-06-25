# No Betting Zone

A points-based FIFA World Cup 2026 predictor app — users register, stake points on 1X2 match outcomes, and earn based on a tranche-level pari-mutuel settlement system.

## Run & Operate

- `node index.js` — run the app (port from `$PORT`, default 3000)
- Required env: `DATABASE_URL` — Postgres connection string (auto-injected by Replit)
- Required secrets: `SESSION_SECRET`, `THE_ODDS_API_KEY`, `RESEND_API_KEY`, `API_FOOTBALL_KEY`

## Stack

- Node.js 24, Express 4, plain HTML (server-rendered, no frontend framework)
- DB: PostgreSQL via `pg` pool — two tables: `kv_store` (key-value store) and `session`
- Sessions: `express-session` + `connect-pg-simple`
- Emails: Resend
- Odds: The Odds API (soccer_fifa_world_cup)

## Where things live

- `index.js` — entire application (~2360 lines), single file
- `artifacts/no-betting-zone/.replit-artifact/artifact.toml` — deployment config (port 3003, VM)
- `package.json` (workspace root) — dependencies for the no-betting-zone app

## Architecture decisions

- **`PgKV` class** (top of `index.js`): drop-in replacement for `@replit/database` — same `get/set/delete/list` API, backed by a `kv_store (key text PK, value jsonb)` table. All app data lives there.
- **Fixture snapshot** is loaded into memory at startup from `snapshot:fixtures` key, refreshed once daily at 12 noon IST by the daily job. Routes never call the API directly.
- **Settlement** uses tranche-level pari-mutuel: winners capped at `stake × lockedOdds`; undistributed pool returned to losers proportionally.
- **Sessions** stored in PostgreSQL `session` table via `connect-pg-simple` — works in both dev and Reserved VM production (no REPLIT_DB_URL dependency).
- **Admin password** stored as `admin:password` in kv_store; falls back to hardcoded default if key absent.

## Product

- Users register with email + OTP verification, receive 100 starting points
- Make 1X2 predictions with tranche-based staking (up to 100 pts per match in multiples of 20)
- Leaderboard, personal stats, settled results, and community forum
- Daily automated settlement + manual admin override
- Admin panel: run daily job, manual settle, view OTPs, change password, snapshot info

## Gotchas

- `db.list(prefix)` uses `LIKE $1 ESCAPE '!'` — the `!` escape character matters; do not change without updating the prefix-escape logic.
- The fixture snapshot is in-memory only; a server restart re-loads it from `kv_store`. Production restarts happen on each publish.
- Dev and production use **separate** PostgreSQL databases. Production has its own live DB populated by the running deployment; dev has a smaller dataset. Schema is created idempotently at startup.
- `express.json({ limit: '20mb' })` — raised from default to handle large admin payloads.
