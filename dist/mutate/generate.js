import { parseSync, visitorKeys, } from 'oxc-parser';
import { ScopeTracker } from 'oxc-walker';
import { changesIn, lineStarts } from '../diff.js';
import { isOperator } from '../types.js';
import { dropEquivalent } from './equivalent.js';
import { Strings } from './infer.js';
import { regexMutations } from './regex.js';
export class ParseError extends Error {
}
// Child keys that only hold TypeScript types or decorators; nothing in them runs as a mutable expression.
const TYPE_KEYS = new Set([
    'typeAnnotation',
    'returnType',
    'typeParameters',
    'typeArguments',
    'superTypeArguments',
    'implements',
    'decorators',
]);
// The keys of each node type that hold child nodes, as oxc lists them, minus the type-only ones.
const CHILD_KEYS = new Map(Object.entries(visitorKeys).map(([type, keys]) => [type, keys.filter((key) => !TYPE_KEYS.has(key))]));
const SKIP_NODES = new Set([
    'ImportDeclaration',
    'ExportAllDeclaration',
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'TSDeclareFunction',
    'TSEnumDeclaration',
    'TSModuleDeclaration',
    'TSIndexSignature',
    'TSAbstractMethodDefinition',
    'TSAbstractPropertyDefinition',
    'TSEmptyBodyFunctionExpression',
]);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** The nodes whose children a Revert's statement does not reach past (see unitOf), besides functions. */
const UNIT = /Statement$|Declaration$|^(?:Program|ClassBody|SwitchCase|(?:Object|Array)(?:Expression|Pattern)|JSX(?:OpeningElement|Element|Fragment))$/;
const BINARY = {
    '<': ['ComparisonBoundary', '<='],
    '<=': ['ComparisonBoundary', '<'],
    '>': ['ComparisonBoundary', '>='],
    '>=': ['ComparisonBoundary', '>'],
    '===': ['Equality', '!=='],
    '!==': ['Equality', '==='],
    '==': ['Equality', '!='],
    '!=': ['Equality', '=='],
    '+': ['Arithmetic', '-'],
    '-': ['Arithmetic', '+'],
    '*': ['Arithmetic', '/'],
    '/': ['Arithmetic', '*'],
    '%': ['Arithmetic', '*'],
};
const NO_TYPES = { plus: () => 'unknown', nonNullableType: () => undefined };
const SUPPRESS_PREFIX = 'nyorori-ignore';
const SUPPRESS_RE = /^nyorori-ignore-next-line\s+([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+--\s+(\S.*)$/;
/**
 * Builds the mutants of the code that `changes` touch, plus the suppression
 * comments that apply to them. An expression site is in scope when its text
 * holds a change; a function body when the function's header does (see
 * plan). Mutants that minify to the original code are set aside in
 * `equivalent`. Ids start at `firstId`. Where the syntax cannot tell string
 * `+` from numeric `+`, `types` answers from the operand types (see typeQuestions).
 * `options.logGuards` mutates an `if` that only logs too.
 */
export function generate(file, code, changes, firstId, types = NO_TYPES, options = {}) {
    const { parsed, lines, sites } = plan(file, code, changes, types, options);
    const sorted = [...sites.values()].sort((a, b) => a.start - b.start || b.end - a.end);
    // Before ids are assigned, so each remaining site keeps a contiguous id range.
    const { sites: ordered, equivalent } = dropEquivalent(file, code, sorted);
    const mutants = [];
    let id = firstId;
    for (const site of ordered) {
        for (const planned of site.mutants) {
            planned.mutant.id = id++;
            mutants.push(planned.mutant);
            // After TCE, so a probe whose first reader was dropped is keyed by the next one.
            if (planned.profile && planned.profile.probe.key === 0)
                planned.profile.probe.key = planned.mutant.id;
        }
    }
    const { suppressions, problems } = readSuppressions(file, parsed.comments, lines, changes.lines);
    const reformatted = suppressions.filter(({ isNew, targetLine }) => isNew && changes.lines.has(targetLine) &&
        changesIn(changes.ranges, lines[targetLine - 1] ?? code.length, lines[targetLine] ?? code.length).length === 0);
    return { sites: ordered, mutants, equivalent, suppressions, reformatted, problems };
}
/**
 * What generate() will ask `types` about `file`: the changed `+` of mutated
 * code where the syntax cannot tell, and the values that the changed `?.` and
 * `??` mutants guard. The type checker answers them all in one pass
 * before generation, which stays synchronous. A file that does not parse has
 * no questions; generate() reports it.
 */
export function typeQuestions(file, code, changes, options = {}) {
    const questions = { file, plus: [], guarded: [] };
    const recorder = {
        plus: (_, left, right) => {
            questions.plus.push({ left: { start: left.start, end: left.end }, right: { start: right.start, end: right.end } });
            return 'unknown';
        },
        nonNullableType: (_, value) => {
            questions.guarded.push({ start: value.start, end: value.end });
            return undefined;
        },
    };
    try {
        plan(file, code, changes, recorder, options);
    }
    catch (error) {
        if (!(error instanceof ParseError))
            throw error;
    }
    return questions;
}
/**
 * The sites and mutants of `file` before TCE and ids, the part of generate()
 * that asks `types`. A mutant is made only where its site holds a change:
 * `a < max` when `max` replaced another operand, but not `arr.length - 1`
 * when only an argument next to it changed (see `changed`). A body site, whose
 * mutant skips the whole body, would otherwise come with every edit inside a
 * function; it takes the function's header instead, from its start (or its
 * method name) to the `{`.
 */
function plan(file, code, changes, types, options) {
    const parsed = parseSync(file, code);
    if (parsed.errors.length > 0) {
        throw new ParseError(parsed.errors[0].message);
    }
    const lines = lineStarts(code);
    const position = (offset) => toPosition(lines, offset);
    const sites = new Map();
    const statements = new Map();
    const valueProbes = new Map();
    // The bodies of functions, by start (filled by the first walk below), with where the function starts for an expression body.
    const bodies = [];
    // The nodes at each place where an operand was cut off, outermost first (filled by the first walk), and the
    // expressions that lost it, as `start:end` (see cutShort).
    const atCuts = new Map();
    for (const { start, cut } of changes.ranges)
        if (cut)
            atCuts.set(`${cut}:${start}`, []);
    const cut = new Set();
    // The literals this branch put in place of others, as `start:end`, with the text of the ones they replaced (see revert).
    const replaced = new Map();
    for (const { start, end, before } of changes.ranges)
        if (before !== undefined)
            replaced.set(`${start}:${end}`, before);
    // The parent of each node, for unitOf (filled by the first walk when a literal took the place of another).
    const parents = new Map();
    /**
     * Whether `span` holds a change of its own. One in the body of a function
     * nested in it does not count: that code belongs to that function and its
     * sites, or `xs.forEach((x) => { … })` would be removed for every edit in
     * the callback, and `xs.map((x) => x.id)` unwrapped for every edit of `x.id`.
     * An expression that lost an operand at its edge changed too.
     */
    function changed(span, besides) {
        return cut.has(`${span.start}:${span.end}`) || changesIn(changes.ranges, span.start, span.end).some((range) => !(range.start === besides?.start && range.end === besides.end) && !inNestedBody(span, range));
    }
    function inNestedBody(span, range) {
        const start = Math.max(range.start, span.start);
        const end = Math.min(range.end, span.end);
        let lo = 0;
        let hi = bodies.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (bodies[mid].start >= span.start)
                hi = mid;
            else
                lo = mid + 1;
        }
        for (let i = lo; i < bodies.length && bodies[i].start <= start; i++) {
            const body = bodies[i];
            // A header holds no body, only the `{` of its own; an arrow function's own `=> undefined` holds its expression body.
            if (body.end > span.end || (body.arrow !== undefined && body.arrow <= span.start))
                continue;
            if (start !== end ? end <= body.end : body.start < start && start < body.end)
                return true;
            // A deletion right before the `{` or after the `}` is outside; an operand cut off at the edge of an expression body was the body's.
            if (body.arrow !== undefined && start === (range.cut === 'start' ? body.start : range.cut === 'end' ? body.end : -1))
                return true;
        }
        return false;
    }
    function add(site, kind, anchor, operator, replacement, description, scope = site) {
        if (!changed(scope))
            return undefined;
        const { line, column } = position(anchor);
        const key = `${site.start}:${site.end}:${kind}`;
        let target = sites.get(key);
        if (!target) {
            target = { start: site.start, end: site.end, kind, mutants: [] };
            sites.set(key, target);
        }
        // Another operator can reach the same code: `if (check(true))` → `true` by Condition and by CallUnwrap.
        if (target.mutants.some((m) => m.replacement === replacement))
            return undefined;
        const planned = { mutant: { id: 0, file, line, column, operator, description }, replacement };
        target.mutants.push(planned);
        return planned;
    }
    // Both Condition mutants of a test read the same record, so they share its probe.
    function valueProbe(node) {
        const place = `${node.start}:${node.end}`;
        let probe = valueProbes.get(place);
        if (!probe) {
            probe = { kind: 'value', key: 0, start: node.start, end: node.end };
            valueProbes.set(place, probe);
        }
        return probe;
    }
    const text = (node) => code.slice(node.start, node.end);
    // Replaces [from, to) inside the site with `insert`, returning the whole site text.
    const edit = (site, from, to, insert) => code.slice(site.start, from) + insert + code.slice(to, site.end);
    /**
     * String `+` is not mutated (string mutations are deferred). The syntax
     * settles it where it is certain that an operand is a string (infer.ts);
     * the checker could not answer otherwise there, so only the rest is asked.
     */
    function isConcatenation(node) {
        const { left, right } = node;
        // Only a `+` that can become a mutant is worth the question.
        if (!changed(node))
            return false;
        if (strings.isString(left) || strings.isString(right))
            return true;
        return types.plus(file, left, right) === 'string';
    }
    // Asked only for a mutant that exists and that the profile can settle, so it is in changed code.
    function nonNullableType(value) {
        const type = types.nonNullableType(file, value);
        return type === undefined ? undefined : snippet(type);
    }
    function condition(test, values) {
        if (!test)
            return;
        const inner = unwrap(test);
        if (isBooleanLiteral(inner))
            return;
        // Only a test without side effects can be replaced by its observed value.
        const pure = isPure(test);
        for (const value of values) {
            if (value === 'true' && isAlwaysTrue(inner))
                continue;
            const planned = add(test, 'expression', test.start, 'Condition', value, `\`${snippet(text(test))}\` → \`${value}\``);
            if (planned && pure)
                planned.profile = { probe: valueProbe(test), rule: { kind: 'condition', value: value === 'true' } };
        }
    }
    // Chains whose value is used as a reference. Wrapping one in a conditional
    // turns it into a plain value: `(o?.f)()` would lose `this`, and
    // `delete (o?.x)` would not delete. Parents are visited first, so the set is
    // filled before the chain is reached.
    const references = new Set();
    // Callees of `new`: unwrapping a call there would construct its argument.
    const constructed = new Set();
    // Calls whose value an expression statement drops. CallStatement removes
    // them; CallUnwrap would only remove them too, with the first argument evaluated.
    const discarded = new Set();
    // Receivers that a method only reads before they are dropped (`….map(f)`).
    // A copy there changes nothing, so it gets no CallUnwrap.
    const readOnce = new Set();
    // Values that the code around them converts as a global call would: a test
    // as `Boolean(x)`, a template expression as `String(x)`, an awaited value as
    // `Promise.resolve(x)`. That call there changes nothing (see convert).
    const converted = new Map();
    // Values that only make an error's message: `throw new TypeError('Expected a function')`,
    // `throw 'bad ' + x`. Its text gets no Revert, like a log call's (see markMessages).
    const messages = new Set();
    // A `console` declared in an enclosing scope (a parameter, an import, ...) is the code's own object.
    const isLogging = (node) => (isConsoleCall(node) && !scopes.isDeclared('console')) || isLogCall(node);
    /**
     * Whether `statement` only logs: Google's service calls such nodes arid, and
     * a compound node arid when all its children are. A statement is arid when
     * the log filter leaves nothing in it (a log call, a dropped recording, an
     * empty block or statement), and an `if` when its branches are. Its test
     * then only decides whether to log, so it gets no mutant either:
     * `if (err) this.logger.warn(…)`. A `?.` on the logger still does
     * something, so `this.logger?.warn(…)` is not arid.
     */
    function isArid(statement) {
        switch (statement.type) {
            case 'EmptyStatement':
                return true;
            case 'BlockStatement':
                return statement.body.every(isArid);
            case 'IfStatement':
                return isArid(statement.consequent) && (!statement.alternate || isArid(statement.alternate));
            case 'ExpressionStatement':
                return isRecordStatement(statement) || logsOnly(statement.expression);
            default:
                return false;
        }
    }
    // A log call, or one that a condition guards like an `if` would: `err && logger.warn(…)`.
    function logsOnly(expression) {
        const node = unwrapReference(expression);
        if (node.type === 'LogicalExpression')
            return logsOnly(node.right);
        if (node.type === 'ConditionalExpression')
            return logsOnly(node.consequent) && logsOnly(node.alternate);
        const call = statementCall(expression);
        return call !== undefined && call.site === call.node && isLogging(call.node);
    }
    function mutate(node, parent, context) {
        if (node.type === 'CallExpression') {
            const callee = unwrapReference(node.callee);
            references.add(callee);
            if (callee.type === 'MemberExpression' && READS.has(methodName(node) ?? ''))
                readOnce.add(unwrapReference(callee.object));
        }
        else if (node.type === 'TaggedTemplateExpression')
            references.add(unwrapReference(node.tag));
        else if (node.type === 'UnaryExpression' && node.operator === 'delete')
            references.add(unwrapReference(node.argument));
        else if (node.type === 'NewExpression')
            constructed.add(unwrapReference(node.callee));
        convert(node, parent, context);
        markMessages(node);
        switch (node.type) {
            case 'BinaryExpression': {
                const entry = BINARY[node.operator];
                if (!entry)
                    break;
                const [operator, replacementOp] = entry;
                const { left, right } = node;
                // Same value either way; with `1n`, the same TypeError when `x` is not a bigint.
                if ((node.operator === '*' || node.operator === '/') && (isNumber(right, 1) || isNumber(right, 1n)))
                    break;
                const at = findToken(code, left.end, right.start, node.operator);
                if (at < 0)
                    break;
                if (node.operator === '+' && isConcatenation(node))
                    break;
                const planned = add(node, 'expression', at, operator, edit(node, at, at + node.operator.length, replacementOp), `\`${node.operator}\` → \`${replacementOp}\``);
                // `===` → `!==` changes every result; nothing to learn from the values.
                if (planned && operator !== 'Equality') {
                    planned.profile = {
                        probe: { kind: 'binary', key: 0, start: node.start, end: node.end, at, operator: node.operator, mutated: replacementOp },
                        rule: { kind: 'binary', operator: node.operator, mutated: replacementOp, left: snippet(text(left)), right: snippet(text(right)) },
                    };
                }
                break;
            }
            case 'LogicalExpression': {
                const { left, right } = node;
                const at = findToken(code, left.end, right.start, node.operator);
                if (at < 0)
                    break;
                if (node.operator === '??') {
                    const shown = keeping(oneLine(text(left)), ` ?? ${oneLine(text(right))}`);
                    const planned = add(node, 'expression', at, 'Logical', text(left), `\`${shown.whole}\` → \`${shown.kept}\``);
                    if (planned)
                        planned.profile = { probe: valueProbe(left), rule: { kind: 'nonNullish', subject: snippet(text(left)), type: nonNullableType(left) } };
                }
                else {
                    const other = node.operator === '&&' ? '||' : '&&';
                    add(node, 'expression', at, 'Logical', edit(node, at, at + 2, other), `\`${node.operator}\` → \`${other}\``);
                }
                break;
            }
            case 'UnaryExpression': {
                const { argument } = node;
                if (node.operator === '-') {
                    add(node, 'expression', node.start, 'UnaryMinus', text(argument), `\`${snippet(text(node))}\` → \`${snippet(text(argument))}\``);
                }
                else if (node.operator === '!') {
                    // In `!!x`, dropping either `!` yields the same `!x`; keep only the outer one.
                    if (parent?.type === 'UnaryExpression' && parent.operator === '!')
                        break;
                    add(node, 'expression', node.start, 'Negation', text(argument), `\`${snippet(text(node))}\` → \`${snippet(text(argument))}\``);
                }
                break;
            }
            case 'UpdateExpression': {
                const at = node.prefix ? node.start : findToken(code, node.argument.end, node.end, node.operator);
                if (at < 0)
                    break;
                const other = node.operator === '++' ? '--' : '++';
                add(node, 'expression', at, 'Update', edit(node, at, at + 2, other), `\`${node.operator}\` → \`${other}\``);
                break;
            }
            case 'Literal': {
                if ('regex' in node) {
                    for (const { at, literal, from, to } of regexMutations(node.regex.pattern, node.regex.flags)) {
                        add(node, 'expression', node.start + at, 'Regex', literal, to === '' ? `\`${from}\` removed` : `\`${snippet(from)}\` → \`${snippet(to)}\``);
                    }
                }
                else if (typeof node.value === 'boolean') {
                    const other = String(!node.value);
                    add(node, 'expression', node.start, 'BooleanLiteral', other, `\`${node.value}\` → \`${other}\``);
                }
                // Last, so a mutant that another operator makes keeps its name: `true` → `false`, a flag removed.
                if (isValue(node, parent) && !(typeof node.value === 'string' && messages.has(node)))
                    revert(node, node.start, node.end);
                break;
            }
            case 'TemplateLiteral':
                // The text of a tagged template is not a value: the tag gets it whole.
                if (parent?.type === 'TaggedTemplateExpression' || messages.has(node))
                    break;
                for (const { start, end } of changesIn(changes.ranges, node.start, node.end)) {
                    if (!node.expressions.some((expression) => expression.start <= start && end <= expression.end))
                        revert(node, start, end);
                }
                break;
            case 'IfStatement':
            case 'ConditionalExpression':
                condition(node.test, ['true', 'false']);
                break;
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'ForStatement':
                // `true` would only turn the loop into an infinite one.
                condition(node.test, ['false']);
                break;
            case 'ChainExpression': {
                if (references.has(node))
                    break;
                for (const link of optionalLinks(node.expression)) {
                    const from = link.type === 'MemberExpression' ? link.object : link.callee;
                    const at = findToken(code, from.end, link.end, '?.');
                    if (at < 0)
                        continue;
                    const dot = link.type === 'MemberExpression' && !link.computed ? '.' : '';
                    const planned = add(node, 'expression', at, 'OptionalChaining', edit(node, at, at + 2, dot), `\`?.\` → \`${dot || '(none)'}\``);
                    if (!planned)
                        continue;
                    const subject = snippet(text(from));
                    if (link.type === 'MemberExpression') {
                        // Cutting the chain at the object of a `?.` is safe: if the part before stops early, the `?.` sees undefined and stops too.
                        planned.profile = { probe: valueProbe(link.object), rule: { kind: 'nonNullish', subject, type: nonNullableType(from) } };
                    }
                    else {
                        const probe = callProbe(code, link);
                        if (probe)
                            planned.profile = { probe, rule: { kind: 'called', subject, type: nonNullableType(from) } };
                    }
                }
                break;
            }
            case 'ExpressionStatement': {
                const call = statementCall(node.expression);
                if (!call)
                    break;
                discarded.add(call.site);
                // Without `super()` a derived constructor throws; a log call only logs, and `metrics.increment()` only records.
                if (call.node.callee.type === 'Super' || isLogging(call.node) || isRecordStatement(node))
                    break;
                add(call.site, 'expression', calleeAnchor(call.node), 'CallStatement', 'undefined', `\`${showCall(call.node).call}\` removed`);
                break;
            }
            case 'CallExpression': {
                // A call that ends an optional chain stands for the whole chain, which has the same span.
                const site = parent?.type === 'ChainExpression' ? parent : node;
                // A call a statement drops is CallStatement's. One that is called, constructed, tagged
                // or deleted is left alone: `f(x)(y)` → `x(y)` only tests that `x` is not a function.
                if (discarded.has(site) || references.has(site) || constructed.has(site))
                    break;
                // `super(x)` → `x` leaves `this` uninitialised; `require('x')` → `'x'` and a log call say nothing.
                if (node.callee.type === 'Super' || isName(node.callee, 'require') || isLogging(node))
                    break;
                // Where the code converts the value anyway, the call changes nothing:
                // `if (Boolean(x))`, `` `${String(x)}` ``, `await Promise.resolve(x)`.
                if (isConversion(node, converted.get(site)))
                    break;
                // The first argument of `f.call(that, x)`, `.apply` and `.bind` is the receiver, not a value the call passes on.
                if (isReceiverCall(node))
                    break;
                // Inside a chain, a `?.` before the call skips the links after it; parentheses around the call would cut them off.
                if (site === node && optionalLinks(node).length > 0)
                    break;
                const kept = unwrapped(node);
                if (!kept)
                    break;
                // A copy that is only read and dropped (`xs.slice().map(f)`) reads the same as its receiver.
                if (kept.receiver && isCopy(node) && readOnce.has(site))
                    break;
                const shown = showCall(node);
                const to = kept.receiver ? shown.receiver : snippet(text(kept.node));
                add(site, 'expression', calleeAnchor(node), 'CallUnwrap', text(kept.node), `\`${shown.call}\` → \`${to}\``);
                break;
            }
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'ArrowFunctionExpression': {
                const { body } = node;
                if (!body)
                    break;
                // A method's header starts with its name: `get size() {`, not `() {`.
                const method = (parent?.type === 'MethodDefinition' || (parent?.type === 'Property' && (parent.method || parent.kind !== 'init'))) &&
                    parent.value === node;
                const start = method ? parent.start : node.start;
                if (body.type === 'BlockStatement') {
                    const [first] = body.body;
                    const onlyReturn = body.body.length === 1 && first?.type === 'ReturnStatement' && first.argument === null;
                    if (body.body.length === 0 || onlyReturn)
                        break;
                    const at = body.start + 1;
                    add({ start: at, end: at }, 'body', body.start, 'FunctionBody', '', 'body → `return`', { start, end: at });
                }
                else if (!isUndefined(body)) {
                    // The mutant replaces the expression, so a change in it counts, as in any expression site, and so does the header.
                    add(body, 'expression', body.start, 'FunctionBody', 'undefined', `\`=> ${snippet(text(body))}\` → \`=> undefined\``, { start, end: body.end });
                }
                break;
            }
        }
    }
    /**
     * `Revert`: the literal that this branch replaced, put back (see
     * Range.before). A changed literal puts the expressions around it in
     * scope, but none of their mutants says whether a test checks its new
     * value: `maxReplaces || 500` gets `||` → `&&`, which tests kill whatever
     * the number is. If this one survives, no test does. [start, end) is the
     * literal's token in `site`: the literal itself, or a chunk of a template.
     * Only when nothing else in its statement changed: put back among other
     * changes, the old literal makes code that never existed, which the
     * mutants of those changes test already (see unitOf).
     */
    function revert(site, start, end) {
        const before = replaced.get(`${start}:${end}`);
        if (before === undefined || changed(unitOf(site), { start, end }))
            return;
        // A template chunk shows its text: `a` for `` `a${ ``.
        const shown = (token) => snippet(site.type === 'TemplateLiteral' ? token.replace(/^[`}]|(?:`|\$\{)$/g, '') : token);
        add(site, 'expression', start, 'Revert', edit(site, start, end, before), `\`${shown(code.slice(start, end))}\` → \`${shown(before)}\`, as before this PR`);
    }
    /**
     * The statement that `node` is in, for revert(), or the part of one that
     * stands on its own: the test of an `if` or a loop, a function's parameter
     * or expression body, a class member, an entry of an object or array
     * literal, a JSX attribute or child. A PR that changes two defaults in one
     * returned object changes two values, each with its own Revert.
     */
    function unitOf(node) {
        for (let parent = parents.get(node); parent && !UNIT.test(parent.type) && !FUNCTIONS.has(parent.type); parent = parents.get(parent))
            node = parent;
        return node;
    }
    /**
     * Records the values that `node` converts (see converted). A test, the
     * operand of `!`, and both operands of an `&&` or `||` whose own value is
     * used that way are used only for their truthiness. An untagged template
     * converts its expressions with ToString. `await`, and an async function
     * returning a value, resolve it to a promise.
     */
    function convert(node, parent, context) {
        switch (node.type) {
            case 'IfStatement':
            case 'ConditionalExpression':
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'ForStatement':
                if (node.test)
                    converted.set(unwrap(node.test), 'Boolean');
                break;
            case 'UnaryExpression':
                if (node.operator === '!')
                    converted.set(unwrap(node.argument), 'Boolean');
                break;
            case 'LogicalExpression':
                // Not `??`: `Boolean(x) ?? y` is never `y`, but `x ?? y` is when `x` is null.
                if (node.operator !== '??' && converted.get(node) === 'Boolean') {
                    converted.set(unwrap(node.left), 'Boolean');
                    converted.set(unwrap(node.right), 'Boolean');
                }
                break;
            case 'TemplateLiteral':
                // A tag gets the values themselves.
                if (parent?.type !== 'TaggedTemplateExpression')
                    for (const expression of node.expressions)
                        converted.set(unwrap(expression), 'String');
                break;
            case 'AwaitExpression':
                converted.set(unwrap(node.argument), 'Promise');
                break;
            case 'ReturnStatement':
                if (node.argument && context === 'async')
                    converted.set(unwrap(node.argument), 'Promise');
                break;
            case 'ArrowFunctionExpression':
                if (node.async && node.expression)
                    converted.set(unwrap(node.body), 'Promise');
                break;
        }
    }
    /**
     * Records the values that only make an error's message (see messages): what
     * is thrown, the arguments of `new …Error(…)` or `…Error(…)`, and, within
     * those, the operands of `+`, `&&`, `||`, `??` and the branches of `?:`.
     * Messages are text for people, often reworded with no test that reads
     * them; a log call's arguments are left out for the same reason.
     */
    function markMessages(node) {
        if (node.type === 'ThrowStatement')
            messages.add(unwrap(node.argument));
        else if ((node.type === 'NewExpression' || node.type === 'CallExpression') && /Error$/.test(calleeName(node.callee) ?? '')) {
            for (const argument of node.arguments)
                messages.add(unwrap(argument));
        }
        if (!messages.has(node))
            return;
        if ((node.type === 'BinaryExpression' && node.operator === '+') || node.type === 'LogicalExpression') {
            messages.add(unwrap(node.left));
            messages.add(unwrap(node.right));
        }
        else if (node.type === 'ConditionalExpression') {
            messages.add(unwrap(node.consequent));
            messages.add(unwrap(node.alternate));
        }
    }
    /**
     * Whether `call` is the conversion of the unshadowed global `global`, with
     * one argument: `Boolean(x)`, `String(x)`, `Promise.resolve(x)`. Unwrapped,
     * a call with more would no longer evaluate the others.
     */
    function isConversion(call, global) {
        if (global === undefined || call.arguments.length !== 1 || scopes.isDeclared(global))
            return false;
        const callee = unwrapReference(call.callee);
        if (global !== 'Promise')
            return isName(callee, global);
        return callee.type === 'MemberExpression' && methodName(call) === 'resolve' && isName(unwrapReference(callee.object), global);
    }
    /**
     * What CallUnwrap puts in place of a call so that it no longer does its work:
     * the value a function passes on (`toInteger(x)` → `x`), or the receiver of a
     * method that transforms it (`s.trim()` → `s`, `xs.map(f)` → `xs`). Any other
     * method gives a different kind of value than its argument or receiver
     * (`set.has(v)`, `xs.join(',')`, `re.test(s)`): either would only be killed
     * for its type, so such a call gets none. Condition, Negation and
     * CallStatement still mutate where it is used.
     */
    function unwrapped(call) {
        const callee = unwrapReference(call.callee);
        if (callee.type !== 'MemberExpression')
            return firstArgument(call);
        const { object } = callee;
        // Parentheses and type assertions do not change what the receiver is.
        const receiver = unwrapReference(object);
        // The class's own methods, which wrap values like plain functions do: `this.getValue(x)`.
        if (receiver.type === 'ThisExpression' || receiver.type === 'Super')
            return firstArgument(call);
        if (receiver.type === 'Identifier') {
            const declaration = scopes.getDeclaration(receiver.name);
            if (!declaration)
                return NAMESPACES.has(receiver.name) ? firstArgument(call) : undefined;
            if (declaration.type === 'Import' && declaration.node.type === 'ImportNamespaceSpecifier')
                return firstArgument(call);
            // A module or a class is never a string or an array, whatever its methods are called.
            if (declaration.type === 'Import' || declaration.type === 'Identifier' || isModule(declaration))
                return undefined;
        }
        const method = methodName(call);
        return method !== undefined && TRANSFORMS.has(method) ? { node: object, receiver: true } : undefined;
    }
    /**
     * A call as descriptions show it, from the callee to the `)`: `toInteger(x)`,
     * `code?.replace(/_/g, '-')`. Past LONG characters, a receiver longer than
     * SHORT becomes `…` and the arguments are cut, so the method stays in view:
     * `….map(normalizeZero)`. `receiver` is the receiver as shown there.
     */
    function showCall(call) {
        const callee = unwrapReference(call.callee);
        const open = findToken(code, call.typeArguments?.end ?? call.callee.end, call.end, '(');
        const args = `(${call.arguments.map((arg) => oneLine(text(arg))).join(', ')})`;
        if (callee.type !== 'MemberExpression') {
            const shown = keeping('', `${snippet(code.slice(call.start, open), SHORT)}${args}`, true);
            return { call: shown.whole, receiver: '' };
        }
        const { object } = callee;
        // A method on the next line reads `.b`, not ` .b`. Before the receiver is what wraps the callee: `(o.f as F)(x)`.
        const shown = keeping(oneLine(text(object)), `${oneLine(code.slice(object.end, open))}${args}`, true);
        return { call: oneLine(code.slice(call.start, object.start)) + shown.whole, receiver: shown.kept };
    }
    const scopes = new Scopes();
    const strings = new Strings(scopes);
    // The tracker records a name when the walk reaches its declaration, so a first
    // pass collects them all and the second also sees names declared below their
    // use: hoisted `var` and functions, or a module-level logger defined further down.
    // It also finds the bodies that `changed` leaves to the functions they belong to.
    walk(parsed.program, null, undefined, scopes, (node, parent) => {
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.body) {
            const { body } = node;
            bodies.push(body.type === 'BlockStatement' ? body : { start: body.start, end: body.end, arrow: node.start });
        }
        if (replaced.size > 0)
            parents.set(node, parent);
        atCuts.get(`end:${node.end}`)?.push({ node, parent });
        atCuts.get(`start:${node.start}`)?.push({ node, parent });
        return undefined;
    });
    bodies.sort((a, b) => a.start - b.start);
    for (const nodes of atCuts.values())
        for (const node of cutShort(nodes))
            cut.add(`${node.start}:${node.end}`);
    scopes.freeze();
    walk(parsed.program, null, 'module', scopes, (node, parent, context) => {
        if (node.type === 'ExpressionStatement')
            statements.set(node.start, node);
        if (context === 'log')
            return context;
        // An `if` that only logs gets no mutant, its test included; so does `err && logger.warn(…)`.
        // With logGuards they are mutated, and only the log calls inside are left out, as anywhere.
        if (!options.logGuards && (node.type === 'IfStatement' || node.type === 'ExpressionStatement') && isArid(node))
            return 'log';
        const inner = 'async' in node && node.async ? 'async' : FUNCTIONS.has(node.type) ? 'function' : context;
        if (inner !== 'module')
            mutate(node, parent, context);
        return isLogging(node) || isRecordStatement(node) ? 'log' : inner;
    });
    for (const site of sites.values()) {
        const statement = site.kind === 'expression' ? statements.get(site.start) : undefined;
        if (statement)
            site.statement = { start: statement.start, end: statement.end };
    }
    return { parsed, lines, sites };
}
function readSuppressions(file, comments, lines, changed) {
    const suppressions = [];
    const problems = [];
    for (const comment of comments) {
        const value = comment.value.replace(/^\*+/, '').trim();
        if (!value.startsWith(SUPPRESS_PREFIX))
            continue;
        const line = toPosition(lines, comment.start).line;
        const match = SUPPRESS_RE.exec(value);
        if (!match) {
            problems.push({
                file,
                line,
                message: 'Malformed suppression. Use `nyorori-ignore-next-line <Operator>[, <Operator>] -- <reason>`.',
            });
            continue;
        }
        const names = match[1].split(',').map((name) => name.trim());
        const unknown = names.filter((name) => !isOperator(name));
        if (unknown.length > 0) {
            problems.push({ file, line, message: `Unknown operator in suppression: ${unknown.join(', ')}.` });
            continue;
        }
        suppressions.push({
            file,
            line,
            targetLine: toPosition(lines, comment.end).line + 1,
            operators: names,
            reason: match[2].trim(),
            isNew: changed.has(line),
        });
    }
    return { suppressions, problems };
}
/**
 * oxc-walker's ScopeTracker, kept in step by `walk` below rather than by
 * oxc-walker's own walk. That one enters every key and every node, so the
 * tracker would also count ambient declarations, which bind nothing at runtime:
 * after `declare const console: …`, `console` is still the global. The hooks
 * its walk calls and the recorded scopes are protected, hence the subclass.
 */
class Scopes extends ScopeTracker {
    constructor() {
        // Exited scopes stay recorded, so the second walk can look names up in them.
        super({ preserveExitedScopes: true });
    }
    enter(node) {
        this.processNodeEnter(node);
    }
    leave(node) {
        this.processNodeLeave(node);
    }
    /** For infer.ts, which resolves a constant's initialiser from where it stands. */
    lookup(name, scope) {
        // A key extends its parent's: `0-1` is inside `0`, which is inside the root scope ''.
        for (let key = scope;; key = key.slice(0, Math.max(0, key.lastIndexOf('-')))) {
            const declaration = this.scopes.get(key)?.get(name);
            if (declaration)
                return declaration;
            if (key === '')
                return null;
        }
    }
}
/**
 * Visits the code that exists at runtime, parents before children, and keeps
 * `scopes` in step. Type-only children and ambient (`declare`) declarations are
 * not entered. SKIP_NODES reach `scopes` but not `enter`: an import, enum or
 * namespace can still declare a name. `enter` returns the state its children get.
 */
function walk(node, parent, state, scopes, enter) {
    if ('declare' in node && node.declare)
        return;
    scopes.enter(node);
    if (!SKIP_NODES.has(node.type)) {
        const inner = enter(node, parent, state);
        for (const key of CHILD_KEYS.get(node.type) ?? []) {
            // The key comes from oxc's table, so TypeScript cannot know which property it names.
            const value = Reflect.get(node, key);
            if (Array.isArray(value)) {
                for (const child of value)
                    if (isNode(child))
                        walk(child, node, inner, scopes, enter);
            }
            else if (isNode(value)) {
                walk(value, node, inner, scopes, enter);
            }
        }
    }
    scopes.leave(node);
}
// Expressions that hold an operand at their edge more tightly than a binary operator would: `size <= 0`, `!x`, `a.b(c)`.
const TIGHT = new Set([
    'BinaryExpression', 'LogicalExpression', 'UnaryExpression', 'UpdateExpression', 'AwaitExpression', 'MemberExpression', 'CallExpression',
    'ChainExpression', 'TaggedTemplateExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion',
    'TSInstantiationExpression',
]);
/**
 * Of `nodes`, which end (or start) where an operand was cut off with its
 * operator, outermost first, those that lost it (see Range.cut). That is the
 * expression left in the operand's place: from the innermost, up through
 * what binds more tightly, so `size <= 0` and not its `0`. What holds it at
 * the same place changed with it, like an arrow function whose body it is.
 * None when it is an operand of a binary or logical expression around it:
 * that one holds the place inside and changed anyway (`a && b && c` → `a && c`).
 */
function cutShort(nodes) {
    let k = nodes.length - 1;
    if (k < 0 || !/Expression$|^(?:Identifier|Literal|TemplateLiteral|Super)$/.test(nodes[k].node.type))
        return [];
    while (k > 0 && TIGHT.has(nodes[k - 1].node.type))
        k--;
    const { parent } = nodes[k];
    if (parent?.type === 'BinaryExpression' || parent?.type === 'LogicalExpression')
        return [];
    return nodes.slice(0, k + 1).map(({ node }) => node);
}
function isNode(value) {
    return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}
function unwrap(node) {
    while (node.type === 'ParenthesizedExpression')
        node = node.expression;
    return node;
}
/** Parentheses and type-only wrappers keep a member expression a reference. */
function unwrapReference(node) {
    while (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' ||
        node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion')
        node = node.expression;
    return node;
}
/**
 * Whether `literal` is a value the code computes: not a property name, an
 * import source, a JSX attribute, or a statement of its own like `'use strict'`.
 */
function isValue(literal, parent) {
    if (!parent)
        return true;
    if ('key' in parent && parent.key === literal)
        return 'computed' in parent && parent.computed === true;
    // `import('./x')` and `require('./x')` name a module like an import declaration: the old path would only fail to load.
    if (parent.type === 'ImportExpression' || (parent.type === 'CallExpression' && isName(parent.callee, 'require')))
        return false;
    return !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportAttribute', 'JSXAttribute', 'ExpressionStatement'].includes(parent.type);
}
function isBooleanLiteral(node) {
    return node.type === 'Literal' && typeof node.value === 'boolean';
}
function isNumber(node, value) {
    node = unwrap(node);
    return node.type === 'Literal' && node.value === value;
}
function isUndefined(node) {
    node = unwrap(node);
    return (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'UnaryExpression' && node.operator === 'void');
}
/**
 * Whether evaluating `node` does nothing but produce its value, judged by syntax
 * and conservatively: names, literals, member access with a fixed key, and
 * operators over those. No calls, `new`, assignments, updates, `await`, `yield`,
 * tagged templates or `delete`. Getters, proxies and valueOf/toString can still
 * run code here; the profile assumes they do not change anything the tests see.
 */
function isPure(node) {
    switch (node.type) {
        case 'Identifier':
        case 'Literal':
        case 'ThisExpression':
            return true;
        case 'ParenthesizedExpression':
        case 'ChainExpression':
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
        case 'TSTypeAssertion':
            return isPure(node.expression);
        case 'MemberExpression':
            return isPure(node.object) && (!node.computed || node.property.type === 'Literal');
        case 'UnaryExpression':
            return node.operator !== 'delete' && isPure(node.argument);
        case 'BinaryExpression':
        case 'LogicalExpression':
            return isPure(node.left) && isPure(node.right);
        case 'ConditionalExpression':
            return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
        case 'TemplateLiteral':
            return node.expressions.every(isPure);
        default:
            return false;
    }
}
/** `x.length >= 0`: turning it into `true` changes nothing. */
function isAlwaysTrue(node) {
    if (node.type !== 'BinaryExpression' || node.operator !== '>=')
        return false;
    const left = unwrap(node.left);
    return isNumber(node.right, 0) && left.type === 'MemberExpression' && !left.computed &&
        left.property.type === 'Identifier' && left.property.name === 'length';
}
/** `console.x(...)`, whichever `console` it names; the caller checks the scope. */
function isConsoleCall(node) {
    return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' && node.callee.object.name === 'console';
}
/**
 * Names of a logger, as the receiver's last segment shows it: `logger`,
 * `this.logger`, `ctx.log`, `this._logger`, `baseLogger`. Not a name that
 * only ends in `log` (`auditLog`, `changelog`): such a log is often what the
 * code keeps. A `log` that is something else, like the array in
 * `this.entries.log.push(x)`, has no log levels (see LEVELS).
 */
const LOGGERS = /^_*log(?:ger)?$|Logger$/;
/**
 * Log levels. Only these: a logger's other methods do things
 * (`baseLogger.create('x')` makes a logger, `logger.clone(options)` copies it),
 * and on anything else a level may too: `this.error(…)` throws in a Rollup
 * plugin, `result.warn(…)` adds a PostCSS warning, `util.deprecate(f, …)` wraps `f`.
 */
const LEVELS = new Set([
    'trace', 'debug', 'verbose', 'silly', 'info', 'log', 'notice', 'warn', 'warning', 'deprecate', 'error', 'critical', 'fatal',
]);
/**
 * Metrics and tracing objects and the methods that record to them:
 * `metrics.increment('hits')`, `this.statsd.timing('load', ms)`,
 * `requestTracer.recordException(e)`. Only for calls whose value is dropped
 * (see isRecordStatement). Not `span`, which is as often a DOM element
 * (`span.setAttribute('class', c)`), nor `counter` or `stats`.
 */
const RECORDERS = /^_*(?:metrics|statsd|telemetry|tracer)$|(?:Metrics|Telemetry|Tracer)$/;
const RECORDINGS = new Set([
    'increment', 'decrement', 'gauge', 'histogram', 'timing', 'distribution', 'record',
    'addEvent', 'setAttribute', 'setAttributes', 'setStatus', 'recordException',
]);
/** `logger.warn(…)`: a log level called on something named like a logger (see LOGGERS). */
function isLogCall(node) {
    return isCallOn(node, LOGGERS, LEVELS);
}
/** `metrics.increment(…)` as a statement: a recording whose value is dropped (see RECORDERS). */
function isRecordStatement(node) {
    if (node.type !== 'ExpressionStatement')
        return false;
    const call = statementCall(node.expression);
    return call !== undefined && isCallOn(call.node, RECORDERS, RECORDINGS);
}
/** `receiver.method(…)` with a method in `methods` and a receiver whose own name matches `receivers`. */
function isCallOn(node, receivers, methods) {
    if (node.type !== 'CallExpression' || !methods.has(methodName(node) ?? ''))
        return false;
    const callee = unwrapReference(node.callee);
    if (callee.type !== 'MemberExpression')
        return false;
    const receiver = unwrapReference(callee.object);
    const name = receiver.type === 'Identifier' ? receiver.name : receiver.type === 'MemberExpression' && !receiver.computed ? receiver.property.name : '';
    return receivers.test(name);
}
function isName(node, name) {
    return node.type === 'Identifier' && node.name === name;
}
/**
 * Built-in objects whose static methods take the value they work on first:
 * `Math.trunc(x)`, `Number.isNaN(x)`, `Object.assign(target, …)`,
 * `JSON.stringify(x)`, `Array.from(x)`. Unshadowed, their calls unwrap to that
 * argument like plain function calls. Other globals (`Buffer`, `process`,
 * `document`, a global `$` or `_`) are host or library objects: their methods
 * are not all functions of the first argument, and the names of some are
 * TRANSFORMS (`Buffer.concat(list)`, `_.map(xs, f)`), so their calls get none.
 */
const NAMESPACES = new Set(['Array', 'BigInt', 'Date', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'Reflect', 'String', 'Symbol']);
/**
 * Methods of strings and arrays that give back a value of the same kind as
 * their receiver: a string from a string, an array from an array, or the
 * receiver itself, sorted or reversed. Unwrapped to the receiver, the call
 * reads "the transform was not applied". A lookup (`charAt`, `at`) or a
 * conversion (`split`, `join`) is not a transform of the receiver.
 *
 * The receiver's type is not known, so any object with a method of one of these
 * names gets the same mutant. Elsewhere the names mostly keep that meaning:
 * iterator helpers, typed arrays, RxJS, Immutable.js, lodash wrappers and
 * Option or Result types return a value of the same kind from `map`, `filter`,
 * `concat` or `slice`. A method that means something else (`router.replace(p)`)
 * is still not called, and its tests notice that by its effect, as with
 * CallStatement, or by the value, as with the first argument before. A
 * receiver named by an import, a `require`, a class or a global outside
 * NAMESPACES is a module or a class, never a string or an array: those calls
 * (`path.normalize(p)`) get none (see unwrapped).
 */
const TRANSFORMS = new Set([
    // String.prototype
    'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'substr', 'substring', 'toLocaleLowerCase', 'toLocaleUpperCase',
    'toLowerCase', 'toUpperCase', 'toWellFormed', 'trim', 'trimEnd', 'trimLeft', 'trimRight', 'trimStart',
    // Both
    'concat', 'slice',
    // Array.prototype
    'filter', 'flat', 'flatMap', 'map', 'reverse', 'sort', 'toReversed', 'toSorted',
]);
/**
 * Array methods that read their receiver without changing it and give back a
 * new array or a value: a copy that only one of them reads is dropped right
 * after, so it changes nothing (`xs.slice().map(f)`). Not `forEach`, `some`,
 * `every`, `find` or `reduce`: a loop over a copy is usually there because its
 * body changes the original (`listeners.slice().forEach((l) => l())`, where a
 * listener can unsubscribe). Iterators (`values()`) read their receiver later.
 */
const READS = new Set([
    'at', 'concat', 'filter', 'flat', 'flatMap', 'includes', 'indexOf', 'join', 'lastIndexOf', 'map', 'slice',
    'toReversed', 'toSorted', 'toSpliced', 'with',
]);
/**
 * `xs.slice()`, `xs.slice(0)` and `xs.concat()` copy their receiver. Unwrapped,
 * the code works on the receiver itself: a function changes or returns its
 * input (`toFilled`, `dropRight`), a clone shares it, a cache hands it out.
 * Only a copy that is read once and dropped reads the same (see READS).
 */
function isCopy(call) {
    const method = methodName(call);
    const [first, ...rest] = call.arguments;
    if (method === 'concat')
        return !first;
    return method === 'slice' && rest.length === 0 && (!first || isNumber(first, 0));
}
/** The name a callee goes by: `Error`, `TypeError` in `errors.TypeError`, none in `make()`. */
function calleeName(callee) {
    const node = unwrapReference(callee);
    if (node.type === 'Identifier')
        return node.name;
    return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
}
/** The name of the method a call makes: `sort` in `xs.sort()`, none in `xs[k]()`. */
function methodName(call) {
    const callee = unwrapReference(call.callee);
    return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
}
/**
 * The argument a call passes on, which CallUnwrap puts in its place. None when
 * it is spread, or a callback: the result of a call that takes a callback is
 * hardly ever that function, or acts the same as it (`useCallback(fn, deps)`),
 * so the mutant would only check that the result is used.
 */
function firstArgument(call) {
    const [first] = call.arguments;
    if (!first || first.type === 'SpreadElement' || first.type === 'FunctionExpression' || first.type === 'ArrowFunctionExpression')
        return undefined;
    return { node: first, receiver: false };
}
/** `const path = require('path')`, a name destructured from it, or the same with `await import('path')`: a module, like an import. */
function isModule(declaration) {
    if (declaration.type !== 'Variable')
        return false;
    const { node } = declaration;
    const declarator = declaration.variableNode.declarations.find(({ id }) => id.start <= node.start && node.end <= id.end);
    let init = declarator?.init ? unwrapReference(declarator.init) : undefined;
    if (init?.type === 'AwaitExpression')
        init = unwrapReference(init.argument);
    return init?.type === 'ImportExpression' || (init?.type === 'CallExpression' && isName(init.callee, 'require'));
}
const RECEIVER_METHODS = new Set(['call', 'apply', 'bind']);
function isReceiverCall(call) {
    return RECEIVER_METHODS.has(methodName(call) ?? '');
}
/**
 * The call an expression statement makes (`f(x)`, `await f(x)`, `a?.f(x)`),
 * and what CallStatement replaces: the call, or the optional chain it ends.
 * Under `await` only the call goes, so the statement still waits.
 */
function statementCall(expression) {
    let node = unwrapReference(expression);
    if (node.type === 'AwaitExpression')
        node = unwrapReference(node.argument);
    if (node.type === 'ChainExpression' && node.expression.type === 'CallExpression')
        return { node: node.expression, site: node };
    return node.type === 'CallExpression' ? { node, site: node } : undefined;
}
/** The callee's name, where a call shows on its line: `b` in `a\n  .b(x)`. */
function calleeAnchor(call) {
    const callee = unwrapReference(call.callee);
    return callee.type === 'MemberExpression' ? callee.property.start : callee.start;
}
/**
 * A probe that counts the calls an optional call makes, as a spread of an
 * empty array in front of its arguments: it runs only when the callee is not
 * nullish, adds no argument, and leaves the callee (and so `this`) alone.
 */
function callProbe(code, link) {
    const [first] = link.arguments;
    if (first)
        return { kind: 'call', key: 0, at: first.start, args: true };
    // No arguments: the call ends with `)`, even after type arguments.
    const close = link.end - 1;
    return code.charAt(close) === ')' ? { kind: 'call', key: 0, at: close, args: false } : undefined;
}
function optionalLinks(expression) {
    const links = [];
    let node = expression;
    while (node) {
        if (node.type === 'MemberExpression') {
            if (node.optional)
                links.push(node);
            node = node.object;
        }
        else if (node.type === 'CallExpression') {
            if (node.optional)
                links.push(node);
            node = node.callee;
        }
        else if (node.type === 'TSNonNullExpression') {
            node = node.expression;
        }
        else {
            node = undefined;
        }
    }
    return links;
}
/** Index of `token` in code[from, to), skipping comments; -1 if absent. */
export function findToken(code, from, to, token) {
    let i = from;
    while (i < to) {
        if (code.startsWith('//', i)) {
            const next = code.indexOf('\n', i);
            i = next < 0 ? to : next + 1;
        }
        else if (code.startsWith('/*', i)) {
            const next = code.indexOf('*/', i + 2);
            i = next < 0 ? to : next + 2;
        }
        else if (code.startsWith(token, i)) {
            return i;
        }
        else {
            i++;
        }
    }
    return -1;
}
export function toPosition(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
}
// The most characters of code a description shows, and of a part it may hide behind `…` to keep the rest in view.
const LONG = 40;
const SHORT = 20;
function oneLine(source) {
    return source.replace(/\s+/g, ' ').trim();
}
/** `source` on one line, cut to `max` characters at the end. */
function snippet(source, max = LONG) {
    return cut(oneLine(source), max);
}
function cut(text, max) {
    return text.length > max ? `${text.slice(0, Math.max(max - 1, 0))}…` : text;
}
/**
 * `kept` followed by `rest`, for the description of a mutant that keeps only
 * `kept`. Past LONG characters, a `kept` longer than SHORT becomes `…` and
 * `rest` is cut at the end (before its closing `)` for a call), so what the
 * mutant removes stays in view: `… ?? fallback`, `….map(normalizeZero)`.
 */
function keeping(kept, rest, call = false) {
    if (kept.length + rest.length <= LONG)
        return { whole: kept + rest, kept };
    const shown = kept.length > SHORT ? '…' : kept;
    const close = call ? ')' : '';
    return { whole: shown + cut(call ? rest.slice(0, -1) : rest, LONG - shown.length - close.length) + close, kept: shown };
}
