import type { ActionRecord, GameState } from "./poker";

// Type-only import (same convention as heroProfile.ts / strategy.ts): this module must stay
// runtime-free of the engine so the client, the worker route and `node --test` can all load it.
/** Mirror of poker.ts BIG_BLIND. Preflop the bet level opens here, so "faced more than the big
 *  blind" is exactly "somebody has already raised". */
const BIG_BLIND = 2;

/**
 * Rolling behavioural counts for ONE seat (CONTRACT-V3 §一).
 *
 * Everything here is derived from `state.actions` — public betting only. Hole cards are never
 * read, so a seat learns exactly what an attentive opponent at the table could learn.
 *
 * The per-hand fields (`voluntary`, `raisedPreflop`, `coldCalls`, `threeBetOpp`,
 * `foldedPreflop`, `sawFlop`, `wonWithoutShowdown`) are capped at 1 per hand on purpose:
 * they are numerators over `handsDealt`, so a hand where a player calls twice preflop must
 * not push VPIP above 100%.
 */
export interface SeatDynamics {
  handsDealt: number;
  /** Preflop money in by choice. The BB checking its free option does NOT count; the SB
   *  completing DOES (the engine records it as a `call`, and it is a real decision). */
  voluntary: number;
  /** Preflop raise/all-in that lifted the bet level. */
  raisedPreflop: number;
  /** Preflop call of a raise as the FIRST voluntary money in the hand — not a limp, not the
   *  SB completion. Blind posts are forced, so a big blind defending a raise is a cold call. */
  coldCalls: number;
  /** Preflop spots facing exactly one prior raise while not having raised in this hand yet. */
  threeBetOpp: number;
  /** Of those spots, the ones answered with a raise. */
  threeBets: number;
  foldedPreflop: number;
  sawFlop: number;
  wonWithoutShowdown: number;
}

export const EMPTY_SEAT_DYNAMICS: SeatDynamics = Object.freeze({
  handsDealt: 0,
  voluntary: 0,
  raisedPreflop: 0,
  coldCalls: 0,
  threeBetOpp: 0,
  threeBets: 0,
  foldedPreflop: 0,
  sawFlop: 0,
  wonWithoutShowdown: 0,
});

/** playerId -> SeatDynamics. */
export type TableDynamics = Record<string, SeatDynamics>;

export const EMPTY_TABLE_DYNAMICS: TableDynamics = Object.freeze({});

type SeatKey = keyof SeatDynamics;

const SEAT_KEYS = Object.keys(EMPTY_SEAT_DYNAMICS) as SeatKey[];

