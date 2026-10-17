/**
 * dsh-ws-deflate -- enable permessage-deflate on DSH's WebSocket transport
 * without touching the DSH install tree.
 *
 * WHY
 *   DSH sends the whole session transcript over /api/remote.mux UNCOMPRESSED.
 *   The gateway builds its server as `new WebSocketServer({ noServer: true })`
 *   (@deepseek-ai/dsh-api-gateway/lib/index.js) and never passes
 *   perMessageDeflate, while ws defaults that to false. DSH exposes no config
 *   key for it -- the webserver's `compression` is an HTTP gzip middleware that
 *   does not cover streams. So the only lever left is the ws layer.
 *
 * HOW A PROTOTYPE PATCH IS ENOUGH
 *   ws 8.x reads `this.options.perMessageDeflate` inside
 *   WebSocketServer.prototype.handleUpgrade, i.e. at EVERY handshake, not at
 *   construction. Wrapping the prototype method therefore reaches the
 *   already-constructed gateway instance, whenever it was built.
 *
 * HOW THE GATEWAY'S OWN ws COPY IS LOCATED (the part that is not clean)
 *   A plugin cannot `import 'ws'` and get the gateway's copy: the profile is a
 *   pnpm tree that contains no ws at all, so declaring ws as a dependency would
 *   install a SECOND copy -- a different class object, and patching it would do
 *   nothing. Declaring it as a peer does not resolve either (the host does not
 *   provide a bare 'ws'). Two routes remain:
 *     1. ask the process -- the gateway is imported during profile composition,
 *        before plugins activate, so its ws is already in the CommonJS module
 *        cache; the class found there is provably the one the gateway uses, in
 *        any install layout (npm global, pnpm, yarn, nvm, /opt/homebrew).
 *        Match `websocket-server.js`, not `ws/index.js`: ws routes `import` to
 *        wrapper.mjs, which requires lib/websocket-server.js directly.
 *     2. guess the path -- kept as a fallback for the case where the gateway is
 *        loaded lazily, plus a short deferred retry for the same reason.
 *   Route 1 is preferred and route 2 is the honest admission that this is a
 *   monkey-patch of a third party's internals, not a supported extension point.
 *
 * SAFETY
 *   Nothing here can stop DSH from starting. Third-party plugin ids are not in
 *   dsh-app-boot's hardcoded requiredStartupEntryIds, so a failed activation is
 *   a warning, not a startup failure. On top of that: every path is wrapped, a
 *   missing ws just logs and returns, and the optional self-test binds an
 *   ephemeral loopback port and tears it down.
 *
 * EXIT CONDITION
 *   If DSH ever ships a gateway option for perMessageDeflate (or enables it by
 *   default), remove this plugin. Re-run the baseline handshake test on every
 *   DSH upgrade to find out.
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name and profile entry id. */
export const name = 'ws-deflate'

const require = createRequire(import.meta.url)

/** Schema defaults; the profile patch is authoritative. */
export const Config = z.object({
  /** Master switch. Turning it off stops the wrapper from opting any handshake in. */
  enabled: z.boolean().default(true).volatile(),
  /** zlib level for frames above the threshold. 6 matches what was measured. */
  level: z.number().step(1).min(0).max(9).default(6).volatile(),
  /** Frames below this many bytes go out raw (the median DSH event is ~800 B). */
  thresholdBytes: z.natural().default(1024).volatile(),
  /**
   * Independent deflate stream per frame: bounded memory per connection and a
   * dropped frame cannot corrupt later messages. Costs some ratio, buys
   * robustness on a lossy relay link.
   */
  noContextTakeover: z.boolean().default(true).volatile(),
  /** Cap on simultaneous compress operations. */
  concurrencyLimit: z.number().step(1).min(1).max(64).default(10).volatile(),
  /** Prove the patch works inside this process, on a private loopback server. */
  selfTest: z.boolean().default(true),
  /** How many successful negotiations to log (0 disables the per-connection log). */
  maxLog: z.number().step(1).min(0).max(100).default(5).volatile(),
})

/** Live options object handed to every handshake; mutated in place on re-activation. */
const deflateOptions = {
  level: 6,
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 10,
}

/** Mutable runtime state shared with the installed wrapper. */
const state = {
  enabled: true,
  maxLog: 0,
  logged: 0,
  patched: [],
  selfTestOk: null,
  log: () => {},
}

const PATCHED_FLAG = '__dshWsDeflatePatched'

