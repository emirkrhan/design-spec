#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require("openai");
const inquirer = require("inquirer");
const { default: ora } = require("ora");

// ---------------------------------------------------------------------------
// API key management
// Priority:
//   1. process.env.OPENAI_API_KEY (shell export) → use silently
//   2. .env* files in cwd              → found, ask confirmation
//   3. ~/.config/design-spec/config.json → use silently
//   4. None found                      → prompt, save to global config
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.config', 'design-spec');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const ENV_FILE_CANDIDATES = [
  '.env.local',
  '.env.development.local',
  '.env.production.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env',
];

function readGlobalConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeGlobalConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function findKeyInEnvFiles(cwd) {
  for (const filename of ENV_FILE_CANDIDATES) {
    const filePath = path.join(cwd, filename);
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
        if (match) {
          const key = match[1].trim().replace(/^["']|["']$/g, '');
          if (key) return { key, file: filename };
        }
      }
    } catch {
      // file doesn't exist or unreadable, skip
    }
  }
  return null;
}

async function resolveApiKey(cwd) {
  // 1. Shell environment variable — use silently
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  // 2. .env* files — found, ask confirmation
  const envMatch = findKeyInEnvFiles(cwd);
  if (envMatch) {
    const { use } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'use',
        message: `Found OPENAI_API_KEY in ${envMatch.file}. Use it?`,
        default: true,
      },
    ]);
    if (use) return envMatch.key;
  }

  // 3. Global config — use silently
  const config = readGlobalConfig();
  if (config.openaiApiKey) {
    return config.openaiApiKey;
  }

  // 4. Nothing found — prompt and save
  console.log('  No OpenAI API key found.\n');
  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Paste your OpenAI API key:',
      validate: (v) => v && v.trim().startsWith('sk-') ? true : 'Key must start with sk-',
    },
  ]);

  const trimmed = apiKey.trim();
  writeGlobalConfig({ ...config, openaiApiKey: trimmed });
  console.log(`  Key saved to ${CONFIG_FILE}\n`);

  return trimmed;
}

let client;

// A single-file CLI that collects a minimal, high-value UI context payload
// from the current working directory (assumed to be a frontend project).
//
// It intentionally does NOT call any network / LLM provider. It outputs a
// compact payload you can paste into an LLM to generate a project-specific
// design manifesto.

const DEFAULTS = {
  outputFile: 'DESIGN.md',
  maxFiles: 8, // component files
  maxChars: 2000, // per snippet default
  maxTotalChars: 20000, // payload hard cap
  maxFileSizeBytes: 200 * 1024, // 200KB
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'out',
  'coverage',
  '.turbo',
  '.vercel',
  '.cache',
  '.yarn',
  '.pnpm',
  // Angular
  '.angular',
  // Nx monorepo
  '.nx',
  // Vite
  '.vite',
  // Generic build outputs
  'tmp',
  'temp',
  '__pycache__',
  '.sass-cache',
  'generated',
  'gen',
  // iOS / Android (Ionic, Capacitor, React Native)
  'ios',
  'android',
  'platforms',
  'www',
  // Storybook
  'storybook-static',
]);

const SKIP_FILE_EXACT = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
]);

const SKIP_FILE_PARTS = [
  '.test.',
  '.spec.',
  '.stories.',
  '.story.',
  '.snap.',
  '.min.',
  '.d.ts',
];

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico',
  '.mp4', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.flac',
  '.zip', '.gz', '.tgz', '.rar', '.7z',
  '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

const COMPONENT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html']);
const STYLE_EXTS = new Set(['.css', '.scss']);
const KNOWN_TEXT_EXTS = new Set([
  ...COMPONENT_EXTS,
  ...STYLE_EXTS,
  '.json', '.cjs', '.mjs', '.mts', '.cts',
]);

const GLOBAL_STYLE_BASENAMES = [
  // higher first
  'globals',
  'global',
  'styles',
  'style',
  'main',
  'app',
  'index',
  'tailwind',
  'theme',
  'variables',
  'tokens',
];

const COMPONENT_MATCHERS = [
  { key: 'button', label: 'Button', weight: 60 },
  { key: 'btn', label: 'Button', weight: 58 },
  { key: 'input', label: 'Input', weight: 55 },
  { key: 'field', label: 'Input', weight: 52 },
  { key: 'card', label: 'Card', weight: 50 },
  { key: 'layout', label: 'Layout', weight: 48 },
  { key: 'navbar', label: 'Nav', weight: 45 },
  { key: 'nav', label: 'Nav', weight: 42 },
  { key: 'header', label: 'Header', weight: 40 },
  { key: 'footer', label: 'Footer', weight: 40 },
  { key: 'sidebar', label: 'Sidebar', weight: 38 },
  { key: 'drawer', label: 'Sidebar', weight: 36 },
  { key: 'modal', label: 'Modal', weight: 38 },
  { key: 'dialog', label: 'Modal', weight: 37 },
  { key: 'table', label: 'Table', weight: 35 },
  { key: 'list', label: 'List', weight: 34 },
  { key: 'form', label: 'Form', weight: 35 },
  { key: 'select', label: 'Select', weight: 33 },
  { key: 'dropdown', label: 'Select', weight: 32 },
  { key: 'badge', label: 'Badge', weight: 30 },
  { key: 'tag', label: 'Badge', weight: 28 },
  { key: 'chip', label: 'Badge', weight: 28 },
  { key: 'alert', label: 'Alert', weight: 30 },
  { key: 'toast', label: 'Alert', weight: 29 },
  { key: 'notification', label: 'Alert', weight: 28 },
  { key: 'tab', label: 'Tabs', weight: 32 },
  { key: 'tabs', label: 'Tabs', weight: 33 },
  { key: 'pagination', label: 'Pagination', weight: 30 },
  { key: 'breadcrumb', label: 'Breadcrumb', weight: 28 },
  { key: 'avatar', label: 'Avatar', weight: 28 },
  { key: 'icon', label: 'Icon', weight: 25 },
  { key: 'spinner', label: 'Spinner', weight: 25 },
  { key: 'loader', label: 'Spinner', weight: 24 },
  { key: 'skeleton', label: 'Spinner', weight: 24 },
  { key: 'tooltip', label: 'Tooltip', weight: 27 },
  { key: 'popover', label: 'Tooltip', weight: 26 },
  { key: 'menu', label: 'Menu', weight: 30 },
  { key: 'accordion', label: 'Accordion', weight: 28 },
  { key: 'collapse', label: 'Accordion', weight: 27 },
  { key: 'grid', label: 'Grid', weight: 28 },
  { key: 'container', label: 'Layout', weight: 27 },
  { key: 'wrapper', label: 'Layout', weight: 25 },
  { key: 'section', label: 'Layout', weight: 25 },
  { key: 'page', label: 'Page', weight: 22 },
];

function stderr(msg) {
  process.stderr.write(String(msg) + '\n');
}

function normalizeRel(p) {
  return p.split(path.sep).join('/');
}

function safeStat(abs) {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name);
}

function shouldSkipFileName(nameLower) {
  if (SKIP_FILE_EXACT.has(nameLower)) return true;
  return SKIP_FILE_PARTS.some(part => nameLower.includes(part));
}

