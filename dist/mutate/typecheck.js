import { ChildProcess } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import { existsSync } from 'node:fs';
import path from 'node:path';
export async function loadTypeScript() {
    const [api, ast] = await Promise.all([import('typescript/async'), import('typescript/ast')]);
    return { api, ast };
}
const LIMITS = { start: 30_000, open: 30_000, ask: 5_000, close: 2_000 };
const TYPESCRIPT = /\.[cm]?tsx?$/;
const JAVASCRIPT = /\.[cm]?jsx?$/;
const NOT_ASKED = 'no `+`, `?.` or `??` on a changed line needed types';
const NO_PROJECT = 'not in any tsconfig.json project';
const UNCHECKED = 'TypeScript does not check this JavaScript (it needs checkJs and noImplicitAny or strict in a tsconfig.json or jsconfig.json)';
/** The usage before any file was asked about. */
export function typesNotAsked() {
    return { backend: 'none', reason: NOT_ASKED, untyped: [] };
}
/** Answers from the type pre-pass. */
export class TypeAnswers {
    usage;
    plusKinds;
    nonNullable;
    constructor(plusKinds, nonNullable, usage) {
        this.plusKinds = plusKinds;
        this.nonNullable = nonNullable;
        this.usage = usage;
    }
    plus(file, left, right) {
        return this.plusKinds.get(spanKey(file, left, right)) ?? 'unknown';
    }
    nonNullableType(file, value) {
        return this.nonNullable.get(spanKey(file, value, value));
    }
}
/** Where a question sits: from the start of `first` to the end of `last`. */
function spanKey(file, first, last) {
    return `${file}:${first.start}:${last.end}`;
}
/**
 * Answers the questions with the TypeScript 7 API, before generation, so
 * that generation stays synchronous. TypeScript starts only when some file has
 * questions, and every request races a timer: on a timeout, an error or an
 * exit of the TypeScript process, the process is killed and the remaining files
 * fall back to the syntax, with the reason in the usage.
 *
 * TypeScript answers for a TypeScript file in a tsconfig.json project, and for
 * a JavaScript file only where its project checks JavaScript as strictly as
 * TypeScript: elsewhere a JavaScript value can break the type TypeScript infers
 * for it (a `let` initialised with a string and later given a number) without
 * any error. Whether a value can be null is asked of TypeScript files only.
 */
export async function askTypes(root, questions, options = {}) {
    const plusKinds = new Map();
    const nonNullable = new Map();
    // TypeScript files with a `+` that went without types; one asked only about `?.` and `??` keeps
    // today's verdicts without them, so it is not listed, but its reason still explains the usage.
    const untyped = [];
    let reason;
    const without = (q, why) => {
        if (q.plus.length > 0)
            untyped.push({ file: q.file, reason: why });
        reason ??= why;
    };
    let typed = 0;
    let unchecked = false;
    let failure;
    const asked = [];
    for (const q of questions) {
        const typescript = TYPESCRIPT.test(q.file);
        const guarded = typescript ? q.guarded : [];
        if ((q.plus.length === 0 && guarded.length === 0) || (!typescript && !JAVASCRIPT.test(q.file)))
            continue;
        // TypeScript would put the file in an inferred project with default options; no need to start it for that.
        if (hasConfig(q.file))
            asked.push({ ...q, guarded });
        else if (typescript)
            without(q, NO_PROJECT);
        else
            unchecked = true;
    }
    if (asked.length > 0) {
        const server = new Server(root, options.load ?? loadTypeScript, options.limits ?? LIMITS);
        try {
            for (const q of asked) {
                const answer = await server.answer(q);
                if (typeof answer !== 'string') {
                    typed++;
                    q.plus.forEach(({ left, right }, i) => plusKinds.set(spanKey(q.file, left, right), answer.plus[i]));
                    q.guarded.forEach((value, i) => {
                        const type = answer.guarded[i];
                        if (type !== undefined)
                            nonNullable.set(spanKey(q.file, value, value), type);
                    });
                }
                else if (TYPESCRIPT.test(q.file)) {
                    without(q, answer);
                }
                else {
                    // JavaScript is normally judged by syntax alone, so it is not listed.
                    unchecked = true;
                }
            }
        }
        finally {
            await server.close();
        }
        failure = server.failure;
    }
    const usage = typed > 0
        ? { backend: 'typescript', files: typed, untyped }
        : { backend: 'none', reason: failure ?? reason ?? (unchecked ? UNCHECKED : NOT_ASKED), untyped };
    return new TypeAnswers(plusKinds, nonNullable, usage);
}
function hasConfig(file) {
    for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, 'tsconfig.json')) || existsSync(path.join(dir, 'jsconfig.json')))
            return true;
        if (path.dirname(dir) === dir)
            return false;
    }
}
/**
 * Whether the project reports what would break the types it infers for
 * JavaScript: an assignment or a call against them, or an untyped parameter.
 * The options are as written in the config, so TypeScript 7's default of
 * `strict` does not count: the project's own checker may be older.
 */
