/**
 * Tiny, CSP-safe expression language for JavaScript.
 * Expressions compile to a composition of closures — never to JS source —
 * so no string-to-code construct is ever used and strict CSP is satisfied.
 */

/**
 * The public types are declared once, in the hand-written `index.d.ts` beside
 * this file, and pulled in here — so a signature that drifts from what ships
 * fails to compile.
 *
 * @import { XprsnDiagnostic, XprsnErrorCode, XprsnEvaluator } from './index.js'
 */

/**
 * A compiled node: given the scope object, produce a value. Every parser
 * production returns one of these — that is what makes this a closure
 * compiler rather than an AST interpreter.
 *
 * @internal
 * @typedef {(v: any) => any} Node
 * @typedef {[Node, number, number, 0 | 1]} Access
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
let diags = new WeakMap(),
  mark = diags.set.bind(diags),
  origin = diags.get.bind(diags);

/**
 * Test whether an error was created by this xprsn module instance.
 *
 * The bound `WeakMap.has` is a `(key: WeakKey) => boolean`, which cannot be
 * assigned to a type-predicate signature; the cast publishes the narrowing
 * consumers rely on.
 *
 * @type {(error: unknown) => error is XprsnDiagnostic}
 */
export let isDiagnostic = /** @type {any} */ (diags.has.bind(diags));

/**
 * Intrinsics captured at module load, exactly as `mark`/`origin` are: a copy is
 * built from a fixed table of error classes rather than through the original's
 * `constructor`, so replacing a prototype's `constructor` cannot make
 * `relocate` mint an authenticated value that is not an Error.
 */
const DESCS = Object.getOwnPropertyDescriptors,
  DEFINE = Object.defineProperties,
  PROTO = Object.getPrototypeOf,
  SYNTAX = SyntaxError.prototype,
  TYPE = TypeError.prototype;
/**
 * The two classes this module throws, and a plain Error for a diagnostic whose
 * prototype a caller has since replaced.
 *
 * @type {(p: any) => (msg: string) => Error}
 */
const kindOf = (p) => (p === SYNTAX ? SyntaxError : p === TYPE ? TypeError : Error);
/**
 * Copy a diagnostic into an embedder's coordinates.
 *
 * Relocation lives here, beside the authentication it has to satisfy: the copy
 * is registered in the same WeakMap as the original, so it passes both
 * `isDiagnostic` and the `isDiagnostic` of the evaluator that threw it. The
 * original is never mutated, and every own field the diagnostic carries comes
 * across — an embedder never enumerates them, so a field added here is never a
 * field an embedder forgets.
 *
 * @param {unknown} diag A diagnostic from this module instance.
 * @param {{ prefix?: string, offset?: number }} [opts] `prefix` is prepended to
 *   the message verbatim; `offset` shifts `start` and `end`.
 * @returns {XprsnDiagnostic} The relocated copy.
 * @throws {TypeError} When `diag` is not a diagnostic from this instance.
 */
export let relocate = (diag, { prefix = "", offset = 0 } = {}) => {
  if (!isDiagnostic(diag)) throw TypeError("Not an xprsn diagnostic");
  let d = /** @type {any} */ (diag),
    props = DESCS(d),
    copy = kindOf(PROTO(d))(prefix + d.message);
  delete props.message;
  delete props.stack;
  if (props.start) {
    props.start.value += offset;
    props.end.value += offset;
  }
  DEFINE(copy, props);
  return (mark(copy, origin(d)), /** @type {XprsnDiagnostic} */ (copy));
};

/**
 * `code` is typed to the published union, so a code this module throws but
 * `index.d.ts` does not declare fails to compile rather than shipping.
 *
 * @param {(msg: string) => Error} Type
 * @param {string} msg
 * @param {XprsnErrorCode} code
 * @param {number} start
 * @param {number} end
 * @param {any} [own] The names set this diagnostic originated from, when there is one.
 * @returns {XprsnDiagnostic}
 */
let fault = (Type, msg, code, start, end, own) => {
  let e = /** @type {Error & { code: XprsnErrorCode, start: number, end: number }} */ (Type(msg));
  e.code = code;
  e.start = start;
  e.end = end;
  return (mark(e, own), e);
};

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
    if ("\"'".includes(t)) throw fault(SyntaxError, "Unexpected " + t, "XPRSN_SYNTAX", at, length);
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

