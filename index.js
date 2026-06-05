const express = require('express');
const axios = require('axios');
const moment = require('moment-timezone');
const Database = require('@replit/database');

const db = new Database();
const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

const TIMEZONE = 'Asia/Kolkata';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// All soccer sport keys on The Odds API free plan
const SOCCER_SPORT_KEYS = [
  'soccer_belgium_first_div',
  'soccer_brazil_campeonato',
  'soccer_brazil_serie_b',
  'soccer_chile_campeonato',
  'soccer_china_superleague',
  'soccer_conmebol_copa_libertadores',
  'soccer_conmebol_copa_sudamericana',
  'soccer_epl',
  'soccer_finland_veikkausliiga',
  'soccer_france_ligue_one',
  'soccer_germany_bundesliga2',
  'soccer_italy_serie_b',
  'soccer_japan_j_league',
  'soccer_league_of_ireland',
  'soccer_norway_eliteserien',
  'soccer_spain_segunda_division',
  'soccer_sweden_allsvenskan',
  'soccer_sweden_superettan',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_conference_league',
  'soccer_fifa_world_cup',
];

// Cache per sport — 6 hour TTL to stay within 500 req/month free quota
const eventsCache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000;

// Fetch upcoming fixtures + real odds from The Odds API for all covered leagues
async function getAllUpcomingFixtures() {
  const now = Date.now();
  const all = [];
  for (const sportKey of SOCCER_SPORT_KEYS) {
    const cached = eventsCache[sportKey];
    if (cached && now - cached.time < CACHE_TTL) {
      all.push(...cached.events);
      continue;
    }
    try {
      const resp = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
        params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }
      });
      const events = Array.isArray(resp.data) ? resp.data : [];
      eventsCache[sportKey] = { time: now, events };
      all.push(...events);
      const rem = resp.headers['x-requests-remaining'];
      if (events.length > 0) console.log(`[OddsAPI] ${sportKey}: ${events.length} events. Credits left: ${rem}`);
    } catch (e) {
      console.error(`[OddsAPI] error [${sportKey}]:`, e.message);
      if (cached) all.push(...cached.events);
    }
  }
  // Only future events
  const future = new Date();
  return all.filter(e => new Date(e.commence_time) > future);
}

