const express = require('express');
const axios = require('axios');
const moment = require('moment-timezone');
const Database = require('@replit/database');

const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: set API_FOOTBALL_KEY in Replit "Secrets"
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

// Timezone for display (India)
const TIMEZONE = 'Asia/Kolkata';

// Express body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory cache to reduce API calls
let upcomingCache = [];
let upcomingCacheTime = 0;

// Helper: call API-Football
async function apiGet(path, params) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await axios.get(url.toString(), {
    headers: {
      'x-apisports-key': API_KEY
    }
  });
  return res.data.response;
}

// Get upcoming fixtures across ALL tournaments
// Free plan supports date= but not next= or last=
async function getUpcomingFixtures() {
  const now = Date.now();
  if (upcomingCache.length && now - upcomingCacheTime < 5 * 60 * 1000) {
    return upcomingCache;
  }

  // Fetch today + next 2 days (free plan only supports date param)
  const dates = [0, 1, 2].map(offset => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
  });

  const allFixtures = [];
  for (const date of dates) {
    try {
      const fixtures = await apiGet('/fixtures', { date });
      allFixtures.push(...fixtures);
    } catch (e) {
      console.error('Fixtures fetch error for', date, e.message);
    }
  }

  // Only not-yet-started fixtures
  const upcoming = allFixtures.filter(f =>
    ['TBD', 'NS'].includes(f.fixture.status.short)
  );

  upcomingCache = upcoming;
  upcomingCacheTime = now;
  return upcoming;
}

// Find a fixture by its ID from upcoming (fallback to direct API call if needed)
async function getFixtureById(id) {
  const upcoming = await getUpcomingFixtures();
  let fixture = upcoming.find(f => String(f.fixture.id) === String(id));
  if (fixture) return fixture;

  // Fallback: fetch directly
  const fixtures = await apiGet('/fixtures', { id: String(id) });
  return fixtures[0] || null;
}

// Determine stage (best-effort) from round name
function getStage(fixture) {
  const round = (fixture.league && fixture.league.round) || '';
  if (round.toLowerCase().includes('group')) return 'GROUP';
  return 'KNOCKOUT';
}

// Default odds used when the API doesn't provide them (free plan restriction)
const DEFAULT_ODDS = [
  { value: 'Home', odd: '1.90' },
  { value: 'Draw', odd: '3.20' },
  { value: 'Away', odd: '2.10' },
];

// Get 1X2 odds for a fixture — falls back to defaults on free plan
async function getOddsForFixture(fixtureId) {
  try {
    const oddsResp = await apiGet('/odds', { fixture: String(fixtureId) });
    if (!oddsResp || !oddsResp.length) return DEFAULT_ODDS;

    const first = oddsResp[0];
    const bookmakers = first.bookmakers || [];
    if (!bookmakers.length) return DEFAULT_ODDS;

    const bets = bookmakers[0].bets || [];
    const matchResult = bets.find(
      b => (b.name && b.name.toLowerCase().includes('winner')) || b.id === 1
    ) || bets[0];

    if (!matchResult) return DEFAULT_ODDS;
    const values = matchResult.values || [];
    return values.length ? values : DEFAULT_ODDS;
  } catch (e) {
    console.error('Odds error', e.message);
    return DEFAULT_ODDS;
  }
}

/* ---------------- REPLIT DB HELPERS ---------------- */

// Get or create user by name (no login system for now)
async function getUser(name) {
  const key = `user:${name.toLowerCase()}`;
  let user = await db.get(key);
  if (!user) {
    user = { name, totalNetPoints: 0 };
    await db.set(key, user);
  }
  return user;
}

