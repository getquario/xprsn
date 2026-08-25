import assert from "node:assert/strict";
import test from "node:test";
import { compile, evaluate } from "../lib/index.js";

test("literals", () => {
  assert.strictEqual(evaluate("42"), 42);
  assert.strictEqual(evaluate("4.2"), 4.2);
  assert.strictEqual(evaluate(".5"), 0.5);
  assert.strictEqual(evaluate("1e3"), 1000);
  assert.strictEqual(evaluate('"hello"'), "hello");
  assert.strictEqual(evaluate("'hello'"), "hello");
  assert.strictEqual(evaluate('"it\\"s"'), 'it"s');
  assert.strictEqual(evaluate("'it\\'s'"), "it's");
  assert.strictEqual(
    evaluate("'say \"hi\"'"),
    'say "hi"',
    "bare double quote in a single-quoted string",
  );
  assert.strictEqual(evaluate('"line\\nbreak"'), "line\nbreak");
  assert.strictEqual(
    evaluate(String.raw`'a\"b'`),
    'a"b',
    "double-quote escape survives single-quote normalization",
  );
  assert.strictEqual(
    evaluate(String.raw`'a\\b'`),
    "a\\b",
    "escaped backslash survives single-quote normalization",
  );
  assert.strictEqual(evaluate(String.raw`'\\\''`), "\\'", "backslash before an escaped apostrophe");
  assert.strictEqual(
    evaluate(String.raw`'\n\t\u0041'`),
    "\n\tA",
    "JSON control and Unicode escapes",
  );
  assert.strictEqual(evaluate("true"), true);
  assert.strictEqual(evaluate("false"), false);
  assert.strictEqual(evaluate("null"), null);
});

test("arithmetic", () => {
  assert.strictEqual(evaluate("1 + 2"), 3);
  assert.strictEqual(evaluate("5 - 2"), 3);
  assert.strictEqual(evaluate("3 * 4"), 12);
  assert.strictEqual(evaluate("10 / 4"), 2.5);
  assert.strictEqual(evaluate("10 % 3"), 1);
  assert.strictEqual(evaluate("2 ** 10"), 1024);
});

test("precedence and associativity", () => {
  assert.strictEqual(evaluate("2 + 3 * 4"), 14);
  assert.strictEqual(evaluate("(2 + 3) * 4"), 20);
  assert.strictEqual(evaluate("2 ** 3 ** 2"), 512, "** is right-associative");
  assert.strictEqual(evaluate("10 - 3 - 2"), 5, "- is left-associative");
  assert.strictEqual(evaluate("1 + 2 > 2 and 1 < 2"), true);
  assert.strictEqual(evaluate("false or true and false"), false, "and binds tighter than or");
});

test("string concatenation", () => {
  assert.strictEqual(evaluate('"a" ~ "b"'), "ab");
  assert.strictEqual(evaluate('"x-" ~ 5'), "x-5", "coerces the right side");
  assert.strictEqual(evaluate("1 ~ 2"), "12", "coerces both sides");
  assert.strictEqual(evaluate('"a" ~ "b" ~ "c"'), "abc", "left-associative chain");
  assert.strictEqual(evaluate('first ~ " " ~ last', { first: "Robin", last: "v" }), "Robin v");
  assert.strictEqual(
    evaluate('"sum: " ~ a + b', { a: 1, b: 2 }),
    "sum: 3",
    "~ binds looser than +",
  );
  assert.strictEqual(evaluate('a ~ b == "12"', { a: 1, b: 2 }), true, "~ binds tighter than ==");
  assert.deepStrictEqual(
    compile("a ~ b").names,
    ["a", "b"],
    "operands are still scanned for names",
  );
});

test("unary operators", () => {
  assert.strictEqual(evaluate("-5"), -5);
  assert.strictEqual(evaluate("+5"), 5);
  assert.strictEqual(evaluate("--5"), 5);
  assert.strictEqual(evaluate("!true"), false);
  assert.strictEqual(evaluate("not true"), false);
  assert.strictEqual(evaluate("not not true"), true);
  assert.strictEqual(evaluate("-a", { a: 3 }), -3);
});

