import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 80,
  sortImports: true,
  overrides: [
    {
      files: [
        "packages/l10n/test/fixtures/offline-check/.l10n/upstream/source-baseline.json",
      ],
      options: { printWidth: 1 },
    },
  ],
});
