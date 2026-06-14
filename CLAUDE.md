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

## Environment quirks

- Repo lives on a VirtualBox `vboxsf` shared folder (no symlinks, root-owned):
  - `npm install` must use `--no-bin-links`.
  - git has `core.fileMode false` set locally to avoid spurious exec-bit diffs.

## Project

ioBroker adapter for Bluetti power stations. TypeScript port of the BLE/MODBUS
protocol from [bluetti_mqtt](https://github.com/warhammerkid/bluetti_mqtt).
Runs TS directly (ts-node, no build step). BLE via `node-ble` (BlueZ/D-Bus).
One device per adapter instance. See `src/lib/` for the protocol layer.
