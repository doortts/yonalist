import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Minimal ruleset: this codebase has never been linted, so we intentionally do
// NOT enable any broad "recommended" set. We only wire up the typescript-eslint
// parser (so .ts/.tsx parses) and the two react-hooks correctness rules.
export default [
  {
    ignores: ["node_modules", "dist", "docs", ".worktrees"],
  },
  {
    files: ["apps/yonalist/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
