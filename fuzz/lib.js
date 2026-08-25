import { compile, evaluate } from "../lib/index.js";

export const isCompileErr = (e) => e instanceof SyntaxError;
export const isEvalErr = (e) =>
  e instanceof SyntaxError ||
  e instanceof TypeError ||
  (e instanceof RangeError && /stack|Maximum call/i.test(String(e.message)));

export function compileOnly(src) {
  try {
    compile(src);
  } catch (e) {
    if (!isCompileErr(e)) throw e;
  }
}

export function evalSafe(src, values, funcs) {
  try {
    evaluate(src, values, funcs);
  } catch (e) {
    if (!isEvalErr(e)) throw e;
  }
}
