# 日本 2026 — app di viaggio

App di famiglia per il viaggio in Giappone (10–24 agosto 2026): itinerario col meteo,
QR di biglietti e documenti, checklist e appunti CONDIVISI, sezione celiachia.

## Deploy (una volta sola, ~5 minuti)
1. Push di questa cartella su un repo GitHub (privato va benissimo)
2. Su render.com → New → **Blueprint** → seleziona il repo → Apply
   (il file `render.yaml` crea da solo web service + database)
3. Al prompt inserisci le due variabili:
   - `AIRLABS_KEY` → la chiave airlabs.co (stato voli automatico)
   - `APP_PASSWORD` → la password di famiglia (utente: `japan`)
4. Fine. URL tipo `https://japan-2026.onrender.com` → Aggiungi a Home su tutti i telefoni.

## Aggiornamenti
`git push` → Render rideploya da solo. Nessun FTP, nessuna cache da combattere.

## Note operative
- **Appunti e spunte sono condivisi** tra tutti i telefoni (salvati su Postgres).
- Web service su piano Starter (a pagamento): sempre attivo, niente sleep.
- Postgres free scade dopo 30 giorni dalla creazione: copre tutto il viaggio.
  Se l'app dovesse restare in vita oltre, upgrade o export.
- Se il server non risponde, l'app degrada da sola su salvataggio locale.
