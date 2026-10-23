import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffFiles, fileChanges, gitRoot, mergeBase } from './git.js';
import { generate, ParseError, typeQuestions } from './mutate/generate.js';
import { instrument, InstrumentError } from './mutate/instrument.js';
import { mergeProfile, predict } from './mutate/profile.js';
import { askTypes, typesNotAsked } from './mutate/typecheck.js';
import { EXPLAIN } from './report.js';
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
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
    const candidates = [...changed.keys()]
        .filter((file) => SOURCE.test(file) && !DECLARATION.test(file) && !file.split(path.sep).includes('node_modules'))
        .filter((file) => existsSync(file))
        .sort();
    const report = {
        gitRoot: repo,
        base,
        files: [],
        results: [],
        equivalent: [],
        skipped: [],
        unnecessary: [],
        suppressions: [],
        problems: [],
        types: options.types ? typesNotAsked() : { backend: 'none', reason: 'disabled with --no-types', untyped: [] },
        dryRun: options.dryRun,
    };
    if (candidates.length === 0)
        return report;
    // Holds the session's Vitest setup file. The CLI owns it because it SIGKILLs sessions.
    const setupDir = mkdtempSync(path.join(os.tmpdir(), 'nyorori-'));
    const start = () => Session.start({ type: 'init', root, candidates, exclude: options.exclude, setupDir });
    let session;
    try {
        session = await start();
        const plans = [];
        const mutants = [];
        const planned = new Map();
        const reformatted = new Set();
        const sources = session.eligible.map((file) => {
            const code = readFileSync(file, 'utf8');
            return { file, code, changes: fileChanges(repo, file, changed.get(file), code) };
        });
        let types;
        if (options.types) {
            // Generation is synchronous, so the type checker answers everything it will ask beforehand.
            const answers = await askTypes(root, sources.map(({ file, code, changes }) => typeQuestions(file, code, changes)));
            report.types = answers.usage;
            types = answers;
        }
        for (const { file, code, changes } of sources) {
            let generated;
            try {
                generated = generate(file, code, changes, mutants.length + 1, types);
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
            if (result.suppression) {
                if (status === 'Killed' || status === 'Timeout') {
                    report.problems.push({
                        file: result.suppression.file,
                        line: result.suppression.line,
                        message: `Unnecessary suppression: tests already detect mutant ${result.operator} ${result.description}. Remove it.`,
                    });
                }
                status = 'Ignored';
            }
            result.status = status;
            // The same words as the text output, so --json says why every failing mutant fails.
            if (status === 'Survived' || status === 'NoCoverage')
                result.reason ??= EXPLAIN[status];
        }
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
