#!/usr/bin/env node
/**
 * check_score_gate.mjs
 * ---------------------
 * Fails the CI job (exit code 1) if any file does not meet
 * the target score after fixes have been applied.
 */

import { readFileSync } from "fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    report: get("--report", "analysis_report.json"),
    targetScore: parseInt(get("--target-score", "80"), 10),
  };
}

function main() {
  const { report: reportPath, targetScore } = parseArgs();
  const report = JSON.parse(readFileSync(reportPath, "utf-8"));

  if (report.summary?.skipped) {
    console.log("No files analyzed — gate skipped. ✅");
    process.exit(0);
  }

  const failed = [];

  for (const entry of report.files ?? []) {
    if (entry.error) continue;

    // Use fix scores if auto-fix was applied, else use analysis scores
    const scores = (entry.fix ?? entry.analysis)?.scores ?? {};
    const filepath = entry.analysis?.filepath ?? "?";
    const { tem = 0, cqm = 0, sam = 0 } = scores;

    const below = [
      tem < targetScore && `TEM=${tem}`,
      cqm < targetScore && `CQM=${cqm}`,
      sam < targetScore && `SAM=${sam}`,
    ].filter(Boolean);

    if (below.length) failed.push({ filepath, below });
  }

  if (failed.length) {
    console.log(`\n❌ Score gate FAILED (target: ${targetScore})\n`);
    for (const { filepath, below } of failed) {
      console.log(`  ${filepath}: ${below.join(", ")}`);
    }
    console.log("\nFix the issues above, enable auto-fix, or lower the target score.");
    process.exit(1);
  } else {
    console.log(`\n✅ Score gate PASSED — all JS/TS files meet target of ${targetScore}.`);
    process.exit(0);
  }
}

main();
