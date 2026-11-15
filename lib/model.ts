// Launch Radar — the value model and the farm plans.
//
// One sealed snapshot in, one ranked board out. The board ranks only protocols
// whose DefiLlama record carries no token (no market cap, no CoinGecko id, no
// symbol) and that are not a wrapped, staked or bridged product of a token
// that already trades. Protocols whose token already trades are kept apart:
// the dashboard shows their market caps as facts, never as model output.
//
// Implied value is computed from the snapshot's own figures, in impliedValue:
//   base      = tvl_usd x baseMultiple
//   growth    = 1 + clamp(change_7d, -50, 100) / 100 x 0.4
//   maturity  = 0.65 + 0.35 x min(age_days, 1095) / 1095   (age unknown: 0.78)
//   breadth   = 1 + 0.02 x min(chains - 1, 6)
//   implied   = max(1, round(base x growth x maturity x breadth))
//
// baseMultiple is not a constant I chose: calibrateBase reads it out of the
// snapshot at run time as the median market-cap-to-TVL ratio of the token
// protocols in the same snapshot (TVL at least $50M, exchanges and bridges
// left out). A pre-token protocol is therefore valued the way the market
// already values comparable protocols that do trade. No protocol name is
// ever special-cased: the same function scores every row, and the same
// farmPlan function writes every plan from the row's category, chains,
// TVL and age.

/** One protocol entry, exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The constants impliedValue runs on; base_multiple is calibrated, the rest fixed. */
export interface ModelConstants {
  base_multiple: number;
  calibrated_from: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_factor: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL_VERSION = 'launch-radar-1';

/** Fixed part of the model; base_multiple is filled in by calibrateBase. */
export const MODEL_FIXED = {
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.4,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_factor: 0.78,
  breadth_per_chain: 0.02,
  breadth_max_chains: 6,
} as const;

/** How many live-token protocols the dashboard's "already trades" view carries. */
export const LIVE_ROWS = 24;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** One row as the dashboard reads it (board.json's row, unchanged). */
export type RadarRow = BoardRow;

/** A protocol whose token already trades, shown with the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  mcap_per_tvl: number;
}

/** Everything the dashboard needs to render, written to data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty sorted list; null when the list is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * calibrateBase: the market's own multiple, read out of this snapshot. Take
 * every protocol that records a token, holds at least floor_usd of TVL and
 * is neither an exchange nor a bridge, and return the median of its
 * market-cap-to-TVL ratio plus how many protocols the median came from.
 * When the snapshot carries no such protocol, fall back to 0.08.
 */
export function calibrateBase(snapshot: Snapshot): { base_multiple: number; calibrated_from: number } {
  const ratios = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= snapshot.floor_usd)
    .filter((p) => p.category !== 'CEX' && p.category !== 'Bridge' && p.category !== 'Canonical Bridge')
    .map((p) => p.mcap_usd! / p.tvl_usd)
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  const median = medianOf(ratios);
  return median === null
    ? { base_multiple: 0.08, calibrated_from: 0 }
    : { base_multiple: median, calibrated_from: ratios.length };
}

/** The full model constants for a snapshot: calibrated base plus the fixed part. */
export function modelFor(snapshot: Snapshot): ModelConstants {
  const cal = calibrateBase(snapshot);
  return { ...MODEL_FIXED, base_multiple: cal.base_multiple, calibrated_from: cal.calibrated_from };
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult =
    age === null
      ? model.unknown_age_factor
      : model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.max(0, protocol.chains.length - 1);
  const breadthMult = 1 + model.breadth_per_chain * Math.min(extraChains, model.breadth_max_chains);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * model.base_multiple * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole wrapped / staked / staking word in a name. */
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
/** An exchange's name at the start of a protocol name. */
const EXCHANGE_NAMED = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a product of a token that already trades, not a launch of their own. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * isRankable: the watchlist's own rule, applied to every pre-token protocol
 * instead of only the ones above the floor. A protocol ranks when it records
 * no token, is not an exchange, bridge, liquid-staking or restaked product,
 * carries no wrapped/staked word, no version marker and no exchange name.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_OR_STAKED.test(p.name)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_NAMED.test(p.name)) return false;
  return true;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger records get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 540) return 60;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $20 of the same asset against it so the position shows both a supply and a borrow.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c === 'farm') {
    return `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} (USDC paired with the pool's main asset) and keep the LP tokens in the wallet.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain}, pick the vault with the largest TVL, and hold the vault shares.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the same wallet for the whole period.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged trade worth under $25.`;
  }
  if (c.includes('prediction')) {
    return `Fund ${name} with $${capital} on ${chain} and take one small position in a market that settles within 30 days.`;
  }
  if (c.includes('payment')) {
    return `Route $${capital} through ${name} on ${chain} for a real payment, then keep a small balance in the app.`;
  }
  if (c === 'chain') {
    return `Move $${capital} onto ${chain} through ${name}'s own bridge or on-ramp and use one native app on the chain the same week.`;
  }
  if (c.includes('restak')) {
    return `Restake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis vault on ${chain} and hold the position through one full funding cycle.`;
  }
  if (c.includes('stable')) {
    return `Mint or hold $${capital} of ${name}'s stable asset on ${chain} and keep it in the wallet for the whole period.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} for a position you already hold, and keep the policy open.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it in the farm wallet.`;
  }
  if (c.includes('governance')) {
    return `Lock $${capital} of assets in ${name} on ${chain} and vote in one governance proposal while the position is open.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, then its cost and time. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * farmPlan: a protocol's five farm steps. Every step is derived from the
 * protocol's own record (category, chains, TVL, age) — the action, the
 * capital, the hold and every cost and time. No name is special-cased.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 200 ? 10 : 5;
  return [
    stepText(
      `Open a fresh wallet for this farm only and fund it with $${gas} of ${chain}'s gas token plus the $${capital} you will deposit. Keep the seed phrase offline, never in a chat or a screenshot`,
      `about $${gas} of gas to set up`,
      '10 minutes',
    ),
    stepText(
      actionFor(p, capital, chain),
      `$${capital} of capital and about $${gas} of gas`,
      '20 minutes to set up',
    ),
    stepText(
      `Once a week, do one small qualifying action on ${p.name} — a deposit, a swap, a vote or a claim check — so the wallet shows steady use instead of one burst`,
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days. Check ${p.name}'s own points or rewards page once a month and note what it shows for your wallet`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      `When you exit, claim only from a link ${p.name} itself publishes, never from a reply or an ad, and log the wallet, the dates and every transaction hash before you withdraw`,
      'no fee to check, and never pay to claim',
      '10 minutes to log and exit',
    ),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's "already trades" view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .filter((p) => p.category !== 'CEX' && p.category !== 'Bridge' && p.category !== 'Canonical Bridge')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      mcap_per_tvl: p.mcap_usd! / p.tvl_usd,
    }));
}

/** The ranked board: every rankable pre-token protocol, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model) }));
  scored.sort(
    (a, b) =>
      b.v.implied - a.v.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    watchlist: watch.has(s.p.slug),
    model: {
      base_multiple: round4(model.base_multiple),
      growth_pct: round4(s.v.growthPct),
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      breadth_multiplier: round4(s.v.breadthMult),
    },
    farm_steps: farmPlan(s.p, s.v.age),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = modelFor(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
