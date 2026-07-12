import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Type-checked linting for TS/TSX sources and tests, plus the React hooks
// rules (exhaustive-deps, rules-of-hooks). Root config files are covered
// via allowDefaultProject; this file itself is plain JS and unlinted.
export default tseslint.config(
  { ignores: ["dist/", "eslint.config.js"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs["recommended-latest"],
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
