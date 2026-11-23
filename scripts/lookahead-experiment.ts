/**
 * The lookahead experiment, live: every arm on every scenario, several runs each, against real Jev. Writes
 * docs/lookahead/results.json and prints a summary.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/lookahead-experiment.ts [--runs 3] [--arms greedy,la-3x2] [--only trip,settings-night] [--parallel 2] [--out docs/lookahead/results.json]
 *
 * Nothing is recorded to cassettes; the acceptance suite (tests/acceptance/lookahead) is what replays.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { JevModel } from "../src/index.js";
import { ARMS, runArm, type Outcome } from "../tests/support/lookahead/run.js";
import { SCENARIOS } from "../tests/support/lookahead/worlds.js";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const runs = Number(arg("runs", "3"));
const parallel = Number(arg("parallel", "2"));
const armIds = arg("arms", ARMS.map((a) => a.id).join(",")).split(",");
const only = arg("only", "").split(",").filter(Boolean);
const out = arg("out", "docs/lookahead/results.json");

const jobs: { run: number; sc: (typeof SCENARIOS)[number]; arm: (typeof ARMS)[number] }[] = [];
for (let r = 0; r < runs; r++) for (const sc of SCENARIOS) for (const arm of ARMS) if (armIds.includes(arm.id) && (!only.length || only.includes(sc.id))) jobs.push({ run: r, sc, arm });

const results: (Outcome & { run: number })[] = [];
let next = 0;
const model = new JevModel({ retries: 6 });
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const o = await runArm(job.sc, job.arm, model).catch((e) => ({ scenario: job.sc.id, kind: job.sc.kind, arm: job.arm.id, complete: false, failed: ["crashed"], regressions: 0, violations: 0, status: "error" as const, steps: 0, requests: 0, ms: 0, trail: [], error: String(e) }));
      results.push({ ...o, run: job.run });
      console.log(`${String(results.length).padStart(3)}/${jobs.length} ${job.sc.id.padEnd(22)} ${job.arm.id.padEnd(8)} run ${job.run} ${o.complete ? "ok  " : "FAIL"} reg ${o.regressions} req ${String(o.requests).padStart(3)} ${(o.ms / 1000).toFixed(1)}s  ${o.failed.join(", ")}${o.error ? ` [${o.error.slice(0, 80)}]` : ""}`);
    }
  }),
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ model: model.id, runs, parallel, results }, null, 1) + "\n");

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log("\narm       n  complete  regress/run  violations/run  requests/run  s/run");
for (const arm of ARMS.filter((a) => armIds.includes(a.id))) {
  const rs = results.filter((r) => r.arm === arm.id);
  if (!rs.length) continue;
  console.log(`${arm.id.padEnd(8)} ${String(rs.length).padStart(3)}  ${((100 * rs.filter((r) => r.complete).length) / rs.length).toFixed(0).padStart(6)}%  ${mean(rs.map((r) => r.regressions)).toFixed(2).padStart(10)}  ${mean(rs.map((r) => r.violations)).toFixed(2).padStart(13)}  ${mean(rs.map((r) => r.requests)).toFixed(1).padStart(12)}  ${(mean(rs.map((r) => r.ms)) / 1000).toFixed(1).padStart(5)}`);
}
