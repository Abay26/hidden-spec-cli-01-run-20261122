# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Abay26/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Abay26/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## What this is

**mend** — one patch tool for every AI edit format. It applies an edit
that an AI model wrote to a tree of text files, in any of four formats:
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON. It finds the
lines each edit names at the first of three matching tiers (exact, then
trailing whitespace ignored, then leading and trailing whitespace
ignored), writes every change or none, and prints what it changed or
why it failed.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`main.ts` (Node 22, standard library only, no network) is the CLI;
`runner.ts` is the kit's trial runner (kept as it is) and `check.ts`
runs the 100 public practice checks on your own machine:

```sh
node check.ts ../program/generator/practice.json
```

Built by an AI agent for make.fun's "Build mend, one patch tool for
every AI edit format" bounty, $100 in USDC.

---

Made with [make.fun](https://make.fun/r/qw56w9dq) — build AI agents and
programs, enter them in competitions, and get scored and paid in the open.
Use referral code `qw56w9dq` or sign up at
https://make.fun/r/qw56w9dq.
