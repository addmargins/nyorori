// The spec 7.2 behavior-preserving variants recreated under
// test/fixtures/manipulation/<dir>/price.js (plus helper files).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/manipulation/", import.meta.url));

export interface Variant {
  /** Spec label, e.g. "f″". */
  id: string;
  dir: string;
  description: string;
  /** Spec 7.2 classification. */
  kind: "legit" | "manipulation" | "mixed" | "neutral" | "ineffective" | "overdesign";
  /** Spec 7.2 equivalence was not checked for e′/e″ (class-split measurement only). */
  equivalenceChecked: boolean;
}

export const ORIGINAL = "original";

export const VARIANTS: Variant[] = [
  { id: "a", dir: "a", description: "가드절, 의미 있는 helper, 표 하나", kind: "legit", equivalenceChecked: true },
  { id: "a′", dir: "a2", description: "같은 helper를 중첩 클로저로", kind: "legit", equivalenceChecked: true },
  { id: "b", dir: "b", description: "공유 ctx 객체를 수정하는 helper 11개", kind: "manipulation", equivalenceChecked: true },
  { id: "c", dir: "c", description: "화살표 함수 객체 맵 + BOOL[String(cond)]", kind: "mixed", equivalenceChecked: true },
  { id: "d", dir: "d", description: "[cond].filter(Boolean).forEach", kind: "manipulation", equivalenceChecked: true },
  { id: "d′", dir: "d2", description: "cond && (() => {…})()", kind: "manipulation", equivalenceChecked: true },
  { id: "e", dir: "e", description: "클래스 필드 초기화식으로", kind: "manipulation", equivalenceChecked: true },
  { id: "e′", dir: "e2", description: "그 클래스를 별도 파일로", kind: "manipulation", equivalenceChecked: true },
  { id: "e″", dir: "e3", description: "설정 파싱을 static {}과 최상위 if/for로", kind: "neutral", equivalenceChecked: true },
  { id: "f", dir: "f", description: "모든 if를 x &&= cond로", kind: "manipulation", equivalenceChecked: true },
  { id: "f′", dir: "f2", description: "불리언 산술, [x, y][+cond]", kind: "manipulation", equivalenceChecked: true },
  { id: "f″", dir: "f3", description: "범용 조합자 when/match", kind: "manipulation", equivalenceChecked: true },
  { id: "g", dir: "g", description: "예외를 goto처럼 사용", kind: "ineffective", equivalenceChecked: true },
  { id: "h", dir: "h", description: "별칭을 통한 재귀", kind: "manipulation", equivalenceChecked: true },
  { id: "i", dir: "i", description: "본문을 문자열로, new Function", kind: "manipulation", equivalenceChecked: true },
  { id: "i′", dir: "i2", description: "규칙 목록 + 작은 인터프리터", kind: "overdesign", equivalenceChecked: true },
  { id: "j", dir: "j", description: "전략 클래스, reduce 파이프라인", kind: "legit", equivalenceChecked: true },
];

/** All source files of a variant directory, keyed by file name. */
export function variantSources(dir: string): Record<string, string> {
  const root = join(FIXTURE_ROOT, dir);
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    if (name.endsWith(".js")) out[name] = readFileSync(join(root, name), "utf8");
  }
  return out;
}

export function variantEntry(dir: string): string {
  return join(FIXTURE_ROOT, dir, "price.js");
}