// Find a single event by its Odds API UUID
async function getEventById(id) {
  for (const cached of Object.values(eventsCache)) {
    const found = cached.events.find(e => e.id === id);
    if (found) return found;
  }
  // Cache miss — refresh and retry once
  await getAllUpcomingFixtures();
  for (const cached of Object.values(eventsCache)) {
    const found = cached.events.find(e => e.id === id);
    if (found) return found;
  }
  return null;
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
  return outcomes.length === 3 ? outcomes : null;
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

async function settlePendingBets() {
  const summary = { settled: 0, errors: [] };

  const allBets = await getBets();
  const pendingBets = allBets.filter(b => b.status === 'PENDING');
  if (!pendingBets.length) return summary;

  // Only fetch scores for sport keys that have pending bets
  const sportKeys = [...new Set(pendingBets.map(b => b.sportKey).filter(Boolean))];
  if (!sportKeys.length) return summary;

  const resultMap = {}; // eventId → 'Home' | 'Away' | 'Draw'
  for (const sportKey of sportKeys) {
    try {
      const resp = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/scores`, {
        params: { apiKey: ODDS_API_KEY, daysFrom: 3, dateFormat: 'iso' }
      });
      const scores = Array.isArray(resp.data) ? resp.data : [];
      for (const s of scores.filter(s => s.completed)) {
        const result = getResultFromScore(s);
        if (result) resultMap[s.id] = result;
      }
    } catch (e) {
      summary.errors.push(`Scores error [${sportKey}]: ${e.message}`);
    }
  }

  let changed = false;
  for (const bet of allBets) {
    if (bet.status !== 'PENDING') continue;
    const result = resultMap[bet.fixtureId];
    if (!result) continue;

    const won = bet.selection === result;
    bet.status = won ? 'WON' : 'LOST';
    bet.netPoints = won
      ? Math.round(bet.stake * (parseFloat(bet.lockedOdds) - 1) * 10) / 10
      : -bet.stake;
    bet.result = result;
    changed = true;
    summary.settled++;

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

// Auto-settle every 60 minutes (conserves Odds API credits)
setInterval(async () => {
  try {
    const s = await settlePendingBets();
    if (s.settled > 0) console.log(`Auto-settlement: settled ${s.settled} bets`);
  } catch (e) {
    console.error('Auto-settlement error:', e.message);
  }
}, 60 * 60 * 1000);

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

// HOME / DASHBOARD – upcoming matches from The Odds API, grouped by league
app.get('/', async (req, res) => {
  try {
    const events = await getAllUpcomingFixtures();

    const byLeague = {};
    for (const ev of events) {
      const title = ev.sport_title || 'Unknown League';
      if (!byLeague[title]) byLeague[title] = [];
      byLeague[title].push(ev);
    }

    let html = htmlHeader('No Betting Zone - Home');
    html += `
      <div class="title">No Betting Zone</div>
      <p style="font-size:14px;color:#9ca3af;">Points-based football prediction game. No real money.</p>

      <p>Enter your name to track your predictions:</p>
      <form method="GET" action="/me" style="margin-bottom:16px;">
        <input name="name" placeholder="Your name" required style="width:60%;max-width:260px;">
        <button type="submit">Go</button>
      </form>

      <h3>Upcoming matches</h3>
    `;

    const leagueNames = Object.keys(byLeague).sort();
    if (!leagueNames.length) {
      html += `<p style="color:#9ca3af;">No upcoming fixtures available. Check back later.</p>`;
    } else {
      for (const leagueName of leagueNames) {
        html += `<h4 style="margin-top:12px;font-size:14px;">${leagueName}</h4>`;
        const list = byLeague[leagueName].slice(0, 10);
        for (const ev of list) {
          const date = moment(ev.commence_time).tz(TIMEZONE).format('DD MMM, HH:mm');
          html += `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div style="font-size:14px;">${ev.home_team} vs ${ev.away_team}</div>
                <div style="font-size:12px;color:#9ca3af;white-space:nowrap;margin-left:8px;">${date}</div>
              </div>
              <a href="/match?id=${ev.id}" style="font-size:13px;margin-top:6px;display:inline-block;">View & predict →</a>
            </div>
          `;
        }
      }
    }

    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading fixtures: ' + e.message);
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

// MATCH PAGE – single match view + 1X2 prediction
app.get('/match', async (req, res) => {
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
    const stake = 100;

    let html = htmlHeader(`${home} vs ${away} - No Betting Zone`);
    html += `
      <h2>${home} vs ${away}</h2>
      <div style="font-size:12px;color:#9ca3af;">
        ${leagueName} • ${date} • Stake: ${stake} pts
      </div>
      <hr style="border-color:#1f2937;margin:12px 0;">
      <form method="POST" action="/bet">
        <input type="hidden" name="eventId" value="${eventId}">
        <input type="hidden" name="leagueName" value="${leagueName}">
        <p>Your name:</p>
        <input name="name" placeholder="Your name" required style="width:100%;margin-bottom:8px;">

        <p>Pick result (1X2):</p>
    `;

    const labelMap = { Home: `${home} wins`, Draw: 'Draw', Away: `${away} wins` };
    oddsToShow.forEach(o => {
      html += `
        <div style="margin-bottom:8px;">
          <label style="display:flex;align-items:center;gap:10px;background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px 12px;cursor:pointer;">
            <input type="radio" name="selection" value="${o.value}" required style="accent-color:#22c55e;width:18px;height:18px;">
            <span style="flex:1;font-size:14px;">${labelMap[o.value] || o.value}</span>
            <span style="font-size:13px;font-weight:bold;color:#22c55e;">${o.odd}</span>
          </label>
        </div>
      `;
    });

    html += `
        <button type="submit" style="margin-top:12px;width:100%;">Place Bet</button>
      </form>
      <p style="margin-top:8px;font-size:11px;color:#6b7280;">${odds ? '📊 Live bookmaker odds' : '📊 Estimated odds'}</p>
      <p><a href="/">Back to Home</a></p>
    `;
    html += htmlFooter('home');
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading match: ' + e.message);
  }
});

// HANDLE BET – one prediction per user per event
app.post('/bet', async (req, res) => {
  const { name, eventId, selection, leagueName } = req.body || {};
  if (!name || !eventId || !selection) {
    return res.status(400).send('Missing fields');
  }

  const user = await getUser(name.trim());
  const event = await getEventById(eventId);
  if (!event) return res.status(400).send('Match not found');

  // Betting window: event must be in the future
  if (new Date(event.commence_time) <= new Date()) {
    return res.send('Betting closed — this match has already started.');
  }

  // One prediction per user per event
  const bets = await getBets();
  const existing = bets.find(b => b.user === user.name && b.fixtureId === eventId);
  if (existing) {
    return res.send(`
      <html><body style="background:#020617;color:#e5e7eb;font-family:system-ui;padding:16px;">
        <h2>No Betting Zone</h2>
        <p>You already placed a prediction on this match.</p>
        <p><a href="/">Back to home</a></p>
      </body></html>
    `);
  }

  // Lock in odds from the event's bookmaker data
  const odds = extractOdds(event);
  const stake = 100;
  let lockedOdds = 2.0;
  if (odds) {
    const match = odds.find(o => o.value === selection);
    if (match) lockedOdds = parseFloat(match.odd) || 2.0;
  }

  const bet = {
    id: Date.now().toString(),
    user: user.name,
    fixtureId: eventId,
    sportKey: event.sport_key,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    leagueName: leagueName || event.sport_title || 'Unknown League',
    market: 'MATCH_RESULT',
    selection,
    stake,
    lockedOdds,
    status: 'PENDING',
    netPoints: null,
    result: null,
  };

  await addBet(bet);

  res.send(`
    <html><body style="background:#020617;color:#e5e7eb;font-family:system-ui;padding:16px;">
      <h2>No Betting Zone ✓</h2>
      <p>${user.name}, you predicted <strong>${selection}</strong> @ ${lockedOdds} — ${stake} pts staked.</p>
      <p><a href="/" style="color:#22c55e;">Back to home</a> | <a href="/me?name=${encodeURIComponent(user.name)}" style="color:#22c55e;">View your bets</a></p>
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