async function saveUser(user) {
  const key = `user:${user.name.toLowerCase()}`;
  await db.set(key, user);
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

// Determine match result string from API fixture data
function getMatchResult(fixture) {
  const home = fixture.teams.home;
  const away = fixture.teams.away;
  if (home.winner === true) return 'Home';
  if (away.winner === true) return 'Away';
  return 'Draw';
}

// Settle all pending bets for recently finished fixtures
// Returns a summary { settled, errors }
async function settlePendingBets() {
  const summary = { settled: 0, errors: [] };

  // Free plan only supports date= not last= or status= alone
  // Fetch today + yesterday and filter for FT status
  const datesToCheck = [0, -1, -2].map(offset => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
  });

  const finishedFixtures = [];
  for (const date of datesToCheck) {
    try {
      const fixtures = await apiGet('/fixtures', { date });
      finishedFixtures.push(...fixtures.filter(f => f.fixture.status.short === 'FT'));
    } catch (e) {
      summary.errors.push(`API error fetching fixtures for ${date}: ${e.message}`);
    }
  }

  if (!finishedFixtures.length) return summary;

  const allBets = await getBets();
  const pendingBets = allBets.filter(b => b.status === 'PENDING');
  if (!pendingBets.length) return summary;

  // Build a map of fixtureId → result for fast lookup
  const resultMap = {};
  for (const f of finishedFixtures) {
    resultMap[String(f.fixture.id)] = getMatchResult(f);
  }

  let changed = false;
  for (const bet of allBets) {
    if (bet.status !== 'PENDING') continue;
    const result = resultMap[String(bet.fixtureId)];
    if (!result) continue; // fixture not finished yet

    const won = bet.selection === result;
    bet.status = won ? 'WON' : 'LOST';
    // Net points: profit on win (odds-based), full stake lost on miss
    bet.netPoints = won
      ? Math.round(bet.stake * (parseFloat(bet.lockedOdds) - 1) * 10) / 10
      : -bet.stake;
    bet.result = result;
    changed = true;
    summary.settled++;

    // Update user total
    try {
      const user = await getUser(bet.user);
      user.totalNetPoints = Math.round((user.totalNetPoints + bet.netPoints) * 10) / 10;
      await saveUser(user);
    } catch (e) {
      summary.errors.push(`User update error for ${bet.user}: ${e.message}`);
    }
  }

  if (changed) await updateBets(allBets);
  return summary;
}

// Auto-settle every 15 minutes
setInterval(async () => {
  try {
    const s = await settlePendingBets();
    if (s.settled > 0) console.log(`Auto-settlement: settled ${s.settled} bets`);
  } catch (e) {
    console.error('Auto-settlement error:', e.message);
  }
}, 15 * 60 * 1000);

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
      <a href="/forum" class="${active === 'forum' ? 'active' : ''}">Forum</a>
      <a href="/settle" class="${active === 'settle' ? 'active' : ''}">Settle</a>
    </div>
  </body>
  </html>
  `;
}

/* ---------------- ROUTES ---------------- */

// HOME / DASHBOARD – upcoming matches grouped by tournament (league)
app.get('/', async (req, res) => {
  try {
    const fixtures = await getUpcomingFixtures();

    // Group by league name
    const byLeague = {};
    for (const f of fixtures) {
      const leagueName = f.league && f.league.name ? f.league.name : 'Unknown Tournament';
      if (!byLeague[leagueName]) byLeague[leagueName] = [];
      byLeague[leagueName].push(f);
    }

    let html = htmlHeader('No Betting Zone - Home');
    html += `
      <div class="title">No Betting Zone</div>
      <p style="font-size:14px;color:#9ca3af;">Points-based football prediction game. No real money.</p>

      <p>Enter your name to track your bets:</p>
      <form method="GET" action="/me" style="margin-bottom:16px;">
        <input name="name" placeholder="Your name" required style="width:60%;max-width:260px;">
        <button type="submit">Go</button>
      </form>

      <h3>Upcoming matches (all tournaments)</h3>
    `;

    const leagueNames = Object.keys(byLeague).sort();
    if (!leagueNames.length) {
      html += `<p>No upcoming fixtures found.</p>`;
    } else {
      for (const leagueName of leagueNames) {
        html += `<h4 style="margin-top:12px;font-size:14px;">${leagueName}</h4>`;
        const list = byLeague[leagueName].slice(0, 10); // cap per tournament
        for (const f of list) {
          const id = f.fixture.id;
          const home = f.teams.home.name;
          const away = f.teams.away.name;
          const date = moment(f.fixture.date).tz(TIMEZONE).format('DD MMM, HH:mm');
          const stage = getStage(f);
          const stake = stage === 'GROUP' ? 50 : 100;
          html += `
            <div class="card">
              <div style="display:flex;justify-content:space-between;">
                <div>${home} vs ${away}</div>
                <div style="font-size:12px;color:#9ca3af;">${date}</div>
              </div>
              <div style="font-size:12px;color:#9ca3af;margin-top:4px;">
                Stage guess: ${stage} • Stake: ${stake} pts
              </div>
              <a href="/match?id=${id}">View & bet</a>
            </div>
          `;
        }
      }
    }

    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading fixtures');
  }
});

// USER PAGE – see own bets
app.get('/me', async (req, res) => {
  const name = (req.query.name || '').toString().trim();
  if (!name) return res.redirect('/');

  const user = await getUser(name);
  const bets = (await getBets()).filter(b => b.user === user.name);

  let html = htmlHeader(`${user.name} - No Betting Zone`);
  html += `
    <h2>Hello, ${user.name}</h2>
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

