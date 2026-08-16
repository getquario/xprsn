# xprsn

Tiny, CSP-safe expression language for JavaScript. Zero runtime dependencies, plain JS + JSDoc (no TypeScript).

## Commands

- `npm run check` — the full local pull-request CI gate: lint, size limits, unit/types, browser CSP coverage, and deterministic fuzz regression. **There is no build step.**
- `npm run lint` — oxlint on its default (correctness) ruleset with `--deny-warnings`, so any warning fails. It runs first in `check` because it is the cheapest step.
- **Non-negotiable: run `npm run check` before declaring any work done.** Passing unit tests alone is not done — a change is complete only when the full gate above is green. Never say "done", close an issue, or hand off without it.
- `npm test` — Node's built-in test runner under `--disallow-code-generation-from-strings` (strict-CSP simulation), then `npm run test:types`: a plain `tsc` that type-checks `lib/` **and** `test/types.check.ts` in one pass, followed by `attw` against a packed tarball to catch module-resolution mistakes the compiler cannot see. Keep this on Node: Bun accepts that V8 flag but does not enforce it.
- `npm run size` — size-limit bundles and minifies `lib/index.js` itself, then checks it against the budget in `package.json`. It measures what a consumer's bundler would ship rather than a file on disk, so it still catches a dependency accidentally being pulled in.
- `npm run test:browser` — serves `lib/` straight to Playwright Chromium under a strict CSP.
- Run a single suite: `node --disallow-code-generation-from-strings --test test/evaluate.test.js`
- `npm run bench` — zero-dependency micro-benchmarks in `bench/`, run against `lib/`. Measures compile (parse) and evaluate throughput separately, since the design is compile-once, evaluate-many. `bench/` is not in `files`, so it is never published.
- `npm run fuzz` — jazzer.js fuzz targets in `fuzz/` (compile / evaluate / structured), against `lib/`, 60s each. `npm run fuzz:regression` deterministically replays the minimized committed corpus (CI-safe, used by `.github/workflows/fuzz.yml`). Nightly discovery restores and updates a private GitHub Actions corpus cache. The structured target asserts the real safety properties — no prototype pollution, blocked-key reads throw, deterministic eval — not just "doesn't crash". `fuzz/` is not in `files`, so it is never published.

## Architecture

The entire implementation is `lib/index.js`, which is also exactly what ships — `lib/` is published as-is, unminified and unbundled (~200 lines, one file by design). It is a **closure compiler**: a one-regex tokenizer feeds a precedence-climbing parser that emits nested arrow functions, so `compile(expr)` returns a plain `(values) => result` function. There is no AST, no node classes, and no code generation — that is what makes it CSP-safe.

Parser state (`toks`, `i`, `fns`) is module-level and shared; parsing is synchronous so this is safe. Grammar entry points, lowest to highest binding: `ternary` → `expr` (binary ops via the `PREC` table) → `unary` → `postfix` (`.prop`, `[idx]`, method calls) → `primary`.

## Hard constraints

