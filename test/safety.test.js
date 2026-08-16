import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, evaluate, isDiagnostic } from '../lib/index.js';

let caught = fn => {
	try { fn() }
	catch (e) { return e }
	assert.fail('expected an error');
};

test('prototype escape hatches are blocked', () => {
	assert.throws(() => evaluate('a.constructor', { a: {} }), TypeError);
	assert.throws(() => evaluate('a["constructor"]', { a: {} }), TypeError);
	assert.throws(() => evaluate('a[key]', { a: {}, key: 'constructor' }), TypeError, 'computed key resolved at runtime');
	assert.throws(() => evaluate('a.__proto__', { a: {} }), TypeError);
	assert.throws(() => evaluate('a.prototype', { a: () => {} }), TypeError);
	assert.throws(() => evaluate('constructor', {}), TypeError, 'bare variable lookup is guarded too');
	assert.throws(() => evaluate('$.constructor', { $: {} }), TypeError, 'the $ anchor does not bypass the guard');
	assert.throws(() => evaluate('@["__proto__"]', { '@': {} }), TypeError, 'the @ anchor does not bypass the guard');
	assert.throws(() => evaluate('a?.constructor', { a: {} }), TypeError, 'null-safe access is still guarded');
	assert.throws(() => evaluate('a?.["constructor"]', { a: {} }), TypeError);
	assert.strictEqual(evaluate('a?.constructor', { a: null }), null, 'nullish base short-circuits before the key is touched');
	assert.throws(() => evaluate('__proto__', {}), TypeError);
	assert.throws(
		() => evaluate('a.constructor.constructor("return 1")', { a: {} }),
		TypeError,
		'the classic Function escape'
	);
});

test('hash literals cannot pollute prototypes', () => {
	const before = {}.polluted;
	const h = evaluate('{"__proto__": {"polluted": true}}');
	assert.strictEqual({}.polluted, before, 'Object.prototype untouched');
	assert.strictEqual(Object.getPrototypeOf(h), null, 'hash results have a null prototype');
	assert.deepStrictEqual({ ...h.__proto__ }, { polluted: true }, '__proto__ is inert own data');
});

test('in does not see inherited properties', () => {
	assert.strictEqual(evaluate('"toString" in obj', { obj: {} }), false);
	assert.strictEqual(evaluate('"hasOwnProperty" in obj', { obj: { a: 1 } }), false);
});

test('null-base access throws a readable error', () => {
	assert.throws(() => evaluate('a.b', { a: null }), /Cannot read "b" of null/);
	// `a` is absent, so it normalizes to null before the `.b` step reads through it.
	assert.throws(() => evaluate('a.b.c', {}), /Cannot read "b" of null/);
});

test('runtime diagnostics identify the failing read operation', () => {
	let check = (src, values, code, start, end) => {
		assert.throws(() => evaluate(src, values), e => {
			assert.ok(e instanceof TypeError);
			assert.ok(isDiagnostic(e));
			assert.strictEqual(e.code, code);
			assert.deepStrictEqual([e.start, e.end], [start, end]);
			return true;
		});
	};
	check('a.b', { a: null }, 'XPRSN_NULL_BASE', 2, 3);
	check('constructor', {}, 'XPRSN_BLOCKED_KEY', 0, 11);
	check('a[key]', { a: {}, key: 'constructor' }, 'XPRSN_BLOCKED_KEY', 1, 6);
	check('a.m()', { a: { m: 1 } }, 'XPRSN_NOT_CALLABLE', 2, 5);
});

test('runtime diagnostic provenance is scoped to its evaluator', () => {
	const first = compile('a.b');
	const second = compile('a.b');
	const one = caught(() => first({ a: null }));
	const two = caught(() => first({ a: null }));

	assert.ok(isDiagnostic(one));
	assert.ok(first.isDiagnostic(one));
	assert.ok(first.isDiagnostic(two), 'repeated calls keep the same evaluator origin');
	assert.strictEqual(second.isDiagnostic(one), false);

	const compileError = caught(() => compile('1 +'));
	assert.ok(isDiagnostic(compileError));
	assert.strictEqual(first.isDiagnostic(compileError), false, 'compile errors have package provenance only');
});

test('runtime provenance is local to a module instance', async () => {
	const other = await import('../lib/index.js?instance=runtime-provenance');
	const first = compile('a.b');
	const second = other.compile('a.b');
	const one = caught(() => first({ a: null }));
	const two = caught(() => second({ a: null }));

	assert.ok(first.isDiagnostic(one));
	assert.ok(second.isDiagnostic(two));
	assert.strictEqual(first.isDiagnostic(two), false);
	assert.strictEqual(second.isDiagnostic(one), false);
	assert.strictEqual(isDiagnostic(two), false);
	assert.strictEqual(other.isDiagnostic(one), false);
});

test('authentic host errors do not inherit the outer evaluator origin', () => {
	const compileError = caught(() => compile('1 +'));
	const foreign = compile('a.b');
	const runtimeError = caught(() => foreign({ a: null }));
	const cases = [
		compile('boom()', { boom: () => { throw compileError } }),
		compile('boom()', { boom: () => foreign({ a: null }) }),
		compile('a.b'),
		compile('a.m()'),
		compile('a ~ ""'),
	];
	const values = [
		{},
		{},
		{ a: { get b() { throw runtimeError } } },
		{ a: { m() { throw runtimeError } } },
		{ a: { [Symbol.toPrimitive]() { throw runtimeError } } },
	];

	for (let i = 0; i < cases.length; i++) {
		const e = caught(() => cases[i](values[i]));
		assert.ok(isDiagnostic(e), 'the package still authenticates the inner error');
		assert.strictEqual(cases[i].isDiagnostic(e), false, 'the outer evaluator rejects it');
	}
});

