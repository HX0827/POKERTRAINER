/**
 * The one and only unit boundary in this codebase.
 *
 * The engine, the guardrail and every stored amount are INTEGER CHIPS (small blind = 1,
 * big blind = 2) — integers because side-pot division floors and distributes a remainder,
 * and that must never meet a float. Everything the model reads is BIG BLINDS, because every
 * poker heuristic it has ever seen ("open 2.5x", "100BB deep", SPR) is BB-denominated;
 * handing it chips would force a division by two before it could apply any of them.
 *
 * Those two facts are both good, and the only dangerous thing is letting them meet without a
 * label — which is exactly what happened: numeric fields were chips while the action history
 * was BB text, so a 64-chip stack was reported by the model as "64BB". Every conversion now
 * happens here and nowhere else, and tests/model-units.test.mjs fails if a new amount-bearing
 * field slips through unconverted.
 */
import type { BotObservation } from "./poker";

/** Big blinds per chip for this hand; the engine speaks chips, the model speaks big blinds. */
export function bigBlind(observation: BotObservation): number {
  const value = observation.blinds?.bigBlind;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 2;
}

export function toBB(chips: unknown, bb: number): number {
  const value = typeof chips === "number" && Number.isFinite(chips) ? chips : 0;
  return Math.round((value / bb) * 10) / 10;
}

/**
 * The payload used to mix units: numeric fields were chips while `publicActions`/`lastAction`
 * were BB strings, so the model reported a 64-chip stack as "64BB" — a clean factor-of-two
 * error. Everything the model sees is now big blinds, and nothing else is.
 */
export function bigBlindView(observation: BotObservation) {
  const bb = bigBlind(observation);
  const amount = (chips: unknown) => toBB(chips, bb);
  return {
    handNo: observation.handNo,
    street: observation.street,
    position: observation.position,
    holeCards: observation.holeCards,
    communityCards: observation.communityCards,
    boardTexture: observation.boardTexture?.summary,
    // Published analysis of LLM poker agents found they "confuse their own hole cards, position,
    // hand strengths" — so the made hand is classified for them rather than left to inference.
    handStrength: observation.handStrength,
    stack: amount(observation.stack),
    startingStack: amount(observation.startingStack),
    effectiveStack: amount(observation.effectiveStack),
    pot: amount(observation.pot),
    streetBet: amount(observation.streetBet),
    toCall: amount(observation.toCall),
    potOddsToCall: observation.potOddsToCall,
    spr: observation.spr,
    currentBet: amount(observation.currentBet),
    minRaiseToBB: amount(observation.minimumRaiseTo),
    maxRaiseToBB: amount(observation.maximumRaiseTo),
    legalActions: observation.legalActions,
    publicActions: observation.publicActions,
    playersRemaining: observation.playersRemaining,
    opponentsAbleToAct: observation.opponentsAbleToAct,
    raiseCountThisStreet: observation.raiseCountThisStreet,
    opponentProfiles: (observation.opponentProfiles ?? []).map((profile) => ({
      ...profile,
      totalCommitted: amount(profile.totalCommitted),
    })),
    publicPlayers: (observation.publicPlayers ?? []).map((player) => ({
      ...player,
      stack: amount(player.stack),
      startingStack: amount(player.startingStack),
      streetBet: amount(player.streetBet),
      totalCommitted: amount(player.totalCommitted),
    })),
  };
}

