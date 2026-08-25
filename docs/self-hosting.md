# Self-hosting guide

Everything needed to run this system on your own server and phone number.

The result is a Hebrew IVR that answers a Twilio number, offers a DTMF menu,
looks a reference up in your system and reads the answer back — plus a
browser dashboard showing live and historical calls. Every part is
configurable; see [Making it yours](#making-it-yours).

---

## What you need

| | |
|---|---|
| **A server** | Ubuntu 24.04 LTS, 2 vCPU / 2 GB RAM, a **static public IP**. ~$12/month on any provider. |
| **A Twilio account** | With a phone number. Elastic SIP Trunking, *not* Programmable Voice — see below. |
| **A domain** | Optional. Only needed for the dashboard. |
| **Recordings** | Voice prompts in your language. The system is silent without them. |

> **Ubuntu 24.04 is a requirement, not a preference.** The release decides
> which Asterisk you get. 22.04 ships Asterisk 18, whose packaging leaves you
> without a usable ARI — and ARI is the only interface between Asterisk and
> this application. Bootstrap refuses to run on it and explains why.

---

## Install

```bash
ssh root@YOUR_SERVER_IP
apt update && apt install -y git
git clone https://github.com/27180781/IVR.git /opt/ivr
cd /opt/ivr
./scripts/bootstrap-server.sh
```

One command. It configures the firewall (SIP restricted to Twilio's networks),
installs Asterisk and Node, generates and synchronises the ARI password between
`.env` and `ari.conf`, deploys the Asterisk configuration, builds the
application, creates a service account and starts it under systemd.

It is safe to re-run: it never overwrites an existing `.env`.

Check it:

```bash
./scripts/verify-asterisk.sh
```

Everything should pass except **Sound files** — you have not recorded any yet.

---

## Twilio

The important distinction: **Elastic SIP Trunking**, not Programmable Voice.
They are separate products in the same console. Programmable Voice sends calls
to a webhook and expects TwiML back; this project doesn't want that. It wants
Twilio to act purely as a PSTN carrier and hand the raw SIP call to Asterisk.

1. **Elastic SIP Trunking → Trunks → Create new SIP Trunk**

2. **Origination → Add Origination URI:**
   ```
   sip:YOUR_SERVER_IP:5060;transport=udp
   ```
   Priority 10, Weight 10, Enabled.

3. **Attach the number.** Phone Numbers → your number → Voice Configuration →
   **Configure with: the trunk you created**.

   This step is the one people miss. While the number is set to a webhook,
   your Origination URI is never consulted and nothing reaches your server.

4. **Termination** is only needed for outbound calls. The configuration is
   ready for it but this project doesn't place calls.

Twilio identifies you by **IP address**, not a password, so your protection is
the `type=identify` block in `pjsip.conf` plus the firewall — both configured
by bootstrap. Twilio's published signalling ranges change; re-check them
occasionally, in `asterisk/pjsip.conf` and in `ufw`.

---

## Recordings

The system connects and runs correctly with no recordings — and the caller
hears nothing. This is the last step before going live.

```bash
npm run prompts:list
```

That prints every prompt, the exact filename it must be saved as, and the text
to read. Files go under the language directory:

```
/usr/share/asterisk/sounds/he/
├── ivr/       welcome.wav, main-menu.wav, ...
└── digits/    0.wav … 9.wav
```

> Asterisk resolves sounds under `astdatadir` — `/usr/share/asterisk` on Debian
> and Ubuntu — **not** `/var/lib/asterisk`, which many guides state. Both
> directories exist, so the mistake is silent: calls connect, the application
> reports success, and the caller hears nothing. Confirm with
> `grep astdatadir /etc/asterisk/asterisk.conf`.

Format matters: **8000 Hz, mono, 16-bit PCM**. Telephony samples at 8 kHz
regardless; a 44.1 kHz file just makes Asterisk transcode on every call.

```bash
ffmpeg -i source.mp3 -ar 8000 -ac 1 -c:a pcm_s16le welcome.wav
sudo chown -R asterisk:asterisk /usr/share/asterisk/sounds/he
```

**Digits are not optional if you read numbers back.** Reading a reference aloud
uses `digits/0.wav` … `9.wav` in your language. Asterisk ships sound packs for
English, Spanish, French, Italian and Russian only — for anything else you
record them yourself.

### Testing before you record

```bash
sudo ./scripts/make-placeholder-sounds.sh
```

Generates a distinct tone per prompt. Not a substitute for recordings, but it
turns the first test call into proof that audio actually reaches the caller —
which a silent call cannot tell you.

---

## The dashboard

```bash
sudo ./scripts/setup-web.sh dashboard.example.com
```

Create an **A record** for that name pointing at your server first; the script
verifies it and refuses otherwise, because Let's Encrypt validates by
connecting to that address.

Installs Caddy, obtains a certificate, opens 80/443, generates a password and
verifies the dashboard actually answers before reporting success.

If your DNS is behind Cloudflare's proxy (orange cloud), turn it off. With the
proxy on, certificate renewal breaks in 90 days — Caddy renews over port 80 or
TLS-ALPN on 443 and Cloudflare intercepts both — and the proxy may buffer the
live feed into delayed bursts.

Full detail: [`dashboard.md`](dashboard.md).

---

## Making it yours

### Change the language

1. Set `IVR_LANGUAGE` in `.env` (e.g. `en`, `ar`, `ru`).
2. Set the same value in `asterisk/asterisk.env` and run
   `sudo ./scripts/deploy-asterisk.sh`.
3. Put your recordings in `/usr/share/asterisk/sounds/<lang>/`.
4. Translate the `text` fields in `src/ivr/prompts.ts` — they are the recording
   script, not runtime strings.

Asterisk resolves `sound:ivr/welcome` through the channel's language, so adding
a language is a parallel directory, not a code change.

### Change the menu

`src/ivr/flows/main.ts` is the whole call flow, declared as data:

```ts
mainMenu: {
  id: 'mainMenu',
  type: 'menu',
  speech: [say('mainMenu')],
  choices: {
    '1': 'askReference',
    '2': 'officeHours',
    '9': 'mainMenu',
  },
  onInvalid: [say('invalidChoice')],
  maxAttempts: 3,
  onExhausted: 'tooManyRetries',
},
```

Adding an option is adding a key to `choices` and a state for it. Transitions
are validated at startup, so a target that doesn't exist is a boot failure
rather than dead air on a live call.

Five state types: `play`, `menu`, `collect`, `action`, `hangup`. If a change is
hard to express here, the missing piece belongs in `src/ivr/engine.ts` — not in
`extensions.conf`.

### Connect it to your system

Out of the box `DATA_SOURCE=mock` serves five fixtures (`100001`–`100005`).
For a real backend:

```bash
DATA_SOURCE=http
DATA_HTTP_URL=https://api.your-system.com/v1
DATA_HTTP_TOKEN=your-token
DATA_HTTP_TIMEOUT_MS=3000
```

The expected contract:

```
GET  {DATA_HTTP_URL}/orders/{reference}
     Authorization: Bearer {DATA_HTTP_TOKEN}
     Accept: application/json
```

| Response | The caller hears |
|---|---|
| `200 {"status":"shipped"}` | the status read back |
| `404` | "not found" |
| anything else, or a timeout | "there was a problem" |

`status` must be one of `new`, `processing`, `shipped`, `delivered`,
`cancelled`. Anything else is treated as an error — deliberately: a caller
hearing "there was a problem" is better served than one hearing silence.

**If your API looks different**, change one function —
`HttpDataSource.lookupOrder` in `src/services/data.ts`, about 30 lines. Nothing
else in the system knows where answers come from.

The 3-second timeout protects the caller, not the server. A backend that hangs
would otherwise leave someone listening to silence with no way out.

### Rename things

The application name (`ARI_APP`, default `ivr-app`) appears in `.env` and in
`asterisk/extensions.conf`. Change both together.

---

## Updating

```bash
cd /opt/ivr && sudo ./scripts/deploy.sh
```

This is not `git pull && restart`. Restarting mid-call cuts the caller off, so
the deploy:

1. **Builds before stopping anything** — a broken build leaves the old process
   answering calls.
2. **Drains calls in progress** — new calls are handed back to the dialplan,
   which plays "system unavailable"; calls already up run to their natural end.
   A deploy during busy hours can take a minute or two. That is the correct
   trade.
3. **Verifies the app re-registered with Asterisk** — a process that starts but
   never registers looks perfectly healthy to systemd and answers nothing.
4. **Rolls back** if it didn't. Last week's code beats a line that doesn't
   answer.

### Automatic deploys

`.github/workflows/deploy.yml` deploys on push. It builds in CI first, so a
broken commit never reaches the machine answering the phone. Four repository
secrets:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server IP |
| `DEPLOY_USER` | a dedicated deploy user, not root |
| `DEPLOY_SSH_KEY` | that user's private key |
| `DEPLOY_PATH` | `/opt/ivr` |

Without them the job skips cleanly rather than failing. Set up the restricted
deploy user as described in [`deployment.md`](deployment.md) — its sudo is
scoped to the single deploy script.

---

## Troubleshooting

Every entry below is a failure hit while building this, not a hypothetical.
The common thread: each one produced symptoms pointing somewhere other than
the cause.

### Calls rejected with "extension not found in context 'public'"

```
chan_sip.c: Call from '' (54.244.51.1:5060) to extension '+1...'
            rejected because extension not found in context 'public'
```

`chan_sip.c`, not `res_pjsip`. Debian and Ubuntu autoload the deprecated
chan_sip module, which takes UDP 5060 — the port res_pjsip wants — and its
packaged `sip.conf` defaults to `context=public`. Every setting in
`pjsip.conf` is correct and none of it is consulted.

The repo ships a `modules.conf` that prevents this. If you hit it:

```bash
sudo ./scripts/deploy-asterisk.sh && sudo systemctl restart asterisk
```

### The application won't connect to ARI

```bash
sudo asterisk -rx 'module show like res_ari'   # Running?
sudo asterisk -rx 'http show status'           # Server Enabled?
sudo asterisk -rx 'ari show apps'              # is ivr-app listed?
```

Three independent things fail here and look identical from outside:

- **`ari.conf` unreadable.** Asterisk drops to the `asterisk` user; config
  owned `root:root` mode 640 can't be read, and every ARI module declines to
  load. `ari show apps` then reports "No such command", which reads like a
  broken Asterisk. Want `root:asterisk 640`.
- **HTTP server disabled.** ARI runs over Asterisk's built-in HTTP server, and
  the packaged default is `enabled=no`. `ari show status` cheerfully reports
  `Enabled: Yes` while there is nothing to connect to. These are two separate
  switches.
- **Wrong ARI password.** `ARI_PASSWORD` in `.env` must equal the password for
  that user in `/etc/asterisk/ari.conf`. The app now reports this clearly and
  keeps retrying instead of crash-looping.

### The call connects but there is no sound

Sound files in the wrong directory — see [Recordings](#recordings). The
application logs `playback did not complete` for each missing file, and
`verify-asterisk.sh` counts what is actually present.

### The call connects and there is no audio at all, in either direction

RTP, not SIP. Check `external_media_address` in `/etc/asterisk/pjsip.conf`
matches your real public IP, and that UDP 10000-20000 is open — **including in
your cloud provider's firewall**, which applies before the machine's own.

### Digits go missing when typing quickly

Fixed, but worth understanding: DTMF is buffered for the life of the channel
so keys pressed between prompts still count. If you write a new gather path,
consume from that buffer rather than attaching a fresh listener.

### `git pull` fails with "detected dubious ownership"

The checkout is owned by another user. Code should be owned by `root`, with
only `data/` owned by the service account — the process answering calls has no
business rewriting its own code. `deploy.sh` repairs this automatically.

---

## How it fits together

```
Caller ──PSTN──► Twilio SIP Trunk ──SIP/RTP──► Asterisk ──ARI──► This app ──HTTPS──► Your system
```

Asterisk handles telephony and audio and makes no decisions — the dialplan is
one line handing every call to `Stasis()`. All logic lives in TypeScript.

**The application runs on the same server as Asterisk** and connects over
`127.0.0.1`. ARI can originate outbound calls, so exposing it to the internet
with only a password is a phone account open to the world. It is also
latency-sensitive: every prompt is a round trip.

Audio never passes through the application. RTP flows between Twilio and
Asterisk; the app sends strings like `sound:ivr/welcome`. That is why it stays
light, and why the language it is written in barely matters for throughput.

Full detail: [`architecture.md`](architecture.md).

---

## Running costs

| | |
|---|---|
| Server | ~$12/month |
| Twilio number | ~$1/month |
| Inbound minutes | fractions of a cent per minute, varies by country |
| Certificates | free |

The bulk is the server, and a 2 GB instance handles far more concurrent calls
than most deployments will see.

---

## Security checklist

- [ ] SSH key authentication, password login disabled
- [ ] SIP restricted to Twilio's ranges (bootstrap does this — re-check the
      ranges periodically)
- [ ] ARI on loopback only, never exposed
- [ ] Dashboard behind HTTPS with a strong password — it lists callers' phone
      numbers
- [ ] `.env` and `asterisk/asterisk.env` never committed (both gitignored)
- [ ] `fail2ban` with the Asterisk jail

An open SIP port is scanned within hours, and international dialling fraud is
billed to you.
