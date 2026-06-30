# Self-hosting Howl

Run your own private Howl instance with Docker. You get your own server, your own
users, end-to-end encrypted DMs, and every Pro feature unlocked for free. No
connection back to the hosted service.

This guide is written to be followed top to bottom. **Part 1 gets it running on
your own computer in a few minutes so you can see it work. Part 2 puts it online
for other people.** You do not need to understand Docker to follow along, just
copy the commands.

## Contents

- [Part 1: Try it on your computer (5 minutes)](#part-1-try-it-on-your-computer-5-minutes)
- [Part 2: Put it online for others](#part-2-put-it-online-for-others)
- [Claim the admin account first](#claim-the-admin-account-first)
- [Adding more users](#adding-more-users)
- [Turning on voice and video](#turning-on-voice-and-video-optional)
- [Turning on email](#turning-on-email-optional)
- [Backups](#backups)
- [Updating to a new version](#updating-to-a-new-version)
- [Troubleshooting](#troubleshooting)
- [Command cheat sheet](#command-cheat-sheet)
- [Pro features unlocked](#pro-features-unlocked)

---

## Part 1: Try it on your computer (5 minutes)

This runs the whole stack locally so you can register, log in, and send an
encrypted DM before you commit to a domain or a server. Everything runs in
Docker, so the only thing you install is Docker itself.

### Step 1: Install Docker

Install **Docker Desktop**: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
(Windows or macOS), or Docker Engine + the Compose plugin on Linux.

Start Docker Desktop and leave it running. Confirm it works:

```bash
docker version
docker compose version
```

Both should print version numbers. If `docker version` says it cannot connect to
the daemon, Docker Desktop is not started yet.

> **Which terminal to use.** The commands in this guide are written for a
> bash-style shell, which you already have in the **macOS Terminal** and on
> **Linux**. On **Windows**, run everything from a **WSL2 Ubuntu** terminal (Docker
> Desktop integrates with WSL2 out of the box) or from **Git Bash**. The
> PowerShell and Command Prompt shells will not run `./setup.sh` or the `curl`
> examples correctly. The setup script also uses `openssl`, which is already
> present on macOS, Linux, and WSL2.

### Step 2: Get the code

```bash
git clone <your-howl-repo-url> howl
cd howl
```

(The `howl` at the end of the clone command names the folder, so `cd howl` always
works regardless of what the repository URL is called.)

### Step 3: Generate your configuration

**Always run the self-host commands from inside the `deploy/selfhost/` folder.**
Docker uses that folder name as the project name, which is how it finds your
config automatically and how your data volumes get their `selfhost_` names (used
in [Backups](#backups)). Running the commands from elsewhere will create a
*separate*, empty instance.

```bash
cd deploy/selfhost
./setup.sh
```

`setup.sh` asks two questions:

- **Public domain**: type `localhost` for this local test. This question has no
  default, so you must type something here; do not just press Enter.
- **Instance name**: anything you like, for example `My Howl`. This one *does*
  have a default, so you can press Enter to accept it.

It then writes a `deploy/selfhost/.env` file with strong random secrets already
filled in (database password, JWT keys, encryption keys), `SELF_HOST=true`, and
`REGISTRATION_MODE=closed`. You do not edit anything by hand. The file is written
with locked-down permissions; keep it private and never commit it.

> If `setup.sh` says it refuses to overwrite an existing `.env`, you already have
> one. Delete `deploy/selfhost/.env` first if you want to start fresh.

### Step 4: Start everything

```bash
docker compose up -d --build
```

The first run builds the app and pulls the database, so it takes a few minutes.
When it finishes, check that all four services are up:

```bash
docker compose ps
```

You want `postgres` and `redis` showing `healthy`, `backend` showing `healthy`,
and `caddy` showing `Up`. (The backend takes about 30 to 60 seconds after start
to finish its database setup and report healthy. If it still says `starting`,
wait a moment and run the command again.)

### Step 5: Open it

Go to **https://localhost** in your browser.

Because this is a local test, the browser will warn that the certificate is not
trusted ("Your connection is not private"). **This is expected on `localhost`**.
Howl's web server issues its own local certificate, which your browser does not
recognize. It is safe here because it is your own machine. To continue:

- **Chrome / Edge:** click **Advanced**, then **Proceed to localhost (unsafe)**.
  (If you do not see that link, click once anywhere on the warning page and type
  `thisisunsafe`. You will not see the letters appear anywhere; the page just
  reloads when you finish typing.)
- **Firefox:** click **Advanced**, then **Accept the Risk and Continue**.
- **Safari:** click **Show Details**, then **visit this website**.

This warning only happens with `localhost`. On a real domain (Part 2) the
certificate is trusted automatically and there is no warning.

### Step 6: Register and look around

The **first account you register becomes the admin.** The registration form asks for
the one-time **setup token** that `setup.sh` printed (also saved as `BOOTSTRAP_TOKEN`
in `deploy/selfhost/.env`). Paste it in, finish signing up, then:

1. Choose how your messages are protected (**Self recovery** keeps the only key
   with you; **Server recovery** lets the server help you recover if you forget
   your passphrase). Either works. If you pick Self recovery, save the recovery
   key it shows you.
2. Pick a layout.
3. You are in. Open a DM, send a message, and you have a working private instance.

### Step 7: Stop it

```bash
docker compose down
```

This stops the containers but keeps your data. To wipe everything and start
completely fresh, use `docker compose down -v` (the `-v` deletes the data).

That is the whole app, running locally. When you are ready to let other people in,
continue to Part 2.

---

## Part 2: Put it online for others

To let other people reach your instance, it needs to run somewhere with a public
address and a domain name.

### What you need

- A **machine that is reachable from the internet**. The easiest is a small cloud
  server (a "VPS" from any provider). You can also host from home; see
  [Hosting from home](#hosting-from-home) below.
- A **domain name** (for example `chat.example.com`) that you can edit DNS for.
- **Ports 80 and 443 open** to that machine. Howl's web server uses them to get
  and serve a real HTTPS certificate automatically.

### Steps

1. **Point your domain at the machine.** In your domain's DNS settings, add an
   `A` record (and an `AAAA` record if you have an IPv6 address) pointing your
   chosen hostname at the machine's public IP address. Wait a few minutes for it
   to take effect.

2. **Install Docker** on the machine (see [Step 1](#step-1-install-docker)) and
   **get the code** (see [Step 2](#step-2-get-the-code)).

3. **Generate config with your real domain:**

   ```bash
   cd deploy/selfhost
   ./setup.sh
   ```

   This time, enter your real domain (for example `chat.example.com`) when asked.

4. **Start it:**

   ```bash
   docker compose up -d --build
   ```

5. **Open `https://YOUR_DOMAIN`.** The first time you load it, Howl's web server
   automatically requests a real, trusted HTTPS certificate (via Let's Encrypt /
   ZeroSSL), so give DNS a minute to settle before loading the site. There is
   **no certificate warning** on a real domain. If you still get an error after a
   few minutes, see the "certificate warning on a real domain" row in
   [Troubleshooting](#troubleshooting). It is almost always DNS not resolving yet
   or ports 80/443 being blocked.

6. **Register the admin account.** The form asks for the one-time setup token that
   `setup.sh` printed (`BOOTSTRAP_TOKEN` in `deploy/selfhost/.env`); paste it in to
   create the first account. Because the token is required, nobody can claim admin
   before you even if the URL is already public. See
   [Claim the admin account first](#claim-the-admin-account-first).

### Hosting from home

You can host from a machine at home, but home networks usually block incoming
connections, so you have two options:

- **Port forwarding:** in your router, forward external ports **80 and 443** to
  the machine running Howl. If your home IP address changes over time, also set
  up **dynamic DNS** (many routers and registrars offer this) so your domain
  keeps pointing at the right address.
- **A tunnel (no port forwarding):** a service like **Cloudflare Tunnel** exposes
  your instance without opening any router ports. If you use a tunnel that
  terminates HTTPS for you, you do not need ports 80/443 open at all. Follow your
  tunnel provider's guide and point it at the `caddy` container's port.

---

## Claim the admin account first

> **The very first account to register becomes the instance admin and owner of a
> default server,** but only if it presents the one-time **setup token**
> (`BOOTSTRAP_TOKEN`) that `setup.sh` generated and printed. The token is also saved in
> `deploy/selfhost/.env`. Keep it private: anyone who has it can claim the admin account.

Because the first-admin claim requires that token, it is safe to bring the instance
online before you register. A stranger who finds your URL cannot claim admin without
the token. The claim happens exactly once; after the first account exists, the
`REGISTRATION_MODE` setting (below) controls whether anyone else can sign up.

---

## Adding more users

By default a new instance is in **closed registration** (`REGISTRATION_MODE=closed`),
the "private island" mode: only the admin can add people. You have two choices.

### Option A: Let people sign up themselves

Open registration so anyone with the URL can create an account. Edit
`deploy/selfhost/.env` and change:

```env
REGISTRATION_MODE=open
```

Then apply it (this just restarts with the new setting; your data is kept):

```bash
cd deploy/selfhost
docker compose up -d
```

Set it back to `closed` and re-run the same command to lock it down again.

### Option B: Create accounts as the admin (stay closed)

In closed mode, you (the admin) create accounts through a small admin API. There
is no admin web page for this yet, so you use two `curl` commands.

**1. Get your admin login token.** On a default instance (email turned off), log
in from the command line and read the token straight from the response:

```bash
curl -k -X POST https://YOUR_DOMAIN/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-admin-password"}'
```

The response is one line of JSON containing a large `user` object and, as a
top-level field, your `token`:

```json
{"user":{"id":"...","username":"you", ...},"token":"eyJhbGciOi...long-string..."}
```

The easiest way to grab it is to append `| jq -r .token` to the login command (if
you have `jq`); otherwise copy the long value between the quotes after `"token":`
(the characters only, not the quotes). (Use `-k` only for a `localhost` test; on a
real domain with a trusted certificate you can drop it.)

> **If you have turned on email** (you set `RESEND_API_KEY`), a command-line login
> is challenged for a one-time email code and will *not* return a token. In that
> case, log in through the browser instead, open the browser developer tools, switch
> to the **Network** tab, complete the email-code step, and click the `login` (or
> `verify-device/confirm`) request; its **Response** tab contains the `token` to copy.
> (Howl keeps the token in memory, so it never appears in Local Storage.)

**2. Create the user**, pasting your token after `Bearer`:

```bash
curl -k -X POST https://YOUR_DOMAIN/api/v1/instance/users \
  -H "Authorization: Bearer PASTE_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"Str0ng-Passw0rd!"}'
```

> **Password rules:** a password must be at least **12 characters** and include
> an uppercase letter, a number, and a symbol. The example above meets them. A
> weaker password is rejected with HTTP 400 and a body like
> `{"error":"Validation failed","fields":{"password":"Password must be at least 12 characters"}}`,
> and no user is created.

A success response looks like `{"id":"...","username":"alice","discriminator":"1234"}`.
The new account is created already verified. Give the person their username and
password and have them change the password after their first login.

**To reset someone's password** (this also signs them out everywhere). Use the
person's `id` from the create response in place of `THEIR_USER_ID`, and a new
password that meets the same rules above:

```bash
curl -k -X POST https://YOUR_DOMAIN/api/v1/instance/users/THEIR_USER_ID/reset-password \
  -H "Authorization: Bearer PASTE_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"newPassword":"New-Passw0rd-2026!"}'
```

Both commands require the `ADMIN` role and only exist on self-hosted instances.

---

## Turning on voice and video (optional)

Voice and video are off by default, and text, DMs, and full encryption work
without them. Howl uses [LiveKit](https://livekit.io/) as the media server, and
self-host expects you to bring your own LiveKit deployment.

Once you have a LiveKit server, add these to `deploy/selfhost/.env`:

```env
LIVEKIT_WS_URL=wss://your-livekit-host
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

Apply the change:

```bash
cd deploy/selfhost
docker compose up -d
```

Voice turns on only when all three values are present and real (not the LiveKit
development placeholders `devkey` / `secret`).

---

## Turning on email (optional)

Email is optional. With no email provider configured, new accounts are
auto-verified and everyone can log in normally, so the instance works fully
without it.

To turn on verification and password-reset emails, set a
[Resend](https://resend.com/) API key in `deploy/selfhost/.env`:

```env
RESEND_API_KEY=your-resend-api-key
```

Apply it:

```bash
cd deploy/selfhost
docker compose up -d
```

---

## Backups

Two pieces of durable data must be backed up. They live in Docker named volumes:

- **`selfhost_pgdata`**: the database (users, servers, channels, messages).
- **`selfhost_uploads`**: uploaded files and attachments.

First, confirm the exact volume names (they are prefixed with the compose project
name, which is `selfhost` as long as you run from `deploy/selfhost/`):

```bash
docker volume ls
```

You should see `selfhost_pgdata` and `selfhost_uploads`. If yours have a different
prefix, substitute the real names in the commands below.

Back them up with the stack stopped. This archives each volume to a `.tar.gz`:

```bash
cd deploy/selfhost
docker compose down

docker run --rm -v selfhost_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-backup.tar.gz -C /data .
docker run --rm -v selfhost_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/uploads-backup.tar.gz -C /data .

docker compose up -d
```

> **Heads up:** while the stack is stopped (`docker compose down`), your instance
> is offline for everyone. For a local test that does not matter; for an online
> instance, run backups during a quiet period.

**Also keep a copy of `deploy/selfhost/.env`.** Its secrets are required to read
the encrypted data; restoring the database without the matching `.env` will not work.

---

## Updating to a new version

> **Back up first.** An update can run database migrations, and a failed
> migration has no automatic rollback. Take a fresh backup (see
> [Backups](#backups)) before every update so you can always roll back.

To update:

```bash
cd /path/to/howl
git pull

cd deploy/selfhost
docker compose up -d --build
```

This rebuilds and restarts with the new code. Your `.env` and your data volumes
are kept, and database migrations run automatically on start.

### Stable releases vs. the latest code

`git pull` on the default branch gives you the **latest** code, which moves fast
and is not guaranteed to be stable. To pin a known-good version instead, check out
a self-host release tag. Self-host releases are tagged `selfhost-<version>` (the
first is `selfhost-1.0.0`), a track of their own, separate from Howl's hosted
desktop-app releases (the `v*` tags). List the self-host tags and check out the
newest one:

```bash
git fetch --tags
git tag --list 'selfhost-*'

# Check out the newest self-host release from that list:
git checkout selfhost-1.0.0

cd deploy/selfhost
docker compose up -d --build
```

Repeat with a newer `selfhost-*` tag when you want to move up.

### If an update fails

- **The backend will not start and the log mentions a missing or required
  variable.** A newer version added a setting your `.env` does not have yet.
  `setup.sh` never edits an existing `.env`, so add the new key by hand: compare
  your `deploy/selfhost/.env` against `deploy/selfhost/.env.example`, copy over
  anything you are missing, then run `docker compose up -d`.
- **A database migration failed.** Look at `docker compose logs backend`.
  Restore your most recent backup (see [Backups](#backups)); that backup is your
  real rollback. Then return to the previous code: if you pinned a release tag,
  check that tag back out; if you were tracking the latest branch, find the
  commit you were on before the pull with `git reflog` (the entry just before
  `pull`) and `git checkout` it. Bring the stack back up, then report the failure
  before retrying.

---

## Troubleshooting

| Symptom | What to do |
|---------|-----------|
| Browser warns the certificate is not trusted on **`localhost`** | Expected. Click through (Chrome: **Advanced → Proceed**, or type `thisisunsafe` on the warning page). Only happens on `localhost`. |
| Certificate warning on a **real domain** | DNS is not pointing at the machine yet, or ports 80/443 are blocked. Check your DNS record and firewall, then reload after a minute. |
| "This site can't be reached" | Make sure the stack is running: `docker compose ps`. On a real domain, confirm DNS points at the machine and ports 80/443 are open. |
| `backend` shows `unhealthy` or keeps restarting | See its logs: `docker compose logs -f backend`. The most common cause is a bad value in `.env`. |
| Want to see what is happening | `docker compose logs -f` (all services) or `docker compose logs -f backend`. |
| `setup.sh` refuses to run | A `deploy/selfhost/.env` already exists. Remove it to regenerate, or edit it directly. |
| `./setup.sh` errors, "permission denied", `openssl: command not found`, or odd syntax errors | You are likely in the wrong shell. Use the macOS/Linux Terminal, or on Windows a WSL2 Ubuntu / Git Bash terminal (not PowerShell or cmd). `openssl` ships with all of those. If you got "permission denied", run `bash setup.sh`. If a previous run left a half-written `.env`, delete it and re-run. |
| Forgot the volume names for backups | `docker volume ls` lists them (look for the `selfhost_` prefix). |
| `backend` will not start after an update, log mentions a missing or required variable | A newer version added a setting. Copy the missing key from `deploy/selfhost/.env.example` into your `.env`, then `docker compose up -d`. See [Updating](#updating-to-a-new-version). |
| An update or a database migration failed | Restore your latest backup (your real rollback), return to the previous code (your pinned tag, or `git reflog` to find the pre-pull commit), and bring the stack back up. See [Updating](#updating-to-a-new-version). |
| Start over completely | `docker compose down -v` deletes the containers **and all data**, then run setup again. |

To check overall status any time:

```bash
cd deploy/selfhost
docker compose ps
```

---

## Command cheat sheet

All commands run from `deploy/selfhost/`:

| Action | Command |
|--------|---------|
| Generate config | `./setup.sh` |
| Start / apply changes | `docker compose up -d --build` |
| Apply an `.env` change (no rebuild) | `docker compose up -d` |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f backend` |
| Stop (keep data) | `docker compose down` |
| Stop and wipe data | `docker compose down -v` |
| Update (latest) | `git pull` then `docker compose up -d --build` |
| Pin a self-host release | `git fetch --tags`, `git tag --list 'selfhost-*'`, then `git checkout <release>` |

---

## Pro features unlocked

On a self-hosted instance, every Pro feature is unlocked for free for all
accounts. This is on by default (`SELF_HOST_ALL_PRO=true`, which `setup.sh`
writes). To turn it off, set `SELF_HOST_ALL_PRO=false` in `deploy/selfhost/.env`
and restart with `docker compose up -d`.