/** Candidate locations of the ws copy DSH actually resolves. */
function candidateDirs() {
  const out = []
  const argv1 = String(process.argv[1] || '')
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }

  if (process.env.DSH_WS_DIR) push(process.env.DSH_WS_DIR)

  // .../@deepseek-ai/dsh/lib/bin.js -> .../@deepseek-ai/dsh/node_modules/ws
  if (argv1) {
    const pkgDir = dirname(dirname(argv1))
    push(join(pkgDir, 'node_modules', 'ws'))
    push(join(dirname(pkgDir), 'ws'))
  }

  // DSH's own home, honouring the documented precedence (configured path >
  // $DSH_HOME > ~/.dsh). dsh mirrors the installation's dependencies under
  // <home>/profiles/node_modules -- on this box profiles\node_modules\ws is a
  // junction straight into the install tree -- so this is the most portable
  // entry here and the one that survives an unusual global prefix.
  const home = homedir()
  const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(home, '.dsh')
  push(join(dshHome, 'profiles', 'node_modules', 'ws'))
  push(join(dshHome, 'profiles', 'web', 'node_modules', 'ws'))

  const appdata = process.env.APPDATA || ''
  if (appdata) {
    push(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'ws'))
    push(join(appdata, 'npm', 'node_modules', 'ws'))
  }
  // npm global prefixes on Linux and both macOS install locations. Missing
  // paths are skipped, so listing several costs nothing.
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/ws')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/ws')
  push('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/ws')
  push('/usr/local/lib/node_modules/ws')
  push('/opt/homebrew/lib/node_modules/ws')
  return out
}

/**
 * Depth-limited sweep for odd (pnpm-style) layouts. Only runs when none of the
 * explicit paths resolved, because walking a few hundred package directories
 * costs real milliseconds at startup.
 */
