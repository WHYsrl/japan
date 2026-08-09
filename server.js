/* Giappone 2026 — server minimale: statico + stato condiviso + proxy voli */
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '8mb' }));

/* ── Basic auth opzionale (imposta APP_PASSWORD su Render) ── */
if (process.env.APP_PASSWORD) {
  const want = 'Basic ' + Buffer.from('japan:' + process.env.APP_PASSWORD).toString('base64');
  app.use((req, res, next) => {
    if ((req.headers.authorization || '') === want) return next();
    res.set('WWW-Authenticate', 'Basic realm="japan2026"');
    res.status(401).send('Auth richiesta');
  });
}

/* ── Storage: Postgres se presente, altrimenti memoria (volatile) ── */
let pool = null, mem = {};
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)').catch(console.error);
}

app.get('/api/ok', (req, res) => res.json({ ok: true, shared: !!pool }));

app.get('/api/state/:k', async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query('SELECT v FROM kv WHERE k=$1', [req.params.k]);
      return res.json({ value: r.rows[0] ? r.rows[0].v : null });
    }
    res.json({ value: mem[req.params.k] ?? null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put('/api/state/:k', async (req, res) => {
  const v = req.body && req.body.value;
  try {
    if (pool) {
      await pool.query('INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [req.params.k, v]);
    } else { mem[req.params.k] = v; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ── Proxy stato voli: la chiave resta sul server (env AIRLABS_KEY) ── */
app.get('/api/flight/:iata', async (req, res) => {
  const key = process.env.AIRLABS_KEY;
  if (!key) return res.status(404).json({ error: 'AIRLABS_KEY non impostata' });
  try {
    const r = await fetch('https://airlabs.co/api/v9/flight?flight_iata=' +
      encodeURIComponent(req.params.iata) + '&api_key=' + key);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ── Idee di famiglia (lista condivisa nel kv) ── */
async function kvGet(k) {
  if (pool) { const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; }
  return mem[k] ?? null;
}
async function kvSet(k, v) {
  if (pool) { await pool.query('INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, v]); }
  else { mem[k] = v; }
}
async function kvDel(k) {
  if (pool) { await pool.query('DELETE FROM kv WHERE k=$1', [k]); }
  else { delete mem[k]; }
}

app.get('/api/ideas', async (req, res) => {
  try { res.json(JSON.parse(await kvGet('ideas') || '[]')); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/ideas', async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 2000);
    let img = String(b.img || '');
    if (img && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 5000000)) img = '';
    if (!text && !img) return res.status(400).json({ error: 'testo vuoto' });
    const idea = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      who: String(b.who || '?').slice(0, 30),
      text,
      link: String(b.link || '').trim().slice(0, 500),
      details: String(b.details || '').trim().slice(0, 1000),
      ts: new Date().toISOString(), ai: null, done: false, img: !!img
    };
    if (img) await kvSet('ideaimg:' + idea.id, img);
    const list = JSON.parse(await kvGet('ideas') || '[]');
    list.unshift(idea);
    await kvSet('ideas', JSON.stringify(list.slice(0, 200)));
    res.json(idea);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/ideas/:id/img', async (req, res) => {
  try {
    const d = await kvGet('ideaimg:' + req.params.id);
    const m = d && d.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(m[2], 'base64'));
  } catch (e) { res.status(500).end(); }
});

app.put('/api/ideas/:id', async (req, res) => {
  try {
    const list = JSON.parse(await kvGet('ideas') || '[]');
    const it = list.find(x => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: 'idea non trovata' });
    if (req.body && 'ai' in req.body) it.ai = String(req.body.ai || '').slice(0, 4000);
    if (req.body && 'done' in req.body) it.done = !!req.body.done;
    await kvSet('ideas', JSON.stringify(list));
    res.json(it);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/ideas/:id', async (req, res) => {
  try {
    let list = JSON.parse(await kvGet('ideas') || '[]');
    list = list.filter(x => x.id !== req.params.id);
    await kvSet('ideas', JSON.stringify(list));
    await kvDel('ideaimg:' + req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ── Suggerimenti AI (Claude): la chiave resta sul server (env ANTHROPIC_API_KEY) ── */
app.post('/api/ai', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(404).json({ error: 'ANTHROPIC_API_KEY non impostata' });
  try {
    const b = req.body || {};
    const text = String(b.text || '').slice(0, 2000);
    const who = String(b.who || 'famiglia').slice(0, 30);
    const details = String(b.details || '').slice(0, 1000);
    const link = String(b.link || '').slice(0, 500);
    const itinerary = String(b.itinerary || '').slice(0, 20000);
    const content = [];
    if (b.ideaId) {
      const imgData = await kvGet('ideaimg:' + String(b.ideaId).slice(0, 40));
      const m = imgData && imgData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    content.push({
      type: 'text',
      text: 'PROGRAMMA:\n' + itinerary + '\n\nNUOVA IDEA (di ' + who + '): ' + text
        + (details ? '\nDETTAGLI: ' + details : '')
        + (link ? '\nLINK: ' + link : '')
        + (content.length ? '\n(In allegato una foto/screenshot: analizzala e tienine conto nel suggerimento.)' : '')
    });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-opus-5',
        max_tokens: 2000,
        system: "Sei l'assistente del viaggio in Giappone della famiglia Bonifati (10-25 agosto 2026; Leo, il figlio, è celiaco). Ricevi il programma e una nuova idea, a volte con foto o screenshot (un luogo, un menu, un post social): se c'è, identifica cosa mostra e usala. Rispondi in italiano, massimo 120 parole, tono pratico e caldo: 1) di' se e DOVE incastrare l'idea (giorno e fascia oraria, citando cosa c'è già in programma), 2) avvertenze utili (caldo di agosto, orari di apertura da verificare, prenotazioni, distanze, glutine se si mangia). Se l'idea non sta in piedi, dillo con garbo e proponi un'alternativa.",
        messages: [{ role: 'user', content }]
      })
    });
    const j = await r.json();
    if (j.error) return res.status(502).json({ error: j.error.message || 'errore API Anthropic' });
    const textOut = (Array.isArray(j.content) ? j.content : [])
      .filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
    if (!textOut) {
      console.error('AI: risposta senza testo —', JSON.stringify(j).slice(0, 800));
      return res.status(502).json({ error: 'Risposta AI senza testo (stop_reason: ' + (j.stop_reason || '?') + ') — riprova' });
    }
    res.json({ suggestion: textOut });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Giappone 2026 in ascolto'));
