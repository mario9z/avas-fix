#!/usr/bin/env node
/**
 * analyze_code_quality.mjs
 * -------------------------
 * Sends JS/TS source files to AWS Bedrock (Claude) and measures
 * TEM, CQM, and SAM scores. Optionally rewrites files that
 * fall below the target score.
 *
 * Usage:
 *   node analyze_code_quality.mjs \
 *     --files-list changed_files.txt \
 *     --target-score 80 \
 *     --auto-fix false \
 *     --model-id anthropic.claude-3-5-sonnet-20241022-v2:0 \
 *     --output-file analysis_report.json
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { appendFileSync } from "fs";
import { extname, basename } from "path";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    filesList: get("--files-list", "changed_files.txt"),
    targetScore: parseInt(get("--target-score", "80"), 10),
    autoFix: get("--auto-fix", "false").toLowerCase() === "true",
    modelId: get("--model-id", "anthropic.claude-3-5-sonnet-20241022-v2:0"),
    outputFile: get("--output-file", "analysis_report.json"),
    region: process.env.AWS_REGION ?? "us-east-1",
  };
}

// ─────────────────────────────────────────────
// Language detection
// ─────────────────────────────────────────────

const EXT_TO_LANG = {
  ".js":  "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript (JSX)",
  ".ts":  "typescript",
  ".tsx": "typescript (TSX)",
};

function detectLanguage(filepath) {
  return EXT_TO_LANG[extname(filepath).toLowerCase()] ?? "javascript";
}

// ─────────────────────────────────────────────
// Prompt templates  (JS/TS specific)
// ─────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are a senior JavaScript/TypeScript software quality engineer \
specialising in code review and software metrics. You evaluate code objectively and output \
structured, actionable feedback. You ALWAYS respond with valid JSON only — no prose, no markdown fences.`;

function buildAnalysisPrompt(filename, language, code, targetScore) {
  return `Analyze the following ${language} source file and score it on three quality metrics.

## Metric definitions

### TEM — Test Effectiveness Metric (0–100)
Measures how well the code supports and enables testing in a JS/TS ecosystem:
- 0–39  : No tests, untestable side-effectful functions, no dependency injection
- 40–59 : Minimal tests (e.g. a few Jest/Mocha stubs), poor isolation of async logic
- 60–79 : Some unit tests present, moderate coverage, some global state making tests hard
- 80–89 : Good Jest/Vitest coverage, pure functions preferred, async properly awaited in tests
- 90–100: Excellent coverage, mocks/spies used correctly, all branches + edge cases tested

### CQM — Code Quality Metric (0–100)
Measures internal JS/TS code quality:
- 0–39  : var everywhere, callback hell, no error handling, magic numbers, console.logs left in
- 40–59 : Mix of let/const, some promises, inconsistent naming (camelCase vs snake_case)
- 60–79 : Mostly modern syntax, minor duplication, functions slightly too long (>30 lines)
- 80–89 : Clean ES2020+/TypeScript, JSDoc or TSDoc on exports, try/catch on async, no dead code
- 90–100: Excellent structure, strict TypeScript types, DRY, SOLID principles, fully documented

### SAM — Software Agility Metric (0–100)
Measures modularity and adaptability in a JS/TS module system:
- 0–39  : Everything in one file or global scope, tightly coupled, no clear module boundaries
- 40–59 : Some exports but heavy internal coupling, circular imports likely
- 60–79 : Reasonable ES module structure, some coupling issues, mixed concerns in files
- 80–89 : Clean named exports, single-responsibility modules, no circular deps, easy to tree-shake
- 90–100: Highly modular, dependency-injected, follows open/closed, fully typed interfaces

## File to analyze

Filename: ${filename}
Language: ${language}

\`\`\`${language}
${code}
\`\`\`

## JavaScript / TypeScript specific checks

Evaluate and mention where relevant:
- Use of \`var\` vs \`let\`/\`const\`
- Callback-style vs Promises vs async/await consistency
- Missing \`await\` on async calls (common bug source)
- Unhandled promise rejections (.catch() or try/catch missing)
- console.log / debugger statements left in production code
- TypeScript: any types, missing return types, non-null assertions overused
- React/JSX (if applicable): missing key props, useEffect dependency arrays, prop drilling
- Direct DOM manipulation mixed with framework code
- CommonJS require() mixed with ESM import
- Missing or incorrect JSDoc / TSDoc on exported functions

## Required JSON response schema

{
  "filename": "${filename}",
  "language": "${language}",
  "scores": {
    "tem": <integer 0-100>,
    "cqm": <integer 0-100>,
    "sam": <integer 0-100>,
    "overall": <integer — weighted average: TEM×0.35 + CQM×0.40 + SAM×0.25>
  },
  "issues": [
    {
      "metric": "TEM" | "CQM" | "SAM",
      "severity": "critical" | "high" | "medium" | "low",
      "line": <integer or null>,
      "title": "<concise issue title>",
      "detail": "<one-sentence explanation of the problem>",
      "suggestion": "<one-sentence fix recommendation>"
    }
  ],
  "summary": "<3-4 sentence overall assessment>",
  "passes_target": <true if ALL three scores >= ${targetScore}, else false>
}

List all issues found, up to 12, ordered by severity descending.
Reference specific function names, variable names, or line patterns wherever possible.`;
}

// ─────────────────────────────────────────────

const FIX_SYSTEM_PROMPT = `You are a senior JavaScript/TypeScript engineer performing a targeted \
refactor to improve TEM, CQM, and SAM scores. You write clean, idiomatic, modern JS/TS. \
You ALWAYS respond with valid JSON only — no prose, no markdown fences.`;

function buildFixPrompt(filename, language, code, analysis, targetScore) {
  const { scores = {}, issues = [] } = analysis;
  const issuesSummary = issues
    .slice(0, 6)
    .map((i) => `- [${i.metric}] ${i.severity.toUpperCase()}: ${i.title} — ${i.detail}`)
    .join("\n") || "See full analysis.";

  return `The following ${language} file scored below the target of ${targetScore} on one or more metrics.
Rewrite it so ALL three scores reach ${targetScore} or above.

## Current scores
- TEM: ${scores.tem ?? "?"} (target: ${targetScore})
- CQM: ${scores.cqm ?? "?"} (target: ${targetScore})
- SAM: ${scores.sam ?? "?"} (target: ${targetScore})

## Top issues to fix
${issuesSummary}

## Original file (${filename})

\`\`\`${language}
${code}
\`\`\`

## Fix guidelines — JavaScript / TypeScript specific

### TEM fixes — improve testability
- Extract pure functions with no side effects (easy to unit-test with Jest/Vitest)
- Replace hard-coded dependencies with constructor/function injection so they can be mocked
- Separate I/O (fetch, fs, DOM) from business logic into distinct functions
- Add a companion \`${filename.replace(/\.(m?js|tsx?)$/, ".test.$1")}\` export or inline test stubs
  showing how each exported function should be tested, including edge cases
- Ensure async functions return Promises consistently so tests can await them
- Handle and document what happens on null/undefined/empty inputs

### CQM fixes — improve code quality
- Replace all \`var\` with \`const\` (prefer) or \`let\`
- Convert callback chains to async/await with try/catch
- Wrap every async call in try/catch or add .catch() — no unhandled rejections
- Remove all console.log / debugger statements
- Break functions longer than 25 lines into smaller helpers
- Extract magic numbers/strings into named constants at the top of the file
- Add JSDoc (JS) or TSDoc + explicit return types (TS) to every exported symbol
- Fix inconsistent naming (camelCase for variables/functions, PascalCase for classes/components)

### SAM fixes — improve modularity
- One concern per file: split if the file mixes data-fetching, business logic, and UI
- Use named exports not default exports (easier to tree-shake and refactor)
- Eliminate global/module-level mutable state; pass state as arguments or use a context/store
- Ensure no circular imports — restructure shared logic into a separate utility file if needed
- If TypeScript: define and export explicit interfaces/types for all function parameters and returns

## Required JSON response schema

{
  "filename": "${filename}",
  "fixed_code": "<the complete rewritten file as a single escaped string>",
  "scores": {
    "tem": <integer 0-100>,
    "cqm": <integer 0-100>,
    "sam": <integer 0-100>,
    "overall": <integer — weighted average: TEM×0.35 + CQM×0.40 + SAM×0.25>
  },
  "changes": [
    "<concise description of each change made>"
  ],
  "passes_target": <true | false>
}

Preserve the file's public API and observable behaviour. Do not add runtime dependencies
that are not already in package.json. Keep the same module format (ESM/CJS) as the original.`;
}

// ─────────────────────────────────────────────
// Bedrock helpers
// ─────────────────────────────────────────────

async function callBedrock(client, modelId, systemPrompt, userPrompt, maxTokens = 4096) {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cmd = new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      });
      const res = await client.send(cmd);
      const decoded = JSON.parse(Buffer.from(res.body).toString("utf-8"));
      return decoded.content[0].text;
    } catch (err) {
      const code = err?.name ?? "";
      if (
        (code === "ThrottlingException" || code === "ServiceUnavailableException") &&
        attempt < 2
      ) {
        const wait = 5 * 2 ** attempt;
        console.log(`  [bedrock] throttled — retrying in ${wait}s…`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

function parseJsonResponse(text) {
  let clean = text.trim();
  if (clean.startsWith("```")) {
    const lines = clean.split("\n");
    const end = lines.at(-1).trim() === "```" ? -1 : undefined;
    clean = lines.slice(1, end).join("\n");
  }
  return JSON.parse(clean);
}

// ─────────────────────────────────────────────
// Per-file logic
// ─────────────────────────────────────────────

async function analyzeFile(client, modelId, filepath, targetScore) {
  let code = readFileSync(filepath, "utf-8");
  const lang = detectLanguage(filepath);
  const filename = basename(filepath);

  // Truncate very large files to stay within token limits
  if (code.length > 14_000) {
    code = code.slice(0, 14_000) + "\n\n// ... [file truncated for analysis]";
  }

  console.log(`  Analyzing ${filename} (${lang}) …`);
  const prompt = buildAnalysisPrompt(filename, lang, code, targetScore);
  const raw = await callBedrock(client, modelId, ANALYSIS_SYSTEM_PROMPT, prompt, 2048);
  const result = parseJsonResponse(raw);
  result.filepath = filepath;
  return result;
}

async function fixFile(client, modelId, filepath, analysis, targetScore) {
  const code = readFileSync(filepath, "utf-8");
  const lang = detectLanguage(filepath);
  const filename = basename(filepath);

  console.log(`  Fixing ${filename} …`);
  const prompt = buildFixPrompt(filename, lang, code, analysis, targetScore);
  const raw = await callBedrock(client, modelId, FIX_SYSTEM_PROMPT, prompt, 4096);
  const result = parseJsonResponse(raw);
  result.filepath = filepath;
  return result;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!existsSync(args.filesList) || statSync(args.filesList).size === 0) {
    console.log("No changed source files detected — skipping analysis.");
    writeFileSync(args.outputFile, JSON.stringify({ files: [], summary: { skipped: true } }));
    return;
  }

  const files = readFileSync(args.filesList, "utf-8")
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && existsSync(f));

  if (files.length === 0) {
    console.log("No readable source files found.");
    writeFileSync(args.outputFile, JSON.stringify({ files: [], summary: { skipped: true } }));
    return;
  }

  const client = new BedrockRuntimeClient({ region: args.region });
  const report = { files: [], fixes_applied: false, summary: {} };
  let allPass = true;

  for (const filepath of files) {
    console.log(`\n${"─".repeat(52)}`);
    try {
      const analysis = await analyzeFile(client, args.modelId, filepath, args.targetScore);
      const { scores = {}, passes_target: passes = false } = analysis;
      allPass = allPass && passes;

      console.log(
        `  TEM=${scores.tem}  CQM=${scores.cqm}  SAM=${scores.sam}  overall=${scores.overall}  pass=${passes}`
      );

      const entry = { analysis, fix: null };

      if (!passes && args.autoFix) {
        const fix = await fixFile(client, args.modelId, filepath, analysis, args.targetScore);
        if (fix.fixed_code) {
          writeFileSync(filepath, fix.fixed_code, "utf-8");
          report.fixes_applied = true;
          console.log(`  ✓ File rewritten. New scores: TEM=${fix.scores?.tem} CQM=${fix.scores?.cqm} SAM=${fix.scores?.sam}`);
        }
        entry.fix = fix;
      }

      report.files.push(entry);
    } catch (err) {
      console.error(`  ERROR processing ${filepath}:`, err.message);
      report.files.push({ error: err.message, filepath });
    }
  }

  report.summary = {
    total_files: files.length,
    target_score: args.targetScore,
    all_pass: allPass,
    fixes_applied: report.fixes_applied,
  };

  writeFileSync(args.outputFile, JSON.stringify(report, null, 2));
  console.log(`\n${"─".repeat(52)}`);
  console.log(`Report written to ${args.outputFile}`);

  // Signal to GitHub Actions
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `fixes_applied=${report.fixes_applied ? "true" : "false"}\n`);
    appendFileSync(ghOutput, `all_pass=${allPass ? "true" : "false"}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