test('lambda guard errors retain their compiled evaluator origin', () => {
	const fn = compile('map(rows, r => r.missing.value)', {
		map: (rows, pick) => rows.map(pick),
	});
	const e = caught(() => fn({ rows: [{}] }));
	assert.ok(isDiagnostic(e));
	assert.ok(fn.isDiagnostic(e));
});

test('host errors pass through without xprsn diagnostics', () => {
	let registry = TypeError('registry failed');
	assert.throws(
		() => evaluate('boom()', {}, { boom: () => { throw registry } }),
		e => e === registry && !Object.hasOwn(e, 'code') && !isDiagnostic(e)
	);
	let getter = TypeError('getter failed');
	assert.throws(
		() => evaluate('a.b', { a: { get b() { throw getter } } }),
		e => e === getter && !Object.hasOwn(e, 'code') && !isDiagnostic(e)
	);
	let method = TypeError('method failed');
	assert.throws(
		() => evaluate('a.m()', { a: { m() { throw method } } }),
		e => e === method && !Object.hasOwn(e, 'code') && !isDiagnostic(e)
	);
	let coercion = TypeError('coercion failed');
	let value = { [Symbol.toPrimitive]() { throw coercion } };
	assert.throws(
		() => evaluate('value ~ ""', { value }),
		e => e === coercion && !Object.hasOwn(e, 'code') && !isDiagnostic(e)
	);
});

test('host errors cannot spoof diagnostic provenance', () => {
	let spoof = Object.assign(TypeError('getter failed'), {
		code: 'XPRSN_NULL_BASE',
		start: 2,
		end: 3,
	});
	assert.throws(
		() => evaluate('a.b', { a: { get b() { throw spoof } } }),
		e => e === spoof && !isDiagnostic(e)
	);
});

test('null normalization does not relax the guards', () => {
	assert.throws(() => evaluate('a.constructor', { a: {} }), TypeError, 'prototype keys still blocked');
	assert.throws(() => evaluate('a.b', { a: null }), TypeError, 'reading through a null base still throws');
	assert.throws(() => evaluate('a.b.c', { a: {} }), TypeError, 'missing key becomes null, then reading through it throws');
});

test('functions only resolve from the registry', () => {
	assert.throws(() => evaluate('toString()'), SyntaxError, 'inherited names are not functions');
	assert.throws(() => evaluate('boom()', { boom: () => 1 }), SyntaxError, 'values are not callable as functions');
});

test('lambda values cannot reach the Function constructor', () => {
	// Lambdas make function values first-class for the first time; every property
	// hop still routes through the get() guard, so the escape stays closed.
	assert.throws(() => evaluate('(x => x).constructor'), TypeError, 'constructor blocked on a lambda value');
	assert.throws(() => evaluate('(x => x)["constructor"]'), TypeError, 'computed constructor blocked too');
	assert.throws(() => evaluate('(x => x).__proto__'), TypeError, '__proto__ (Function.prototype) blocked');
	assert.throws(() => evaluate('(x => x).prototype'), TypeError, 'prototype blocked');
	// .call/.apply/.bind are readable but only re-invoke the safe closure; the
	// pivot to Function still needs .constructor, which the next hop blocks.
	assert.throws(() => evaluate('(x => x).call.constructor'), TypeError, 'call chain terminates at the guard');
	assert.throws(() => evaluate('(x => x).bind.constructor'), TypeError, 'bind chain terminates at the guard');
	const reducers = { map: (a, f) => a.map(x => f(x)) };
	assert.throws(
		() => evaluate('map(rows, r => r.constructor.constructor("return 1"))', { rows: [{}] }, reducers),
		TypeError,
		'the classic escape is blocked inside a lambda body'
	);
});

test('a lambda param cannot be invoked as a function', () => {
	// Calls resolve only from the registry, so a lambda is never self-callable —
	// no Y-combinator, no expression-driven recursion.
	const reducers = { map: (a, f) => a.map(x => f(x)) };
	assert.throws(() => compile('map(a, f => f(f))', reducers), SyntaxError, 'calling the param is a compile-time error');
});

test('a param named for a blocked key stays inert', () => {
	const reducers = { map: (a, f) => a.map(x => f(x)) };
	const before = {}.polluted;
	assert.throws(() => evaluate('map(rows, __proto__ => __proto__.x)', { rows: [{ x: 1 }] }, reducers), TypeError, 'reading a __proto__ param is blocked');
	assert.throws(() => evaluate('map(rows, constructor => constructor.x)', { rows: [{ x: 1 }] }, reducers), TypeError, 'reading a constructor param is blocked');
	assert.strictEqual({}.polluted, before, 'Object.prototype is untouched');
});

test('source contains no string-to-code constructs', () => {
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.ok(!/\beval\b|\bFunction\s*\(|new\s+Function/.test(src));
});

test('tokenizer resists repeated unterminated quote prefixes', () => {
	const n = 30_000;
	const t0 = Date.now();
	for (const q of ['"', "'"]) {
		const src = q + ('\\' + q).repeat(n);
		assert.throws(() => compile(src), SyntaxError, q + ' quote input is rejected');
	}
	assert.ok(Date.now() - t0 < 1500, 'completes without quadratic rescanning');
});