function checksJavaScript(options) {
    return options.checkJs === true && (options.noImplicitAny ?? options.strict ?? false);
}
/**
 * Without strictNullChecks no type includes null or undefined, so no type
 * rules them out. TypeScript 7 turns it on by default (through `strict`), but
 * the options are as written in the config and the project's own checker may
 * be older, where it is off: only a config that turns it on counts.
 */
function checksNulls(options) {
    return options.strictNullChecks ?? options.strict ?? false;
}
/** Requests that fail to reach an exited process; see `ignoreWriteFailures`. */
const WRITE_FAILURES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
/**
 * One TypeScript API process. It starts on the first file and each file is
 * opened the way an editor opens it, so TypeScript finds its project from the
 * nearest tsconfig.json, following references; a project loads once and serves
 * every file in it. After the first failure nothing more is asked.
 */
class Server {
    /** Why TypeScript cannot answer; once set, every file falls back to syntax. */
    failure;
    root;
    load;
    limits;
    ts;
    api;
    snapshot;
    child;
    /** Why the process is gone, once it exits on its own. */
    exited;
    /** Rejects the requests in flight when the process exits. */
    waiting = new Set();
    /** Every request made, to know when the last write to the process is over. */
    requests = [];
    stopIgnoring = ignoreWriteFailures();
    constructor(root, load, limits) {
        this.root = root;
        this.load = load;
        this.limits = limits;
    }
    async answer(q) {
        if (this.failure)
            return this.failure;
        let step = 'starting';
        try {
            if (!this.snapshot)
                await this.start();
            step = `opening ${path.relative(this.root, q.file)}`;
            const opened = await this.open(q.file);
            if (typeof opened === 'string')
                return opened;
            step = `asking about ${path.relative(this.root, q.file)}`;
            return await this.ask(opened, q);
        }
        catch (error) {
            const reason = error instanceof Timeout
                ? `TypeScript did not answer within ${error.ms / 1000} s (${step})`
                : `${step === 'starting' ? 'TypeScript is unavailable' : 'TypeScript failed'}: ${message(error)}`;
            this.fail(reason);
            return reason;
        }
    }
    /** Releases what the process holds if it is still answering, then kills it. */
    async close() {
        const api = this.api;
        if (api && !this.failure) {
            try {
                await this.within(this.limits.close, api.close());
            }
            catch {
                // It is killed below either way.
            }
        }
        this.kill();
        // A request may still fail to reach the process; its stray rejection comes with the request's own.
        void Promise.allSettled(this.requests).then(() => setImmediate(this.stopIgnoring));
    }
    async start() {
        // The client spawns its process on the first request and keeps it to itself;
        // Node announces every child process it creates on this channel.
        const spawned = [];
        const capture = (message) => {
            const child = message.process;
            if (!(child instanceof ChildProcess))
                return;
            spawned.push(child);
            child.once('exit', (code, signal) => {
                // A process that never started has no pid; the client reports why.
                if (child.pid === undefined || !isServer(child))
                    return;
                this.exited = new Error(`its process exited (${signal ?? code})`);
                for (const reject of this.waiting)
                    reject(this.exited);
            });
        };
        diagnostics.subscribe('child_process', capture);
        try {
            this.ts = await this.within(this.limits.start, this.load());
            this.api = new this.ts.api.API({ cwd: this.root });
            this.snapshot = await this.within(this.limits.start, this.api.createSnapshot());
        }
        finally {
            diagnostics.unsubscribe('child_process', capture);
            // Its arguments are set when it is spawned, just after the announcement.
            this.child = spawned.find(isServer);
        }
    }
    async open(file) {
        this.snapshot = await this.within(this.limits.open, this.snapshot.update({ openFiles: [file] }));
        const project = await this.within(this.limits.ask, this.snapshot.getDefaultProjectForFile(file));
        // A file outside every tsconfig.json lands in an inferred project with default options.
        if (!project?.configFileName)
            return JAVASCRIPT.test(file) ? UNCHECKED : NO_PROJECT;
        const options = project.program.getCompilerOptions();
        if (JAVASCRIPT.test(file) && !checksJavaScript(options))
            return UNCHECKED;
        const source = await this.within(this.limits.ask, project.program.getSourceFile(file));
        if (!source)
            return NO_PROJECT;
        return { checker: project.checker, source, nulls: checksNulls(options), uncheckedIndex: options.noUncheckedIndexedAccess === true };
    }
    /**
     * Asks about every `+` and every guarded value of a file at once: one batch
     * for their types (and the symbols of property names), one for union members
     * and type names.
     */
    async ask({ checker, source, nulls, uncheckedIndex }, q) {
        const { ast, api } = this.ts;
        const nodes = [];
        const plus = q.plus.map(({ left, right }) => {
            // The left operand ends where the `+` token's leading trivia starts.
            const binary = ast.getTokenAtPosition(source, left.end).parent;
            // Offsets disagree when TypeScript reads the text differently, e.g. without a byte order mark.
            if (!ast.isBinaryExpression(binary) || binary.operatorToken.kind !== ast.SyntaxKind.PlusToken ||
                binary.left.end !== left.end || binary.right.end !== right.end)
                return -1;
            nodes.push(binary, binary.left, binary.right);
            return nodes.length - 3;
        });
        // Their symbols tell a declared property from one found through an index signature or put together by a spread.
        const names = [];
        const guarded = q.guarded.map((value) => {
            const found = nulls ? guardedValue(ast, source, value) : undefined;
            if (!found)
                return undefined;
            // Without noUncheckedIndexedAccess, `xs[i]` has the element type even past the end.
            if (!uncheckedIndex && ast.isElementAccessExpression(found.inner))
                return undefined;
            nodes.push(found.node);
            const name = ast.isPropertyAccessExpression(found.inner) ? names.push(found.inner.name) - 1 : -1;
            return { node: found.node, at: nodes.length - 1, name };
        });
        if (nodes.length === 0)
            return { plus: plus.map(() => 'unknown'), guarded: guarded.map(() => undefined) };
        // Requests made together go to the process as one batch.
        const [types, symbols] = await this.within(this.limits.ask, Promise.all([
            checker.getTypeAtLocation(nodes),
            names.length > 0 ? checker.getSymbolAtLocation(names) : [],
        ]));
        // Union members and type names come in one more round trip.
        const [kinds, nonNullable] = await this.within(this.limits.ask, Promise.all([
            Promise.all(plus.map((i) => i < 0 ? 'unknown' : classify(api.TypeFlags, types[i], types[i + 1], types[i + 2]))),
            Promise.all(guarded.map(async (g) => {
                if (!g)
                    return undefined;
                if (g.name >= 0) {
                    const symbol = symbols[g.name];
                    // Through an index signature: no symbol of its own (`Record<string, T>`), or the signature's.
                    if (!uncheckedIndex && (!symbol || (symbol.checkFlags & api.CheckFlags.IndexSymbol) !== 0))
                        return undefined;
                    // Put together from several declarations, as by a spread: `{ tags: [], ...options }` has
                    // `tags: string[]` even where `options.tags` is optional and explicitly undefined.
                    if (symbol && symbol.declarations.length > 1)
                        return undefined;
                }
                const type = types[g.at];
                const [never, text] = await Promise.all([cannotBeNullish(api, type), checker.typeToString(type, g.node)]);
                return never ? text : undefined;
            })),
        ]));
        return { plus: kinds, guarded: nonNullable };
    }
    /** Settles as `promise` does, unless `ms` pass or the process exits first. */
    within(ms, promise) {
        this.requests.push(promise);
        return new Promise((resolve, reject) => {
            const done = () => {
                clearTimeout(timer);
                this.waiting.delete(fail);
            };
            const fail = (error) => {
                done();
                reject(error);
            };
            const timer = setTimeout(() => fail(new Timeout(ms)), ms);
            this.waiting.add(fail);
            // Handled even after a timeout, so a late rejection is not left unhandled.
            promise.then((value) => {
                done();
                resolve(value);
            }, fail);
            if (this.exited)
                fail(this.exited);
        });
    }
    /** After one failure nothing TypeScript says is trusted, and its process goes. */
    fail(reason) {
        this.failure ??= reason;
        // Releasing the snapshots would be another request to a process that may be hung or gone.
        this.kill();
    }
    kill() {
        this.child?.kill('SIGKILL');
        this.api = undefined;
        this.snapshot = undefined;
    }
}
function isServer(child) {
    return child.spawnargs.includes('--api');
}
class Timeout extends Error {
    ms;
    constructor(ms) {
        super(`no answer within ${ms} ms`);
        this.ms = ms;
    }
}
/**
 * The type of the whole `+` is how the checker resolved it: `string` when
 * either side is string-like (a template literal type, a string enum, a type
 * parameter constrained to string), `number` or `bigint` when both sides are.
 */
