/**
 * Tiny, CSP-safe expression language for JavaScript.
 * Expressions compile to a composition of closures — never to JS source —
 * so no string-to-code construct is ever used and strict CSP is satisfied.
 */

/**
 * @import { XprsnDiagnostic, XprsnErrorCode, XprsnEvaluator } from './index.js'
 * @import { Relocation, Store } from 'waarmerk'
 */
import { mint, relocate as relocateFault, store } from "waarmerk";

/**
 * A compiled node: given the scope object, produce a value. Every parser
 * production returns one of these — that is what makes this a closure
 * compiler rather than an AST interpreter.
 *
 * @internal
 * @typedef {(v: any) => any} Node
 */

/**
 * Sticky matching prevents a failed string from restarting at every later quote.
 * `?.` must not swallow the `?` of a ternary before a bare decimal.
 */
const TOKEN =
  /\s+|\d*\.?\d+(?:[eE][+-]?\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w$@]+|\?\.(?!\d)|\?\?|=>|[<>=!*]=|&&|\|\||\*\*|\S/y;

/** @type {number} */
let length;

/** @type {number[]} */
let pos;
/**
 * @type {Store<XprsnErrorCode>}
 */
const diags = store("xprsn");

/** Test whether an error was created by this xprsn module instance. */
export let isDiagnostic = diags.isDiagnostic;

/**
 * Copy a diagnostic into an embedder's coordinates.
 *
 * @type {(diag: unknown, opts?: Relocation) => XprsnDiagnostic}
 */
export let relocate = (diag, opts) => {
  return /** @type {any} */ (relocateFault(diags, diag, opts));
};

/**
 * Throw a located diagnostic.
 *
 * @type {(Type: (msg: string) => Error, msg: string, code: XprsnErrorCode,
 *   start: number, end: number, own?: any) => never}
 */
const fault = (Type, msg, code, start, end, own) =>
  mint(diags, Type, msg, { code, start, end }, own);

/**
 * @param {string} s
 * @returns {string[]}
 */
let lex = (s) => {
  let out = /** @type {string[]} */ ([]),
    at,
    t;
  length = s.length;
  pos = [];
  for (TOKEN.lastIndex = 0; TOKEN.lastIndex < length;) {
    at = TOKEN.lastIndex;
    // TOKEN ends in `\S`, so a non-empty remainder always matches.
    t = /** @type {RegExpExecArray} */ (TOKEN.exec(s))[0];
    if ("\"'".includes(t)) fault(SyntaxError, "Unexpected " + t, "XPRSN_SYNTAX", at, length);
    // oxlint-disable-next-line no-unused-expressions
    if (t.trim()) (out.push(t), pos.push(at));
  }
  return out;
};

/**
 * Null-prototype tables: arbitrary token text is used as a key, so a normal
 * object would turn `constructor` into Object's constructor (and break the
 * blocked-key guarantees).
 *
 * @template T
 * @param {T} entries
 * @returns {T}
 */
let table = (entries) => Object.assign(Object.create(null), entries);

/** Strict wrapper: evaluate both sides, apply `f`. @param {(a: any, b: any) => any} f */
let bin = (f) => /** @type {Bin} */ (lhs, right) => (scope) => f(lhs(scope), right(scope));

/**
 * Binary operators: `[precedence, builder]`, higher binds tighter. `**` is
 * right-associative. `~` sits below comparison and above `+`, so `"x: " ~ a +
 * b` joins the sum and `a ~ b == "12"` compares the joined string. Looked up
 * by arbitrary token text; a miss fails `expr`'s `>= min` test before the
 * builder is read.
 *
 * @typedef {(lhs: Node, right: Node) => Node} Bin
 * @type {Record<string, [number, Bin]>}
 */
