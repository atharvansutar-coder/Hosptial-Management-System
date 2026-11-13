# CareFlow

CareFlow runs on one computer with a local Node.js API, SQLite database, and private PDF, JPG, and PNG medical documents. The computer hosting CareFlow must remain on and connected to the network while patients or staff use it.

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

   On Windows PowerShell, use `Copy-Item .env.example .env`. If `.env` already exists, keep it and add/update these settings rather than overwriting it. Set `JWT_SECRET` to a random secret of at least 32 characters (on macOS/Linux, generate one with `openssl rand -hex 32`), `ADMIN_EMAIL` to the administrator's email, and `ADMIN_PASSWORD` to a unique password of at least 12 characters. `ADMIN_HOSPITAL_ID` defaults to `central-city-hospital`; it can instead be set to `riverside-general` or `northside-medical-center`. Keep `.env` private; it is ignored by Git.

3. Create the first admin account:

   ```sh
   npm run seed:admin
   ```

   If the command reports `ADMIN_PASSWORD` is missing, add `ADMIN_PASSWORD` to `.env`, save the file, and run the command again. The password is not generated automatically.

4. Start CareFlow:

   ```sh
   npm run start
   ```

   This builds the React app and starts the API and website together. The terminal prints the laptop's local and network URLs. Open the network URL on phones connected to the same Wi-Fi, and make the common patient QR code from that URL.

The SQLite database is created at `data/careflow.db`; private medical documents are under `data/records/`. The self-service check-in QR opens the focused check-in form. Submitted patients appear in the matching hospital's staff queue; staff can select **Patient details** on a ticket to view the submitted name and mobile number. To develop with Vite, run `npm run dev`; it starts both the local API and Vite frontend. The terminal prints the frontend URL. `npm run server:dev` remains available when you need to run only the API separately.

## Staff accounts

Set `STAFF_EMAIL`, `STAFF_PASSWORD` (at least 12 characters), `STAFF_ROLE` (`receptionist`, `doctor`, or `admin`), and `STAFF_HOSPITAL_ID` in `.env`, then run:

```sh
npm run staff:grant
```

The command prints the staff user's ID. Link that ID to the doctor's profile in CareFlow's Doctor Availability page. To disable the configured staff account, keep its email in `STAFF_EMAIL` and run `npm run staff:remove`.

New staff can use **Request access** on the staff sign-in page. Requests remain inactive until an administrator reviews them in **Staff access requests** from the separate administrator portal at `/admin`. Public requests can only ask for receptionist or doctor access; administrators cannot be self-requested. Administrators can review requests for all listed hospitals.

Administrators can add hospitals by name from the **Manage hospitals** section of `/admin`. New hospitals appear in patient registration, appointment requests, and staff access requests across connected CareFlow pages. Names are unique, and added hospitals do not automatically receive contact details or staff accounts.

## Patient registration and appointment review

Patients can create an account from **Patient account**, provide their contact details and appointment request, and track its status after submission. The profile and pending request are saved together; the request appears in the assigned hospital's **Request inbox**, with the patient name and mobile number visible to authorized staff. Receptionists and admins can confirm it by assigning an available doctor and time slot, or decline it with a reason. Add the hospital's doctor names in **Doctor availability**, then create their open times in **Slot scheduler**; the request inbox links directly to these setup pages when doctors or slots are missing.

Hospital staff can search a patient and open **Patient history** to correct the patient's name or mobile number, upload private PDF, JPG, and PNG documents directly to the patient profile (independent of visits), and attach PDF, JPG, or PNG files to visit records. Profile documents are limited to 10 MB each and are visible only to the patient and staff at the assigned hospital. When confirming or rescheduling an appointment, receptionists and admins can set an approximate arrival window around the reserved slot. Patients see a live countdown to the opening of that window in appointment status.

## Tests

```sh
npm test
npm run build
```

The backend tests cover cross-hospital denial, patient record ownership, concurrent last-slot booking, reminder idempotency, and authenticated private medical document uploads/downloads.

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

Do not restore or copy SQLite files while the server is running. Start CareFlow again with `npm run start`, then verify a patient and a medical document before returning it to use. Keep the external drive disconnected when not backing up.

## Security and privacy notes

- Passwords are bcrypt-hashed; sessions use an HTTP-only cookie. API routes enforce role, patient ownership, and hospital scope. PDF, JPG, and PNG medical documents are private and can only be uploaded/downloaded through authenticated API routes.
- Queue QR codes contain only a random ticket reference. Name and mobile number are fetched only after staff sign-in and hospital-scope authorization; public ticket tracking never includes patient identity.
- Helmet headers, rate limits, Zod input validation, and audit events are enabled. Audit events record actions and IDs, not diagnoses or other clinical text.
- Record consent can be withdrawn; patient export/erasure requests require admin approval. Clinical data and audit history are not automatically deleted. Set and document a retention schedule that meets local law and hospital policy; the backup rotation is not a medical-record retention policy.
- The server requires authenticated sessions for private data and must not be exposed directly to the internet. A Cloudflare Tunnel provides HTTPS transport but is not a replacement for account security, backups, or access controls.

## Data model

The local SQLite database contains users and JSON-backed tables for patients, appointments, slots, doctors, medical records, notifications, audit logs, consents, privacy requests, queue tickets, patient details, and QR tracking projections. The `data/records/{hospitalId}/{patientId}/` directory holds random-named PDF, JPG, and PNG files; it is not served as a public static directory. The `pdfFiles` field stores medical-document metadata, including category, description, uploader, and file type.
# Hosptial-Management-System
