import { parseSync, visitorKeys } from 'oxc-parser';
/**
 * Where `after` differs from `before` in what it runs. Git finds the changed
 * lines; within each hunk the tokens are diffed again, so a reformatted line,
 * a moved comment or a renamed operand marks only what really changed. Each
 * inserted or replaced token is changed. Tokens deleted with nothing put in
 * their place leave an empty range between the tokens around them: an
 * expression around the deletion changed (`a && b && c` → `a && c`), one next
 * to it did not, unless the deletion took an operand of its own (see
 * Range.cut).
 *
 * Without `before` (an added file, or an old version git cannot show), every
 * token of the hunks is new.
 *
 * In a TypeScript `file`, a token that only TypeScript reads (see typeSpans)
 * is not a change when it is inserted or deleted, so an edit of types alone
 * changes nothing: `(a: any)` → `(a: unknown)`, `a < b` → `(a as number) <
 * (b as number)`. Such tokens still line the two versions up as before.
 */
export function changedRanges(before, after, hunks, file) {
    const read = (text) => {
        const tokens = tokenize(text);
        if (file !== undefined && TYPESCRIPT.test(file))
            markTypes(tokens, typeSpans(file, text));
        return tokens;
    };
    const old = before === undefined ? undefined : { tokens: read(before), lines: lineStarts(before), length: before.length };
    const tokens = read(after);
    const lines = lineStarts(after);
    const ranges = [];
    for (const hunk of hunks) {
        const region = lineRegion(lines, after.length, hunk.newStart, hunk.newCount);
        // Unknown old lines match nothing.
        const removed = old ? old.tokens.slice(...overlapping(old.tokens, lineRegion(old.lines, old.length, hunk.oldStart, hunk.oldCount)))
            : hunk.oldCount > 0 ? [{ start: 0, end: 0, key: '', kind: 'punct' }] : [];
        const [from, to] = overlapping(tokens, region);
        diffTokens(removed, tokens.slice(from, to), { at: region.start, previous: tokens[from - 1]?.end, next: tokens[to]?.start }, ranges, before);
    }
    return normalize(ranges);
}
/**
 * The changes in [start, end): ranges that overlap it, and places of a
 * deletion strictly inside it. A deletion just before or after an expression
 * did not change it; where it cut the expression short (see Range.cut), the
 * mutation planner looks for the expression itself.
 */
export function changesIn(ranges, start, end) {
    // Disjoint and sorted, so the ends are sorted too.
    const first = firstEndingAfter(ranges, start);
    let last = first;
    while (last < ranges.length && ranges[last].start < end)
        last++;
    return ranges.slice(first, last);
}
/** The index of the first of `spans`, sorted by end, that ends after `offset`. */
function firstEndingAfter(spans, offset) {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].end > offset)
            hi = mid;
        else
            lo = mid + 1;
    }
    return lo;
}
export function lineStarts(code) {
    const starts = [0];
    for (let i = 0; i < code.length; i++)
        if (code.charCodeAt(i) === 10)
            starts.push(i + 1);
    return starts;
}
/** The text of `count` lines from 1-based `line`; with no lines, the empty range after line `line`. */
function lineRegion(starts, length, line, count) {
    const offset = (index) => (index < starts.length ? starts[index] : length);
    if (count === 0)
        return { start: offset(line), end: offset(line) };
    return { start: offset(line - 1), end: offset(line - 1 + count) };
}
/** The indices [from, to) of the tokens with a character in `region`; for an empty region, of those that span it. */
function overlapping(tokens, region) {
    const lo = firstEndingAfter(tokens, region.start);
    let end = lo;
    // For an empty region, at most a token around it, like a template literal the hunk adds a line to.
    while (end < tokens.length && tokens[end].start < region.end)
        end++;
    return [lo, end];
}
/** Above this many edits in one hunk, every new token of it counts as changed. */
export const MAX_EDITS = 1000;
const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;
// Binary and logical operators. Deleted at the edge of a run, they took an operand with them (see Range.cut).
const OPERATORS = new Set(['||', '&&', '??', '|', '^', '&', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '>>>', '+', '-', '*', '/', '%', '**', 'in', 'instanceof']);
/**
 * Adds to `out` the changes from `before` to `after`, two token runs of one
 * hunk. `at` stands for where tokens were deleted when `after` has none;
 * `previous` and `next` are where the tokens just outside the run end and
 * start. `base` is the text of `before`'s tokens, if git could show it.
 */
