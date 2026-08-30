/**
 * Hand-written declarations — bundler type generation is disabled.
 */

import type { Diagnostic, Relocation } from "waarmerk";

export type XprsnErrorCode =
  | "XPRSN_SYNTAX"
  | "XPRSN_UNKNOWN_FUNCTION"
  | "XPRSN_TOO_DEEP"
  | "XPRSN_NULL_BASE"
  | "XPRSN_BLOCKED_KEY"
  | "XPRSN_NOT_CALLABLE";

/**
 * The fields and their meanings are waarmerk's; this names the code union they
 * are checked against, and narrows the three this module always carries from
 * optional to required.
 */
export interface XprsnDiagnostic extends Diagnostic<XprsnErrorCode> {
  readonly code: XprsnErrorCode;
  readonly start: number;
  readonly end: number;
}

/** One root-name read, with its span in the source expression. */
export interface XprsnRead {
  name: string;
  start: number;
  end: number;
}

/** One registry entry described: `doc` is absent unless the function carries one. */
export interface XprsnSignature {
  name: string;
  arity: number;
  doc?: string;
}

export interface XprsnEvaluator {
  (values?: Record<string, any>): any;
  names: string[];
  reads: XprsnRead[];
  functions: string[];
  isDiagnostic(error: unknown): error is XprsnDiagnostic;
}

/**
 * Test whether an error was created by this xprsn module instance.
 */
export function isDiagnostic(error: unknown): error is XprsnDiagnostic;

/**
 * Copy a diagnostic into an embedder's coordinates: `prefix` is prepended to
 * the message verbatim, the span is moved, every other field is carried over,
 * and the copy is authenticated exactly as the original was.
 *
 * `offset` shifts the span, for an embedder that handed over a verbatim slice
 * of its own text. `span` replaces it, for one whose text reached the
 * expression through a decode and so has no offset to shift. `span` wins when
 * both are given.
 *
 * @throws {TypeError} When `diag` is not a diagnostic from this instance.
 */
export function relocate(diag: unknown, opts?: Relocation): XprsnDiagnostic;

/**
 * Compile an expression once, evaluate it many times.
 *
 * The returned evaluator exposes `names` (the free variables the expression
 * reads) and `functions` (the registry functions it calls), both deduplicated,
 * plus `reads`: every root-name read with its source span, in source order,
 * duplicates and bound names kept — `names` is its free, deduplicated view.
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
  funcs?: Record<string, (...args: any[]) => any>,
  opts?: { bound?: Iterable<string> },
): XprsnEvaluator;

/**
 * Describe a function registry: one signature per entry, in the registry's own
 * key order. `arity` is `fn.length`, unless the function carries its own
 * numeric `arity` — the escape hatch for rest params and wrappers. `doc` comes
 * from the function's own `doc` string when it has one.
 */
export function signatures(funcs?: Record<string, (...args: any[]) => any>): XprsnSignature[];

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
  funcs?: Record<string, (...args: any[]) => any>,
): any;