function parseArgs(argv) {
  const opts = {
    outputFile: DEFAULTS.outputFile,
    maxFiles: DEFAULTS.maxFiles,
    maxChars: DEFAULTS.maxChars,
    maxTotalChars: DEFAULTS.maxTotalChars,
    maxFileSizeBytes: DEFAULTS.maxFileSizeBytes,
    force: false,
    provider: null,
    help: false,
    subcommand: null, // 'patch'
    patchTarget: null,
  };

  const getValue = (i) => {
    const a = argv[i];
    if (!a) return null;
    const eq = a.indexOf('=');
    if (eq !== -1) return a.slice(eq + 1);
    return argv[i + 1] ?? null;
  };

  // Parse subcommand first
  if (argv[0] === 'patch') {
    opts.subcommand = 'patch';
    opts.patchTarget = argv[1] || null;
    return opts;
  }

  if (argv[0] === 'add') {
    opts.subcommand = 'add';
    return opts;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }

    if (a === '--force' || a === '-f') {
      opts.force = true;
      continue;
    }

    if (a === '--max-files' || a.startsWith('--max-files=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) opts.maxFiles = Math.floor(n);
      continue;
    }

    if (a === '--max-chars' || a.startsWith('--max-chars=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      const n = Number(v);
      if (Number.isFinite(n) && n > 100) opts.maxChars = Math.floor(n);
      continue;
    }

    if (a === '--provider' || a.startsWith('--provider=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      opts.provider = v || null;
      continue;
    }

    if (a === '--output' || a.startsWith('--output=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      if (v) opts.outputFile = v;
      continue;
    }

    // Optional knobs (not required, but helpful for tuning)
    if (a === '--max-total-chars' || a.startsWith('--max-total-chars=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      const n = Number(v);
      if (Number.isFinite(n) && n > 1000) opts.maxTotalChars = Math.floor(n);
      continue;
    }

    if (a === '--max-file-size' || a.startsWith('--max-file-size=')) {
      const v = getValue(i);
      if (!a.includes('=')) i++;
      const n = Number(v);
      if (Number.isFinite(n) && n > 1024) opts.maxFileSizeBytes = Math.floor(n);
      continue;
    }
  }

  return opts;
}

function printHelp() {
  const msg = `
design-spec

Commands:
  design-spec                     Generate DESIGN.md for this project
  design-spec patch <file>        Extract new patterns from a file and add them to DESIGN.md

Options:
  --max-files <n>        Max component files to include (default: ${DEFAULTS.maxFiles}, increase for larger projects)
  --max-chars <n>        Max characters per snippet (default: ${DEFAULTS.maxChars})
  --max-total-chars <n>  Hard cap for entire payload (default: ${DEFAULTS.maxTotalChars})
  --max-file-size <n>    Skip files larger than n bytes (default: ${DEFAULTS.maxFileSizeBytes})
  --force, -f            Overwrite DESIGN.md if it exists
  --output <file>        Output filename (default: DESIGN.md)
  --help, -h             Show help
`;
  process.stdout.write(msg.trimStart());
}

function walkProject(root, opts) {
  const out = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      stderr(`[warn] cannot read dir: ${normalizeRel(path.relative(root, dir)) || '.'} (${e.message})`);
      return;
    }

    for (const ent of entries) {
      const name = ent.name;
      const abs = path.join(dir, name);

      if (ent.isSymbolicLink()) continue;

      if (ent.isDirectory()) {
        if (shouldSkipDir(name)) continue;
        walk(abs);
        continue;
      }

      if (!ent.isFile()) continue;

      const nameLower = name.toLowerCase();
      if (shouldSkipFileName(nameLower)) continue;

      const ext = path.extname(nameLower);
      if (BINARY_EXTS.has(ext)) continue;
      if (!KNOWN_TEXT_EXTS.has(ext)) continue;

      const st = safeStat(abs);
      if (!st || !st.isFile()) continue;
      if (st.size <= 0) continue;
      if (st.size > opts.maxFileSizeBytes) continue;

      const rel = normalizeRel(path.relative(root, abs));
      const base = path.basename(nameLower, ext);
      const depth = rel ? rel.split('/').length - 1 : 0;

      out.push({ abs, rel, name: nameLower, ext, base, size: st.size, depth });
    }
  };

  walk(root);
  return out;
}

function pickBest(candidates, scoreFn) {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestScore = scoreFn(best);
  for (let i = 1; i < candidates.length; i++) {
    const s = scoreFn(candidates[i]);
    if (s > bestScore) {
      best = candidates[i];
      bestScore = s;
    }
  }
  return best;
}

function selectTailwindConfig(files) {
  const candidates = files.filter(f => f.name.startsWith('tailwind.config.'));
  return pickBest(candidates, (f) => {
    let s = 0;
    if (f.depth === 0) s += 100;
    if (f.ext === '.js') s += 50;
    else if (f.ext === '.ts') s += 48;
    else if (f.ext === '.cjs') s += 45;
    else if (f.ext === '.mjs') s += 42;
    else s += 30;
    s += Math.max(0, 20 - f.depth * 3);
    return s;
  });
}

function selectPackageJson(root, files, opts) {
  const rootPkg = path.join(root, 'package.json');
  const st = safeStat(rootPkg);
  if (st && st.isFile() && st.size <= opts.maxFileSizeBytes) {
    return { abs: rootPkg, rel: 'package.json' };
  }

  const candidates = files.filter(f => f.name === 'package.json');
  const best = pickBest(candidates, (f) => 100 - f.depth * 5);
  if (!best) return null;
  return { abs: best.abs, rel: best.rel };
}

function readUtf8(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function sortObjectKeys(obj) {
  const keys = Object.keys(obj || {}).sort((a, b) => a.localeCompare(b));
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function extractPackageDeps(pkgAbs, maxChars) {
  try {
    const raw = readUtf8(pkgAbs);
    const json = JSON.parse(raw);
    const deps = sortObjectKeys(json.dependencies || {});
    const devDeps = sortObjectKeys(json.devDependencies || {});

    const snippetObj = { dependencies: deps, devDependencies: devDeps };
    let snippet = JSON.stringify(snippetObj, null, 2);

    if (snippet.length > maxChars) {
      snippet = snippet.slice(0, maxChars);
      snippet += '\n... [truncated]';
    }

    return snippet;
  } catch (e) {
    try {
      const raw = readUtf8(pkgAbs);
      let snippet = raw.slice(0, maxChars);
      if (raw.length > maxChars) snippet += '\n... [truncated]';
      return snippet;
    } catch {
      return `/* failed to read package.json: ${e.message} */`;
    }
  }
}

function scoreGlobalStyleFile(f) {
  let s = 0;

  const baseIdx = GLOBAL_STYLE_BASENAMES.indexOf(f.base);
  if (baseIdx !== -1) s += 100 - baseIdx * 6;

  if (f.name.includes('.module.')) s -= 25;

  if (f.rel.includes('/styles/')) s += 18;
  if (f.rel.includes('/style/')) s += 10;
  if (f.rel.includes('/src/')) s += 10;
  if (f.rel.includes('/app/')) s += 8;

  s += Math.max(0, 25 - f.depth * 4);

  if (f.ext === '.css') s += 4;

  return s;
}

function selectGlobalStyles(files, limit) {
  const candidates = files.filter(f => STYLE_EXTS.has(f.ext));

  const ranked = candidates
    .map(f => ({ f, score: scoreGlobalStyleFile(f) }))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const item of ranked) {
    if (selected.length >= limit) break;
    const dup = selected.some(x => x.base === item.f.base && x.ext === item.f.ext);
    if (dup) continue;
    selected.push(item.f);
  }

  return selected;
}

function classifyComponent(baseLower) {
  for (const m of COMPONENT_MATCHERS) {
    if (baseLower === m.key) return m;
    if (baseLower.startsWith(m.key)) return m;
    if (baseLower.endsWith(m.key)) return m;
    if (baseLower.includes(m.key)) return m;
  }
  return null;
}

function scoreComponentFile(f, match) {
  let s = match ? match.weight : 0;

  if (f.rel.includes('/components/')) s += 30;
  if (f.rel.includes('/component/')) s += 18;
  if (f.rel.includes('/ui/')) s += 20;
  if (f.rel.includes('/src/')) s += 10;

  if (f.ext === '.tsx') s += 20;
  else if (f.ext === '.jsx') s += 18;
  else if (f.ext === '.vue') s += 20;   // SFC: template + styles in one file
  else if (f.ext === '.svelte') s += 20; // SFC: template + styles in one file
  else if (f.ext === '.html') s += 18;   // Angular/plain templates: pure markup
  else if (f.ext === '.ts') s += 15;
  else if (f.ext === '.js') s += 12;

  if (f.size >= 300 && f.size <= 12_000) s += 10;
  if (f.size > 50_000) s -= 25;

  s += Math.max(0, 20 - f.depth * 3);

  return s;
}

function isSharedComponent(f) {
  return (
    f.rel.includes('/shared/') ||
    f.rel.includes('/common/') ||
    f.rel.includes('/core/') ||
    f.rel.includes('/ui/') ||
    f.rel.includes('/primitives/')
  );
}

function selectComponents(files, limit) {
  const selectedAbsPaths = new Set();
  const selected = [];

  // Pass 1: name-matched components (existing logic)
  const candidates = [];
  for (const f of files) {
    if (!COMPONENT_EXTS.has(f.ext)) continue;
    if (f.name.endsWith('.config.js') || f.name.endsWith('.config.ts')) continue;
    const match = classifyComponent(f.base);
    if (!match) continue;
    candidates.push({ f, match, score: scoreComponentFile(f, match) });
  }
  candidates.sort((a, b) => b.score - a.score);

  const labelCounts = {};
  for (const item of candidates) {
    if (selected.length >= limit) break;
    const label = item.match.label;
    const count = labelCounts[label] || 0;
    if (count >= 2) continue;
    selected.push(item);
    selectedAbsPaths.add(item.f.abs);
    labelCounts[label] = count + 1;
  }

  // Pass 2: fallback — pick UI-rich files from /components/ that name-matching missed.
  // These are page-level or feature components that contain real HTML patterns.
  if (selected.length < limit) {
    const fallbackCandidates = [];

    for (const f of files) {
      if (!COMPONENT_EXTS.has(f.ext)) continue;
      if (f.name.endsWith('.config.js') || f.name.endsWith('.config.ts')) continue;
      if (selectedAbsPaths.has(f.abs)) continue;
      // Must be inside a components or pages-like directory
      if (
        !f.rel.includes('/components/') &&
        !f.rel.includes('/component/') &&
        !f.rel.includes('/views/') &&
        !f.rel.includes('/pages/') &&
        !f.rel.includes('/features/') &&
        !f.rel.includes('/modules/')
      ) continue;
      // Size sweet spot: big enough to have real markup, small enough to be readable
      if (f.size < 500 || f.size > 20_000) continue;

      let score = 0;
      if (f.ext === '.tsx') score += 20;
      else if (f.ext === '.jsx') score += 18;
      else if (f.ext === '.vue') score += 20;
      else if (f.ext === '.svelte') score += 20;
      else if (f.ext === '.html') score += 18;
      else if (f.ext === '.js') score += 12;
      else if (f.ext === '.ts') score += 10;
      // Prefer larger files — more HTML patterns
      score += Math.min(20, Math.floor(f.size / 1000));
      score += Math.max(0, 15 - f.depth * 2);

      fallbackCandidates.push({ f, match: { label: 'Component' }, score });
    }

    fallbackCandidates.sort((a, b) => b.score - a.score);

    for (const item of fallbackCandidates) {
      if (selected.length >= limit) break;
      selected.push(item);
      selectedAbsPaths.add(item.f.abs);
    }
  }

  return selected;
}

function truncateText(text, maxChars, marker) {
  if (text.length <= maxChars) return text;
  const m = marker || '... [truncated]';
  const cut = Math.max(0, maxChars - (m.length + 1));
  return text.slice(0, cut) + '\n' + m;
}

function stripEmptyEdges(s) {
  return String(s || '').replace(/\s+$/g, '').replace(/^\s+\n/g, '');
}

function extractComponentSnippet(abs, maxChars) {
  let text;
  try {
    text = readUtf8(abs);
  } catch (e) {
    return `/* failed to read file: ${e.message} */`;
  }

  text = text.replace(/\r\n/g, '\n');

  const patterns = [
    /export\s+default\s+(function|class)?\b/g,
    /export\s+function\s+[A-Za-z0-9_]+\s*\(/g,
    /export\s+const\s+[A-Za-z0-9_]+\b[^=]*=\s*/g,
    /function\s+[A-Za-z0-9_]+\s*\(/g,
    /const\s+[A-Za-z0-9_]+\b[^=]*=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>)/g,
    /class\s+[A-Za-z0-9_]+\s*extends\s+/g,
  ];

  let start = 0;
  let bestIdx = Infinity;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && typeof m.index === 'number' && m.index < bestIdx) {
      bestIdx = m.index;
    }
  }

  if (bestIdx !== Infinity) {
    start = bestIdx;

    const windowBefore = 500;
    const minStart = Math.max(0, start - windowBefore);
    const blankBlock = text.lastIndexOf('\n\n', start);
    if (blankBlock !== -1 && blankBlock >= minStart) {
      start = blankBlock + 2;
    } else {
      start = minStart;
    }
  }

  const sliced = text.slice(start);
  return truncateText(stripEmptyEdges(sliced), maxChars);
}

// ---------------------------------------------------------------------------
// Static frequency analysis
// ---------------------------------------------------------------------------

// Extracts hex colors, rgb/hsl literals, and CSS custom properties from a
// single file's text. Returns arrays of raw string matches (not deduplicated).
function extractColorsFromText(text) {
  const colors = [];

  // hex: #abc, #aabbcc, #aabbccdd
  const hexRe = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m;
  while ((m = hexRe.exec(text)) !== null) colors.push(m[0].toLowerCase());

  // rgb() / rgba() / hsl() / hsla()
  const funcRe = /\b(rgba?|hsla?)\s*\([^)]{3,60}\)/g;
  while ((m = funcRe.exec(text)) !== null) colors.push(m[0].replace(/\s+/g, ''));

  // CSS custom properties used as values: var(--foo)
  const varRe = /var\(\s*(--[\w-]+)\s*\)/g;
  while ((m = varRe.exec(text)) !== null) colors.push(m[1]);

  return colors;
}

// Extracts CSS custom property *definitions* from style text: --foo: value
function extractCSSVarDefinitions(text) {
  const defs = {};
  const re = /(--[\w-]+)\s*:\s*([^;}{]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    const value = m[2].trim();
    // Only keep color-looking values
    if (
      value.startsWith('#') ||
      /^(rgb|rgba|hsl|hsla)\s*\(/.test(value) ||
      /^(transparent|currentColor|inherit|initial)$/.test(value)
    ) {
      defs[name] = value;
    }
  }
  return defs;
}

// Extracts CSS class *definitions* from style text: .foo { ... }
function extractClassDefinitions(text) {
  const classes = new Set();
  // Match .classname (not :pseudo, not .module-style, not keyframe %)
  const re = /\.([a-zA-Z_-][a-zA-Z0-9_-]+)\s*[{,\s:]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cls = m[1];
    // Skip Angular/BEM-style private classes starting with ng- or _
    if (cls.startsWith('ng-')) continue;
    classes.add(cls);
  }
  return classes;
}

// Counts how many files reference each CSS class name (via className=, class=, or bare usage in templates)
function countClassUsageAcrossFiles(allFiles, definedClasses, opts) {
  const counts = {};
  for (const cls of definedClasses) counts[cls] = 0;

  const templateExts = new Set(['.html', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts']);

  for (const f of allFiles) {
    if (!templateExts.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;

    let text;
    try {
      text = readUtf8(f.abs);
    } catch {
      continue;
    }

    for (const cls of definedClasses) {
      // Match class="... foo ..." or className="... foo ..." or [class]="..." or class:foo
      // Simple word-boundary check is fast and accurate enough for this purpose
      if (text.includes(cls)) {
        counts[cls]++;
      }
    }
  }

  return counts;
}

// Builds the static analysis summary section for the AI payload
function buildStaticAnalysis(allFiles, opts) {
  // 1. Collect CSS variable definitions from all style files
  const cssVarDefs = {}; // name -> value
  for (const f of allFiles) {
    if (!STYLE_EXTS.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;
    let text;
    try { text = readUtf8(f.abs); } catch { continue; }
    Object.assign(cssVarDefs, extractCSSVarDefinitions(text));
  }

  // 2. Collect all hex/rgb colors used across style AND template files
  //    key: normalized color string, value: Set of file rels
  const colorFileMap = {}; // color -> Set<rel>
  const styleAndTemplateExts = new Set(['.css', '.scss', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts']);

  for (const f of allFiles) {
    if (!styleAndTemplateExts.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;
    let text;
    try { text = readUtf8(f.abs); } catch { continue; }
    const colors = extractColorsFromText(text);
    for (const c of colors) {
      if (!colorFileMap[c]) colorFileMap[c] = new Set();
      colorFileMap[c].add(f.rel);
    }
  }

  // 3. Collect CSS class definitions from style files
  const definedClasses = new Set();
  for (const f of allFiles) {
    if (!STYLE_EXTS.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;
    let text;
    try { text = readUtf8(f.abs); } catch { continue; }
    for (const cls of extractClassDefinitions(text)) definedClasses.add(cls);
  }

  // 4. Count usage of each defined class across template files
  const classCounts = countClassUsageAcrossFiles(allFiles, definedClasses, opts);

  // --- Build the summary text ---
  const lines = [];

  // Colors: only those used in 2+ files (single-use colors are noise)
  const colorEntries = Object.entries(colorFileMap)
    .filter(([, files]) => files.size >= 2)
    .sort((a, b) => b[1].size - a[1].size);

  if (colorEntries.length > 0) {
    lines.push('## Color Usage (used in 2+ files)');
    // Check for conflicts: same raw hex used alongside a CSS var that resolves to same value
    const hexToVars = {}; // hex -> [var names that equal this hex]
    for (const [varName, varValue] of Object.entries(cssVarDefs)) {
      const norm = varValue.toLowerCase();
      if (!hexToVars[norm]) hexToVars[norm] = [];
      hexToVars[norm].push(varName);
    }

    for (const [color, files] of colorEntries.slice(0, 30)) {
      const fileCount = files.size;
      // Is this a var(--x) reference?
      if (color.startsWith('--')) {
        const def = cssVarDefs[color];
        lines.push(`- ${color}${def ? ` (= ${def})` : ''} — ${fileCount} files`);
        continue;
      }
      // Is this a raw hex that also has a CSS var equivalent? → conflict
      const norm = color.toLowerCase();
      const matchingVars = hexToVars[norm] || [];
      if (matchingVars.length > 0) {
        lines.push(`- ${color} — ${fileCount} files ⚠️ CONFLICT: also used as ${matchingVars.join(', ')}`);
      } else {
        lines.push(`- ${color} — ${fileCount} files`);
      }
    }
    lines.push('');
  }

  // CSS variable definitions (color tokens)
  if (Object.keys(cssVarDefs).length > 0) {
    lines.push('## CSS Color Tokens (defined in stylesheets)');
    for (const [name, value] of Object.entries(cssVarDefs).slice(0, 40)) {
      lines.push(`- ${name}: ${value}`);
    }
    lines.push('');
  }

  // Global classes: only those used in 3+ files
  const multiUseClasses = Object.entries(classCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1]);

  if (multiUseClasses.length > 0) {
    lines.push('## Global CSS Classes (used in 3+ files)');
    for (const [cls, count] of multiUseClasses.slice(0, 40)) {
      lines.push(`- .${cls} — ${count} files`);
    }
    lines.push('');
  }

  // Single-use classes — these are likely scoped/local, flag them
  const singleUseClasses = Object.entries(classCounts)
    .filter(([, count]) => count === 1)
    .map(([cls]) => cls);

  if (singleUseClasses.length > 0) {
    lines.push(`## Single-use CSS Classes (likely scoped — ${singleUseClasses.length} total, sample below)`);
    lines.push(singleUseClasses.slice(0, 20).map(c => `.${c}`).join(', '));
    lines.push('');
  }

  // Custom class prefixes: detect project-specific helper class families
  // (e.g. theme-*, btn-*, text-display-*) that appear in 2+ files.
  // These are NOT Tailwind utilities and NOT standard CSS — they're project conventions.
  const knownFrameworkPrefixes = new Set([
    // Tailwind
    'bg-', 'text-', 'border-', 'flex', 'grid', 'gap-', 'p-', 'px-', 'py-', 'pt-', 'pb-', 'pl-', 'pr-',
    'm-', 'mx-', 'my-', 'mt-', 'mb-', 'ml-', 'mr-', 'w-', 'h-', 'min-', 'max-',
    'rounded', 'shadow', 'opacity', 'overflow', 'cursor-', 'pointer-', 'select-',
    'font-', 'leading-', 'tracking-', 'align-', 'justify-', 'items-', 'content-',
    'self-', 'place-', 'col-', 'row-', 'sr-', 'not-', 'space-', 'divide-',
    'ring-', 'outline-', 'transition', 'duration-', 'ease-', 'delay-',
    'scale-', 'rotate-', 'translate-', 'skew-', 'transform',
    'z-', 'top-', 'right-', 'bottom-', 'left-', 'inset-', 'static', 'fixed',
    'absolute', 'relative', 'sticky', 'hidden', 'block', 'inline', 'table',
    'hover:', 'focus:', 'active:', 'disabled:', 'dark:', 'md:', 'lg:', 'xl:', 'sm:', '2xl:',
    // Bootstrap
    'd-', 'col-', 'row-', 'btn-', 'alert-', 'badge-', 'nav-', 'navbar-',
    // Angular Material / PrimeNG
    'mat-', 'p-', 'ng-',
  ]);

  const prefixFileMap = {}; // prefix -> Set<rel>
  const wordRe = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g; // hyphenated tokens only

  const templateExtsForPrefixes = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html']);
  for (const f of allFiles) {
    if (!templateExtsForPrefixes.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;
    let text;
    try { text = readUtf8(f.abs); } catch { continue; }

    // Extract all hyphenated class-like tokens from the file
    let m;
    wordRe.lastIndex = 0;
    while ((m = wordRe.exec(text)) !== null) {
      const token = m[0];
      // Get the prefix (everything up to and including the first dash)
      const dashIdx = token.indexOf('-');
      if (dashIdx < 1) continue;
      const prefix = token.slice(0, dashIdx + 1);
      // Skip if it's a known framework prefix
      if (knownFrameworkPrefixes.has(prefix)) continue;
      // Skip short prefixes that are likely noise
      if (prefix.length < 3) continue;
      if (!prefixFileMap[prefix]) prefixFileMap[prefix] = new Set();
      prefixFileMap[prefix].add(f.rel);
    }
  }

  const customPrefixes = Object.entries(prefixFileMap)
    .filter(([, files]) => files.size >= 2)
    .sort((a, b) => b[1].size - a[1].size);

  if (customPrefixes.length > 0) {
    lines.push('## Custom Class Prefixes (project-specific, used in 2+ files)');
    lines.push('These are NOT Tailwind utilities. Document their purpose based on usage.');
    for (const [prefix, files] of customPrefixes.slice(0, 20)) {
      lines.push(`- ${prefix}* — ${files.size} files`);
    }
    lines.push('');
  }

  // Loading patterns: count how many files use each approach so AI can determine
  // which is the "default" and which is situational.
  const loadingPatterns = {
    // Dedicated skeleton component (named *Skeleton or *TableSkeleton etc.)
    skeletonComponent: [],
    // Inline animate-pulse divs (manual skeleton without a component)
    animatePulse: [],
    // isLoading / loading boolean flag driving conditional render
    loadingFlag: [],
    // Spinner component or spinner class
    spinner: [],
  };

  const componentExtsForLoading = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html']);
  for (const f of allFiles) {
    if (!componentExtsForLoading.has(f.ext)) continue;
    if (f.size > opts.maxFileSizeBytes) continue;
    let text;
    try { text = readUtf8(f.abs); } catch { continue; }

    // Each file counted once per pattern type
    if (/\bSkeleton\b/.test(text) && !/function\s+\w*Skeleton/.test(text)) {
      // Uses a skeleton *component* (references it, not defines it)
      loadingPatterns.skeletonComponent.push(f.rel);
    }
    if (/animate-pulse/.test(text)) {
      loadingPatterns.animatePulse.push(f.rel);
    }
    if (/\bisLoading\b|\bloading\b/.test(text)) {
      loadingPatterns.loadingFlag.push(f.rel);
    }
    if (/[Ss]pinner/.test(text)) {
      loadingPatterns.spinner.push(f.rel);
    }
  }

  const loadingEntries = [
    ['Skeleton component (e.g. <XxxSkeleton />)', loadingPatterns.skeletonComponent],
    ['Inline animate-pulse divs', loadingPatterns.animatePulse],
    ['isLoading / loading boolean flag', loadingPatterns.loadingFlag],
    ['Spinner component', loadingPatterns.spinner],
  ].filter(([, files]) => files.length > 0)
   .sort((a, b) => b[1].length - a[1].length);

  if (loadingEntries.length > 0) {
    lines.push('## Loading Patterns (frequency = how many files use each)');
    for (const [label, files] of loadingEntries) {
      lines.push(`- ${label}: ${files.length} files`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function detectFrameworksFromDeps(depsObj) {
  const detected = new Set();
  const deps = Object.assign({}, depsObj.dependencies || {}, depsObj.devDependencies || {});
  const keys = Object.keys(deps);

  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  if (has('tailwindcss')) detected.add('tailwind');

  if (has('bootstrap') || has('react-bootstrap') || has('bootstrap-vue') || has('bootstrap-vue-3')) {
    detected.add('bootstrap');
  }

  if (keys.some(k => k.startsWith('@mui/') || k.startsWith('@material-ui/')) || has('material-ui')) {
    detected.add('mui');
  }

  if (has('styled-components')) detected.add('styled-components');

  if (has('sass') || has('node-sass')) detected.add('scss');
  if (has('less')) detected.add('less');

  return detected;
}

function detectFrameworks({ depsSnippetObj, tailwindConfig, globalStyles, files }) {
  const detected = new Set();

  const fromDeps = detectFrameworksFromDeps(depsSnippetObj || { dependencies: {}, devDependencies: {} });
  for (const x of fromDeps) detected.add(x);

  if (tailwindConfig) detected.add('tailwind');

  if (files.some(f => f.ext === '.scss')) detected.add('scss');
  if (files.some(f => f.ext === '.css')) detected.add('css');

  if (files.some(f => f.ext === '.scss' && (f.name === 'bootstrap.scss' || f.base === 'bootstrap'))) {
    detected.add('bootstrap');
  }

  for (const s of globalStyles) {
    try {
      const preview = readUtf8(s.abs).slice(0, 4000);
      if (preview.includes('@tailwind')) {
        detected.add('tailwind');
        break;
      }
    } catch {
      // ignore
    }
  }

  return detected;
}

function buildPayload({ detected, sections, opts }) {
  const detectedList = Array.from(detected);
  detectedList.sort((a, b) => a.localeCompare(b));

  let out = `DETECTED: ${detectedList.length ? detectedList.join(', ') : 'none'}\n`;

  const addSection = (relPath, reasonTag, content) => {
    const header = `\n=== ${relPath} ===\n[${reasonTag}]\n`;
    const footer = '\n';

    const remaining = opts.maxTotalChars - out.length;
    if (remaining <= 0) return;

    if (header.length + footer.length > remaining) return;

    const contentBudget = remaining - header.length - footer.length;
    const body = truncateText(stripEmptyEdges(content), contentBudget, '... [truncated-to-fit]');

    out += header + body + footer;
  };

  for (const s of sections) {
    addSection(s.rel, s.tag, s.content);
  }

  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function safeWriteFile(outputAbs, content, opts) {
  if (!opts.force && fs.existsSync(outputAbs)) {
    stderr(`[error] ${path.basename(outputAbs)} already exists. Use --force to overwrite.`);
    process.exitCode = 1;
    return false;
  }

  try {
    fs.writeFileSync(outputAbs, content, 'utf8');
    return true;
  } catch (e) {
    stderr(`[error] failed to write ${outputAbs}: ${e.message}`);
    process.exitCode = 1;
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const root = process.cwd();

  const apiKey = await resolveApiKey(root);
  client = new OpenAI({ apiKey });

  if (opts.subcommand === 'patch') {
    await runPatch(root, opts);
    return;
  }

  if (opts.subcommand === 'add') {
    await runAdd(root);
    return;
  }
  const rootStat = safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) {
    stderr('[error] current working directory is not a directory.');
    process.exitCode = 1;
    return;
  }

  // --- Branding ---
  console.log('\n  design-spec\n');

  // --- Questions ---
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'focus',
      message: 'Any area to focus on? (optional, e.g. "colors, spacing, buttons") — press Enter to skip:',
    },
  ]);

  // --- Scan ---
  const scanSpinner = ora('Scanning project...').start();

  const files = walkProject(root, opts);
  const tw = selectTailwindConfig(files);
  const pkg = selectPackageJson(root, files, opts);
  const globalStyles = selectGlobalStyles(files, 4);
  const components = selectComponents(files, opts.maxFiles);

  const sections = [];

  if (tw) {
    const twMax = Math.min(opts.maxChars * 2, 4000);
    let content = '';
    try {
      content = truncateText(readUtf8(tw.abs).replace(/\r\n/g, '\n'), twMax);
    } catch (e) {
      content = `/* failed to read tailwind config: ${e.message} */`;
    }
    sections.push({ rel: tw.rel, tag: 'tailwind-config', content });
  }

  let depsForDetection = { dependencies: {}, devDependencies: {} };
  if (pkg) {
    try {
      const raw = readUtf8(pkg.abs);
      const json = JSON.parse(raw);
      depsForDetection = {
        dependencies: json.dependencies || {},
        devDependencies: json.devDependencies || {},
      };
    } catch {
      // ignore; detection will be weaker
    }
    const content = extractPackageDeps(pkg.abs, opts.maxChars);
    sections.push({ rel: pkg.rel, tag: 'package.json:deps', content });
  }

  for (const s of globalStyles) {
    let content = '';
    try {
      content = truncateText(readUtf8(s.abs).replace(/\r\n/g, '\n'), opts.maxChars);
    } catch (e) {
      content = `/* failed to read style file: ${e.message} */`;
    }
    sections.push({ rel: s.rel, tag: 'global-css', content });
  }

  for (const item of components) {
    let content;
    // Shared/primitive components (button, input, etc.) must be sent in full —
    // their dark mode, disabled states and exact class lists are the most
    // valuable information in the whole payload. Only skip truncation when the
    // file is small enough to not blow the budget (≤ 12 KB).
    const charLimit = isSharedComponent(item.f) && item.f.size <= 12_000
      ? item.f.size * 2   // effectively no truncation for small shared files
      : opts.maxChars;

    if (['.html', '.vue', '.svelte'].includes(item.f.ext)) {
      try {
        const raw = readUtf8(item.f.abs).replace(/\r\n/g, '\n');
        content = truncateText(extractUIContext(raw), charLimit);
      } catch (e) {
        content = `/* failed to read file: ${e.message} */`;
      }
    } else {
      content = extractComponentSnippet(item.f.abs, charLimit);
    }
    sections.push({ rel: item.f.rel, tag: `component:${item.match.label}`, content });
  }

  const detected = detectFrameworks({
    depsSnippetObj: depsForDetection,
    tailwindConfig: tw,
    globalStyles,
    files,
  });

  // Static frequency analysis — runs over all walked files, no extra I/O cost
  const staticAnalysis = buildStaticAnalysis(files, opts);
  if (staticAnalysis.trim()) {
    sections.unshift({ rel: '[static-analysis]', tag: 'color-and-class-frequency', content: staticAnalysis });
  }

  const payload = buildPayload({ detected, sections, opts });

  scanSpinner.succeed(`Scanned ${files.length} files`);

  // --- AI ---
  const aiSpinner = ora('Generating manifesto...').start();
  const outputAbs = path.join(root, opts.outputFile);

  try {
    const result = await generateManifesto(payload, answers.focus, detected);
    const ok = safeWriteFile(outputAbs, result, opts);
    if (ok) {
      aiSpinner.succeed(`DESIGN.md created`);
    } else {
      aiSpinner.fail('Could not write DESIGN.md');
    }
  } catch (e) {
    aiSpinner.fail(`AI call failed: ${e.message}`);
    process.exitCode = 1;
  }
}

async function generateManifesto(context, focus, detected) {
  const focusBlock = focus && focus.trim()
    ? `\nPay extra attention to: ${focus.trim()}\n`
    : '';

  const detectedList = detected ? Array.from(detected).sort().join(', ') : 'unknown';

  const prompt = `You are a strict UI linter analyzing a frontend project's source code.
Your only goal: produce a machine-readable design contract that helps an AI write new UI code consistent with this codebase.
${focusBlock}
Here is the project context (styles, components, config, dependencies):

${context}

---

ABSOLUTE LANGUAGE RULES — enforced for every cell, bullet, and line you write:
- Telegraphic only. No full sentences. No verbs like "use", "ensure", "make sure", "remember to".
- Bad Do: "Primary text on dark surfaces." (too generic — no location)
- Good Do: "Modal headings, sidebar nav labels." (specific UI element or location)
- Bad Don't: "Other dark base colors." (too vague)
- Good Don't: "\`bg-gray-900\`, raw \`#262624\`" (specific wrong alternative)
- Table cells must be ≤ 10 words each.
- NEVER document a token without resolving its actual underlying value (e.g., font-family must show the resolved font name, not just the variable).
- If a distinct UI sub-system is detected (e.g., "Wrap UI" vs standard), define its boundary explicitly (e.g., "Wrap UI = full-screen immersive modes only").
- If two tokens resolve to the same value, their Do cells MUST differ by specific location — never write identical Do cells. That difference IS the tie-breaker for the AI choosing between them.
- ALL code snippets (in any section) MUST use CSS variables (\`var(--token)\`) or Tailwind classes for colors. NEVER write raw hex or RGB in snippets if a project token exists. Contradicting your own anti-patterns inside examples is strictly forbidden.

---

Answer ONLY these five sections. Do not explain framework rules — the AI already knows them. Only document what is project-specific.

---

## 1. Colors & Spacing

Start this section with:
> **Environment Context:** ${detectedList}
> *All tokens below belong to this ecosystem.*

Rules:
- Only tokens actually used in code (not just defined in config).
- Skip one-off values with a single usage.
- Do NOT flag conflicts here — conflicts go in Section 4 only.
- Group standard tokens under subheadings: **Backgrounds**, **Typography**, **Borders**, **Spacing**, **Other**. Omit empty groups.
- If a distinct UI sub-system exists (e.g. tokens prefixed with \`--wrap-\`, \`--modal-\`, \`--admin-\`), isolate them in a SEPARATE table under a subheading named after that sub-system (e.g. "### Wrap UI"). Never mix sub-system tokens with standard tokens in the same table.

**Do column rule:** Must name the SPECIFIC UI element or location where this token is used (e.g. "sidebar background", "modal overlay", "active nav item"). NOT a generic purpose like "dark surface". If you cannot name a specific location, omit the row.
**Don't column rule:** Must name a specific wrong alternative (e.g. "bg-gray-900", "raw #1a1a1a"). NOT a vague negation like "other dark colors".

Each group = one Markdown table:

### Backgrounds
| Token / Class | Resolved Value | Do | Don't |
| :--- | :--- | :--- | :--- |
| \`--bg-primary\` | \`#1a1a1a\` | Sidebar, card body | \`bg-gray-900\`, raw \`#1a1a1a\` |

---

## 2. Global CSS Classes

Rules:
- Only classes that are PROJECT-SPECIFIC overrides or conventions — defined in global stylesheets and used in 2+ files.
- SKIP any class that is a standard Tailwind or CSS utility the framework already knows (\`.hidden\`, \`.border\`, \`.shadow\`, \`.flex\`, etc.). These must be omitted entirely.
- If a class IS a framework utility but has a project-specific override in a global stylesheet, include it and mark it "Project override" in the Structure column.

Output as one Markdown table:

| Class | Structure | Use when | Don't use when |
| :--- | :--- | :--- | :--- |
| \`.app-badge\` | shared badge shell | status labels, counts | custom inline badge |

---

## 3. Recurring UI Patterns

Rules:
- Only patterns appearing in 3+ files.
- Trimmed snippet + one file reference.

Format per pattern:
## [Pattern Name]
- Snippet:
\`\`\`
[trimmed HTML/template]
\`\`\`
- Reference: [filename]
- Do: [telegraphic rule]
- Don't: [telegraphic rule]

---

## 4. Anti-patterns & Conflicts

Rules:
- STRICTLY structural, architectural, or cross-component issues only.
- Do NOT repeat color/token rules from Section 1.
- Color conflicts (token vs raw hex) belong here ONLY if they represent a structural misuse pattern.
- Flag: wrong component used, legacy pattern vs new, Tailwind default used instead of project component.

Format per anti-pattern:
## [Topic]
- Do: [correct approach — telegraphic]
- Don't: [wrong approach] — [one-phrase reason]

---

## 5. Dark Mode

Document the exact mechanism:
- Trigger (class on html/body / media query / data attribute)
- Which variables or classes change
- Steps to add a new dark mode style

If no dark mode: write "No dark mode detected."

Format:
## Dark Mode
- Trigger: [mechanism]
- Snippet — how dark scope is applied (host element or wrapper):
\`\`\`
[shortest real snippet showing the .dark wrapper or host binding from the codebase]
\`\`\`
- SCSS usage example:
\`\`\`scss
.my-component \{ background: var(--bg-primary); \}
.dark .my-component \{ background: var(--bg-secondary); \}
\`\`\`
- Do: [telegraphic steps]
- Don't: [telegraphic rule]

---

GLOBAL RULES:
- Never invent. Only document what exists in the provided code.
- Never write general framework rules.
- If a section has nothing project-specific: "Nothing project-specific found."
- No prose. No preamble. Start directly with ## 1.`;

  const res = await client.chat.completions.create({
    model: "gpt-5.4",
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content;
}

function extractUIContext(code) {
  const lines = code.split('\n');
  const out = [];
  let depth = 0;
  let skipDepth = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Always keep: JSX tags, className, style, return statements, imports of UI libs
    const isJSXLine = /^<|<[A-Z]|className|style=|return\s*\(|return\s*</.test(trimmed);
    const isImport = /^import/.test(trimmed);
    const isTailwindOrStyle = /className=|style=/.test(line);

    // Detect start of pure JS blocks to skip (event handlers, data fetching, etc.)
    const isPureJS = /^(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\()/.test(trimmed)
      || /^async function\s+(?!.*return\s*[(<])/.test(trimmed)
      || /^function\s+\w+.*\{$/.test(trimmed);

    // Count braces to track block depth
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (skipDepth !== null) {
      depth += opens - closes;
      if (depth <= skipDepth) {
        skipDepth = null;
        depth = 0;
      }
      continue;
    }

    if (isPureJS && !isJSXLine && !isTailwindOrStyle) {
      skipDepth = depth;
      depth += opens - closes;
      continue;
    }

    if (isImport || isJSXLine || isTailwindOrStyle || trimmed === '' || trimmed === ')' || trimmed === '};' || trimmed === '}') {
      out.push(line);
    }
  }

  return out.join('\n');
}

const RULE_FILES = [
  { file: 'CLAUDE.md', label: 'Claude Code' },
  { file: '.cursorrules', label: 'Cursor' },
  { file: '.windsurfrules', label: 'Windsurf' },
  { file: '.github/copilot-instructions.md', label: 'GitHub Copilot' },
];

// Strong, specific rule for CLAUDE.md — tells the LLM exactly when to call
// design_context and what to do with the result. Intentionally verbose so
// the LLM cannot "forget" or interpret it loosely.
const CLAUDE_MD_RULE = `
## design-spec (UI consistency)

When creating a **new** UI file (component, page, layout) via the Write tool:
1. Call the \`design_context\` MCP tool with a short description of what you are building.
2. Read the returned rules and code examples carefully.
3. Follow them — same tokens, same structure, same patterns.
4. Do NOT invent new class names, color values, or layout patterns not present in the examples.

When editing an existing file: skip step 1 unless the change introduces new UI patterns.

After any UI change (new or edit): call \`design_lint\` on the modified file.
If lint reports errors, fix them before finishing.
`;

// Weaker reference for non-Claude tools (they don't have MCP)
const GENERIC_RULE = `
## design-spec

Refer to \`DESIGN.md\` in the project root as the source of truth for UI/design conventions.
Follow its token, class, and pattern rules when writing or editing UI code.
`;

// ---------------------------------------------------------------------------
// Hook helpers
// ---------------------------------------------------------------------------

const SETTINGS_PATH_LOCAL  = path.join('.claude', 'settings.json');

function readSettingsJson(settingsAbs) {
  try {
    return JSON.parse(fs.readFileSync(settingsAbs, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettingsJson(settingsAbs, data) {
  const dir = path.dirname(settingsAbs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsAbs, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function hookAlreadyExists(settings) {
  const hooks = settings?.hooks?.PreToolUse;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(h => {
    const cmds = h?.hooks?.map(x => x?.command || '').join(' ') || '';
    return cmds.includes('design_context') || cmds.includes('design-spec');
  });
}

function addWriteHook(settingsAbs) {
  const settings = readSettingsJson(settingsAbs);

  if (hookAlreadyExists(settings)) return false; // already there

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  // Trigger only on Write (new file creation), not Edit
  settings.hooks.PreToolUse.push({
    matcher: 'Write',
    hooks: [
      {
        type: 'command',
        command: 'echo "[design-spec] New file detected — run design_context before writing UI code."',
      },
    ],
  });

  writeSettingsJson(settingsAbs, settings);
  return true;
}

async function runAdd(root) {
  console.log('\n  design-spec add\n');

  // ── Step 1: Rule files ──────────────────────────────────────────────────
  const found = RULE_FILES.filter(({ file }) => fs.existsSync(path.join(root, file)));

  if (found.length === 0) {
    console.log('No LLM rule files found (CLAUDE.md, .cursorrules, etc.)');
    console.log('Create one first, then run "design-spec add" again.\n');
  } else {
    console.log('Found rule files:\n');
    found.forEach(({ file, label }) => console.log(`  ${label}: ${file}`));
    console.log('');

    const { confirmRules } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmRules',
        message: 'Add design-spec rules to these files?',
        default: true,
      },
    ]);

    if (confirmRules) {
      for (const { file, label } of found) {
        const abs     = path.join(root, file);
        const content = readUtf8(abs);
        const isClaude = file === 'CLAUDE.md';
        const marker   = isClaude ? 'design_context' : 'DESIGN.md';

        if (content.includes(marker)) {
          console.log(`  skipped ${file} — already configured`);
          continue;
        }

        const rule = isClaude ? CLAUDE_MD_RULE : GENERIC_RULE;
        try {
          fs.writeFileSync(abs, content.trimEnd() + rule, 'utf8');
          console.log(`  updated ${file}`);
        } catch (e) {
          stderr(`  [error] could not update ${file}: ${e.message}`);
        }
      }
    }
  }

  console.log('');

  // ── Step 2: Write hook (opt-in) ─────────────────────────────────────────
  console.log('  Automatic hook (optional)');
  console.log('  When you create a new file, Claude Code will remind itself to');
  console.log('  call design_context first. This uses a small amount of extra tokens.\n');

  const { confirmHook } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmHook',
      message: 'Install Write hook? (opt-in — adds a small token cost per new file)',
      default: false,
    },
  ]);

  if (confirmHook) {
    const settingsAbs = path.join(root, SETTINGS_PATH_LOCAL);
    try {
      const added = addWriteHook(settingsAbs);
      if (added) {
        console.log(`  hook added → ${SETTINGS_PATH_LOCAL}`);
      } else {
        console.log(`  skipped — hook already exists in ${SETTINGS_PATH_LOCAL}`);
      }
    } catch (e) {
      stderr(`  [error] could not write settings.json: ${e.message}`);
    }
  } else {
    console.log('  Hook skipped. You can always add it later by running "design-spec add" again.');
  }

  console.log('');
  console.log('  Done. design-spec is now integrated into your AI workflow.');
  console.log('  Next time Claude Code creates a new UI file, it will call design_context first.\n');
}

async function runPatch(root, opts) {
  console.log('\n  design-spec patch\n');

  // 1. Read DESIGN.md
  const designFile = path.join(root, opts.outputFile);
  if (!fs.existsSync(designFile)) {
    stderr(`[error] ${opts.outputFile} not found. Run "design-spec" first to generate it.`);
    process.exitCode = 1;
    return;
  }

  // 2. Resolve target file
  if (!opts.patchTarget) {
    stderr('[error] No target file specified. Usage: design-spec patch <file>');
    process.exitCode = 1;
    return;
  }

  const targetAbs = path.resolve(root, opts.patchTarget);
  if (!fs.existsSync(targetAbs)) {
    stderr(`[error] Target file not found: ${opts.patchTarget}`);
    process.exitCode = 1;
    return;
  }

  const st = safeStat(targetAbs);
  if (!st || !st.isFile()) {
    stderr(`[error] Target is not a file: ${opts.patchTarget}`);
    process.exitCode = 1;
    return;
  }

  // 3. Read both files
  let contract, targetCode;
  try {
    contract = readUtf8(designFile);
    targetCode = extractUIContext(readUtf8(targetAbs));
  } catch (e) {
    stderr(`[error] Could not read files: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // 4. Detect module scope from file path (deterministic — no LLM guessing)
  const moduleScope = detectModuleScope(opts.patchTarget);

  // 5. Extract new patterns from target file
  const spinner = ora(`Analyzing ${opts.patchTarget}...`).start();

  let result;
  try {
    result = await extractNewPatterns(contract, targetCode, opts.patchTarget, moduleScope);
    spinner.succeed('Analysis done');
  } catch (e) {
    spinner.fail(`AI call failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // 5. Nothing new found
  const hasChanges = result.section_1_rows?.length
    || result.section_2_rows?.length
    || result.section_3_patterns?.length
    || result.section_4_antipatterns?.length
    || result.section_5_update;

  if (!hasChanges) {
    console.log('\nNo new patterns found. DESIGN.md is already up to date for this file.');
    return;
  }

  // 6. Preview what will be merged
  console.log('\n--- Changes to merge into DESIGN.md ---\n');
  if (result.section_1_rows?.length) {
    console.log(`Section 1 (Colors & Spacing): +${result.section_1_rows.length} row(s)`);
    result.section_1_rows.forEach(r => console.log(`  | ${r.token} | ${r.resolved_value} | ${r.do} | ${r.dont} |`));
  }
  if (result.section_2_rows?.length) {
    console.log(`Section 2 (Global CSS Classes): +${result.section_2_rows.length} row(s)`);
    result.section_2_rows.forEach(r => console.log(`  | ${r.class} | ${r.structure} | ${r.use_when} | ${r.dont_use_when} |`));
  }
  if (result.section_3_patterns?.length) {
    console.log(`Section 3 (Recurring Patterns): +${result.section_3_patterns.length} pattern(s)`);
    result.section_3_patterns.forEach(r => console.log(`  ## ${r.name}`));
  }
  if (result.section_4_antipatterns?.length) {
    console.log(`Section 4 (Anti-patterns): +${result.section_4_antipatterns.length} entry(s)`);
    result.section_4_antipatterns.forEach(r => console.log(`  ## ${r.topic}`));
  }
  if (result.section_5_update) {
    console.log(`Section 5 (Dark Mode): update`);
  }
  console.log('');

  // 7. Ask for confirmation
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Merge these into DESIGN.md?',
      default: true,
    },
  ]);

  if (!confirm) {
    console.log('Aborted. No changes made.');
    return;
  }

  // 8. Merge into DESIGN.md
  try {
    const existing = readUtf8(designFile);
    const updated = mergeIntoDesignDoc(existing, result);
    fs.writeFileSync(designFile, updated, 'utf8');
    console.log(`\nDESIGN.md updated.`);
  } catch (e) {
    stderr(`[error] Could not write DESIGN.md: ${e.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// mergeIntoDesignDoc
// Merges structured patch result into the existing DESIGN.md content.
// Strategy: find each section by its heading marker, insert new content at
// the correct location within that section. Never relies on line numbers —
// only on deterministic heading anchors.
// ---------------------------------------------------------------------------

function mergeIntoDesignDoc(existing, result) {
  let doc = existing;

  // Section 1: append table rows under the correct group subheading,
  // or create a new group if it doesn't exist yet.
  if (result.section_1_rows?.length) {
    for (const row of result.section_1_rows) {
      const group = row.group || 'Other';
      const subheading = `### ${group}`;
      const tableRow = `| \`${row.token}\` | \`${row.resolved_value}\` | ${row.do} | ${row.dont} |`;

      if (doc.includes(subheading)) {
        // Find the end of this group's table (last | ... | line before next heading or end)
        const afterHeading = doc.indexOf(subheading) + subheading.length;
        const nextHeadingMatch = doc.slice(afterHeading).search(/\n##/);
        const sectionEnd = nextHeadingMatch === -1
          ? doc.length
          : afterHeading + nextHeadingMatch;

        const sectionSlice = doc.slice(afterHeading, sectionEnd);
        const lastTableRow = sectionSlice.lastIndexOf('\n|');
        if (lastTableRow !== -1) {
          const insertAt = afterHeading + lastTableRow + 1;
          doc = doc.slice(0, insertAt) + tableRow + '\n' + doc.slice(insertAt);
        } else {
          // No table rows yet after heading — append after header row
          const insertAt = afterHeading + sectionEnd - afterHeading;
          doc = doc.slice(0, insertAt) + '\n' + tableRow + doc.slice(insertAt);
        }
      } else {
        // Group subheading doesn't exist — find Section 1 end and append new group
        const sec1End = findSectionEnd(doc, '## 1.');
        const newGroup = `\n${subheading}\n| Token / Class | Resolved Value | Do | Don't |\n| :--- | :--- | :--- | :--- |\n${tableRow}\n`;
        doc = doc.slice(0, sec1End) + newGroup + doc.slice(sec1End);
      }
    }
  }

  // Section 2: append rows to the existing table, or create table if missing.
  if (result.section_2_rows?.length) {
    for (const row of result.section_2_rows) {
      const tableRow = `| \`${row.class}\` | ${row.structure} | ${row.use_when} | ${row.dont_use_when} |`;
      const sec2Start = doc.indexOf('## 2.');
      const sec2End = findSectionEnd(doc, '## 2.');

      if (sec2Start !== -1) {
        const sec2Slice = doc.slice(sec2Start, sec2End);
        const lastTableRow = sec2Slice.lastIndexOf('\n|');

        if (lastTableRow !== -1) {
          const insertAt = sec2Start + lastTableRow + 1;
          doc = doc.slice(0, insertAt) + tableRow + '\n' + doc.slice(insertAt);
        } else {
          const newTable = `\n| Class | Structure | Use when | Don't use when |\n| :--- | :--- | :--- | :--- |\n${tableRow}\n`;
          doc = doc.slice(0, sec2End) + newTable + doc.slice(sec2End);
        }
      }
    }
  }

  // Section 3: append each new pattern block before the section end.
  if (result.section_3_patterns?.length) {
    for (const pattern of result.section_3_patterns) {
      const block = formatPatternBlock(pattern);
      const insertAt = findSectionEnd(doc, '## 3.');
      doc = doc.slice(0, insertAt) + '\n' + block + doc.slice(insertAt);
    }
  }

  // Section 4: append each new anti-pattern block before the section end.
  if (result.section_4_antipatterns?.length) {
    for (const ap of result.section_4_antipatterns) {
      const block = `## ${ap.topic}\n- Do: ${ap.do}\n- Don't: ${ap.dont}\n`;
      const insertAt = findSectionEnd(doc, '## 4.');
      doc = doc.slice(0, insertAt) + '\n' + block + doc.slice(insertAt);
    }
  }

  // Section 5: append update note if provided.
  if (result.section_5_update) {
    const insertAt = findSectionEnd(doc, '## 5.');
    doc = doc.slice(0, insertAt) + '\n' + result.section_5_update.trim() + '\n' + doc.slice(insertAt);
  }

  if (!doc.endsWith('\n')) doc += '\n';
  return doc;
}

function findSectionEnd(doc, sectionMarker) {
  const start = doc.indexOf(sectionMarker);
  if (start === -1) return doc.length;

  // Next top-level section starts with '\n## ' after current section
  const afterStart = start + sectionMarker.length;
  const nextSection = doc.slice(afterStart).search(/\n## \d/);
  if (nextSection === -1) return doc.length;
  return afterStart + nextSection;
}

// Extracts the nearest named module from a file path.
// e.g. src/app/modules/admin/components/foo.ts → "admin"
//      src/app/features/auth/login.component.ts → "auth"
//      src/app/shared/components/button.ts      → "shared"
//      src/pages/dashboard/index.tsx            → "dashboard"
// Returns null if the path is clearly a global/root-level file.
function detectModuleScope(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');

  // Known scope-indicating directory names that precede the module name
  const SCOPE_PARENTS = new Set(['modules', 'features', 'pages', 'views', 'screens', 'sections']);
  // Directories that are explicitly global — not a scoped module
  const GLOBAL_DIRS = new Set(['shared', 'common', 'core', 'ui', 'primitives', 'lib', 'utils', 'helpers', 'layouts']);

  for (let i = 0; i < segments.length - 1; i++) {
    if (SCOPE_PARENTS.has(segments[i]) && segments[i + 1]) {
      const candidate = segments[i + 1];
      if (!GLOBAL_DIRS.has(candidate)) return candidate;
    }
  }

  // Fallback: if a segment itself is a well-known module name, use it
  const KNOWN_MODULES = ['admin', 'auth', 'dashboard', 'settings', 'profile', 'onboarding', 'checkout', 'billing'];
  for (const seg of segments) {
    if (KNOWN_MODULES.includes(seg)) return seg;
  }

  return null; // global / unknown
}

function formatPatternBlock(pattern) {
  const snippetLang = pattern.snippet_lang || '';
  return `## ${pattern.name}\n- Snippet:\n\`\`\`${snippetLang}\n${pattern.snippet.trim()}\n\`\`\`\n- Reference: ${pattern.reference}\n- Do: ${pattern.do}\n- Don't: ${pattern.dont}\n`;
}

async function extractNewPatterns(contract, targetCode, targetPath, moduleScope) {
  const scopeBlock = moduleScope
    ? `## Detected Module Scope: "${moduleScope}"
This file belongs to the "${moduleScope}" module. Apply SCOPE RULES below.`
    : `## Detected Module Scope: global
This file appears to be shared/global. Patterns extracted here apply project-wide.`;

  const prompt = `You are a strict UI linter maintaining a design contract used by AI assistants to write consistent UI code.

## Existing Design Contract (DESIGN.md)
${contract}

## File to Analyze: ${targetPath}
${scopeBlock}
\`\`\`
${targetCode}
\`\`\`

Your job: identify reusable UI patterns in this file that are NOT already documented in the contract.

---

SCOPE RULES — enforced before writing any pattern:
- First, determine if each pattern is GLOBAL (used identically across the whole app) or MODULE-SPECIFIC (only makes sense in the "${moduleScope || 'detected'}" module).
- GLOBAL pattern: a shared button style, a universal token, a repeated form field structure. Name it plainly: "Search field", "Primary button".
- MODULE-SPECIFIC pattern: a layout, a data grid, a page-level shell unique to this module. You MUST prefix the name with the module in brackets: "[${moduleScope || 'Module'}] Stat card grid".
- For every MODULE-SPECIFIC pattern, the Don't rule MUST explicitly state: "Outside ${moduleScope || 'this'} module."
- If scope is "global" (no module detected), treat all patterns as global — no prefix needed.

---

ABSOLUTE LANGUAGE RULES — enforced for every cell, bullet, and line you write:
- Telegraphic only. No full sentences. No verbs like "use", "ensure", "make sure", "remember to".
- Bad Do: "Primary text on dark surfaces." (too generic — no location)
- Good Do: "Modal headings, sidebar nav labels." (specific UI element or location)
- Bad Don't: "Other dark base colors." (too vague)
- Good Don't: "\`bg-gray-900\`, raw \`#262624\`" (specific wrong alternative)
- Table cells must be ≤ 10 words each.
- NEVER document a token without resolving its actual underlying value.
- If two tokens resolve to the same value, their Do cells MUST differ by specific location — never write identical Do cells.
- ALL code snippets MUST use CSS variables (\`var(--token)\`) or Tailwind classes for colors. NEVER write raw hex or RGB in snippets if a project token exists. Contradicting the contract's anti-patterns inside examples is strictly forbidden.

---

CONTENT RULES:
- DO NOT repeat anything already in the contract — compare carefully before writing.
- DO NOT organize by page or file name. "Orders page does X" is wrong. "Admin data rows use X" is right.
- DO NOT invent, suggest improvements, or document non-UI logic.
- Only document what actually exists in the code.
- Skip standard Tailwind or CSS utilities the framework already knows (\`.hidden\`, \`.border\`, \`.shadow\`, etc.) unless they have a project-specific override.
- Conflicts (token vs raw hex, old vs new pattern) go under an "Anti-patterns" heading only — never inline with token tables.
- If a distinct UI sub-system is detected (tokens prefixed with \`--wrap-\`, \`--modal-\`, etc.), isolate them in a SEPARATE table under a subheading named after that sub-system.

---

---

Respond with valid JSON only. Use this exact schema — empty arrays mean nothing new found for that section.

{
  "section_1_rows": [
    {
      "group": "Backgrounds | Typography | Borders | Spacing | Other",
      "token": "--token-name or tailwind-class",
      "resolved_value": "#hex or value",
      "do": "specific UI element/location (≤10 words)",
      "dont": "specific wrong alternative (≤10 words)"
    }
  ],
  "section_2_rows": [
    {
      "class": ".class-name",
      "structure": "layout description",
      "use_when": "condition",
      "dont_use_when": "condition"
    }
  ],
  "section_3_patterns": [
    {
      "name": "Pattern Name",
      "snippet": "trimmed HTML/template — use var(--token) for colors, never raw hex",
      "snippet_lang": "html",
      "reference": "src/path/to/file.ext",
      "do": "telegraphic rule",
      "dont": "telegraphic rule"
    }
  ],
  "section_4_antipatterns": [
    {
      "topic": "Topic Name",
      "do": "correct approach — telegraphic",
      "dont": "wrong approach — one-phrase reason"
    }
  ],
  "section_5_update": "markdown string with dark mode update, or null if no change"
}`;

  const res = await client.chat.completions.create({
    model: "gpt-5.4",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const raw = res.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('AI returned invalid JSON. Try again.');
  }
}

main();
