// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import importXPlugin from "eslint-plugin-import-x";

// Why `tseslint.config(...)` and not `defineConfig` from `eslint/config`:
// the canonical entry would be `eslint/config`, but in this monorepo
// `eslint` is a per-workspace devDependency (so the bin lives in each
// package), not a root one. Importing from `eslint/...` at the root would
// require duplicating `eslint` at the root just for module resolution.
// `tseslint.config(...)` accepts the same variadic config shape and is
// already imported for `tseslint.configs.*` spreading.

/**
 * Shared flat-config factory. Each workspace's `eslint.config.js`
 * calls `makeConfig(import.meta.dirname)` so `projectService` picks
 * up the workspace's own `tsconfig.json`. The factory bakes in
 * everything else (rule sets, ignores, plugins) so the per-workspace
 * file is a single-line re-export.
 *
 * @param {string} workspaceDir absolute path of the workspace this
 *   config is applied to. Forwarded to `parserOptions.tsconfigRootDir`
 *   so typescript-eslint's `projectService` resolves the workspace's
 *   `tsconfig.json`, not the monorepo root's.
 */
export function makeConfig(workspaceDir) {
  return tseslint.config(
    {
      ignores: [
        "**/dist/**",
        "**/node_modules/**",
        "**/coverage/**",
        "**/*.config.js",
        "**/*.config.mjs",
        // Build-info is machine-generated (scripts/gen-build-info.mjs) and git-ignored.
        "**/src/generated/**",
      ],
    },

    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,

    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: workspaceDir,
        },
      },
    },

    // `eslint-plugin-import-x`: missing `.js` extensions on relative
    // imports are a NodeNext-resolution silent break. The rule writes
    // `.ts`/`.tsx` as `never` because the source files reference
    // sibling modules with their compiled `.js` extension (the
    // canonical TypeScript-with-NodeNext idiom).
    {
      plugins: { "import-x": importXPlugin },
      settings: { "import-x/resolver": { typescript: true, node: true } },
      rules: {
        "import-x/extensions": [
          "error",
          "always",
          {
            ignorePackages: true,
            checkTypeImports: true,
            pattern: { ts: "never", tsx: "never" },
          },
        ],
        "import-x/no-anonymous-default-export": ["error", { allowCallExpression: false }],
      },
    },

    // Erasable-syntax-only: ban TS-specific runtime constructs (enums,
    // `export =`, decorators, constructor parameter properties). All
    // four have plain TypeScript-as-type-erasure equivalents, and the
    // ban keeps the codebase usable with future Node `--experimental-
    // strip-types` style execution.
    //
    // Plus type-import discipline and a naming convention adjusted for
    // wacz-validator conventions (UPPER_CASE module constants, PascalCase
    // React FC consts, no boolean-prefix requirement).
    {
      rules: {
        "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
        "no-restricted-syntax": [
          "error",
          {
            selector: "TSEnumDeclaration",
            message: "Enums are not allowed. Use a union type or a const object instead.",
          },
          {
            selector: "TSExportAssignment",
            message:
              "Export assignment (`export =`) is not allowed. Use ES module export syntax instead.",
          },
          {
            selector: "Decorator",
            message: "Legacy experimental decorators are not allowed.",
          },
        ],
        "@typescript-eslint/no-import-type-side-effects": "error",
        "@typescript-eslint/consistent-type-imports": "error",
        // 使わないと決めた変数は `_` で始める（分割代入で 1 つ捨てる・for...of で数えるだけ）。
        // `void x;` で黙らせると no-meaningless-void-operator に当たる。
        "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_" }],
        "@typescript-eslint/naming-convention": [
          "warn",
          // const は UPPER_CASE 定数 / PascalCase React FC / camelCase の 3 形式を許容
          {
            selector: "variable",
            format: ["camelCase", "UPPER_CASE", "PascalCase"],
            leadingUnderscore: "allow",
          },
          { selector: "function", format: ["camelCase"], leadingUnderscore: "allow" },
          { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
          { selector: "accessor", format: ["camelCase"] },
          // class / interface / typeAlias / typeParameter / enum まとめて PascalCase
          { selector: "typeLike", format: ["PascalCase"] },
          // enum は no-restricted-syntax で塞いでいるが、enumMember は念のため
          { selector: "enumMember", format: ["UPPER_CASE"] },
        ],
      },
    },

    {
      files: ["test/**/*.ts", "test/**/*.tsx"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
      },
    },

    // vitest.config.ts のような top-level config ファイルは
    // `defineConfig({...})` を default export するので
    // import-x/no-anonymous-default-export と衝突する。naming も config DSL の
    // key (snake_case 等) に縛られるので緩める。
    {
      files: ["vitest.config.*[cmjt]*s"],
      rules: {
        "@typescript-eslint/naming-convention": "off",
        "import-x/no-anonymous-default-export": "off",
      },
    },
  );
}

export default makeConfig(import.meta.dirname);