// MATCH PAGE – single match view + 1X2 bet
app.get('/match', async (req, res) => {
  const fixtureId = req.query.id;
  if (!fixtureId) return res.redirect('/');

  try {
    const fixture = await getFixtureById(fixtureId);
    if (!fixture) return res.status(404).send('Match not found');

    const odds = await getOddsForFixture(fixtureId);
    const stage = getStage(fixture);
    const stake = stage === 'GROUP' ? 50 : 100;
    const home = fixture.teams.home.name;
    const away = fixture.teams.away.name;
    const date = moment(fixture.fixture.date).tz(TIMEZONE).format('DD MMM, HH:mm');
    const leagueName = fixture.league?.name || 'Unknown Tournament';

    let html = htmlHeader(`${home} vs ${away} - No Betting Zone`);
    html += `
      <h2>${home} vs ${away}</h2>
      <div style="font-size:12px;color:#9ca3af;">
        ${leagueName} • ${date} • Stage guess: ${stage} • Stake: ${stake} pts
      </div>
      <hr style="border-color:#1f2937;margin:12px 0;">
      <form method="POST" action="/bet">
        <input type="hidden" name="fixtureId" value="${fixtureId}">
        <input type="hidden" name="leagueName" value="${leagueName}">
        <p>Your name:</p>
        <input name="name" placeholder="Your name" required style="width:100%;margin-bottom:8px;">

        <p>Pick result (1X2):</p>
    `;

    // Map value labels to human-readable team names
    const labelMap = { Home: `${home} wins`, Draw: 'Draw', Away: `${away} wins` };
    odds.forEach(o => {
      const label = labelMap[o.value] || o.value;
      html += `
        <div style="margin-bottom:8px;">
          <label style="display:flex;align-items:center;gap:10px;background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px 12px;cursor:pointer;">
            <input type="radio" name="selection" value="${o.value}" required style="accent-color:#22c55e;width:18px;height:18px;">
            <span style="flex:1;font-size:14px;">${label}</span>
            <span style="font-size:13px;font-weight:bold;color:#22c55e;">${o.odd}</span>
          </label>
        </div>
      `;
    });

    html += `
        <button type="submit" style="margin-top:12px;width:100%;">Place Bet</button>
      </form>
      <p style="margin-top:12px;"><a href="/">Back to Home</a></p>
    `;
    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading match');
  }
});