async function classify(flags, whole, left, right) {
    if (whole.flags & flags.StringLike)
        return 'string';
    if (whole.flags & (flags.NumberLike | flags.BigIntLike))
        return 'numeric';
    // A `+` that does not type-check, like `string | undefined` plus a number, is `any`;
    // a string among an operand's possible types still makes it a concatenation.
    const mayBeString = async (type) => (type.flags & flags.StringLike) !== 0 || (type.isUnionType() && (await type.getTypes()).some((t) => (t.flags & flags.StringLike) !== 0));
    return (await mayBeString(left)) || (await mayBeString(right)) ? 'string' : 'unknown';
}
/**
 * The node of a value that a `?.` or `??` guards, found from the token right
 * after it, and the value inside its parentheses. Undefined where the offsets
 * disagree, or where an assertion states the type instead of the checker
 * finding it: `x!`, `x as T` or `<T>x` itself, or an `as` further down the
 * chain, as in `(r as T).isEscaped`, which has T's type even where `r` is a
 * string. A `!` further down is harmless: in `x!.y?.z` a null `x` makes the
 * chain throw before the `?.`, mutated or not.
 */
function guardedValue(ast, source, value) {
    // The value ends where the leading trivia of its `?.` or `??` starts.
    const token = ast.getTokenAtPosition(source, value.end);
    const parent = token.parent;
    let node;
    if (token.kind === ast.SyntaxKind.QuestionDotToken &&
        (ast.isPropertyAccessExpression(parent) || ast.isElementAccessExpression(parent) || ast.isCallExpression(parent))) {
        node = parent.expression;
    }
    else if (token.kind === ast.SyntaxKind.QuestionQuestionToken && ast.isBinaryExpression(parent)) {
        node = parent.left;
    }
    if (!node || node.end !== value.end)
        return undefined;
    let inner = node;
    while (ast.isParenthesizedExpression(inner))
        inner = inner.expression;
    if (ast.isNonNullExpression(inner))
        return undefined;
    for (let n = inner;;) {
        if (ast.isAsExpression(n) || ast.isTypeAssertion(n))
            return undefined;
        if (ast.isParenthesizedExpression(n) || ast.isNonNullExpression(n) || ast.isPropertyAccessExpression(n) ||
            ast.isElementAccessExpression(n) || ast.isCallExpression(n))
            n = n.expression;
        else
            return { node, inner };
    }
}
/**
 * Whether no value of `type` is null or undefined: a string, number, bigint,
 * boolean, enum, symbol, object or function type, or a union of only those.
 * `any`, `unknown`, `void`, a type parameter and other generic types (`T[K]`,
 * conditional types) may be null, and so may a mapped type: `Readonly<T>` and
 * `Partial<T>` are null when `T` is. An intersection cannot be null when one
 * of its members cannot, as in `T & {}`.
 */
