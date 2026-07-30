/**
 * Hand-written declarations — bundler type generation is disabled.
 */

type Fn = (...args: any[]) => any;

export type XprsnErrorCode =
	| 'XPRSN_SYNTAX'
	| 'XPRSN_UNKNOWN_FUNCTION'
	| 'XPRSN_TOO_DEEP'
	| 'XPRSN_NULL_BASE'
	| 'XPRSN_BLOCKED_KEY'
	| 'XPRSN_NOT_CALLABLE';

export interface XprsnDiagnostic extends Error {
	readonly code: XprsnErrorCode;
	readonly start: number;
	readonly end: number;
}

export interface XprsnEvaluator {
	(values?: Record<string, any>): any;
	names: string[];
	functions: string[];
	isDiagnostic(error: unknown): error is XprsnDiagnostic;
}

/**
 * Test whether an error was created by this xprsn module instance.
 */
export function isDiagnostic(error: unknown): error is XprsnDiagnostic;

/**
 * Compile an expression once, evaluate it many times.
 *
 * The returned evaluator exposes `names` (the free variables the expression
 * reads) and `functions` (the registry functions it calls), both deduplicated.
 * Property names, hash keys, and method names are not included. Unknown
 * variables and missing properties evaluate to `null` (reading through a null
 * base still throws); validate expected variables yourself via `names`.
 *
 * `opts.bound` lists names the host already has in scope; they are excluded
 * from `names` at runtime (a bound name still resolves normally). The `names`
 * type is not narrowed — it stays a superset when `bound` is passed.
 *
 * @param src The expression, e.g. `'user.age > 18 and "admin" in user.roles'`.
 * @param funcs Functions callable from the expression.
 * @param opts `bound`: root names to omit from `names`.
 * @throws {SyntaxError} On malformed input or unknown function names.
 */
export function compile(
	src: string,
	funcs?: Record<string, Fn>,
	opts?: { bound?: Iterable<string> }
): XprsnEvaluator;

/**
 * Compile and evaluate an expression in one go.
 *
 * @param src The expression to evaluate.
 * @param values Variables available to the expression.
 * @param funcs Functions callable from the expression.
 */
export function evaluate(
	src: string,
	values?: Record<string, any>,
	funcs?: Record<string, Fn>
): any;
