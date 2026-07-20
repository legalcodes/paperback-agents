---
name: paperback
description: Open markdown beautifully rendered in Paperback when the user asks to "show/open/read this in paperback," or wants a document, plan, report, or any markdown rendered nicely for reading. Works for files on disk and for content the agent just wrote. Render-only; never uploads content or creates share links.
---

# Open markdown in Paperback

Paperback (https://paperback.sh) renders markdown beautifully for reading: typography-first reading view, table of contents, math, Mermaid diagrams, syntax highlighting, GFM tables and footnotes. This skill opens documents there.

**Render-only, by design.** This skill never uploads document content anywhere and never creates Paperback share links. Sharing is a human action inside the app, and this skill must not be extended to perform it. On the web path the document travels compressed inside the URL fragment (`#d=`), which browsers never send to any server: the content stays client-side.

## How

The bundled CLI routes automatically: the native Paperback Mac app when installed (`open -a Paperback`, one tab per file, re-open focuses), otherwise the web app via a handoff URL.

```sh
# Files on disk (one tab per file, order preserved)
node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/scripts/paperback.mjs" doc.md other.md

# Content you just generated: pipe it, no need to save first
cat plan.md | node "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/scripts/paperback.mjs"
```

Flags:

- `--web` — force the browser handoff even if the Mac app is installed
- `--url-only` — print the handoff URL instead of opening anything (use this in remote or headless sessions and give the user the link)
- `--app` — require the Mac app; error if it is not installed

## Rules

- One document per open. "Show me these 3 docs" = pass all 3 paths in one call; they open as 3 tabs in the order given.
- Piped stdin is persisted to `~/.paperback/handoff/<slug>-<hash>.md` so the Mac app can read it from disk and re-read it on focus; files older than 7 days are cleaned up automatically.
- If the CLI reports the ~1MB URL limit, tell the user to open https://paperback.sh and paste the content instead.
- The CLI requires node. If node is unavailable, give the user the https://paperback.sh link and suggest pasting the content.
- Live reload: once the Mac app has a file open, it re-renders as the file changes on disk. "Open the plan in paperback" once, then keep writing; the user watches it evolve.
