/**
 * Tiny, CSP-safe expression language for JavaScript.
 * Expressions compile to a composition of closures — never to JS source —
 * so no string-to-code construct is ever used and strict CSP is satisfied.
 */

/** @import { XprsnErrorCode } from './index.js' */

// Sticky matching prevents a failed string from restarting at every later quote.
// `?.` must not swallow the `?` of a ternary before a bare decimal.
const TOKEN = /\s+|\d*\.?\d+(?:[eE][+-]?\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w$@]+|\?\.(?!\d)|\?\?|=>|[<>=!*]=|&&|\|\||\*\*|\S/y;
let length, pos;
let diags = new WeakMap(), mark = diags.set.bind(diags), origin = diags.get.bind(diags);
export let isDiagnostic = diags.has.bind(diags);
/**
 * `code` is typed to the published union, so a code this module throws but
 * `index.d.ts` does not declare fails to compile rather than shipping.
 *
 * @param {XprsnErrorCode} code
 * @param {any} [own] The names set this diagnostic originated from, when there is one.
 */
let fault = (Type, msg, code, start, end, own) => {
	let e = /** @type {Error & { code: XprsnErrorCode, start: number, end: number }} */ (Type(msg));
	e.code = code;
	e.start = start;
	e.end = end;
	return mark(e, own), e;
};
let lex = s => {
	let out = [], at, t;
	length = s.length;
	pos = [];
	for (TOKEN.lastIndex = 0; TOKEN.lastIndex < length; ) {
		at = TOKEN.lastIndex;
		// TOKEN ends in `\S`, so a non-empty remainder always matches.
		t = /** @type {RegExpExecArray} */ (TOKEN.exec(s))[0];
		if (t === '"' || t === "'") throw fault(SyntaxError, 'Unexpected ' + t, 'XPRSN_SYNTAX', at, length);
		if (t.trim()) out.push(t), pos.push(at);
	}
	return out;
};

// Binary operator precedence (higher binds tighter). `**` is right-associative.
// `~` (string concat) sits below comparison and above `+`, so `"x: " ~ a + b`
// joins the sum and `a ~ b == "12"` compares the joined string.
const PREC = { '??': 1, or: 2, '||': 2, and: 3, '&&': 3, '==': 4, '!=': 4, in: 5, '<': 6, '>': 6, '<=': 6, '>=': 6, '~': 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9, '**': 10 };

// Shared parser state; parsing is synchronous so this is safe.
// `nm` collects free variables, `fnm` the registry functions actually called,
// `bnd` the names the host already has in scope (excluded from `nm`).
let toks, i, fns, nm, fnm, bnd;

// Shared empty set so the common no-`bound` path allocates nothing.
let EMPTY = new Set();

/**
 * @param {XprsnErrorCode} [code]
 * @returns {never}
 */
let err = (msg, code = 'XPRSN_SYNTAX', at = i) => {
	let t = toks[at], p = t ? pos[at] : length;
	throw fault(SyntaxError, msg, code, p, t ? p + t.length : p);
};
let bad = () => err('Unexpected ' + (toks[i] || 'end of expression'));
let eat = t => toks[i] === t && (i++, !0);
let expect = t => eat(t) || bad();

// Guarded property read — the single gate for every dynamic key in the
// language. Blocks the prototype-chain escape hatches (`x.constructor.constructor`
// is `Function`) and gives readable errors on null bases.
let get = (o, k, start, end, own) => {
	if (o == null) throw fault(TypeError, 'Cannot read "' + k + '" of ' + o, 'XPRSN_NULL_BASE', start, end, own);
	if (k === '__proto__' || k === 'constructor' || k === 'prototype')
		throw fault(TypeError, 'Cannot access "' + k + '"', 'XPRSN_BLOCKED_KEY', start, end, own);
	// Absence normalizes to null: a missing key or variable reads as null, so the
	// natural `x == null` test works. Present null/0/false/"" pass through untouched.
	return o[k] ?? null;
};

