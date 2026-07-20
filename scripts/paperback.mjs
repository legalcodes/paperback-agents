#!/usr/bin/env node
// paperback CLI (plugin-vendored, render-only) — open markdown in Paperback.
//
// Vendored from the Paperback repo's bin/paperback.mjs with the GitHub-issue
// path removed (no gh dependency) and no repo-path assumptions. Render-only
// by design: this script never uploads content and never creates share links.
//
// On macOS with the Paperback app installed (detected via `open -Ra Paperback`),
// files open directly in the app: `open -a Paperback <files>`, one tab per
// file in the reader window, re-open focuses the existing tab. Everywhere
// else (or with --web), documents travel as handoff URLs to paperback.sh:
//   https://paperback.sh/#d=<base64url(deflate-raw(utf8 markdown))>
// The payload rides in the URL FRAGMENT, which browsers never send to the
// server: the document stays client-side.
//
// stdin content has no file on disk, so on the app path it is written to
// ~/.paperback/handoff/<slug>-<hash>.md first (the app reads from disk at
// open and re-reads on focus, so the file must persist). Handoff files older
// than 7 days are cleaned up opportunistically.
//
// Usage:
//   paperback a.md b.md                        # app if installed, else browser
//   cat doc.md | paperback                     # open stdin
//   paperback --app doc.md                     # require the Mac app (error if absent)
//   paperback --web doc.md                     # force the paperback.sh handoff URL
//   paperback --url-only doc.md                # print the URL instead of opening
//   paperback --base http://localhost:5180 doc.md   # target a dev server
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const MAX_PAYLOAD_CHARS = 1_000_000
const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const HELP = `paperback — open markdown in Paperback (render-only)

Usage:
  paperback a.md b.md                open files (Mac app if installed, else paperback.sh)
  cat doc.md | paperback             open stdin

Routing:
  --app        require the Mac app; error if it isn't installed
  --web        force the paperback.sh handoff URL in the browser
  --url-only   print the handoff URL instead of opening (implies --web)
  --base URL   target another web origin, e.g. http://localhost:5180 (implies --web)
  -h, --help   show this help

Notes:
  On macOS with the Paperback app installed, files open in the app: one
  tab per file, and re-opening a file focuses its existing tab.
  stdin content is written to ~/.paperback/handoff/<name>-<hash>.md
  so the app can read it from disk (and re-read it on focus). Handoff files
  older than 7 days are cleaned up automatically.
  Without the app (or off macOS), documents travel as compressed handoff
  URLs; the payload stays in the fragment and never reaches the server.
  This script never uploads content and never creates share links.
`

