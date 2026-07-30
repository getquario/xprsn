# xprsn

Tiny, CSP-safe expression language for JavaScript. Zero runtime dependencies, plain JS + JSDoc (no TypeScript).

## Commands

- `npm run check` — the full local pull-request CI gate: build, size limits, unit/types, browser CSP coverage, and deterministic fuzz regression.
- **Non-negotiable: run `npm run check` before declaring any work done.** Passing unit tests alone is not done — a change is complete only when the full gate above is green. Never say "done", close an issue, or hand off without it.
- `npm test` — Node's built-in test runner under `--disallow-code-generation-from-strings` (strict-CSP simulation), then `npm run test:types`, a plain `tsc` that type-checks `src/` **and** `test/types.check.ts` in one pass. No build needed. Keep this on Node: Bun accepts that V8 flag but does not enforce it.
- `npm run build` — tsdown (rolldown + oxc), configured in `tsdown.config.js` → `dist/` (ESM only, ES2024). Type generation is off (`dts: false`); the hand-written `src/index.d.ts` is carried over by tsdown's `copy`.
- `npm run size` — size-limit checks the gzip size of `dist/index.js` against the budget in `package.json`.
- `npm run test:browser` — builds the package and runs the browser bundle in Playwright Chromium under a strict CSP.
- Run a single suite: `node --disallow-code-generation-from-strings --test test/evaluate.test.js`
- `npm run bench` — zero-dependency micro-benchmarks in `bench/`, run against `src/`. Measures compile (parse) and evaluate throughput separately, since the design is compile-once, evaluate-many. `bench/` is not in `files`, so it is never published.
- `npm run fuzz` — jazzer.js fuzz targets in `fuzz/` (compile / evaluate / structured), against `src/`, 60s each. `npm run fuzz:regression` deterministically replays the minimized committed corpus (CI-safe, used by `.github/workflows/fuzz.yml`). Nightly discovery restores and updates a private GitHub Actions corpus cache. The structured target asserts the real safety properties — no prototype pollution, blocked-key reads throw, deterministic eval — not just "doesn't crash". `fuzz/` is not in `files`, so it is never published.

## Architecture

The entire implementation is `src/index.js` (~200 lines, one file by design). It is a **closure compiler**: a one-regex tokenizer feeds a precedence-climbing parser that emits nested arrow functions, so `compile(expr)` returns a plain `(values) => result` function. There is no AST, no node classes, and no code generation — that is what makes it CSP-safe.

Parser state (`toks`, `i`, `fns`) is module-level and shared; parsing is synchronous so this is safe. Grammar entry points, lowest to highest binding: `ternary` → `expr` (binary ops via the `PREC` table) → `unary` → `postfix` (`.prop`, `[idx]`, method calls) → `primary`.

## Hard constraints

1. **CSP safety is non-negotiable.** Never introduce `eval`, `new Function`, string `setTimeout`, or any string-to-code path. A test greps the source for these, and the whole suite runs under `--disallow-code-generation-from-strings`. Don't even use the words "eval" or "new Function" in comments — the source-scan test flags them.
2. **The `get()` guard is the security boundary.** Every dynamic key read (property, index, method lookup, bare variable names) must go through it. It blocks `__proto__`/`constructor`/`prototype` to close the `x.constructor.constructor(...)` escape to Function. Never add a read path that bypasses it.
3. Hash literals must stay null-prototype (`Object.create(null)`) so `{"__proto__": x}` cannot pollute. `in` on objects must use `Object.hasOwn`, never the JS `in` operator. Expression functions resolve only from the registry passed to `compile`, at compile time.
4. **Size is a soft goal (~1.2KB min+gzip).** Code is written lukeed-style *for* the minifier and gzip: single-letter-manglable module-private arrows, repetition over abstraction, data-driven operator tables. Prefer terse constructs, but never trade a safety guard or a passing test for bytes. Check the size impact of changes with `npm run build`.

## Omakase pragmatism

Apply this across the whole project: implementation, API design, tests, documentation, dependencies, and tooling. Prefer cohesive defaults and one obvious path over knobs, abstraction, or infrastructure. Test the guarantee users rely on directly, and add complexity only when concrete pressure justifies it. These preferences never weaken the hard safety constraints.