/**
 * Binary operator precedence (higher binds tighter). `**` is right-associative.
 * `~` (string concat) sits below comparison and above `+`, so `"x: " ~ a + b`
 * joins the sum and `a ~ b == "12"` compares the joined string.
 * Looked up by arbitrary token text; a miss is undefined and fails `>= min`.
 * A normal object is safe here: inherited methods are non-numeric, so they
 * never pass the precedence test (unlike UNARY/OPEN/LITERALS, which call
 * the looked-up value).
 *
 * @type {Record<string, number>}
 */
const PREC = {
  "??": 1,
  or: 2,
  "||": 2,
  and: 3,
  "&&": 3,
  "==": 4,
  "!=": 4,
  in: 5,
  "<": 6,
  ">": 6,
  "<=": 6,
  ">=": 6,
  "~": 7,
  "+": 8,
  "-": 8,
  "*": 9,
  "/": 9,
  "%": 9,
  "**": 10,
};

/** @type {Record<string, (a: any, b: any) => any>} */
const OPS = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "~": (a, b) => "" + a + b, // string concat, coerces both sides
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
  // `in`: arrays use includes; objects use hasOwn (never the JS `in` operator).
  in: (a, b) => (b && b.includes ? b.includes(a) : Object.hasOwn(b, a)),
};

/** @type {Record<string, (e: Node) => Node>} */
const UNARY = table({
  "!": (e) => (scope) => !e(scope),
  "-": (e) => (scope) => -e(scope),
  "+": (e) => (scope) => +e(scope),
});

/** @type {Record<string, (lhs: Node, right: Node) => Node>} */
const SHORT = {
  and: (lhs, right) => (scope) => lhs(scope) && right(scope),
  or: (lhs, right) => (scope) => lhs(scope) || right(scope),
  "??": (lhs, right) => (scope) => lhs(scope) ?? right(scope),
};
SHORT["&&"] = SHORT.and;
SHORT["||"] = SHORT.or;

/** @type {Record<string, Node>} */
const LITERALS = table({
  true: () => !0,
  false: () => !1,
  null: () => null,
});

/** @param {any} k */
let blocked = (k) => k === "__proto__" || k === "constructor" || k === "prototype";

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
 * Shared empty set so the common no-`bound` path allocates nothing.
 *
 * @type {Set<string>}
 */
let EMPTY = new Set();

/**
 * @param {string} msg
 * @param {XprsnErrorCode} [code]
 * @param {number} [at]
 * @returns {never}
 */
const err = (msg, code = "XPRSN_SYNTAX", at = i) => {
  let t = toks[at],
    p = t ? pos[at] : length;
  throw fault(SyntaxError, msg, code, p, t ? endPos(at) : p);
};

/**
 * `const`, not `let`: TypeScript only propagates a `never` return through
 * control-flow analysis when the callee binding cannot be reassigned. Neither
 * of these ever is, and it is what lets `bad()` end a branch.
 *
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
 * language. Blocks the prototype-chain escape hatches (`x.constructor.constructor`
 * is `Function`) and gives readable errors on null bases.
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
    throw fault(TypeError, 'Cannot read "' + k + '" of ' + o, "XPRSN_NULL_BASE", start, end, own);
  if (blocked(k))
    throw fault(TypeError, 'Cannot access "' + k + '"', "XPRSN_BLOCKED_KEY", start, end, own);
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
    err(/** @type {Error} */ (x).message, "XPRSN_SYNTAX", at);
  }
};

/**
 * Identifier start (also a valid property name): letters, `_`, and the `$`/`@`
 * scope anchors. Property keys still route through the get() guard.
 */
let ID = /^[A-Za-z_$@]/;

/**
 * Comma-separated expressions until `end` (call arguments, array items).
 *
 * @param {string} end
 * @returns {Node[]}
 */
let list = (end) => {
  let items = /** @type {Node[]} */ ([]);
  if (!eat(end)) {
    do items.push(ternary());
    while (eat(","));
    expect(end);
  }
  return items;
};

