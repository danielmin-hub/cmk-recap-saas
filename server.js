// CMK Recap Studio — SaaS backend v1.4 (plans + daily limits + upload proxy)
// Auth + credit ledger + plan-gated Gemini proxy (video analysis + Burmese TTS + thumbnails).
// Plans: free/pro/premium/max. Recap & thumbnail are credit-only with daily
// per-plan caps (pro 5/day each, premium 10/day each, max unlimited).
// Video upload is proxied through /api/upload-video (browser never touches
// Google directly; the owner's GEMINI_API_KEY never leaves this server).
// The owner's GEMINI_API_KEY never leaves this server.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // built-in, no native build needed (Node 22.5+)

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_PATH = process.env.DB_PATH || './saas.db';

if (!GEMINI_API_KEY) { console.error('FATAL: GEMINI_API_KEY is not set'); process.exit(1); }
if (!ADMIN_KEY) console.warn('WARN: ADMIN_KEY is not set — admin endpoints will reject everything');

// Credit costs (tune freely)
const COST = { analyze: 2, tts: 1, text: 1, thumbnail: 3 };
// Abuse guards per user per day (safety net; plan limits govern recap/thumbnail)
const DAILY_CAP = { analyze: 100, tts: 100, text: 200 };
// Plan daily limits for credit-only tools (Yangon day). Missing key = unlimited.
const VALID_PLANS = ['free', 'pro', 'premium', 'max'];
const PLAN_LIMIT = {
  free:    { recap: 0, thumbnail: 0 },   // free: buy a plan to use recap/thumbnail
  pro:     { recap: 5, thumbnail: 5 },
  premium: { recap: 10, thumbnail: 10 },
  max:     {}
};
// TTS model fallback chain (server tries each in order)
const TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview'];

// ---------- DB ----------
const db = new DatabaseSync(DB_PATH);
// tiny transaction helper (node:sqlite has no .transaction())
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  passhash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_day (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, day)
);`);
// v1.3 migration: plan column (safe to re-run)
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`); }
catch (_) { /* column already exists */ }

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, passhash) VALUES (?, ?)'),
  insertToken: db.prepare('INSERT INTO tokens (token, user_id) VALUES (?, ?)'),
  deleteToken: db.prepare('DELETE FROM tokens WHERE token = ?'),
  userByToken: db.prepare(`SELECT u.* FROM users u JOIN tokens t ON t.user_id = u.id
    WHERE t.token = ? AND t.created_at > datetime('now', '-30 days')`),
  pruneTokens: db.prepare(`DELETE FROM tokens WHERE created_at <= datetime('now', '-30 days')`),
  addLedger: db.prepare('INSERT INTO ledger (user_id, delta, reason) VALUES (?, ?, ?)'),
  // atomic: deduct only if balance covers it
  deduct: db.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?'),
  addCredits: db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?'),
  usageGet: db.prepare('SELECT count FROM usage_day WHERE user_id = ? AND kind = ? AND day = ?'),
  usageUpsert: db.prepare(`INSERT INTO usage_day (user_id, kind, day, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, kind, day) DO UPDATE SET count = count + 1`),
  allUsers: db.prepare('SELECT id, email, credits, plan, created_at FROM users ORDER BY id DESC LIMIT 200'),
  setPlan: db.prepare(`UPDATE users SET plan = ? WHERE id = ?`),
};

