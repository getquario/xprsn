import assert from "node:assert";
import { FuzzedDataProvider } from "@jazzer.js/core";
import { compile, isDiagnostic } from "../lib/index.js";
import { isCompileErr, isEvalErr } from "./lib.js";

const OPS = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "~",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "and",
  "or",
  "&&",
  "||",
  "??",
  "in",
];
const UNARY = ["!", "-", "+", "not "];
const KEYS = ["a", "b", "c", "x", "y", "z", "foo", "bar", "val", "n"];
const BLOCKED = ["__proto__", "constructor", "prototype"];

// Registry passed to compile so the fuzzer exercises the function-call and
// arrow-lambda reducer paths (lib/index.js). Every function is TOTAL — it never
// throws on its own, so the only errors reaching the oracle come from xprsn
// (via get()) inside a lambda body, keeping any non-eval throw a real signal.
const asArr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => {
  try {
    return Number(x);
  } catch {
    return 0;
  }
};
const text = (x) => {
  try {
    return "" + x;
  } catch {
    return "";
  }
};
const FUNCS = {
  id: (x) => x,
  add: (a, b) => num(a) + num(b),
  len: (x) => (x == null ? 0 : text(x).length),
  // Reducers: xprsn supplies the per-item lambda; the host owns iteration.
  sum: (arr, f) => asArr(arr).reduce((s, x) => s + num(f(x)), 0),
  count: (arr, f) => asArr(arr).filter((x) => f(x)).length,
  map: (arr, f) => asArr(arr).map(f),
  first: (arr, f) => {
    for (const x of asArr(arr)) if (f(x)) return x;
    return null;
  },
};
const PLAIN = ["id", "add", "len"];
const REDUCERS = ["sum", "count", "map", "first"];
// Method names for the postfix `expr.m()` path (get() + m.apply in lib/index.js).
// A base lacking the method makes the lookup null -> TypeError, which is expected.
const METHODS = [
  "trim",
  "toUpperCase",
  "toLowerCase",
  "slice",
  "includes",
  "indexOf",
  "charAt",
  "join",
];

// Blocked-key guard probes, precompiled once (the guard is independent of the
// fuzzed data, so we re-assert the invariant per run rather than re-parse it).
// Reads of __proto__/constructor/prototype must throw; the same names as hash
// keys must stay inert (own props on a null-proto object, no pollution).
const GUARD_READS = [];
const GUARD_HASHES = [];
for (const k of BLOCKED) {
  const q = JSON.stringify(k);
  // Same shapes safety.test.js covers: bare, member, computed, anchors.
  GUARD_READS.push(
    { fn: compile(k, FUNCS), values: {} },
    { fn: compile(`base.${k}`, FUNCS), values: { base: { a: 1 } } },
    { fn: compile(`base[${q}]`, FUNCS), values: { base: { a: 1 } } },
    { fn: compile(`$.${k}`, FUNCS), values: { $: {} } },
    { fn: compile(`@[${q}]`, FUNCS), values: { "@": {} } },
  );
  GUARD_HASHES.push(compile(`{${k}: 1}`, FUNCS));
}
function assertGuards() {
  const before = {}.polluted;
  for (const { fn, values } of GUARD_READS) {
    let blocked = false;
    try {
      fn(values);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      blocked = true;
    }
    if (!blocked) throw new Error("blocked-key read escaped the get() guard");
  }
  for (const hash of GUARD_HASHES) {
    const h = hash({});
    if (Object.getPrototypeOf(h) !== null)
      throw new Error("blocked hash key polluted the prototype");
  }
  if ({}.polluted !== before) throw new Error("Object.prototype polluted via hash literal");
}

// Occasionally pick a blocked key so the generator itself drives reads/hashes
// through the guard branch (weighted low so normal shapes still dominate).
function pickKey(data) {
  const pool = data.consumeIntegralInRange(0, 4) === 0 ? BLOCKED : KEYS;
  return pool[data.consumeIntegralInRange(0, pool.length - 1)];
}

