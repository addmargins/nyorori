import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deletedFiles, diffFiles, fileChanges, gitRoot, mergeBase } from './git.js';
import { generate, ParseError, typeQuestions } from './mutate/generate.js';
import { instrument, InstrumentError } from './mutate/instrument.js';
import { mergeProfile, predict } from './mutate/profile.js';
import { askTypes, typesNotAsked } from './mutate/typecheck.js';
import { EXPLAIN, UNTESTED_SUPPRESSION } from './report.js';
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
/**
 * Single-file component formats a Vite plugin compiles to JavaScript. They hold
 * code a PR changes like any other, but nyorori cannot parse or instrument them.
 */
const COMPONENT = /\.(?:vue|svelte|astro|mdx|marko|g[jt]s)$/;
/** The run cannot produce a verdict: bad input, failing baseline, or a tool failure. */
export class RunError extends Error {
}
export async function run(options) {
    const root = path.resolve(options.root);
    const repo = gitRoot(root);
    let base;
    try {
        base = mergeBase(root, options.base);
    }
    catch {
        throw new RunError(`Cannot find a merge base between ${options.base} and HEAD. In GitHub Actions, check out with \`fetch-depth: 0\`.`);
    }
    const changed = diffFiles(root, base);
    const relative = (file) => path.relative(repo, file);
    const notJudged = [];
    for (const file of deletedFiles(root, base))
        if (isCode(file))
            notJudged.push({ file, reason: 'deleted' });
    const candidates = [];
    for (const file of changed.keys()) {
        if (!isCode(file))
            continue;
        if (file.split(path.sep).includes('node_modules'))
            notJudged.push({ file, reason: 'node_modules' });
        else if (DECLARATION.test(file))
            notJudged.push({ file, reason: 'declaration' });
        else if (!existsSync(file))
            notJudged.push({ file, reason: 'deleted' });
        else
            candidates.push(file);
    }
    candidates.sort();
    const report = {
        gitRoot: repo,
        base,
        judged: [],
        files: [],
        notJudged: [],
        results: [],
        equivalent: [],
        skipped: [],
        unnecessary: [],
        suppressions: [],
        problems: [],
        types: options.types ? typesNotAsked() : { backend: 'none', reason: 'disabled with --no-types', untyped: [] },
        dryRun: options.dryRun,
        logGuards: options.logGuards,
    };
    const listNotJudged = () => {
        report.notJudged = notJudged.map(({ file, reason }) => ({ file: relative(file), reason })).sort((a, b) => a.file.localeCompare(b.file));
    };
    listNotJudged();
    if (candidates.length === 0)
        return report;
    // Holds the session's Vitest setup file. The CLI owns it because it SIGKILLs sessions.
    const setupDir = mkdtempSync(path.join(os.tmpdir(), 'nyorori-'));
    const start = () => Session.start({ type: 'init', root, candidates, exclude: options.exclude, setupDir });
    let session;
    try {
        session = await start();
        notJudged.push(...session.notJudged);
        // What is left of the components is code nyorori cannot judge: the run
        // stops (exit 2) rather than pass a PR that may change only them.
        for (const file of session.eligible)
            if (COMPONENT.test(file))
                notJudged.push({ file, reason: 'unsupported' });
        listNotJudged();
        if (!options.dryRun && report.notJudged.some((f) => f.reason === 'unsupported'))
            return report;
        const eligible = session.eligible.filter((file) => SOURCE.test(file));
        report.judged = eligible.map(relative);
        const plans = [];
        const mutants = [];
        const planned = new Map();
        const reformatted = new Set();
        const sources = eligible.map((file) => {
            const code = readFileSync(file, 'utf8');
            return { file, code, changes: fileChanges(repo, file, changed.get(file), code) };
        });
        let types;
        if (options.types) {
            // Generation is synchronous, so the type checker answers everything it will ask beforehand.
            const answers = await askTypes(root, sources.map(({ file, code, changes }) => typeQuestions(file, code, changes, options)));
            report.types = answers.usage;
            types = answers;
        }
        for (const { file, code, changes } of sources) {
            let generated;
            try {
                generated = generate(file, code, changes, mutants.length + 1, types, options);
            }
            catch (error) {
                if (error instanceof ParseError)
                    throw new RunError(`Cannot parse ${relative(file)}: ${error.message}`);
                throw error;
            }
            report.equivalent.push(...generated.equivalent);
            report.suppressions.push(...generated.suppressions);
            for (const suppression of generated.reformatted)
                reformatted.add(suppression);
            report.problems.push(...generated.problems);
            if (generated.mutants.length === 0)
                continue;
            mutants.push(...generated.mutants);
            for (const site of generated.sites)
                for (const p of site.mutants)
                    planned.set(p.mutant.id, p);
            report.files.push(relative(file));
            let instrumented;
            let profiled;
            try {
                instrumented = instrument(file, code, generated.sites);
                profiled = instrument(file, code, generated.sites, { profile: true });
            }
            catch (error) {
                if (error instanceof InstrumentError)
                    throw new RunError(`nyorori bug: ${error.message}`);
                throw error;
            }
            plans.push({ file, original: code, instrumented: instrumented.code, map: instrumented.map, profiled });
        }
        if (options.maxMutants !== undefined && mutants.length > options.maxMutants) {
            throw new RunError(`${mutants.length} mutants exceed --max-mutants ${options.maxMutants}. Split the PR or raise the limit.`);
        }
        const suppressionOf = (mutant) => report.suppressions.find((s) => s.file === mutant.file && s.targetLine === mutant.line && s.operators.includes(mutant.operator));
        let results = mutants.map((mutant) => ({ ...mutant, status: 'NoCoverage', suppression: suppressionOf(mutant), tests: [] }));
        report.results = results;
        if (options.dryRun || results.length === 0) {
            reportUnusedSuppressions(report, reformatted);
            return report;
        }
        const specs = await session.plan(plans);
        const coverage = new Map();
        // How often the baseline evaluated each mutant's site, over all test files.
        const evaluations = new Map();
        // What the probes recorded, by probe key, over all test files.
        const records = new Map();
        let baselineWall = 0;
        if (specs.length > 0) {
            // Ids run from 1, and probe keys are ids.
            const probes = mutants.length + 1;
            const baseline = await session.run({ type: 'run', active: 0, limit: 0, collect: true, profile: probes, specs });
            if (baseline === 'timeout')
                throw new RunError('Baseline run timed out');
            const failed = baseline.modules.filter((m) => !m.passed);
            if (failed.length > 0 || baseline.unhandledErrors.length > 0) {
                const details = failed.map((m) => `  ${relative(m.spec.moduleId)}: ${m.error}`).concat(baseline.unhandledErrors.map((e) => `  ${e}`));
                throw new RunError(`Tests fail without any mutant, so mutants cannot be judged:\n${details.join('\n')}`);
            }
            baselineWall = baseline.wall;
            for (const module of baseline.modules) {
                for (const [id, hits] of Object.entries(module.hits)) {
                    const entry = coverage.get(Number(id)) ?? { specs: [], hits: 0 };
                    entry.specs.push(module.spec);
                    entry.hits = Math.max(entry.hits, hits);
                    coverage.set(Number(id), entry);
                    evaluations.set(Number(id), (evaluations.get(Number(id)) ?? 0) + hits);
                }
                mergeProfile(records, module.profile);
            }
        }
        // What the profile settles before anything runs: mutants certain to survive, by id, with the reason.
        const survivors = new Map();
        results = results.filter((result) => {
            const { mutant, profile: probed } = planned.get(result.id);
            const prediction = probed && predict(probed.rule, records.get(probed.probe.key), evaluations.get(result.id) ?? 0);
            if (prediction?.verdict === 'concatenation') {
                // A `+` that only ever joined strings is left alone, like one with a string literal.
                report.skipped.push({ ...mutant, reason: prediction.reason });
                return false;
            }
            // A suppression still decides the mutants it names: they stay Ignored.
            if (prediction?.verdict === 'unnecessary' && !result.suppression) {
                const tests = (coverage.get(result.id)?.specs ?? []).map((spec) => relative(spec.moduleId));
                report.unnecessary.push({ ...mutant, reason: prediction.reason, tests });
                return false;
            }
            if (prediction)
                survivors.set(result.id, prediction.reason);
            return true;
        });
        report.results = results;
        reportUnusedSuppressions(report, reformatted);
        const runMutant = async (id, covered) => {
            const request = { type: 'run', active: id, limit: covered.hits * 100 + 10_000, collect: false, profile: 0, specs: covered.specs };
            const outcome = await session.run(request, baselineWall * 2 + options.timeout);
            if (outcome !== 'timeout')
                return judge(outcome.modules, outcome.unhandledErrors);
            session.kill();
            session = await start();
            await session.plan(plans);
            return 'Timeout';
        };
        for (const result of results) {
            const covered = coverage.get(result.id);
            const prediction = survivors.get(result.id);
            let status = 'NoCoverage';
            if (covered) {
                result.tests = covered.specs.map((spec) => relative(spec.moduleId));
                if (prediction !== undefined)
                    result.reason = prediction;
                if (prediction !== undefined && options.predict) {
                    status = 'Survived';
                    result.predicted = true;
                }
                else {
                    status = await runMutant(result.id, covered);
                    // A wrong prediction: flaky tests, or a nyorori bug.
                    if (prediction !== undefined && status !== 'Survived')
                        result.mispredicted = status;
                }
            }
            // A suppression ignores survivors only. A killed mutant stays Killed, and one no test runs stays
            // NoCoverage: why a change cannot be seen says nothing about code that no test runs.
            if (result.suppression && status === 'Survived')
                status = 'Ignored';
            if (result.suppression && status === 'NoCoverage')
                result.reason = UNTESTED_SUPPRESSION;
            result.status = status;
            // The same words as the text output, so --json says why every failing mutant fails.
            if (status === 'Survived' || status === 'NoCoverage')
                result.reason ??= EXPLAIN[status];
        }
        reportUnnecessarySuppressions(report);
        if (!options.predict) {
            // Run too, to check the category: the profile says they survive, whatever the types say.
            for (const mutant of report.unnecessary) {
                const covered = coverage.get(mutant.id);
                const status = covered ? await runMutant(mutant.id, covered) : 'NoCoverage';
                if (status !== 'Survived')
                    mutant.mispredicted = status;
            }
        }
        return report;
    }
    finally {
        await session?.close();
        rmSync(setupDir, { recursive: true, force: true });
    }
}
/**
 * A suppression this PR added that matches no judged mutant would only pile
 * up. One above a line the PR only reformatted cannot match anything here.
 */