function todayStr() {
  // "Day" follows Asia/Yangon (UTC+6:30) — fair daily resets for Myanmar users
  return new Date(Date.now() + 6.5 * 3600 * 1000).toISOString().slice(0, 10);
}
// Plan gate for credit-only tools ('recap' | 'thumbnail'). Returns { ok, remaining }.
function planGate(userId, plan, tool) {
  const lim = (PLAN_LIMIT[plan] || PLAN_LIMIT.free)[tool];
  if (lim === undefined) return { ok: true, remaining: -1 }; // unlimited (max)
  if (lim <= 0) return { ok: false, remaining: 0 };
  const row = q.usageGet.get(userId, tool, todayStr());
  const used = row ? row.count : 0;
  return { ok: used < lim, remaining: Math.max(0, lim - used) };
}
function planLimitMsg(plan, tool, remaining) {
  if (plan === 'free')
    return 'Free plan cannot use ' + tool + ' — upgrade to Pro to unlock';
  return 'Daily ' + tool + ' limit reached for ' + plan + ' plan (' + remaining + ' left today) — try tomorrow';
}
function checkDailyCap(userId, kind) {
  const row = q.usageGet.get(userId, kind, todayStr());
  return (row ? row.count : 0) < DAILY_CAP[kind];
}
function bumpUsage(userId, kind) { q.usageUpsert.run(userId, kind, todayStr()); }
// returns true if deducted
function deductCredits(userId, amount, reason) {
  return tx(() => {
    const r = q.deduct.run(amount, userId, amount);
    if (r.changes !== 1) return false;
    q.addLedger.run(userId, -amount, reason);
    return true;
  });
}

// ---------- Gemini helpers (server key) ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gFetch(url, options, maxRetries = 4) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      let data = {};
      try { data = await res.json(); } catch (_) {}
      const errMsg = (data && data.error && data.error.message) || '';
      const isQuotaDaily = /quotas?.*exceed|exceed.*quota|per day|daily/i.test(errMsg);
      const failed = !res.ok || (data && data.error);
      if (failed && isQuotaDaily) throw new Error('QUOTA_DAILY:' + (errMsg || res.status));
      const isOverload = res.status === 429 || res.status === 503 ||
        /high demand|overloaded|rate limit|quota|try again later/i.test(errMsg);
      if (isOverload && attempt < maxRetries) {
        await sleep([3000, 6000, 12000, 20000][attempt] || 20000);
        continue;
      }
      if (failed) throw new Error(errMsg || ('Gemini API failed (' + res.status + ')'));
      return data;
    } catch (e) {
      lastErr = e;
      if (/^QUOTA_DAILY:/.test(e.message || '')) throw e;
      if (!/high demand|overloaded|rate limit|quota|try again later/i.test(e.message || '')) throw e;
      if (attempt >= maxRetries) throw e;
    }
  }
  throw lastErr || new Error('Gemini request failed');
}

async function discoverModel() {
  try {
    const data = await gFetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_API_KEY, {}, 2);
    const flash = (data.models || []).find(m =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes('generateContent') &&
      /flash/i.test(m.name) && !/tts/i.test(m.name));
    if (flash) return flash.name.replace(/^models\//, '');
  } catch (_) {}
  return 'gemini-3.8-flash';
}

async function waitForActive(fileUri) {
  const fileId = fileUri.split('/').pop();
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const data = await gFetch('https://generativelanguage.googleapis.com/v1beta/files/' + fileId + '?key=' + GEMINI_API_KEY, {}, 2);
    if (data.state === 'ACTIVE') return true;
    if (data.state === 'FAILED') throw new Error('Google failed to process the video.');
  }
  throw new Error('Video processing timed out.');
}

function buildPrompt(duration) {
  const dur = Number(duration) || 0;
  const nScenes = dur > 600 ? '10-16' : dur > 300 ? '8-12' : '4-8';
  return 'Analyze this video and create a Burmese recap dubbing plan. Return ONLY valid JSON:\n' +
    '{"scenes":[{"start":0,"end":5.2,"narration":"\u1019\u103c\u1014\u103a\u1019\u102c recap narration"}],"full_script":"..."}\n' +
    'Use ' + nScenes + ' chronological scenes. Give numeric timestamps in seconds. Cover the important visual story.\n' +
    'SCRIPT QUALITY RULES (V2):\n' +
    '1. HOOK: the first scene narration must grab attention in 3 seconds - a question, a shock, or a tease.\n' +
    '2. Write in NATURAL SPOKEN Burmese, like a popular YouTuber telling the story out loud - short punchy sentences, conversational, dramatic.\n' +
    '3. End scenes on mini-cliffhangers or curiosity gaps so viewers keep watching.\n' +
    '4. Name characters and keep names consistent across scenes.\n' +
    '5. Keep each narration short enough to speak naturally in its time window. Do not translate dialogue word-for-word.\n' +
    '6. Narrate what the viewer needs to understand; skip filler.\n' +
    'Video duration is about ' + dur.toFixed(2) + ' seconds.';
}