function buildExpr(data, depth) {
  if (depth <= 0 || data.remainingBytes < 2) {
    const pick = data.consumeIntegralInRange(0, 3);
    if (pick === 0) return String(data.consumeIntegralInRange(-100, 100));
    if (pick === 1) return data.consumeBoolean() ? "true" : "false";
    if (pick === 2) return "null";
    return KEYS[data.consumeIntegralInRange(0, KEYS.length - 1)];
  }

  const kind = data.consumeIntegralInRange(0, 12);

  if (kind === 0) {
    const n = data.consumeIntegralInRange(-100, 100);
    return String(n);
  }

  if (kind === 1) {
    const a = buildExpr(data, depth - 1);
    const op = OPS[data.consumeIntegralInRange(0, OPS.length - 1)];
    const b = buildExpr(data, depth - 1);
    return `(${a} ${op} ${b})`;
  }

  if (kind === 2) {
    const op = UNARY[data.consumeIntegralInRange(0, UNARY.length - 1)];
    const e = buildExpr(data, depth - 1);
    return `(${op}${e})`;
  }

  if (kind === 3) {
    const c = buildExpr(data, depth - 1);
    const t = buildExpr(data, depth - 1);
    const e = buildExpr(data, depth - 1);
    return `(${c} ? ${t} : ${e})`;
  }

  if (kind === 4) {
    // Elvis shorthand a ?: b
    const c = buildExpr(data, depth - 1);
    const e = buildExpr(data, depth - 1);
    return `(${c} ?: ${e})`;
  }

  if (kind === 5) {
    const e = buildExpr(data, depth - 1);
    const key = pickKey(data);
    const opt = data.consumeBoolean() ? "?." : ".";
    return `(${e}${opt}${key})`;
  }

  if (kind === 6) {
    const e = buildExpr(data, depth - 1);
    // Sometimes index by a blocked-key string literal to hit the guard.
    const idx =
      data.consumeIntegralInRange(0, 4) === 0
        ? JSON.stringify(BLOCKED[data.consumeIntegralInRange(0, BLOCKED.length - 1)])
        : buildExpr(data, depth - 1);
    const opt = data.consumeBoolean() ? "?." : "";
    return `(${e}${opt}[${idx}])`;
  }

  if (kind === 7) {
    const count = data.consumeIntegralInRange(0, 3);
    const items = [];
    for (let i = 0; i < count; i++) items.push(buildExpr(data, depth - 1));
    return `[${items.join(",")}]`;
  }

  if (kind === 8) {
    // Function call. Either a reducer with an arrow lambda (exercises the
    // lambda VALUE + child-scope binding), or a plain N-ary registry call.
    if (data.consumeBoolean()) {
      const r = REDUCERS[data.consumeIntegralInRange(0, REDUCERS.length - 1)];
      const coll = buildExpr(data, depth - 1);
      // Rarely use a blocked param name so get() on the param is exercised.
      const p =
        data.consumeIntegralInRange(0, 5) === 0
          ? BLOCKED[data.consumeIntegralInRange(0, BLOCKED.length - 1)]
          : KEYS[data.consumeIntegralInRange(0, KEYS.length - 1)];
      const body = buildExpr(data, depth - 1);
      return `${r}(${coll}, ${p} => ${body})`;
    }
    const f = PLAIN[data.consumeIntegralInRange(0, PLAIN.length - 1)];
    const a = buildExpr(data, depth - 1);
    const b = buildExpr(data, depth - 1);
    return `${f}(${a}, ${b})`;
  }

  if (kind === 9) {
    // Method call: postfix get() + m.apply. Zero args keeps most calls valid.
    const e = buildExpr(data, depth - 1);
    const m = METHODS[data.consumeIntegralInRange(0, METHODS.length - 1)];
    return `(${e}).${m}()`;
  }

  if (kind === 10) {
    // Anchors as roots so $/@ paths show up without free-var noise.
    const root = data.consumeBoolean() ? "$" : "@";
    const key = pickKey(data);
    return `(${root}.${key})`;
  }

  if (kind === 11) {
    const q = JSON.stringify(data.consumeString(12, "utf8"));
    return data.consumeBoolean() ? q : "'" + q.slice(1, -1).replace(/'/g, "\\'") + "'";
  }

  {
    const count = data.consumeIntegralInRange(0, 3);
    const pairs = [];
    for (let i = 0; i < count; i++) {
      const k = pickKey(data);
      const v = buildExpr(data, depth - 1);
      pairs.push(`${k}: ${v}`);
    }
    return `{${pairs.join(",")}}`;
  }
}

function buildValues(data, names) {
  const vals = {};
  for (const n of names) {
    const pick = data.consumeIntegralInRange(0, 5);
    if (pick === 0) vals[n] = null;
    else if (pick === 1) vals[n] = data.consumeBoolean();
    else if (pick === 2) vals[n] = data.consumeIntegralInRange(-100, 100);
    else if (pick === 3) vals[n] = data.consumeString(16, "utf8");
    else if (pick === 4) vals[n] = { b: { c: data.consumeIntegralInRange(0, 50) }, x: "s", n: 0 };
    // A non-empty collection so reducer lambdas actually run per item.
    else
      vals[n] = Array.from({ length: data.consumeIntegralInRange(1, 3) }, () => ({
        price: data.consumeIntegralInRange(0, 50),
        qty: data.consumeIntegralInRange(1, 5),
        n: 0,
      }));
  }
  return vals;
}

const CODES = new Set([
  "XPRSN_SYNTAX",
  "XPRSN_UNKNOWN_FUNCTION",
  "XPRSN_TOO_DEEP",
  "XPRSN_NULL_BASE",
  "XPRSN_BLOCKED_KEY",
  "XPRSN_NOT_CALLABLE",
]);
const checkDiag = (e, src, required, fn) => {
  if (!isDiagnostic(e)) {
    if (required || Object.hasOwn(e, "code")) throw new Error("xprsn error lacks provenance");
    return;
  }
  if (fn && !fn.isDiagnostic(e)) throw new Error("xprsn error has wrong evaluator provenance");
  if (!Object.hasOwn(e, "code")) throw new Error("xprsn error lacks diagnostics");
  if (!CODES.has(e.code)) throw new Error("unknown diagnostic code");
  if (
    !Number.isInteger(e.start) ||
    !Number.isInteger(e.end) ||
    e.start < 0 ||
    e.end < e.start ||
    e.end > src.length
  )
    throw new Error("invalid diagnostic span");
};

// Prototype-pollution canary — defense-in-depth alongside jazzer's native
// prototype-pollution detector (enabled in strong mode via fuzz/hooks.js). The
// detector catches assignments that add prototype properties; this canary also
// covers what its docs say it misses — reassignment or deletion of existing
// members — by pinning the own-key count and the identity of core methods to
// the pristine baseline captured once at load. Cheap: a length and two `===`.
const OP = Object.prototype;
const PROTO_KEYS = Object.getOwnPropertyNames(OP).length;
// Captured for identity comparison alone, never called — `unbound-method` reads
// pinning a prototype method as the scoping hazard of calling one.
// oxlint-disable-next-line typescript/unbound-method
const PROTO_HAS_OWN = OP.hasOwnProperty;
// oxlint-disable-next-line typescript/unbound-method
const PROTO_TO_STRING = OP.toString;
const protoIntact = () =>
  Object.getOwnPropertyNames(OP).length === PROTO_KEYS &&
  OP.hasOwnProperty === PROTO_HAS_OWN &&
  OP.toString === PROTO_TO_STRING;

assertGuards();

export function fuzz(data) {
  const provider = new FuzzedDataProvider(data);
  const depth = provider.consumeIntegralInRange(0, 4);
  const src = buildExpr(provider, depth);

  let fn;
  try {
    fn = compile(src, FUNCS);
  } catch (e) {
    if (!isCompileErr(e)) throw e;
    checkDiag(e, src, true);
    return;
  }

  const names = fn.names;
  const values = buildValues(provider, names);
  const snap = JSON.stringify(values);

  let ok = false,
    first;
  try {
    first = fn(values);
    ok = true;
  } catch (e) {
    if (!isEvalErr(e)) throw e;
    checkDiag(e, src, false, fn);
  } finally {
    // These run even when eval throws or the catch returns; a pollution or
    // mutation finding takes precedence over an expected/unexpected eval error.
    if (!protoIntact()) throw new Error("Object.prototype polluted");
    // Reads must never mutate the input — check on the throwing path too.
    if (JSON.stringify(values) !== snap) throw new Error("values mutated");
  }

  // Determinism: the same compiled fn on the same (unmutated) input must yield
  // a deep-equal result. Only meaningful once the first eval succeeded.
  if (ok) {
    let second;
    try {
      second = fn(values);
    } finally {
      if (!protoIntact()) throw new Error("Object.prototype polluted");
      if (JSON.stringify(values) !== snap) throw new Error("values mutated");
    }
    assert.deepStrictEqual(second, first, "non-deterministic evaluation");
  }
}
