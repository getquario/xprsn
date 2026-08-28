import assert from "node:assert/strict";
import test from "node:test";
import { compile, evaluate, isDiagnostic, relocate } from "../lib/index.js";

let caught = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
};

test("syntax errors", () => {
  assert.throws(() => compile(""), /Unexpected end of expression/);
  assert.throws(() => compile("1 +"), /Unexpected end of expression/);
  assert.throws(() => compile("(1 + 2"), /Unexpected end of expression/);
  assert.throws(() => compile("1 + 2)"), /Unexpected \)/, "trailing tokens rejected");
  assert.throws(() => compile("[1, 2"), SyntaxError);
  assert.throws(() => compile("{a 1}"), SyntaxError, "missing colon");
  assert.throws(() => compile("{"), /Unexpected end of expression/, "unterminated hash");
  assert.throws(() => compile("{+: 1}"), /Unexpected \+/, "hash keys must be words or strings");
  assert.throws(() => compile("a."), SyntaxError);
  assert.throws(() => compile("a.1"), SyntaxError, "property names must be identifiers");
  assert.throws(() => compile("a.+"), /Unexpected \+/, "property names must be identifiers");
  assert.throws(() => compile("1 ? 2"), SyntaxError, "unterminated ternary");
  assert.throws(() => compile("1 ? 2 :"), /Unexpected end of expression/, "ternary missing else");
  assert.throws(() => compile("a ??"), /Unexpected end of expression/);
  assert.throws(() => compile("a?."), SyntaxError);
  assert.throws(() => compile("a?.[1"), SyntaxError);
  assert.throws(() => compile("#"), /Unexpected #/, "# is not an identifier char");
  assert.throws(() => compile("'abc"), SyntaxError, "unterminated single-quoted string");
  assert.throws(() => compile('"abc'), SyntaxError, "unterminated double-quoted string");
  assert.throws(() => compile(String.raw`'\x41'`), SyntaxError, "non-JSON escape");
});

test("unknown functions fail at compile time", () => {
  assert.throws(() => compile("nope(1)"), /nope is not a function/);
  assert.doesNotThrow(() => compile("nope(1)", { nope: (x) => x }));
});

test("errors are real SyntaxErrors", () => {
  try {
    compile("1 +");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof SyntaxError);
  }
});

test("non-string input is coerced", () => {
  assert.strictEqual(evaluate(42), 42, "numbers stringify fine");
});

test("deeply nested input throws SyntaxError, not RangeError", () => {
  const deep = "(".repeat(50000) + "1" + ")".repeat(50000);
  try {
    compile(deep);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof SyntaxError, "stack overflow surfaces as SyntaxError");
    assert.ok(!(e instanceof RangeError), "not a raw RangeError");
  }
});

test("compile errors expose stable codes and source spans", () => {
  let check = (src, code, start, end, funcs) => {
    assert.throws(
      () => compile(src, funcs),
      (e) => {
        assert.ok(e instanceof SyntaxError);
        assert.ok(isDiagnostic(e));
        assert.strictEqual(e.code, code);
        assert.deepStrictEqual([e.start, e.end], [start, end]);
        return true;
      },
    );
  };
  check("1 +", "XPRSN_SYNTAX", 3, 3);
  check("1 + )", "XPRSN_SYNTAX", 4, 5);
  check('"abc', "XPRSN_SYNTAX", 0, 4);
  check(String.raw`'\x41'`, "XPRSN_SYNTAX", 0, 6);
  check("nope(1)", "XPRSN_UNKNOWN_FUNCTION", 0, 4);

  const deep = "(".repeat(50000) + "1" + ")".repeat(50000);
  check(deep, "XPRSN_TOO_DEEP", 0, deep.length);
});

test("diagnostic provenance cannot be copied", () => {
  for (const value of [null, undefined, 1, "XPRSN_SYNTAX", {}, SyntaxError("host")])
    assert.strictEqual(isDiagnostic(value), false);

  const spoof = Object.assign(SyntaxError("spoof"), {
    code: "XPRSN_SYNTAX",
    start: 0,
    end: 1,
  });
  assert.strictEqual(isDiagnostic(spoof), false);
});

test("diagnostic provenance is local to a module instance", async () => {
  const other = await import("../lib/index.js?instance=provenance");
  let first, second;
  try {
    compile("");
  } catch (e) {
    first = e;
  }
  try {
    other.compile("");
  } catch (e) {
    second = e;
  }

  assert.ok(isDiagnostic(first));
  assert.ok(other.isDiagnostic(second));
  assert.strictEqual(isDiagnostic(second), false);
  assert.strictEqual(other.isDiagnostic(first), false);
});