function sweepDirs(root, maxDepth, acc) {
  if (maxDepth < 0) return
  const direct = join(root, 'ws', 'package.json')
  try { if (existsSync(direct)) acc.push(dirname(direct)) } catch { /* ignore */ }
  const nm = join(root, 'node_modules')
  let entries = []
  try { entries = readdirSync(nm, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (e.name === '.bin' || e.name === '.cache') continue
    if (e.name === '.pnpm' && maxDepth > 0) {
      // pnpm keeps packages under .pnpm/<name>@<ver>/node_modules/<name>
      let inner = []
      try { inner = readdirSync(join(nm, '.pnpm'), { withFileTypes: true }) } catch { continue }
      for (const p of inner) {
        if (!p.isDirectory() || !p.name.startsWith('ws@')) continue
        const cand = join(nm, '.pnpm', p.name, 'node_modules', 'ws')
        try { if (existsSync(join(cand, 'package.json'))) acc.push(cand) } catch { /* ignore */ }
      }
      continue
    }
    sweepDirs(join(nm, e.name), maxDepth - 1, acc)
  }
}

/**
 * Patch one WebSocketServer class in place. `wsDir` is only used to report the
 * version. Returns the version, 'already', or null when this is not patchable.
 */
function patchClass(WebSocketServer, wsDir) {
  let proto = null
  try { proto = WebSocketServer && WebSocketServer.prototype } catch { return null }
  if (!proto || typeof proto.handleUpgrade !== 'function') return null
  if (proto[PATCHED_FLAG]) return 'already'

  const original = proto.handleUpgrade

  proto.handleUpgrade = function (req, socket, head, cb) {
    try {
      const opts = this.options
      // Only opt in; if a future DSH sets this itself, its value wins.
      if (state.enabled && opts && !opts.perMessageDeflate) opts.perMessageDeflate = deflateOptions
    } catch { /* keep the original behaviour */ }
    if (typeof cb !== 'function') return original.call(this, req, socket, head, cb)
    const wrapped = function (ws, request) {
      try {
        // WebSocket#extensions is a GETTER returning
        // Object.keys(this._extensions).join() -- a comma-joined STRING of
        // extension names, not an object. Indexing it by name is always
        // undefined. (websocket-server.js only assigns _extensions when
        // permessage-deflate was actually accepted, so '' means "not offered".)
        const names = String((ws && ws.extensions) || '')
        if (state.logged < state.maxLog && names.split(',').includes('permessage-deflate')) {
          state.logged++
          state.log('negotiated permessage-deflate with '
            + String((request && request.headers && request.headers['user-agent']) || 'client').slice(0, 80))
        }
      } catch { /* never break a connection over a log line */ }
      return cb.apply(this, arguments)
    }
    return original.call(this, req, socket, head, wrapped)
  }

  Object.defineProperty(proto, PATCHED_FLAG, { value: wsDir || 'require.cache', enumerable: false })
  try { return require(join(wsDir, 'package.json')).version } catch { return 'unknown' }
}

/**
 * Preferred route: ask THIS PROCESS which ws copy it already loaded.
 *
 * The gateway is imported during profile composition, before any plugin is
 * activated, so by the time apply() runs its ws dependency is in the CommonJS
 * module cache -- and the object found there is provably the one the gateway
 * will construct servers from, whatever the install layout turns out to be
 * (npm global, pnpm, yarn, nvm, /opt/homebrew, a vendored copy). Measured on
 * this box: after importing the gateway, 13 cache entries live inside ws.
 *
 * Match on `websocket-server.js`, NOT `ws/index.js`: ws routes `import` to
 * wrapper.mjs, which requires ./lib/websocket-server.js directly, so index.js
 * never enters the cache in an ESM host.
 */
function patchFromCache() {
  const hits = []
  let keys = []
  try { keys = Object.keys(require.cache) } catch { return hits }
  for (const key of keys) {
    if (!/[\\/]websocket-server\.js$/.test(key)) continue
    let cls = null
    try {
      const exports = require.cache[key] && require.cache[key].exports
      // ws's lib/websocket-server.js ends with `module.exports = WebSocketServer`
      // -- the export IS the class, so `.Server` / `.WebSocketServer` are both
      // undefined there. They exist on ws/index.js, which an ESM host never
      // loads (wrapper.mjs goes straight at the lib file). Accept both shapes,
      // plus the transpiled `.default` form.
      cls = (typeof exports === 'function' && exports)
        || (exports && (exports.Server || exports.WebSocketServer))
        || (exports && exports.default && (typeof exports.default === 'function'
          ? exports.default
          : (exports.default.Server || exports.default.WebSocketServer)))
        || null
    } catch { continue }
    let wsDir = null
    try { wsDir = dirname(dirname(realpathSync(key))) } catch { wsDir = dirname(dirname(key)) }
    let version = null
    try { version = patchClass(cls, wsDir) } catch { continue }
    if (version) hits.push({ dir: wsDir, version: version === 'already' ? 'already' : version, via: 'require.cache' })
  }
  return hits
}

/** Fallback route: require a candidate directory and patch whatever it exports. */
function patchDirs(list) {
  const hits = []
  const seen = new Set()
  for (const dir of list) {
    let real = dir
    try { real = realpathSync(dir) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    let mod = null
    try { mod = require(real) } catch { continue }
    let version = null
    try { version = patchClass(mod && (mod.Server || mod.WebSocketServer), real) } catch { continue }
    if (version) hits.push({ dir: real, version, via: 'path' })
  }
  return hits
}

/** Find and patch every reachable ws copy. Idempotent across re-activations. */
function installPatch(logger) {
  let hits = []
  try { hits = patchFromCache() } catch { hits = [] }
  if (!hits.length) {
    try { hits = patchDirs(candidateDirs()) } catch { hits = [] }
  }
  if (!hits.length) {
    const argv1 = String(process.argv[1] || '')
    if (argv1) {
      const found = []
      try { sweepDirs(dirname(dirname(argv1)), 2, found) } catch { /* ignore */ }
      try { hits = patchDirs(found) } catch { hits = [] }
    }
  }
  for (const h of hits) {
    if (!state.patched.some((p) => p.dir === h.dir)) state.patched.push(h)
  }
  if (!state.patched.length) return false
  return true
}

/**
 * Prove the patch works in THIS process, on a private loopback server built
 * exactly like the gateway's. This is the check that neither the .bashrc nor the
 * NODE_OPTIONS route could do against the live service (its browser auth blocks
 * a non-browser handshake) -- here the server is ours, so no auth is involved.
 */
async function runSelfTest(logger) {
  const target = state.patched.find((p) => p.version !== 'already') || state.patched[0]
  if (!target) return false
  let mod
  try { mod = require(target.dir) } catch { return false }
  const WebSocketServer = mod.Server || mod.WebSocketServer
  const WebSocket = mod.WebSocket || mod

  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  let serverSawExtension = false
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      serverSawExtension = String(ws.extensions || '').split(',').includes('permessage-deflate')
      ws.on('message', (data) => { try { ws.send(data) } catch { /* ignore */ } })
    })
  })
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => resolveListen())
    })
    const port = server.address().port
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws-deflate-self-test`, { perMessageDeflate: true })
    const ok = await new Promise((resolveTest) => {
      const done = (value) => { clearTimeout(timer); resolveTest(value) }
      const timer = setTimeout(() => done(false), 5000)
      client.on('error', () => done(false))
      client.on('open', () => {
        try { client.send('dsh-ws-deflate-self-test '.repeat(256)) } catch { done(false) }
      })
      client.on('message', () => {
        done(String(client.extensions || '').split(',').includes('permessage-deflate') && serverSawExtension)
      })
    })
    try { client.terminate ? client.terminate() : client.close() } catch { /* ignore */ }
    return ok
  } catch (error) {
    logger.debug?.(`[dsh-ws-deflate] self test errored: ${String(error)}`)
    return false
  } finally {
    try { server.closeAllConnections?.() } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
    try { server.close() } catch { /* ignore */ }
  }
}

/** Apply resolved config to the shared live objects. */
function syncConfig(resolved) {
  state.enabled = resolved.enabled
  state.maxLog = resolved.maxLog
  deflateOptions.level = resolved.level
  deflateOptions.threshold = resolved.thresholdBytes
  deflateOptions.concurrencyLimit = resolved.concurrencyLimit
  deflateOptions.serverNoContextTakeover = resolved.noContextTakeover
  deflateOptions.clientNoContextTakeover = resolved.noContextTakeover
}

/** Activate the plugin. Never throws: a failure here must only warn. */
export function apply(ctx, config) {
  // DSH's default log level swallows logger.info, and the launcher only
  // captures stdout/stderr -- so write through console like the other profile
  // plugins do (dsh-cost-meter, auto-continue) and mirror into ctx.logger for
  // whoever reads the harness log instead. Without this the plugin is silent
  // even when it is working, which is indistinguishable from "never loaded".
  let scoped = null
  try { scoped = ctx.logger?.(name) ?? ctx.logger } catch { scoped = null }
  const emit = (level, text) => {
    try { console.log(text) } catch { /* ignore */ }
    try { scoped?.[level]?.(text) } catch { /* ignore */ }
  }
  const logger = {
    info: (text) => emit('info', text),
    warn: (text) => emit('warn', text),
    debug: () => {},
  }
  state.log = (text) => emit('info', text)

  const resolved = {
    enabled: config?.enabled !== false,
    level: Number.isFinite(config?.level) ? config.level : 6,
    thresholdBytes: Number.isFinite(config?.thresholdBytes) ? config.thresholdBytes : 1024,
    noContextTakeover: config?.noContextTakeover !== false,
    concurrencyLimit: Number.isFinite(config?.concurrencyLimit) ? config.concurrencyLimit : 10,
    selfTest: config?.selfTest !== false,
    maxLog: Number.isFinite(config?.maxLog) ? config.maxLog : 5,
  }
  syncConfig(resolved)

  const report = () => {
    logger.info(`[dsh-ws-deflate] permessage-deflate ${resolved.enabled ? 'enabled' : 'armed but disabled by config'} -> `
      + state.patched.map((p) => `${p.dir} [ws ${p.version}] via ${p.via}`).join(', ')
      + ` (level ${resolved.level}, threshold ${resolved.thresholdBytes} B, `
      + `noContextTakeover ${resolved.noContextTakeover ? 'on' : 'off'})`)
    if (!resolved.selfTest) return
    // Deliberately not awaited: a stuck self test must never hold up activation.
    runSelfTest(logger).then((ok) => {
      state.selfTestOk = ok
      if (ok) logger.info('[dsh-ws-deflate] self test OK: this process negotiates permessage-deflate')
      else logger.warn('[dsh-ws-deflate] self test did not confirm negotiation -- check the ws version')
    }, (error) => {
      state.selfTestOk = false
      logger.warn(`[dsh-ws-deflate] self test threw: ${String(error)}`)
    })
  }

  let patched = false
  try {
    patched = installPatch(logger)
  } catch (error) {
    logger.warn(`[dsh-ws-deflate] patching failed, leaving compression off: ${String(error)}`)
  }
  if (patched) return report()

  // Nothing found yet. The likely reason is ordering: if a future DSH loads the
  // gateway lazily, ws is not in the module cache at activation time. Retry off
  // the activation path for ~2 s instead of warning once and staying off for the
  // whole process lifetime. unref() so a pending timer can never keep the host
  // process alive.
  let tries = 0
  const timer = setInterval(() => {
    tries++
    let ok = false
    try { ok = installPatch(logger) } catch { ok = false }
    if (!ok && tries < 8) return
    clearInterval(timer)
    if (ok) {
      logger.info(`[dsh-ws-deflate] located ws on deferred attempt ${tries}`)
      report()
    } else {
      logger.warn('[dsh-ws-deflate] no patchable WebSocketServer found; compression stays off')
    }
  }, 250)
  if (typeof timer.unref === 'function') timer.unref()
}

/** Read-only view for diagnostics and future UI. */
export function status() {
  return {
    enabled: state.enabled,
    patched: state.patched.slice(),
    selfTestOk: state.selfTestOk,
    options: { ...deflateOptions },
  }
}
