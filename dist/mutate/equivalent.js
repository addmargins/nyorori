import { minifySync } from 'oxc-minify';
import { transformSync } from 'oxc-transform';
// The minifier only reads plain JavaScript, so types and JSX are stripped first.
const NEEDS_TRANSFORM = /\.(?:[cm]?ts|[jt]sx)$/;
const COMMONJS = /\.c[jt]s$/;
/**
 * Trivial Compiler Equivalence (TCE): drops every mutant whose file minifies
 * to exactly the original's minified code, e.g. a change in a dead branch.
 * Returns the sites that still have mutants and the mutants it dropped.
 */
export function dropEquivalent(file, code, sites) {
    const equivalent = [];
    if (sites.length === 0)
        return { sites, equivalent };
    const original = normalize(file, code);
    if (original === undefined)
        return { sites, equivalent };
    const kept = [];
    for (const site of sites) {
        const mutants = site.mutants.filter((planned) => {
            if (normalize(file, applyMutant(code, site, planned)) !== original)
                return true;
            const { id: _, ...mutant } = planned.mutant;
            equivalent.push(mutant);
            return false;
        });
        if (mutants.length > 0)
            kept.push({ ...site, mutants });
    }
    return { sites: kept, equivalent };
}
/**
 * Minified JavaScript for a source file, or undefined when oxc reports an
 * error or produces nothing. On input it cannot parse (TypeScript included),
 * the minifier returns empty code plus errors instead of throwing, so two
 * failures would otherwise compare equal and drop a real mutant.
 */
export function normalize(file, code) {
    try {
        let js = code;
        if (NEEDS_TRANSFORM.test(file)) {
            const transformed = transformSync(file, code);
            if (transformed.errors.length > 0 || transformed.code.trim() === '')
                return undefined;
            js = transformed.code;
        }
        const commonjs = COMMONJS.test(file);
        const minified = minifySync(commonjs ? 'file.cjs' : 'file.js', js, { module: !commonjs, mangle: false, compress: { target: 'esnext' } });
        if (minified.errors.length > 0 || minified.code.trim() === '')
            return undefined;
        return minified.code;
    }
    catch {
        return undefined;
    }
}
/**
 * The whole file with one mutant applied, written the way the instrumenter
 * writes it: the replacement is parenthesized so operator precedence cannot
 * regroup it (`a && b && c` with the inner `&&` → `||`), and a statement that
 * starts with the site is wrapped in a block (see Site.statement).
 */
export function applyMutant(code, site, planned) {
    if (site.kind === 'body')
        return `${code.slice(0, site.start)} return;${code.slice(site.start)}`;
    const mutated = `${code.slice(0, site.start)}(${planned.replacement})${code.slice(site.end)}`;
    if (!site.statement)
        return mutated;
    // The statement starts at the site, so only its end moves.
    const end = site.statement.end + mutated.length - code.length;
    return `${mutated.slice(0, site.statement.start)}{ ${mutated.slice(site.statement.start, end)} }${mutated.slice(end)}`;
}
