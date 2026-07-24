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
- **Rendering stays on your machine.** On the web render path the document travels inside the URL fragment (`#d=`), which browsers never send to any server. No uploads, no analytics on your content, no accounts.
- **Writes to a live doc you were handed.** If your user gives an agent a live doc's edit link (`paperback.sh/d/<id>#k=<token>`), the plugin reads the current text and writes updated markdown back, under a compare-and-swap anchor so it never clobbers a collaborator's concurrent edit. This is the one path where content goes to paperback.sh, and only for a doc a human already made live and handed over out-of-band.
- **Never creates, rotates, or deletes.** The plugin never mints a share link, never creates or rotates or deletes a live doc or its edit link, and never uploads a new document. Creating and sharing stay human, in-app actions, by design: agents render and edit what they're handed, humans publish.

## Layout

- `skills/paperback/SKILL.md` — the skill (same file serves Codex and Claude Code)
- `scripts/paperback.mjs` — self-contained CLI (render routing + handoff encoding, plus `live read` / `live write` for an existing live doc); no dependencies beyond node
- `.codex-plugin/` + `.agents/plugins/` — Codex plugin + marketplace manifests
- `.claude-plugin/` — Claude Code plugin + marketplace manifests (also read by Codex's legacy auto-import)
