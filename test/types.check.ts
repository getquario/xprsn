// Type smoke test for index.d.ts — run via `npm run test:types`.
// The declarations are plain (no expression-level inference), so this only
// checks the public API is callable with the expected shapes.
import {
	compile,
	evaluate,
	isDiagnostic,
	type XprsnDiagnostic,
	type XprsnErrorCode,
	type XprsnEvaluator,
} from '../src/index.js';

const error: unknown = new Error();
if (isDiagnostic(error)) {
	const diagnostic: XprsnDiagnostic = error;
	const code: XprsnErrorCode = diagnostic.code;
	const start: number = diagnostic.start;
	const end: number = diagnostic.end;
}

const fn = compile('user.age > 18 and (discount ?? 0) > 0');
const evaluator: XprsnEvaluator = fn;
fn({ user: { age: 30 }, discount: 5 });
fn();                                   // values arg is optional

if (fn.isDiagnostic(error)) {
	const diagnostic: XprsnDiagnostic = error;
	const code: XprsnErrorCode = diagnostic.code;
}

const names: string[] = fn.names;
const functions: string[] = fn.functions;

// funcs registry is optional and typed as functions
compile('fmt(price)', { fmt: (n: number) => String(n) })({ price: 4.5 });

// evaluate is the one-shot form
const out: any = evaluate('a + b', { a: 1, b: 2 });
evaluate('lower(name)', { name: 'X' }, { lower: (s: string) => s.toLowerCase() });