export function encode(markdown) {
  return Buffer.from(deflateRawSync(Buffer.from(markdown, 'utf8'))).toString('base64url')
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.txt', '.mdx'])

/** Expand a leading ~ (quoted paths skip shell expansion). */
export function expandPath(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** Validate a path for reading: returns {ok, path} or {ok:false, error}. */
export function checkReadablePath(raw) {
  const p = expandPath(raw)
  if (!existsSync(p)) return { ok: false, error: `no such file: ${raw}` }
  const st = statSync(p)
  if (st.isDirectory()) return { ok: false, error: `${raw} is a directory, not a file` }
  if (!st.isFile()) return { ok: false, error: `${raw} is not a regular file` }
  return { ok: true, path: p, warnExt: !MARKDOWN_EXTS.has(extname(p).toLowerCase()) }
}

/** Parse CLI argv (no program/script prefix). Returns flags + files, or an error string. */
export function parseCliArgs(argv) {
  const out = {
    help: false,
    web: false,
    app: false,
    urlOnly: false,
    base: 'https://paperback.sh',
    hasBase: false,
    files: [],
    error: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--web') out.web = true
    else if (a === '--app') out.app = true
    else if (a === '--url-only') out.urlOnly = true
    else if (a === '--base') {
      const v = argv[++i]
      if (v === undefined) return { ...out, error: '--base needs a URL argument' }
      out.base = v
      out.hasBase = true
    } else if (a.startsWith('--')) {
      return { ...out, error: `unknown flag ${a} (see --help)` }
    } else out.files.push(a)
  }
  return out
}

/**
 * Decide where a document goes. Pure: platform and appInstalled are injected.
 * Web-only flags (--web, --url-only, --base) force the web path; --app forces
 * the app; with neither, the app wins on macOS when installed.
 */
export function chooseTarget({ web = false, app = false, urlOnly = false, hasBase = false, platform, appInstalled }) {
  const wantsWeb = web || urlOnly || hasBase
  if (app && wantsWeb) {
    const flag = web ? '--web' : urlOnly ? '--url-only' : '--base'
    return { error: `--app conflicts with ${flag}: pick one destination` }
  }
  if (app) {
    if (platform !== 'darwin') return { error: 'the Paperback app is macOS-only; drop --app to use the web handoff' }
    if (!appInstalled) {
      return { error: 'Paperback app not found (checked `open -Ra Paperback`); install it from https://paperback.sh or drop --app' }
    }
    return { target: 'app' }
  }
  if (wantsWeb) return { target: 'web' }
  return { target: platform === 'darwin' && appInstalled ? 'app' : 'web' }
}

/** True when the Paperback Mac app is installed (macOS only; `open -Ra` exits 0). */
export function detectApp() {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('open', ['-Ra', 'Paperback'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** ~/.paperback/handoff — persistent temp home for stdin content opened in the app. */
export function handoffDir() {
  return join(homedir(), '.paperback', 'handoff')
}

/**
 * Stable, readable filename for handoff content: <slug>-<hash12>.md.
 * Slug comes from the first non-empty line (usually the H1) so the app's
 * title is readable; the content hash makes repeat pipes of the same
 * document idempotent (same file → the app focuses the existing tab).
 */
export function handoffFileName(markdown) {
  const first = markdown.split('\n').find((l) => l.trim()) ?? ''
  const slug =
    first
      .replace(/^[#>\s*-]+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'document'
  const hash = createHash('sha256').update(markdown, 'utf8').digest('hex').slice(0, 12)
  return `${slug}-${hash}.md`
}

function handoffHashFromName(name) {
  return /-([0-9a-f]{12})\.md$/i.exec(name)?.[1].toLowerCase() ?? null
}

/**
 * Best-effort removal of handoff files older than maxAgeMs. Never throws.
 * Files in `keep` (absolute paths) survive regardless of age.
 */
export function cleanupHandoffDir(dir, { keep = new Set(), maxAgeMs = HANDOFF_MAX_AGE_MS, now = Date.now() } = {}) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const p = join(dir, name)
    if (keep.has(p)) continue
    try {
      if (now - statSync(p).mtimeMs <= maxAgeMs) continue
      const expected = handoffHashFromName(name)
      if (!expected) continue
      const actual = createHash('sha256').update(readFileSync(p), 'utf8').digest('hex').slice(0, 12)
      if (actual !== expected) continue
      unlinkSync(p)
    } catch {
      // best-effort: another process may have removed it, or perms are odd
    }
  }
}

function writeHandoffFile(markdown) {
  const dir = handoffDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, handoffFileName(markdown))
  writeFileSync(path, markdown)
  return path
}

function openInApp(paths) {
  try {
    execFileSync('open', ['-a', 'Paperback', ...paths], { stdio: 'ignore' })
  } catch {
    console.error('paperback: failed to open the Paperback app (`open -a Paperback` errored)')
    process.exit(1)
  }
}

function openUrl(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
}

function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(`paperback: ${parsed.error}`)
    process.exit(1)
  }
  if (parsed.help) {
    console.log(HELP)
    return
  }

  const forcedWeb = parsed.web || parsed.urlOnly || parsed.hasBase
  const appInstalled = !forcedWeb && process.platform === 'darwin' ? detectApp() : false
  const route = chooseTarget({ ...parsed, platform: process.platform, appInstalled })
  if (route.error) {
    console.error(`paperback: ${route.error}`)
    process.exit(1)
  }

  if (route.target === 'app') {
    if (parsed.files.length === 0) {
      // No file on disk (stdin): persist to ~/.paperback/handoff so the app
      // can read it now and re-read it on focus.
      const content = readFileSync(0, 'utf8')
      if (!content.trim()) {
        console.error('paperback: stdin is empty, skipping')
        process.exit(1)
      }
      const path = writeHandoffFile(content)
      cleanupHandoffDir(handoffDir(), { keep: new Set([path]) })
      openInApp([path])
      return
    }
    const paths = []
    for (const f of parsed.files) {
      const check = checkReadablePath(f)
      if (!check.ok) {
        console.error(`paperback: ${check.error}`)
        process.exitCode = 1
        continue
      }
      if (check.warnExt) {
        console.error(`paperback: ${f} doesn't look like markdown (opening it anyway)`)
      }
      paths.push(resolve(check.path))
    }
    if (paths.length > 0) openInApp(paths) // one call; the app opens one tab per file
    return
  }

  // Web path: encode into handoff URLs.
  function handle(markdown, label) {
    if (!markdown.trim()) {
      console.error(`paperback: ${label} is empty, skipping`)
      return
    }
    const payload = encode(markdown)
    if (payload.length > MAX_PAYLOAD_CHARS) {
      console.error(
        `paperback: ${label} compresses to ${payload.length} chars, over the ~1MB URL safety limit.`,
      )
      console.error('Open https://paperback.sh and paste it instead.')
      process.exitCode = 1
      return
    }
    const url = `${parsed.base}/#d=${payload}`
    if (parsed.urlOnly) console.log(url)
    else openUrl(url)
  }

  if (parsed.files.length === 0) {
    handle(readFileSync(0, 'utf8'), 'stdin')
  } else {
    for (const f of parsed.files) {
      const check = checkReadablePath(f)
      if (!check.ok) {
        console.error(`paperback: ${check.error}`)
        process.exitCode = 1
        continue
      }
      if (check.warnExt) {
        console.error(`paperback: ${f} doesn't look like markdown (opening it anyway)`)
      }
      handle(readFileSync(check.path, 'utf8'), f)
    }
  }
}

// Gate execution so tests can import the helpers without running the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
