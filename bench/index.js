// Manual micro-benchmarks for xprsn. Run with `npm run bench`.
import assert from "node:assert/strict";
import { compile, evaluate } from "../lib/index.js";

let sink = 0;

function consume(value) {
  sink += typeof value === "number" ? value : value ? 1 : 0;
}

function micro(name, fn) {
  for (let t = performance.now(); performance.now() - t < 50;) consume(fn());
  let best = 0;
  for (let sample = 0; sample < 5; sample++) {
    let ops = 0;
    const start = performance.now();
    let elapsed;
    do {
      for (let i = 0; i < 1000; i++) consume(fn());
      ops += 1000;
      elapsed = performance.now() - start;
    } while (elapsed < 100);
    best = Math.max(best, ops / (elapsed / 1e3));
  }
  console.log(name.padEnd(30), Math.round(best).toLocaleString().padStart(14), "ops/sec");
}

const values = {
  user: { age: 30, roles: ["admin", "user"] },
  price: 60,
  qty: 2,
  items: [{ price: 60 }],
};
const EXPR = 'user.age > 18 and "admin" in user.roles ? price * qty : 0';

const add = compile("a + b");
const complex = compile(EXPR);
const member = compile("items[0].price * qty");

assert.equal(add({ a: 1, b: 2 }), 3);
assert.equal(complex(values), 120);
assert.equal(member(values), 120);

console.log(`Node ${process.version} · ${process.platform} ${process.arch}`);
console.log("\nMicrobenchmarks (best of 5)");
micro("compile: a + b", () => compile("a + b"));
micro("compile: complex", () => compile(EXPR));
micro("run: a + b", () => add({ a: 1, b: 2 }));
micro("run: complex", () => complex(values));
micro("run: member access", () => member(values));
micro("evaluate: one-shot", () => evaluate("a + b", { a: 1, b: 2 }));

if (sink < 0) console.log(sink);