async function ttsOne(text, voice, model) {
  const data = await gFetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      })
    }, 3);
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const ap = parts.find(p => p.inlineData && p.inlineData.data);
  if (!ap) throw new Error('TTS returned no audio (' + model + ')');
  return ap.inlineData.data; // base64 PCM16
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // correct client IP behind Render/hosting proxy
app.use(helmet()); // secure HTTP headers
app.disable('x-powered-by');
// CORS: set ALLOWED_ORIGINS="https://cmkrecapstudio.blogspot.com,https://your.domain" in production.
// Default (empty) = allow all — OK for MVP since every API call needs a login token.
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(ALLOWED.length ? { origin: ALLOWED } : {}));
if (!ALLOWED.length) console.warn('WARN: CORS open to all origins — set ALLOWED_ORIGINS in production');
// 20mb: /api/text can carry base64 audio (up to ~15MB) for the translator
app.use(express.json({ limit: '20mb' }));

// Simple in-memory IP rate limiter (brute-force + abuse guard)
function rateLimit({ windowMs, max }) {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.start > windowMs) buckets.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(ip, b); }
    b.count++;
    if (b.count > max) return res.status(429).json({ error: 'Too many requests — slow down a bit' });
    next();
  };
}
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 600 })); // general API guard
app.use('/api/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 })); // anti-spam accounts
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 })); // anti brute-force

// Drop login tokens older than 30 days
setInterval(() => { try { q.pruneTokens.run(); } catch (_) {} }, 3600000).unref();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Login required' });
  const user = q.userByToken.get(m[1]);
  if (!user) return res.status(401).json({ error: 'Session expired — login again' });
  req.user = user;
  next();
}
function adminAuth(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}
const emailOk = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/register', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!emailOk(email)) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (q.userByEmail.get(email)) return res.status(400).json({ error: 'Email already registered — login instead' });
  const passhash = bcrypt.hashSync(password, 10);
  const r = q.insertUser.run(email, passhash);
  const token = crypto.randomBytes(32).toString('hex');
  q.insertToken.run(token, r.lastInsertRowid);
  res.json({ token, email, credits: 0, plan: 'free' });
});

app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = q.userByEmail.get(email);
  if (!user || !bcrypt.compareSync(password, user.passhash))
    return res.status(401).json({ error: 'Wrong email or password' });
  const token = crypto.randomBytes(32).toString('hex');
  q.insertToken.run(token, user.id);
  res.json({ token, email: user.email, credits: user.credits, plan: user.plan || 'free' });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization || '';
  q.deleteToken.run(h.match(/^Bearer\s+(.+)$/i)[1]);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = q.userById.get(req.user.id);
  const plan = u.plan || 'free';
  const recap = planGate(u.id, plan, 'recap');
  const thumbnail = planGate(u.id, plan, 'thumbnail');
  res.json({
    email: u.email, credits: u.credits, plan,
    limits: { recap: recap.remaining, thumbnail: thumbnail.remaining }
  });
});

