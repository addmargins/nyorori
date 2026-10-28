// Policy P: the only source of thresholds, scope and trust lists (spec 2.3, 6.1).
// It lives in the trusted gate repository; nothing from the candidate tree
// (cccc.toml, eslint.config.js, .gitignore...) may influence these values.

import { z } from "zod";

const mode = z.enum(["enforce", "observe", "degraded"]);
const glob = z.string().min(1);

export const policySchema = z
  .object({
    schema_version: z.literal(1),
    /** Filled in by the loader from the gate repository commit; may be pinned in tests. */
    revision: z.string().default("unversioned"),

    measurer: z
      .object({
        cccc_version: z.string().default("cccc 1.8.5"),
        /** sha256 of the attested release binary. Empty disables the check (fixtures only). */
        cccc_sha256: z.string().regex(/^([0-9a-f]{64})?$/).default(""),
        timeout_ms: z.number().int().positive().default(120_000),
        chunk_size: z.number().int().positive().default(1000),
        jobs: z.number().int().positive().default(4),
        /** Fraction of runs re-measured with -j1 for the determinism check (spec 6.4). */
        determinism_sample_rate: z.number().min(0).max(1).default(0.05),
      })
      .strict()
      .default({}),

    scope: z
      .object({
        /** Extensions measured by cccc. */
        extensions: z
          .array(z.string())
          .default([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]),
        /** Declaration files are excluded (spec 2.3). */
        declaration_suffixes: z.array(z.string()).default([".d.ts", ".d.mts", ".d.cts"]),
        /** Code formats cccc cannot measure: recorded as unmeasured and routed to S11. */
        unmeasured_code_extensions: z
          .array(z.string())
          .default([".vue", ".svelte", ".astro", ".mdx"]),
        /**
         * Extensions that are clearly not code (docs, images, data). Any other
         * extension not listed anywhere makes the gate INCONCLUSIVE.
         */
        non_code_extensions: z
          .array(z.string())
          .default([
            ".md", ".txt", ".json", ".jsonc", ".yml", ".yaml", ".toml", ".lock",
            ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
            ".css", ".scss", ".sass", ".less", ".html", ".csv", ".snap", ".map",
            ".gitignore", ".gitattributes", ".gitmodules", ".npmrc", ".nvmrc",
            ".editorconfig", ".prettierrc", ".env.example", "",
          ]),
        /** Code in other languages: unmeasured FOREIGN_LANGUAGE, routed to S11 when it may hide JS/TS logic. */
        foreign_code_extensions: z
          .array(z.string())
          .default([
            ".py", ".sh", ".bash", ".zsh", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
            ".scala", ".php", ".pl", ".lua", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
            ".cs", ".tf", ".hcl", ".ps1", ".wasm",
          ]),
        exclude: z.array(glob).default([]),
        test_globs: z
          .array(glob)
          .default(["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "test/**", "tests/**"]),
        /** Globs of `.js` files that contain JSX and are measured with a `.jsx` suffix. */
        jsx_in_js: z.array(glob).default([]),
        max_file_bytes: z.number().int().positive().default(2 * 1024 * 1024),
        rename_similarity: z.number().int().min(1).max(100).default(70),
        /** Measure `.d.ts` on C anyway: an implementation there is a parse error (PARSE_ERROR_CANDIDATE). */
        declaration_impl_check: z.boolean().default(true),
        /** Paths whose change is routed to S11 and requires CODEOWNERS review. */
        sensitive_paths: z
          .array(glob)
          .default([".gitattributes", "**/.gitattributes", ".gitmodules"]),
      })
      .strict()
      .default({}),

    complexity: z
      .object({
        mode: mode.default("enforce"),
        cognitive_limit: z.number().int().nonnegative().default(15),
        /** S8 observe band [near_limit_low, cognitive_limit]. */
        near_limit_low: z.number().int().nonnegative().default(12),
        cyclomatic_observe_mark: z.number().int().positive().default(20),
        /** S2: inclusive CogC above this with own CogC within the limit. */
        inclusive_cognitive_trigger: z.number().int().positive().default(25),
        /** S2: new/changed anonymous child with own CogC at least this. */
        anonymous_child_trigger: z.number().int().positive().default(8),
        /** S11/UNITS_VANISHED: B unit count at which a drop to zero is suspicious. */
        vanish_min_units: z.number().int().positive().default(4),
        /** Test files are measured but only observed in v1. */
        enforce_on_tests: z.boolean().default(false),
      })
      .strict()
      .default({}),

    triggers: z
      .object({
        s1: z
          .object({
            visible_branch_slack: z.number().int().nonnegative().default(2),
            min_unit_increase: z.number().int().positive().default(3),
            min_max_cognitive_drop: z.number().int().positive().default(5),
          })
          .strict()
          .default({}),
        s4_max_function_lines: z.number().int().positive().default(60),
        s9: z
          .object({
            branch_drop_ratio: z.number().min(0).max(1).default(0.3),
            max_line_drop_ratio: z.number().min(0).max(1).default(0.3),
            density_drop_ratio: z.number().min(0).max(1).default(0.3),
            min_branch_drop: z.number().int().positive().default(3),
          })
          .strict()
          .default({}),
        s10: z
          .object({
            min_density: z.number().positive().default(0.6),
            min_new_units: z.number().int().positive().default(5),
          })
          .strict()
          .default({}),
        s3: z
          .object({
            min_single_importer_modules: z.number().int().positive().default(2),
            min_efferent_increase: z.number().int().positive().default(5),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),

    lint: z
      .object({
        mode: mode.default("enforce"),
        max_params: z.number().int().positive().default(4),
        max_nested_callbacks: z.number().int().positive().default(3),
        /**
         * Rules that block while `mode` is enforce. Empty means every block-category
         * rule. P1 lists only the dynamic-code rules (spec 13.1).
         */
        enforced_rules: z.array(z.string()).default([]),
        /** Files allowed to construct code dynamically (config loaders). Reviewed in the gate repo. */
        dynamic_code_allowlist: z.array(glob).default([]),
        /** Suppression comments that may be added (exact rule names / directive text). */
        suppression_allowlist: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),

    deps: z
      .object({
        mode: mode.default("enforce"),
        /** P1 blocks new cycles only; forbidden edges block from P2. */
        block_forbidden_edges: z.boolean().default(false),
        forbidden: z
          .array(z.object({ name: z.string(), from: z.string(), to: z.string() }).strict())
          .default([]),
      })
      .strict()
      .default({}),

    tests: z
      .object({
        mode: mode.default("enforce"),
        /** Paths whose modification needs independent approval (spec 8.3, 12.2). */
        protected_paths: z
          .array(glob)
          .default([
            "vitest.config.*", "vite.config.*", "jest.config.*", "stryker.conf*",
            ".c8rc*", ".nycrc*", "tsconfig*.json", "eslint.config.*", ".eslintrc*",
            ".dependency-cruiser.*", "cccc.toml", ".cccc.toml", ".github/**",
            ".gitignore", ".ignore", ".gitattributes",
          ]),
      })
      .strict()
      .default({}),

    coverage: z
      .object({
        mode: mode.default("observe"),
        max_unexecuted_branches_abs: z.number().int().nonnegative().default(2),
        max_unexecuted_branches_ratio: z.number().min(0).max(1).default(0.1),
        provider: z.string().default("v8"),
        provider_version: z.string().default(""),
        ignore_comment_allowlist: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),

    review: z
      .object({
        mode: mode.default("enforce"),
        simplification_reviewers: z.array(z.string()).default([]),
        waiver_approvers: z.array(z.string()).default([]),
        gate_owners: z.array(z.string()).default([]),
        /** Bot accounts never count as approvers. AI-loop bots are listed in ai_loop. */
        bots: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),

    waivers: z
      .object({
        per_pr_budget: z.number().int().nonnegative().default(3),
        per_quarter_budget: z.number().int().nonnegative().default(30),
        max_days: z.number().int().positive().default(90),
      })
      .strict()
      .default({}),

    ai_loop: z
      .object({
        bot_accounts: z.array(z.string()).default([]),
        max_retries: z.number().int().nonnegative().default(2),
      })
      .strict()
      .default({}),

    mutation: z
      .object({ mode: mode.default("observe") })
      .strict()
      .default({}),

    /**
     * Only artifacts from these workflow files at these commits are accepted
     * from the untrusted Actions job (spec 10.1).
     */
    provenance: z
      .object({
        trusted_workflows: z
          .array(
            z
              .object({ repository: z.string(), path: z.string(), shas: z.array(z.string()) })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({}),

    /** Parser-lag syntax list: the only parse errors a gate owner may override (spec 11.2). */
    parser_lag_allowlist: z.array(z.string()).default([]),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;

export function parsePolicy(input: unknown): Policy {
  return policySchema.parse(input);
}

/** The default policy with every starting value from the spec. */
export function defaultPolicy(overrides: Partial<PolicyInput> = {}): Policy {
  return parsePolicy({ schema_version: 1, ...overrides });
}