/** Counters round-trip through JSON and through client state: never trust them. */
function readCounter(source: SeatDynamics | undefined, key: SeatKey): number {
  const value = source ? source[key] : 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function sanitizeSeat(source: SeatDynamics | undefined): SeatDynamics {
  const result = { ...EMPTY_SEAT_DYNAMICS };
  for (const key of SEAT_KEYS) result[key] = readCounter(source, key);
  return result;
}

/**
 * A raise in engine terms: the player moved the street's bet level up.
 * `allin` alone is not aggression — a short stack calling off its last chips records
 * `kind: "allin"` with `toAmount <= facedBet`, which is a call, not a raise.
 */
function isAggressive(action: ActionRecord): boolean {
  return (
    (action.kind === "raise" || action.kind === "allin") && action.toAmount > action.facedBet
  );
}

/**
 * Per-seat increments for one FINISHED hand, from public actions only.
 *
 * Walks `state.actions` in order and keeps a preflop raise counter, which is all that the
 * 3-bet and cold-call definitions need. Postflop actions are not counted: the only postflop
 * facts here (`sawFlop`, `wonWithoutShowdown`) come from the board and the showdown list.
 */
export function dynamicsForHand(state: GameState): TableDynamics {
  const result: TableDynamics = {};
  const players = Array.isArray(state?.players) ? state.players : [];
  if (players.length === 0) return result;

  const actions: ActionRecord[] = Array.isArray(state?.actions) ? state.actions : [];
  const community = Array.isArray(state?.community) ? state.community : [];
  const revealed = Array.isArray(state?.revealed) ? state.revealed : [];
  const winners = Array.isArray(state?.winners) ? state.winners : [];

  const seats = new Map<string, SeatDynamics>();
  for (const player of players) {
    if (!player || typeof player.id !== "string" || seats.has(player.id)) continue;
    seats.set(player.id, { ...EMPTY_SEAT_DYNAMICS, handsDealt: 1 });
  }

  /** Players who have already put voluntary money in this hand — the "cold" in cold call. */
  const entered = new Set<string>();
  const raisedPreflop = new Set<string>();
  const foldedPreflop = new Set<string>();
  /** One 3-bet spot per player per hand; the "exactly one raise" rule makes a second one
   *  structurally impossible, and the set keeps the invariant true even if the engine changes. */
  const threeBetSpotSeen = new Set<string>();
  let preflopRaises = 0;

  for (const action of actions) {
    if (!action || action.street !== "preflop") continue;
    const seat = seats.get(action.playerId);
    const aggressive = isAggressive(action);

    if (seat) {
      const putsMoneyIn =
        action.kind === "call" || action.kind === "raise" || action.kind === "allin";
      // Preflop the bet level starts at the big blind and only raises move it, so this is
      // exactly "there is a raise out there" — a limp and the SB completion both face 1BB.
      const facingRaise = action.facedBet > BIG_BLIND;
      const hadMoneyIn = entered.has(action.playerId);
      const hadRaised = raisedPreflop.has(action.playerId);

      // Evaluated before this action updates anything: facing the FIRST raise, having never
      // raised this hand, is the textbook 3-bet spot. Folding here is still an opportunity.
      if (preflopRaises === 1 && !hadRaised && !threeBetSpotSeen.has(action.playerId)) {
        threeBetSpotSeen.add(action.playerId);
        seat.threeBetOpp += 1;
        if (aggressive) seat.threeBets += 1;
      }

      // A call (including an all-in for less than the current bet) that is this player's
      // first voluntary chip and answers a raise.
      if (putsMoneyIn && !aggressive && facingRaise && !hadMoneyIn) {
        seat.coldCalls += 1;
      }

      // The engine only offers `check` when there is nothing to call, so every preflop
      // call/raise/all-in is money the player chose to put in. That is why the BB's free
      // option (recorded as `check`) is not voluntary while the SB completion (a `call`) is.
      if (putsMoneyIn && !hadMoneyIn) {
        entered.add(action.playerId);
        seat.voluntary += 1;
      }
      if (aggressive && !hadRaised) {
        raisedPreflop.add(action.playerId);
        seat.raisedPreflop += 1;
      }
      if (action.kind === "fold" && !foldedPreflop.has(action.playerId)) {
        foldedPreflop.add(action.playerId);
        seat.foldedPreflop += 1;
      }
    }

    if (aggressive) preflopRaises += 1;
  }

  for (const player of players) {
    const seat = seats.get(player?.id);
    if (!seat) continue;
    // "Saw the flop" = did not fold before it was dealt (being all-in preflop still counts).
    seat.sawFlop = !foldedPreflop.has(player.id) && community.length >= 3 ? 1 : 0;
    // `revealed` is populated only at a real showdown, so a winner who is not in it took the
    // pot uncontested.
    seat.wonWithoutShowdown =
      winners.includes(player.id) && !revealed.includes(player.id) ? 1 : 0;
    result[player.id] = seat;
  }

  return result;
}

export function mergeTableDynamics(a: TableDynamics, b: TableDynamics): TableDynamics {
  const result: TableDynamics = {};
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const sumA = sanitizeSeat(left[id]);
    const sumB = sanitizeSeat(right[id]);
    const merged = { ...EMPTY_SEAT_DYNAMICS };
    for (const key of SEAT_KEYS) merged[key] = sumA[key] + sumB[key];
    result[id] = merged;
  }
  return result;
}

/**
 * Target frequencies per persona, expressed as a HUD line.
 *
 * VPIP/PFR rather than a home-made index on purpose: "40/10" is native vocabulary in the
 * models' training data, so the target is legible without explanation. Numbers follow the
 * published player-type table (TAG 25/20, Calling Station 40/10, Nit 15/11, Maniac 45/35).
 * `callShare` is derived, not configured — see `targetCallShare`.
 */
export interface FrequencyTarget {
  /** Target pots entered, 0..1. */
  vpip: number;
  /** Target preflop raise rate, 0..1. Always <= vpip. */
  pfr: number;
  /** Target 3-bet rate when facing an open, 0..1. GTO baseline is 6-8%; the LLM judged out
   *  of control in published analysis sat at 18.3%. */
  threeBet: number;
}

export const FREQUENCY_TARGETS: Record<string, FrequencyTarget> = Object.freeze({
  gto: { vpip: 0.24, pfr: 0.2, threeBet: 0.08 },
  boss: { vpip: 0.35, pfr: 0.27, threeBet: 0.11 },
  tag: { vpip: 0.25, pfr: 0.2, threeBet: 0.09 },
  station: { vpip: 0.4, pfr: 0.1, threeBet: 0.02 },
  short: { vpip: 0.22, pfr: 0.19, threeBet: 0.12 },
  rock: { vpip: 0.15, pfr: 0.11, threeBet: 0.04 },
  maniac: { vpip: 0.45, pfr: 0.35, threeBet: 0.16 },
});

