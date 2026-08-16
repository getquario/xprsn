import { evalSafe } from "./lib.js";

export function fuzz(data) {
  evalSafe(data.toString("utf8"), {});
}
