import { compileOnly } from "./lib.js";

export function fuzz(data) {
  compileOnly(data.toString("utf8"));
}
