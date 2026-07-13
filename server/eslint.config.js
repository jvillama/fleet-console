import tseslint from "typescript-eslint";

// Type-checked linting for TS sources and tests. Config files at the
// package root (vitest.config.ts) are covered via allowDefaultProject;
// scripts/*.ts is already part of the main tsconfig.json project (see
// its "include"), so it must NOT also be listed here — typescript-eslint
// errors if a file is claimed by both the default project and the
// project service. This config file itself is plain JS and deliberately
// unlinted.
export default tseslint.config(
  { ignores: ["dist/", "data/", "eslint.config.js"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
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