test("captured provenance operations resist later prototype replacement", () => {
  // Captured to restore in `finally`, never called — `unbound-method` reads the
  // saving of a prototype method as the scoping hazard of calling one.
  // oxlint-disable-next-line typescript/unbound-method
  const set = WeakMap.prototype.set;
  // oxlint-disable-next-line typescript/unbound-method
  const get = WeakMap.prototype.get;
  // oxlint-disable-next-line typescript/unbound-method
  const has = WeakMap.prototype.has;
  const fn = compile("a.b");
  try {
    WeakMap.prototype.set = function () {
      return this;
    };
    WeakMap.prototype.get = () => ({});
    WeakMap.prototype.has = () => true;
    const spoof = Object.assign(SyntaxError("spoof"), {
      code: "XPRSN_SYNTAX",
      start: 0,
      end: 0,
    });
    assert.strictEqual(isDiagnostic(spoof), false);
    assert.throws(
      () => compile(""),
      (e) => isDiagnostic(e),
    );
    assert.throws(
      () => fn({ a: null }),
      (e) => isDiagnostic(e) && fn.isDiagnostic(e),
    );
  } finally {
    WeakMap.prototype.set = set;
    WeakMap.prototype.get = get;
    WeakMap.prototype.has = has;
  }
});

test("relocate returns an authenticated copy in the embedder's coordinates", () => {
  const original = caught(() => compile("1 + )"));
  const moved = relocate(original, { prefix: "cell.value [=1 + )]: ", offset: 1 });

  assert.ok(moved instanceof SyntaxError, "same constructor as the original");
  assert.strictEqual(moved.message, "cell.value [=1 + )]: " + original.message);
  assert.strictEqual(moved.code, original.code);
  assert.deepStrictEqual([moved.start, moved.end], [original.start + 1, original.end + 1]);
  assert.ok(isDiagnostic(moved), "the copy is authenticated");
  assert.notStrictEqual(moved, original);
  assert.deepStrictEqual([original.start, original.end], [4, 5], "the original is left untouched");
});

test("relocate defaults to no prefix and no shift", () => {
  const original = caught(() => compile("1 +"));
  const moved = relocate(original);
  assert.strictEqual(moved.message, original.message);
  assert.deepStrictEqual([moved.start, moved.end], [original.start, original.end]);
  assert.ok(isDiagnostic(moved));
});

test("relocate preserves the per-compile origin of a runtime diagnostic", () => {
  const fn = compile("a.b");
  const original = caught(() => fn({ a: null }));
  const moved = relocate(original, { prefix: "detail: ", offset: 2 });
  assert.ok(fn.isDiagnostic(moved), "still recognized by the evaluator that threw it");
  assert.strictEqual(moved.code, "XPRSN_NULL_BASE");
  assert.ok(moved instanceof TypeError, "runtime faults keep their own constructor");
});

test("relocate refuses anything that is not an xprsn diagnostic", () => {
  const spoof = Object.assign(SyntaxError("spoof"), {
    code: "XPRSN_SYNTAX",
    start: 0,
    end: 1,
  });
  for (const value of [null, undefined, 1, "XPRSN_SYNTAX", {}, SyntaxError("host"), spoof])
    assert.throws(() => relocate(value), TypeError);
});

test("relocate does not mint a diagnostic through a replaced constructor", () => {
  const d = caught(() => compile("1 +"));
  const real = SyntaxError.prototype.constructor;
  try {
    SyntaxError.prototype.constructor = function () {
      return { pwned: true };
    };
    const moved = relocate(d, { prefix: "x: " });
    assert.ok(moved instanceof SyntaxError, "the class comes from a captured table");
    assert.ok(!Object.hasOwn(moved, "pwned"));
    assert.ok(isDiagnostic(moved));
  } finally {
    SyntaxError.prototype.constructor = real;
  }
});

test("relocate degrades to a plain Error when the original's prototype was replaced", () => {
  const d = caught(() => compile("1 +"));
  Object.setPrototypeOf(d, Object.create(null));

  const moved = relocate(d, { prefix: "x: " });
  assert.ok(moved instanceof Error, "an unrecognized class falls back to Error");
  assert.ok(isDiagnostic(moved), "and is still authenticated");
});
