#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
require("dotenv").config();
const OpenAI = require("openai");
const inquirer = require("inquirer");
const { default: ora } = require("ora");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// A single-file CLI that collects a minimal, high-value UI context payload
// from the current working directory (assumed to be a frontend project).
//
// It intentionally does NOT call any network / LLM provider. It outputs a
// compact payload you can paste into an LLM to generate a project-specific
// design manifesto.

const DEFAULTS = {
  outputFile: 'DESIGN.md',
  maxFiles: 3, // component files
  maxChars: 2000, // per snippet default
  maxTotalChars: 8000, // payload hard cap
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
  { key: 'input', label: 'Input', weight: 55 },
  { key: 'card', label: 'Card', weight: 50 },
  { key: 'layout', label: 'Layout', weight: 48 },
  { key: 'navbar', label: 'Nav', weight: 45 },
  { key: 'nav', label: 'Nav', weight: 42 },
  { key: 'header', label: 'Header', weight: 40 },
  { key: 'footer', label: 'Footer', weight: 40 },
  { key: 'sidebar', label: 'Sidebar', weight: 38 },
  { key: 'modal', label: 'Modal', weight: 38 },
  { key: 'table', label: 'Table', weight: 35 },
  { key: 'form', label: 'Form', weight: 35 },
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
  --max-files <n>        Max component files to include (default: ${DEFAULTS.maxFiles})
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
  else if (f.ext === '.ts') s += 15;
  else if (f.ext === '.js') s += 12;
  else if (f.ext === '.vue') s += 16;
  else if (f.ext === '.svelte') s += 16;
  else if (f.ext === '.html') s += 5;

  if (f.size >= 300 && f.size <= 12_000) s += 10;
  if (f.size > 50_000) s -= 25;

  s += Math.max(0, 20 - f.depth * 3);

  return s;
}