async function cannotBeNullish(api, type) {
    const one = (t) => (t.flags & api.TypeFlags.DefinitelyNonNullable) !== 0 &&
        !(t.isObjectType() && (t.objectFlags & (api.ObjectFlags.Mapped | api.ObjectFlags.ReverseMapped)) !== 0);
    if (type.isUnionType())
        return (await type.getTypes()).every(one);
    if (type.isIntersectionType())
        return (await type.getTypes()).some(one);
    return one(type);
}
/**
 * The client's JSON-RPC layer rethrows a failed write from inside an async
 * promise executor, so a request to a process that has just exited also
 * surfaces as an unhandled rejection, which would end the CLI with exit code 1.
 * The request itself rejects too, and that is what makes the fallback. Other
 * unhandled rejections behave as before. Returns the function that stops this.
 */
function ignoreWriteFailures() {
    const listener = (reason) => {
        const code = reason instanceof Error && 'code' in reason ? reason.code : undefined;
        if (typeof code === 'string' && WRITE_FAILURES.has(code))
            return;
        // Alone, this listener would silence Node's default: throw, as Node does.
        if (process.listenerCount('unhandledRejection') === 1)
            throw reason;
    };
    process.on('unhandledRejection', listener);
    return () => {
        process.off('unhandledRejection', listener);
    };
}
function message(error) {
    // A missing binary is explained over several lines; the first one names the problem.
    return (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/\.$/, '');
}