/** Unknown persona ids fall back to a solid TAG line rather than throwing. */
const DEFAULT_TARGET: FrequencyTarget = { vpip: 0.24, pfr: 0.2, threeBet: 0.08 };

/**
 * The reference a competent opponent measures other seats against. Deliberately NOT the
 * seat's own persona target: a calling station playing exactly its designed 40/10 is still
 * the most exploitable seat at the table, and that is what the read has to say.
 */
const NORMAL_BASELINE: FrequencyTarget = { vpip: 0.24, pfr: 0.2, threeBet: 0.08 };

/**
 * Share of entered pots that should be calls rather than raises: (vpip - pfr) / vpip.
 * The station lands on 0.75, not 0.9 — real stations raise about one entry in ten.
 */
function targetCallShare(target: FrequencyTarget): number {
  if (!(target.vpip > 0)) return 0;
  return Math.max(0, Math.min(1, (target.vpip - target.pfr) / target.vpip));
}

function frequencyTarget(personaId: string): FrequencyTarget {
  // Seat ids may be `${personaId}#${seat}` when a lineup repeats a persona; the persona part
  // is what carries the target.
  const key = typeof personaId === "string" ? personaId.split("#")[0] : "";
  return FREQUENCY_TARGETS[key] ?? DEFAULT_TARGET;
}

/** Below this many hands the numbers are noise and nothing is injected into the prompt. */
const MIN_HANDS = 8;
/** Prompt lines are capped by the route at 300 characters; produce text that already fits. */
const MAX_LINE = 300;
const MAX_READ_SEATS = 3;
/** A 3-bet rate needs a few spots before it means anything at all. */
const MIN_THREE_BET_SPOTS = 4;
/** Same for "he never calls": below this many entries, zero calls is ordinary variance. */
const MIN_ENTRIES = 6;

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The rate the model will actually read. Thresholds compare against this so the sentence
 *  can never print "16% against a target of 8%" and then call it close to target. */