1. **CSP safety is non-negotiable.** Never introduce `eval`, `new Function`, string `setTimeout`, or any string-to-code path. A test greps the source for these, and the whole suite runs under `--disallow-code-generation-from-strings`. Don't even use the words "eval" or "new Function" in comments — the source-scan test flags them.
2. **The `get()` guard is the security boundary.** Every dynamic key read (property, index, method lookup, bare variable names) must go through it. It blocks `__proto__`/`constructor`/`prototype` to close the `x.constructor.constructor(...)` escape to Function. Never add a read path that bypasses it.
3. Hash literals must stay null-prototype (`Object.create(null)`) so `{"__proto__": x}` cannot pollute. `in` on objects must use `Object.hasOwn`, never the JS `in` operator. Expression functions resolve only from the registry passed to `compile`, at compile time.
4. **Size is a soft goal (~1.2KB min+gzip).** Repetition over abstraction and data-driven operator tables still earn their keep. **Short identifiers do not** — a consumer's minifier mangles every binding regardless of how it is spelled here, so `scope` costs exactly what `v` costs, and renaming the whole file measured *smaller* because longer repeated names compress better. Since `lib/` ships verbatim, these names are what a consumer reads in a stack trace, so name bindings for readers. Object *property* names are the exception, being unmanglable — spend those bytes deliberately. Never trade a safety guard or a passing test for bytes. Check size impact with `npm run size`, which bundles and minifies `lib/` the way a consumer's bundler would.

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
- Bindings are named for readers: `names`/`functions`/`bound` not `nm`/`fnm`/`bnd`, `scope` not `v`, `token` not `t`, `left`/`right`/`lhs` not `l`/`r`/`a`. `i` stays the parser cursor. Rename with a scope-aware tool, never `sed` — a bare `v` occurs inside strings, comments and a dozen unrelated closures, and `o` meant both the operator and the names set before this was cleaned up. Watch shorthand properties: renaming the binding in `{ x }` renames the *property* too.
- Tests use `node:test`, live in `test/*.test.js`, and run directly against `lib/`. New syntax or guards need tests in the matching suite (`evaluate`, `safety`, or `errors`). A new syntax form or safety guard should also be reflected in the structured fuzz generator (`fuzz/structured.fuzz.js`) so the fuzzer keeps exercising it.
- Do not mention Symfony in code, comments, or docs.
- Runtime support is Node.js 22.12+ (unflagged `require(esm)`), **ESM only**, plus ES2024 browser environments through a standards-based ESM bundler. There is no CommonJS, direct-script global, or UMD build — shipping two formats would split the diagnostics WeakSet/WeakMap across a `require`/`import` seam, which no config can fix.
- Suggested commit messages must follow Conventional Commits and be at most 80 characters.
- **There is no build.** `lib/` is published verbatim — `files` is just `["lib"]` and `exports` points straight at `lib/index.js`. Consumers get readable source and real stack traces; their own bundler does the minifying. Do not reintroduce one to ship smaller bytes.
- The declaration is **hand-written** in `lib/index.d.ts`, beside the code it describes. It is **not** generated: `tsc` cannot keep `@internal` JSDoc typedefs out of emitted declarations ([TypeScript #38444](https://github.com/microsoft/TypeScript/issues/38444)), so generating would publish the internal `Node` closure type as API. dts-buddy has the same flaw; ESLint and execa hand-write theirs for the same reason. It is kept deliberately plain: two function signatures, `values` typed as `Record<string, any>`, `names`/`functions` as `string[]`. No expression-level type inference — that machinery was dropped as too heavy for the value.
- **`checkJs` over `lib/` is what keeps that declaration honest.** `tsconfig.json` type-checks `lib/**/*.js` under full `strict` including `noImplicitAny`. The public types are declared once in `lib/index.d.ts` and pulled into the implementation with `@import`, so a signature that drifts from what ships fails to compile; only the internal `Node` closure type is a local `@typedef`. `fault()` and `err()` take `XprsnErrorCode`, so a code this module throws but the declaration omits fails to compile. Verify with: swap a thrown code for a made-up one and confirm `npm run test:types` fails. Downstream matters here — sjabloon's `SjabloonErrorCode` unions `XprsnErrorCode`.
- `err` and `bad` are `const`, not `let`. TypeScript only propagates a `never` return through control-flow analysis when the callee binding cannot be reassigned, and `bad` additionally needs the `@type {() => never}` form rather than `@returns` — that is what lets `bad()` legally end a branch in `primary()`.
- `attw` runs with `--profile esm-only`, which skips the `node10` and `node16-cjs` resolution modes — the two this package deliberately does not support. `node16` (ESM) and `bundler` must stay green.
- **`no-unused-expressions` is suppressed per line, never per glob.** The `cond || err()` guard idiom and the `out.push(t), pos.push(at)` comma form trip it 6 times in `lib/index.js`, each carrying its own `// oxlint-disable-line no-unused-expressions`. Do not "tidy" these into one `.oxlintrc.json` override: the rule staying live in that file is what still catches a genuinely dead statement there. Verify by adding `TOKEN;` next to a suppressed line and confirming `npm run lint` fails.
- `test/types.check.ts` ends each scope with `void [...]`. Those bindings exist to assert types, not to be read, and consuming them is what keeps the file clean under `no-unused-vars` — the same convention treffer's suite uses.