// Step 1: begin a resumable Google upload. Client PUTs the video bytes straight to Google.
// Upload video: browser streams bytes here; server pipes them straight to Google.
// (v1.4.1: streaming — no RAM buffering, so large videos don't OOM the server.
// Browser never touches Google directly; the owner's GEMINI_API_KEY never leaves here.)
app.post('/api/upload-video', auth, async (req, res) => {
  try {
    const size = Number(req.get('Content-Length') || 0);
    const mimeType = (req.get('Content-Type') || 'video/mp4').split(';')[0].trim() || 'video/mp4';
    if (!Number.isFinite(size) || size <= 0 || size > 750 * 1024 * 1024)
      return res.status(400).json({ error: 'Invalid video (max 750MB)' });
    if (!checkDailyCap(req.user.id, 'analyze')) return res.status(429).json({ error: 'Daily video limit reached — try tomorrow' });
    // 1. open resumable session (server key never leaves the server)
    const startRes = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + GEMINI_API_KEY, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: 'saas_recap_' + Date.now() } })
    });
    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!startRes.ok || !uploadUrl) {
      let m = 'Google upload init failed';
      try { const e = await startRes.json(); m = (e.error && e.error.message) || m; } catch (_) {}
      return res.status(502).json({ error: m });
    }
    // 2. pipe the incoming stream straight to Google (no buffering)
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mimeType,
        'Content-Length': String(size)
      },
      body: req,
      duplex: 'half'
    });
    if (!upRes.ok) {
      let m = 'Video upload to Google failed';
      try { const e = await upRes.json(); m = (e.error && e.error.message) || m; } catch (_) {}
      return res.status(502).json({ error: m });
    }
    const upData = await upRes.json().catch(() => ({}));
    const fileUri = upData.file && upData.file.uri;
    if (!fileUri) return res.status(502).json({ error: 'Google did not return a video file URI' });
    res.json({ fileUri });
  } catch (e) { res.status(502).json({ error: e.message || 'Upload failed' }); }
});

// Step 2: analyze (deducts credits AFTER Google succeeds)
app.post('/api/analyze', auth, async (req, res) => {
  try {
    const { fileUri, mimeType, duration } = req.body || {};
    if (typeof fileUri !== 'string' || !fileUri.includes('/files/'))
      return res.status(400).json({ error: 'Invalid fileUri — upload the video first' });
    if (!checkDailyCap(req.user.id, 'analyze')) return res.status(429).json({ error: 'Daily video limit reached — try tomorrow' });
    // Plan gate: recap is credit-only with a daily per-plan cap
    const me0 = q.userById.get(req.user.id);
    const gate = planGate(req.user.id, me0.plan || 'free', 'recap');
    if (!gate.ok) return res.status(429).json({ error: planLimitMsg(me0.plan || 'free', 'recap', gate.remaining) });
    // Pre-check balance so we never burn owner API budget on users who can't pay.
    if (me0.credits < COST.analyze)
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.analyze + ')' });
    await waitForActive(fileUri);
    const model = await discoverModel();
    const data = await gFetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ file_data: { mime_type: mimeType || 'video/mp4', file_uri: fileUri } }, { text: buildPrompt(duration || 60) }] }],
          generationConfig: { temperature: 0.25, responseMimeType: 'application/json' }
        })
      }, 3);
    let raw = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    raw = (raw[0] && raw[0].text) || '{}';
    raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (_) { return res.status(502).json({ error: 'AI returned invalid data — try again' }); }
    if (!deductCredits(req.user.id, COST.analyze, 'video analysis')) {
      // Google succeeded but user can't pay — don't leak free work; still return data? No: be strict.
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.analyze + ')' });
    }
    bumpUsage(req.user.id, 'analyze');
    bumpUsage(req.user.id, 'recap'); // plan daily counter
    const u = q.userById.get(req.user.id);
    res.json({ scenes: parsed.scenes || [], full_script: parsed.full_script || '', credits: u.credits });
  } catch (e) {
    if (/^QUOTA_DAILY:/.test(e.message || ''))
      return res.status(429).json({ error: 'Owner API daily quota exhausted — try tomorrow' });
    res.status(502).json({ error: e.message || 'Analysis failed' });
  }
});

