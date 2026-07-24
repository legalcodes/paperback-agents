// Tests for the live-doc read/write verb (paperback live read|write).
//
// Two layers:
//  1. Pure unit tests for link parsing and anchor quoting (imported directly).
//  2. End-to-end CLI tests: spawn `node scripts/paperback.mjs live ...` against
//     a local mock implementing the shipped B3 contract shape (GET returns text
//     + quoted-ETag anchor; PUT requires Bearer + If-Match, 200 {id,rev} + new
//     ETag on match, 412 fresh state on stale anchor, 404 on bad/rotated token,
//     400 on raw If-Match: *). Grounded against paperback server/live-docs.ts
//     and server/live-b3-agent.test.ts.
//
// Run: `node --test` (or `npm test`). No dependencies beyond Node 18+.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { parseLiveLink, quoteAnchor, unquoteAnchor, liveApiUrl } from '../scripts/paperback.mjs'

const CLI = fileURLToPath(new URL('../scripts/paperback.mjs', import.meta.url))

// ---------- unit: link parsing ----------

test('parseLiveLink: full edit link yields id, token, origin', () => {
  const r = parseLiveLink('https://paperback.sh/d/abc123#k=secrettoken')
  assert.equal(r.ok, true)
  assert.equal(r.id, 'abc123')
  assert.equal(r.token, 'secrettoken')
  assert.equal(r.origin, 'https://paperback.sh')
})

test('parseLiveLink: bare /d/<id> with no #k= is refused (grants nothing)', () => {
  const r = parseLiveLink('https://paperback.sh/d/abc123')
  assert.equal(r.ok, false)
  assert.match(r.error, /grants nothing/)
})

test('parseLiveLink: token read from &-joined fragment params', () => {
  const r = parseLiveLink('https://paperback.sh/d/abc123#foo=1&k=tok&bar=2')
  assert.equal(r.ok, true)
  assert.equal(r.token, 'tok')
})

test('parseLiveLink: percent-encoded token is decoded', () => {
  const r = parseLiveLink('https://paperback.sh/d/abc123#k=a%2Bb')
  assert.equal(r.token, 'a+b')
})

test('parseLiveLink: query string before the fragment does not pollute the id', () => {
  const r = parseLiveLink('https://paperback.sh/d/abc123?utm=x#k=tok')
  assert.equal(r.id, 'abc123')
  assert.equal(r.token, 'tok')
})

test('parseLiveLink: missing link is a hard error', () => {
  assert.equal(parseLiveLink('').ok, false)
  assert.equal(parseLiveLink(undefined).ok, false)
})

test('liveApiUrl: maps origin + id to the /api/live/<id> endpoint', () => {
  assert.equal(liveApiUrl('https://paperback.sh', 'abc123'), 'https://paperback.sh/api/live/abc123')
  assert.equal(liveApiUrl('http://localhost:5180/', 'x'), 'http://localhost:5180/api/live/x')
})

// ---------- unit: anchor quoting (the bare-* safety property) ----------

test('quoteAnchor: wraps an unquoted anchor', () => {
  assert.equal(quoteAnchor('deadbeef'), '"deadbeef"')
})

test('quoteAnchor: leaves an already-quoted anchor alone', () => {
  assert.equal(quoteAnchor('"deadbeef"'), '"deadbeef"')
})

test('quoteAnchor NEUTRALIZES a bare * so the client can never send a blind-overwrite wildcard', () => {
  // If-Match: * means "overwrite regardless of what I saw" — exactly the blind
  // clobber the contract forbids. Quoting turns it into a harmless (stale)
  // literal anchor, so the helper structurally cannot force a wildcard write.
  assert.equal(quoteAnchor('*'), '"*"')
  assert.notEqual(quoteAnchor('*'), '*')
})

test('unquoteAnchor: strips one layer of surrounding quotes', () => {
  assert.equal(unquoteAnchor('"abc"'), 'abc')
  assert.equal(unquoteAnchor('abc'), 'abc')
  assert.equal(unquoteAnchor(null), '')
})

// ---------- e2e: CLI against a mock B3 server ----------

const anchorOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16)

