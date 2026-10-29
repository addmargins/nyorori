// Unit-name hygiene for matching (spec 5.4): names are compared after NFKC,
// and names that mix scripts or contain Latin look-alikes are never trusted
// for name-based matching, so `аpply` (Cyrillic а) cannot pose as `apply`.

/** Cyrillic and Greek letters that render like Latin letters. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  // Cyrillic lower
  ["а", "a"], ["в", "b"], ["с", "c"], ["е", "e"], ["һ", "h"], ["і", "i"],
  ["ј", "j"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"],
  ["ԛ", "q"], ["ѕ", "s"], ["т", "t"], ["ս", "u"], ["ѵ", "v"], ["ԝ", "w"],
  ["х", "x"], ["у", "y"], ["ӏ", "l"], ["ԁ", "d"], ["ɡ", "g"],
  // Cyrillic upper
  ["А", "A"], ["В", "B"], ["С", "C"], ["Е", "E"], ["Н", "H"], ["І", "I"],
  ["Ј", "J"], ["К", "K"], ["М", "M"], ["О", "O"], ["Р", "P"], ["Ѕ", "S"],
  ["Т", "T"], ["Х", "X"], ["У", "Y"], ["Ԝ", "W"], ["Ӏ", "I"],
  // Greek
  ["α", "a"], ["ο", "o"], ["ρ", "p"], ["ν", "v"], ["ι", "i"], ["κ", "k"],
  ["τ", "t"], ["υ", "u"], ["χ", "x"], ["γ", "y"],
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"],
  ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"], ["Ρ", "P"], ["Τ", "T"],
  ["Υ", "Y"], ["Χ", "X"],
]);

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Cherokee"] as const;
const SCRIPT_RE = Object.fromEntries(
  SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")]),
) as Record<(typeof SCRIPTS)[number], RegExp>;

const INVISIBLE_RE = /[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/u;

export function normalizeName(name: string): string {
  return name.normalize("NFKC");
}

export interface NameCheck {
  normalized: string;
  /** Contains a Latin look-alike, invisible characters, or mixes scripts. */
  suspicious: boolean;
  /** Human-readable reason when suspicious. */
  warning?: string;
}

export function checkName(name: string): NameCheck {
  const normalized = normalizeName(name);
  const lookalikes = [...normalized].filter((ch) => CONFUSABLES.has(ch));
  if (INVISIBLE_RE.test(normalized)) {
    return { normalized, suspicious: true, warning: `invisible character in "${name}"` };
  }
  const scripts = SCRIPTS.filter((s) => SCRIPT_RE[s].test(normalized));
  if (scripts.length > 1) {
    return {
      normalized,
      suspicious: true,
      warning: `mixed scripts (${scripts.join("+")}) in "${name}"`,
    };
  }
  if (lookalikes.length > 0) {
    return {
      normalized,
      suspicious: true,
      warning: `Latin look-alike characters (${lookalikes.join("")}) in "${name}"`,
    };
  }
  return { normalized, suspicious: false };
}

/** The Latin skeleton of a name, used only to explain which name it imitates. */
export function skeleton(name: string): string {
  return [...normalizeName(name)].map((ch) => CONFUSABLES.get(ch) ?? ch).join("");
}
