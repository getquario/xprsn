# xprsn

A tiny, CSP-safe expression language for JavaScript. **~2.0KB min+compressed, one tiny dependency.**

[![NPM version](https://img.shields.io/npm/v/xprsn.svg)](https://www.npmjs.com/package/xprsn)
[![Build Status](https://github.com/getquario/xprsn/actions/workflows/test.yml/badge.svg)](https://github.com/getquario/xprsn/actions/workflows/test.yml)
[![NPM downloads](https://img.shields.io/npm/dm/xprsn.svg)](https://www.npmjs.com/package/xprsn)
[![Apache-2.0 license](https://img.shields.io/github/license/getquario/xprsn.svg)](https://github.com/getquario/xprsn/blob/main/LICENSE)

<a href="https://webstronauts.com?utm_source=github&utm_medium=readme&utm_campaign=xprsn">
	<picture>
		<img src="https://webstronauts.com/images/sponsored-by.svg" alt="Sponsored by The Webstronauts" width="200" height="65">
	</picture>
</a>

Evaluates expressions like `user.age > 18 and "admin" in user.roles` against data you provide, without running them as JavaScript. xprsn parses each expression into a chain of plain closures, so there is no `eval` and no `new Function`.

That makes it a fit wherever the expression is written by someone other than you — a rule in a form builder, a filter in a query UI, a formula in a spreadsheet cell, a condition on a workflow step — and especially where a strict Content Security Policy rules out the usual `new Function` shortcut.

## Contents

- [Install](#install)
- [Usage](#usage)
- [Is xprsn the right tool?](#is-xprsn-the-right-tool)
- [More than one expression?](#more-than-one-expression)
- [Syntax](#syntax)
- [Recipes](#recipes)
- [API](#api)
- [Safety](#safety)
- [Content Security Policy](#content-security-policy)
- [Environments](#environments)
- [Embedding xprsn](#embedding-xprsn)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install xprsn
```

Node.js 22 or newer, ESM only. TypeScript declarations ship with the package; nothing extra to install.

## Usage

```js
import { compile, evaluate } from "xprsn";

// One-shot:
evaluate("items[0].price * qty > 100", { items: [{ price: 60 }], qty: 2 });
// => true

// Compile once, evaluate many times:
const isAdmin = compile('user.age > 18 and "admin" in user.roles');
isAdmin({ user: { age: 30, roles: ["admin"] } }); // => true
isAdmin({ user: { age: 16, roles: [] } }); // => false

// Custom functions (third argument of evaluate, second of compile):
evaluate('lower(name) == "robin"', { name: "ROBIN" }, { lower: (s) => s.toLowerCase() });
// => true
```

Expressions read only from the values object you pass and call only the functions you register. Anything else — globals, `require`, the DOM — is simply not reachable.

## Is xprsn the right tool?

xprsn evaluates one expression against one values object and returns one value. There are no statements, no local variables, no loops, and no I/O. That is the whole design, and it is worth checking against your problem before you install anything.

**It fits when:**

- Expressions come from your users, and storing them as strings in a database or config file is the natural thing to do.
- You'd otherwise reach for `new Function`, and either can't (strict CSP, a runtime without string-to-code) or would rather not.
- The people writing expressions are not programmers, so the syntax has to be typeable and forgiving — a missing key reads as `null` rather than crashing.
- Bundle size is a real constraint. The whole language is about 2KB.

**Look elsewhere when:**

- You need a scripting language — variables, assignment, loops, user-defined functions. Expressions cannot express those, and the [multi-step recipe](#multi-step-expressions) below is a deliberate ceiling, not a stepping stone.
- You want rules stored as structured data rather than text, so a visual builder can round-trip them without parsing. xprsn's input is a string.
- You control both ends. If nobody but you writes the expressions, plain JavaScript is faster, smaller, and better tooled.
- You need a sandbox. xprsn closes the route from an expression to the `Function` constructor; it does not limit what your own registered functions and exposed methods do once called. See [SECURITY.md](SECURITY.md).
- You need CommonJS, or Node older than 22. See [Environments](#environments).

## More than one expression?

An expression produces a single value. Two sibling packages carry the same closure-compiling approach further, and one of them may be closer to what you're actually after:

- **[sjabloon](https://github.com/getquario/sjabloon)** — a template engine, if you need _text_ rather than a value: `{{ expr }}` interpolation with HTML escaping, `{{#if}}`/`{{#elif}}` and `{{#each}}` blocks, and any xprsn expression inside every tag. About 1KB on top of this package.
- **[padvinder](https://github.com/getquario/padvinder)** — a JSONPath engine, if you need to _select many nodes_ out of a document rather than compute one value. Filter evaluation is the part of JSONPath that has produced real code-injection CVEs elsewhere; padvinder parses filters to closures with no route to code execution, and passes the full RFC 9535 compliance suite.

All three parse to closures and are safe under the same CSP terms. Their only runtime dependencies are each other and [waarmerk](https://github.com/getquario/waarmerk), the located-diagnostic module they share.

## Syntax

| Category         | Syntax                                                                              |
| ---------------- | ----------------------------------------------------------------------------------- |
| Literals         | `42`, `4.2`, `.5`, `1e3`, `"double"`, `'single'`, `true`, `false`, `null`           |
| Arrays           | `[1, 2, 3]`                                                                         |
| Hashes           | `{"key": value}`, `{key: value}`                                                    |
| Arithmetic       | `+` `-` `*` `/` `%` `**`                                                            |
| Concatenation    | `"id-" ~ n` (string concat; coerces both sides)                                     |
| Comparison       | `==` `!=` `<` `>` `<=` `>=` (strict: `1 == "1"` is `false`)                         |
| Logical          | `and` `&&` `or` `\|\|` `not` `!` (with short-circuiting)                            |
| Membership       | `"admin" in roles` (arrays: `includes`; strings: substring; objects: own keys only) |
| Ternary          | `a ? b : c`, and the `a ?: b` shorthand                                             |
| Null coalescing  | `a ?? b`, chains as `a ?? b ?? c`                                                   |
| Access           | `user.name`, `user["name"]`, `items[0]`, `items[i + 1]`                             |
| Null-safe access | `user?.name`, `items?.[0]`, `name?.toUpperCase()`                                   |
| Method calls     | `name.toUpperCase()`, `items.indexOf(2)`                                            |
| Functions        | `lower(name)`, resolved only from the registry you pass in                          |
| Lambdas          | `sum(rows, r => r.price)` (single param; a per-item function for host reducers)     |
| Identifiers      | letters, digits, `_`, and `$` / `@` (e.g. `$price`, `@.total`)                      |

`==`/`!=` are strict (JS loose equality is a footgun). `~` joins its sides as strings (`1 ~ 2` is `"12"`) and binds looser than arithmetic but tighter than comparison, so `"total: " ~ a + b` joins the sum.

Absence reads as `null`: an unknown variable or a missing property is `null` (not `undefined`), so `x == null` is the natural "is it there?" test. Present `null`/`0`/`false`/`""` are untouched, and registry function return values are left as-is. Reading _through_ a null base still throws, so use `?.`: `a?.b` yields `null` on a nullish base and guards each step on its own. Chain it at every link that can be null: `a?.b?.c`. To keep the package tiny, xprsn leaves out `matches`, ranges (`..`), and bitwise operators.

`$` and `@` are ordinary identifier characters, so a variable can be named `$` or `@`. They read through the same guard as any other name, and matter most to hosts that stack nested scopes — see [Embedding xprsn](EMBEDDING.md#nested-scopes-and-bound-identifiers).

## Recipes

### Multi-step expressions

Expressions have no local variables. When a calculation needs intermediate results, split it into named steps and feed each result back in as a variable for the next expression:

```js
const steps = [
  ["subtotal", "price * qty"],
  ["discount", "subtotal >= 100 ? subtotal * 0.1 : 0"],
  ["total", "subtotal - discount + shipping"],
].map(([name, expr]) => [name, compile(expr)]);

function run(values) {
  const ctx = { ...values };
  for (const [name, fn] of steps) ctx[name] = fn(ctx);
  return ctx;
}

run({ price: 60, qty: 2, shipping: 5 });
// => { price: 60, qty: 2, shipping: 5, subtotal: 120, discount: 12, total: 113 }
```

Each step compiles once. The steps are plain data, so you can store them in a database or config file and let users edit the whole calculation.

### Aggregates and per-item computation

An expression computes a single value; walking a collection is the host's job. An arrow lambda `x => body` bridges the two. It compiles to a function value that a registry function calls once per element, so iteration stays in your code: the reducer decides how to combine the results and where to reset.

```js
const reducers = {
  sum: (rows, f) => rows.reduce((total, row) => total + f(row), 0),
};

evaluate(
  "sum(orders, order => order.price * order.qty)",
  {
    orders: [
      { price: 20, qty: 2 },
      { price: 5, qty: 4 },
    ],
  },
  reducers,
);
// => 60
```

A lambda takes one bare parameter (no parentheses) and its body is any expression. That body parses to closures like everything else, so every read still passes through the same guard. A lambda adds no route to code execution: `order => order.constructor` throws just as `x.constructor` does. The parameter binds in a child scope, so it shadows an outer variable of the same name and drops out of `names`:

```js
compile("sum(orders, r => r.price * tax)", reducers).names; // => ['orders', 'tax']
```

Because the reducers are yours, you decide what they do: `sum`, `count`, `avg`, `any`, `map`, or a running total that keeps state between calls. xprsn only hands each one a per-item function. It never iterates for you, and a lambda cannot call itself (`f => f(f)` is a compile-time error), so an expression can't recurse into an infinite loop.

### Caching compiled expressions

There is no built-in parse cache. If you evaluate the same expressions repeatedly, memoize `compile`:

```js
const cache = new Map();
const cached = (expr) => cache.get(expr) ?? cache.set(expr, compile(expr)).get(expr);
```

## API

### `compile(expression, functions?, options?)`

Parses the expression and returns an evaluator function `(values?) => result`. Malformed input and unknown function names throw a `SyntaxError` at compile time.

The evaluator also carries `names`: the variables the expression reads, deduplicated. Property names, hash keys, and registry functions don't count; only the roots do.

```js
const fn = compile("user.age > 18 and (discount ?? 0) > 0");
fn.names; // => ['user', 'discount']
```

When expressions come from your users, `names` is how you check a rule against a schema before saving it (`fn.names.every(n => n in schema)`), or how you find which stored rules read a field you're about to rename. In the [multi-step pattern](#multi-step-expressions) above, each step's `names` are its dependencies.

Evaluators carry two further properties aimed at hosts building editors and validators: [`reads`](EMBEDDING.md#reads), every root-name read with its span, and [`functions`](EMBEDDING.md#signaturesfunctions), the registry functions the expression calls. [`options.bound`](EMBEDDING.md#optionsbound) shapes what `names` reports.

### `evaluate(expression, values?, functions?)`

Shorthand for `compile(expression, functions)(values)`. Compiles every call, so prefer `compile` in a hot path.

### `signatures(functions?)`

Describes a registry — one `{ name, arity, doc }` per entry — for editors and function reference docs. See [EMBEDDING.md](EMBEDDING.md#signaturesfunctions).

### Error diagnostics

Errors produced by xprsn keep their `SyntaxError` or `TypeError` class and expose three machine-readable properties:

- `code`: a stable category;
- `start`: the zero-based source offset;
- `end`: the exclusive source offset.

The codes are `XPRSN_SYNTAX`, `XPRSN_UNKNOWN_FUNCTION`, `XPRSN_TOO_DEEP`, `XPRSN_NULL_BASE`, `XPRSN_BLOCKED_KEY`, and `XPRSN_NOT_CALLABLE`. End-of-input syntax errors use an empty span at the expression length. A computed property failure spans the bracket operation, because its runtime key may not occur literally in the source.

Together they are enough to underline the offending characters back to whoever wrote the expression:

```js
import { compile, isDiagnostic } from "xprsn";

try {
  compile("price * (qty");
} catch (error) {
  if (!isDiagnostic(error)) throw error;
  console.log(error.code, error.start, error.end); // XPRSN_SYNTAX 12 12
}
```

Errors thrown by registered functions, getters, methods, or value coercion hooks are host errors. xprsn passes them through unchanged and does not attach diagnostic fields. `isDiagnostic(error)` is how you tell the two apart; it authenticates by identity rather than by shape, which has consequences worth knowing if you embed xprsn — see [EMBEDDING.md](EMBEDDING.md#diagnostic-identity).

## Safety

Expressions can only read the data you pass in:

- Every property read (`a.b`, `a[b]`, method lookup, and bare variable names) goes through a guard that rejects `__proto__`, `constructor`, and `prototype`. This blocks the `x.constructor.constructor(...)` route to `Function`.
- Hash literals are built on null-prototype objects, so `{"__proto__": …}` is plain data and cannot pollute `Object.prototype`.
- `in` on objects checks own properties only; inherited properties are not visible.
- There are no assignment operators, so expressions cannot modify your data.
- Functions resolve from the registry you provide, at compile time.
- Lambdas (`r => r.price`) compile to function values, but an expression can't call one; only your registry functions can. Reads inside a lambda still go through the guard, so they open no route to `Function`.

Expressions can still call methods on the values you expose (`user.delete()`, say, if you pass such an object), so only pass data you are comfortable handing over. [SECURITY.md](SECURITY.md) has the checklist to work through before accepting expressions from people you don't trust, and the process for reporting a vulnerability.

## Content Security Policy

This package works under a strict CSP such as:

```
Content-Security-Policy: script-src 'self'
```

It needs no `unsafe-eval` because the compiler only composes arrow functions that already exist in the shipped source; it never turns expression text into JavaScript. The test suite runs under `node --disallow-code-generation-from-strings`, which throws on any string-to-code construct the same way a strict CSP does, and a test checks the source for such constructs. The library never touches the DOM, so you don't need a Trusted Types policy.

`npm run test:browser` serves `lib/` to Playwright Chromium under this policy, including blocked-key reads that should throw. The run checks that the library itself works under CSP. It does not sandbox registry functions or host objects you pass in.

## Environments

Node.js 22 and newer, ESM only. Browser use is supported through a standards-based ESM bundler in environments supporting ES2024. Direct `<script>` globals, UMD, and CommonJS builds are not provided.

Shipping CommonJS alongside ESM would put two copies of the core in any process that mixed `require` and `import`. Each copy would have its own diagnostic identity, so `isDiagnostic` would return `false` across the seam.

TypeScript declarations are hand-written and ship in the package; `npm run check` runs `attw` against them.

## Embedding xprsn

If you compile xprsn source out of a larger document — a cell in a report, a field in a form, a rule in a workflow builder — [EMBEDDING.md](EMBEDDING.md) covers the surface built for that: expression introspection for validators and editors, registry signatures, diagnostic identity, relocating a fault into your own coordinates, and nested scopes with `@` and `$`.

## Contributing

```bash
git clone https://github.com/getquario/xprsn.git
cd xprsn
npm install
npm run check
```

`npm run check` is the local gate: formatting, lint, dead-code and dependency checks, the size budget, the unit and type suites, the browser CSP run, and the fuzz regression corpus. It is the same gate CI runs, so a green `check` locally means a green pull request.

Conventions for this repo — architecture, semantics that look like bugs if you tidy them, and the commit format — live in [AGENTS.md](AGENTS.md).

## License

Copyright 2026 Robin van der Vleuten

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
