# design-spec

AI-powered design system documentation generator for frontend projects.

Scans your codebase — components, stylesheets, config files — and generates a `DESIGN.md` that tells AI assistants (Claude, Cursor, Copilot, Windsurf) exactly how your project looks: which colors, classes, patterns, and conventions are actually used.

Works with any frontend framework: **React, Vue, Angular, Svelte, Next.js, Nuxt, plain HTML** — and any CSS approach: **Tailwind, SCSS, CSS Modules, Bootstrap, or vanilla CSS**.

---

## Why

When you ask an AI to write new UI code, it produces generic output that doesn't match your project's visual style. It uses wrong colors, misses your custom CSS classes, and ignores patterns already established in the codebase.

`design-spec` fixes this by generating a concise, project-specific design contract from your actual source code — not invented rules.

---

## Requirements

- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys)

---

## Setup

Set your OpenAI API key as an environment variable:

```bash
export OPENAI_API_KEY=sk-...
```

Or create a `.env` file in your project root:

```
OPENAI_API_KEY=sk-...
```

---

## Usage

### Generate `DESIGN.md`

Run this from the root of your frontend project:

```bash
npx design-spec
```

It will scan your project, analyze the code, and create a `DESIGN.md` file.

If `DESIGN.md` already exists, use `--force` to overwrite:

```bash
npx design-spec --force
```

---

### Update with new patterns from a specific file

After you build a new component, extract its patterns and merge them into your existing `DESIGN.md`:

```bash
npx design-spec patch src/components/MyNewComponent.tsx
```

It shows you what's new (patterns not already documented) and asks for confirmation before writing.

---

### Register `DESIGN.md` with your AI assistant

Tell your AI assistant to use `DESIGN.md` as the source of truth for UI decisions:

```bash
npx design-spec add
```

This appends a one-line reference to any rule files it finds in your project:
- `CLAUDE.md` (Claude Code)
- `.cursorrules` (Cursor)
- `.windsurfrules` (Windsurf)
- `.github/copilot-instructions.md` (GitHub Copilot)

---

## What gets generated

`DESIGN.md` answers five questions about your project:

1. **Colors & Spacing** — which tokens, CSS variables, and values are actually used (with conflict detection if the same color appears both as a token and a raw hex value)
2. **Global CSS Classes** — classes defined in global stylesheets and used across multiple components, with Do/Don't rules
3. **Recurring UI Patterns** — HTML/template structures that repeat 3+ times, with actual code snippets
4. **Anti-patterns** — places where two approaches exist for the same thing; documents which is correct and which is legacy
5. **Dark Mode** — the exact mechanism: which class or attribute triggers it, which tokens change, what a developer must do to support it in a new component

---

## Options

```
design-spec                     Generate DESIGN.md for this project
design-spec patch <file>        Extract new patterns from a file and add them to DESIGN.md
design-spec add                 Register DESIGN.md reference in AI rule files

--max-files <n>        Max component files to include (default: 8)
--max-chars <n>        Max characters per snippet (default: 2000)
--max-total-chars <n>  Hard cap for entire analysis payload (default: 20000)
--max-file-size <n>    Skip files larger than n bytes (default: 204800)
--force, -f            Overwrite DESIGN.md if it already exists
--output <file>        Output filename (default: DESIGN.md)
--help, -h             Show help
```

---

## How it works

1. Walks your project directory (skips `node_modules`, build outputs, test files, lockfiles, etc.)
2. Selects the most relevant files: Tailwind config, `package.json`, global stylesheets, and component files scored by type and location
3. Runs static frequency analysis: extracts color usage, CSS variable definitions, class usage counts, loading patterns, and project-specific class prefixes
4. Sends a compact payload to OpenAI with a structured prompt
5. Writes the result to `DESIGN.md`

The payload respects a hard character limit so API costs stay low and the prompt fits in any model's context window.

---

## License

MIT — [Emirhan Körhan](https://github.com/emirkrhan)
