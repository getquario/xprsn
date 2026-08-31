# xprsn

Tiny, CSP-safe expression language for JavaScript. Plain JS + JSDoc, one runtime dependency. `lib/index.js` is the implementation and the package.

Work is done when `npm run check` is green. Scripts live in `package.json`. Run them on Node: Bun accepts `--disallow-code-generation-from-strings` but does not enforce it. A single suite is `node --disallow-code-generation-from-strings --test test/evaluate.test.js`. Public syntax and API live in `README.md`; the host-facing surface (`reads`, `bound`, `signatures`, `relocate`, diagnostic identity) lives in `EMBEDDING.md`.

## Architecture

A closure compiler: one regex tokenizes, a precedence-climbing parser emits nested arrows, `compile(expr)` returns `(values) => result`. No AST, no string-to-code path. Parser state (`toks`, `i`, `fns`) is module-level; parsing is synchronous.

Grammar, lowest to highest: `ternary` → `expr` (`PREC`) → `unary` → `postfix` → `primary`.

## Safety

- Compose closures that already exist in the shipped source. `test/safety.test.js` greps `lib/index.js` for `\beval\b`, `Function(`, and `new Function`, so comments in `lib/` have to avoid those spellings. The suite runs under `--disallow-code-generation-from-strings`.
- `get()` is the security boundary. Every dynamic key read (property, index, method lookup, bare name) goes through it. It blocks `__proto__`, `constructor`, and `prototype`, which closes `x.constructor.constructor(...)`.
- Hash literals are `Object.create(null)`, so `{"__proto__": x}` is data. Object membership uses `Object.hasOwn`.
- Registry functions resolve at compile time from the map passed to `compile`.

Size is a soft goal (budget in `package.json`). Name bindings for readers; a consumer minifier mangles them anyway, and `lib/` ships verbatim so those names show up in stack traces. Property names do not mangle, so spend those bytes on purpose. Keep the guard and the passing test; then check `npm run size`.

## Semantics

`test/` is the executable spec. These look like bugs if you tidy them:

- `==` / `!=` compile to `===` / `!==`.
- `and` / `or` / `&&` / `||` / `??` short-circuit; `**` is right-associative; `??` is the lowest binary op.
- `a ?: b` keeps `a` when truthy, else `b`.
- A missing key or variable reads as `null` (inside `get()`). Present `null` / `0` / `false` / `""` pass through. Registry returns are left as-is. Reading through a null base throws; `?.` guards per step, so `a?.b.c` still throws if `a` is null. The tokenizer's `(?!\d)` on `?.` keeps `a ?.5 : b` a ternary.
- Unknown functions and malformed input throw `SyntaxError` at compile time. Null-base and blocked-key access throw `TypeError` at runtime.
- `names` lists free root variables. Unknown variables evaluate to `null`; validate via `names`.
- Expressions are read-only.
- `x => body` (one bare param) is a function value for a host reducer. The body still reads through `get()`. Bind with `{ __proto__: scope, [param]: arg }` so a `__proto__`-named param cannot reprototype the child. The param goes into `bound` and drops out of `names`. Calls resolve only from the registry, so `f => f(f)` is a compile-time `SyntaxError`. Blocked keys stay blocked on function values.

## Conventions

Omakase: one obvious path over knobs. Test the guarantee a user relies on. Add complexity when concrete pressure shows up.

- oxfmt owns formatting on its defaults. `npm run fmt`.
- Comments only where the code cannot: safety rationale, non-obvious tricks.
- Bindings named for readers (`scope`, `names`, `token`, `left`). `i` is the parser cursor. Rename with a scope-aware tool: a bare `v` also lives in strings and unrelated closures, and `{ x }` shorthand renames the property.
- Tests are `node:test` in `test/*.test.js`, run against `lib/`. New syntax or a new guard belongs in `evaluate`, `safety`, or `errors`, and in `fuzz/structured.fuzz.js`.
- Fuzz: when running, adding, or triaging a target, corpus, or dictionary, read `.claude/skills/fuzz-testing/SKILL.md`.
- Treat the language as original. Leave Symfony unmentioned in code, comments, and docs.
- Diagnostics are minted, authenticated and relocated through [waarmerk](https://github.com/getquario/waarmerk), which treffer, padvinder and sjabloon share. `store()` at module load annotated `Store<XprsnErrorCode>`, `mint` to throw, `relocate` re-exported with this module's store applied. Do not hand-roll a second copy of that machinery here — it drifted four ways before it was extracted, and do not drop the store's type argument: `store()` defaults `Code` to `string`, which compiles and checks nothing.
- `XPRSN_TOO_DEEP` mints through `fault`, not waarmerk's `capped`: it carries a span over the whole expression, where a `capped` diagnostic carries `limit`/`actual` and no span. treffer and padvinder use `capped` because their budgets really are counters.
- `relocate` takes `span` as well as `offset`. `offset` shifts, for an embedder holding a verbatim slice; `span` replaces, for one whose text reached the expression through a decode.
- `test/browser/harness.js` rewrites every bare `waarmerk` import to a path it serves, because a browser cannot resolve a bare specifier and a JSDoc `@import` names it ahead of the real statement. Resolve the dependency through `import.meta.resolve`, not a hardcoded path.
- ESM only. Two module formats would split the diagnostics WeakMap across a `require` / `import` seam.
- Conventional Commits, at most 80 characters, checked by `commitlint.config.mjs` from `.githooks/commit-msg`. Enable it once per clone with `git config core.hooksPath .githooks`. The hook fails rather than skips when commitlint is missing: no CI job checks messages, so a skip would be no gate at all, and this repo's release notes are generated from these messages. `npm run commitlint -- --last --verbose` checks one by hand.
- `lib/index.d.ts` is hand-written and pulled into `lib/index.js` with `@import`. Generating it would publish the internal `Node` closure type. `checkJs` under `strict` keeps the pair honest: `fault()` and `err()` take `XprsnErrorCode`, so a thrown code the declaration omits fails `npm run test:types`. sjabloon unions that type. Keep the declaration plain.
- `fault`, `err` and `bad` are `const`. TypeScript only treats a `never` return as closing a branch when the binding cannot be reassigned; `bad` needs `@type {() => never}`, not `@returns`.
- Suppress `no-unused-expressions` on the expression that trips it (`cond || err()`, comma `push`) with `// oxlint-disable-next-line` directly above it. oxfmt moves lines, so a trailing `-line` comment slips off its target. Leave the rule live in `.oxlintrc.json`. Type-aware suppressions use the `typescript/` prefix the diagnostic reports.
- `oxlint-tsgolint` is the binary that runs the type-aware rules; without it they drop silently.
- `test/types.check.ts` ends scopes with `void [...]` so type-only bindings stay live under `no-unused-vars`.
- Fallow defaults are the gate. Split and table-drive until shipped functions sit under them; leave `maxCognitive` and `maxCrap` alone. With no coverage file, estimated CRAP wants cyclomatic below 5. Duplicated helpers in `fuzz/` get exported. A second name in `ignoreDependencies` means a real graph edge is missing.