## Semantics to preserve

- `==`/`!=` compile to strict `===`/`!==` (documented, intentional).
- `and`/`or`/`&&`/`||` and `??` short-circuit; `**` is right-associative; `??` has the lowest binary precedence.
- `a ?: b` yields the condition's value when truthy, else `b`.
- Absence normalizes to `null`: a missing key/variable reads as `null` (in `get()`), so `x == null` is the natural nothing-test. Present `null`/`0`/`false`/`""` pass through untouched; only reads are normalized — registry function return values are left as-is. Strict keys: reading _through_ a null base still throws (use `?.`).
- `?.` (also `?.[...]` and `?.m()`) yields `null` on a nullish base and guards per step, not per chain — `a?.b.c` still throws if `a` is null. The tokenizer must keep the `(?!\d)` lookahead so `a ?.5 : b` stays a ternary.
- Unknown function names and malformed input throw `SyntaxError` at compile time; null-base and blocked-key access throw `TypeError` at runtime.
- Compiled functions expose `names`: the deduplicated free root variables of the expression (no property names, hash keys, or registry functions). Unknown variables do NOT throw — they evaluate to `null`; author-time validation is the caller's job via `names`.
- There are no assignment operators — expressions must remain read-only.
- Arrow lambdas `x => body` (single bare param, no parens) compile to a function **value** the host passes to a registry reducer, e.g. `sum(rows, r => r.price * r.qty)` — xprsn supplies the per-item function; the host owns iteration/reset. The body is parser-compiled like any expression (CSP intact), so every read still routes through `get()`. The param binds via a child scope (`{ __proto__: v, [n]: arg }`, a computed own-prop so a `__proto__`-named param can't reprototype it), reusing the `bnd` set so the param is excluded from `names` (`.functions` still lists reducers). Lambdas are **not self-callable** — a call resolves only from the registry, so `f => f(f)` is a compile-time `SyntaxError` (no recursion/DoS); only the host invokes a lambda. Function values are first-class here, but `constructor`/`__proto__`/`prototype` stay blocked at every hop, so `(x => x).constructor` and the like still throw.

## Conventions

- Tabs for indentation. Comments only where the code can't speak (safety rationale, non-obvious tricks).
- Tests use `node:test`, live in `test/*.test.js`, and run directly against `src/` (no build needed). New syntax or guards need tests in the matching suite (`evaluate`, `safety`, or `errors`). A new syntax form or safety guard should also be reflected in the structured fuzz generator (`fuzz/structured.fuzz.js`) so the fuzzer keeps exercising it.
- Do not mention Symfony in code, comments, or docs.
- Runtime support is Node.js 22.12+ (unflagged `require(esm)`), **ESM only**, plus ES2024 browser environments through a standards-based ESM bundler. There is no CommonJS, direct-script global, or UMD build — shipping two formats would split the diagnostics WeakSet/WeakMap across a `require`/`import` seam, which no config can fix.
- Suggested commit messages must follow Conventional Commits and be at most 80 characters.
- `dist/` is gitignored build output and the **only** thing published — `files` is just `["dist"]`. The declaration is **hand-written** in `src/index.d.ts`, beside the code it describes (`dts: false`), and tsdown's `copy` carries it into `dist/`. It is kept deliberately plain: two function signatures, `values` typed as `Record<string, any>`, `names`/`functions` as `string[]`. No expression-level type inference — that machinery was dropped as too heavy for the value.
- **`checkJs` over `src/` is what keeps that declaration honest.** `tsconfig.json` type-checks `src/**/*.js` with `noImplicitAny` off — that setting is the difference between 2 real errors and a flood of `noImplicitAny` noise. `fault()` and `err()` take `XprsnErrorCode`, so a code this module throws but `src/index.d.ts` omits fails to compile. Verify with: swap a thrown code for a made-up one and confirm `npm run test:types` fails. Downstream matters here — sjabloon's `SjabloonErrorCode` unions `XprsnErrorCode`.