function diffTokens(before, after, around, out, base) {
    const ids = new Map();
    const id = (token) => {
        // A name that only TypeScript reads is not the one that runs: `x: T` → `declare x: T` drops the field `x`.
        const key = token.type ? `type ${token.key}` : token.key;
        let value = ids.get(key);
        if (value === undefined)
            ids.set(key, (value = ids.size));
        return value;
    };
    const a = before.map(id);
    const b = after.map(id);
    // Most hunks change a few tokens in the middle of a line or two.
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo])
        lo++;
    let endA = a.length;
    let endB = b.length;
    while (endA > lo && endB > lo && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const ops = editScript(a.slice(lo, endA), b.slice(lo, endB))
        // Too different to be worth the search: all of it is new.
        ?? [...Array(endA - lo).fill(DELETE), ...Array(endB - lo).fill(INSERT)];
    const changed = new Uint8Array(after.length);
    // `first` and `last`: the first and last of the deleted tokens that run.
    const deletedAt = (j, first, last) => {
        // `a > 0 || b` → `a > 0`: the operand went with the operator after `a > 0`; `a || b > 0` → `b > 0`: before `b > 0`.
        const end = j > 0 ? after[j - 1].end : around.previous;
        const start = j < after.length ? after[j].start : around.next;
        if (OPERATORS.has(first.key) && end !== undefined) {
            out.push({ start: end, end, cut: 'end' });
        }
        else if (OPERATORS.has(last.key) && start !== undefined) {
            out.push({ start, end: start, cut: 'start' });
        }
        else {
            const place = j < after.length ? after[j].start : after.length > 0 ? after.at(-1).end : around.at;
            out.push({ start: place, end: place });
        }
    };
    // The text of the base literal that a lone literal put in its place replaced, by its index in `after`.
    const replaced = new Map();
    // Between two kept tokens, deleted tokens matter only if nothing was inserted:
    // any expression around the place also holds the inserted tokens. Tokens
    // that only TypeScript reads count as neither.
    let i = lo;
    let j = lo;
    // The tokens that run, deleted and inserted (by index), since the last kept one.
    let deleted = [];
    let inserted = [];
    const kept = () => {
        if (deleted.length > 0 && inserted.length === 0)
            deletedAt(j, deleted[0], deleted.at(-1));
        if (base !== undefined && deleted.length === 1 && inserted.length === 1) {
            const was = deleted[0];
            if (sameKindOfLiteral(was, after[inserted[0]]))
                replaced.set(inserted[0], base.slice(was.start, was.end));
        }
        deleted = [];
        inserted = [];
    };
    for (const op of ops) {
        if (op === INSERT) {
            if (!after[j].type) {
                changed[j] = 1;
                inserted.push(j);
            }
            j++;
        }
        else if (op === DELETE) {
            if (!before[i].type)
                deleted.push(before[i]);
            i++;
        }
        else {
            kept();
            i++;
            j++;
        }
    }
    kept();
    for (let t = 0; t < after.length; t++) {
        if (!changed[t])
            continue;
        let last = t;
        while (changed[last + 1])
            last++;
        const before = replaced.get(t);
        out.push(last === t && before !== undefined ? { start: after[t].start, end: after[t].end, before } : { start: after[t].start, end: after[last].end });
        t = last;
    }
}
/**
 * Whether `was` and `now` are literals that can stand for each other: a
 * number, string, regex, `true` or `false` for any of them, and a template
 * chunk for a chunk with the same ends (`` `a${ `` for `` `b${ ``).
 */
