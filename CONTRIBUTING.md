# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
pnpm install
pnpm check
```

`pnpm check` runs the TypeScript check, the unit tests (vitest, `test/*.spec.ts`), a check that
`dist/` and `mod/` match the source, and the mod drawing tests (`claude plugin test`, which runs
`mod-tests/*.test.ts`). Run `pnpm build` after changing anything in `src/` and commit the built files.

## Ground rules

- **Safety first.** Changes to `src/browser/`, `src/config/` or `src/hooks/` need a test that
  shows the guard still blocks what it should. When in doubt, block and report it as skipped.
- **Test against the fixture.** `test/fixture-app/server.ts` is a small made-up shop. Add the shape
  you need there rather than testing against a real site.
- **No product-specific code.** Baseline must work on any web app. Examples use "Acme shop".
- **Keep it quiet.** New findings or checks must not make reports noisier for everyone. Prefer a
  setup option.

## Layout

| Path | What |
|---|---|
| `skills/` | `/baseline:run`, `/baseline:setup`, `/baseline:dismiss`, `/baseline:theme` |
| `agents/` | the subagents a run dispatches |
| `src/` | the engine behind `bin/baseline` (bundled to `dist/`) and the band (bundled to `mod/`) |
| `hooks/hooks.json` | the band, the SessionStart hook and the Bash guard |
| `checklists/product.md` | the product-sense checklist |
