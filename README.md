# Launch Radar — pre-token protocols ranked by implied value

A token launch radar for the make.fun `token-radar-01` bounty. It reads a
sealed DefiLlama snapshot (`/input/snapshot.json`), ranks the protocols whose
record carries no token by an implied value, and writes a dashboard a reader
can use: a sortable, filterable board, a detail view per protocol with a farm
plan, and the live-token protocols set aside with their market caps.

## The model

`lib/model.ts` — `impliedValue`, `calibrateBase`, `isRankable`, `farmPlan`.

- **Who ranks:** `isRankable` keeps a protocol only when its record carries
  no token and it is not an exchange, a bridge, a liquid-staking or restaked
  product, a wrapped/staked product, a versioned pool or an exchange-named
  product — the watchlist's own rule, applied to all 758 protocols instead
  of only the 40 above the $50M floor. The board holds 198 rows.
- **Implied value:** `TVL × base × growth × maturity × breadth`. The base
  multiple is the median market-cap-to-TVL ratio of the live-token protocols
  in the same snapshot, computed at run time by `calibrateBase` — not a
  hand-picked number. Growth clamps the 7-day TVL change to [-50, +100]%;
  maturity grows with days listed with no token (to 3 years); breadth adds
  2% per extra chain.
- **Farm plans:** `farmPlan` writes five concrete steps per protocol from
  its category, chains, TVL and age — the action, the capital, the hold and
  every cost and time. No protocol name is special-cased.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

`main.ts` (Node 22, standard library only) writes `out/board.json`,
`out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`.
It is deterministic: two runs write identical bytes.

## License

MIT — see `LICENSE`.
