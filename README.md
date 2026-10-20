# dsh-ws-deflate

**English** | [简体中文](./README.zh-CN.md)

Turns on `permessage-deflate` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web's WebSocket transport, **without modifying the DSH installation**. Measured on one machine: a session transcript that left the server as **1,206,822 B went out as 350,599 B — 70.9 % fewer wire bytes**.

It is a **runtime monkey-patch, not a supported extension point.** Read "Should I install this" before installing it.

## Should I install this?

**Install it if** you open `dsh web` from somewhere that is not your own machine — a Tailscale/VPN link, a reverse proxy over the internet, any path with real latency or packet loss. DSH replays the whole session transcript over `/api/remote.mux` on every reconnect, so on a lossy link those bytes are paid repeatedly.

**Do not install it if** you only ever use `dsh web` on `localhost` or a LAN. The saving is real but you don't need it there, and what you'd be taking on in exchange is a patch against another project's internals that can go quietly stale on every upgrade.

What it costs, measured on a Windows 10 / node v24 box: **+10 ms** to `dsh` startup (alternating 4-run measurement), and zlib level 6 at **42.7 ms per 1.53 MB** of transcript. The compression is per-message above a 1 KiB threshold, so small events are untouched.

## What it actually changes

Nothing on disk. `ws@8.22.0`, `@deepseek-ai/dsh-api-gateway`, and `@deepseek-ai/dsh/lib` were compared file-by-file (sha256) against the pristine registry tarballs: **63 files, 0 mismatches, 0 extra, 0 missing**, and 0 files in the install tree written or created that day.

What it does change is one method, in memory, in the `dsh` process:

```
BEFORE  WebSocketServer.prototype.handleUpgrade = handleUpgrade(req, socket, head, cb) {   ← ws's own
AFTER   WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) { try {  ← the wrapper
disk sha256 of ws/lib/websocket-server.js: 6d8dd89a841748c8 -> 6d8dd89a841748c8            ← unchanged
```

The wrapper sets `this.options.perMessageDeflate` at **handshake** time, which works because ws 8.x reads that option inside `handleUpgrade` (`websocket-server.js:299`/`:303`), not at construction — so it reaches the gateway's already-built `new WebSocketServer({ noServer: true })` (`dsh-api-gateway/lib/index.js:179`). It only opts in when nothing else set the option, so **if DSH enables compression itself upstream, this plugin steps aside automatically.**

Why the option can't just be configured: DSH exposes no key for it. The webserver's `compression` is HTTP gzip and does not cover streams.

## Install

```bash
dsh plugin --profile web add dsh-ws-deflate
```

Then restart `dsh web`. The bundle list is read at startup, so no restart means no effect.

## Verify

```bash
grep 'dsh-ws-deflate' <wherever your dsh web logs>
```

You want three things:

```
[dsh-ws-deflate] permessage-deflate enabled -> …/node_modules/ws [ws 8.22.0] via path (level 6, threshold 1024 B, noContextTakeover on)
[dsh-ws-deflate] self test OK: this process negotiates permessage-deflate
[dsh-ws-deflate] negotiated permessage-deflate with Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …
```

The **self test** is the interesting one. DSH's browser auth rejects non-browser handshakes, so you cannot probe a live server from a script — the plugin instead builds its own `new WebSocketServer({ noServer: true })` on an ephemeral loopback port and does a real handshake against it. That proves *this process, with this ws copy, negotiates*, which is the claim no external probe can reach. The `negotiated …` lines then log the first few real browser handshakes (user agent truncated, `maxLog` caps it at 5, `0` disables).

Browser side, if you want it: DevTools → Network → the `remote.mux` request → Response Headers should contain `Sec-WebSocket-Extensions: permessage-deflate; …`.

## Uninstall

```bash
dsh plugin --profile web remove dsh-ws-deflate
```

Restart. Nothing needs restoring, because nothing on disk was ever different.

## Configuration

The entry **registers itself**. The bundle manifest points `dsh.bundle.patch` at the `cordis.patch.yml` shipped inside this package, and DSH inserts the entry while it composes the profile tree — your own `cordis.patch.yml` never has to mention it. Proof, on this machine, from DSH itself:

```bash
dsh --profile web --dump-config | grep -B1 -A9 'id: ws-deflate'
# # == dsh-ws-deflate          <- its own layer, named after the bundle
# - id: ws-deflate
#   name: dsh-ws-deflate
#   config:
#     level: 6 ...
```

Override it only when you want non-default values, and use a **field-replacing patch, not an insert**:

```yaml
# your profile's cordis.patch.yml
- id: ws-deflate
  name: dsh-ws-deflate      # asserts the existing name; not a rename
  config:
    level: 1
    thresholdBytes: 512
    noContextTakeover: true
    concurrencyLimit: 10
    selfTest: true
    maxLog: 5
```

Two rules, both verified with `--dump-config` rather than taken on faith:

- **`insert` appends; it does not dedupe by id.** Copying the shipped patch into your profile file leaves **two** `- id: ws-deflate` entries in the tree — `level: 6` and `level: 1` both show up — so the override silently does nothing, or runs twice. Measured: entry count goes 1 -> 2.
- **`config` is replaced wholesale, not deep-merged.** Any key you omit falls back to this plugin's schema defaults, not to the bundle patch's values. So list every key you intend to keep.

