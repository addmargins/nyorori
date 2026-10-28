// ESLint splits lines on CRLF, CR, LF, U+2028 and U+2029; git and cccc split
// on LF only. Every lint position is converted to LF-based lines before it is
// attributed to a unit, otherwise invisible separators in a string literal
// shift a hit onto a neighbouring function (audit bug #2).

const ESLINT_LINE_BREAK = /\r\n|[\r\n  ]/g;

export type PositionMapper = (line: number, column: number) => { line: number; column: number };

function lineStarts(text: string, breaks: RegExp): number[] {
  const starts = [0];
  breaks.lastIndex = 0;
  for (let m = breaks.exec(text); m; m = breaks.exec(text)) starts.push(m.index + m[0].length);
  return starts;
}

/** Maps ESLint's 1-based (line, column) in `text` to LF-based 1-based (line, column). */
export function lfPositionMapper(rawText: string): PositionMapper {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const eslintStarts = lineStarts(text, ESLINT_LINE_BREAK);
  const lfStarts = lineStarts(text, /\n/g);
  if (eslintStarts.length === lfStarts.length) return (line, column) => ({ line, column });
  return (line, column) => {
    const start = eslintStarts[Math.min(Math.max(line, 1), eslintStarts.length) - 1]!;
    const offset = start + Math.max(column, 1) - 1;
    // Last LF line start ≤ offset.
    let lo = 0;
    let hi = lfStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lfStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lfStarts[lo]! + 1 };
  };
}
