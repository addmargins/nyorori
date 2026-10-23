var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx, extraExtensions, ignoreCase) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        if (extraExtensions) {
            for (var extension in extraExtensions) {
                var suffix = path.slice(-extension.length);
                if (suffix === extension || ignoreCase && suffix.toLowerCase() === extension.toLowerCase()) {
                    var output = extraExtensions[extension];
                    return output === extension ? path : path.slice(0, -extension.length) + output;
                }
            }
        }
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/**
 * Hosts one Vitest instance for the CLI. Runs as a separate, detached process
 * so the CLI can kill it (and every test worker with it) when a mutant hangs
 * a worker in a loop that never reaches a mutant site.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
import { SLOTS } from './mutate/profile.js';
import { PROVIDE } from './protocol.js';
import { checkVitestVersion, findVitest, ProjectError } from './vitest.js';
// The probe buffer goes back as the records of the probes that ran, keyed by probe key.
const SETUP = `import { inject, afterAll } from 'vitest'
const s = (globalThis.__nyorori ??= {})
s.active = inject(${JSON.stringify(PROVIDE.active)}) ?? 0
s.limit = inject(${JSON.stringify(PROVIDE.limit)}) ?? 0
s.hits = inject(${JSON.stringify(PROVIDE.collect)}) ? {} : null
const probes = inject(${JSON.stringify(PROVIDE.probes)}) ?? 0
s.prof = probes > 0 ? new Float64Array(probes * ${SLOTS}) : null
s.count = 0
s.exceeded = false
afterAll(({}, suite) => {
  if (s.hits !== null) suite.meta.nyororiHits = s.hits
  if (s.prof !== null) {
    const records = {}
    for (let i = 0; i < s.prof.length; i += ${SLOTS}) {
      if (s.prof[i + ${SLOTS - 1}] > 0) records[i / ${SLOTS}] = Array.from(s.prof.subarray(i, i + ${SLOTS}))
    }
    suite.meta.nyororiProfile = records
  }
  if (s.exceeded) suite.meta.nyororiExceeded = true
})
`;
let vitest;
let setupDir;
const plans = new Map();
/** Whether the plugin serves the profiled instrumentation (the baseline) rather than the plain one. */
let profiling = false;
/** The plugins whose transform runs before nyorori's (`order: 'pre'`, earlier in the list). */
let transformsBefore = [];
/** A planned file that reached the transform already changed: the run cannot judge it, whatever the tests say. */
let changedBefore;
// runTestSpecifications() returns every module the instance has ever run, so
// a file that failed for an earlier mutant would count as failing for later
// ones too. The reporter receives only the modules of the run that just ended.
let lastRun;
const collector = {
    onTestRunEnd(modules, errors) {
        lastRun = { modules, errors };
    },
};
function send(message) {
    process.send(message);
}
async function init(root, candidates, exclude, dir) {
    const vitestDir = findVitest(root);
    const pkg = JSON.parse(readFileSync(path.join(vitestDir, 'package.json'), 'utf8'));
    checkVitestVersion(pkg.version);
    const entry = pkg.exports['./node'].default ?? pkg.exports['./node'];
    const { createVitest } = (await import(__rewriteRelativeImportExtension(pathToFileURL(path.join(vitestDir, entry)).href)));
    // Vitest resolves a bare 'vitest' import to the running Vitest (its
    // vitest:resolve-core plugin) wherever the importer lives, so the setup file
    // can stay in the CLI's temporary directory instead of the project's node_modules.
    setupDir = dir;
    const setupFile = path.join(dir, 'setup.mjs');
    writeFileSync(setupFile, SETUP);
    const plugin = {
        name: 'nyorori',
        enforce: 'pre',
        // jsdom and happy-dom tests load setup files through Vite's /@fs/ route,
        // which serves only allowed directories; the setup file lives outside the project.
        configResolved(config) {
            config.server.fs.allow.push(dir);
            // Vite runs the `order: 'pre'` transforms first, in plugin order, then the rest.
            transformsBefore = config.plugins
                .slice(0, config.plugins.indexOf(plugin))
                .filter((p) => typeof p.transform === 'object' && p.transform.order === 'pre')
                .map((p) => p.name);
        },
        // `order: 'pre'`, not only `enforce: 'pre'`: plugins such as Vitest's own
        // vitest:meta-env-replacer (`import.meta.env`) or vite-plugin-solid are
        // `enforce: 'pre'` too, and would otherwise rewrite the file first.
        transform: {
            order: 'pre',
            handler(code, id) {
                const plan = plans.get(id.split('?')[0]);
                if (!plan)
                    return undefined;
                if (code !== plan.original) {
                    changedBefore ??= plan.file;
                    throw new Error(`nyorori: ${plan.file} reached the transform already changed by another plugin; it cannot be mutated.`);
                }
                return profiling ? plan.profiled : { code: plan.instrumented, map: plan.map };
            },
        },
    };
    // As the Vitest CLI does (prepareVitest): Vite would otherwise set NODE_ENV
    // to 'development', and tests or configs that check it would behave unlike `vitest run`.
    process.env.TEST = 'true';
    process.env.VITEST = 'true';
    process.env.NODE_ENV ??= 'test';
    vitest = await createVitest('test', {
        root,
        watch: false,
        reporters: [collector],
        // The on-disk transform cache is keyed by source, not by plan: a later
        // run would reuse code instrumented with another run's mutant ids.
        fsModuleCache: false,
        related: candidates,
        // As in CI: `false` means 'new' outside CI, which writes missing snapshots and passes.
        update: 'none',
        // Hits and profiles are attributed per test file by the setup file, which
        // Vitest runs only once per worker under `isolate: false` here, so later
        // files would record nothing and their code would look untested.
        isolate: true,
        // No bail: cancelling a run makes test files that never started report
        // their state from an earlier run, and can abort the next run, so a
        // killed mutant could pass as Survived and the other way round.
        passWithNoTests: true,
        coverage: { enabled: false },
        provide: { [PROVIDE.active]: 0, [PROVIDE.limit]: 0, [PROVIDE.collect]: false, [PROVIDE.probes]: 0 },
    }, { plugins: [plugin] });
    // Code that never passes through the plugin looks untested, so these setups
    // would fail the PR with false NoCoverage. Stop before judging anything.
    for (const project of vitest.projects) {
        const name = project.name ? `Vitest project "${project.name}"` : 'The Vitest config';
        if (project.config.browser.enabled) {
            throw new ProjectError(`${name} runs its tests in browser mode, which nyorori does not support yet.`);
        }
        if (!project.vite.config.plugins.includes(plugin)) {
            // Vitest gives such a project its own Vite server and does not pass it the root's plugins.
            throw new ProjectError(`${name} has its own Vite config (Vite options such as plugins, resolve or alias, or its own config file), so nyorori cannot instrument the code its tests run. This setup is not supported yet.`);
        }
        if (project.config.experimental.viteModuleRunner === false) {
            throw new ProjectError(`${name} sets experimental.viteModuleRunner: false, which skips the Vite transform nyorori instruments code with. This setup is not supported yet.`);
        }
        project.config.setupFiles.push(setupFile);
    }
    const config = vitest.config;
    const coverageInclude = config.coverage.include?.length ? picomatch(config.coverage.include, { dot: true }) : () => true;
    const coverageExclude = picomatch(config.coverage.exclude, { dot: true });
    const userExclude = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;
    // matchesTestGlob() knows only `include`: type tests (`*.test-d.ts`) and
    // benchmarks are test files too, whether or not typecheck or benchmark is enabled.
    const otherTests = vitest.projects.flatMap((project) => {
        const { typecheck, benchmark } = project.config;
        const dir = project.config.dir || project.config.root;
        return [typecheck, benchmark].map((globs) => ({ dir, matches: globMatcher(globs.include, globs.exclude) }));
    });
    const eligible = candidates.filter((file) => {
        const relative = path.relative(config.root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            return false;
        if (vitest.projects.some((project) => project.matchesTestGlob(file)))
            return false;
        if (otherTests.some(({ dir, matches }) => matches(path.relative(dir, file))))
            return false;
        return coverageInclude(relative) && !coverageExclude(relative) && !userExclude(relative);
    });
    // Tests are picked from the files that get mutants. A changed vitest.config
    // among them would make Vitest pick the whole suite (forceRerunTriggers),
    // including tests that only pass in the project's own CI setup.
    config.related = eligible;
    config.forceRerunTriggers = [];
    return eligible;
}
/**
 * A file another plugin changed before nyorori's transform makes its tests
 * fail to load. That says nothing about the tests, so the run stops here.
 */
function checkTransforms() {
    if (changedBefore === undefined)
        return;
    const file = path.relative(vitest.config.root, changedBefore);
    const which = transformsBefore.length > 0
        ? `Vite plugins whose transform runs before nyorori's: ${transformsBefore.join(', ')}.`
        : "No plugin's transform runs before nyorori's, so a plugin's load hook probably changed it.";
    throw new ProjectError(`${file} was changed by another Vite plugin before nyorori could instrument it, so its mutants cannot be judged. ${which} Leave the file out with --exclude to judge the rest.`);
}
function toRef(spec) {
    return { project: spec.project.name, moduleId: spec.moduleId, pool: spec.pool };
}
function fromRef(ref) {
    const project = vitest.projects.find((p) => p.name === ref.project);
    if (!project)
        throw new Error(`Unknown Vitest project "${ref.project}"`);
    return project.createSpecification(ref.moduleId, undefined, ref.pool);
}
/**
 * Switches the plugin between the profiled and the plain instrumentation. Vite
 * keeps transformed code, so every planned file is invalidated and transformed
 * again on the next run. Vitest 5.0.5 starts new workers for every run, even
 * with `isolate: false`; `watcher.invalidates` would also make a reused worker
 * drop the module it evaluated.
 */
function serveProfiled(profiled) {
    if (profiled === profiling)
        return;
    profiling = profiled;
    for (const file of plans.keys()) {
        vitest.invalidateFile(file);
        vitest.watcher.invalidates.add(file);
    }
}
async function run(active, limit, collect, profile, refs) {
    serveProfiled(profile > 0);
    for (const project of vitest.projects) {
        project.provide(PROVIDE.active, active);
        project.provide(PROVIDE.limit, limit);
        project.provide(PROVIDE.collect, collect);
        project.provide(PROVIDE.probes, profile);
    }
    const started = performance.now();
    lastRun = undefined;
    await vitest.runTestSpecifications(refs.map(fromRef));
    checkTransforms();
    if (!lastRun)
        throw new Error('Vitest finished a run without reporting it');
    const result = lastRun;
    const wall = performance.now() - started;
    const modules = result.modules.map((module) => {
        const meta = module.meta();
        const passed = module.ok();
        let error;
        if (!passed) {
            const failure = module.errors()[0] ?? [...module.children.allTests('failed')][0]?.result().errors?.[0];
            error = failure?.message ?? 'failed';
        }
        return {
            spec: { project: module.project.name, moduleId: module.moduleId, pool: poolOf(refs, module) },
            passed,
            hits: meta.nyororiHits ?? {},
            profile: meta.nyororiProfile ?? {},
            exceeded: meta.nyororiExceeded === true,
            duration: module.diagnostic().duration,
            error,
        };
    });
    return { type: 'result', modules, unhandledErrors: result.errors.map(describeError), wall };
}
process.on('message', async (request) => {
    try {
        switch (request.type) {
            case 'init':
                send({ type: 'ready', eligible: await init(request.root, request.candidates, request.exclude, request.setupDir) });
                break;
            case 'plan': {
                for (const file of request.files)
                    plans.set(file.file, file);
                // Finding the related tests transforms their imports too.
                const specs = await vitest.getRelevantTestSpecifications().finally(checkTransforms);
                send({ type: 'planned', specs: specs.map(toRef) });
                break;
            }
            case 'run':
                send(await run(request.active, request.limit, request.collect, request.profile, request.specs));
                break;
            case 'close':
                await vitest?.close();
                send({ type: 'closed' });
                break;
        }
    }
    catch (error) {
        const message = error instanceof ProjectError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
        send({ type: 'error', message });
    }
});
process.on('disconnect', () => {
    // The CLI removes the setup directory after the run; this covers a CLI that died first.
    if (setupDir)
        rmSync(setupDir, { recursive: true, force: true });
    process.exit(0);
});
function poolOf(refs, module) {
    const ref = refs.find((r) => r.project === module.project.name && r.moduleId === module.moduleId);
    if (!ref)
        throw new Error(`Vitest reported ${module.moduleId}, which this run did not ask for`);
    return ref.pool;
}
/** Matches paths relative to a project's directory, as Vitest globs its test files. */
function globMatcher(include = [], exclude = []) {
    if (include.length === 0)
        return () => false;
    const included = picomatch([...include], { dot: true });
    const excluded = exclude.length > 0 ? picomatch([...exclude], { dot: true }) : () => false;
    return (relative) => included(relative) && !excluded(relative);
}
/** Vitest's serialized errors may have no prototype, so `String(error)` can throw. */
function describeError(error) {
    if (typeof error === 'object' && error !== null && 'message' in error)
        return String(error.message);
    try {
        return JSON.stringify(error) ?? String(error);
    }
    catch {
        return 'unknown error';
    }
}
