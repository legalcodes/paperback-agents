# paperback-agents

Agent-harness plugin for [Paperback](https://paperback.sh): open markdown beautifully rendered, one utterance away, from inside Codex and Claude Code.

Say "show me the plan in paperback" and the document opens rendered — in the native Paperback Mac app when installed (with live reload as the agent keeps writing), otherwise in the web app at paperback.sh.

## Install

**Codex CLI:**

```
codex plugin marketplace add legalcodes/paperback-agents
```

then `/plugins` and install **paperback**.

**Claude Code:**

```
/plugin marketplace add legalcodes/paperback-agents
/plugin install paperback@paperback-agents
```

Requires `node` on your machine. The Mac app is optional; without it, documents open in the browser.

## What it does, and deliberately does not do

- **Renders.** Files on disk or content the agent just wrote. Mac app first (`open -a Paperback`), web fallback via a compressed handoff URL.
- **Nothing leaves your machine.** On the web path the document travels inside the URL fragment (`#d=`), which browsers never send to any server. No uploads, no analytics on your content, no accounts.
- **No sharing.** This plugin never creates paperback.sh share links and never uploads document content. Sharing is a human action inside the app, by design: agents render, humans publish.

## Layout

- `skills/paperback/SKILL.md` — the skill (same file serves Codex and Claude Code)
- `scripts/paperback.mjs` — self-contained CLI (routing, handoff encoding); no dependencies beyond node
- `.codex-plugin/` + `.agents/plugins/` — Codex plugin + marketplace manifests
- `.claude-plugin/` — Claude Code plugin + marketplace manifests (also read by Codex's legacy auto-import)
