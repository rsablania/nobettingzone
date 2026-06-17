const express = require('express');
const axios = require('axios');
const moment = require('moment-timezone');
const Database = require('@replit/database');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const API_FOOTBALL_WC_LEAGUE = 1;   // FIFA World Cup league ID
const API_FOOTBALL_WC_SEASON = 2026;

// Normalize team name for fuzzy matching across APIs
function normalizeTeamName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Fetch completed match results from the Odds API scores endpoint.
// Returns a map of { fixtureId → 'Home'|'Away'|'Draw' } for all completed fixtures.
async function fetchResultsFromOddsApi() {
  const resultMap = {};
  for (const sportKey of SOCCER_SPORT_KEYS) {
    try {
      const resp = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/scores`, {
        params: { apiKey: ODDS_API_KEY, daysFrom: 3 },
      });
      const games = Array.isArray(resp.data) ? resp.data : [];
      for (const g of games) {
        if (!g.completed || !g.scores || g.scores.length < 2) continue;
        const homeScore = parseInt(g.scores.find(s => s.name === g.home_team)?.score ?? -1);
        const awayScore = parseInt(g.scores.find(s => s.name === g.away_team)?.score ?? -1);
        if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) continue;
        resultMap[g.id] = homeScore > awayScore ? 'Home' : awayScore > homeScore ? 'Away' : 'Draw';
      }
    } catch (e) {
      console.error(`[Settlement] Odds API scores error [${sportKey}]:`, e.message);
    }
  }
  return resultMap;
}

const TIMEZONE = 'Asia/Kolkata';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Persistent session store backed by @replit/database
// Prevents logout when the container sleeps/restarts
const SessionStore = session.Store;
class ReplitDbSessionStore extends SessionStore {
  async get(sid, cb) {
    try { cb(null, (await db.get(`sess:${sid}`)) || null); }
    catch (e) { cb(e); }
  }
  async set(sid, sess, cb) {
    try { await db.set(`sess:${sid}`, sess); cb(null); }
    catch (e) { cb(e); }
  }
  async destroy(sid, cb) {
    try { await db.delete(`sess:${sid}`); cb(null); }
    catch (e) { cb(e); }
  }
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: new ReplitDbSessionStore(),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }   // 30 days, survives container restarts
}));

// All soccer sport keys on The Odds API free plan
const SOCCER_SPORT_KEYS = [
  'soccer_fifa_world_cup',
];

// ── IN-MEMORY SNAPSHOT ───────────────────────────────────────────────────────
// All fixture+odds data lives here. Populated from DB on startup, refreshed
// once daily at 12 noon IST by the daily job. User requests NEVER call the API.

let fixtureSnapshot = [];   // array of Odds API event objects
let snapshotMeta = null;    // { fetchedAt, creditsLeft }

// Load the persisted snapshot from Replit DB into memory on startup
async function loadFixturesFromDB() {
  try {
    const stored = await db.get('snapshot:fixtures');
    if (stored && Array.isArray(stored.events)) {
      fixtureSnapshot = stored.events;
      snapshotMeta = { fetchedAt: stored.fetchedAt, creditsLeft: stored.creditsLeft };
      console.log(`[Snapshot] Loaded ${fixtureSnapshot.length} events from DB (fetched ${stored.fetchedAt})`);
    } else {
      console.log('[Snapshot] No stored snapshot found — waiting for daily job at 12 noon IST.');
    }
  } catch (e) {
    console.error('[Snapshot] Failed to load from DB:', e.message);
  }
}

// Fetch all sport keys, store results in DB and memory
async function fetchAndStoreFixtures() {
  console.log('[DailyJob] Fetching fixtures+odds from all sport keys...');
  const all = [];
  let creditsLeft = '?';
  for (const sportKey of SOCCER_SPORT_KEYS) {
    try {
      const resp = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
        params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }
      });
      const events = Array.isArray(resp.data) ? resp.data : [];
      all.push(...events);
      const rem = resp.headers['x-requests-remaining'];
      if (rem) creditsLeft = rem;
      if (events.length > 0) console.log(`[DailyJob] ${sportKey}: ${events.length} events. Credits left: ${rem}`);
    } catch (e) {
      console.error(`[DailyJob] Error [${sportKey}]:`, e.message);
    }
  }

  // Odds sanity pass — for each event, validate odds. If glitchy, fall back to
  // the previously stored bookmaker data for that event (keeps last known good odds).
  const prevByEventId = {};
  for (const ev of fixtureSnapshot) prevByEventId[ev.id] = ev;

  let fallbackCount = 0;
  const validated = all.map(ev => {
    const odds = extractOdds(ev);
    if (odds !== null) return ev; // odds are clean — use as-is
    // Odds are glitchy — try to keep previous bookmaker data
    const prev = prevByEventId[ev.id];
    const prevOdds = prev ? extractOdds(prev) : null;
    if (prevOdds) {
      fallbackCount++;
      console.warn(`[OddsValidation] Glitchy odds for "${ev.home_team} vs ${ev.away_team}" — keeping previous odds`);
      return { ...ev, bookmakers: prev.bookmakers };
    }
    // No previous data either — store event without bookmaker odds (will show — on UI)
    console.warn(`[OddsValidation] Glitchy odds for "${ev.home_team} vs ${ev.away_team}" — no fallback available`);
    return { ...ev, bookmakers: [] };
  });

  if (fallbackCount > 0) console.log(`[OddsValidation] ${fallbackCount} event(s) fell back to previous odds`);

  const fetchedAt = moment().tz(TIMEZONE).format('DD MMM YYYY, HH:mm z');
  const stored = { events: validated, fetchedAt, creditsLeft };
  await db.set('snapshot:fixtures', stored);
  fixtureSnapshot = validated;
  snapshotMeta = { fetchedAt, creditsLeft };
  console.log(`[DailyJob] Snapshot stored: ${validated.length} total events. Credits remaining: ${creditsLeft}`);
}

// Read a single event from the in-memory snapshot (no API call)
async function getEventById(id) {
  return fixtureSnapshot.find(e => e.id === id) || null;
}

// ── DAILY SCHEDULER ───────────────────────────────────────────────────────────
// Runs at 12 noon IST: settle finished matches, then fetch fresh fixtures+odds.
// Checks every minute; skips if already ran today.

async function runDailyJob() {
  console.log('[DailyJob] Starting — settling bets, then fetching fixtures...');
  try { await settlePendingBets(); } catch (e) { console.error('[DailyJob] Settlement error:', e.message); }
  try { await fetchAndStoreFixtures(); } catch (e) { console.error('[DailyJob] Fetch error:', e.message); }
  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
  await db.set('dailyJob:lastRun', today);
  await db.set('dailyJob:scheduledRun', today); // separate key — only set by the scheduler
  console.log('[DailyJob] Done for', today);
}

setInterval(async () => {
  try {
    const now = moment().tz(TIMEZONE);
    if (now.hour() !== 12) return;                                  // only run during 12 noon IST hour
    const today = now.format('YYYY-MM-DD');
    const lastScheduled = await db.get('dailyJob:scheduledRun');   // not affected by manual admin runs
    if (lastScheduled === today) return;
    await runDailyJob();
  } catch (e) {
    console.error('[Scheduler] Error:', e.message);
  }
}, 60 * 1000);

// Odds refresh every 2 hours (runs at :00 of hours 0,2,4,6,8,10,12,14,16,18,20,22 IST)
setInterval(async () => {
  try {
    const now = moment().tz(TIMEZONE);
    const h = now.hour();
    if (h === 23) return;                         // 11 PM handled by full daily job
    if (h % 2 !== 0 || now.minute() !== 0) return;
    const key = `oddsRefresh:${now.format('YYYY-MM-DD-HH')}`;
    if (await db.get(key)) return;
    await db.set(key, true);
    console.log(`[OddsRefresh] Fetching latest odds at ${now.format('HH:mm z')}…`);
    await fetchAndStoreFixtures();
    console.log(`[OddsRefresh] Done`);
  } catch (e) {
    console.error('[OddsRefresh] Error:', e.message);
  }
}, 60 * 1000);


// Leaderboard email at 11:59 PM IST daily
async function sendLeaderboardEmail() {
  try {
    const keys = await db.list('user:');
    const users = [];
    for (const key of keys) {
      const u = await db.get(key);
      if (u) users.push(u);
    }
    users.sort((a, b) => b.totalNetPoints - a.totalNetPoints);
    if (!users.length) return;

    const rows = users.map((u, i) => {
      const name = u.displayName || u.userId || 'Unknown';
      const pts = (u.totalNetPoints || 0).toFixed(1);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      return `<tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:8px 12px;">${medal}</td>
        <td style="padding:8px 12px;">${name}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:bold;">${pts}</td>
      </tr>`;
    }).join('');

    const date = moment().tz(TIMEZONE).format('DD MMM YYYY');
    await resend.emails.send({
      from: 'No Betting Zone <onboarding@resend.dev>',
      to: 'gletterdash@gmail.com',
      subject: `Leaderboard Update — ${date}`,
      html: `
        <h2 style="font-family:sans-serif;">🏆 No Betting Zone — Daily Leaderboard</h2>
        <p style="font-family:sans-serif;color:#6b7280;">${date}</p>
        <table style="border-collapse:collapse;font-family:sans-serif;width:100%;max-width:400px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:8px 12px;text-align:left;">Rank</th>
              <th style="padding:8px 12px;text-align:left;">Player</th>
              <th style="padding:8px 12px;text-align:right;">Points</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `
    });
    console.log('[LeaderboardEmail] Sent successfully for', date);
  } catch (e) {
    console.error('[LeaderboardEmail] Error:', e.message);
  }
}

setInterval(async () => {
  try {
    const now = moment().tz(TIMEZONE);
    if (now.hour() !== 12 || now.minute() !== 59) return;          // only at 12:59 PM IST
    const today = now.format('YYYY-MM-DD');
    const lastSent = await db.get('leaderboardEmail:lastSent');
    if (lastSent === today) return;                                  // already sent today
    await db.set('leaderboardEmail:lastSent', today);
    await sendLeaderboardEmail();
  } catch (e) {
    console.error('[LeaderboardEmail Scheduler] Error:', e.message);
  }
}, 60 * 1000);

// ── ODDS VALIDATION ───────────────────────────────────────────────────────────
// Bounds for individual odds and implied probability sum (overround)
const ODDS_MIN = 1.01;
const ODDS_MAX = 50;
const IMPLIED_PROB_MIN = 0.85;  // sum of 1/H + 1/D + 1/A
const IMPLIED_PROB_MAX = 1.50;

function validateOddsList(outcomes) {
  if (!outcomes || outcomes.length !== 3) return false;
  for (const o of outcomes) {
    const p = parseFloat(o.odd);
    if (!isFinite(p) || p < ODDS_MIN || p > ODDS_MAX) return false;
  }
  const impliedSum = outcomes.reduce((s, o) => s + 1 / parseFloat(o.odd), 0);
  return impliedSum >= IMPLIED_PROB_MIN && impliedSum <= IMPLIED_PROB_MAX;
}

// Extract h2h odds from an event → [{ value:'Home'|'Draw'|'Away', odd:'1.90' }]
function extractOdds(event) {
  if (!event?.bookmakers?.length) return null;
  const market = event.bookmakers[0].markets?.find(m => m.key === 'h2h');
  if (!market?.outcomes?.length) return null;
  const order = { Home: 0, Draw: 1, Away: 2 };
  const outcomes = market.outcomes.map(o => {
    let value = 'Away';
    if (o.name === 'Draw') value = 'Draw';
    else if (o.name === event.home_team) value = 'Home';
    return { value, odd: Number(o.price).toFixed(2) };
  });
  outcomes.sort((a, b) => order[a.value] - order[b.value]);
  if (outcomes.length !== 3) return null;
  if (!validateOddsList(outcomes)) return null;
  return outcomes;
}

// Determine match result from Odds API score object
function getResultFromScore(scoreEvent) {
  if (!scoreEvent.scores?.length) return null;
  const homeScore = scoreEvent.scores.find(s => s.name === scoreEvent.home_team);
  const awayScore = scoreEvent.scores.find(s => s.name === scoreEvent.away_team);
  const hs = parseInt(homeScore?.score ?? scoreEvent.scores[0]?.score);
  const as = parseInt(awayScore?.score ?? scoreEvent.scores[1]?.score);
  if (isNaN(hs) || isNaN(as)) return null;
  if (hs > as) return 'Home';
  if (as > hs) return 'Away';
  return 'Draw';
}

/* ---------------- REPLIT DB HELPERS ---------------- */

async function getUserById(userId) {
  return db.get(`user:${userId.toLowerCase()}`);
}

async function getUserByEmail(email) {
  const userId = await db.get(`email:${email.toLowerCase()}`);
  if (!userId) return null;
  return getUserById(userId);
}

async function saveUser(user) {
  await db.set(`user:${user.userId.toLowerCase()}`, user);
}

async function createUser(userId, email, passwordHash) {
  const user = {
    userId,
    email,
    displayName: userId,
    passwordHash,
    verified: true,
    totalNetPoints: 0,
    createdAt: new Date().toISOString(),
  };
  await db.set(`user:${userId.toLowerCase()}`, user);
  await db.set(`email:${email.toLowerCase()}`, userId);
  return user;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

const DEFAULT_ADMIN_PASSWORD = 'locomotive123@';
async function getAdminPassword() {
  return (await db.get('admin:password')) || DEFAULT_ADMIN_PASSWORD;
}

async function addBet(bet) {
  const allBets = (await db.get('bets')) || [];
  allBets.push(bet);
  await db.set('bets', allBets);
}

async function getBets() {
  return (await db.get('bets')) || [];
}

async function addMessage(msg) {
  const all = (await db.get('messages')) || [];
  all.push(msg);
  await db.set('messages', all);
}

async function getMessages() {
  return (await db.get('messages')) || [];
}

async function updateBets(updatedBets) {
  await db.set('bets', updatedBets);
}

/* ---------------- SETTLEMENT ENGINE ---------------- */

async function settlePendingBets() {
  const summary = { settled: 0, errors: [], settledFixtureIds: [] };

  const allBets = await getBets();
  const pendingBets = allBets.filter(b => b.status === 'PENDING');
  if (!pendingBets.length) return summary;

  // Fetch finished results from the Odds API scores endpoint (direct ID match)
  const resultMap = {}; // fixtureId → 'Home' | 'Away' | 'Draw'
  try {
    const oddsResults = await fetchResultsFromOddsApi();
    const count = Object.keys(oddsResults).length;
    console.log(`[Settlement] Odds API scores returned ${count} completed fixture(s)`);
    for (const bet of pendingBets) {
      if (resultMap[bet.fixtureId]) continue;
      if (oddsResults[bet.fixtureId]) resultMap[bet.fixtureId] = oddsResults[bet.fixtureId];
    }
  } catch (e) {
    summary.errors.push(`Odds API scores error: ${e.message}`);
    console.error('[Settlement] Odds API scores error:', e.message);
  }

  // Group pending bets by fixture (only those with a known result)
  const byFixture = {};
  for (const bet of pendingBets) {
    const result = resultMap[bet.fixtureId];
    if (!result) continue;
    if (!byFixture[bet.fixtureId]) byFixture[bet.fixtureId] = { result, bets: [] };
    byFixture[bet.fixtureId].bets.push(bet);
  }

  let changed = false;
  for (const { result, bets } of Object.values(byFixture)) {
    // Gross points: WON = stake × odds, LOST = 0
    const grossArr = bets.map(b =>
      b.selection === result ? b.stake * parseFloat(b.lockedOdds) : 0
    );
    const sumGross = grossArr.reduce((a, v) => a + v, 0);
    const totalStaked = bets.reduce((a, b) => a + b.stake, 0);

    const logEntries = [];
    for (let i = 0; i < bets.length; i++) {
      const bet = bets[i];
      const won = bet.selection === result;
      bet.status = won ? 'WON' : 'LOST';
      bet.result = result;

      // Proportional payout from the pool; if no one won, everyone loses stake
      const finalPayout = sumGross > 0
        ? Math.round((grossArr[i] / sumGross) * totalStaked * 10) / 10
        : 0;
      bet.netPoints = Math.round((finalPayout - bet.stake) * 10) / 10;

      logEntries.push({
        user: bet.user,
        selection: bet.selection,
        stake: bet.stake,
        lockedOdds: bet.lockedOdds,
        status: bet.status,
        finalPayout,
        netPoints: bet.netPoints,
      });

      changed = true;
      summary.settled++;

      try {
        const user = await getUserById(bet.user.toLowerCase());
        if (user) {
          user.totalNetPoints = Math.round((user.totalNetPoints + bet.netPoints) * 10) / 10;
          await saveUser(user);
        }
      } catch (e) {
        summary.errors.push(`User update error for ${bet.user}: ${e.message}`);
      }
    }

    // Persist settlement log for this fixture
    const fb = bets[0];
    await db.set(`settlementLog:${fb.fixtureId}`, {
      fixtureId: fb.fixtureId,
      homeTeam: fb.homeTeam || '?',
      awayTeam: fb.awayTeam || '?',
      leagueName: fb.leagueName || 'Unknown',
      result,
      totalStaked,
      settledAt: moment().tz(TIMEZONE).format('DD MMM YYYY, HH:mm z'),
      entries: logEntries,
    });
    summary.settledFixtureIds.push(fb.fixtureId);
  }

  if (changed) await updateBets(allBets);
  return summary;
}

// Settlement is triggered exclusively by the daily job at 12 noon IST.
// No auto-polling — every API call is accounted for.

/* ---------------- HTML HELPERS ---------------- */

function htmlHeader(title) {
  return `
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { background:#020617; color:#e5e7eb; font-family: system-ui, -apple-system, BlinkMacSystemFont; margin:0; }
      a { color:#22c55e; text-decoration:none; }
      .container { padding:16px; padding-bottom:72px; }
      .card { background:#020617; border:1px solid #1f2937; border-radius:12px; padding:12px; margin-bottom:8px; }
      .title { font-size:20px; font-weight:bold; margin-bottom:8px; }
      .nav { position:fixed; bottom:0; left:0; right:0; height:56px; background:#020617; border-top:1px solid #1f2937; display:flex; justify-content:space-around; align-items:center; font-size:12px; }
      .nav a { color:#9ca3af; }
      .nav a.active { color:#22c55e; font-weight:bold; }
      input, textarea, button { font-size:16px; }
      input, textarea { padding:8px; border-radius:8px; border:1px solid #1f2937; background:#020617; color:#e5e7eb; }
      button { background:#22c55e; color:#020617; border:none; border-radius:8px; padding:8px 12px; font-weight:bold; }
    </style>
  </head>
  <body>
    <div class="container">
  `;
}

function htmlFooter(active) {
  return `
    </div>
    <div class="nav">
      <a href="/" class="${active === 'home' ? 'active' : ''}">Home</a>
      <a href="/summary" class="${active === 'summary' ? 'active' : ''}">My Stats</a>
      <a href="/leaderboard" class="${active === 'leaders' ? 'active' : ''}">Leaders</a>
      <a href="/rules" class="${active === 'rules' ? 'active' : ''}">Rules</a>
      <a href="/results" class="${active === 'results' ? 'active' : ''}">Results</a>
      <a href="/forum" class="${active === 'forum' ? 'active' : ''}">Forum</a>
      <a href="/admin" class="${active === 'admin' ? 'active' : ''}">Admin</a>
    </div>
  </body>
  </html>
  `;
}

/* ---------------- AUTH ROUTES ---------------- */

// REGISTER – step 1: collect details, send OTP
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const err = req.query.error || '';
  let html = htmlHeader('Register - No Betting Zone');
  html += `
    <h2>Create Account</h2>
    ${err ? `<p style="color:#ef4444;font-size:13px;">${err}</p>` : ''}
    <form method="POST" action="/register">
      <p style="margin-bottom:4px;font-size:13px;">Username</p>
      <input name="userId" placeholder="e.g. Rahul07" required autocomplete="username"
        style="width:100%;margin-bottom:12px;">
      <p style="margin-bottom:4px;font-size:13px;">Email</p>
      <input name="email" type="email" placeholder="you@example.com" required autocomplete="email"
        style="width:100%;margin-bottom:12px;">
      <p style="margin-bottom:4px;font-size:13px;">Password</p>
      <input name="password" type="password" placeholder="Min 6 characters" required autocomplete="new-password"
        style="width:100%;margin-bottom:16px;">
      <button type="submit" style="width:100%;">Send OTP →</button>
    </form>
    <p style="font-size:13px;margin-top:16px;">Already have an account? <a href="/login">Log in</a></p>
  `;
  html += htmlFooter('');
  res.send(html);
});

app.post('/register', async (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const { userId, email, password } = req.body || {};

  if (!userId || !email || !password) return res.redirect('/register?error=All+fields+are+required.');
  if (userId.length < 3 || userId.length > 20) return res.redirect('/register?error=Username+must+be+3-20+characters.');
  if (!/^[a-zA-Z0-9_]+$/.test(userId)) return res.redirect('/register?error=Username+can+only+contain+letters,+numbers,+and+underscores.');
  if (password.length < 6) return res.redirect('/register?error=Password+must+be+at+least+6+characters.');

  try {
    const existingByUserId = await getUserById(userId);
    if (existingByUserId) return res.redirect('/register?error=Username+already+taken.');
    const existingByEmail = await getUserByEmail(email);
    if (existingByEmail) return res.redirect('/register?error=Email+already+registered.');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const passwordHash = await bcrypt.hash(password, 10);
    await db.set(`otp:${email.toLowerCase()}`, {
      otp, userId, email, passwordHash,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    await resend.emails.send({
      from: 'No Betting Zone <onboarding@resend.dev>',
      to: 'gletterdash@gmail.com',
      subject: `OTP for new user: ${userId}`,
      html: `<p>New registration request:</p><ul><li><strong>Username:</strong> ${userId}</li><li><strong>Email:</strong> ${email}</li><li><strong>OTP:</strong> <span style="font-size:20px;letter-spacing:4px;font-weight:bold;">${otp}</span></li></ul><p>This code expires in 15 minutes.</p>`
    });

    res.redirect(`/register-otp-info?email=${encodeURIComponent(email)}`);
  } catch (e) {
    console.error('[Register]', e.message);
    res.redirect('/register?error=Something+went+wrong.+Please+try+again.');
  }
});

// REGISTER OTP INFO – shown after registration form, before OTP entry
app.get('/register-otp-info', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const email = req.query.email || '';
  let html = htmlHeader('Almost there! - No Betting Zone');
  html += `
    <h2>One more step!</h2>
    <div class="card" style="text-align:center;padding:24px 16px;">
      <div style="font-size:32px;margin-bottom:12px;">📩</div>
      <p style="font-size:15px;font-weight:600;margin:0 0 8px;">Contact Shiladitya Saha for your registration OTP</p>
      <p style="font-size:13px;color:#9ca3af;margin:0;">Once you have your 6-digit code, tap the button below to complete registration.</p>
    </div>
    <a href="/verify-email?email=${encodeURIComponent(email)}"
      style="display:block;text-align:center;margin-top:16px;padding:12px;background:#7c3aed;color:#fff;border-radius:10px;font-size:15px;text-decoration:none;font-weight:600;">
      I have my OTP →
    </a>
  `;
  html += htmlFooter('');
  res.send(html);
});

// VERIFY EMAIL – step 2: enter OTP
app.get('/verify-email', (req, res) => {
  const email = req.query.email || '';
  const err = req.query.error || '';
  let html = htmlHeader('Verify Email - No Betting Zone');
  html += `
    <h2>Verify Your Email</h2>
    <p style="font-size:13px;color:#9ca3af;">We sent a 6-digit code to <strong style="color:#e5e7eb;">${email}</strong></p>
    ${err ? `<p style="color:#ef4444;font-size:13px;">${err}</p>` : ''}
    <form method="POST" action="/verify-email">
      <input type="hidden" name="email" value="${email}">
      <p style="margin-bottom:4px;font-size:13px;">Enter OTP</p>
      <input name="otp" placeholder="6-digit code" required maxlength="6" autocomplete="one-time-code"
        style="width:100%;margin-bottom:16px;letter-spacing:6px;font-size:20px;text-align:center;">
      <button type="submit" style="width:100%;">Verify & Create Account</button>
    </form>
    <p style="font-size:13px;margin-top:12px;color:#6b7280;">
      Didn't get it? <a href="/register">Start over</a>
    </p>
  `;
  html += htmlFooter('');
  res.send(html);
});

app.post('/verify-email', async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.redirect('/register');

  const pending = await db.get(`otp:${email.toLowerCase()}`);
  if (!pending) return res.redirect(`/verify-email?email=${encodeURIComponent(email)}&error=OTP+expired.+Please+register+again.`);
  if (Date.now() > pending.expiresAt) {
    await db.delete(`otp:${email.toLowerCase()}`);
    return res.redirect(`/verify-email?email=${encodeURIComponent(email)}&error=OTP+expired.+Please+register+again.`);
  }
  if (otp.trim() !== pending.otp) {
    return res.redirect(`/verify-email?email=${encodeURIComponent(email)}&error=Incorrect+OTP.+Please+try+again.`);
  }

  await db.delete(`otp:${email.toLowerCase()}`);
  const user = await createUser(pending.userId, pending.email, pending.passwordHash);
  req.session.userId = user.userId;
  req.session.displayName = user.displayName;
  res.redirect('/');
});

// LOGIN
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const err = req.query.error || '';
  const msg = req.query.msg || '';
  let html = htmlHeader('Login - No Betting Zone');
  html += `
    <h2>Log In</h2>
    ${err ? `<p style="color:#ef4444;font-size:13px;">${err}</p>` : ''}
    ${msg ? `<p style="color:#22c55e;font-size:13px;">${msg}</p>` : ''}
    <form method="POST" action="/login">
      <p style="margin-bottom:4px;font-size:13px;">Email</p>
      <input name="email" type="email" placeholder="you@example.com" required autocomplete="email"
        style="width:100%;margin-bottom:12px;">
      <p style="margin-bottom:4px;font-size:13px;">Password</p>
      <input name="password" type="password" placeholder="Your password" required autocomplete="current-password"
        style="width:100%;margin-bottom:16px;">
      <button type="submit" style="width:100%;">Log In</button>
    </form>
    <p style="font-size:13px;margin-top:12px;"><a href="/forgot-password">Forgot password?</a></p>
    <p style="font-size:13px;margin-top:8px;">No account? <a href="/register">Register</a></p>
  `;
  html += htmlFooter('');
  res.send(html);
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.redirect('/login?error=Please+fill+in+all+fields.');
  try {
    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.redirect('/login?error=Invalid+email+or+password.');
    }
    req.session.userId = user.userId;
    req.session.displayName = user.displayName;
    res.redirect('/');
  } catch (e) {
    console.error('[Login]', e.message);
    res.redirect('/login?error=Something+went+wrong.');
  }
});

// LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// FORGOT PASSWORD – step 1: enter registered email
app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const err = req.query.error || '';
  let html = htmlHeader('Forgot Password - No Betting Zone');
  html += `
    <h2>Reset Password</h2>
    <p style="font-size:13px;color:#9ca3af;margin-bottom:16px;">Enter the email address you registered with. An OTP will be sent to the admin who will share it with you.</p>
    ${err ? `<p style="color:#ef4444;font-size:13px;">${err}</p>` : ''}
    <form method="POST" action="/forgot-password">
      <p style="margin-bottom:4px;font-size:13px;">Registered Email</p>
      <input name="email" type="email" placeholder="you@example.com" required autocomplete="email"
        style="width:100%;margin-bottom:16px;">
      <button type="submit" style="width:100%;">Send OTP →</button>
    </form>
    <p style="font-size:13px;margin-top:16px;"><a href="/login">← Back to Login</a></p>
  `;
  html += htmlFooter('');
  res.send(html);
});

app.post('/forgot-password', async (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const { email } = req.body || {};
  if (!email) return res.redirect('/forgot-password?error=Please+enter+your+email.');
  try {
    const user = await getUserByEmail(email);
    if (!user) return res.redirect('/forgot-password?error=No+account+found+with+that+email.');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db.set(`reset-otp:${email.toLowerCase()}`, {
      otp, userId: user.userId, email,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    await resend.emails.send({
      from: 'No Betting Zone <onboarding@resend.dev>',
      to: 'gletterdash@gmail.com',
      subject: `Password Reset OTP for: ${user.userId}`,
      html: `<p>Password reset request:</p><ul><li><strong>Username:</strong> ${user.userId}</li><li><strong>Email:</strong> ${email}</li><li><strong>OTP:</strong> <span style="font-size:20px;letter-spacing:4px;font-weight:bold;">${otp}</span></li></ul><p>This code expires in 15 minutes.</p>`
    });

    res.redirect(`/forgot-password-otp-info?email=${encodeURIComponent(email)}`);
  } catch (e) {
    console.error('[ForgotPassword]', e.message);
    res.redirect('/forgot-password?error=Something+went+wrong.+Please+try+again.');
  }
});

// FORGOT PASSWORD OTP INFO – contact admin page
app.get('/forgot-password-otp-info', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const email = req.query.email || '';
  let html = htmlHeader('Check with Admin - No Betting Zone');
  html += `
    <h2>Almost there!</h2>
    <div class="card" style="text-align:center;padding:24px 16px;">
      <div style="font-size:32px;margin-bottom:12px;">🔐</div>
      <p style="font-size:15px;font-weight:600;margin:0 0 8px;">Contact Shiladitya Saha for your password reset OTP</p>
      <p style="font-size:13px;color:#9ca3af;margin:0;">Once you have your 6-digit code, tap the button below to set a new password.</p>
    </div>
    <a href="/reset-password?email=${encodeURIComponent(email)}"
      style="display:block;text-align:center;margin-top:16px;padding:12px;background:#7c3aed;color:#fff;border-radius:10px;font-size:15px;text-decoration:none;font-weight:600;">
      I have my OTP →
    </a>
  `;
  html += htmlFooter('');
  res.send(html);
});

// RESET PASSWORD – enter OTP + new password
app.get('/reset-password', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const email = req.query.email || '';
  const err = req.query.error || '';
  let html = htmlHeader('Reset Password - No Betting Zone');
  html += `
    <h2>Set New Password</h2>
    ${err ? `<p style="color:#ef4444;font-size:13px;">${err}</p>` : ''}
    <form method="POST" action="/reset-password">
      <input type="hidden" name="email" value="${email}">
      <p style="margin-bottom:4px;font-size:13px;">OTP Code</p>
      <input name="otp" placeholder="6-digit code" required maxlength="6" autocomplete="one-time-code"
        style="width:100%;margin-bottom:12px;letter-spacing:6px;font-size:20px;text-align:center;">
      <p style="margin-bottom:4px;font-size:13px;">New Password</p>
      <input name="password" type="password" placeholder="Min 6 characters" required autocomplete="new-password"
        style="width:100%;margin-bottom:12px;">
      <p style="margin-bottom:4px;font-size:13px;">Confirm New Password</p>
      <input name="confirmPassword" type="password" placeholder="Repeat new password" required autocomplete="new-password"
        style="width:100%;margin-bottom:16px;">
      <button type="submit" style="width:100%;">Reset Password</button>
    </form>
  `;
  html += htmlFooter('');
  res.send(html);
});

app.post('/reset-password', async (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const { email, otp, password, confirmPassword } = req.body || {};
  const errBase = `/reset-password?email=${encodeURIComponent(email || '')}`;

  if (!email || !otp || !password || !confirmPassword)
    return res.redirect(`${errBase}&error=All+fields+are+required.`);
  if (password !== confirmPassword)
    return res.redirect(`${errBase}&error=Passwords+do+not+match.`);
  if (password.length < 6)
    return res.redirect(`${errBase}&error=Password+must+be+at+least+6+characters.`);

  try {
    const pending = await db.get(`reset-otp:${email.toLowerCase()}`);
    if (!pending) return res.redirect(`${errBase}&error=OTP+expired.+Please+start+over.`);
    if (Date.now() > pending.expiresAt) {
      await db.delete(`reset-otp:${email.toLowerCase()}`);
      return res.redirect(`${errBase}&error=OTP+expired.+Please+start+over.`);
    }
    if (otp.trim() !== pending.otp)
      return res.redirect(`${errBase}&error=Incorrect+OTP.+Please+try+again.`);

    const newHash = await bcrypt.hash(password, 10);
    const user = await getUserByEmail(email);
    user.passwordHash = newHash;
    await db.set(`user:${user.userId.toLowerCase()}`, user);
    await db.delete(`reset-otp:${email.toLowerCase()}`);

    res.redirect('/login?msg=Password+reset+successfully.+Please+log+in.');
  } catch (e) {
    console.error('[ResetPassword]', e.message);
    res.redirect(`${errBase}&error=Something+went+wrong.+Please+try+again.`);
  }
});

/* ---------------- ROUTES ---------------- */

// HOME / DASHBOARD – reads from in-memory snapshot only, no API calls
app.get('/', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const cutoff = 10 * 60 * 1000; // 10 min in ms
    // Show events that haven't kicked off yet (betting still open or about to close)
    const events = fixtureSnapshot.filter(ev => new Date(ev.commence_time) > now);

    const byLeague = {};
    for (const ev of events) {
      const title = ev.sport_title || 'Unknown League';
      if (!byLeague[title]) byLeague[title] = [];
      byLeague[title].push(ev);
    }

    const nextOddsUpdate = (() => {
      const n = moment().tz(TIMEZONE);
      const next = n.clone().startOf('hour');
      if (next.hour() % 2 !== 0) next.add(1, 'hour');
      else if (n.minute() > 0) next.add(2, 'hours');
      // round to next even hour
      if (next.hour() % 2 !== 0) next.add(1, 'hour');
      return next.format('h:mm A z');
    })();
    const fetchInfo = snapshotMeta
      ? `<p style="font-size:11px;color:#6b7280;margin-top:0;">Fixtures last updated: ${snapshotMeta.fetchedAt} • Next update: ${nextOddsUpdate}</p>`
      : `<p style="font-size:11px;color:#f59e0b;">Fixtures not yet loaded — next update at ${nextOddsUpdate}.</p>`;

    const sessionUserId = req.session.userId;
    const userGreeting = sessionUserId
      ? `<p style="font-size:13px;margin-bottom:12px;">👤 <strong>${sessionUserId}</strong> — <a href="/summary">My Stats</a> · <a href="/logout">Log out</a></p>`
      : `<p style="font-size:13px;margin-bottom:12px;"><a href="/login">Log in</a> or <a href="/register">Register</a> to make predictions</p>`;

    // Build a map of fixtureId → total staked by this user for home page badges
    const userBetMap = {};
    if (sessionUserId) {
      const allUserBets = (await getBets()).filter(b => b.user === sessionUserId);
      for (const b of allUserBets) {
        userBetMap[b.fixtureId] = (userBetMap[b.fixtureId] || 0) + b.stake;
      }
    }

    let html = htmlHeader('No Betting Zone - Home');
    html += `
      <div class="title">No Betting Zone</div>
      ${userGreeting}
      ${fetchInfo}
      <h3>Upcoming matches</h3>
    `;

    const leagueNames = Object.keys(byLeague).sort();
    if (!leagueNames.length) {
      html += `<p style="color:#9ca3af;">No upcoming fixtures in today's snapshot. Check back after 12 noon IST.</p>`;
    } else {
      html += `<style>
        details.tournament { border:1px solid #1f2937; border-radius:10px; margin-bottom:10px; overflow:hidden; }
        details.tournament > summary {
          cursor:pointer; padding:12px 16px; font-size:15px; font-weight:600;
          background:#0f172a; list-style:none; display:flex; justify-content:space-between; align-items:center;
          user-select:none;
        }
        details.tournament > summary::-webkit-details-marker { display:none; }
        details.tournament > summary::after { content:'▸'; font-size:12px; color:#6b7280; transition:transform .2s; }
        details.tournament[open] > summary::after { content:'▾'; }
        details.tournament > summary:hover { background:#1e293b; }

        details.match-item { border-top:1px solid #1f2937; }
        details.match-item > summary {
          cursor:pointer; padding:10px 16px; list-style:none; display:flex;
          justify-content:space-between; align-items:center; gap:8px;
          background:#020617; user-select:none;
        }
        details.match-item > summary::-webkit-details-marker { display:none; }
        details.match-item > summary:hover { background:#0f172a; }
        details.match-item > summary .match-name { font-size:14px; }
        details.match-item > summary .match-meta { font-size:11px; color:#6b7280; white-space:nowrap; }

        .bet-panel { padding:12px 16px; background:#0a0f1e; border-top:1px solid #1f2937; }
        .odds-row { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; }
        .odds-btn {
          flex:1; min-width:80px; padding:8px 6px; border-radius:8px; border:1px solid #374151;
          background:#1f2937; color:#e5e7eb; font-size:13px; text-align:center;
        }
        .odds-btn .label { font-size:11px; color:#9ca3af; }
        .odds-btn .value { font-weight:700; font-size:15px; margin-top:2px; }
      </style>`;

      for (const leagueName of leagueNames) {
        const list = byLeague[leagueName].slice(0, 15);
        html += `<details class="tournament">
          <summary>${leagueName} <span style="font-size:12px;font-weight:400;color:#6b7280;">${list.length} match${list.length !== 1 ? 'es' : ''}</span></summary>`;

        for (const ev of list) {
          const kickoff = new Date(ev.commence_time);
          const minsLeft = Math.round((kickoff - now) / 60000);
          const bettingOpen = kickoff - now > cutoff;
          const dateStr = moment(ev.commence_time).tz(TIMEZONE).format('DD MMM, HH:mm');
          const badge = !bettingOpen
            ? `<span style="font-size:11px;color:#6b7280;border:1px solid #374151;border-radius:4px;padding:1px 5px;">Closed</span>`
            : minsLeft < 60
              ? `<span style="font-size:11px;color:#f59e0b;border:1px solid #f59e0b;border-radius:4px;padding:1px 5px;">Closes ${minsLeft}m</span>`
              : '';

          // Extract 1X2 odds if available
          const h2h = (ev.bookmakers?.[0]?.markets || []).find(m => m.key === 'h2h');
          let oddsHtml = '';
          if (h2h && h2h.outcomes) {
            const home = h2h.outcomes.find(o => o.name === ev.home_team);
            const away = h2h.outcomes.find(o => o.name === ev.away_team);
            const draw = h2h.outcomes.find(o => o.name === 'Draw');
            oddsHtml = `<div class="odds-row">
              <div class="odds-btn"><div class="label">Home</div><div class="value">${home ? home.price : '—'}</div></div>
              ${draw ? `<div class="odds-btn"><div class="label">Draw</div><div class="value">${draw.price}</div></div>` : ''}
              <div class="odds-btn"><div class="label">Away</div><div class="value">${away ? away.price : '—'}</div></div>
            </div>`;
          }

          html += `<details class="match-item">
            <summary>
              <span class="match-name">${ev.home_team} vs ${ev.away_team}</span>
              <span style="display:flex;align-items:center;gap:6px;">${badge}<span class="match-meta">${dateStr}</span></span>
            </summary>
            <div class="bet-panel">
              ${oddsHtml || '<p style="font-size:12px;color:#6b7280;margin:0 0 8px;">Odds not yet available.</p>'}
              ${(() => {
                const staked = userBetMap[ev.id] || 0;
                const remaining = 100 - staked;
                if (!bettingOpen) return `<p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Betting closed for this match.</p>`;
                if (staked === 0) return `<a href="/match?id=${ev.id}" style="display:inline-block;margin-top:6px;font-size:13px;padding:7px 14px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;">Make prediction →</a>`;
                if (remaining > 0) return `<a href="/match?id=${ev.id}" style="display:inline-block;margin-top:6px;font-size:13px;padding:7px 14px;background:#92400e;color:#fbbf24;border-radius:8px;text-decoration:none;">✏️ ${staked}/100 pts staked — add more →</a>`;
                return `<a href="/match?id=${ev.id}" style="display:inline-block;margin-top:6px;font-size:13px;padding:7px 14px;background:#14532d;color:#22c55e;border-radius:8px;text-decoration:none;">✓ Fully staked (100 pts)</a>`;
              })()}
            </div>
          </details>`;
        }
        html += `</details>`;
      }
    }

    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error: ' + e.message);
  }
});

// USER PAGE – see own bets (session-based)
app.get('/me', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (!user) return res.redirect('/login');
  const bets = (await getBets()).filter(b => b.user === user.userId);

  let html = htmlHeader(`${user.displayName} - No Betting Zone`);
  html += `
    <h2>Hello, ${user.displayName}</h2>
    <p>Total points: ${user.totalNetPoints.toFixed(1)}</p>
    <h3>Your bets</h3>
  `;

  if (!bets.length) {
    html += `<p>No bets yet. Go to <a href="/">Home</a> and pick a match.</p>`;
  } else {
    for (const b of bets) {
      const statusColor = b.status === 'WON' ? '#22c55e' : b.status === 'LOST' ? '#ef4444' : '#9ca3af';
      const netLabel = b.netPoints !== null
        ? `<span style="color:${b.netPoints >= 0 ? '#22c55e' : '#ef4444'};font-weight:bold;">
            ${b.netPoints >= 0 ? '+' : ''}${b.netPoints.toFixed(1)} pts
           </span>`
        : '';
      html += `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:14px;">${b.leagueName}</div>
            <span style="font-size:11px;font-weight:bold;color:${statusColor};border:1px solid ${statusColor};border-radius:4px;padding:2px 6px;">${b.status}</span>
          </div>
          <div style="font-size:12px;color:#9ca3af;margin-top:4px;">
            Pick: <strong style="color:#e5e7eb;">${b.selection}</strong> @ ${b.lockedOdds} • Stake: ${b.stake} pts
          </div>
          ${b.result ? `<div style="font-size:12px;color:#9ca3af;">Result: ${b.result}</div>` : ''}
          ${netLabel ? `<div style="margin-top:4px;">${netLabel}</div>` : ''}
        </div>
      `;
    }
  }

  html += htmlFooter('home');
  res.send(html);
});

// MATCH PAGE – single match view + 1X2 prediction
app.get('/match', requireAuth, async (req, res) => {
  const eventId = req.query.id;
  if (!eventId) return res.redirect('/');

  try {
    const event = await getEventById(eventId);
    if (!event) return res.status(404).send('Match not found. It may have started or expired.');

    const home = event.home_team;
    const away = event.away_team;
    const date = moment(event.commence_time).tz(TIMEZONE).format('DD MMM, HH:mm');
    const leagueName = event.sport_title || 'Unknown League';
    const odds = extractOdds(event);
    const oddsToShow = odds || [
      { value: 'Home', odd: '1.90' },
      { value: 'Draw', odd: '3.20' },
      { value: 'Away', odd: '2.10' },
    ];

    // Fetch existing bets for this fixture
    const allBets = await getBets();
    const fixtureBets = allBets.filter(b => b.fixtureId === eventId);
    const myBets = fixtureBets.filter(b => b.user === req.session.userId);
    const myTotalStaked = myBets.reduce((s, b) => s + b.stake, 0);
    const myRemaining = 100 - myTotalStaked;
    const mySelection = myBets.length > 0 ? myBets[0].selection : null;

    const labelMap = { Home: `${home} wins`, Draw: 'Draw', Away: `${away} wins` };

    let html = htmlHeader(`${home} vs ${away} - No Betting Zone`);
    html += `
      <h2>${home} vs ${away}</h2>
      <div style="font-size:12px;color:#9ca3af;">${leagueName} • ${date}</div>
      <hr style="border-color:#1f2937;margin:12px 0;">
    `;

    // Is betting still open?
    const kickoffTime = new Date(event.commence_time);
    const bettingOpen = new Date() < new Date(kickoffTime.getTime() - 10 * 60 * 1000);

    // Show existing tranches if any
    if (myBets.length > 0) {
      const tranchemsLabel = myBets.length === 1 ? '1 tranche' : `${myBets.length} tranches`;
      html += `
        <div style="background:#111827;border:1px solid ${myRemaining === 0 || !bettingOpen ? '#22c55e' : '#f59e0b'};border-radius:10px;padding:14px 16px;margin-bottom:14px;">
          <div style="font-size:12px;color:${myRemaining === 0 || !bettingOpen ? '#22c55e' : '#fbbf24'};margin-bottom:8px;">
            ${myRemaining === 0 || !bettingOpen ? '✓ Your prediction (locked)' : `✏️ Your prediction — ${myRemaining} pts remaining`}
          </div>
          <div style="font-size:14px;font-weight:700;margin-bottom:8px;">${labelMap[mySelection] || mySelection}</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="color:#6b7280;font-size:11px;">
              <th style="text-align:left;padding:3px 0;">Tranche</th>
              <th style="text-align:right;padding:3px 4px;">Stake</th>
              <th style="text-align:right;padding:3px 0;">Odds locked</th>
            </tr></thead>
            <tbody>
              ${myBets.map((b, i) => `
                <tr style="border-top:1px solid #1f2937;">
                  <td style="padding:4px 0;color:#9ca3af;">#${i + 1}</td>
                  <td style="padding:4px 4px;text-align:right;color:#a78bfa;">${b.stake} pts</td>
                  <td style="padding:4px 0;text-align:right;color:#22c55e;">${b.lockedOdds}x</td>
                </tr>`).join('')}
              <tr style="border-top:1px solid #374151;font-weight:700;">
                <td style="padding:4px 0;font-size:11px;color:#9ca3af;">TOTAL</td>
                <td style="padding:4px 4px;text-align:right;color:#a78bfa;">${myTotalStaked} pts</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }

    // Show form if betting open and stake remaining
    if (bettingOpen && myRemaining > 0) {
      const availableStakes = [20, 40, 60, 80, 100].filter(s => s <= myRemaining);
      const defaultStake = availableStakes[availableStakes.length - 1];
      html += `
        <form method="POST" action="/bet">
          <input type="hidden" name="eventId" value="${eventId}">
          <input type="hidden" name="leagueName" value="${leagueName}">
          <p style="margin-bottom:6px;">${myBets.length > 0 ? 'Add another tranche (1X2):' : 'Pick result (1X2):'}</p>
      `;
      oddsToShow.forEach(o => {
        const isLocked = mySelection !== null && o.value !== mySelection;
        const isSelected = mySelection === o.value;
        html += `
          <div style="margin-bottom:8px;${isLocked ? 'opacity:0.35;pointer-events:none;' : ''}">
            <label style="display:flex;align-items:center;gap:10px;background:#111827;border:1px solid ${isSelected ? '#22c55e' : '#1f2937'};border-radius:8px;padding:10px 12px;cursor:${isLocked ? 'not-allowed' : 'pointer'};">
              <input type="radio" name="selection" value="${o.value}" ${isSelected || (!mySelection && o.value === oddsToShow[0].value) ? '' : ''} ${isSelected ? 'checked' : ''} ${isLocked ? 'disabled' : ''} required style="accent-color:#22c55e;width:18px;height:18px;">
              <span style="flex:1;font-size:14px;">${labelMap[o.value] || o.value}${isLocked ? ' <span style="font-size:11px;color:#6b7280;">(locked out)</span>' : ''}</span>
              <span style="font-size:13px;font-weight:bold;color:#22c55e;">${o.odd}</span>
            </label>
          </div>
        `;
      });
      html += `
          <p style="margin:14px 0 6px;">Choose stake <span style="font-size:11px;color:#9ca3af;">(max ${myRemaining} pts remaining)</span>:</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
            ${[20, 40, 60, 80, 100].map(s => {
              const disabled = s > myRemaining;
              const isDefault = s === defaultStake;
              return `
              <label style="flex:1;min-width:48px;text-align:center;cursor:${disabled ? 'not-allowed' : 'pointer'};${disabled ? 'opacity:0.3;' : ''}" ${disabled ? '' : `onclick="selectStake(this, ${s})"`}>
                <input type="radio" name="stake" value="${s}" ${isDefault ? 'checked' : ''} ${disabled ? 'disabled' : ''} required style="display:none;">
                <span class="stake-btn" style="display:block;padding:8px 4px;border:1px solid ${isDefault ? '#7c3aed' : '#374151'};border-radius:8px;font-size:14px;font-weight:600;background:${isDefault ? '#4c1d95' : '#1f2937'};color:#fff;">${s}</span>
              </label>`;
            }).join('')}
          </div>
          <script>
            function selectStake(clicked, val) {
              document.querySelectorAll('.stake-btn').forEach(function(btn) {
                btn.style.borderColor = '#374151';
                btn.style.background = '#1f2937';
              });
              var span = clicked.querySelector('.stake-btn');
              span.style.borderColor = '#7c3aed';
              span.style.background = '#4c1d95';
            }
          </script>
          <button type="submit" style="margin-top:4px;width:100%;">${myBets.length > 0 ? 'Add Tranche' : 'Place Bet'}</button>
        </form>
        <p style="margin-top:8px;font-size:11px;color:#6b7280;">${odds ? '📊 Live bookmaker odds' : '📊 Estimated odds'}</p>

        <!-- Confirmation overlay -->
        <div id="bet-confirm-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:999;align-items:center;justify-content:center;">
          <div style="background:#111827;border:1px solid #374151;border-radius:14px;padding:24px 20px;max-width:320px;width:90%;text-align:center;">
            <div style="font-size:15px;font-weight:700;color:#e5e7eb;margin-bottom:6px;">${myBets.length > 0 ? 'Add tranche' : 'Confirm bet'}</div>
            <div style="font-size:13px;color:#9ca3af;margin-bottom:14px;">${home} vs ${away}</div>
            <div style="background:#1f2937;border-radius:8px;padding:12px;margin-bottom:16px;">
              <div style="font-size:13px;color:#9ca3af;">Pick</div>
              <div id="confirm-pick" style="font-size:16px;font-weight:700;color:#e5e7eb;margin-top:2px;"></div>
              <div style="font-size:13px;color:#9ca3af;margin-top:8px;">Stake</div>
              <div id="confirm-stake" style="font-size:16px;font-weight:700;color:#a78bfa;margin-top:2px;"></div>
            </div>
            <div style="display:flex;gap:10px;">
              <button id="bet-cancel-btn" style="flex:1;background:#1f2937;color:#9ca3af;border:1px solid #374151;padding:12px;border-radius:8px;font-size:14px;font-weight:600;">Cancel</button>
              <button id="bet-confirm-btn" style="flex:1;padding:12px;border-radius:8px;font-size:14px;font-weight:600;">Confirm</button>
            </div>
          </div>
        </div>
        <script>
          (function() {
            const form = document.querySelector('form[action="/bet"]');
            const overlay = document.getElementById('bet-confirm-overlay');
            const labelMap = { Home: '${home} wins', Draw: 'Draw', Away: '${away} wins' };
            let confirmed = false;
            form.addEventListener('submit', function(e) {
              if (confirmed) return;
              e.preventDefault();
              const sel = form.querySelector('input[name="selection"]:checked');
              const stk = form.querySelector('input[name="stake"]:checked');
              if (!sel || !stk) return;
              document.getElementById('confirm-pick').textContent = labelMap[sel.value] || sel.value;
              document.getElementById('confirm-stake').textContent = stk.value + ' pts';
              overlay.style.display = 'flex';
            });
            document.getElementById('bet-cancel-btn').addEventListener('click', function() {
              overlay.style.display = 'none';
            });
            document.getElementById('bet-confirm-btn').addEventListener('click', function() {
              confirmed = true;
              overlay.style.display = 'none';
              form.submit();
            });
          })();
        </script>
      `;
    } else if (!bettingOpen && myBets.length === 0) {
      html += `<p style="font-size:13px;color:#6b7280;">Betting closed for this match.</p>`;
    }

    // Predictions so far table — grouped by player
    const byPlayer = {};
    for (const b of fixtureBets) {
      if (!byPlayer[b.user]) byPlayer[b.user] = { selection: b.selection, totalStake: 0, bets: [] };
      byPlayer[b.user].totalStake += b.stake;
      byPlayer[b.user].bets.push(b);
    }
    const allPlayerEntries = Object.entries(byPlayer);
    const poolTotal = fixtureBets.reduce((s, b) => s + b.stake, 0);

    // While betting is open, only show the current user's own row
    const visibleEntries = bettingOpen
      ? allPlayerEntries.filter(([userId]) => userId === req.session.userId)
      : allPlayerEntries;

    html += `<hr style="border-color:#1f2937;margin:16px 0;">`;
    if (allPlayerEntries.length === 0) {
      html += `<p style="font-size:13px;color:#6b7280;">No predictions placed yet.</p>`;
    } else {
      html += `
        <p style="font-size:13px;color:#9ca3af;margin-bottom:8px;">
          Predictions so far &nbsp;·&nbsp; <strong style="color:#e5e7eb;">${allPlayerEntries.length}</strong> player${allPlayerEntries.length !== 1 ? 's' : ''}
          &nbsp;·&nbsp; Pool: <strong style="color:#e5e7eb;">${poolTotal} pts</strong>
          ${bettingOpen ? `&nbsp;·&nbsp; <span style="font-size:11px;color:#6b7280;">(others hidden until kick-off)</span>` : ''}
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid #1f2937;color:#6b7280;font-size:11px;text-transform:uppercase;">
              <th style="padding:6px 4px;text-align:left;">Player</th>
              <th style="padding:6px 4px;text-align:left;">Pick</th>
              <th style="padding:6px 4px;text-align:right;">Total Stake</th>
              <th style="padding:6px 4px;text-align:right;">Avg Odds</th>
            </tr>
          </thead>
          <tbody>
            ${visibleEntries.length === 0
              ? `<tr><td colspan="4" style="padding:10px 4px;color:#6b7280;font-size:12px;">You haven't placed a bet on this match yet.</td></tr>`
              : visibleEntries.map(([userId, data]) => {
                  const isMe = userId === req.session.userId;
                  const selLabel = labelMap[data.selection] || data.selection;
                  const wavgOdds = (data.bets.reduce((s, b) => s + b.lockedOdds * b.stake, 0) / data.totalStake).toFixed(2);
                  return `<tr style="border-bottom:1px solid #1f2937;${isMe ? 'color:#22c55e;' : ''}">
                    <td style="padding:8px 4px;">${userId}${isMe ? ' ★' : ''}</td>
                    <td style="padding:8px 4px;">${selLabel}</td>
                    <td style="padding:8px 4px;text-align:right;">${data.totalStake}</td>
                    <td style="padding:8px 4px;text-align:right;">${wavgOdds}x</td>
                  </tr>`;
                }).join('')
            }
          </tbody>
        </table>
      `;
    }

    html += `<p style="margin-top:12px;"><a href="/">← Back to Home</a></p>`;
    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading match: ' + e.message);
  }
});

// HANDLE BET – tranche-based, up to 100 pts per user per fixture
app.post('/bet', requireAuth, async (req, res) => {
  const { eventId, selection, leagueName } = req.body || {};
  if (!eventId || !selection) {
    return res.status(400).send('Missing fields');
  }

  const user = await getUserById(req.session.userId);
  if (!user) return res.redirect('/login');
  const event = await getEventById(eventId);
  if (!event) return res.status(400).send('Match not found');

  // Betting closes 10 minutes before kick-off
  const kickoff = new Date(event.commence_time);
  const tenMinsBefore = new Date(kickoff.getTime() - 10 * 60 * 1000);
  if (new Date() >= tenMinsBefore) {
    const timeStr = moment(kickoff).tz(TIMEZONE).format('DD MMM, HH:mm');
    return res.send(`Betting closed — predictions locked 10 minutes before kick-off (${timeStr} IST).`);
  }

  // Validate stake
  const stakeInput = parseInt(req.body.stake);
  if (![20, 40, 60, 80, 100].includes(stakeInput)) {
    return res.status(400).send('Invalid stake amount.');
  }
  const stake = stakeInput;

  // Enforce same selection as existing tranches
  const bets = await getBets();
  const existingTranches = bets.filter(b => b.user === user.userId && b.fixtureId === eventId);
  if (existingTranches.length > 0 && existingTranches[0].selection !== selection) {
    return res.status(400).send(`You must bet on the same outcome as your existing tranches (${existingTranches[0].selection}).`);
  }

  // Enforce 100-pt cap per fixture
  const alreadyStaked = existingTranches.reduce((s, b) => s + b.stake, 0);
  if (alreadyStaked + stake > 100) {
    return res.status(400).send(`Only ${100 - alreadyStaked} pts remaining for this match.`);
  }

  // Lock in odds from the current snapshot at time of this tranche
  const odds = extractOdds(event);
  let lockedOdds = 2.0;
  if (odds) {
    const match = odds.find(o => o.value === selection);
    if (match) lockedOdds = parseFloat(match.odd) || 2.0;
  }

  const isFirstTranche = existingTranches.length === 0;
  const bet = {
    id: Date.now().toString(),
    user: user.userId,
    fixtureId: eventId,
    sportKey: event.sport_key,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    leagueName: leagueName || event.sport_title || 'Unknown League',
    commenceTime: event.commence_time || '',
    market: 'MATCH_RESULT',
    selection,
    stake,
    lockedOdds,
    status: 'PENDING',
    netPoints: null,
    result: null,
  };
  await addBet(bet);

  const totalNow = alreadyStaked + stake;
  const remaining = 100 - totalNow;

  const selectionLabel = selection === 'Home' ? `${event.home_team} wins`
    : selection === 'Away' ? `${event.away_team} wins`
    : 'Draw';

  res.send(`
    <html><body style="background:#020617;color:#e5e7eb;font-family:system-ui;padding:20px;">
      <div style="max-width:400px;margin:0 auto;text-align:center;padding-top:40px;">
        <div style="font-size:48px;margin-bottom:12px;">${isFirstTranche ? '✅' : '➕'}</div>
        <h2 style="font-size:22px;margin-bottom:6px;">${isFirstTranche ? 'Bet Placed!' : 'Tranche Added!'}</h2>
        <p style="font-size:15px;color:#9ca3af;margin-bottom:24px;">${event.home_team} vs ${event.away_team}</p>
        <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;margin-bottom:24px;">
          <div style="font-size:13px;color:#9ca3af;margin-bottom:4px;">Your pick</div>
          <div style="font-size:22px;font-weight:700;color:#e5e7eb;margin-bottom:16px;">${selectionLabel}</div>
          <div style="display:flex;justify-content:space-around;margin-bottom:12px;">
            <div>
              <div style="font-size:13px;color:#9ca3af;">This tranche</div>
              <div style="font-size:20px;font-weight:700;color:#a78bfa;">${stake} pts</div>
            </div>
            <div>
              <div style="font-size:13px;color:#9ca3af;">Odds locked</div>
              <div style="font-size:20px;font-weight:700;color:#22c55e;">${lockedOdds}x</div>
            </div>
          </div>
          <div style="font-size:12px;color:#9ca3af;border-top:1px solid #374151;padding-top:10px;display:flex;justify-content:space-between;">
            <span>Total staked on match</span>
            <strong style="color:#e5e7eb;">${totalNow} / 100 pts</strong>
          </div>
          ${remaining > 0 ? `<div style="font-size:12px;color:#fbbf24;margin-top:4px;">${remaining} pts remaining — add another tranche from the match page.</div>` : `<div style="font-size:12px;color:#22c55e;margin-top:4px;">Fully staked on this match.</div>`}
        </div>
        <div style="display:flex;gap:12px;">
          <a href="/match?id=${eventId}" style="flex:1;padding:12px;background:#1f2937;color:#e5e7eb;border-radius:8px;text-decoration:none;font-size:15px;text-align:center;">Match</a>
          <a href="/summary" style="flex:1;padding:12px;background:#22c55e;color:#000;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;text-align:center;">My Bets</a>
        </div>
      </div>
    </body></html>
  `);
});

// MY PREDICTIONS SUMMARY PAGE
app.get('/summary', requireAuth, async (req, res) => {
  const user = await getUserById(req.session.userId);
  if (!user) return res.redirect('/login');
  const bets = (await getBets()).filter(b => b.user === user.userId);

  const total = bets.length;
  const won = bets.filter(b => b.status === 'WON').length;
  const lost = bets.filter(b => b.status === 'LOST').length;
  const pending = bets.filter(b => b.status === 'PENDING').length;
  const winRate = total - pending > 0 ? Math.round((won / (total - pending)) * 100) : 0;
  const totalNet = user.totalNetPoints;

  let html = htmlHeader(`${user.displayName} - My Predictions`);
  html += `
    <h2 style="margin-bottom:4px;">${user.displayName}</h2>
    <p style="color:#9ca3af;font-size:13px;margin-top:0;">Prediction history</p>

    <!-- Stats strip -->
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px;">
      <div class="card" style="text-align:center;">
        <div style="font-size:22px;font-weight:bold;color:#e5e7eb;">${total}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">TOTAL PICKS</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:22px;font-weight:bold;color:${totalNet >= 0 ? '#22c55e' : '#ef4444'};">${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(1)}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">NET POINTS</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:22px;font-weight:bold;color:#22c55e;">${won}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">WINS</div>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:22px;font-weight:bold;color:#ef4444;">${lost}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">LOSSES</div>
      </div>
    </div>

    <!-- Win rate bar -->
    ${total - pending > 0 ? `
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#9ca3af;margin-bottom:6px;">
        <span>Win rate</span><span style="color:#e5e7eb;font-weight:bold;">${winRate}%</span>
      </div>
      <div style="background:#1f2937;border-radius:4px;height:8px;overflow:hidden;">
        <div style="background:#22c55e;height:100%;width:${winRate}%;border-radius:4px;transition:width 0.3s;"></div>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;">${won}W / ${lost}L${pending > 0 ? ` / ${pending} pending` : ''}</div>
    </div>` : ''}

    <h3 style="font-size:14px;margin-bottom:8px;">All Predictions</h3>
  `;

  if (!bets.length) {
    html += `<p style="color:#9ca3af;">No predictions yet. <a href="/">Pick a match</a> to get started.</p>`;
  } else {
    // Group tranches by fixture — one card per match
    const byFixture = {};
    for (const b of bets) {
      if (!byFixture[b.fixtureId]) byFixture[b.fixtureId] = [];
      byFixture[b.fixtureId].push(b);
    }

    // Pre-fetch snapshot events for pending fixtures (kickoff time)
    const eventCache = {};
    for (const [fid, tranches] of Object.entries(byFixture)) {
      if (tranches.some(t => t.status === 'PENDING') && !eventCache[fid]) {
        const ev = await getEventById(fid);
        if (ev) eventCache[fid] = ev;
      }
    }

    // Sort fixture groups: pending first (by earliest tranche timestamp desc), then settled
    const groups = Object.entries(byFixture).map(([fid, tranches]) => {
      const first = tranches[0];
      const totalStake = tranches.reduce((s, t) => s + t.stake, 0);
      const totalNet = tranches.reduce((s, t) => s + (t.netPoints ?? 0), 0);
      const hasPending = tranches.some(t => t.status === 'PENDING');
      const status = hasPending ? 'PENDING' : (tranches.some(t => t.status === 'WON') ? 'WON' : 'LOST');
      return { fid, tranches, first, totalStake, totalNet, status };
    });
    groups.sort((a, b) => (a.status === 'PENDING' ? -1 : 1) - (b.status === 'PENDING' ? -1 : 1));

    for (const { fid, tranches, first, totalStake, totalNet, status } of groups) {
      const statusColor = status === 'WON' ? '#22c55e' : status === 'LOST' ? '#ef4444' : '#f59e0b';
      const matchTitle = first.homeTeam && first.awayTeam
        ? `${first.homeTeam} vs ${first.awayTeam}`
        : first.leagueName;
      const selectionMap = { Home: `${first.homeTeam} wins`, Draw: 'Draw', Away: `${first.awayTeam} wins` };
      const selLabel = selectionMap[first.selection] || first.selection;
      const ev = eventCache[fid];
      const kickoffLine = ev
        ? `<div style="font-size:11px;color:#6b7280;margin-top:1px;">${moment(ev.commence_time).tz(TIMEZONE).format('DD MMM, HH:mm')} IST</div>`
        : '';
      const netLabel = status !== 'PENDING'
        ? `<span style="font-weight:bold;color:${totalNet >= 0 ? '#22c55e' : '#ef4444'};">${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(1)} pts</span>`
        : `<span style="color:#f59e0b;">Pending settlement</span>`;

      // Tranche breakdown rows
      const trancheRows = tranches.map((t, i) => `
        <tr style="border-top:1px solid #1f2937;">
          <td style="padding:3px 0;color:#9ca3af;">#${i + 1}</td>
          <td style="padding:3px 4px;text-align:right;color:#a78bfa;">${t.stake} pts</td>
          <td style="padding:3px 0;text-align:right;color:#22c55e;">${t.lockedOdds}x</td>
        </tr>`).join('');

      const cardInner = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-size:14px;font-weight:700;color:#e5e7eb;">${matchTitle}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:1px;">${first.leagueName}</div>
            ${kickoffLine}
          </div>
          <span style="font-size:11px;font-weight:bold;color:${statusColor};border:1px solid ${statusColor};border-radius:4px;padding:2px 6px;white-space:nowrap;margin-left:8px;">${status}</span>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-top:8px;">
          Pick: <strong style="color:#e5e7eb;">${selLabel}</strong> &nbsp;·&nbsp; Total staked: <strong style="color:#a78bfa;">${totalStake} pts</strong>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px;">
          <thead><tr style="color:#6b7280;">
            <th style="text-align:left;padding:2px 0;">Tranche</th>
            <th style="text-align:right;padding:2px 4px;">Stake</th>
            <th style="text-align:right;padding:2px 0;">Odds</th>
          </tr></thead>
          <tbody>${trancheRows}</tbody>
        </table>
        ${first.result ? `<div style="font-size:12px;color:#9ca3af;margin-top:6px;">Result: <strong style="color:#e5e7eb;">${first.result}</strong></div>` : ''}
        <div style="font-size:13px;margin-top:6px;">${netLabel}</div>
        ${status === 'PENDING' ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;">Tap to add another tranche →</div>` : ''}
      `;

      if (status === 'PENDING') {
        html += `<a href="/match?id=${fid}" style="display:block;text-decoration:none;color:inherit;">
          <div class="card" style="border-color:#374151;">${cardInner}</div>
        </a>`;
      } else {
        html += `<div class="card">${cardInner}</div>`;
      }
    }
  }

  html += htmlFooter('summary');
  res.send(html);
});

// RULES – read-only explanation of results & settlement logic
app.get('/rules', requireAuth, (req, res) => {
  let html = htmlHeader('Rules - No Betting Zone');
  html += `
    <h2 style="margin-bottom:4px;">How It Works</h2>
    <p style="color:#9ca3af;font-size:13px;margin-top:0;margin-bottom:20px;">Results logic &amp; settlement explained</p>

    <!-- Predictions -->
    <div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Making a Prediction</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#d1d5db;">
        <li>Each match offers three outcomes — <strong style="color:#e5e7eb;">Home win, Draw, Away win</strong> (1X2 format).</li>
        <li>Pick one outcome and choose a stake: <strong style="color:#a78bfa;">20 / 40 / 60 / 80 / 100 points</strong>.</li>
        <li>Betting closes <strong style="color:#e5e7eb;">10 minutes before kick-off</strong>. No changes after that.</li>
        <li>You can stake up to <strong style="color:#e5e7eb;">100 points per match</strong> in multiple tranches — e.g. 40 pts now, then 60 pts later. Each tranche must be a multiple of 20 pts (20 / 40 / 60 / 80 / 100) and locks in the odds at the time it is placed.</li>
        <li>All tranches on a match must be on the <strong style="color:#e5e7eb;">same outcome</strong>. Betting closes 10 minutes before kick-off — no new tranches after that.</li>
      </ul>
    </div>

    <!-- Group stage -->
    <div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Group Stage — Results</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#d1d5db;">
        <li>Result is determined by the <strong style="color:#e5e7eb;">full-time (90-minute) score</strong>.</li>
        <li>Home win, Draw, or Away win — straightforward 1X2 settlement.</li>
      </ul>
    </div>

    <!-- Knockout stage -->
    <div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Knockout Stage — Results</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#d1d5db;">
        <li>Result is still based on the <strong style="color:#e5e7eb;">90-minute score only</strong>. Extra time and penalty shootouts are <strong style="color:#e5e7eb;">not</strong> considered.</li>
        <li>If the match is level after 90 minutes, the result is settled as a <strong style="color:#e5e7eb;">Draw</strong> — regardless of who wins on penalties.</li>
        <li>"Draw" in a knockout match means the game was tied at full-time and went to extra time/penalties.</li>
      </ul>
    </div>

    <!-- Settlement -->
    <div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Settlement — How Points Are Calculated</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#d1d5db;">
        <li>All stakes from all players on a match form a <strong style="color:#e5e7eb;">shared pool</strong>.</li>
        <li>Only players who picked the correct outcome share the pool.</li>
        <li>Your share is proportional to your <strong style="color:#e5e7eb;">stake × your locked odds</strong> relative to the total of all correct picks' weighted stakes.</li>
        <li>If nobody picks correctly, all stakes are forfeited and no points are paid out.</li>
        <li><strong style="color:#e5e7eb;">Net points</strong> = payout received − stake paid. This can be positive (profit) or negative (loss).</li>
      </ul>
      <div style="background:#0f172a;border-radius:8px;padding:12px;margin-top:12px;font-size:13px;color:#9ca3af;">
        <div style="color:#e5e7eb;font-weight:600;margin-bottom:4px;">Example</div>
        Pool = 200 pts. Correct pickers: Player A (stake 100, odds 2.0) and Player B (stake 60, odds 2.0).<br>
        Weighted: A = 200, B = 120. Total = 320.<br>
        A gets <strong style="color:#22c55e;">200 ÷ 320 × 200 = 125 pts</strong> payout → net <strong style="color:#22c55e;">+25 pts</strong>.<br>
        B gets <strong style="color:#22c55e;">120 ÷ 320 × 200 = 75 pts</strong> payout → net <strong style="color:#22c55e;">+15 pts</strong>.
      </div>
    </div>

    <!-- Settlement timing -->
    <div class="card" style="margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Settlement Timing</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#d1d5db;">
        <li>Odds are refreshed every <strong style="color:#e5e7eb;">2 hours</strong>. Results are checked and settled once daily at <strong style="color:#e5e7eb;">12 noon IST</strong>.</li>
        <li>Bets are settled as soon as the result is confirmed by the data source.</li>
        <li>Settled results appear on the <a href="/results" style="color:#22c55e;">Results</a> page and your <a href="/summary" style="color:#22c55e;">My Stats</a> page.</li>
      </ul>
    </div>
  `;
  html += htmlFooter('rules');
  res.send(html);
});

// RESULTS – list of all settled matches
app.get('/results', requireAuth, async (req, res) => {
  const keys = await db.list('settlementLog:');
  const logs = [];
  for (const key of keys) {
    const log = await db.get(key);
    if (log) logs.push(log);
  }
  logs.sort((a, b) => (a.settledAt < b.settledAt ? 1 : -1)); // newest first

  const lastUpdated = logs.length ? logs[0].settledAt : null;
  const nextNoon = (() => {
    const n = moment().tz(TIMEZONE);
    const candidate = n.clone().startOf('day').hour(12);
    return n.isBefore(candidate) ? candidate : candidate.add(1, 'day');
  })();
  const nextUpdateStr = nextNoon.format('D MMM YYYY, h:mm A z');

  let html = htmlHeader('Match Results - No Betting Zone');
  html += `<h2>Match Results</h2>`;
  html += `<p style="font-size:11px;color:#6b7280;margin-top:-4px;margin-bottom:14px;">
    ${lastUpdated ? `Last updated: <strong style="color:#9ca3af;">${lastUpdated}</strong> &nbsp;·&nbsp; ` : ''}
    Next scheduled update: <strong style="color:#9ca3af;">${nextUpdateStr}</strong>
  </p>`;

  if (!logs.length) {
    html += `<p style="color:#9ca3af;">No settled matches yet. Check back after results are in.</p>`;
  } else {
    for (const log of logs) {
      const resultLabel = log.result === 'Home' ? `${log.homeTeam} wins`
        : log.result === 'Away' ? `${log.awayTeam} wins` : 'Draw';
      const winners = log.entries.filter(e => e.status === 'WON').length;
      const total = log.entries.length;
      html += `
        <a href="/results/${log.fixtureId}" style="display:block;text-decoration:none;color:inherit;">
          <div class="card" style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-size:14px;font-weight:700;color:#e5e7eb;">${log.homeTeam} vs ${log.awayTeam}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:2px;">${log.leagueName}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:1px;">${log.settledAt}</div>
              </div>
              <span style="font-size:11px;font-weight:bold;color:#22c55e;border:1px solid #22c55e;border-radius:4px;padding:2px 6px;white-space:nowrap;margin-left:8px;">SETTLED</span>
            </div>
            <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;font-weight:600;color:#e5e7eb;">Result: ${resultLabel}</span>
              <span style="font-size:12px;color:#9ca3af;">${winners}/${total} correct &nbsp;·&nbsp; ${log.totalStaked} pts pool</span>
            </div>
            <div style="font-size:11px;color:#6b7280;margin-top:4px;">Tap to see full breakdown →</div>
          </div>
        </a>`;
    }
  }

  html += htmlFooter('results');
  res.send(html);
});

// RESULTS – detail page for one settled match
app.get('/results/:fixtureId', requireAuth, async (req, res) => {
  const log = await db.get(`settlementLog:${req.params.fixtureId}`);
  if (!log) {
    return res.send(htmlHeader('Not Found') + `<p style="color:#9ca3af;">No settlement data found for this match.</p>` + htmlFooter('results'));
  }

  const resultLabel = log.result === 'Home' ? `${log.homeTeam} wins`
    : log.result === 'Away' ? `${log.awayTeam} wins` : 'Draw';

  const selLabel = (sel, home, away) =>
    sel === 'Home' ? `${home} wins` : sel === 'Away' ? `${away} wins` : 'Draw';

  // Sort: winners first, then by netPoints desc
  const sorted = [...log.entries].sort((a, b) => {
    if (a.status === b.status) return b.netPoints - a.netPoints;
    return a.status === 'WON' ? -1 : 1;
  });

  let html = htmlHeader(`${log.homeTeam} vs ${log.awayTeam} - Results`);
  html += `
    <a href="/results" style="font-size:12px;color:#6b7280;text-decoration:none;">← Back to Results</a>

    <div class="card" style="margin-top:10px;margin-bottom:16px;">
      <div style="font-size:15px;font-weight:700;color:#e5e7eb;">${log.homeTeam} vs ${log.awayTeam}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${log.leagueName} &nbsp;·&nbsp; ${log.settledAt}</div>
      <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;">
        <div style="text-align:center;">
          <div style="font-size:18px;font-weight:bold;color:#22c55e;">${resultLabel}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px;">RESULT</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:18px;font-weight:bold;color:#e5e7eb;">${log.totalStaked}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px;">TOTAL POOL (pts)</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:18px;font-weight:bold;color:#e5e7eb;">${log.entries.length}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px;">PREDICTIONS</div>
        </div>
      </div>
    </div>

    <h3 style="font-size:13px;color:#9ca3af;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">All Predictions</h3>
  `;

  for (const e of sorted) {
    const won = e.status === 'WON';
    const netColor = e.netPoints >= 0 ? '#22c55e' : '#ef4444';
    const netSign = e.netPoints >= 0 ? '+' : '';
    html += `
      <div class="card" style="margin-bottom:8px;border-left:3px solid ${won ? '#22c55e' : '#ef4444'};">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:13px;font-weight:700;color:#e5e7eb;">${e.user}</span>
          <span style="font-size:12px;font-weight:bold;color:${netColor};">${netSign}${Number(e.netPoints).toFixed(1)} pts</span>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px;">
          Picked: <strong style="color:#e5e7eb;">${selLabel(e.selection, log.homeTeam, log.awayTeam)}</strong>
          &nbsp;·&nbsp; Stake: ${e.stake} pts &nbsp;·&nbsp; Odds: ${e.lockedOdds}
        </div>
        <div style="font-size:11px;margin-top:4px;">
          <span style="color:${won ? '#22c55e' : '#ef4444'};font-weight:600;">${won ? '✓ WON' : '✗ LOST'}</span>
          ${won ? `<span style="color:#6b7280;margin-left:8px;">Payout: ${Number(e.finalPayout).toFixed(1)} pts</span>` : ''}
        </div>
      </div>`;
  }

  html += htmlFooter('results');
  res.send(html);
});

// SETTLE – redirect to admin
app.get('/settle', (req, res) => res.redirect('/admin'));

// ADMIN – unified admin panel
app.get('/admin', async (req, res) => {
  // Consume one-time unlock flag — every fresh page visit requires the password
  req.session.isAdmin = req.session.isAdminUnlocked || false;
  delete req.session.isAdminUnlocked;

  const lastRun = (await db.get('dailyJob:lastRun')) || 'Never';
  const allBets = await getBets();
  const settlementLogKeys = await db.list('settlementLog:');
  const logCount = settlementLogKeys.length;
  const pending = allBets.filter(b => b.status === 'PENDING').length;
  const won = allBets.filter(b => b.status === 'WON').length;
  const lost = allBets.filter(b => b.status === 'LOST').length;

  let html = htmlHeader('Admin - No Betting Zone');
  html += `<h2>Admin</h2>`;

  // Status cards — always visible
  html += `
    <div class="card">
      <div style="font-size:13px;">Last job ran: <strong>${lastRun}</strong></div>
      <div style="font-size:13px;margin-top:4px;">Snapshot: <strong>${snapshotMeta ? snapshotMeta.fetchedAt : 'Not yet fetched'}</strong></div>
      ${snapshotMeta ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Credits left: ${snapshotMeta.creditsLeft}</div>` : ''}
    </div>
    <div class="card">
      <div style="font-size:13px;">Pending bets: <strong>${pending}</strong></div>
      <div style="font-size:13px;margin-top:4px;">Won: <strong style="color:#22c55e;">${won}</strong> / Lost: <strong style="color:#ef4444;">${lost}</strong></div>
    </div>
    <hr style="border-color:#1f2937;margin:16px 0;">
  `;

  if (!req.session.isAdmin) {
    const err = req.query.err || '';
    html += `
      ${err ? `<p style="font-size:13px;color:#ef4444;">${err}</p>` : ''}
      <p style="font-size:13px;color:#9ca3af;margin-bottom:12px;">Enter admin password to unlock tools.</p>
      <form method="POST" action="/admin/login">
        <input type="password" name="password" placeholder="Admin password" required autocomplete="current-password"
          style="width:100%;max-width:280px;margin-bottom:8px;">
        <br><button type="submit" style="background:#7c3aed;border-color:#7c3aed;">Unlock Admin</button>
      </form>
    `;
  } else {
    const pwMsg = req.query.pwMsg || '';

    // Fetch pending OTPs
    const now = Date.now();
    const otpKeys = await db.list('otp:');
    const otpRows = [];
    for (const key of otpKeys) {
      const entry = await db.get(key);
      if (!entry) continue;
      const minsLeft = Math.round((entry.expiresAt - now) / 60000);
      if (minsLeft <= 0) continue;
      otpRows.push({ email: entry.email, userId: entry.userId, otp: entry.otp, minsLeft });
    }

    html += `
      <h3 style="font-size:14px;color:#9ca3af;margin-top:0;">Run daily job</h3>
      <form method="POST" action="/admin/run-job">
        <button type="submit" style="background:#7c3aed;border-color:#7c3aed;">Run daily job now</button>
      </form>
      <p style="font-size:11px;color:#6b7280;margin-top:8px;">Settles pending bets and fetches a fresh fixture snapshot immediately.</p>

      <hr style="border-color:#1f2937;margin:16px 0;">
      <h3 style="font-size:14px;color:#9ca3af;">Manual Settlement</h3>
      ${(() => {
        const manualMsg = req.query.manualMsg || '';
        const feedback = manualMsg === 'ok'
          ? `<p style="font-size:13px;color:#22c55e;margin-bottom:8px;">✓ Fixture settled successfully.</p>`
          : manualMsg ? `<p style="font-size:13px;color:#ef4444;margin-bottom:8px;">${manualMsg}</p>` : '';

        // Gather distinct pending fixtures from allBets
        const pendingFixtures = [];
        const seen = new Set();
        for (const b of allBets.filter(b => b.status === 'PENDING')) {
          if (!seen.has(b.fixtureId)) {
            seen.add(b.fixtureId);
            const matchName = b.homeTeam && b.awayTeam ? `${b.homeTeam} vs ${b.awayTeam}` : b.fixtureId;
            const dateStr = b.commenceTime
              ? moment(b.commenceTime).tz(TIMEZONE).format('DD MMM, HH:mm')
              : '?';
            pendingFixtures.push({ id: b.fixtureId, label: `${matchName} — ${dateStr} IST` });
          }
        }

        if (!pendingFixtures.length) {
          return `${feedback}<p style="font-size:13px;color:#9ca3af;">No pending fixtures to settle.</p>`;
        }

        return `${feedback}
          <p style="font-size:12px;color:#9ca3af;margin-bottom:10px;">Override API Football and settle a fixture manually.</p>
          <form method="POST" action="/admin/manual-settle">
            <select name="fixtureId" required style="width:100%;max-width:340px;margin-bottom:8px;padding:8px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;font-size:13px;">
              ${pendingFixtures.map(f => `<option value="${f.id}">${f.label}</option>`).join('')}
            </select>
            <br>
            <div style="display:flex;gap:8px;margin-top:6px;max-width:340px;">
              <label style="flex:1;text-align:center;">
                <input type="radio" name="result" value="Home" required style="margin-right:4px;">Home win
              </label>
              <label style="flex:1;text-align:center;">
                <input type="radio" name="result" value="Draw" style="margin-right:4px;">Draw
              </label>
              <label style="flex:1;text-align:center;">
                <input type="radio" name="result" value="Away" style="margin-right:4px;">Away win
              </label>
            </div>
            <button type="submit" style="margin-top:10px;background:#b45309;border-color:#b45309;">Settle fixture</button>
          </form>`;
      })()}

      <hr style="border-color:#1f2937;margin:16px 0;">
      <h3 style="font-size:14px;color:#9ca3af;">Pending OTPs</h3>
      ${otpRows.length === 0
        ? `<p style="color:#9ca3af;font-size:13px;">No pending OTPs right now.</p>`
        : `<p style="font-size:12px;color:#9ca3af;margin-bottom:8px;">Share these codes with users who are trying to register.</p>
           ${otpRows.map(r => `
             <div class="card">
               <div style="font-size:13px;color:#9ca3af;">${r.email} &nbsp;·&nbsp; <strong style="color:#e5e7eb;">@${r.userId}</strong></div>
               <div style="font-size:28px;font-weight:700;letter-spacing:8px;margin:8px 0;color:#22c55e;">${r.otp}</div>
               <div style="font-size:12px;color:#f59e0b;">Expires in ${r.minsLeft} min</div>
             </div>`).join('')}`
      }
      <p style="font-size:12px;"><a href="/admin">↻ Refresh</a></p>

      <hr style="border-color:#1f2937;margin:16px 0;">
      <h3 style="font-size:14px;color:#9ca3af;">Change admin password</h3>
      ${pwMsg ? `<p style="font-size:13px;color:${pwMsg === 'ok' ? '#22c55e' : '#ef4444'};">${pwMsg === 'ok' ? 'Password changed.' : pwMsg}</p>` : ''}
      <form method="POST" action="/admin/change-password">
        <input type="password" name="oldPassword" placeholder="Current password" required autocomplete="current-password"
          style="width:100%;max-width:280px;margin-bottom:8px;">
        <br>
        <input type="password" name="newPassword" placeholder="New password (min 6 chars)" required autocomplete="new-password"
          style="width:100%;max-width:280px;margin-bottom:8px;">
        <br>
        <button type="submit" style="background:#374151;border-color:#374151;">Change password</button>
      </form>

      <hr style="border-color:#1f2937;margin:16px 0;">
      <h3 style="font-size:14px;color:#9ca3af;">Settlement Report</h3>
      ${(() => {
        const logMsg = req.query.logMsg || '';
        const feedback = logMsg === 'ok'
          ? `<p style="font-size:13px;color:#22c55e;margin-bottom:8px;">✓ Compiled report sent to gletterdash@gmail.com</p>`
          : logMsg
            ? `<p style="font-size:13px;color:#ef4444;margin-bottom:8px;">${logMsg}</p>`
            : '';
        if (logCount === 0) {
          return `${feedback}<p style="font-size:13px;color:#9ca3af;">No matches settled yet.</p>`;
        }
        return `${feedback}
          <p style="font-size:13px;color:#9ca3af;margin-bottom:10px;">${logCount} match${logCount !== 1 ? 'es' : ''} settled so far.</p>
          <form method="POST" action="/admin/send-settlement-logs">
            <button type="submit" style="background:#0369a1;border-color:#0369a1;">📧 Send compiled report →</button>
          </form>
          <p style="font-size:11px;color:#6b7280;margin-top:6px;">All match breakdowns + current leaderboard → gletterdash@gmail.com</p>`;
      })()}

      <p style="margin-top:24px;font-size:12px;color:#6b7280;">🔒 Admin panel locks automatically on next visit.</p>
    `;
  }

  html += htmlFooter('admin');
  res.send(html);
});

// ADMIN – login (set session)
app.post('/admin/login', async (req, res) => {
  const { password } = req.body || {};
  const adminPassword = await getAdminPassword();
  if (password !== adminPassword) return res.redirect('/admin?err=Wrong+password.');
  req.session.isAdminUnlocked = true;  // one-time flag, consumed on next GET /admin
  res.redirect('/admin');
});

// ADMIN – lock (clear session)
app.get('/admin/logout-admin', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin');
});

// ADMIN – manual daily job trigger (session-gated)
app.post('/admin/run-job', async (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');

  let settleResult, fetchResult;
  try { settleResult = await settlePendingBets(); } catch (e) { settleResult = { error: e.message }; }
  try { await fetchAndStoreFixtures(); fetchResult = 'OK'; } catch (e) { fetchResult = e.message; }
  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
  await db.set('dailyJob:lastRun', today);

  const settled = settleResult.settled ?? 0;
  const errors = settleResult.errors ?? [];

  let html = htmlHeader('Job Complete - No Betting Zone');
  html += `
    <h2>Daily job complete</h2>
    <div class="card">
      <div style="font-size:13px;">Settlement: <strong style="color:#22c55e;">${settled} bet(s) settled</strong></div>
      ${errors.length ? `<div style="font-size:12px;color:#ef4444;margin-top:4px;">${errors.join('<br>')}</div>` : ''}
    </div>
    <div class="card">
      <div style="font-size:13px;">Fixture fetch: <strong style="color:${fetchResult === 'OK' ? '#22c55e' : '#ef4444'};">${fetchResult}</strong></div>
      ${snapshotMeta ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">Snapshot updated: ${snapshotMeta.fetchedAt} • Credits left: ${snapshotMeta.creditsLeft}</div>` : ''}
    </div>
    <p><a href="/">View fixtures</a> • <a href="/admin">Back to admin</a></p>
  `;
  html += htmlFooter('admin');
  res.send(html);
});

// ADMIN – change admin password
app.post('/admin/change-password', async (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.redirect('/admin?pwMsg=All+fields+are+required.');
  if (newPassword.length < 6) return res.redirect('/admin?pwMsg=New+password+must+be+at+least+6+characters.');

  const adminPassword = await getAdminPassword();
  if (oldPassword !== adminPassword) return res.redirect('/admin?pwMsg=Current+password+is+incorrect.');

  await db.set('admin:password', newPassword);
  res.redirect('/admin?pwMsg=ok');
});

// ADMIN – manual settle a specific fixture
app.post('/admin/manual-settle', async (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const { fixtureId, result } = req.body || {};
  if (!fixtureId || !['Home','Draw','Away'].includes(result)) {
    return res.redirect('/admin?manualMsg=Invalid+fixture+or+result.');
  }

  const allBets = await getBets();
  const bets = allBets.filter(b => b.fixtureId === fixtureId && b.status === 'PENDING');
  if (!bets.length) return res.redirect('/admin?manualMsg=No+pending+bets+for+that+fixture.');

  // Pari-mutuel settlement — same logic as the automated engine
  const grossArr = bets.map(b => b.selection === result ? b.stake * parseFloat(b.lockedOdds) : 0);
  const sumGross = grossArr.reduce((a, v) => a + v, 0);
  const totalStaked = bets.reduce((a, b) => a + b.stake, 0);

  const logEntries = [];
  for (let i = 0; i < bets.length; i++) {
    const bet = bets[i];
    const won = bet.selection === result;
    bet.status = won ? 'WON' : 'LOST';
    bet.result = result;
    const finalPayout = sumGross > 0
      ? Math.round((grossArr[i] / sumGross) * totalStaked * 10) / 10
      : 0;
    bet.netPoints = Math.round((finalPayout - bet.stake) * 10) / 10;
    logEntries.push({ user: bet.user, selection: bet.selection, stake: bet.stake,
      lockedOdds: bet.lockedOdds, status: bet.status, finalPayout, netPoints: bet.netPoints });
    try {
      const user = await getUserById(bet.user.toLowerCase());
      if (user) {
        user.totalNetPoints = Math.round((user.totalNetPoints + bet.netPoints) * 10) / 10;
        await saveUser(user);
      }
    } catch (e) { /* ignore per-user errors */ }
  }

  // Write updated bets back to DB (allBets mutated in-place above)
  await updateBets(allBets);

  // Persist settlement log
  const fb = bets[0];
  await db.set(`settlementLog:${fixtureId}`, {
    fixtureId, homeTeam: fb.homeTeam || '?', awayTeam: fb.awayTeam || '?',
    leagueName: fb.leagueName || 'Unknown', result, totalStaked,
    settledAt: moment().tz(TIMEZONE).format('DD MMM YYYY, HH:mm z'),
    entries: logEntries,
  });

  console.log(`[ManualSettle] ${fb.homeTeam} vs ${fb.awayTeam} → ${result} | ${bets.length} bets settled`);
  res.redirect('/admin?manualMsg=ok');
});

// ADMIN – email all settlement logs
app.post('/admin/send-settlement-logs', async (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');

  const keys = await db.list('settlementLog:');
  if (!keys.length) return res.redirect('/admin?logMsg=No+settlement+logs+to+send.');

  const logs = [];
  for (const key of keys) {
    const log = await db.get(key);
    if (log) logs.push(log);
  }
  logs.sort((a, b) => a.settledAt < b.settledAt ? 1 : -1); // newest first

  const matchSections = logs.map(log => {
    const resultLabel = log.result === 'Home' ? `${log.homeTeam} wins`
      : log.result === 'Away' ? `${log.awayTeam} wins` : 'Draw';

    const totalGross = log.entries.filter(e => e.status === 'WON')
      .reduce((sum, e) => sum + e.stake * parseFloat(e.lockedOdds), 0);
    const formula = totalGross > 0
      ? `Payout = (stake × odds ÷ ${totalGross.toFixed(1)}) × ${log.totalStaked} pts pool`
      : `No correct picks — all stakes forfeited`;

    const entryRows = log.entries.map(e => {
      const won = e.status === 'WON';
      const color = won ? '#16a34a' : '#dc2626';
      const sign = e.netPoints >= 0 ? '+' : '';
      const grossPts = won ? (e.stake * parseFloat(e.lockedOdds)).toFixed(1) : '0.0';
      return `<tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:6px 10px;">${e.user}</td>
        <td style="padding:6px 10px;">${e.selection} @ ${e.lockedOdds}</td>
        <td style="padding:6px 10px;text-align:center;">${e.stake}</td>
        <td style="padding:6px 10px;text-align:center;">${grossPts}</td>
        <td style="padding:6px 10px;text-align:center;">${e.finalPayout.toFixed(1)}</td>
        <td style="padding:6px 10px;text-align:center;font-weight:bold;color:${color};">${sign}${e.netPoints.toFixed(1)}</td>
        <td style="padding:6px 10px;text-align:center;color:${color};">${e.status}</td>
      </tr>`;
    }).join('');

    return `
      <h3 style="font-family:sans-serif;margin:24px 0 2px;">${log.homeTeam} vs ${log.awayTeam}</h3>
      <p style="font-family:sans-serif;color:#6b7280;margin:0 0 3px;font-size:13px;">
        ${log.leagueName} &nbsp;·&nbsp; Result: <strong style="color:#111;">${resultLabel}</strong>
        &nbsp;·&nbsp; Pool: <strong>${log.totalStaked} pts</strong>
        &nbsp;·&nbsp; Settled: ${log.settledAt}
      </p>
      <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;margin:0 0 8px;font-style:italic;">${formula}</p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;max-width:640px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:6px 10px;text-align:left;">Player</th>
            <th style="padding:6px 10px;text-align:left;">Pick @ Odds</th>
            <th style="padding:6px 10px;text-align:center;">Stake</th>
            <th style="padding:6px 10px;text-align:center;">Gross pts</th>
            <th style="padding:6px 10px;text-align:center;">Payout</th>
            <th style="padding:6px 10px;text-align:center;">Net</th>
            <th style="padding:6px 10px;text-align:center;">Result</th>
          </tr>
        </thead>
        <tbody>${entryRows}</tbody>
      </table>`;
  }).join('<hr style="margin:20px 0;border-color:#e5e7eb;">');

  // Current leaderboard
  const userKeys = await db.list('user:');
  const users = [];
  for (const key of userKeys) { const u = await db.get(key); if (u) users.push(u); }
  users.sort((a, b) => b.totalNetPoints - a.totalNetPoints);
  const leaderRows = users.map((u, i) => {
    const name = u.displayName || u.userId || 'Unknown';
    const pts = (u.totalNetPoints || 0).toFixed(1);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
    return `<tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:6px 10px;">${medal}</td>
      <td style="padding:6px 10px;">${name}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:bold;">${pts}</td>
    </tr>`;
  }).join('');

  const sentAt = moment().tz(TIMEZONE).format('DD MMM YYYY, HH:mm z');
  try {
    await resend.emails.send({
      from: 'No Betting Zone <onboarding@resend.dev>',
      to: 'gletterdash@gmail.com',
      subject: `Compiled Report — ${logs.length} match${logs.length !== 1 ? 'es' : ''} settled`,
      html: `
        <h2 style="font-family:sans-serif;">⚽ No Betting Zone — Compiled Settlement Report</h2>
        <p style="font-family:sans-serif;color:#6b7280;">Generated: ${sentAt} &nbsp;·&nbsp; ${logs.length} match${logs.length !== 1 ? 'es' : ''} total</p>

        <hr style="border-color:#e5e7eb;">
        <h2 style="font-family:sans-serif;font-size:15px;margin-bottom:0;">Match Breakdowns</h2>
        ${matchSections}

        <hr style="border-color:#e5e7eb;margin-top:28px;">
        <h2 style="font-family:sans-serif;font-size:15px;">🏆 Current Leaderboard</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;max-width:400px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:6px 10px;text-align:left;">Rank</th>
              <th style="padding:6px 10px;text-align:left;">Player</th>
              <th style="padding:6px 10px;text-align:right;">Total pts</th>
            </tr>
          </thead>
          <tbody>${leaderRows}</tbody>
        </table>
      `
    });
    res.redirect('/admin?logMsg=ok');
  } catch (e) {
    console.error('[SettlementEmail]', e.message);
    res.redirect('/admin?logMsg=Email+failed:+' + encodeURIComponent(e.message));
  }
});

// LEADERBOARD
app.get('/leaderboard', requireAuth, async (req, res) => {
  const keys = await db.list('user:');
  const users = [];
  for (const key of keys) {
    const u = await db.get(key);
    if (u) users.push(u);
  }
  users.sort((a, b) => b.totalNetPoints - a.totalNetPoints);

  let html = htmlHeader('Leaderboard - No Betting Zone');
  html += `<h2>Leaderboard</h2>`;

  if (!users.length) {
    html += `<p style="color:#9ca3af;">No players yet.</p>`;
  } else {
    html += `
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="border-bottom:2px solid #1f2937;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">
            <th style="padding:8px 6px;text-align:left;width:40px;">#</th>
            <th style="padding:8px 6px;text-align:left;">Player</th>
            <th style="padding:8px 6px;text-align:right;">Points</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((u, idx) => {
            const name = u.displayName || u.userId || u.name || 'Unknown';
            const pts = (u.totalNetPoints || 0).toFixed(1);
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}`;
            const ptColor = u.totalNetPoints > 0 ? '#22c55e' : u.totalNetPoints < 0 ? '#ef4444' : '#e5e7eb';
            const rowBg = idx % 2 === 0 ? 'background:#0a0f1e;' : '';
            return `<tr style="border-bottom:1px solid #1f2937;${rowBg}">
              <td style="padding:10px 6px;font-size:16px;">${medal}</td>
              <td style="padding:10px 6px;font-weight:${idx < 3 ? '600' : '400'};">${name}</td>
              <td style="padding:10px 6px;text-align:right;font-weight:700;color:${ptColor};">${u.totalNetPoints >= 0 ? '+' : ''}${pts}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  html += htmlFooter('leaders');
  res.send(html);
});

// FORUM – chat with emojis (from keyboard) and @Name in text
app.get('/forum', requireAuth, async (req, res) => {
  const messages = await getMessages();
  const sessionUserId = req.session.userId;

  let html = htmlHeader('Forum - No Betting Zone');
  html += `<h2>Forum</h2>`;

  if (sessionUserId) {
    html += `
    <form method="POST" action="/forum">
      <p style="font-size:13px;color:#9ca3af;margin-bottom:4px;">Posting as <strong style="color:#e5e7eb;">${sessionUserId}</strong></p>
      <p>Message (use emojis from your keyboard, @Name to tag):</p>
      <textarea name="text" rows="2" required style="width:100%;"></textarea>
      <button type="submit" style="margin-top:8px;width:100%;">Post</button>
    </form>`;
  } else {
    html += `<p style="font-size:13px;color:#9ca3af;"><a href="/login">Log in</a> to post messages.</p>`;
  }

  html += `<h3 style="margin-top:16px;">Messages</h3>`;

  for (const m of messages.slice().reverse()) {
    const ts = m.createdAt
      ? moment(m.createdAt).tz(TIMEZONE).format('DD MMM, HH:mm')
      : '';
    html += `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:600;color:#e5e7eb;">${m.name}</span>
          <span style="font-size:11px;color:#4b5563;">${ts}</span>
        </div>
        <div style="font-size:14px;">${m.text}</div>
      </div>
    `;
  }

  html += htmlFooter('forum');
  res.send(html);
});

app.post('/forum', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.redirect('/forum');

  await addMessage({
    id: Date.now().toString(),
    name: req.session.userId,
    text: text.trim(),
    createdAt: new Date().toISOString()
  });

  res.redirect('/forum');
});

// START SERVER — load persisted snapshot into memory before accepting requests
loadFixturesFromDB().then(() => {
  app.listen(PORT, () => {
    console.log(`No Betting Zone server running on port ${PORT}`);
  });
});