function selectComponents(files, limit) {
  const candidates = [];

  for (const f of files) {
    if (!COMPONENT_EXTS.has(f.ext)) continue;
    if (f.name.endsWith('.config.js') || f.name.endsWith('.config.ts')) continue;

    const match = classifyComponent(f.base);
    if (!match) continue;

    candidates.push({ f, match, score: scoreComponentFile(f, match) });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];
  const usedLabels = new Set();

  for (const item of candidates) {
    if (selected.length >= limit) break;
    if (usedLabels.has(item.match.label)) continue;

    selected.push(item);
    usedLabels.add(item.match.label);
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
  const globalStyles = selectGlobalStyles(files, 2);
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
    const content = extractComponentSnippet(item.f.abs, opts.maxChars);
    sections.push({ rel: item.f.rel, tag: `component:${item.match.label}`, content });
  }

  const detected = detectFrameworks({
    depsSnippetObj: depsForDetection,
    tailwindConfig: tw,
    globalStyles,
    files,
  });

  const payload = buildPayload({ detected, sections, opts });

  scanSpinner.succeed(`Scanned ${files.length} files`);

  // --- AI ---
  const aiSpinner = ora('Generating manifesto...').start();
  const outputAbs = path.join(root, opts.outputFile);

  try {
    const result = await generateManifesto(payload, answers.focus);
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

async function generateManifesto(context, focus) {
  const focusBlock = focus && focus.trim()
    ? `\nPay extra attention to: ${focus.trim()}\n`
    : '';

  const prompt = `You are writing a design contract for an AI assistant.
${focusBlock}
This contract will be used by other LLMs to understand how UI is built in this project.
They must follow it exactly when writing components, styles, or UI-related code.

Here is the project context (styles, components, dependencies):

${context}

Extract and document the existing design system as a strict contract.

Rules:
- DO NOT suggest improvements
- DO NOT redesign anything
- DO NOT invent styles that are not in the code
- Only document what actually exists
- Be specific: use actual class names, values, and patterns from the code
- Write rules another AI can follow without ambiguity

Format each section like this:
## [Component or Topic]
- Pattern: how it's used in this project
- Do: what to follow
- Don't: what to avoid`;

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

const DESIGN_RULE = `\nConsider \`DESIGN.md\` in the project root as the primary source for UI/design preferences in this project.\n`;

async function runAdd(root) {
  console.log('\n  design-spec add\n');

  // Find which rule files exist in the project
  const found = RULE_FILES.filter(({ file }) => fs.existsSync(path.join(root, file)));

  if (found.length === 0) {
    console.log('No LLM rule files found in this project (CLAUDE.md, .cursorrules, etc.)');
    console.log('Create one first, then run "design-spec add" again.');
    return;
  }

  // Show which files will be updated
  console.log('Found rule files:\n');
  found.forEach(({ file, label }) => console.log(`  ${label}: ${file}`));
  console.log('');

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Add DESIGN.md reference to all of them?',
      default: true,
    },
  ]);

  if (!confirm) {
    console.log('Aborted. No changes made.');
    return;
  }

  // Append to each file (skip if already contains the reference)
  for (const { file } of found) {
    const abs = path.join(root, file);
    const content = readUtf8(abs);

    if (content.includes('DESIGN.md')) {
      console.log(`  skipped ${file} — already references DESIGN.md`);
      continue;
    }

    try {
      fs.writeFileSync(abs, content.trimEnd() + DESIGN_RULE, 'utf8');
      console.log(`  updated ${file}`);
    } catch (e) {
      stderr(`  [error] could not update ${file}: ${e.message}`);
    }
  }
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

  // 4. Extract new patterns from target file
  const spinner = ora(`Analyzing ${opts.patchTarget}...`).start();

  let result;
  try {
    result = await extractNewPatterns(contract, targetCode, opts.patchTarget);
    spinner.succeed('Analysis done');
  } catch (e) {
    spinner.fail(`AI call failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // 5. Nothing new found
  if (!result.additions || result.additions.trim() === '') {
    console.log('\nNo new patterns found. DESIGN.md is already up to date for this file.');
    return;
  }

  // 6. Show what will be added
  console.log('\n--- New patterns to add to DESIGN.md ---\n');
  console.log(result.additions);
  console.log('');

  // 7. Ask for confirmation
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Add these to DESIGN.md?',
      default: true,
    },
  ]);

  if (!confirm) {
    console.log('Aborted. No changes made.');
    return;
  }

  // 8. Append to DESIGN.md
  try {
    const existing = readUtf8(designFile);
    const updated = existing.trimEnd() + '\n\n' + result.additions.trim() + '\n';
    fs.writeFileSync(designFile, updated, 'utf8');
    console.log(`\nDESIGN.md updated.`);
  } catch (e) {
    stderr(`[error] Could not write DESIGN.md: ${e.message}`);
    process.exitCode = 1;
  }
}

async function extractNewPatterns(contract, targetCode, targetPath) {
  const prompt = `You are maintaining a design contract document used by AI assistants to write consistent UI code.

## Existing Design Contract (DESIGN.md)
${contract}

## File to Analyze: ${targetPath}
\`\`\`
${targetCode}
\`\`\`

Your job: extract reusable UI patterns from the file that are NOT already in the contract.

Critical rules:
- DO NOT organize output by page name or file name
- DO NOT write "Orders page does X" — write "Admin data rows use X"
- DO NOT repeat anything already documented
- DO NOT invent or suggest improvements
- Only document what actually exists in the code
- Group patterns by UI concept (Layout, Tabs, Cards, Modal, Table rows, etc.)
- Use actual class names and component names from the code
- Write rules another AI can follow when building similar UI

Output format — use this structure for each new pattern:
## [UI Concept]
- Pattern: [what it is, in reusable terms]
- Uses: [actual classes or components]
- Do: [rule to follow]
- Don't: [what to avoid]

Respond with valid JSON only.

{
  "additions": "markdown string to append to DESIGN.md, or empty string if nothing new"
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
