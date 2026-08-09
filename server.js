/* Giappone 2026 — server minimale: statico + stato condiviso + proxy voli */
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

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

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Giappone 2026 in ascolto'));