// Step 3: TTS (deducts 1 credit AFTER Google succeeds)
const VALID_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede'];
app.post('/api/tts', auth, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    const voice = VALID_VOICES.includes(req.body.voice) ? req.body.voice : 'Kore';
    if (!text) return res.status(400).json({ error: 'Empty text' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text too long (max 2000 chars)' });
    if (!checkDailyCap(req.user.id, 'tts')) return res.status(429).json({ error: 'Daily voice limit reached — try tomorrow' });
    if (q.userById.get(req.user.id).credits < COST.tts)
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.tts + ')' });
    let lastErr = null, quotaHits = 0;
    for (const model of TTS_MODELS) {
      try {
        const audioBase64 = await ttsOne(text, voice, model);
        if (!deductCredits(req.user.id, COST.tts, 'tts:' + model)) {
          return res.status(402).json({ error: 'Not enough credits (need ' + COST.tts + ')' });
        }
        bumpUsage(req.user.id, 'tts');
        const u = q.userById.get(req.user.id);
        return res.json({ audioBase64, credits: u.credits, model });
      } catch (e) {
        lastErr = e;
        if (/^QUOTA_DAILY:/.test(e.message || '')) quotaHits++;
      }
    }
    if (quotaHits === TTS_MODELS.length)
      return res.status(429).json({ error: 'Owner API daily TTS quota exhausted — try tomorrow' });
    throw lastErr || new Error('TTS failed');
  } catch (e) { res.status(502).json({ error: e.message || 'TTS failed' }); }
});

// Generic text generation (translator, recapper, script tools) — 1 credit per call
app.post('/api/text', auth, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const temperature = Math.min(1, Math.max(0, Number(req.body.temperature ?? 0.4)));
    const jsonMode = req.body.jsonMode === true;
    // Optional audio input (e.g. shorts translator sends extracted audio)
    const audioBase64 = typeof req.body.audioBase64 === 'string' ? req.body.audioBase64 : '';
    const audioMime = typeof req.body.audioMime === 'string' ? req.body.audioMime : 'audio/wav';
    if (!prompt) return res.status(400).json({ error: 'Empty prompt' });
    if (prompt.length > 12000) return res.status(400).json({ error: 'Prompt too long (max 12000 chars)' });
    if (audioBase64 && audioBase64.length > 15 * 1024 * 1024)
      return res.status(400).json({ error: 'Audio too large (max ~11MB)' });
    if (!checkDailyCap(req.user.id, 'text')) return res.status(429).json({ error: 'Daily text limit reached — try tomorrow' });
    if (q.userById.get(req.user.id).credits < COST.text)
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.text + ')' });
    const model = await discoverModel();
    const genConfig = { temperature };
    if (jsonMode) genConfig.responseMimeType = 'application/json';
    const parts = [{ text: prompt }];
    if (audioBase64) parts.unshift({ inlineData: { mimeType: audioMime, data: audioBase64 } });
    const data = await gFetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: genConfig })
      }, 3);
    const outParts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const text = (outParts[0] && outParts[0].text) || '';
    if (!text) return res.status(502).json({ error: 'AI returned empty response' });
    if (!deductCredits(req.user.id, COST.text, 'text')) {
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.text + ')' });
    }
    bumpUsage(req.user.id, 'text');
    const u = q.userById.get(req.user.id);
    res.json({ text, credits: u.credits, model });
  } catch (e) {
    if (/^QUOTA_DAILY:/.test(e.message || ''))
      return res.status(429).json({ error: 'Owner API daily quota exhausted — try tomorrow' });
    res.status(502).json({ error: e.message || 'Text generation failed' });
  }
});

// Generic VIDEO analysis with a custom prompt (recapper/script tools) — 2 credits
app.post('/api/video-text', auth, async (req, res) => {
  try {
    const { fileUri, mimeType, prompt } = req.body || {};
    const temperature = Math.min(1, Math.max(0, Number(req.body.temperature ?? 0.3)));
    if (typeof fileUri !== 'string' || !fileUri.includes('/files/'))
      return res.status(400).json({ error: 'Invalid fileUri — upload the video first' });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000)
      return res.status(400).json({ error: 'Valid prompt (max 12000 chars) required' });
    if (!checkDailyCap(req.user.id, 'analyze')) return res.status(429).json({ error: 'Daily video limit reached — try tomorrow' });
    if (q.userById.get(req.user.id).credits < COST.analyze)
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.analyze + ')' });
    await waitForActive(fileUri);
    const model = await discoverModel();
    const data = await gFetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { file_data: { mime_type: mimeType || 'video/mp4', file_uri: fileUri } }
          ] }],
          generationConfig: { temperature }
        })
      }, 3);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const text = (parts[0] && parts[0].text) || '';
    if (!text) return res.status(502).json({ error: 'AI returned empty response' });
    if (!deductCredits(req.user.id, COST.analyze, 'video-text')) {
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.analyze + ')' });
    }
    bumpUsage(req.user.id, 'analyze');
    const u = q.userById.get(req.user.id);
    res.json({ text, credits: u.credits, model });
  } catch (e) {
    if (/^QUOTA_DAILY:/.test(e.message || ''))
      return res.status(429).json({ error: 'Owner API daily quota exhausted — try tomorrow' });
    res.status(502).json({ error: e.message || 'Video analysis failed' });
  }
});

