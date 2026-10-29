import { existsSync } from "node:fs";

export const CCCC = process.env.NYORORI_CCCC ?? "/home/user/moznion/cccc/target/release/cccc";

export function requireCccc(): string {
  if (!existsSync(CCCC)) {
    throw new Error(`cccc binary not found at ${CCCC}; run scripts/fetch-cccc.sh or set NYORORI_CCCC`);
  }
  return CCCC;
}
