// The serve command's signer must honour the signer module's denylist: naming a
// secret in NYORORI_SIGNER_ENV never forwards it to the signing command.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signerFromEnv } from "../../src/cli.js";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("serve signer env passthrough", () => {
  it("forwards allowlisted names but never NYORORI_* or token-like names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyorori-signer-"));
    const out = join(dir, "env.txt");
    process.env.NYORORI_SIGNER = "command";
    process.env.NYORORI_SIGNER_COMMAND = JSON.stringify(["sh", "-c", `env | cut -d= -f1 | sort > "${out}"; printf QUJD`]);
    process.env.NYORORI_SIGNER_ENV = JSON.stringify(["AWS_REGION", "NYORORI_WEBHOOK_SECRET", "GITHUB_TOKEN"]);
    process.env.AWS_REGION = "ap-northeast-2";
    process.env.NYORORI_WEBHOOK_SECRET = "hunter2";
    process.env.GITHUB_TOKEN = "ghs_x";
    try {
      const signer = await signerFromEnv();
      await signer.sign("header.payload");
      const names = readFileSync(out, "utf8").split("\n").filter(Boolean);
      expect(names).toContain("AWS_REGION");
      expect(names).toContain("PATH");
      expect(names).not.toContain("NYORORI_WEBHOOK_SECRET");
      expect(names).not.toContain("GITHUB_TOKEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
