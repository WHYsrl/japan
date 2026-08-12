/* Giappone 2026 — server minimale: statico + stato condiviso + proxy voli */
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '8mb' }));

/* ── Accesso con "ricordami" (cookie 6 mesi) + Basic auth di riserva ── */
if (process.env.APP_PASSWORD) {
  const crypto = require('crypto');
  const want = 'Basic ' + Buffer.from('japan:' + process.env.APP_PASSWORD).toString('base64');
  const tok = crypto.createHmac('sha256', process.env.APP_PASSWORD).update('japan2026-ricordami').digest('hex');
  const setCookie = res => res.append('Set-Cookie', 'jauth=' + tok + '; Max-Age=15552000; Path=/; HttpOnly; Secure; SameSite=Lax');
  const hasCookie = req => ((req.headers.cookie || '').match(/(?:^|;\s*)jauth=([^;]+)/) || [])[1] === tok;
  app.use(express.urlencoded({ extended: false }));
  app.post('/login', (req, res) => {
    if (((req.body && req.body.password) || '') === process.env.APP_PASSWORD) {
      setCookie(res);
      return res.redirect('/');
    }
    res.redirect('/?e=1');
  });
  app.use((req, res, next) => {
    if (hasCookie(req)) return next();
    if ((req.headers.authorization || '') === want) { setCookie(res); return next(); }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth' });
    res.status(401).send('<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>日本 2026 · Accesso</title><style>'
      + 'body{font-family:-apple-system,"Zen Maru Gothic",sans-serif;background:#FBF7EF;color:#2B2320;display:grid;place-items:center;min-height:100vh;margin:0}'
      + '.box{background:#fff;border:1.5px solid #E7DFD2;border-radius:20px;padding:32px 26px;width:min(88vw,340px);text-align:center}'
      + '.dot{width:52px;height:52px;border-radius:50%;background:#C73E3A;margin:0 auto 14px}'
      + 'h1{font-size:19px;margin:0 0 4px}p{font-size:13px;color:#7A6F63;margin:0 0 18px}'
      + 'input{width:100%;box-sizing:border-box;border:1.5px solid #E7DFD2;border-radius:12px;padding:12px;font-size:16px;font-family:inherit;text-align:center}'
      + 'button{width:100%;border:0;background:#C73E3A;color:#fff;border-radius:12px;padding:13px;font-size:15px;font-weight:700;font-family:inherit;margin-top:10px}'
      + '.err{color:#A32F2C;font-size:13px;font-weight:700;margin:10px 0 0}'
      + '.hint{font-size:11.5px;color:#7A6F63;margin-top:14px}'
      + '</style></head><body><form class="box" method="POST" action="/login">'
      + '<div class="dot"></div><h1>日本 2026 · Bonifati</h1><p>Il viaggio di famiglia</p>'
      + '<input type="password" name="password" placeholder="Password di famiglia" autofocus autocomplete="current-password">'
      + '<button type="submit">Entra</button>'
      + (req.query && req.query.e ? '<div class="err">Password sbagliata, riprova.</div>' : '')
      + '<div class="hint">Questo dispositivo resterà collegato per 6 mesi.</div>'
      + '</form></body></html>');
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
    if (req.body && Array.isArray(req.body.chat)) {
      it.chat = req.body.chat.slice(-40).map(m => ({ r: (m && m.r === 'a') ? 'a' : 'u', t: String((m && m.t) || '').slice(0, 5000), w: String((m && m.w) || '').slice(0, 30) })).filter(m => m.t);
      const lastAi = it.chat.filter(m => m.r === 'a').slice(-1)[0];
      it.ai = lastAi ? lastAi.t : it.ai;
    }
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
    const oggi = new Intl.DateTimeFormat('it-IT', { dateStyle: 'full', timeZone: 'Asia/Tokyo' }).format(new Date());
    content.push({
      type: 'text',
      text: 'Oggi in Giappone è ' + oggi + '.\n\nPROGRAMMA:\n' + itinerary + '\n\nNUOVA IDEA (di ' + who + '): ' + text
        + (details ? '\nDETTAGLI: ' + details : '')
        + (link ? '\nLINK: ' + link : '')
        + (content.length ? '\n(In allegato una foto/screenshot: analizzala e tienine conto nel suggerimento.)' : '')
    });
    const msgs = [{ role: 'user', content }];
    const history = Array.isArray(b.history) ? b.history.slice(-24) : [];
    for (const m of history) {
      const role = (m && m.r === 'a') ? 'assistant' : 'user';
      let t = String((m && m.t) || '').slice(0, 5000);
      if (!t) continue;
      if (role === 'user' && m.w) t = String(m.w).slice(0, 30) + ': ' + t;
      const last = msgs[msgs.length - 1];
      if (last.role === role && typeof last.content === 'string') last.content += '\n' + t;
      else msgs.push({ role, content: t });
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-fable-5',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        system: "Sei l'assistente del viaggio in Giappone della famiglia Bonifati (10-25 agosto 2026): Filippo (Fili), Floriana (Flo) e il figlio Leo, che è CELIACO. Ricevi il programma, un'idea firmata da uno di loro (a volte con foto o screenshot: identifica cosa mostra e usala) e l'eventuale conversazione. Rivolgiti sempre direttamente a chi firma il messaggio, dandogli del tu.\nREGOLE FERREE DI VERIFICA — la famiglia prende decisioni reali in viaggio sulla base delle tue risposte:\n1) Prima della prima risposta su qualunque locale o luogo fai SEMPRE almeno una ricerca web (nome + città) e basati sui risultati, MAI sulla memoria: la memoria su locali specifici è spesso sbagliata.\n2) MAI nominare, collocare o descrivere un locale che non compare nei risultati delle tue ricerche. Se un posto non risulta esistere, dillo chiaramente.\n3) Verifica orari di apertura, giorni di chiusura, prezzi e necessità di prenotare PRIMA di affermarli (periodo Obon: molte variazioni), e nel dubbio scrivi «non ho potuto confermare…». Meglio un dubbio dichiarato che un dettaglio inventato.\n4) Se la ricerca smentisce quello che credevi, ammettilo e correggi.\n5) DATE: esprimi sempre giorni e orari in forma ASSOLUTA («il 17/8 alle 8:00»), MAI con espressioni relative come «domani», «domattina», «stasera», «dopodomani» — a meno che non si riferiscano davvero alla data di oggi indicata a inizio conversazione. Non calarti mai nella prospettiva temporale del giorno di cui si sta parlando: tu parli sempre dalla data di oggi.\nRispondi in italiano, massimo 150 parole, tono pratico e caldo: di' se e DOVE incastrare l'idea (giorno e fascia oraria, citando cosa c'è già in programma e i vincoli di orario reali) e le avvertenze utili (caldo di agosto, distanze, prenotazioni, glutine per Leo). Se l'idea non sta in piedi così com'è, dillo con garbo e proponi l'alternativa concreta migliore. Nelle risposte successive rispondi in modo diretto alla domanda specifica.",
        messages: msgs
      })
    });
    const j = await r.json();
    if (j.error) return res.status(502).json({ error: j.error.message || 'errore API Anthropic' });
    const blocks = Array.isArray(j.content) ? j.content : [];
    const textOut = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    if (!textOut) {
      console.error('AI: risposta senza testo —', JSON.stringify(j).slice(0, 800));
      return res.status(502).json({ error: 'Risposta AI senza testo (stop_reason: ' + (j.stop_reason || '?') + ') — riprova' });
    }
    const cites = [];
    for (const bk of blocks) {
      if (bk && bk.type === 'text' && Array.isArray(bk.citations)) {
        for (const c of bk.citations) { if (c && c.url && !cites.includes(c.url)) cites.push(c.url); }
      }
    }
    res.json({ suggestion: textOut + (cites.length ? '\n\nFonti: ' + cites.slice(0, 3).join(' · ') : '') });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); }
}));
app.listen(process.env.PORT || 3000, () => console.log('Giappone 2026 in ascolto'));