function sameKindOfLiteral(was, now) {
    const literal = (token) => token.kind === 'number' || token.kind === 'string' || token.kind === 'regex' || token.key === 'true' || token.key === 'false';
    if (was.kind !== 'template' || now.kind !== 'template')
        return literal(was) && literal(now);
    return was.key[0] === now.key[0] && was.key.endsWith('${') === now.key.endsWith('${');
}
/**
 * Myers' O(ND) diff of two id sequences: the operations that turn `a` into
 * `b`, in order. Undefined when that takes more than MAX_EDITS insertions
 * and deletions.
 */
function editScript(a, b) {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, MAX_EDITS);
    const offset = max + 1;
    // v[offset + k]: the furthest x reached on diagonal k = x - y.
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m)
                return backtrack(trace, offset, n, m);
        }
    }
    return undefined;
}
function backtrack(trace, offset, n, m) {
    const ops = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        const prev = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = v[offset + prev];
        const prevY = prevX - prev;
        while (x > prevX && y > prevY) {
            ops.push(EQUAL);
            x--;
            y--;
        }
        if (d > 0)
            ops.push(x === prevX ? INSERT : DELETE);
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}
/** Sorts, merges what overlaps or touches, and drops empty ranges that a changed token covers. */
function normalize(ranges) {
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const result = [];
    for (const range of ranges) {
        const last = result.at(-1);
        if (!last || range.start > last.end) {
            result.push({ ...range });
        }
        else if (last.start === last.end) {
            // A deletion right before a changed token: whatever holds the place holds the token too.
            if (range.end > last.end) {
                last.end = range.end;
                delete last.cut;
                if (range.before !== undefined)
                    last.before = range.before;
            }
            else {
                last.cut ??= range.cut;
            }
        }
        else if (range.end > last.end) {
            last.end = range.end;
            delete last.before;
        }
    }
    return result;
}
const TYPESCRIPT = /\.[cm]?tsx?$/;
// Child keys that hold only types: `: T`, `<T>` and the types after `implements`.
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements']);
// Declarations that compile to nothing, whatever is in them.
const TYPE_DECLARATIONS = new Set([
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'TSDeclareFunction',
    'TSIndexSignature',
    'TSAbstractMethodDefinition',
    'TSAbstractPropertyDefinition',
    'TSAbstractAccessorProperty',
]);
const CASTS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);
// Modifiers of a class member that TypeScript checks and erases. Not of a parameter property, which they make assign a field.
const MODIFIERS = /\b(?:private|protected|public|readonly|override)\b/g;
/** Marks the tokens that lie inside one of `spans`, which are sorted and disjoint. */
function markTypes(tokens, spans) {
    let i = 0;
    for (const token of tokens) {
        while (i < spans.length && spans[i].end <= token.start)
            i++;
        const span = spans[i];
        if (span && span.start <= token.start && token.end <= span.end)
            token.type = true;
    }
}
/**
 * The parts of a TypeScript file that compile to nothing, sorted and merged:
 * type annotations and return types, type parameters and arguments, `as T`,
 * `satisfies T` and a non-null `!`, `<T>x`, interfaces, type aliases,
 * `declare`d and abstract members and declarations, overload and index
 * signatures, `implements …`, a `this` parameter, the `?` or `!` after a
 * declared name, a class member's `private`, `readonly` or `override`, and
 * parentheses that only a cast needs: `(a as number) < b` runs as `a < b`.
 *
 * Parameter properties (`constructor(private x)`) assign a field, enums and
 * namespaces build objects, decorators run, and a field becomes `declare` or
 * `abstract` only by losing the field it defines: none of that is left out.
 * A file that does not parse has none, so all of it counts.
 */