// String literal → value. Single-quoted strings normalize to JSON first.
let str = (t, at) => {
	try {
		return JSON.parse(t[0] === '"' ? t : '"' + t.slice(1, -1)
			.replace(/\\.|"/g, c => c === "\\'" ? "'" : c === '"' ? '\\"' : c) + '"');
	} catch (x) {
		err(/** @type {Error} */ (x).message, 'XPRSN_SYNTAX', at);
	}
};

// Identifier start (also a valid property name): letters, `_`, and the `$`/`@`
// scope anchors. Property keys still route through the get() guard.
let ID = /^[A-Za-z_$@]/;

let apply = (op, a, b) =>
	op === '+' ? a + b :
	op === '-' ? a - b :
	op === '*' ? a * b :
	op === '/' ? a / b :
	op === '%' ? a % b :
	op === '**' ? a ** b :
	op === '~' ? '' + a + b : // string concat, coerces both sides
	op === '==' ? a === b :
	op === '!=' ? a !== b :
	op === '<' ? a < b :
	op === '>' ? a > b :
	op === '<=' ? a <= b :
	op === '>=' ? a >= b :
	b && b.includes ? b.includes(a) : Object.hasOwn(b, a); // in

// Comma-separated expressions until `end` (call arguments, array items).
let list = end => {
	let items = [];
	if (!eat(end)) {
		do items.push(ternary()); while (eat(','));
		expect(end);
	}
	return items;
};

let primary = () => {
	let at = i, t = toks[i++] || bad();

	if (t == '(') {
		let e = ternary();
		expect(')');
		return e;
	}

	if (t == '[') {
		let items = list(']');
		return v => items.map(e => e(v));
	}

	if (t == '{') {
		let pairs = [];
		if (!eat('}')) {
			do {
				let at = i, k = toks[i++] || bad();
				k = /^["']/.test(k) ? str(k, at) : /^[\w.$@]/.test(k) ? k : (i--, bad());
				expect(':');
				pairs.push([k, ternary()]);
			} while (eat(','));
			expect('}');
		}
		// Null-prototype result: `{"__proto__": x}` stays inert data.
		return v => {
			let o = Object.create(null);
			for (let [k, e] of pairs) o[k] = e(v);
			return o;
		};
	}

	if (/^["']/.test(t)) {
		let s = str(t, at);
		return () => s;
	}

	if (/^[\d.]/.test(t)) {
		let n = +t;
		return () => n;
	}

	if (t == 'true') return () => !0;
	if (t == 'false') return () => !1;
	if (t == 'null') return () => null;

	if (ID.test(t)) {
		if (eat('(')) {
			// Functions resolve at compile time, only from the registry.
			Object.hasOwn(fns, t) || err(t + ' is not a function', 'XPRSN_UNKNOWN_FUNCTION', at);
			fnm.add(t);
			let fn = fns[t], args = list(')');
			return v => fn(...args.map(e => e(v)));
		}
		bnd.has(t) || nm.add(t);
		let o = nm;
		return v => get(v, t, pos[at], pos[at] + t.length, o);
	}

	i--;
	bad();
};

// One postfix step off base `o`. `key(v)` is the member key; `opt` (the `?.`
// form) yields null on a nullish base instead of throwing, per step; a
// truthy `args` makes it a method call bound to the base.
let step = (o, key, opt, args, start, end, callStart, callEnd, own) => v => {
	let b = o(v);
	if (opt && b == null) return null;
	let m = get(b, key(v), start, end, own);
	if (!args) return m;
	if (typeof m?.apply !== 'function')
		throw fault(TypeError, 'Cannot call method', 'XPRSN_NOT_CALLABLE', callStart, callEnd, own);
	return m.apply(b, args.map(a => a(v)));
};

let postfix = () => {
	let e = primary();
	for (;;) {
		let opAt = i, opt = eat('?.'), computed = eat('['), key, start, end;
		if (computed) {
			key = ternary();
			expect(']');
			start = pos[opAt];
			end = pos[i - 1] + toks[i - 1].length;
		} else if (opt || eat('.')) {
			let at = i, k = toks[i++] || bad();
			ID.test(k) || (i--, bad());
			key = () => k;
			start = pos[at];
			end = start + k.length;
		} else return e;
		// A trailing `(` is a method call, but not on a computed index.
		let args = !computed && eat('(') ? list(')') : 0;
		e = step(e, key, opt, args, start, end, start, args ? pos[i - 1] + toks[i - 1].length : end, nm);
	}
};

let unary = () => {
	let t = toks[i], e;
	if (t === '!' || t === 'not') return i++, e = unary(), v => !e(v);
	if (t === '-') return i++, e = unary(), v => -e(v);
	if (t === '+') return i++, e = unary(), v => +e(v);
	return postfix();
};

// Precedence climbing over PREC; `and`/`or` short-circuit.
let expr = (min = 1) => {
	let l = unary();
	for (let op, p; (p = PREC[op = toks[i]]) >= min; ) {
		i++;
		let r = expr(op === '**' ? p : p + 1);
		l = op === 'and' || op === '&&' ? (a => v => a(v) && r(v))(l)
			: op === 'or' || op === '||' ? (a => v => a(v) || r(v))(l)
			: op === '??' ? (a => v => a(v) ?? r(v))(l)
			: ((o, a) => v => apply(o, a(v), r(v)))(op, l);
	}
	return l;
};

// Arrow lambda `x => body`, single param, no parens. Compiles to a function
// VALUE the host passes to a registry reducer (e.g. `sum(rows, r => r.a)`),
// which calls it once per element. The body is parser-compiled like any
// expression, so every read still routes through get(); the param binds via a
// child scope, not a new read path. Expression code cannot call the param
// (calls resolve only from the registry) — a lambda is invoked by the host alone.
let lambda = () => {
	let n = toks[i];
	i += 2; // param + `=>`
	// bnd excludes the param from `names`; never mutate the shared EMPTY set.
	if (bnd == EMPTY) bnd = new Set();
	let had = bnd.has(n);
	bnd.add(n);
	let b = ternary();
	had || bnd.delete(n);
	// Child scope: computed `[n]` is always an own prop (safe even for
	// `__proto__`/`constructor` — get() still blocks reading those), and the
	// literal `__proto__: v` chains outer variables/anchors through for fallthrough.
	return v => arg => b({ __proto__: v, [n]: arg });
};

let ternary = () => {
	if (ID.test(toks[i] || '') && toks[i + 1] === '=>') return lambda();
	let c = expr();
	if (!eat('?')) return c;
	if (eat(':')) {
		// `a ?: b` shorthand — yields the condition when truthy, else `b`.
		let e = ternary();
		return v => c(v) || e(v);
	}
	let t = ternary();
	expect(':');
	let e = ternary();
	return v => (c(v) ? t(v) : e(v));
};

/**
 * Compile an expression once, evaluate it many times.
 *
 * The returned evaluator exposes `names`: the free variables the expression
 * reads, deduplicated. Property names, hash keys, and function names are not
 * included. It also exposes `functions`: the registry functions the expression
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
 * @returns {{(values?: Record<string, any>): any, names: string[], functions: string[], isDiagnostic(error: unknown): boolean}} Evaluator for the compiled expression.
 * @throws {SyntaxError} On malformed input or unknown function names.
 */
export function compile(src, funcs, opts) {
	src = String(src);
	toks = lex(src);
	i = 0;
	fns = funcs || {};
	nm = new Set();
	fnm = new Set();
	bnd = opts && opts.bound ? new Set(opts.bound) : EMPTY;
	let o = nm;
	// Deeply nested input overflows the recursive-descent parser; surface that as
	// a SyntaxError so malformed input keeps its documented compile-time contract.
	let e;
	try { e = toks.length ? ternary() : bad(); }
	catch (x) {
		throw x instanceof RangeError
			? fault(SyntaxError, 'Expression too deeply nested', 'XPRSN_TOO_DEEP', 0, length)
			: x;
	}
	i < toks.length && bad();
	let f = v => e(v || {});
	// Array.from, not a spread: the bundler's transpile turns `[...set]` into
	// `[].concat(set)`, which wraps the Set instead of unpacking it.
	f.names = Array.from(nm);
	f.functions = Array.from(fnm);
	f.isDiagnostic = x => origin(x) == o;
	return f;
}

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
