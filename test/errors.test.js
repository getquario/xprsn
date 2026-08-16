import assert from "node:assert/strict";
import test from "node:test";
import { compile, evaluate, isDiagnostic } from "../lib/index.js";

test("syntax errors", () => {
  assert.throws(() => compile(""), /Unexpected end of expression/);
  assert.throws(() => compile("1 +"), /Unexpected end of expression/);
  assert.throws(() => compile("(1 + 2"), /Unexpected end of expression/);
  assert.throws(() => compile("1 + 2)"), /Unexpected \)/, "trailing tokens rejected");
  assert.throws(() => compile("[1, 2"), SyntaxError);
  assert.throws(() => compile("{a 1}"), SyntaxError, "missing colon");
  assert.throws(() => compile("a."), SyntaxError);
  assert.throws(() => compile("a.1"), SyntaxError, "property names must be identifiers");
  assert.throws(() => compile("1 ? 2"), SyntaxError, "unterminated ternary");
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
  const set = WeakMap.prototype.set;
  const get = WeakMap.prototype.get;
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