function typeSpans(file, code) {
    const parsed = parseSync(file, code);
    if (parsed.errors.length > 0)
        return [];
    const spans = [];
    const add = (start, end) => {
        if (start < end)
            spans.push({ start, end });
    };
    // The `?` or `!` in [from, to): `a?: T`, `x!: T`, `m?() {}`.
    const mark = (from, to, char) => {
        const at = code.indexOf(char, from);
        if (at >= 0 && at < to)
            add(at, at + 1);
    };
    // `private`, `readonly` and `override` before a class member's name.
    const modifiers = (member) => {
        const from = member.decorators.at(-1)?.end ?? member.start;
        for (const match of code.slice(from, member.key.start).matchAll(MODIFIERS))
            add(from + match.index, from + match.index + match[0].length);
    };
    // `newCallee`: what `new` calls, where `new (f() as F)()` is not `new f()()`.
    const visit = (node, newCallee) => {
        if (TYPE_DECLARATIONS.has(node.type) || ('declare' in node && node.declare === true))
            return add(node.start, node.end);
        switch (node.type) {
            case 'TSAsExpression':
            case 'TSSatisfiesExpression':
            case 'TSNonNullExpression':
                add(node.expression.end, node.end);
                break;
            case 'TSTypeAssertion':
                add(node.start, node.expression.start);
                break;
            case 'ParenthesizedExpression':
                if (CASTS.has(node.expression.type) && needsNoParens(uncast(node.expression), newCallee)) {
                    add(node.start, node.start + 1);
                    add(node.end - 1, node.end);
                }
                break;
            case 'MethodDefinition':
                // An overload signature in a class.
                if (node.value.type === 'TSEmptyBodyFunctionExpression')
                    return add(node.start, node.end);
                modifiers(node);
                if (node.optional)
                    mark(node.key.end, node.value.start, '?');
                break;
            case 'PropertyDefinition':
            case 'AccessorProperty': {
                modifiers(node);
                const next = node.typeAnnotation?.start ?? node.value?.start ?? node.end;
                if (node.optional)
                    mark(node.key.end, next, '?');
                if (node.definite)
                    mark(node.key.end, next, '!');
                break;
            }
            case 'VariableDeclarator':
                if (node.definite && node.id.type === 'Identifier')
                    mark(node.id.start + node.id.name.length, node.id.typeAnnotation?.start ?? node.id.end, '!');
                break;
            case 'Identifier': {
                // oxc's types say no identifier is optional, but a parameter's is: `a?: T`.
                const optional = Reflect.get(node, 'optional');
                if (optional === true)
                    mark(node.start + node.name.length, node.typeAnnotation?.start ?? node.end, '?');
                break;
            }
            case 'ClassDeclaration':
            case 'ClassExpression': {
                // The keyword is the last `implements` before the first type (one in a comment after it only leaves it counted).
                const types = node.implements ?? [];
                const at = types.length > 0 ? code.lastIndexOf('implements', types[0].start - 1) : -1;
                if (at >= 0)
                    add(at, types.at(-1).end);
                break;
            }
            case 'FunctionDeclaration':
            case 'FunctionExpression': {
                // `function f(this: Window, a)`: the parameter and its comma.
                const [first, second] = node.params;
                if (first?.type === 'Identifier' && first.name === 'this')
                    add(first.start, second?.start ?? first.end);
                break;
            }
        }
        for (const key of visitorKeys[node.type] ?? []) {
            const value = Reflect.get(node, key);
            for (const child of Array.isArray(value) ? value : [value]) {
                if (!isNode(child))
                    continue;
                if (TYPE_KEYS.has(key))
                    add(child.start, child.end);
                else
                    visit(child, passesNewCallee(node, key) && (newCallee || node.type === 'NewExpression'));
            }
        }
    };
    visit(parsed.program, false);
    return normalize(spans);
}
// Where the callee of `new` reaches: `new (a.b as any)()`, `new (f() as F).x()`.
function passesNewCallee(node, key) {
    if (node.type === 'NewExpression')
        return key === 'callee';
    return (node.type === 'MemberExpression' && key === 'object') || node.type === 'ParenthesizedExpression' || CASTS.has(node.type);
}
function uncast(node) {
    while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion') {
        node = node.expression;
    }
    return node;
}
/**
 * Whether parentheses around `node` change nothing once its casts are gone:
 * `(a as T).b` is `(a).b`, which is `a.b`. Not around an operator, an
 * optional chain (`(a?.b as T).c` throws where `a?.b.c` does not), a number
 * (`(1 as number).toFixed()`), a call that `new` calls, or anything that a
 * statement or an arrow body would read differently (`{`, `function`).
 */
