#!/usr/bin/env node

'use strict';

/**
 * design-spec MCP server
 *
 * Exposes two tools to Claude Code / Codex:
 *
 *   design_context  — given a UI task description, returns a focused bundle of
 *                     relevant rules (from DESIGN.md) + real code examples from
 *                     the project. The LLM receives this before writing any UI
 *                     code so it "sees" existing patterns instead of inventing.
 *
 *   design_lint     — scans a file or directory for design violations:
 *                     hard-coded colors, out-of-token spacing values, etc.
 *                     Returns a structured report with file + line references.
 *
 * Both tools are purely local — no network calls, no OpenAI.
 * The heavy AI work (DESIGN.md generation) is still done by the CLI.
 */

const fs   = require('fs');
const path = require('path');

const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Re-use constants + helpers from index.js that don't depend on OpenAI/inquirer
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules','.git','dist','build','.next','.nuxt','.svelte-kit','out',
  'coverage','.turbo','.vercel','.cache','.yarn','.pnpm','.angular','.nx',
  '.vite','tmp','temp','__pycache__','.sass-cache','generated','gen',
  'ios','android','platforms','www','storybook-static',
]);

const BINARY_EXTS = new Set([
  '.png','.jpg','.jpeg','.gif','.webp','.bmp','.tiff','.ico',
  '.mp4','.mov','.avi','.mkv','.mp3','.wav','.flac',
  '.zip','.gz','.tgz','.rar','.7z','.pdf',
  '.woff','.woff2','.ttf','.otf','.eot',
]);

const COMPONENT_EXTS  = new Set(['.js','.jsx','.ts','.tsx','.vue','.svelte','.html']);
const STYLE_EXTS      = new Set(['.css','.scss']);
const KNOWN_TEXT_EXTS = new Set([...COMPONENT_EXTS, ...STYLE_EXTS, '.json','.cjs','.mjs','.mts','.cts']);

const SKIP_FILE_PARTS = ['.test.','.spec.','.stories.','.story.','.snap.','.min.','.d.ts'];

const COMPONENT_MATCHERS = [
  { key: 'button',       label: 'Button' },
  { key: 'btn',          label: 'Button' },
  { key: 'input',        label: 'Input' },
  { key: 'field',        label: 'Input' },
  { key: 'card',         label: 'Card' },
  { key: 'layout',       label: 'Layout' },
  { key: 'navbar',       label: 'Nav' },
  { key: 'nav',          label: 'Nav' },
  { key: 'header',       label: 'Header' },
  { key: 'footer',       label: 'Footer' },
  { key: 'sidebar',      label: 'Sidebar' },
  { key: 'drawer',       label: 'Sidebar' },
  { key: 'modal',        label: 'Modal' },
  { key: 'dialog',       label: 'Modal' },
  { key: 'table',        label: 'Table' },
  { key: 'list',         label: 'List' },
  { key: 'form',         label: 'Form' },
  { key: 'select',       label: 'Select' },
  { key: 'dropdown',     label: 'Select' },
  { key: 'badge',        label: 'Badge' },
  { key: 'tag',          label: 'Badge' },
  { key: 'chip',         label: 'Badge' },
  { key: 'alert',        label: 'Alert' },
  { key: 'toast',        label: 'Alert' },
  { key: 'notification', label: 'Alert' },
  { key: 'tab',          label: 'Tabs' },
  { key: 'tabs',         label: 'Tabs' },
  { key: 'pagination',   label: 'Pagination' },
  { key: 'breadcrumb',   label: 'Breadcrumb' },
  { key: 'avatar',       label: 'Avatar' },
  { key: 'icon',         label: 'Icon' },
  { key: 'spinner',      label: 'Spinner' },
  { key: 'loader',       label: 'Spinner' },
  { key: 'skeleton',     label: 'Spinner' },
  { key: 'menu',         label: 'Menu' },
  { key: 'tooltip',      label: 'Tooltip' },
  { key: 'popover',      label: 'Tooltip' },
  { key: 'search',       label: 'Search' },
];

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

function shouldSkipFile(name) {
  if (SKIP_FILE_PARTS.some(part => name.includes(part))) return true;
  const ext = path.extname(name.toLowerCase());
  if (BINARY_EXTS.has(ext)) return true;
  if (!KNOWN_TEXT_EXTS.has(ext)) return true;
  return false;
}