const BIN = table({
  "??": [1, (lhs, right) => (scope) => lhs(scope) ?? right(scope)],
  or: [2, (lhs, right) => (scope) => lhs(scope) || right(scope)],
  "||": [2, (lhs, right) => (scope) => lhs(scope) || right(scope)],
  and: [3, (lhs, right) => (scope) => lhs(scope) && right(scope)],
  "&&": [3, (lhs, right) => (scope) => lhs(scope) && right(scope)],
  "==": [4, bin((a, b) => a === b)],
  "!=": [4, bin((a, b) => a !== b)],
  // `in`: arrays use includes; objects use hasOwn (never the JS `in` operator).
  in: [5, bin((a, b) => (b && b.includes ? b.includes(a) : Object.hasOwn(b, a)))],
  "<": [6, bin((a, b) => a < b)],
  ">": [6, bin((a, b) => a > b)],
  "<=": [6, bin((a, b) => a <= b)],
  ">=": [6, bin((a, b) => a >= b)],
  "~": [7, bin((a, b) => "" + a + b)],
  "+": [8, bin((a, b) => a + b)],
  "-": [8, bin((a, b) => a - b)],
  "*": [9, bin((a, b) => a * b)],
  "/": [9, bin((a, b) => a / b)],
  "%": [9, bin((a, b) => a % b)],
  "**": [10, bin((a, b) => a ** b)],
});

/**
 * Prefix operators, applied to the operand's value. `not` is a row rather than
 * a rewrite to `!`, so the lookup is the whole production.
 *
 * @type {Record<string, (x: any) => any>}
 */
const UNARY = table({ "!": (x) => !x, not: (x) => !x, "-": (x) => -x, "+": (x) => +x });

/** Constant node. @template T @param {T} v @returns {() => T} */
let konst = (v) => () => v;
/**
 * The prototype-chain escape hatches, as data rather than a branch chain, so
 * the membership test costs `get()` no branch of its own. Set membership is
 * the same identity test the equality chain was.
 */
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Shared parser state; parsing is synchronous so this is safe.
 * `bound` is the names the host already has in scope, excluded from `names`.
 *
 * @type {string[]}
 */
let toks;
/** @type {number} */
let i;
/** @type {Record<string, Function>} */
let fns;
/** @type {Set<string>} */
let names;
/** @type {{ name: string, start: number, end: number }[]} */
let reads;
/** @type {Set<string>} */
let functions;
/** @type {Set<string>} */
let bound;

/**
 * `at` precedes `code` so the common case — a syntax error at a token — names
 * only the token, instead of restating the default code to reach the position.
 *
 * `t` and `p` are default parameters, not a body: no caller passes them.
 *
 * @param {string} msg
 * @param {number} [at]
 * @param {XprsnErrorCode} [code]
 * @param {string} [t]
 * @param {number} [p]
 * @returns {never}
 */
const err = (msg, at = i, code = "XPRSN_SYNTAX", t = toks[at], p = t ? pos[at] : length) =>
  fault(SyntaxError, msg, code, p, t ? endPos(at) : p);

/**
 * @type {() => never}
 */
const bad = () => err("Unexpected " + (toks[i] || "end of expression"));
/** @param {string} t @returns {boolean} */
let eat = (t) => /** @type {boolean} */ (toks[i] === t && ++i);
/** @param {string} t */
let expect = (t) => eat(t) || bad();
/** @param {number} j */
let endPos = (j) => pos[j] + toks[j].length;

/**
 * Guarded property read — the single gate for every dynamic key in the
 * language, blocking the prototype-chain escape hatches.
 *
 * @param {any} o
 * @param {any} k
 * @param {number} start
 * @param {number} end
 * @param {any} [own]
 * @returns {any}
 */
let get = (o, k, start, end, own) => {
  if (o == null)
    fault(TypeError, 'Cannot read "' + k + '" of ' + o, "XPRSN_NULL_BASE", start, end, own);
  // Coerce once, then guard and read that same string: a key whose toString()
  // is attacker-supplied would otherwise slip the identity test and only
  // become "constructor" on the read below. String(), not "" + k, so a symbol
  // stringifies instead of throwing an uncoded TypeError.
  k = String(k);
  if (BLOCKED.has(k))
    fault(TypeError, 'Cannot access "' + k + '"', "XPRSN_BLOCKED_KEY", start, end, own);
  // Absence normalizes to null: a missing key or variable reads as null, so the
  // natural `x == null` test works. Present null/0/false/"" pass through untouched.
  return o[k] ?? null;
};