function needsNoParens(node, newCallee) {
    switch (node.type) {
        case 'Identifier':
        case 'ThisExpression':
        case 'MemberExpression':
        case 'ParenthesizedExpression':
        case 'ArrayExpression':
        case 'TemplateLiteral':
        case 'TaggedTemplateExpression':
            return true;
        case 'Literal':
            return typeof node.value !== 'number' && typeof node.value !== 'bigint';
        case 'CallExpression':
            return !newCallee;
        default:
            return false;
    }
}
function isNode(value) {
    return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}
const PUNCTUATORS = [
    new Set(['>>>=']),
    new Set(['...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=']),
    new Set(['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '**', '<<', '>>']),
];
/** Words after which a `/` starts a regex literal rather than a division. */
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
/** Words that a line break ends (`return\nx` is `return; x`), so a line break after them is part of the code. */
const RESTRICTED = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async']);
const CLOSERS = new Set([')', ']', '}']);
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]*|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?/y;
/**
 * JavaScript and TypeScript tokens, by a scanner that only needs to agree
 * with itself on the old and the new text. Comments and whitespace are
 * skipped. Each string, template chunk (`` `a${ ``, `` }b` ``) and regex
 * literal is one token. A `/` is a regex after an operator or a keyword like
 * `return`, as engines read it; after `<` it is the `</` of a JSX closing tag.
 *
 * Keys leave out what cannot change behaviour: the quotes of a string that
 * has no quote or backslash in it, and a trailing comma (`f(a,)` is `f(a)`;
 * not `[a,,]`, whose last hole counts). A line break counts after `return` and
 * the other words it ends, and before `++` and `--`.
 */
function tokenize(text) {
    const tokens = [];
    // One entry per open `{`: true for the `${` of a template literal.
    const braces = [];
    let previous;
    let newline = false;
    let i = text.startsWith('#!') ? lineEnd(text, 0) : 0;
    const push = (kind, end) => {
        const raw = text.slice(i, end);
        let key = kind === 'string' ? stringKey(raw) : raw;
        if (newline && ((previous && RESTRICTED.has(previous.text)) || raw === '++' || raw === '--'))
            key += '\n';
        tokens.push({ start: i, end, key, kind });
        previous = { kind, text: raw };
        newline = false;
        i = end;
    };
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if (isLineBreak(c)) {
            newline = true;
            i++;
        }
        else if (isSpace(c)) {
            i++;
        }
        else if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
            i = lineEnd(text, i);
        }
        else if (c === 47 && text.charCodeAt(i + 1) === 42 /* * */) {
            const close = text.indexOf('*/', i + 2);
            const end = close < 0 ? text.length : close + 2;
            // A comment with a line break in it ends a line for ASI.
            if (/[\n\r\u2028\u2029]/.test(text.slice(i, end)))
                newline = true;
            i = end;
        }
        else if (c === 47) {
            const end = startsRegex(previous) ? regexEnd(text, i) : -1;
            if (end > 0)
                push('regex', end);
            else
                push('punct', text.charCodeAt(i + 1) === 61 /* = */ ? i + 2 : i + 1);
        }
        else if (c === 34 || c === 39) {
            push('string', stringEnd(text, i));
        }
        else if (c === 96 /* ` */ || (c === 125 /* } */ && braces.at(-1) === true)) {
            if (c === 125)
                braces.pop();
            const end = templateEnd(text, i);
            if (text.charCodeAt(end - 1) === 123)
                braces.push(true);
            push('template', end);
        }
        else if (isDigit(c) || (c === 46 /* . */ && isDigit(text.charCodeAt(i + 1)))) {
            NUMBER.lastIndex = i;
            NUMBER.test(text);
            push('number', Math.max(NUMBER.lastIndex, i + 1));
        }
        else if (isWordStart(c)) {
            let end = i + 1;
            while (end < text.length && isWordPart(text.charCodeAt(end)))
                end++;
            push('word', end);
        }
        else {
            if (c === 123 /* { */)
                braces.push(false);
            else if (c === 125)
                braces.pop();
            push('punct', i + punctuatorLength(text, i));
        }
    }
    return tokens.filter((token, index) => {
        if (token.key !== ',')
            return true;
        const next = tokens[index + 1];
        const before = tokens[index - 1];
        return !(next && CLOSERS.has(next.key) && before && before.key !== ',' && before.key !== '[');
    });
}
function punctuatorLength(text, i) {
    for (const [index, set] of PUNCTUATORS.entries()) {
        const length = 4 - index;
        const candidate = text.slice(i, i + length);
        // `a?.5:b` is a conditional, not optional chaining.
        if (set.has(candidate) && !(candidate === '?.' && isDigit(text.charCodeAt(i + 2))))
            return length;
    }
    return 1;
}
function startsRegex(previous) {
    if (!previous)
        return true;
    switch (previous.kind) {
        case 'punct':
            return !['<', ')', ']', '++', '--'].includes(previous.text);
        case 'word':
            return BEFORE_EXPRESSION.has(previous.text);
        case 'template':
            return previous.text.endsWith('${');
        default:
            return false;
    }
}
/** The end of the regex literal at `i`, flags included, or -1 if the line ends first. */
function regexEnd(text, i) {
    let inClass = false;
    for (let j = i + 1; j < text.length; j++) {
        const c = text.charCodeAt(j);
        if (isLineBreak(c))
            return -1;
        if (c === 92 /* \ */)
            j++;
        else if (c === 91 /* [ */)
            inClass = true;
        else if (c === 93 /* ] */)
            inClass = false;
        else if (c === 47 && !inClass) {
            let end = j + 1;
            while (end < text.length && isWordPart(text.charCodeAt(end)))
                end++;
            return end;
        }
    }
    return -1;
}
/** The end of the string at `i`; an unterminated one ends with its line. */
function stringEnd(text, i) {
    const quote = text.charCodeAt(i);
    for (let j = i + 1; j < text.length; j++) {
        const c = text.charCodeAt(j);
        if (c === 92)
            j++;
        else if (c === quote)
            return j + 1;
        else if (c === 10 || c === 13)
            return j;
    }
    return text.length;
}
/** The end of the template chunk at `i` (a `` ` `` or the `}` of a substitution): after its closing `` ` `` or its `${`. */
function templateEnd(text, i) {
    for (let j = i + 1; j < text.length; j++) {
        const c = text.charCodeAt(j);
        if (c === 92)
            j++;
        else if (c === 96)
            return j + 1;
        else if (c === 36 /* $ */ && text.charCodeAt(j + 1) === 123)
            return j + 2;
    }
    return text.length;
}
/** `'a'` and `"a"` are the same string; with a quote or an escape inside, the text has to say so. */
function stringKey(raw) {
    const inner = raw.slice(1, -1);
    return raw.length >= 2 && raw.at(-1) === raw[0] && !/["'\\]/.test(inner) ? `"${inner}"` : raw;
}
function lineEnd(text, i) {
    let j = i;
    while (j < text.length && !isLineBreak(text.charCodeAt(j)))
        j++;
    return j;
}
function isLineBreak(c) {
    return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}
function isSpace(c) {
    return c === 9 || c === 11 || c === 12 || c === 32 || c === 0xa0 || c === 0xfeff || c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}
function isDigit(c) {
    return c >= 48 && c <= 57;
}
// Anything else outside ASCII is taken as part of a name: the scanner only needs to be consistent.
function isWordPart(c) {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === 36 || c === 95 || c === 92 ||
        (c >= 0x80 && !isSpace(c) && !isLineBreak(c));
}
function isWordStart(c) {
    return (isWordPart(c) && !isDigit(c)) || c === 35; /* # */
}