test("comparison", () => {
  assert.strictEqual(evaluate("1 == 1"), true);
  assert.strictEqual(evaluate('1 == "1"'), false, "== is strict");
  assert.strictEqual(evaluate('1 != "1"'), true, "!= is strict");
  assert.strictEqual(evaluate("2 < 3"), true);
  assert.strictEqual(evaluate("3 <= 3"), true);
  assert.strictEqual(evaluate("4 > 5"), false);
  assert.strictEqual(evaluate("5 >= 5"), true);
});

test("logical operators", () => {
  assert.strictEqual(evaluate("true and false"), false);
  assert.strictEqual(evaluate("true && true"), true);
  assert.strictEqual(evaluate("false or true"), true);
  assert.strictEqual(evaluate("false || false"), false);
});

test("short-circuiting", () => {
  let calls = 0;
  const boom = () => (calls++, true);
  assert.strictEqual(evaluate("false and boom()", {}, { boom }), false);
  assert.strictEqual(evaluate("true or boom()", {}, { boom }), true);
  assert.strictEqual(calls, 0, "boom() never called");
  assert.strictEqual(evaluate("true and boom()", {}, { boom }), true);
  assert.strictEqual(calls, 1);
});

test("in operator", () => {
  assert.strictEqual(evaluate('"admin" in roles', { roles: ["user", "admin"] }), true);
  assert.strictEqual(evaluate('"root" in roles', { roles: ["user", "admin"] }), false);
  assert.strictEqual(evaluate('"a" in obj', { obj: { a: 1 } }), true);
  assert.strictEqual(evaluate('"b" in obj', { obj: { a: 1 } }), false);
  assert.strictEqual(evaluate('"ell" in "hello"'), true, "substring check on strings");
  assert.strictEqual(evaluate("1 in [1, 2, 3]"), true);
});

test("arrays", () => {
  assert.deepStrictEqual(evaluate("[1, 2, 3]"), [1, 2, 3]);
  assert.deepStrictEqual(evaluate("[]"), []);
  assert.deepStrictEqual(evaluate('[1 + 1, "a", [true]]'), [2, "a", [true]]);
  assert.strictEqual(evaluate("[1, 2, 3][1]"), 2);
});

test("hashes", () => {
  assert.deepStrictEqual({ ...evaluate('{"a": 1, "b": 2}') }, { a: 1, b: 2 });
  assert.deepStrictEqual({ ...evaluate("{a: 1}") }, { a: 1 }, "bare-word keys");
  assert.deepStrictEqual({ ...evaluate("{'a': 1}") }, { a: 1 }, "single-quoted keys");
  assert.strictEqual(evaluate(String.raw`{'a\"b': 1}`)['a"b'], 1, "escaped single-quoted key");
  assert.strictEqual(evaluate("{a: 1 + 1}.a"), 2);
  assert.deepStrictEqual({ ...evaluate("{}") }, {});
});

test("ternary", () => {
  assert.strictEqual(evaluate('true ? "yes" : "no"'), "yes");
  assert.strictEqual(evaluate('false ? "yes" : "no"'), "no");
  assert.strictEqual(evaluate('1 > 2 ? "a" : 2 > 1 ? "b" : "c"'), "b", "nested ternary");
  assert.strictEqual(evaluate('"x" ?: "fallback"'), "x", "?: shorthand keeps truthy value");
  assert.strictEqual(evaluate('"" ?: "fallback"'), "fallback");
});