// HANDLE BET – one bet per user per fixture
app.post('/bet', async (req, res) => {
  const { name, fixtureId, selection, leagueName } = req.body || {};
  if (!name || !fixtureId || !selection) {
    return res.status(400).send('Missing fields');
  }

  const user = await getUser(name.trim());
  const fixture = await getFixtureById(fixtureId);
  if (!fixture) return res.status(400).send('Match not found');

  const stage = getStage(fixture);
  const stake = stage === 'GROUP' ? 50 : 100;

  // Basic betting window: before kick-off (status NS/TBD)
  if (!['NS', 'TBD'].includes(fixture.fixture.status.short)) {
    return res.send('Betting closed for this match.');
  }

  // Ensure only one bet per user per fixture
  const bets = await getBets();
  const existing = bets.find(
    b => b.user === user.name && String(b.fixtureId) === String(fixtureId)
  );
  if (existing) {
    return res.send(`
      <html><body style="background:#020617;color:#e5e7eb;font-family:system-ui;padding:16px;">
        <h2>No Betting Zone</h2>
        <p>You already placed a bet on this match.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
    `);
  }

  // Get latest odds
  const odds = await getOddsForFixture(fixtureId);
  let lockedOdds = 2.0;
  if (odds && odds.length) {
    const match = odds.find(o => o.value === selection);
    if (match) lockedOdds = parseFloat(match.odd) || 2.0;
  }

  const bet = {
    id: Date.now().toString(),
    user: user.name,
    fixtureId,
    leagueName: leagueName || (fixture.league?.name || 'Unknown Tournament'),
    market: 'MATCH_RESULT',
    selection,
    stake,
    lockedOdds,
    status: 'PENDING',
    netPoints: null
  };

  await addBet(bet);

  // Note: settlement and NetPoints calculation not implemented yet in this prototype.
  // Everyone's totalNetPoints stays 0 for now.

  res.send(`
    <html><body style="background:#020617;color:#e5e7eb;font-family:system-ui;padding:16px;">
      <h2>No Betting Zone</h2>
      <p>${user.name}, you placed ${stake} pts on "${selection}" @ ${lockedOdds} for fixture ${fixtureId}.</p>
      <p><a href="/">Back to home</a> or <a href="/me?name=${encodeURIComponent(user.name)}">view your bets</a></p>
    </body></html>
  `);
});

