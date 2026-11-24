# Destroy Your Debt server

A small local server that brings your credit card balances from your bank into the
[Destroy Your Debt dashboard](https://destroy-your-debt.com), using
[SimpleFIN Bridge](https://bridge.simplefin.org).

It runs on your own computer and keeps your SimpleFIN access there. The dashboard in your browser
only ever receives balances, never the credentials that fetch them.

```
your banks ──► SimpleFIN Bridge ──► this server (127.0.0.1:47317) ──► dashboard in your browser
                                    holds the SimpleFIN access          applies balances to your cards
                                                                         └─► Google Drive sync ──► your other devices
```

Your phone can't reach a server on your computer, but it doesn't need to: once the dashboard on this
computer updates the balances, Google Drive sync carries them to your other devices.

## Requirements

- **Node.js 22.12 or newer** (`node -v` to check). The server has no npm dependencies.
- A **SimpleFIN Bridge** subscription ($1.50 a month or $15 a year, up to 25 banks), with your banks
  connected at https://bridge.simplefin.org.
  - Check that your card issuers are supported with the
    [institution search](https://beta-bridge.simplefin.org/search-institutions).
- A desktop browser on the same computer: **Chrome, Edge or Firefox**.
  - Safari may block a secure website from talking to a server on your own computer. If it does,
    use one of the others on this computer.

## Install

Clone this repository:

```bash
git clone https://github.com/charlesrclark1243/Destroy-Your-Debt-Server.git
cd Destroy-Your-Debt-Server
```

There's nothing to install with npm. Optionally, run the tests to check everything works on your
machine:

```bash
npm test
```

## One-time setup: connect to SimpleFIN

1. At https://bridge.simplefin.org, sign in and connect your banks.
2. Create a **setup token** for this app at https://bridge.simplefin.org/simplefin/create.
3. Run the setup and paste the token when it asks. It isn't shown on screen while you paste.

   ```bash
   npm run setup
   ```

   The server exchanges the token once for a permanent **Access URL**. It saves the Access URL in
   `~/.config/destroy-your-debt-server/config.json`, which only your user account can read, and lists
   the accounts it found.

Treat the setup token and the Access URL like passwords:

- **Don't** paste them into chats, issues, emails or the dashboard.
- **Don't** commit `config.json`. It lives outside this project, in your home folder, so a normal
  commit won't include it.

A setup token works only once. To set up again, for example on another computer or after revoking
access, create a new one.

## Run it

```bash
npm start
```

It prints something like:

```
Destroy Your Debt server running on http://127.0.0.1:47317
Allowed sites: https://destroy-your-debt.com, http://localhost:4200

  Pairing code: 123-456   (valid 10 minutes, one use)
```

Leave it running while you use bank sync, and press **Ctrl+C** to stop it. A browser only needs the
pairing code the first time; after that, starting the server is enough.

| Command | What it does |
|---|---|
| `npm run setup` | Connect to SimpleFIN with a setup token (one time) |
| `npm start` | Run the server and print a pairing code |
| `npm run status` | Show whether SimpleFIN access is saved, and which browsers are paired |
| `npm run forget` | Delete the saved SimpleFIN access and all pairings from this computer |
| `npm test` | Run the tests |

### Settings

Set these as environment variables when starting, for example `DYD_ORIGINS=… npm start`.

| Variable | Default | Purpose |
|---|---|---|
| `DYD_ORIGINS` | `https://destroy-your-debt.com,http://localhost:4200` | Comma-separated websites allowed to use the server. Add yours if you host your own copy of the dashboard. |
| `DYD_PORT` | `47317` | The port to listen on. The dashboard expects 47317, so if you change it, also change `SERVER_URL` in the dashboard's `src/app/core/bank-sync.service.ts`. |
| `XDG_CONFIG_HOME` | `~/.config` | Where the `destroy-your-debt-server/config.json` folder is created. |

### Start it automatically (optional)

On Linux with systemd, run the server in the background at login:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/destroy-your-debt-server.service <<EOF
[Unit]
Description=Destroy Your Debt server

[Service]
WorkingDirectory=$(pwd)
ExecStart=$(command -v node) src/cli.mjs serve
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now destroy-your-debt-server
```

To see the pairing code, look at its log:

```bash
journalctl --user -u destroy-your-debt-server -n 20
```

## Connect it to the web app

Do this on the same computer that runs the server.

1. Start the server (`npm start`) and note the pairing code.
2. Open https://destroy-your-debt.com (or http://localhost:4200 if you're running the dashboard
   locally).
3. Open **Bank sync → Update balances from your bank**, enter the pairing code and click **Connect**.
   - Chrome and Edge may ask to **allow access to devices on your local network**. Allow it. That's
     how the website reaches the server on your own computer.
4. The dashboard lists the accounts SimpleFIN returned:
   - **Choose which card each one belongs to.** It suggests matches by name. Leave accounts that
     aren't cards, like checking, as **Not linked**.
   - **Check that "Amount owed" is right** for each card. Most banks report card debt as a negative
     number, which the dashboard expects. If a card shows the wrong amount, click **flip sign**.
5. Click **Update N cards**. The balances change, each card shows **from bank** with the bank's
   date, and your other devices get the new balances through Google sync.

After that:

- **Check balances** uses the server's saved copy if it's less than 6 hours old.
- **Refresh from bank** asks SimpleFIN for the latest balances. The server won't ask SimpleFIN
  more than once every 15 minutes, to stay well within its limit of about 24 requests a day.
- SimpleFIN usually updates balances about once a day, so checking more often rarely changes them.
- Your links and sign choices are remembered, so later updates are one click after checking.
- **Disconnect this browser** removes the pairing from both the browser and the server.

## Security

- **Only your computer can connect.** The server listens on `127.0.0.1` only, so other devices on
  your network can't reach it.
- **Only your dashboard can use it.**
  - The server only answers websites listed in `DYD_ORIGINS`.
  - It rejects requests whose `Host` header isn't `127.0.0.1` or `localhost`, which blocks a trick
    called DNS rebinding that malicious websites can use to reach local servers.
  - A browser must be paired before it can read balances.
- **Pairing codes** are 6 digits, work once and expire after 10 minutes. Five wrong tries cancel
  the code.
- **Pairing tokens:**
  - Each browser gets a random token. The server stores only a hash of it, so the config file never
    contains the token itself.
  - The browser keeps its token in that browser on that computer only. It is **not** synced to
    Google Drive.
- **SimpleFIN access:**
  - The Access URL is stored in a file readable only by your user account, and is never sent to the
    browser.
  - The server only requests balances, with `balances-only=1`, so your transactions aren't fetched
    at all.
- **Revoking access:**
  - Run `npm run forget` on this computer.
  - Remove the app connection at bridge.simplefin.org. This stops the Access URL working
    everywhere.
  - Use **Disconnect this browser** in the dashboard for an individual browser.
- **What this doesn't protect against:** anyone who can log in to your user account on this
  computer can read the config file, just like your other saved passwords and keys. Keep your
  computer account locked.

## Troubleshooting

| Message or problem | What to do |
|---|---|
| "Can't reach the Destroy Your Debt server" | Make sure `npm start` is running on this computer. In Chrome or Edge, check that the site is allowed local network access (click the icon left of the address bar → Site settings). |
| "This site is not allowed to use the Destroy Your Debt server" | The dashboard's address isn't in `DYD_ORIGINS`. Add it (no trailing slash) and restart. |
| "That pairing code is not right" / "has expired" / "Too many wrong codes" | Restart the server for a new code and enter it within 10 minutes. |
| "This browser is no longer paired" | Restart the server and pair again. This happens after `npm run forget`. |
| "SimpleFIN rejected the saved access" | The access was revoked or expired. Create a new setup token and run `npm run setup` again. |
| "From SimpleFIN: …" messages | These come from SimpleFIN, often a bank needing you to sign in again. Fix it at bridge.simplefin.org. |
| A card's amount owed is wrong | Use **flip sign** for that card before updating. |
| A card is missing from the list | Check it's connected at bridge.simplefin.org. Some store cards, like many issued by Comenity, aren't supported. Keep those updated by hand in the dashboard. |
| "No SimpleFIN access saved yet" | Run `npm run setup` first. |

## API

The dashboard uses these endpoints, which you can use from your own tools too.

**Every request needs:**

- an allowed `Origin` header;
- a `Host` header of `127.0.0.1:47317` or `localhost:47317`.

Endpoints marked "paired" also need `Authorization: Bearer <token>`.

| Request | Paired | Response |
|---|---|---|
| `GET /v1/status` | no | `{ "app": "destroy-your-debt-server", "version": 1, "linked": true, "paired": false }` |
| `POST /v1/pair` with `{ "code": "123-456" }` | no | `{ "token": "…" }` |
| `GET /v1/accounts` (add `?refresh=1` to ask SimpleFIN for the latest) | yes | `{ "fetchedAt": 1764000000000, "cached": false, "accounts": [ … ], "errors": [ … ] }` |
| `POST /v1/unpair` | yes | `{ "ok": true }` |

Each account looks like this. `balance` is signed as the bank reports it, and `balanceDate` is
in milliseconds since 1970, or `null`.

```json
{ "id": "ACT-…", "name": "Discover it Card", "org": "Discover", "balance": -3512.1, "available": null, "balanceDate": 1795564800000, "currency": "USD" }
```

## Project layout

| Path | What's there |
|---|---|
| `src/cli.mjs` | The `setup`, `serve`, `status` and `forget` commands, and the HTTP server |
| `src/lib.mjs` | SimpleFIN requests, config storage, pairing and request checks |
| `test/server.test.mjs` | Tests, including a running server against a fake SimpleFIN |

## License

Copyright © 2026 Charles R. Clark. All rights reserved.
