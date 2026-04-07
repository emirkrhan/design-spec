# design-spec

[![npm version](https://img.shields.io/npm/v/design-spec.svg)](https://www.npmjs.com/package/design-spec)
[![npm downloads](https://img.shields.io/npm/dm/design-spec.svg)](https://www.npmjs.com/package/design-spec)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered design system documentation + MCP context server for frontend projects.

Scans your codebase — components, stylesheets, config files — and generates a `DESIGN.md` that tells AI assistants exactly how your project looks. Then exposes an MCP server so Claude Code and Codex automatically use those rules when writing new UI code — **without you having to say anything**.

Works with **React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML** and any CSS approach: **Tailwind, SCSS, CSS Modules, Bootstrap, vanilla CSS**.

---

## Why

When you ask an AI to write new UI code, it produces generic output that doesn't match your project's visual style. It uses wrong colors, misses your custom CSS classes, and ignores patterns already established in the codebase.

`design-spec` fixes this in two layers:

1. **`DESIGN.md`** — a concise, project-specific design contract generated from your actual source code
2. **MCP server** — automatically feeds relevant rules + real code examples to the AI before it writes anything

The result: the AI sees how your project is built and copies it — without you lifting a finger.

---

## Requirements

- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys) — only needed for the initial `DESIGN.md` generation. The MCP server works entirely offline.

---

## Installation

```bash
npm install -g design-spec
```

---

## Quick start

```bash
# 1. Generate DESIGN.md for your project (needs OpenAI key, run once)
cd your-project
design-spec

# 2. Register the MCP server with Claude Code (run once)
claude mcp add design-spec -- design-spec-mcp

# 3. Wire it into your AI rule files + optionally install the Write hook
design-spec add
```

After these three steps: every time Claude Code creates a new UI file, it automatically calls `design_context` first and follows your project's patterns.

---

## Commands

### `design-spec` — Generate `DESIGN.md`

Run from the root of your frontend project:

```bash
design-spec
design-spec --force   # overwrite if DESIGN.md already exists
```

Scans the project, calls OpenAI, writes `DESIGN.md`.

---

### `design-spec patch <file>` — Update with a new file

After building a new component, extract its patterns and merge them into `DESIGN.md`:

```bash
design-spec patch src/components/MyNewComponent.tsx
```

Shows what's new and asks for confirmation before writing.

---

### `design-spec add` — Integrate with your AI assistant

```bash
design-spec add
```

Does two things:

**1. Adds a strong, specific rule** to your AI rule files:

| File | Assistant |
|------|-----------|
| `CLAUDE.md` | Claude Code |
| `.cursorrules` | Cursor |
| `.windsurfrules` | Windsurf |
| `.github/copilot-instructions.md` | GitHub Copilot |

The rule tells Claude Code to call `design_context` before creating any new UI file, and `design_lint` after any UI change.

**2. Optionally installs a Write hook** — when you choose this, Claude Code is reminded to call `design_context` every time it creates a new file. Adds a small token cost per new file; disabled by default.

---

## MCP tools

The MCP server (`design-spec-mcp`) exposes two tools. No OpenAI key required — everything runs locally.

### `design_context`

Call before writing any UI code. Given a task description, returns:
- Relevant rules from `DESIGN.md` (tokens, patterns, anti-patterns)
- Real code examples from your project that match the task
- Explicit instructions: follow these patterns, don't invent new ones

**Modes:**
- **Component mode** — triggered by tasks mentioning buttons, inputs, modals, etc. Returns the closest matching component files.
- **Page/layout mode** — triggered by tasks mentioning page, admin, dashboard, screen, etc. Returns page skeleton structure, layout wrappers, route guards in addition to component examples.

```
# Example: "add a nav item to the sidebar"
→ Returns: sidebar token rules + NavItem.tsx snippet + Sidebar.tsx snippet

# Example: "create a new admin page"
→ Returns: layout wrapper pattern + existing admin page anatomy + relevant component snippets
```

### `design_lint`

Call after any UI change. Scans a file or directory for design violations:

| Rule | Severity | Example |
|------|----------|---------|
| `hard-coded-color` | error | `color: #3b82f6` in CSS instead of a token |
| `inline-style-color` | error | `style={{ color: '#fff' }}` in JSX |
| `tailwind-arbitrary-color` | warning | `text-[#fff]` instead of a project token |
| `off-grid-spacing` | warning | `padding: 13px` (not a multiple of 4) |

Returns a report with file path + line number for every violation.

---

## What `DESIGN.md` contains

| # | Section | What it documents |
|---|---------|-------------------|
| 1 | **Colors & Spacing** | Tokens and CSS variables actually used — with conflict detection |
| 2 | **Global CSS Classes** | Classes used across multiple components, with Do/Don't rules |
| 3 | **Recurring UI Patterns** | HTML/template structures that repeat 3+ times, with code snippets |
| 4 | **Anti-patterns** | Where two approaches exist — which is correct, which is legacy |
| 5 | **Dark Mode** | Exact mechanism, which tokens change, how to add support in a new component |

### Example output

```markdown
## 1. Colors & Spacing

> **Environment Context:** tailwind, scss

### Backgrounds
| Token / Class | Resolved Value | Do | Don't |
| `--bg-primary` | `#262624` | Page shells, card body | `bg-gray-900`, raw `#262624` |
| `--bg-secondary` | `#30302e` | Sidebar panels, modals | Arbitrary panel dark |

## 3. Recurring UI Patterns

## Primary and secondary dialog actions
- Snippet:
```html
<div class="flex justify-end gap-2">
  <button class="secondary-blue-button">Cancel</button>
  <button class="primary-blue-button">Confirm</button>
</div>
```
- Do: Right-aligned action row with standard button variants
- Don't: Ad-hoc Tailwind button stacks
```

---

## How it works

### `design-spec` (CLI — one-time)
1. Walks the project — skips `node_modules`, build outputs, tests, lockfiles
2. Scores and selects the most relevant files: Tailwind config, `package.json`, global stylesheets, components
3. Runs static frequency analysis: color usage, CSS variable definitions, class counts, loading patterns
4. Sends a compact payload to OpenAI with a structured prompt
5. Writes the result to `DESIGN.md`

### `design-spec-mcp` (MCP server — always-on)
1. Claude Code calls `design_context` with your task description
2. Keywords are extracted and matched against file names **and file contents**
3. Top matching files are scored and selected
4. Relevant `DESIGN.md` sections + real code snippets are bundled and returned
5. Claude Code uses this bundle to write code that matches your existing patterns

No AI calls, no network requests. Runs entirely on your machine.

---

## Options

```
design-spec                      Generate DESIGN.md for this project
design-spec patch <file>         Extract new patterns from a file and add them to DESIGN.md
design-spec add                  Integrate with AI rule files and optionally install Write hook

--max-files <n>         Max component files to include (default: 8)
--max-chars <n>         Max characters per snippet (default: 2000)
--max-total-chars <n>   Hard cap for entire analysis payload (default: 20000)
--max-file-size <n>     Skip files larger than n bytes (default: 204800)
--force, -f             Overwrite DESIGN.md if it already exists
--output <file>         Output filename (default: DESIGN.md)
--help, -h              Show help
```

---

## License

MIT — [Emirhan Körhan](https://github.com/emirkrhan)