test("null coalescing", () => {
  assert.strictEqual(evaluate('null ?? "fallback"'), "fallback");
  assert.strictEqual(evaluate('a ?? "fallback"', {}), "fallback", "missing variable is nullish");
  assert.strictEqual(evaluate('0 ?? "fallback"'), 0, "falsy but not nullish");
  assert.strictEqual(evaluate('"" ?? "fallback"'), "", "empty string survives");
  assert.strictEqual(evaluate('a ?? b ?? "last"', {}), "last", "chains");
  assert.strictEqual(evaluate("a ?? b", { a: null, b: 2 }), 2);
  assert.strictEqual(evaluate("1 + 2 ?? 9"), 3, "binds looser than arithmetic");
  assert.strictEqual(evaluate('null ?? false or "x"'), "x", "binds looser than or");
  assert.strictEqual(
    evaluate('a ?? "d" == "d" ? "empty" : a', {}),
    "empty",
    "ternary is outermost",
  );
});

test("null-safe access", () => {
  assert.strictEqual(evaluate("a?.b", { a: null }), null);
  assert.strictEqual(evaluate("a?.b", {}), null, "missing base");
  assert.strictEqual(evaluate("a?.b", { a: { b: 1 } }), 1);
  assert.strictEqual(evaluate("a?.b?.c", { a: { b: null } }), null, "chained");
  assert.strictEqual(evaluate("a?.[0]", { a: null }), null, "null-safe index");
  assert.strictEqual(evaluate("a?.[i + 1]", { a: ["x", "y"], i: 0 }), "y");
  assert.strictEqual(evaluate("a?.toUpperCase()", { a: null }), null, "null-safe method call");
  assert.strictEqual(evaluate("a?.toUpperCase()", { a: "hi" }), "HI");
  assert.strictEqual(evaluate('a?.b ?? "none"', { a: null }), "none", "pairs with ??");
  assert.throws(
    () => evaluate("a?.b.c", { a: null }),
    TypeError,
    "safety is per step, not per chain",
  );
});

test("ternary before a bare decimal is not null-safe access", () => {
  assert.strictEqual(evaluate("a ?.5 : 1", { a: true }), 0.5);
  assert.strictEqual(evaluate("a?.5:1", { a: false }), 1);
});

test("property and index access", () => {
  const values = {
    user: { name: "Robin", address: { city: "Eindhoven" } },
    items: [{ price: 60 }],
  };
  assert.strictEqual(evaluate("user.name", values), "Robin");
  assert.strictEqual(evaluate("user.address.city", values), "Eindhoven");
  assert.strictEqual(evaluate('user["name"]', values), "Robin");
  assert.strictEqual(evaluate("items[0].price", values), 60);
  assert.strictEqual(evaluate("items[1 - 1].price", values), 60, "computed index");
  assert.strictEqual(evaluate("items[0].price * qty > 100", { ...values, qty: 2 }), true);
});

test("method calls", () => {
  assert.strictEqual(evaluate("name.toUpperCase()", { name: "robin" }), "ROBIN");
  assert.strictEqual(evaluate("name.slice(1, 3)", { name: "robin" }), "ob");
  assert.strictEqual(
    evaluate("items.indexOf(2)", { items: [1, 2, 3] }),
    1,
    "this is bound to the object",
  );
});

test("custom functions", () => {
  const funcs = { lower: (s) => s.toLowerCase(), max: Math.max };
  assert.strictEqual(evaluate('lower("HELLO")', {}, funcs), "hello");
  assert.strictEqual(evaluate("max(1, 5, 3)", {}, funcs), 5);
  assert.strictEqual(evaluate('lower(name) == "robin"', { name: "ROBIN" }, funcs), true);
});

test("compile once, evaluate many", () => {
  const fn = compile("a + b");
  assert.strictEqual(fn({ a: 1, b: 2 }), 3);
  assert.strictEqual(fn({ a: 10, b: 20 }), 30);
});