// MY PREDICTIONS SUMMARY PAGE
app.get('/summary', async (req, res) => {
  const name = (req.query.name || '').toString().trim();
  if (!name) {
    let html = htmlHeader('My Predictions - No Betting Zone');
    html += `
      <h2>My Predictions</h2>
      <p>Enter your name to see your prediction history:</p>
      <form method="GET" action="/summary">
        <input name="name" placeholder="Your name" required style="width:70%;max-width:280px;">
        <button type="submit" style="margin-left:8px;">View</button>
      </form>
    `;
    html += htmlFooter('summary');
    res.send(html);
    return;
  }

  const user = await getUser(name);
  const bets = (await getBets()).filter(b => b.user === user.name);

  const total = bets.length;
  const won = bets.filter(b => b.status === 'WON').length;
  const lost = bets.filter(b => b.status === 'LOST').length;
  const pending = bets.filter(b => b.status === 'PENDING').length;
  const winRate = total - pending > 0 ? Math.round((won / (total - pending)) * 100) : 0;
  const totalNet = user.totalNetPoints;

  let html = htmlHeader(`${user.name} - My Predictions`);
  html += `
    <h2 style="margin-bottom:4px;">${user.name}</h2>
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
    // newest first
    const sorted = [...bets].reverse();
    for (const b of sorted) {
      const statusColor = b.status === 'WON' ? '#22c55e' : b.status === 'LOST' ? '#ef4444' : '#9ca3af';
      const netLabel = b.netPoints !== null
        ? `<span style="font-weight:bold;color:${b.netPoints >= 0 ? '#22c55e' : '#ef4444'};">${b.netPoints >= 0 ? '+' : ''}${b.netPoints.toFixed(1)} pts</span>`
        : `<span style="color:#9ca3af;">Pending</span>`;
      html += `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:13px;font-weight:bold;">${b.leagueName}</div>
            <span style="font-size:11px;font-weight:bold;color:${statusColor};border:1px solid ${statusColor};border-radius:4px;padding:2px 6px;">${b.status}</span>
          </div>
          <div style="font-size:12px;color:#9ca3af;margin-top:4px;">
            Pick: <strong style="color:#e5e7eb;">${b.selection}</strong> @ ${b.lockedOdds} • Stake: ${b.stake} pts
          </div>
          ${b.result ? `<div style="font-size:12px;color:#9ca3af;">Result: <strong style="color:#e5e7eb;">${b.result}</strong></div>` : ''}
          <div style="font-size:13px;margin-top:6px;">${netLabel}</div>
        </div>
      `;
    }
  }

  html += htmlFooter('summary');
  res.send(html);
});

// MANUAL SETTLE – trigger settlement and show summary
app.get('/settle', async (req, res) => {
  try {
    const summary = await settlePendingBets();
    let html = htmlHeader('Settlement - No Betting Zone');
    html += `
      <h2>Settlement</h2>
      <div class="card">
        <div>Bets settled: <strong>${summary.settled}</strong></div>
        ${summary.errors.length ? `<div style="color:#ef4444;font-size:12px;margin-top:4px;">${summary.errors.join('<br>')}</div>` : ''}
        ${summary.settled === 0 && !summary.errors.length ? `<div style="font-size:12px;color:#9ca3af;margin-top:4px;">No pending bets matched any finished fixtures.</div>` : ''}
      </div>
      <p><a href="/">Back to home</a> • <a href="/leaderboard">View leaderboard</a></p>
    `;
    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Settlement error');
  }
});

// LEADERBOARD
app.get('/leaderboard', async (req, res) => {
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
    html += `<p>No players yet.</p>`;
  } else {
    users.forEach((u, idx) => {
      html += `
        <div class="card">
          <div>#${idx + 1} - ${u.name}</div>
          <div style="font-size:12px;color:#9ca3af;">Points: ${u.totalNetPoints.toFixed(1)}</div>
        </div>
      `;
    });
  }

  html += htmlFooter('leaders');
  res.send(html);
});

// FORUM – chat with emojis (from keyboard) and @Name in text
app.get('/forum', async (req, res) => {
  const messages = await getMessages();

  let html = htmlHeader('Forum - No Betting Zone');
  html += `
    <h2>Forum</h2>
    <form method="POST" action="/forum">
      <p>Name:</p>
      <input name="name" required style="width:100%;margin-bottom:8px;">
      <p>Message (use emojis from your keyboard, @Name to tag):</p>
      <textarea name="text" rows="2" required style="width:100%;"></textarea>
      <button type="submit" style="margin-top:8px;width:100%;">Post</button>
    </form>
    <h3 style="margin-top:16px;">Messages</h3>
  `;

  for (const m of messages.slice().reverse()) {
    html += `
      <div class="card">
        <div style="font-size:12px;color:#9ca3af;">${m.name}</div>
        <div>${m.text}</div>
      </div>
    `;
  }

  html += htmlFooter('forum');
  res.send(html);
});

app.post('/forum', async (req, res) => {
  const { name, text } = req.body || {};
  if (!name || !text) return res.redirect('/forum');

  await addMessage({
    id: Date.now().toString(),
    name: name.trim(),
    text: text.trim(),
    createdAt: new Date().toISOString()
  });

  res.redirect('/forum');
});

// START SERVER
app.listen(PORT, () => {
  console.log(`No Betting Zone server running on port ${PORT}`);
});