| key | default | notes |
|---|---:|---|
| `enabled` | `true` | `false` keeps the wrapper installed but opts no handshake in |
| `level` | `6` | measured here: level 6 → ratio 0.176, level 1 → 0.238 on the same payload, at 42.7 ms vs 5.9 ms per 1.53 MB |
| `thresholdBytes` | `1024` | below this, frames go out raw (the median DSH event is ~800 B) |
| `noContextTakeover` | `true` | independent deflate stream per frame: bounded memory, and a dropped frame cannot corrupt later messages. Costs ratio, buys robustness on a lossy link — which is the whole reason to run this plugin |
| `concurrencyLimit` | `10` | cap on simultaneous compress operations |
| `selfTest` | `true` | run the loopback handshake at activation. Not hot-reloadable |
| `maxLog` | `5` | how many successful negotiations to log; `0` is silent |

Everything except `selfTest` is `.volatile()`, so editing the patch and letting the profile hot-reload re-applies it without a restart.

## How it finds the gateway's `ws` copy

A plugin cannot `import 'ws'` and get the gateway's copy. The profile is a pnpm tree that contains no `ws` at all; declaring it as a dependency installs a **second** copy — a different class object, and patching it does nothing. Three routes, tried in this order, all tested:

1. **Ask the process.** The gateway's `ws` is in the CommonJS module cache; the class found there is provably the one the gateway uses (`cached === path-required: true`). Match on `ws/lib/websocket-server.js`, **not** `ws/index.js` — ws routes `import` to `wrapper.mjs`, which goes straight at the lib file, so `index.js` never enters the cache in an ESM host. Note `lib/websocket-server.js` does `module.exports = WebSocketServer`, so the export *is* the class.
2. **Guess the path.** Honours `$DSH_HOME` (precedence: configured path > `$DSH_HOME` > `~/.dsh`) and checks `<home>/profiles/node_modules/ws`, which dsh itself creates as a junction into the install tree — the most portable entry. Plus npm-global prefixes for Windows (`%APPDATA%\npm`), Linux (`/usr/local`, `/usr/lib`) and both macOS locations (`/usr/local`, `/opt/homebrew`).
3. **Retry for ~2 s.** If neither finds anything, retry every 250 ms (unref'd, so it can never hold the process open). This is what covers an install whose prefix is not in the list: by the time the gateway has loaded, route 1 works. Tested by neutralising every candidate (`DSH_HOME` + `APPDATA` + `argv[1]` pointed at empty dirs), activating — nothing patched — then loading the gateway late: `located ws on deferred attempt 2 … via require.cache`, self test OK.

### One thing that will confuse you, on purpose

`import 'dsh-ws-deflate'` from a plain `node` script **fails** with `Cannot find package '@deepseek-ai/schemastery'`, even though the plugin loads fine inside `dsh`. That is not a bug to fix: dsh runs its own interception resolver (`dsh-app-boot/lib/index.js:1459` `scope === "installation"`, `:1479` `readPeerNames(...).has(name)`) and supplies declared peers from the installation tree. A fresh profile has no `schemastery` anywhere in it — verified on two platforms — and the plugin still activates. **So don't "verify" this plugin by importing it from a script; verify it by restarting `dsh web` and reading the log.**

## Tested on

| platform | node | dsh | ws | pnpm | result |
|---|---|---|---|---|---|
| Windows 10 | v24.20.0 | 0.2.0-rc.2 | 8.22.0 | 10.18.2 | live, 3 browser handshakes logged incl. macOS Safari |
| Linux | v22.19.0 | 0.2.0-rc.2 | 8.22.0 | 12.11.2 | clean-room: fresh profile from the shipped template, installed from a packed tarball, booted on :3099, self test OK |

Both were installed from a local tarball, not from the registry. One combination per platform — treat anything else as untested. The structural guard is `typeof WebSocketServer.prototype.handleUpgrade === 'function'`; if a future ws changes that, the plugin warns and stays off rather than breaking the handshake.

## Failure modes

- **No patchable `WebSocketServer`** → one warning line, plugin still activates, compression stays off. `dsh` is unaffected.
- **`apply()` throws** → warning only. Third-party plugin ids are not in `dsh-app-boot`'s hardcoded `requiredStartupEntryIds`, so a plugin **cannot** stop `dsh` from starting.
- **A future DSH sets `perMessageDeflate` itself** → its value wins, this plugin becomes a no-op. Delete it.
- **A DSH upgrade changes how the gateway builds its server** → the plugin may find nothing and warn. Check the three log lines after every upgrade.

## Exit condition

Upstream already wants this: [discussion #6950](https://github.com/deepseek-ai/deepseek-harness/discussions/6950) asks for "permessage-deflate on the session-stream WebSocket … compresses ~3–5×; no protocol change needed" (their measurement, 22.5 MB / 41,794 events; my ratio of 0.291 is 3.4×, consistent). **When DSH ships this, delete this plugin.** Until then it is an interim with a self-retiring behaviour, not a permanent fork of DSH's behaviour.

## Security note

`permessage-deflate` is a compression feature and compression features have a BREACH-family history. Here the protected secret and the attacker-controlled input are both inside your own session transcript, on a link you already trust to carry your token in a URL query string. If you are running `dsh web` as plaintext HTTP on a public host, **fix that first** — it is a much bigger hole than anything this plugin touches.

Not affiliated with or endorsed by DeepSeek. MIT.