/** @returns {string} */
let hashKey = () => {
  let at = i,
    k = toks[i++] || bad();
  return /^["']/.test(k) ? str(k, at) : /^[\w.$@]/.test(k) ? k : (i--, bad());
};

/**
 * `{ k: v, ... }`, after the opening brace. Keys are string literals or bare
 * words. Null-prototype result: `{"__proto__": x}` stays inert data.
 *
 * @returns {Node}
 */
let hash = () => {
  let pairs = /** @type {[string, Node][]} */ ([]);
  if (!eat("}")) {
    do {
      let k = hashKey();
      expect(":");
      pairs.push([k, ternary()]);
    } while (eat(","));
    expect("}");
  }
  return (scope) => {
    let o = /** @type {Record<string, any>} */ (table({}));
    for (let [k, e] of pairs) o[k] = e(scope);
    return o;
  };
};

/**
 * @param {string} token
 * @param {number} start
 * @returns {Node | undefined}
 */
let literal = (token, start) => {
  if (/^["']/.test(token)) {
    let s = str(token, start);
    return () => s;
  }
  if (/^[\d.]/.test(token)) {
    let n = +token;
    return () => n;
  }
  return LITERALS[token];
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
    Object.hasOwn(fns, token) || err(token + " is not a function", "XPRSN_UNKNOWN_FUNCTION", start);
    functions.add(token);
    let fn = fns[token],
      args = list(")");
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
 * @param {string} token
 * @param {number} start
 * @returns {Node | undefined | null}
 */
let atom = (token, start) => literal(token, start) || (ID.test(token) ? ident(token, start) : null);

/** @type {Record<string, () => Node>} */
const OPEN = table({
  "(": (e = ternary()) => (expect(")"), e),
  "[":
    (items = list("]")) =>
    (scope) =>
      items.map((e) => e(scope)),
  "{": hash,
});

/** @returns {Node} */
let primary = () => {
  let start = i,
    token = toks[i++] || bad(),
    open = OPEN[token];
  if (open) return open();
  return atom(token, start) || (i--, bad());
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
    throw fault(TypeError, "Cannot call method", "XPRSN_NOT_CALLABLE", callStart, callEnd, own);
  return m.apply(
    b,
    args.map((e) => e(scope)),
  );
};

/**
 * One postfix step off base `o`. `key(scope)` is the member key; `opt` (the `?.`
 * form) yields null on a nullish base instead of throwing, per step; a
 * truthy `args` makes it a method call bound to the base.
 *
 * @param {Node} o
 * @param {Node} key
 * @param {boolean} opt
 * @param {Node[] | 0} args
 * @param {number} start
 * @param {number} end
 * @param {number} callEnd
 * @param {any} own
 * @returns {Node}
 */
let step = (o, key, opt, args, start, end, callEnd, own) => (scope) => {
  let b = o(scope);
  if (opt && b == null) return null;
  let m = get(b, key(scope), start, end, own);
  return args ? invoke(m, b, args, start, callEnd, own, scope) : m;
};

/** @param {number} opAt */
let indexAccess = (opAt, key = ternary()) => (
  expect("]"),
  /** @type {Access} */ ([key, pos[opAt], endPos(i - 1), 1])
);

let propAccess = () => {
  let at = i,
    k = toks[i++] || bad();
  // oxlint-disable-next-line no-unused-expressions
  ID.test(k) || (i--, bad());
  return /** @type {Access} */ ([() => k, pos[at], endPos(at), 0]);
};

/**
 * @param {number} opAt
 * @param {boolean} opt
 */
let accessAt = (opAt, opt) =>
  eat("[") ? indexAccess(opAt) : opt || eat(".") ? propAccess() : null;

/**
 * @param {Node} e
 * @param {boolean} opt
 * @param {Access} access
 * @returns {Node}
 */
let attach = (e, opt, access) => {
  // A trailing `(` is a method call, but not on a computed index.
  let args = /** @type {Node[] | 0} */ (!access[3] && eat("(") ? list(")") : 0);
  return step(
    e,
    access[0],
    opt,
    args,
    access[1],
    access[2],
    args ? endPos(i - 1) : access[2],
    names,
  );
};

/** @returns {Node} */
let postfix = () => {
  let e = primary(),
    opAt,
    opt,
    access;
  while (((opAt = i), (opt = eat("?.")), (access = accessAt(opAt, opt))))
    e = attach(e, opt, access);
  return e;
};

/** @returns {Node} */
let unary = () => {
  let wrap = UNARY[toks[i] === "not" ? "!" : toks[i]];
  return wrap ? (i++, wrap(unary())) : postfix();
};

/**
 * @param {string} op
 * @param {Node} lhs
 * @param {Node} right
 * @returns {Node}
 */
let binary = (op, lhs, right) =>
  SHORT[op]?.(lhs, right) ?? ((scope) => OPS[op](lhs(scope), right(scope)));

/**
 * Precedence climbing over PREC; `and`/`or` short-circuit.
 *
 * @param {number} [min]
 * @returns {Node}
 */
let expr = (min = 1) => {
  let left = unary();
  for (let /** @type {string} */ op, /** @type {number} */ p; (p = PREC[(op = toks[i])]) >= min;) {
    i++;
    left = binary(op, left, expr(op === "**" ? p : p + 1));
  }
  return left;
};

/**
 * Arrow lambda `x => body`, single param, no parens. Compiles to a function
 * VALUE the host passes to a registry reducer (e.g. `sum(rows, r => r.a)`),
 * which calls it once per element. The body is parser-compiled like any
 * expression, so every read still routes through get(); the param binds via a
 * child scope, not a new read path. Expression code cannot call the param
 * (calls resolve only from the registry) — a lambda is invoked by the host alone.
 *
 * @returns {Node}
 */
let lambda = () => {
  let param = toks[i];
  i += 2; // param + `=>`
  // `bound` excludes the param from `names`; never mutate the shared EMPTY set.
  // oxlint-disable-next-line no-unused-expressions
  bound == EMPTY && (bound = new Set());
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
 * `a ?: b` shorthand — yields the condition when truthy, else `b`.
 *
 * @param {Node} c
 */
let elvis =
  (c, e = ternary()) =>
  (/** @type {any} */ scope) =>
    c(scope) || e(scope);

/** @param {Node} c */
let conditional =
  (c, t = ternary(), e = (expect(":"), ternary())) =>
  (/** @type {any} */ scope) =>
    c(scope) ? t(scope) : e(scope);

let isLambda = () => ID.test(toks[i] || "") && toks[i + 1] === "=>";

/** @returns {Node} */
let ternary = () => {
  if (isLambda()) return lambda();
  let c = expr();
  if (!eat("?")) return c;
  return eat(":") ? elvis(c) : conditional(c);
};

/** @returns {Node} */
let parse = () => {
  let e = toks.length ? ternary() : bad();
  // oxlint-disable-next-line no-unused-expressions
  return (i < toks.length && bad(), e);
};

/** @param {{bound?: Iterable<string>} | undefined} opts */
let bindOpts = (opts) => (opts && opts.bound ? new Set(opts.bound) : EMPTY);

/**
 * Compile an expression once, evaluate it many times.
 *
 * The returned evaluator exposes `names`: the free variables the expression
 * reads, deduplicated. Property names, hash keys, and function names are not
 * included. It also exposes `reads`: every root-name read with its source span,
 * in source order, duplicates and bound names kept — `names` is its free,
 * deduplicated view. And `functions`: the registry functions the expression
 * calls, deduplicated (method names like `s.trim()` are not included).
 * `isDiagnostic(error)` recognizes runtime diagnostics created by this
 * evaluator alone.
 *
 * Absent reads yield `null`: an unknown variable or a missing property reads as
 * `null` (not undefined), so `x == null` tests hold. Reading through a null base
 * still throws; registry function return values are untouched.
 *
 * `opts.bound` lists names the host already has in scope (e.g. loop or anchor
 * variables it injects into `values`); they are excluded from `names` only. Such
 * a name still resolves normally at evaluation time, and `functions` is unaffected.
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
  bound = bindOpts(opts);
  let o = names,
    e;
  // Deeply nested input overflows the recursive-descent parser; surface that as
  // a SyntaxError so malformed input keeps its documented compile-time contract.
  try {
    e = parse();
  } catch (x) {
    throw x instanceof RangeError
      ? fault(SyntaxError, "Expression too deeply nested", "XPRSN_TOO_DEEP", 0, length)
      : x;
  }
  let f = (/** @type {any} */ v) => e(v || {});
  // Array.from, not a spread: the bundler's transpile turns `[...set]` into
  // `[].concat(set)`, which wraps the Set instead of unpacking it.
  f.names = Array.from(names);
  f.reads = reads;
  f.functions = Array.from(functions);
  f.isDiagnostic = (/** @type {any} */ x) => origin(x) == o;
  return f;
}

/**
 * Describe a function registry: one `{ name, arity, doc }` per entry, in the
 * registry's own key order. `arity` is the function's declared parameter count
 * (`fn.length`), unless the function carries its own numeric `arity` — the
 * escape hatch for rest params and wrappers, whose `length` misleads. `doc` is
 * the function's own `doc` string when it has one, and absent otherwise.
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