function reportUnusedSuppressions(report, reformatted) {
    const used = new Set(report.results.map((result) => result.suppression));
    for (const suppression of report.suppressions) {
        if (suppression.isNew && !used.has(suppression) && !reformatted.has(suppression)) {
            report.problems.push({
                file: suppression.file,
                line: suppression.line,
                message: `Suppression matches no mutant of ${suppression.operators.join(', ')} on line ${suppression.targetLine}. Remove it.`,
            });
        }
    }
}
/** JavaScript, TypeScript or a component format: a file a PR changes code in. */
function isCode(file) {
    return SOURCE.test(file) || COMPONENT.test(file);
}
/**
 * A suppression is needed while one of its mutants survives, predicted or
 * run. One whose mutants the tests all kill would only hide the next change
 * there. A fast path like `if (arr.length === 0) return []` keeps one: its
 * `→ false` is equivalent even though its `→ true` is killed.
 */
function reportUnnecessarySuppressions(report) {
    for (const suppression of report.suppressions) {
        const matched = report.results.filter((result) => result.suppression === suppression);
        if (matched.length === 0 || !matched.every(({ status }) => status === 'Killed' || status === 'Timeout'))
            continue;
        report.problems.push({
            file: suppression.file,
            line: suppression.line,
            message: `Unnecessary suppression: tests already detect every mutant it matches (${matched.map((m) => `${m.operator} ${m.description}`).join(', ')}). Remove it.`,
        });
    }
}
function judge(modules, unhandledErrors) {
    if (modules.some((m) => m.exceeded))
        return 'Timeout';
    if (unhandledErrors.length > 0 || modules.some((m) => !m.passed))
        return 'Killed';
    return 'Survived';
}
/** CLI side of the Vitest session process (see session.ts). */
class Session {
    eligible = [];
    notJudged = [];
    child;
    waiting;
    constructor(child) {
        this.child = child;
        child.on('message', (response) => {
            const resolve = this.waiting;
            this.waiting = undefined;
            resolve?.(response);
        });
        child.on('exit', (code, signal) => {
            const resolve = this.waiting;
            this.waiting = undefined;
            resolve?.({ type: 'error', message: `Vitest session exited unexpectedly (${signal ?? code})` });
        });
    }
    static async start(init) {
        const entry = new URL(import.meta.url.endsWith('.ts') ? './session.ts' : './session.js', import.meta.url);
        // Detached so the session leads its own process group and kill() also stops its test workers.
        const child = fork(entry, [], { cwd: init.root, detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const session = new Session(child);
        const response = await session.send(init);
        if (response === 'timeout' || response.type !== 'ready') {
            await session.close();
            throw unexpected(response);
        }
        session.eligible = response.eligible;
        session.notJudged = response.notJudged;
        return session;
    }
    async plan(files) {
        const response = await this.send({ type: 'plan', files });
        if (response === 'timeout' || response.type !== 'planned')
            throw unexpected(response);
        return response.specs;
    }
    async run(request, timeout) {
        const response = await this.send(request, timeout);
        if (response === 'timeout')
            return response;
        if (response.type !== 'result')
            throw unexpected(response);
        return response;
    }
    /** Lets Vitest remove its temporary files. A session that does not answer in time is killed. */
    async close() {
        if (this.child.connected)
            await this.send({ type: 'close' }, 5_000);
        this.kill();
    }
    kill() {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        try {
            process.kill(-this.child.pid, 'SIGKILL');
        }
        catch {
            this.child.kill('SIGKILL');
        }
    }
    send(request, timeout) {
        return new Promise((resolve) => {
            const timer = timeout === undefined ? undefined : setTimeout(() => {
                this.waiting = undefined;
                resolve('timeout');
            }, timeout);
            this.waiting = (response) => {
                clearTimeout(timer);
                resolve(response);
            };
            this.child.send(request);
        });
    }
}
function unexpected(response) {
    if (response === 'timeout')
        return new RunError('Vitest session timed out');
    return new RunError(response.type === 'error' ? response.message : `Unexpected response from Vitest session: ${response.type}`);
}
