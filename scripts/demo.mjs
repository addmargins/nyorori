// Demo: a throwaway repository with a CogC-21 function, judged by the built
// CLI. Shows G1 failing on the function and, in a second pair, what G4 reports
// when a test is deleted and no required-workflow artifacts are supplied.
//
//   npm run build && npm run demo -- --cccc /path/to/cccc
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const idx = process.argv.indexOf("--cccc");
const cccc = idx === -1 ? process.env.NYORORI_CCCC : process.argv[idx + 1];
if (!cccc) {
  console.error("usage: npm run demo -- --cccc /path/to/cccc   (or set NYORORI_CCCC)");
  process.exit(64);
}
if (!existsSync(cli)) {
  console.error("dist/cli.js not found: run `npm run build` first");
  process.exit(64);
}

const tmp = mkdtempSync(join(tmpdir(), "nyorori-demo-"));
const repo = join(tmp, "repo");
mkdirSync(repo);
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
const commit = (files, message) => {
  for (const [path, body] of Object.entries(files)) {
    const abs = join(repo, path);
    if (body === null) rmSync(abs);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

/** A function whose Cognitive Complexity is exactly `n`: n flat `if`s at nesting 0. */
const fnWithCogc = (name, n) =>
  `export function ${name}(order, total) {\n${Array.from({ length: n }, (_, i) => `  if (order.flag${i}) total += ${i};`).join("\n")}\n  return total;\n}\n`;

git("init", "-q", "-b", "main");
const base = commit(
  {
    "README.md": "demo\n",
    "src/pricing.js": fnWithCogc("applyDiscount", 4),
    "test/pricing.test.js": 'import { applyDiscount } from "../src/pricing.js";\ntest("discount", () => { expect(applyDiscount({}, 1)).toBe(1); });\n',
  },
  "base",
);
const complex = commit({ "src/pricing.js": fnWithCogc("applyDiscount", 21) }, "applyDiscount grows to CogC 21");
const testGone = commit({ "test/pricing.test.js": null }, "delete the test");

// The default policy with the measurer unpinned (this demo binary is not the attested release asset).
const policy = JSON.parse(readFileSync(join(root, "policy", "default.policy.json"), "utf8"));
policy.measurer.allow_unpinned = true;
const policyFile = join(tmp, "policy.json");
writeFileSync(policyFile, JSON.stringify(policy, null, 2));

function run(label, b, c) {
  const out = join(tmp, label);
  const r = spawnSync(process.execPath, [cli, "run", "--repo", repo, "--base", b, "--candidate", c, "--policy", policyFile, "--cccc", cccc, "--out", out], {
    encoding: "utf8",
  });
  console.log(`\n==== ${label}: nyorori run exit ${r.status} ====\n`);
  if (r.stderr) console.error(r.stderr);
  console.log(readFileSync(join(out, "gate-summary.md"), "utf8"));
  return r.status;
}

console.log(`demo repository: ${repo}\nbase ${base}\ncandidate 1 ${complex} (applyDiscount CogC 4 → 21)\ncandidate 2 ${testGone} (test deleted, no artifacts)`);
const first = run("1-cogc-21", base, complex);
const second = run("2-test-deleted", complex, testGone);
console.log(`Pair 1 exit ${first}: G1 FAILs on applyDiscount (CogC 21 > 15). G4 is enforce in the default policy and has no`);
console.log(`required-workflow artifacts, so it is INCONCLUSIVE (REPORT_MISSING); FAIL wins the aggregate (spec 4.2).`);
console.log(`Pair 2 exit ${second}: the deleted test is a static G4 finding; without artifacts the run cannot pass either.`);
console.log(`Artifacts kept under ${tmp}`);
