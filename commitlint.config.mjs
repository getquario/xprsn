// The convention `AGENTS.md` states in prose; that file is the source and this
// one is the check, so every rule here overrides the extended preset rather
// than restating it. No scope enum: one package, so a scope names an area of
// the repo rather than a publishable unit, and a closed list would only be a
// second thing to edit.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Bodies here are prose, and the parser reads a trailing `word: text` line
    // as a footer — dependabot's trailers arrive that way too, without the
    // blank line the preset wants. So these three fire on how this repo
    // writes rather than on a mistake, and which of the two length rules
    // fires depends only on where the parser split body from footer.
    "body-max-line-length": [0],
    "footer-leading-blank": [0],
    "footer-max-line-length": [0],
    "header-max-length": [2, "always", 80],
    "scope-case": [2, "always", "lower-case"],
    "subject-case": [0],
  },
};