// Thumbnail generation (credit-only, plan daily cap) — 3 credits
app.post('/api/thumbnail', auth, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    const style = String(req.body.style || '').trim().slice(0, 40);
    if (!prompt) return res.status(400).json({ error: 'Describe the thumbnail you want' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'Prompt too long (max 2000 chars)' });
    const me = q.userById.get(req.user.id);
    const gate = planGate(req.user.id, me.plan || 'free', 'thumbnail');
    if (!gate.ok) return res.status(429).json({ error: planLimitMsg(me.plan || 'free', 'thumbnail', gate.remaining) });
    if (me.credits < COST.thumbnail)
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.thumbnail + ')' });
    const fullPrompt = 'YouTube thumbnail image, 16:9, bold cinematic style' +
      (style ? ', ' + style : '') + '. Subject: ' + prompt +
      '. No watermark. High contrast, readable at small size.';
    const data = await gFetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=' + encodeURIComponent(GEMINI_API_KEY),
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
        })
      }, 3);
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find(p => p.inlineData && p.inlineData.data);
    if (!img) return res.status(502).json({ error: 'AI returned no image — try a different prompt' });
    if (!deductCredits(req.user.id, COST.thumbnail, 'thumbnail')) {
      return res.status(402).json({ error: 'Not enough credits (need ' + COST.thumbnail + ')' });
    }
    bumpUsage(req.user.id, 'thumbnail');
    const u = q.userById.get(req.user.id);
    res.json({ imageBase64: img.inlineData.data, mimeType: img.inlineData.mimeType || 'image/png', credits: u.credits });
  } catch (e) {
    if (/^QUOTA_DAILY:/.test(e.message || ''))
      return res.status(429).json({ error: 'Owner API daily quota exhausted — try tomorrow' });
    res.status(502).json({ error: e.message || 'Thumbnail generation failed' });
  }
});

// Admin: top up credits (manual WavePay/KBZPay flow)
app.post('/api/admin/topup', adminAuth, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const credits = Math.floor(Number(req.body.credits));
  if (!emailOk(email) || !Number.isFinite(credits) || credits <= 0 || credits > 100000)
    return res.status(400).json({ error: 'Valid email + credits (1-100000) required' });
  const user = q.userByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  tx(() => {
    q.addCredits.run(credits, user.id);
    q.addLedger.run(user.id, credits, 'manual topup');
  });
  const u = q.userById.get(user.id);
  res.json({ email: u.email, credits: u.credits });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  res.json({ users: q.allUsers.all() });
});

// Admin: set user plan after manual WavePay/KBZPay payment
// Plans: free / pro (350cr/35000Ks) / premium (720cr/70000Ks) / max (1440cr/140000Ks)
app.post('/api/admin/set-plan', adminAuth, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const plan = String(req.body.plan || '').trim().toLowerCase();
  if (!emailOk(email) || !VALID_PLANS.includes(plan))
    return res.status(400).json({ error: 'Valid email + plan (free/pro/premium/max) required' });
  const user = q.userByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  q.setPlan.run(plan, user.id);
  const u = q.userById.get(user.id);
  res.json({ email: u.email, plan: u.plan, credits: u.credits });
});

app.listen(PORT, () => console.log('CMK Recap SaaS backend on :' + PORT));