/** Start a mock implementing the B3 contract shape. Returns { port, close }. */
function startMock({ id = 'doc42', token = 'goodtoken', text = '# Live doc\nversion one\n' } = {}) {
  const doc = { text, rev: 1 }
  const server = http.createServer((req, res) => {
    const m = /^\/api\/live\/([^/?#]+)$/.exec(req.url)
    if (!m) return void res.writeHead(404).end('Not found.')
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer /, '')
    const authed = m[1] === id && bearer === token
    if (req.method === 'GET') {
      if (!authed) return void res.writeHead(404).end('Not found.')
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        etag: `"${anchorOf(doc.text)}"`,
      })
      return void res.end(doc.text)
    }
    if (req.method === 'PUT') {
      if (!authed) return void res.writeHead(404).end('Not found.')
      const ifm = req.headers['if-match']
      if (ifm == null) return void res.writeHead(428).end('If-Match required.')
      if (ifm.trim() === '*') return void res.writeHead(400).end('If-Match: * is not allowed.')
      const want = ifm.replace(/^"(.*)"$/, '$1')
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (want !== anchorOf(doc.text)) {
          res.writeHead(412, {
            'content-type': 'text/markdown; charset=utf-8',
            etag: `"${anchorOf(doc.text)}"`,
          })
          return void res.end(doc.text)
        }
        doc.text = body
        doc.rev += 1
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          etag: `"${anchorOf(doc.text)}"`,
        })
        res.end(JSON.stringify({ id: m[1], rev: doc.rev }))
      })
      return
    }
    res.writeHead(405).end('Method not allowed.')
  })
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ port: server.address().port, close: () => server.close() }))
  })
}

/** Run the CLI as a subprocess; resolve { code, stdout, stderr }. */
function runCli(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile('node', [CLI, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}

function link(port, { id = 'doc42', token = 'goodtoken' } = {}) {
  return `http://localhost:${port}/d/${id}#k=${token}`
}

test('read: prints current text to stdout and the anchor to stderr, exit 0', async () => {
  const mock = await startMock()
  try {
    const r = await runCli(['live', 'read', link(mock.port)])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '# Live doc\nversion one\n')
    assert.match(r.stderr, /anchor: [0-9a-f]{16}/)
  } finally {
    mock.close()
  }
})

test('write with the read anchor lands: exit 0, new anchor reported', async () => {
  const mock = await startMock()
  try {
    const read = await runCli(['live', 'read', link(mock.port)])
    const anchor = /anchor: (\S+)/.exec(read.stderr)[1]
    const w = await runCli(['live', 'write', link(mock.port), '--if-match', anchor], {
      input: '# Live doc\nversion two\n',
    })
    assert.equal(w.code, 0)
    assert.match(w.stderr, /wrote \(rev 2\); new anchor: [0-9a-f]{16}/)
  } finally {
    mock.close()
  }
})

test('stale anchor: 412 with fresh text to stdout, exit 3, reapply guidance', async () => {
  const mock = await startMock()
  try {
    const read = await runCli(['live', 'read', link(mock.port)])
    const stale = /anchor: (\S+)/.exec(read.stderr)[1]
    // Advance the doc so the anchor above goes stale.
    await runCli(['live', 'write', link(mock.port), '--if-match', stale], { input: 'version two\n' })
    // Now write with the stale anchor.
    const w = await runCli(['live', 'write', link(mock.port), '--if-match', stale], {
      input: 'version three\n',
    })
    assert.equal(w.code, 3)
    assert.equal(w.stdout, 'version two\n') // the fresh text rides the 412
    assert.match(w.stderr, /412/)
    assert.match(w.stderr, /Reapply/)
  } finally {
    mock.close()
  }
})

test('write without --if-match is refused before any request, exit 1', async () => {
  const mock = await startMock()
  try {
    const w = await runCli(['live', 'write', link(mock.port)], { input: 'x\n' })
    assert.equal(w.code, 1)
    assert.match(w.stderr, /write needs --if-match/)
  } finally {
    mock.close()
  }
})

test('bad/rotated token: read gets 404, exit 4, stop-and-ask guidance', async () => {
  const mock = await startMock()
  try {
    const r = await runCli(['live', 'read', link(mock.port, { token: 'WRONG' })])
    assert.equal(r.code, 4)
    assert.match(r.stderr, /404/)
    assert.match(r.stderr, /rotated/)
  } finally {
    mock.close()
  }
})

test('empty body is refused client-side, exit 1', async () => {
  const mock = await startMock()
  try {
    const read = await runCli(['live', 'read', link(mock.port)])
    const anchor = /anchor: (\S+)/.exec(read.stderr)[1]
    const w = await runCli(['live', 'write', link(mock.port), '--if-match', anchor], { input: '   \n' })
    assert.equal(w.code, 1)
    assert.match(w.stderr, /empty document/)
  } finally {
    mock.close()
  }
})

test('bare If-Match: * is neutralized by the client (server never sees a wildcard)', async () => {
  const mock = await startMock()
  try {
    // The mock answers raw `If-Match: *` with 400 and a non-matching quoted
    // anchor with 412. The client quotes `*` to `"*"`, so it reaches the mock
    // as a (stale) literal anchor: 412 (exit 3), never the wildcard 400 path.
    const w = await runCli(['live', 'write', link(mock.port), '--if-match', '*'], { input: 'x\n' })
    assert.equal(w.code, 3)
    assert.match(w.stderr, /412/)
  } finally {
    mock.close()
  }
})
