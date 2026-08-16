import { evaluate } from "/lib/index.js";

const result = document.querySelector("#result");
const violations = [];

document.addEventListener("securitypolicyviolation", (event) => {
  violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
});

const assert = (value, message) => {
  if (!value) throw Error(message);
};

const throwsTypeError = (source, values, functions) => {
  try {
    evaluate(source, values, functions);
  } catch (error) {
    return error instanceof TypeError;
  }
  return false;
};

try {
  assert(evaluate("a + b", { a: 2, b: 3 }) === 5, "ordinary expression failed");

  const blocked = [
    ['a.constructor.constructor("return globalThis")', { a: {} }],
    ['a["constructor"]', { a: {} }],
    ["a.__proto__", { a: {} }],
    ["a.prototype", { a: () => {} }],
    ["(x => x).constructor", {}],
  ];
  for (const [source, values] of blocked)
    assert(throwsTypeError(source, values), `escape was not blocked: ${source}`);

  for (const name of ["window", "document", "globalThis", "fetch"])
    assert(evaluate(name) === null, `ambient capability exposed: ${name}`);

  const before = {}.polluted;
  const hash = evaluate('{"__proto__": {"polluted": true}}');
  assert(Object.getPrototypeOf(hash) === null, "hash has a prototype");
  assert({}.polluted === before, "Object.prototype was polluted");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(violations.length === 0, `CSP violation: ${violations.join(", ")}`);
  result.dataset.status = "passed";
  result.textContent = "passed";
} catch (error) {
  result.dataset.status = "failed";
  result.textContent = error.stack || String(error);
}