function shown(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[ ,;—-]+$/, "")}.`;
}

/**
 * The one correction this seat needs, in plain language. Ordered by the failure modes
 * actually measured at this table (3-bet spam first, then "never calls"), because the model
 * gets one sentence and it should be the one that changes this decision.
 */
function correctionFor(
  target: FrequencyTarget,
  vpip: number,
  entries: number,
  callShare: number | null,
  spots: number,
  threeBetRate: number | null,
): string {
  const shareTarget = targetCallShare(target);
  // Twice the target AND at least 6 points above it: catches the 18%+ observed in published
  // LLM play without firing on a normal 9% when the target is 8%.
  if (
    spots >= MIN_THREE_BET_SPOTS &&
    threeBetRate !== null &&
    threeBetRate >= target.threeBet * 2 &&
    threeBetRate >= target.threeBet + 0.06
  ) {
    return "You are 3-betting far too often — calling is the normal action here unless the hand is clearly a raise.";
  }
  // Relative, not absolute: a tight persona's target call share is small, so only "half of
  // what it should be" separates a disciplined raiser from a seat that has stopped calling.
  if (entries >= MIN_ENTRIES && callShare !== null && callShare <= shareTarget * 0.5) {
    return "You almost never call preflop — most hands you continue with should be calls, not raises.";
  }
  if (vpip >= target.vpip + 0.18) {
    return "You are entering far too many pots — fold your weakest hands before the flop.";
  }
  if (vpip <= target.vpip - 0.1) {
    return "You are folding too much — enter more pots, calling where a raise is too much.";
  }
  if (
    spots >= MIN_THREE_BET_SPOTS + 2 &&
    threeBetRate !== null &&
    threeBetRate <= target.threeBet - 0.06
  ) {
    return "You almost never 3-bet — raise your strongest hands instead of only calling them.";
  }
  return "Your frequencies are close to target; keep playing your normal game.";
}

/**
 * The acting AI's own recent frequencies against its persona target, ending in the specific
 * correction it should apply to THIS decision. Returns "" below `MIN_HANDS`.
 *
 * Example: `Your last 20 hands: entered 12 (60%, target 35%); you raised 12 and called 0
 * (call share 0%, target 23%); 3-bet 8 of 9 spots (89%, target 11%). You are 3-betting far
 * too often — calling is the normal action here unless the hand is clearly a raise.`
 */
export function selfCalibration(seat: SeatDynamics, personaId: string): string {
  const safe = sanitizeSeat(seat);
  if (safe.handsDealt < MIN_HANDS) return "";

  const target = frequencyTarget(personaId);
  const entries = Math.min(safe.voluntary, safe.handsDealt);
  const raises = Math.min(safe.raisedPreflop, entries);
  const calls = entries - raises;
  const vpip = shown(entries / safe.handsDealt);
  const callShare = entries > 0 ? shown(calls / entries) : null;
  const spots = safe.threeBetOpp;
  const threeBets = Math.min(safe.threeBets, spots);
  const threeBetRate = spots > 0 ? shown(threeBets / spots) : null;

  const parts = [
    `Your last ${safe.handsDealt} hands: entered ${entries} (${pct(vpip)}, target ${pct(target.vpip)})`,
  ];
  if (callShare !== null) {
    parts.push(
      `you raised ${raises} and called ${calls} (call share ${pct(callShare)}, target ${pct(targetCallShare(target))})`,
    );
  }
  if (threeBetRate !== null) {
    parts.push(
      `3-bet ${threeBets} of ${spots} spots (${pct(threeBetRate)}, target ${pct(target.threeBet)})`,
    );
  }

  const correction = correctionFor(target, vpip, entries, callShare, spots, threeBetRate);
  return clamp(`${parts.join("; ")}. ${correction}`, MAX_LINE);
}

/**
 * One seat's most exploitable trait, scored so seats can be ranked against each other.
 * Scores are "distance from a normal player" in VPIP-equivalent points, weighted by how much
 * money the deviation is worth: a station beats a wide raiser beats a 3-bet maniac beats a nit.
 */
function readNote(
  seat: SeatDynamics,
  position: string,
): { score: number; text: string } | null {
  const hands = seat.handsDealt;
  const entries = Math.min(seat.voluntary, hands);
  const raises = Math.min(seat.raisedPreflop, entries);
  const calls = entries - raises;
  const vpip = entries / hands;
  const callShare = entries > 0 ? calls / entries : 0;
  const spots = seat.threeBetOpp;
  const threeBets = Math.min(seat.threeBets, spots);
  const threeBetRate = spots > 0 ? threeBets / spots : 0;
  const folds = Math.min(seat.foldedPreflop, hands);
  const label = position || "That seat";

  const candidates: Array<{ score: number; text: string }> = [];
  const wide = vpip - NORMAL_BASELINE.vpip;

  if (wide >= 0.12 && callShare >= 0.5) {
    candidates.push({
      score: wide * 1.2,
      text: `${label} entered ${entries} of ${hands} hands and called ${calls} of them — value bet him, bluff less.`,
    });
  }
  if (wide >= 0.12 && callShare < 0.5) {
    candidates.push({
      score: wide + Math.max(0, threeBetRate - NORMAL_BASELINE.threeBet) * 0.5,
      text: `${label} entered ${entries} of ${hands} hands, raising ${raises} — his range is far wider than it looks.`,
    });
  }
  if (
    spots >= MIN_THREE_BET_SPOTS + 1 &&
    threeBetRate >= NORMAL_BASELINE.threeBet * 2 &&
    threeBetRate >= NORMAL_BASELINE.threeBet + 0.08
  ) {
    candidates.push({
      // Weighted below the VPIP reads on purpose: a wide 3-bet range is worth money only in
      // the spots where he faces an open, while a wide entering range is worth money every hand.
      score: (threeBetRate - NORMAL_BASELINE.threeBet) * 0.6,
      text: `${label} has 3-bet ${threeBets} of ${spots} spots — his 3-bets are not premium.`,
    });
  }
  if (wide <= -0.1) {
    candidates.push({
      score: -wide * 0.8,
      text: `${label} folded ${folds} of ${hands} hands preflop — respect his raises.`,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

/**
 * How the OTHER seats have been playing. Only seats with a real sample (`handsDealt >=
 * MIN_HANDS`) that are meaningfully off a normal-player baseline appear, at most 3, most
 * exploitable first.
 *
 * `seats[].personaId` is accepted for the caller's convenience but deliberately unused as a
 * yardstick: the read is about how a seat actually plays versus how a solid player plays,
 * not about whether it matches its own persona brief.
 */
export function tableRead(
  dynamics: TableDynamics,
  seats: Array<{ playerId: string; position: string; personaId: string }>,
  excludePlayerId: string,
): string {
  const table = dynamics && typeof dynamics === "object" ? dynamics : {};
  const list = Array.isArray(seats) ? seats : [];
  const notes: Array<{ score: number; text: string }> = [];

  for (const entry of list) {
    if (!entry || typeof entry.playerId !== "string") continue;
    if (entry.playerId === excludePlayerId) continue;
    const seat = sanitizeSeat(table[entry.playerId]);
    if (seat.handsDealt < MIN_HANDS) continue;
    const note = readNote(seat, entry.position);
    if (note) notes.push(note);
  }

  notes.sort((a, b) => b.score - a.score);

  let text = "";
  for (const note of notes.slice(0, MAX_READ_SEATS)) {
    const next = text ? `${text} ${note.text}` : note.text;
    if (next.length > MAX_LINE) break;
    text = next;
  }
  return clamp(text, MAX_LINE);
}