/**
 * String literal → value. Single-quoted strings normalize to JSON first.
 *
 * @param {string} t
 * @param {number} at
 * @returns {any}
 */
let str = (t, at) => {
  try {
    return JSON.parse(
      t[0] === '"'
        ? t
        : '"' +
            t.slice(1, -1).replace(/\\.|"/g, (c) => (c === "\\'" ? "'" : c === '"' ? '\\"' : c)) +
            '"',
    );
  } catch (x) {
    err(/** @type {Error} */ (x).message, at);
  }
};

/**
 * Identifier start (also a valid property name): letters, `_`, and the `$`/`@`
 * scope anchors. Property keys still route through the get() guard.
 */
let ID = /^[A-Za-z_$@]/;

/** Comma-separated `item`s until `end`. @template T @param {string} end @param {() => T} item @returns {T[]} */
let seq = (end, item) => {
  let items = /** @type {T[]} */ ([]);
  if (!eat(end)) {
    do items.push(item());
    while (eat(","));
    expect(end);
  }
  return items;
};

/** Consume the next token when it matches `re`, else a located error. @param {RegExp} re */
let take = (re) => {
  let k = toks[i++] || bad();
  return re.test(k) ? k : (i--, bad());
};

/**
 * @param {string} token
 * @param {number} start
 * @returns {Node}
 */
let ident = (token, start) => {
  if (eat("(")) {
    // Functions resolve at compile time, only from the registry.
    // oxlint-disable-next-line no-unused-expressions
    Object.hasOwn(fns, token) || err(token + " is not a function", start, "XPRSN_UNKNOWN_FUNCTION");
    functions.add(token);
    let fn = fns[token],
      args = seq(")", ternary);
    return (scope) => fn(...args.map((e) => e(scope)));
  }
  // oxlint-disable-next-line no-unused-expressions
  bound.has(token) || names.add(token);
  // One span for the read and the runtime guard alike, so a squiggle drawn
  // from `reads` always covers exactly what a diagnostic would point at.
  // Every root read is located, bound or not — `names` is the free subset.
  let at = pos[start],
    to = endPos(start);
  reads.push({ name: token, start: at, end: to });
  let own = names;
  return (scope) => get(scope, token, at, to, own);
};

/**
 * Tokens whose meaning is fixed by the token text alone: the three opening
 * brackets, which parse the rest of their form, and the keyword literals,
 * whose row is a thunk over a constant node so every row reads the same way.
 *
 * @type {Record<string, () => Node>}
 */
const HEAD = table({
  "(": (e = ternary()) => (expect(")"), e),
  "[":
    (items = seq("]", ternary)) =>
    (scope) =>
      items.map((e) => e(scope)),
  // `{ k: v, ... }`: keys are string literals or bare words. Null-prototype
  // result, so `{"__proto__": x}` stays inert data.
  "{":
    (
      pairs = seq(
        "}",
        /** @returns {[string, Node]} */ () => {
          let at = i,
            raw = take(/^["'\w.$@]/),
            k = /^["']/.test(raw) ? str(raw, at) : raw;
          expect(":");
          return [k, ternary()];
        },
      ),
    ) =>
    (scope) => {
      let o = /** @type {Record<string, any>} */ (Object.create(null));
      for (let [k, e] of pairs) o[k] = e(scope);
      return o;
    },
  true: konst(konst(!0)),
  false: konst(konst(!1)),
  null: konst(konst(null)),
});

/**
 * What a token means on its own: a HEAD form, a spelled-out value — a string
 * or a number — or a name.
 *
 * @returns {Node}
 */
let primary = () => {
  let start = i,
    token = toks[i++] || bad(),
    head = HEAD[token];
  if (head) return head();
  return (
    (/^["']/.test(token)
      ? konst(str(token, start))
      : /^[\d.]/.test(token)
        ? konst(+token)
        : ID.test(token)
          ? ident(token, start)
          : null) || (i--, bad())
  );
};

/**
 * @param {any} m
 * @param {any} b
 * @param {Node[]} args
 * @param {number} callStart
 * @param {number} callEnd
 * @param {any} own
 * @param {any} scope
 * @returns {any}
 */
let invoke = (m, b, args, callStart, callEnd, own, scope) => {
  if (typeof m?.apply !== "function")
    fault(TypeError, "Cannot call method", "XPRSN_NOT_CALLABLE", callStart, callEnd, own);
  return m.apply(
    b,
    args.map((e) => e(scope)),
  );
};

/**
 * One postfix step off base `o`. `key(scope)` is the member key and
 * `start`/`end` its span; `opt` (the `?.` form) yields null on a nullish base
 * instead of throwing, per step; a trailing `(` makes it a method call bound to
 * the base, which `computed` rules out for an index.
 *
 * @param {Node} o
 * @param {boolean} opt
 * @param {Node} key
 * @param {number} start
 * @param {number} end
 * @param {0 | 1} computed
 * @returns {Node}
 */
let step = (o, opt, key, start, end, computed) => {
  // A trailing `(` is a method call, but not on a computed index.
  let args = /** @type {Node[] | 0} */ (!computed && eat("(") ? seq(")", ternary) : 0),
    callEnd = args ? endPos(i - 1) : end,
    own = names;
  return (scope) => {
    let b = o(scope);
    if (opt && b == null) return null;
    let m = get(b, key(scope), start, end, own);
    return args ? invoke(m, b, args, start, callEnd, own, scope) : m;
  };
};

/**
 * A primary stepped through every member access that follows it: `[expr]` is a
 * computed key spanning from the operator token, `.name` (and the `?.` form) a
 * literal one spanning the name alone.
 *
 * @returns {Node}
 */
let postfix = () => {
  let e = primary(),
    opAt,
    opt;
  for (;;) {
    opAt = i;
    opt = eat("?.");
    // `k` is per step: the `.name` key closure captures the binding it read.
    if (eat("[")) {
      let k = ternary();
      expect("]");
      e = step(e, opt, k, pos[opAt], endPos(i - 1), 1);
    } else if (opt || eat(".")) {
      let at = i,
        k = take(ID);
      e = step(e, opt, () => k, pos[at], endPos(at), 0);
    } else return e;
  }
};

/** @returns {Node} */
let unary = () => {
  let op = UNARY[toks[i]];
  if (!op) return postfix();
  let e = (i++, unary());
  return (scope) => op(e(scope));
};

/**
 * Precedence climbing over BIN; `and`/`or`/`??` short-circuit.
 *
 * @param {number} [min]
 * @returns {Node}
 */
let expr = (min = 1) => {
  let left = unary();
  // `toks[i++]` re-reads the operator token and consumes it in one step.
  for (let b; (b = BIN[toks[i]]) && b[0] >= min;)
    left = b[1](left, expr(toks[i++] === "**" ? b[0] : b[0] + 1));
  return left;
};

/**
 * Arrow lambda `x => body`, single param, no parens. Compiles to a function
 * value only a registry function can invoke, since calls resolve from the
 * registry alone. The body is parser-compiled, so every read still routes
 * through `get()`, and the param binds through a child scope.
 *
 * @returns {Node}
 */
let lambda = () => {
  let param = toks[i];
  i += 2; // param + `=>`
  // `bound` excludes the param from `names`.
  let had = bound.has(param);
  bound.add(param);
  let b = ternary();
  // oxlint-disable-next-line no-unused-expressions
  had || bound.delete(param);
  // Child scope: computed `[n]` is always an own prop (safe even for
  // `__proto__`/`constructor` — get() still blocks reading those), and the
  // literal `__proto__: v` chains outer variables/anchors through for fallthrough.
  return (scope) => (/** @type {any} */ arg) => b({ __proto__: scope, [param]: arg });
};

/**
 * `a ? b : c` selects; `a ?: b` yields the condition when truthy, else `b`.
 *
 * @returns {Node}
 */
let ternary = () => {
  // Past the end `toks[i]` stringifies to an ID match, but `=>` never follows.
  if (ID.test("" + toks[i]) && toks[i + 1] === "=>") return lambda();
  let c = expr();
  if (!eat("?")) return c;
  // Elvis parses no `t`, and keeps `||` so `e` runs once.
  let t = /** @type {Node | 0} */ (eat(":") ? 0 : ternary()),
    e = (t && expect(":"), ternary());
  // The cast restates what `t ?` already tested: a captured `let` does not narrow.
  return (scope) =>
    t ? (c(scope) ? /** @type {Node} */ (t)(scope) : e(scope)) : c(scope) || e(scope);
};

/**
 * Compile an expression once, evaluate it many times.
 *
 * @param {string} src The expression, e.g. `'user.age > 18 and "admin" in user.roles'`.
 * @param {Record<string, Function>} [funcs] Functions callable from the expression.
 * @param {{bound?: Iterable<string>}} [opts] `bound`: root names to omit from `names`.
 * @returns {{(values?: Record<string, any>): any, names: string[], reads: { name: string, start: number, end: number }[], functions: string[], isDiagnostic(error: unknown): boolean}} Evaluator for the compiled expression.
 * @throws {SyntaxError} On malformed input or unknown function names.
 */
export function compile(src, funcs, opts) {
  toks = lex(String(src));
  i = 0;
  fns = funcs || {};
  names = new Set();
  reads = [];
  functions = new Set();
  // Object() tolerates absent opts; Set() tolerates an absent bound list.
  bound = new Set(Object(opts).bound);
  let o = names,
    e;
  // Deeply nested input overflows the recursive-descent parser; surface that as
  // a SyntaxError so malformed input keeps its documented compile-time contract.
  try {
    e = toks.length ? ternary() : bad();
    // oxlint-disable-next-line no-unused-expressions
    i < toks.length && bad();
  } catch (x) {
    if (x instanceof RangeError)
      fault(SyntaxError, "Expression too deeply nested", "XPRSN_TOO_DEEP", 0, length);
    throw x;
  }
  let f = (/** @type {any} */ v) => e(v || {});
  // Array.from, not a spread: the bundler's transpile turns `[...set]` into
  // `[].concat(set)`, which wraps the Set instead of unpacking it.
  f.names = Array.from(names);
  f.reads = reads;
  f.functions = Array.from(functions);
  f.isDiagnostic = (/** @type {any} */ x) => diags.origin(x) == o;
  return f;
}

/**
 * Describe a function registry, in its own key order. `arity` is `fn.length`
 * unless the function carries its own numeric `arity`, the escape hatch for
 * rest params and wrappers whose `length` misleads.
 *
 * @param {Record<string, Function>} [funcs] The registry to describe.
 * @returns {{ name: string, arity: number, doc?: string }[]} One signature per registry entry.
 */
export let signatures = (funcs) =>
  Object.entries(funcs || {}).map(([name, f]) => {
    let fn = /** @type {any} */ (f),
      s = /** @type {{ name: string, arity: number, doc?: string }} */ ({
        name,
        arity: typeof fn.arity == "number" ? fn.arity : fn.length,
      });
    if (typeof fn.doc == "string") s.doc = fn.doc;
    return s;
  });

/**
 * Compile and evaluate an expression in one go.
 *
 * @param {string} src The expression to evaluate.
 * @param {Record<string, any>} [values] Variables available to the expression.
 * @param {Record<string, Function>} [funcs] Functions callable from the expression.
 * @returns {any} The expression result.
 */
export function evaluate(src, values, funcs) {
  return compile(src, funcs)(values);
}