function walkProject(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const ent of entries) {
      const name = ent.name;
      const abs  = path.join(dir, name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!shouldSkipDir(name)) walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const nameLower = name.toLowerCase();
      if (shouldSkipFile(nameLower)) continue;
      const st = safeStat(abs);
      if (!st || st.size <= 0 || st.size > 200 * 1024) continue;

      const rel   = path.relative(root, abs).replace(/\\/g, '/');
      const ext   = path.extname(nameLower);
      const base  = path.basename(nameLower, ext);
      const depth = rel.split('/').length - 1;
      out.push({ abs, rel, name: nameLower, ext, base, size: st.size, depth });
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Keyword → component label matching
// ---------------------------------------------------------------------------

function classifyByKeyword(baseLower) {
  for (const m of COMPONENT_MATCHERS) {
    if (baseLower === m.key || baseLower.startsWith(m.key) ||
        baseLower.endsWith(m.key) || baseLower.includes(m.key)) {
      return m.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page-level anatomy keywords
// When a task mentions these, we switch to "macro mode":
// find page/layout/route files instead of component files.
// ---------------------------------------------------------------------------

const PAGE_KEYWORDS = new Set([
  'page','screen','view','route','layout','scaffold','skeleton',
  'admin','dashboard','settings','profile','onboarding','checkout',
  'billing','login','signup','auth','home','index','list','detail',
  'overview','management','panel','wizard','flow',
]);

// Directory names that signal page-level files
const PAGE_DIRS = new Set([
  'pages','views','screens','routes','app','layouts',
]);

// ---------------------------------------------------------------------------
// Task intent → relevant keywords + macro flag
// ---------------------------------------------------------------------------

function extractKeywordsFromTask(task) {
  const lower = task.toLowerCase();
  const found = new Set();
  let isMacro = false;

  // Check for page-level intent first
  for (const kw of PAGE_KEYWORDS) {
    if (lower.includes(kw)) {
      found.add(kw);
      isMacro = true;
    }
  }

  // Component-level keywords
  for (const m of COMPONENT_MATCHERS) {
    if (lower.includes(m.key)) found.add(m.key);
  }

  // Generic UI nouns
  const extras = [
    'section','panel','container','grid','row','column','item',
    'cell','block','box','wrapper','color','theme','dark','light',
    'token','spacing','padding','margin','font','text','heading',
    'title','label','link','image','icon',
  ];
  for (const word of extras) {
    if (lower.includes(word)) found.add(word);
  }

  return { keywords: [...found], isMacro };
}

// ---------------------------------------------------------------------------
// Content-based scoring: grep file content for keyword hits
// This solves the "admin page → pagenotfound returned" problem by looking
// INSIDE files, not just at file names.
// ---------------------------------------------------------------------------

const CONTENT_SCAN_LIMIT = 6000; // chars to read for content scoring (fast)

function scoreFileContent(abs, keywords) {
  let score = 0;
  try {
    const raw = readUtf8(abs).slice(0, CONTENT_SCAN_LIMIT).toLowerCase();
    for (const kw of keywords) {
      // Count occurrences — more hits = more relevant
      let idx = 0;
      let hits = 0;
      while ((idx = raw.indexOf(kw, idx)) !== -1) {
        hits++;
        idx += kw.length;
        if (hits >= 5) break; // cap at 5 to avoid skewing
      }
      score += hits * 8;
    }
  } catch {
    // unreadable — no content score
  }
  return score;
}

// ---------------------------------------------------------------------------
// Score a file's relevance to a set of keywords (name + path + content)
// ---------------------------------------------------------------------------

function scoreFileRelevance(f, keywords, isMacro) {
  let score = 0;

  // --- Name & path matching ---
  for (const kw of keywords) {
    if (f.base === kw)              score += 60; // exact name match
    if (f.base.includes(kw))        score += 30;
    if (f.rel.includes(`/${kw}/`))  score += 15;
    if (f.rel.includes(kw))         score += 8;
  }

  if (isMacro) {
    // Macro mode: prefer page/layout/route files
    const segments = f.rel.split('/');
    if (segments.some(s => PAGE_DIRS.has(s))) score += 40;
    // Page-level files tend to be larger (more content) — reward that
    if (f.size > 3000) score += 10;
    if (f.size > 8000) score += 10;
  } else {
    // Micro mode: prefer component/ui folders
    if (f.rel.includes('/components/') || f.rel.includes('/ui/')) score += 20;
  }

  if (COMPONENT_EXTS.has(f.ext)) score += 10;

  // Penalise deep nesting only lightly — deep pages are still relevant
  score -= f.depth;

  // --- Content matching (the key fix) ---
  score += scoreFileContent(f.abs, keywords);

  return score;
}

// ---------------------------------------------------------------------------
// Smart snippet extraction
// Instead of blindly cutting at N chars, tries to cut at a clean boundary
// (end of a function/component block) so the LLM gets complete context.
// ---------------------------------------------------------------------------

const MAX_SNIPPET_CHARS = 3000; // raised from 1500

function readSnippet(abs) {
  try {
    const raw = readUtf8(abs).replace(/\r\n/g, '\n').trim();
    if (raw.length <= MAX_SNIPPET_CHARS) return raw;

    // Try to cut at a clean boundary within the limit
    const candidate = raw.slice(0, MAX_SNIPPET_CHARS);

    // Prefer cutting at end of a top-level block: blank line after closing brace
    const cleanCut = candidate.lastIndexOf('\n\n');
    if (cleanCut > MAX_SNIPPET_CHARS * 0.6) {
      return candidate.slice(0, cleanCut) + '\n\n// ... (file continues)';
    }

    // Fallback: cut at last newline
    const lineCut = candidate.lastIndexOf('\n');
    if (lineCut > MAX_SNIPPET_CHARS * 0.5) {
      return candidate.slice(0, lineCut) + '\n// ... (file continues)';
    }

    return candidate + '\n// ... (file continues)';
  } catch {
    return '/* could not read file */';
  }
}

// ---------------------------------------------------------------------------
// Extract relevant sections from DESIGN.md based on keywords
// No truncation per section — DESIGN.md is authoritative, give it fully.
// ---------------------------------------------------------------------------

function extractDesignRules(designMd, keywords, isMacro) {
  if (!designMd) return '';

  const lines    = designMd.split('\n');
  const sections = [];
  let current    = null;

  for (const line of lines) {
    if (/^## \d+\./.test(line)) {
      if (current) sections.push(current);
      current = { heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const relevant = [];
  for (const sec of sections) {
    const body    = sec.lines.join('\n').toLowerCase();
    const heading = sec.heading.toLowerCase();

    const isColors      = heading.includes('1.');
    const isPatterns    = heading.includes('3.');
    const isAntipattern = heading.includes('4.');
    const isDarkMode    = heading.includes('5.');
    const mentionsKw    = keywords.some(kw => body.includes(kw) || heading.includes(kw));

    // Macro mode: always include patterns + anti-patterns (page anatomy lives here)
    const includeDueToMacro = isMacro && (isPatterns || isAntipattern);

    if (isColors || isDarkMode || mentionsKw || includeDueToMacro) {
      relevant.push(sec.heading + '\n' + sec.lines.join('\n'));
    }
  }

  return relevant.join('\n\n');
}

// ---------------------------------------------------------------------------
// Detect page anatomy from existing page files
// Scans page/layout files and extracts the structural skeleton:
// which layout wrappers, route guards, section order they use.
// This gives the LLM the macro-level "how is a page built here" answer.
// ---------------------------------------------------------------------------

function extractPageAnatomy(files, keywords) {
  // Find page/layout files relevant to the task
  const pageCandidates = files.filter(f => {
    const segments = f.rel.split('/');
    const inPageDir = segments.some(s => PAGE_DIRS.has(s));
    const isLargeFile = f.size > 2000; // pages tend to be bigger
    return (inPageDir || isLargeFile) && COMPONENT_EXTS.has(f.ext);
  });

  if (pageCandidates.length === 0) return null;

  // Score by content relevance
  const scored = pageCandidates
    .map(f => ({ f, score: scoreFileContent(f.abs, keywords) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  // Extract structural lines from the top match:
  // imports, JSX root elements, layout wrappers, route guards
  const topFile = scored[0].f;
  let anatomy = '';
  try {
    const raw   = readUtf8(topFile.abs).replace(/\r\n/g, '\n');
    const lines = raw.split('\n');
    const kept  = [];

    for (const line of lines) {
      const t = line.trim();
      // Keep: imports, exports, JSX structural lines, layout/guard patterns
      if (
        t.startsWith('import ')           ||
        t.startsWith('export ')           ||
        t.startsWith('const ')            ||
        /^<[A-Z]/.test(t)                 || // JSX component tags
        /^return\s*[\(<]/.test(t)         ||
        /layout|guard|wrapper|provider|route|auth|admin|page|section|header|footer|sidebar/i.test(t) ||
        t === ')' || t === '}' || t === '};' || t === '),' || t === ''
      ) {
        kept.push(line);
      }
    }

    // Keep first 60 structural lines to avoid bloat
    anatomy = kept.slice(0, 60).join('\n').trim();
  } catch {
    return null;
  }

  if (!anatomy) return null;

  return {
    rel: topFile.rel,
    anatomy,
    others: scored.slice(1, 3).map(x => x.f.rel), // other relevant page files
  };
}

// ---------------------------------------------------------------------------
// design_context — main logic
// ---------------------------------------------------------------------------

async function buildContext(task, projectRoot) {
  const root = projectRoot || process.cwd();

  // 1. Read DESIGN.md if it exists
  const designPath = path.join(root, 'DESIGN.md');
  const designMd   = fs.existsSync(designPath) ? readUtf8(designPath) : null;

  // 2. Extract keywords + detect macro vs micro intent
  const { keywords, isMacro } = extractKeywordsFromTask(task);

  // 3. Walk project
  const allFiles = walkProject(root);
  const uiFiles  = allFiles.filter(f => COMPONENT_EXTS.has(f.ext) || STYLE_EXTS.has(f.ext));

  // 4. Score and pick example files
  const scored = uiFiles
    .map(f => ({ f, score: scoreFileRelevance(f, keywords, isMacro) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // In macro mode: show 3 files (they'll be larger); micro mode: 4 files
  const maxFiles = isMacro ? 3 : 4;
  const seen     = new Set();
  const picked   = [];

  for (const { f } of scored) {
    if (picked.length >= maxFiles) break;
    // De-duplicate: skip if same base name already included
    const key = isMacro ? f.rel : (classifyByKeyword(f.base) || f.base);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(f);
  }

  // 5. Build output
  const parts = [];

  const modeLabel = isMacro ? 'page/layout' : 'component';
  parts.push(`# design-spec context\n_Task: ${task}_\n_Mode: ${modeLabel}_\n`);

  // --- Rules block (from DESIGN.md) ---
  if (designMd) {
    const rules = extractDesignRules(designMd, keywords, isMacro);
    if (rules && rules.trim()) {
      parts.push(`## Design rules\n\n${rules}`);
    } else {
      parts.push(`## Design rules\n\n_No matching sections — check DESIGN.md directly._`);
    }
  } else {
    parts.push(`## Design rules\n\n_DESIGN.md not found. Run \`design-spec\` first._`);
  }

  // --- Macro mode: page anatomy block ---
  if (isMacro) {
    const anatomy = extractPageAnatomy(allFiles, keywords);
    if (anatomy) {
      const otherNote = anatomy.others.length > 0
        ? `\n_Also see: ${anatomy.others.join(', ')}_`
        : '';
      parts.push(
        `## Page anatomy (how pages are structured in this project)\n` +
        `_Extracted from: ${anatomy.rel}_${otherNote}\n\n` +
        `\`\`\`tsx\n${anatomy.anatomy}\n\`\`\``
      );
    }
  }

  // --- Code examples block ---
  if (picked.length > 0) {
    parts.push(`## Existing code examples\n`);
    for (const f of picked) {
      const snippet = readSnippet(f.abs);
      parts.push(`### ${f.rel}\n\`\`\`${f.ext.slice(1)}\n${snippet}\n\`\`\``);
    }
  } else {
    parts.push(`## Existing code examples\n\n_No matching files found._`);
  }

  // --- Instructions ---
  const instructions = isMacro
    ? `## Instructions\n` +
      `- Study the page anatomy above — use the same layout wrappers and structure.\n` +
      `- Follow all design rules (tokens, spacing, dark mode).\n` +
      `- Do NOT invent new layout patterns — extend what already exists.\n` +
      `- If a layout/wrapper component exists, use it; do not re-implement it.\n` +
      `- Match route guard and auth patterns shown in examples.`
    : `## Instructions\n` +
      `- Follow the design rules exactly (tokens, classes, variants).\n` +
      `- Match the patterns in the code examples — same token usage, same structure.\n` +
      `- Do NOT invent new tokens, class names, or patterns not already present.\n` +
      `- If a relevant component already exists, extend it instead of creating a new one.`;

  parts.push(instructions);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// design_lint — violation detection
// ---------------------------------------------------------------------------

// Regex for raw hex colors (#rgb, #rrggbb, #rrggbbaa)
const HEX_RE = /#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// Regex for raw rgb/hsl (not inside var() definitions)
const RGB_RE  = /\brgba?\s*\(/g;
const HSL_RE  = /\bhsla?\s*\(/g;

// Arbitrary pixel values that are NOT multiples of 4 — likely off-grid
const ARBITRARY_PX_RE = /(?:padding|margin|gap|top|right|bottom|left|width|height)\s*:\s*(\d+)px/gi;

// Inline style with literal colors in JSX/TSX
const INLINE_STYLE_COLOR_RE = /style\s*=\s*\{\s*\{[^}]*(?:color|background|borderColor)\s*:\s*['"]#[0-9a-fA-F]/g;

function isInsideVarDefinition(line) {
  // e.g.  --color-primary: #1a1a1a;  — this IS a token definition, not a violation
  return /^\s*--[\w-]+\s*:/.test(line);
}

function lintFile(abs, rel) {
  const violations = [];
  let text;
  try { text = readUtf8(abs); } catch { return violations; }

  const lines = text.split('\n');
  const ext   = path.extname(abs.toLowerCase());
  const isStyle     = STYLE_EXTS.has(ext);
  const isComponent = COMPONENT_EXTS.has(ext);

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    // --- Hard-coded color violations ---
    if (isStyle) {
      // In style files: raw hex outside of token definitions is a violation
      if (!isInsideVarDefinition(line)) {
        let m;
        HEX_RE.lastIndex = 0;
        while ((m = HEX_RE.exec(line)) !== null) {
          violations.push({
            file: rel,
            line: lineNum,
            rule: 'hard-coded-color',
            severity: 'error',
            message: `Hard-coded color \`${m[0]}\` — use a CSS token (var(--...)) instead`,
            excerpt: trimmed.slice(0, 120),
          });
        }
        RGB_RE.lastIndex = 0;
        if (RGB_RE.test(line)) {
          violations.push({
            file: rel, line: lineNum,
            rule: 'hard-coded-color', severity: 'error',
            message: `Hard-coded rgb/rgba color — use a CSS token instead`,
            excerpt: trimmed.slice(0, 120),
          });
        }
        HSL_RE.lastIndex = 0;
        if (HSL_RE.test(line)) {
          violations.push({
            file: rel, line: lineNum,
            rule: 'hard-coded-color', severity: 'error',
            message: `Hard-coded hsl/hsla color — use a CSS token instead`,
            excerpt: trimmed.slice(0, 120),
          });
        }
      }
    }

    if (isComponent) {
      // In components: inline style with literal color
      INLINE_STYLE_COLOR_RE.lastIndex = 0;
      if (INLINE_STYLE_COLOR_RE.test(line)) {
        violations.push({
          file: rel, line: lineNum,
          rule: 'inline-style-color', severity: 'error',
          message: `Inline style with hard-coded color — use a CSS token instead`,
          excerpt: trimmed.slice(0, 120),
        });
      }

      // Raw hex in className / Tailwind arbitrary value  e.g. text-[#fff]
      const twArbitrary = line.match(/\[#[0-9a-fA-F]{3,8}\]/g);
      if (twArbitrary) {
        for (const match of twArbitrary) {
          violations.push({
            file: rel, line: lineNum,
            rule: 'tailwind-arbitrary-color', severity: 'warning',
            message: `Tailwind arbitrary color \`${match}\` — use a project color token instead`,
            excerpt: trimmed.slice(0, 120),
          });
        }
      }
    }

    // --- Off-grid spacing violations (both style and component files) ---
    let sm;
    ARBITRARY_PX_RE.lastIndex = 0;
    while ((sm = ARBITRARY_PX_RE.exec(line)) !== null) {
      const px = parseInt(sm[1], 10);
      // Allow multiples of 4 (8-base grid; 4 is fine for micro-spacing)
      if (px !== 0 && px % 4 !== 0) {
        violations.push({
          file: rel, line: lineNum,
          rule: 'off-grid-spacing', severity: 'warning',
          message: `Off-grid spacing \`${sm[0].trim()}\` (${px}px is not a multiple of 4) — use a spacing token`,
          excerpt: trimmed.slice(0, 120),
        });
      }
    }
  });

  return violations;
}

function lintPath(targetPath, root) {
  const abs = path.resolve(root, targetPath);
  const st  = safeStat(abs);
  if (!st) return { error: `Path not found: ${targetPath}` };

  const filesToLint = [];

  if (st.isFile()) {
    const name = path.basename(abs).toLowerCase();
    if (!shouldSkipFile(name)) {
      filesToLint.push({ abs, rel: path.relative(root, abs).replace(/\\/g, '/') });
    }
  } else if (st.isDirectory()) {
    const allFiles = walkProject(abs);
    for (const f of allFiles) {
      if (COMPONENT_EXTS.has(f.ext) || STYLE_EXTS.has(f.ext)) {
        filesToLint.push({ abs: f.abs, rel: f.rel });
      }
    }
  } else {
    return { error: `Target is not a file or directory: ${targetPath}` };
  }

  const allViolations = [];
  for (const { abs: fileAbs, rel } of filesToLint) {
    allViolations.push(...lintFile(fileAbs, rel));
  }

  return buildLintReport(allViolations, filesToLint.length);
}

function buildLintReport(violations, fileCount) {
  const errors   = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  if (violations.length === 0) {
    return {
      summary: `✓ No violations found in ${fileCount} file(s).`,
      violations: [],
      passed: true,
    };
  }

  const lines = [
    `Found ${errors.length} error(s) and ${warnings.length} warning(s) in ${fileCount} file(s).\n`,
  ];

  // Group by file
  const byFile = {};
  for (const v of violations) {
    if (!byFile[v.file]) byFile[v.file] = [];
    byFile[v.file].push(v);
  }

  for (const [file, vs] of Object.entries(byFile)) {
    lines.push(`### ${file}`);
    for (const v of vs) {
      const icon = v.severity === 'error' ? '✗' : '⚠';
      lines.push(`  ${icon} Line ${v.line}: [${v.rule}] ${v.message}`);
      if (v.excerpt) lines.push(`    \`${v.excerpt}\``);
    }
    lines.push('');
  }

  return {
    summary: lines.join('\n'),
    violations,
    passed: false,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'design-spec',
  version: '1.2.0',
});

// --- Tool 1: design_context ---
server.registerTool(
  'design_context',
  {
    description:
      'Returns relevant design rules (from DESIGN.md) and real code examples for a UI task. ' +
      'Call this before writing any UI code so you match existing patterns.',
    inputSchema: {
      task: z.string().describe(
        'Describe the UI task you are about to implement. ' +
        'E.g. "add a nav item to the sidebar", "create a new modal", "style a data table".'
      ),
      project_root: z.string().optional().describe(
        'Absolute path to the project root. Defaults to the current working directory.'
      ),
    },
  },
  async ({ task, project_root }) => {
    try {
      const context = await buildContext(task, project_root);
      return {
        content: [{ type: 'text', text: context }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `design_context error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 2: design_lint ---
server.registerTool(
  'design_lint',
  {
    description:
      'Scans a file or directory for design violations: hard-coded colors, off-grid spacing, ' +
      'Tailwind arbitrary color values. Returns a report with file + line references.',
    inputSchema: {
      target: z.string().describe(
        'File or directory path to lint (relative to project_root or absolute). ' +
        'E.g. "src/components/Button.tsx" or "src/components".'
      ),
      project_root: z.string().optional().describe(
        'Absolute path to the project root. Defaults to the current working directory.'
      ),
    },
  },
  async ({ target, project_root }) => {
    try {
      const root   = project_root || process.cwd();
      const report = lintPath(target, root);

      if (report.error) {
        return {
          content: [{ type: 'text', text: `design_lint error: ${report.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: report.summary }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `design_lint error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env._DS_MCP_TEST !== '1') {
  main().catch((err) => {
    process.stderr.write(`[design-spec-mcp] fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// Export helpers for testing
module.exports = { buildContext, lintPath, buildLintReport };