test("compiled functions expose their free variables", () => {
  assert.deepStrictEqual(compile("a + b").names, ["a", "b"]);
  assert.deepStrictEqual(compile("a + a * a").names, ["a"], "deduplicated");
  assert.deepStrictEqual(compile('42 + "x"').names, [], "literals reference nothing");
  assert.deepStrictEqual(
    compile("user.name.toUpperCase()").names,
    ["user"],
    "only the root, not properties or methods",
  );
  assert.deepStrictEqual(
    compile("f(a)", { f: (x) => x }).names,
    ["a"],
    "function names are a separate namespace",
  );
  assert.deepStrictEqual(compile("{key: a}").names, ["a"], "bare hash keys are not variables");
  assert.deepStrictEqual(
    compile("a?.b ?? c").names,
    ["a", "c"],
    "null-safe chains count their root",
  );
  assert.deepStrictEqual(
    compile("items[i + 1]").names,
    ["items", "i"],
    "index expressions are scanned too",
  );
  assert.deepStrictEqual(
    compile("x and y or not z").names,
    ["x", "y", "z"],
    "word operators are not variables",
  );
});

test("bound names are excluded from free variables", () => {
  const f = compile("@.price * qty + $.tax", {}, { bound: ["@", "$"] });
  assert.deepStrictEqual(f.names, ["qty"], "host-injected anchors are omitted");
  assert.strictEqual(
    f({ "@": { price: 2 }, qty: 3, $: { tax: 1 } }),
    7,
    "bound names still resolve at eval time",
  );
  assert.deepStrictEqual(
    compile("a + b", {}, { bound: new Set(["a"]) }).names,
    ["b"],
    "bound accepts a Set",
  );
  assert.deepStrictEqual(compile("a + b", {}).names, ["a", "b"], "no bound is unchanged");
  assert.deepStrictEqual(
    compile("region.key", {}, { bound: ["region"] }).names,
    [],
    "a bound root drops out entirely",
  );
  assert.deepStrictEqual(
    compile("f(a)", { f: (x) => x }, { bound: ["a"] }).functions,
    ["f"],
    "functions are unaffected by bound",
  );
});

test("compiled functions expose the registry functions they call", () => {
  const fns = { sum: (x) => x, avg: (x) => x, lower: (s) => s };
  assert.deepStrictEqual(compile("sum(a)", fns).functions, ["sum"]);
  assert.deepStrictEqual(compile("sum(a) + avg(b)", fns).functions, ["sum", "avg"]);
  assert.deepStrictEqual(compile("sum(a) + sum(b)", fns).functions, ["sum"], "deduplicated");
  assert.deepStrictEqual(compile("a + b").functions, [], "no calls, no functions");
  assert.deepStrictEqual(
    compile("s.trim()", {}).functions,
    [],
    "method calls are not registry functions",
  );
  assert.deepStrictEqual(
    compile('lower(name) ~ "!"', fns).functions,
    ["lower"],
    "nested in an expression",
  );
});

test("$ and @ are identifier characters (scope anchors)", () => {
  assert.strictEqual(evaluate("@", { "@": 5 }), 5, "@ is a bare variable");
  assert.strictEqual(evaluate("$", { $: 9 }), 9, "$ is a bare variable");
  assert.strictEqual(evaluate("@.price", { "@": { price: 7 } }), 7, "@ as a scope root");
  assert.strictEqual(evaluate("$.total", { $: { total: 100 } }), 100, "$ as a scope root");
  assert.strictEqual(
    evaluate("@.price * qty", { "@": { price: 4 }, qty: 3 }),
    12,
    "anchors mix with bare names",
  );
  assert.strictEqual(
    evaluate("$.rate * @.amount", { $: { rate: 1.1 }, "@": { amount: 10 } }),
    11,
    "both anchors",
  );
  assert.strictEqual(
    evaluate("$foo + a$b", { $foo: 2, a$b: 3 }),
    5,
    "$ and @ work mid-identifier too",
  );
  assert.deepStrictEqual(
    compile("@.price * $.rate").names,
    ["@", "$"],
    "anchors are reported as free variables",
  );
});

test("missing values default to null", () => {
  assert.strictEqual(evaluate("a", {}), null);
  assert.strictEqual(compile("1 + 1")(), 2, "values argument is optional");
});

