# design-spec

[![npm version](https://img.shields.io/npm/v/design-spec.svg)](https://www.npmjs.com/package/design-spec)
[![npm downloads](https://img.shields.io/npm/dm/design-spec.svg)](https://www.npmjs.com/package/design-spec)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered design system documentation generator for frontend projects.

Scans your codebase — components, stylesheets, config files — and generates a `DESIGN.md` that tells AI assistants exactly how your project looks: which colors, classes, patterns, and conventions are actually used.

Works with **React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML** and any CSS approach: **Tailwind, SCSS, CSS Modules, Bootstrap, vanilla CSS**.

---

## Why

When you ask an AI to write new UI code, it produces generic output that doesn't match your project's visual style. It uses wrong colors, misses your custom CSS classes, and ignores patterns already established in the codebase.

`design-spec` fixes this by generating a concise, project-specific design contract from your actual source code — not invented rules.

---

## Requirements

- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys)

---

## Installation

```bash
npm install -g design-spec
```

On first run, `design-spec` will ask for your OpenAI API key and save it globally — you won't need to enter it again.

> [!NOTE]
> If you already have `OPENAI_API_KEY` set as an environment variable or in a `.env*` file in your project, it will detect and confirm with you before using it.

---

## Usage

### Generate `DESIGN.md`

Run from the root of your frontend project:

```bash
design-spec
```

Scans the project, calls OpenAI, writes `DESIGN.md`.

```bash
design-spec --force   # overwrite if DESIGN.md already exists
```

---

### Update with a new file

After building a new component, extract its patterns and merge them into your existing `DESIGN.md`:

```bash
design-spec patch src/components/MyNewComponent.tsx
```

Shows what's new (patterns not already documented) and asks for confirmation before writing.

---

### Register with your AI assistant

```bash
design-spec add
```

Appends a one-line `DESIGN.md` reference to any AI rule files found in the project:

| File | Assistant |
|------|-----------|
| `CLAUDE.md` | Claude Code |
| `.cursorrules` | Cursor |
| `.windsurfrules` | Windsurf |
| `.github/copilot-instructions.md` | GitHub Copilot |

---

## What gets generated

`DESIGN.md` answers five questions about your project:

| # | Section | What it documents |
|---|---------|-------------------|
| 1 | **Colors & Spacing** | Tokens, CSS variables, and values actually used — with conflict detection |
| 2 | **Global CSS Classes** | Classes used across multiple components, with Do/Don't rules |
| 3 | **Recurring UI Patterns** | HTML/template structures that repeat 3+ times, with code snippets |
| 4 | **Anti-patterns** | Where two approaches exist for the same thing — which is correct, which is legacy |
| 5 | **Dark Mode** | Exact mechanism, which tokens change, how to add support in a new component |

### Example output

```markdown
## 1. Colors & Spacing

> **Environment Context:** tailwind, scss
> *All tokens below belong to this ecosystem.*

### Backgrounds
| Token / Class | Resolved Value | Do | Don't |
| :--- | :--- | :--- | :--- |
| `--bg-primary` | `#262624` | Page shells, card body | `bg-gray-900`, raw `#262624` |
| `--bg-secondary` | `#30302e` | Sidebar panels, modals | Arbitrary panel dark |

### Typography
| Token / Class | Resolved Value | Do | Don't |
| :--- | :--- | :--- | :--- |
| `--text-primary` | `#ffffff` | Modal headings, nav labels | `text-white` on custom surfaces |
| `--text-secondary` | `#d1d5db` | Card subtitles, descriptions | `text-gray-300` ad hoc |

## 3. Recurring UI Patterns

## Primary and secondary dialog actions
- Snippet:
\`\`\`html
<div class="flex justify-end gap-2">
  <button class="secondary-blue-button">Cancel</button>
  <button class="primary-blue-button">Confirm</button>
</div>
\`\`\`
- Reference: `src/app/shared/components/edit-title-dialog/edit-title-dialog.component.html`
- Do: Right-aligned action row with standard button variants
- Don't: Ad-hoc Tailwind button stacks
```

---

## Options

```
design-spec                      Generate DESIGN.md for this project
design-spec patch <file>         Extract new patterns from a file and add them to DESIGN.md
design-spec add                  Register DESIGN.md reference in AI rule files

--max-files <n>         Max component files to include (default: 8)
--max-chars <n>         Max characters per snippet (default: 2000)
--max-total-chars <n>   Hard cap for entire analysis payload (default: 20000)
--max-file-size <n>     Skip files larger than n bytes (default: 204800)
--force, -f             Overwrite DESIGN.md if it already exists
--output <file>         Output filename (default: DESIGN.md)
--help, -h              Show help
```

---

## How it works

1. Walks the project directory — skips `node_modules`, build outputs, test files, lockfiles
2. Scores and selects the most relevant files: Tailwind config, `package.json`, global stylesheets, component files
3. Runs static frequency analysis: color usage, CSS variable definitions, class counts, loading patterns, project-specific class prefixes
4. Sends a compact payload to OpenAI with a structured prompt
5. Writes the result to `DESIGN.md`

The payload respects a hard character limit so API costs stay low and the prompt fits in any model's context window.

---

## License

MIT — [Emirhan Körhan](https://github.com/emirkrhan)
