// The e2e suite drives the pipeline through the isolated worker, which runs
// from the build output: compile once per vitest run.
import { execFileSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

export default function setup(): void {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT, stdio: "inherit" });
}
