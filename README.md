# xprsn

A tiny, CSP-safe expression language for JavaScript. **~2.0KB min+compressed, zero dependencies.**

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

```js
import { compile, evaluate, isDiagnostic } from "xprsn";

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

## How far can you push this?

Pretty far. The same trick, a one-regex tokenizer feeding a parser that emits closures, carries into two sibling packages:

- [sjabloon](https://github.com/getquario/sjabloon) is a full template engine built directly on xprsn: `{{ expr }}` interpolation with HTML escaping, `{{#if}}`/`{{#elif}}` and `{{#each}}` blocks, and any xprsn expression inside every tag. About 1KB on top of this package.
- [padvinder](https://github.com/getquario/padvinder) is a JSONPath engine that started here and grew its own parser. Filter evaluation is the part of JSONPath that has produced real code-injection CVEs elsewhere; padvinder parses filters to closures with no route to code execution, and now passes the full RFC 9535 compliance suite as a standalone, zero-dependency package.

## API

### `compile(expression, functions?, options?)`

Parses the expression and returns an evaluator function `(values?) => result`. Throws a `SyntaxError` on malformed input or unknown function names, so a bad expression fails at compile time rather than during evaluation.

The evaluator also carries `names`: the variables the expression reads, deduplicated. Property names, hash keys, and registry functions don't count; only the roots do.

```js
const fn = compile("user.age > 18 and (discount ?? 0) > 0");
fn.names; // => ['user', 'discount']
```

That one array covers a lot of ground when expressions come from your users: validate a rule against your schema before saving it (`fn.names.every(n => n in schema)`), drive autocomplete in a rule editor, or find which stored rules read a field you're about to rename. It also pairs with the multi-step pattern below, where each step's `names` are its dependencies.

The evaluator also exposes `functions`: the registry functions the expression calls (methods like `s.trim()` are not counted).

```js
const fn = compile("sum(price) > budget", { sum: (xs) => xs.reduce((a, b) => a + b, 0) });
fn.functions; // => ['sum']
```

Unknown functions already throw at compile time, so this is for introspection rather than safety: check a stored expression against the functions available in its context before running it, for example rejecting an aggregate like `sum(...)` where no row group is in scope.

If your host injects its own variables into scope — a `@` for the current row, a `$` for the root, loop variables — pass them as `options.bound` so they're left out of `names`, which then reports only the caller-relevant free variables. Bound names still resolve normally at evaluation time; only the introspection output changes.

```js
compile("@.price * qty", {}, { bound: ["@"] }).names; // => ['qty']
```

### `evaluate(expression, values?, functions?)`

Shorthand for `compile(expression, functions)(values)`.

There is no built-in parse cache; if you evaluate the same expressions repeatedly, memoize `compile`:

```js
const cache = new Map();
const cached = (expr) => cache.get(expr) ?? cache.set(expr, compile(expr)).get(expr);
```

### Error diagnostics

Errors produced by xprsn keep their `SyntaxError` or `TypeError` class and expose three machine-readable properties:

- `code`: a stable category;
- `start`: the zero-based source offset;
- `end`: the exclusive source offset.

The codes are `XPRSN_SYNTAX`, `XPRSN_UNKNOWN_FUNCTION`, `XPRSN_TOO_DEEP`, `XPRSN_NULL_BASE`, `XPRSN_BLOCKED_KEY`, and `XPRSN_NOT_CALLABLE`. End-of-input syntax errors use an empty span at the expression length. A computed property failure spans the bracket operation because its runtime key may not occur literally in the source.

Errors thrown by registered functions, getters, methods, or value coercion hooks are host errors. xprsn passes them through unchanged and does not attach diagnostic fields.

Use `isDiagnostic(error)` when a host needs to distinguish those errors. It returns `true` only for errors created by the same xprsn module instance. Copying a documented `code`, `start`, and `end` onto another error does not authenticate it. A diagnostic from another installed copy or module instance also returns `false`.

Each function returned by `compile` also has `isDiagnostic(error)`. This narrower predicate returns `true` only for runtime guard errors created by that evaluator, so an embedder can relocate its source span without mistaking an authentic xprsn error thrown by a host function, getter, method, or coercion hook for the outer expression's error. Compile-time diagnostics occur before an evaluator exists and authenticate only through the package-level predicate. The one-shot `evaluate` API does not expose its temporary evaluator; use `compile` when scoped authentication is required.

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

`==`/`!=` are strict (JS loose equality is a footgun). `~` joins its sides as strings (`1 ~ 2` is `"12"`) and binds looser than arithmetic but tighter than comparison, so `"total: " ~ a + b` joins the sum. Absence reads as `null`: an unknown variable or a missing property is `null` (not `undefined`), so `x == null` is the natural "is it there?" test; present `null`/`0`/`false`/`""` are untouched, and registry function return values are left as-is. Reading _through_ a null base still throws, so use `?.` for that — `a?.b` yields `null` on a nullish base and guards each step on its own, so chain it at every link that can be null: `a?.b?.c`. To keep the package tiny, xprsn leaves out `matches`, ranges (`..`), and bitwise operators.

`$` and `@` are ordinary identifier characters, so a variable can be named `$` or `@` (they still read through the same prototype guard). On their own they buy little, since xprsn reads from one flat values object. They pay off once a host stacks nested scopes.

[sjabloon](https://github.com/getquario/sjabloon), the template engine built on xprsn, is the concrete case. It layers a fresh child scope on every `{{#each}}` iteration with `Object.create`, so a loop variable and the surrounding variables coexist and an inner name shadows an outer one of the same name. In that setting a plain name always resolves to the nearest scope. Binding `$` and `@` gives an expression a fixed handle on a chosen level instead: set `@` to the current item and `$` to the root, and `@.price * $.taxRate` says exactly which scope each name comes from.

```js
evaluate("@.price * $.taxRate", { "@": { price: 20 }, $: { taxRate: 1.21 } });
// => 24.2
```

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

## Content Security Policy

This package works under a strict CSP such as:

```
Content-Security-Policy: script-src 'self'
```

It needs no `unsafe-eval` because the compiler only composes arrow functions that already exist in the shipped source; it never turns expression text into JavaScript. The test suite runs under `node --disallow-code-generation-from-strings`, which throws on any string-to-code construct the same way a strict CSP does, and a test checks the source for such constructs. The library never touches the DOM, so you don't need a Trusted Types policy.

`npm run test:browser` builds the ESM bundle and verifies this policy in Playwright Chromium, including representative blocked-key escape attempts. This proves CSP compatibility, not containment of registry functions or host objects you deliberately expose.

## Safety

Expressions can only read the data you pass in:

- Every property read (`a.b`, `a[b]`, method lookup, and bare variable names) goes through a guard that rejects `__proto__`, `constructor`, and `prototype`. This blocks the `x.constructor.constructor(...)` route to `Function`.
- Hash literals are built on null-prototype objects, so `{"__proto__": …}` is plain data and cannot pollute `Object.prototype`.
- `in` on objects checks own properties only; inherited properties are not visible.
- There are no assignment operators, so expressions cannot modify your data.
- Functions resolve from the registry you provide, at compile time.
- Lambdas (`r => r.price`) compile to function values, but an expression can't call one; only your registry functions can. Reads inside a lambda still go through the guard, so they open no route to `Function`.

Expressions can still call methods on the values you expose (`user.delete()`, say, if you pass such an object), so only pass data you are comfortable handing over.

## Environments

Node.js 22 and newer are supported through the ESM and CommonJS builds. Browser use is supported through a standards-based ESM bundler in environments supporting ES2024. Direct `<script>` globals and UMD builds are not provided.

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
