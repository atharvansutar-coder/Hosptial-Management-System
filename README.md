# CareFlow

CareFlow runs on one computer with a local Node.js API, SQLite database, and private PDF files. It does not need Firebase or a paid cloud plan. The computer hosting CareFlow must remain on and connected to the network while patients or staff use it.

## Install and start

Requirements: Node.js 20 or newer and npm.

1. In a terminal, open the CareFlow folder and install dependencies:

   ```sh
   npm install
   ```

2. Create the local configuration if you do not already have `.env`:

   ```sh
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env`. If `.env` already exists, keep it and add/update these settings rather than overwriting it. Set `JWT_SECRET` to a random secret of at least 32 characters (on macOS/Linux, generate one with `openssl rand -hex 32`), `ADMIN_EMAIL` to the first administrator's email, and `ADMIN_PASSWORD` to a unique password of at least 12 characters. Keep `.env` private; it is ignored by Git.

3. Create the first admin account:

   ```sh
   npm run seed:admin
   ```

4. Start CareFlow:

   ```sh
   npm run start
   ```

   This builds the React app and starts the API and website together. The terminal prints the laptop's local and network URLs. Open the network URL on phones connected to the same Wi-Fi, and make the common patient QR code from that URL. Do not use the old Firebase Hosting URL: it hosts only the old static frontend and has no local API, so appointment requests there cannot work.

The SQLite database is created at `data/careflow.db`; private PDFs are under `data/records/`. To develop with Vite, run `npm run server:dev` in one terminal and `npm run dev` in another.

## Staff accounts

Set `STAFF_EMAIL`, `STAFF_PASSWORD` (at least 12 characters), `STAFF_ROLE` (`receptionist`, `doctor`, or `admin`), and `STAFF_HOSPITAL_ID` in `.env`, then run:

```sh
npm run staff:grant
```

The command prints the staff user's ID. Link that ID to the doctor's profile in CareFlow's Doctor Availability page. To disable the configured staff account, keep its email in `STAFF_EMAIL` and run `npm run staff:remove`.

## Tests

```sh
npm test
npm run build
```

The backend tests cover cross-hospital denial, patient record ownership, concurrent last-slot booking, reminder idempotency, and private PDF uploads/downloads.

## Start automatically

### Windows Task Scheduler

Create a task triggered **At startup**. Set the program to `cmd.exe`, arguments to `/c npm run start`, and **Start in** to the CareFlow project folder. Run it as the same Windows account that owns the project and its `.env`/`data` files. Keep the computer awake and connected to the network.

### macOS/Linux with pm2

```sh
npm install --global pm2
pm2 start npm --name careflow -- start
pm2 save
pm2 startup
```

Run the platform-specific command printed by `pm2 startup`, then check status with `pm2 status` and logs with `pm2 logs careflow`.

## Access from outside the laptop

Install `cloudflared` (for example, `brew install cloudflared` on macOS or `winget install Cloudflare.cloudflared` on Windows). For short-lived testing, start CareFlow and run:

```sh
cloudflared tunnel --url http://localhost:3000
```

Use the temporary HTTPS URL printed by `cloudflared` for testing only; it changes and stops working when the tunnel process exits. For a stable hostname, log in and create a named tunnel, then route a DNS hostname you control to it:

```sh
cloudflared tunnel login
cloudflared tunnel create careflow
cloudflared tunnel route dns careflow careflow.example.com
cloudflared tunnel run careflow
```

Configure the tunnel's `config.yml` ingress to send `careflow.example.com` to `http://localhost:3000` and end with a `http_status:404` fallback; Cloudflare's dashboard also offers a guided public-hostname setup. Run the tunnel as a service so it starts again after reboot. Do not expose port 3000 directly on the router. A tunnel makes the service internet-reachable and sends traffic through Cloudflare; use strong unique passwords, keep the laptop and dependencies updated, and only do this if that data-routing arrangement is acceptable. For normal patient use, a trusted local Wi-Fi network is simpler.

### Connect the Netlify frontend to this laptop

The Netlify site is only the frontend. To route its `/api` requests to this laptop without browser cross-origin cookies:

1. On the laptop, set `COOKIE_SECURE=true` in `.env`, then run `npm run start` in one terminal and leave it running.
2. In another terminal, run `cloudflared tunnel --url http://localhost:3000`. Copy the temporary `https://...trycloudflare.com` URL it prints.
3. In Netlify, open the CareFlow site's **Site configuration → Environment variables** and add `CAREFLOW_API_ORIGIN` with that HTTPS URL (origin only, no path or trailing route).
4. Trigger a fresh deployment of the latest GitHub commit in Netlify. The build creates a same-origin `/api` proxy rule for the frontend.
5. Test the Netlify site. Keep both terminals and the laptop online. The temporary URL changes when the tunnel restarts, so update the Netlify variable and redeploy after that. Never put `JWT_SECRET` or other backend credentials in Netlify.

This makes the laptop API publicly reachable through the tunnel. Share the public site only with users you intend to give access to; keep passwords strong, configure external-drive backups, and stop the tunnel when it is not needed. If Netlify builds without `CAREFLOW_API_ORIGIN`, the build will fail instead of publishing a frontend disconnected from its API.

## Backups and restore

Set `BACKUP_DIR` in `.env` to a folder on a separate USB/external drive. Backups include a consistent SQLite copy and the PDF directory. The scheduled job runs at `BACKUP_CRON` (default 2:00 AM) and keeps the newest 14 backup folders. Run one manually with:

```sh
npm run backup:run
```

To restore, stop CareFlow first. On macOS/Linux, set `BACKUP` to the chosen backup folder and run:

```sh
BACKUP="/path/to/careflow-backups/careflow-YYYY-MM-DDTHH-MM-SS"
cp "$BACKUP/careflow.db" data/careflow.db
mkdir -p data/records
cp -R "$BACKUP/records/." data/records/
```

On Windows PowerShell, replace `$backup` with the selected backup folder and run:

```powershell
Copy-Item "$backup\careflow.db" ".\data\careflow.db" -Force
New-Item -ItemType Directory -Force ".\data\records" | Out-Null
Copy-Item "$backup\records\*" ".\data\records" -Recurse -Force
```

Do not restore or copy SQLite files while the server is running. Start CareFlow again with `npm run start`, then verify a patient and a PDF before returning it to use. Keep the external drive disconnected when not backing up.

## Security and privacy notes

- Passwords are bcrypt-hashed; sessions use an HTTP-only cookie. API routes enforce role, patient ownership, and hospital scope. PDFs are private and can only be uploaded/downloaded through authenticated API routes.
- Helmet headers, rate limits, Zod input validation, and audit events are enabled. Audit events record actions and IDs, not diagnoses or other clinical text.
- Record consent can be withdrawn; patient export/erasure requests require admin approval. Clinical data and audit history are not automatically deleted. Set and document a retention schedule that meets local law and hospital policy; the backup rotation is not a medical-record retention policy.
- App Check is a Firebase feature and is not used by this local backend. The server requires authenticated sessions for private data and must not be exposed directly to the internet. A Cloudflare Tunnel provides HTTPS transport but is not a replacement for account security, backups, or access controls.
- Existing Firebase data is not automatically copied into SQLite. Export and verify any records you need before switching; keep the Firebase project and its backups until the local data has been checked.

## Data model

The local SQLite database contains users and JSON-backed tables for patients, appointments, slots, doctors, medical records, notifications, audit logs, consents, privacy requests, queue tickets, patient details, and QR tracking projections. The `data/records/{hospitalId}/{patientId}/` directory holds random-named PDF files; it is not served as a public static directory.
# Hosptial-Management-System