test("absent reads yield null", () => {
  assert.strictEqual(evaluate("a", {}), null, "missing variable");
  assert.strictEqual(evaluate("a.b", { a: {} }), null, "missing property");
  assert.strictEqual(evaluate("a == null", {}), true, "the natural nothing test holds");
  assert.strictEqual(evaluate("a.b == null", { a: {} }), true, "missing property is null");
  assert.strictEqual(evaluate("a?.b", { a: null }), null, "null-safe base");
  assert.strictEqual(evaluate("a.b", { a: { b: 0 } }), 0, "present falsy is untouched");
  assert.strictEqual(evaluate("a.b", { a: { b: null } }), null, "present null is untouched");
  assert.strictEqual(evaluate("a.b", { a: { b: "" } }), "", "present empty string is untouched");
});

// A lambda `x => body` compiles to a function value; the host reducer calls it
// per element. Reducers live in the registry — xprsn only supplies the per-item
// function, so the host owns iteration and reset boundaries.
const reducers = {
  sum: (arr, f) => arr.reduce((s, x) => s + f(x), 0),
  count: (arr, f) => arr.reduce((s, x) => s + (f(x) ? 1 : 0), 0),
  any: (arr, f) => arr.some((x) => f(x)),
  map: (arr, f) => arr.map((x) => f(x)),
};
const rows = [
  { price: 2, qty: 3, status: "paid" },
  { price: 5, qty: 1, status: "open" },
];

test("lambdas drive per-item computation over a collection", () => {
  assert.strictEqual(
    evaluate("sum(orders, r => r.price * r.qty)", { orders: rows }, reducers),
    11,
    "aggregate",
  );
  assert.strictEqual(
    evaluate('count(orders, r => r.status == "paid")', { orders: rows }, reducers),
    1,
    "predicate count",
  );
  assert.strictEqual(
    evaluate("any(orders, r => r.qty > 2)", { orders: rows }, reducers),
    true,
    "existential",
  );
  assert.deepStrictEqual(
    evaluate('map(orders, r => r.status == "paid" ? 1 : 0)', { orders: rows }, reducers),
    [1, 0],
    "ternary body",
  );
  assert.strictEqual(
    evaluate("sum(orders, r => r.price)", { orders: [] }, reducers),
    0,
    "empty collection",
  );
});

test("lambda bodies close over outer scope", () => {
  assert.deepStrictEqual(
    evaluate("map(orders, r => r.price * tax)", { orders: rows, tax: 10 }, reducers),
    [20, 50],
    "free var from outer scope",
  );
  // Inner `sum` re-binds `n`; outer `r` still resolves through the child scope chain.
  assert.deepStrictEqual(
    evaluate(
      "map(orders, r => sum(nums, n => n + r.qty))",
      { orders: rows, nums: [10, 20] },
      reducers,
    ),
    [36, 32],
    "nested lambdas keep both bindings",
  );
});

test("a lambda param shadows outer variables and anchors", () => {
  assert.deepStrictEqual(
    evaluate("map(orders, r => r.price)", { orders: rows, r: { price: 999 } }, reducers),
    [2, 5],
    "param wins over an outer var",
  );
  assert.deepStrictEqual(
    evaluate("map(orders, r => r.price)", { orders: rows, "@": { price: 999 } }, reducers),
    [2, 5],
    "param unaffected by the @ anchor",
  );
});

test("lambda params are excluded from names but reducers are reported", () => {
  const f = compile("sum(orders, r => r.price * tax)", reducers);
  assert.deepStrictEqual(f.names, ["orders", "tax"], "the param is not a free variable");
  assert.deepStrictEqual(f.functions, ["sum"], "the reducer is reported");
  assert.deepStrictEqual(
    compile("map(a, x => map(b, y => x + y))", reducers).names,
    ["a", "b"],
    "nested params both drop out",
  );
  assert.deepStrictEqual(
    compile("r + sum(a, r => r)", reducers).names,
    ["r", "a"],
    "a same-named outer var still counts outside the lambda",
  );
});
