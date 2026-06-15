# Project notes for Claude

## Commit workflow

- **One commit per feature or fix.** Keep commits small and focused; do not batch
  unrelated changes.
- A commit does **not** need to build or run successfully on its own — work in
  progress is fine to commit.
- **Before committing:** run `npm run lint` (or `npm run lint:fix`) and clean up
  all errors and warnings, then run the tests (`npm run test:ts` and
  `npm run test:package`; also `npm run check` for types).
- Use [Conventional Commits](https://www.conventionalcommits.org/) style subjects
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

## Releasing

- Run the ioBroker repo checker periodically and **before every release**; fix
  all reported errors:
  ```bash
  npx @iobroker/repochecker@latest https://github.com/Garfonso/ioBroker.bluetti-battery/ --local
  ```
  It queries the GitHub API, so it needs network access and a pushed `main`.

## Code style

- **Never mix `type` and value specifiers in one import statement.** The ts-node
  setup ioBroker uses fails to parse e.g. `import { Foo, type Bar } from './x'`.
  Split them: `import { Foo } from './x';` + `import type { Bar } from './x';`.

## Environment quirks

- Repo lives on a VirtualBox `vboxsf` shared folder (no symlinks, root-owned):
  - `npm install` must use `--no-bin-links`.
  - git has `core.fileMode false` set locally to avoid spurious exec-bit diffs.

## Project

ioBroker adapter for Bluetti power stations. TypeScript port of the BLE/MODBUS
protocol from [bluetti_mqtt](https://github.com/warhammerkid/bluetti_mqtt).
Runs TS directly (ts-node, no build step). BLE via `node-ble` (BlueZ/D-Bus).
One device per adapter instance. See `src/lib/` for the protocol layer.
