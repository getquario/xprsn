# Embedding xprsn

For hosts that compile xprsn source out of a larger document — a cell in a
report, a field in a form, a rule in a workflow builder — and that need to
introspect expressions, drive an editor, or report faults in their own
coordinates.

None of this is needed to use the package. [README.md](README.md) covers the
ordinary surface: `compile`, `evaluate`, the syntax, and the error codes.

- [Introspection](#introspection)
  - [`reads`](#reads)
  - [`options.bound`](#optionsbound)
- [`signatures(functions?)`](#signaturesfunctions)
- [Diagnostic identity](#diagnostic-identity)
- [`relocate(diagnostic, options)`](#relocatediagnostic-options)
- [Nested scopes and bound identifiers](#nested-scopes-and-bound-identifiers)

## Introspection

Every evaluator returned by `compile` carries `names`: the free root variables
the expression reads, deduplicated. That is the view most hosts want, and it is
documented in the [README](README.md#compileexpression-functions-options). The
two below are for tooling.

### `reads`

`reads` is every root-name read with its span in the source, in source order.
Duplicates and bound names are kept — `names` is the free, deduplicated view of
`reads`.

```js
compile("@.price * qty", {}, { bound: ["@"] }).reads;
// => [{ name: '@', start: 0, end: 1 }, { name: 'qty', start: 10, end: 13 }]
```

This is what an editor squiggles, hovers, and jumps from. An unknown variable is
not an error in xprsn — it evaluates to `null` — so an editor that wants to warn
about typos has to do it from `reads` against a known schema, and the span tells
it where to draw.

### `options.bound`

If your host injects its own variables into scope — `@` for the current row, `$`
for the root, a loop variable — pass them as `options.bound` so they are left out
of `names`. Bound names still resolve at evaluation time; only the introspection
output changes.

```js
compile("@.price * qty", {}, { bound: ["@"] }).names; // => ['qty']
```

Without this, every stored expression would appear to depend on variables the
author never supplied, and a schema check like `fn.names.every(n => n in schema)`
would reject valid expressions.

## `signatures(functions?)`

Describes a registry: one `{ name, arity, doc }` per entry, in the registry's own
key order.

```js
import { signatures } from "xprsn";

const sum = (rows, of) => rows.reduce((t, r) => t + of(r), 0);
sum.doc = "sum(rows, of): total of a projection";

signatures({ sum });
// => [{ name: 'sum', arity: 2, doc: 'sum(rows, of): total of a projection' }]
```

`arity` is the function's declared parameter count (`fn.length`), unless the
function carries its own numeric `arity` — the escape hatch for rest params and
wrappers, whose `length` misleads. `doc` is the function's own `doc` string when
it has one, and is absent otherwise.

This is what an editor shows as a signature hint on `sum(`, and what a host
renders as a function reference for the people writing expressions.

The complementary direction is `functions` on a compiled evaluator: the registry
functions an expression actually calls (methods like `s.trim()` are not counted).

```js
const fn = compile("sum(price) > budget", { sum });
fn.functions; // => ['sum']
```

Unknown functions already throw at compile time. `functions` is for checking a
stored expression against what its _context_ allows — rejecting `sum(...)` where
no row group is in scope, say.

## Diagnostic identity

`isDiagnostic(error)` returns `true` only for errors created by the same xprsn
module instance. It is an identity check, not a shape check: copying a documented
`code`, `start`, and `end` onto another error does not authenticate it, and a
diagnostic from another installed copy or module instance returns `false`.

That matters because a host has to tell three kinds of failure apart:

1. xprsn's own faults, which have a span in the expression;
2. errors thrown by _your_ registry functions, getters, methods, or coercion
   hooks, which xprsn passes through unchanged and does not annotate;
3. everything else.

Only the first can be pointed at a source location.

Each function returned by `compile` also has its own `isDiagnostic(error)`, which
returns `true` only for runtime guard errors created by _that_ evaluator. An
embedder can relocate a source span without mistaking a host function's error for
the outer expression's.

Compile-time diagnostics happen before an evaluator exists, so they authenticate
only through the package-level predicate. `evaluate` does not expose its
temporary evaluator; use `compile` when you need scoped authentication.

## `relocate(diagnostic, options)`

An embedder that compiles xprsn source out of a larger document reports the fault
in its own coordinates, not the expression's.
`relocate(diagnostic, { prefix, offset })` returns the copy to re-throw:

```js
import { compile, isDiagnostic, relocate } from "xprsn";

try {
  compile(cell.slice(1)); // the leading "=" is not part of the expression
} catch (error) {
  if (!isDiagnostic(error)) throw error;
  throw relocate(error, { prefix: "cell.value: ", offset: 1 });
}
```

The copy keeps the original's class, prepends `prefix` to the message verbatim,
moves the span, and carries every other field across. It is registered exactly as
the original was, so it passes `isDiagnostic` and — for a runtime fault — the
evaluator's own `isDiagnostic` too. The original is left untouched. Passing
anything but a diagnostic from this instance throws a `TypeError`.

`offset` shifts the span, and it is right whenever the expression was a verbatim
slice of your text, as above. It is wrong when your text was **decoded** first —
an expression read out of a JSON string literal, where an escape makes every
later offset slide. There is no offset that fixes that, so name the region the
expression came from instead:

```js
throw relocate(error, { prefix: "rules[2].when: ", span: [16, 34] });
```

`span` replaces the span outright and wins if you pass both. Neither option adds
a span to a diagnostic that had none.

Relocation lives here rather than in the embedder because authentication is by
identity: a copy an embedder builds itself cannot be authenticated, and a field
added to a diagnostic here would be a field the embedder's copy silently drops.

## Nested scopes and bound identifiers

`$` and `@` are ordinary identifier characters, so a variable can be named `$` or
`@`, and it reads through the same guard as any other name. On their own they buy
little, since xprsn reads from one flat values object:

```js
evaluate("@.price * $.taxRate", { "@": { price: 20 }, $: { taxRate: 1.21 } });
// => 24.2
```

They pay off once a host stacks nested scopes.
[sjabloon](https://github.com/getquario/sjabloon), the template engine built on
xprsn, is the concrete case. It layers a fresh child scope on every `{{#each}}`
iteration with `Object.create`, so a loop variable and the surrounding variables
coexist and an inner name shadows an outer one of the same name. In that setting
a plain name always resolves to the nearest scope. Binding `@` and `$` gives an
expression a fixed handle on a chosen level instead: set `@` to the current item
and `$` to the root, and `@.price * $.taxRate` says exactly which scope each name
comes from.

A host that does this should pass those names in `options.bound` so they stay out
of `names`, and should leave `@` unbound in any scope where there is no current
item — an unbound `@.field` throws, where a bound one would silently read a
stale or representative value.
