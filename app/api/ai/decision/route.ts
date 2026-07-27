import { NextRequest, NextResponse } from "next/server";
import type { ActionKind, BotObservation } from "../../../lib/poker";
import { bigBlind, bigBlindView } from "../../../lib/modelView";
import {
  checkDecision,
  describeHandClass,
  suggestSafeAction,
  type BotDecision,
  type GuardrailVerdict,
  type RuleId,
  type PersonaTraits,
} from "../../../lib/strategy";

export const dynamic = "force-dynamic";

interface RequestBody {
  persona?: {
    id?: string;
    title?: string;
    prompt?: string;
    looseness?: number;
    aggression?: number;
    bluff?: number;
  };
  observation?: BotObservation;
  api?: {
    apiKey?: string;
    model?: string;
  };
  /** Observed public frequencies of the one human seat (CONTRACT-V2 §三). Enhancement only. */
  heroProfile?: {
    text?: string;
    handsDealt?: number;
    /**
     * Executable exploit instructions, already sample-gated by `exploitDirectives` on the
     * client. The route only limits their number and length — it never rewrites them.
     */
    directives?: string[];
  };
  /** Which seat the human occupies, e.g. "BB". Required for the HERO READ block to be emitted. */
  heroPosition?: string;
  /**
   * Pre-formatted strings from `app/lib/tableDynamics.ts` (CONTRACT-V3 §一), computed on the
   * client where the rolling hand window lives. The route flattens and clamps them; the wording
   * belongs to that module and is passed through untouched.
   */
  selfCalibration?: string;
  tableRead?: string;
}

const DEEPSEEK_API_BASE = "https://api.deepseek.com";
const ALLOWED_DEEPSEEK_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

const MAX_TOKENS = 420;
const FIRST_TEMPERATURE = 0.45;
const RETRY_TEMPERATURE = 0.2;
const FIRST_TIMEOUT_MS = 5000;
const RETRY_TIMEOUT_MS = 3500;
const REASON_MAX_CHARS = 140;
const HAND_CLASS_MAX_CHARS = 24;
const HERO_READ_MAX_CHARS = 400;
const HERO_POSITION_MAX_CHARS = 12;
const HERO_DIRECTIVE_MAX_CHARS = 200;
/**
 * CONTRACT-V3 §二.4 caps the injected list at 3; §三.4 asks the `hard` hero-read tier to send
 * up to 5. The cap here is the anti-abuse limit (an unbounded client array must not become an
 * unbounded prompt), so it is set to the larger of the two — a cap of 3 would silently turn the
 * `hard` tier into the `normal` one. The client decides how many to send.
 */
const HERO_DIRECTIVE_MAX_COUNT = 5;
/** CONTRACT-V3 §二.3 — the two tableDynamics strings are already written to fit this. */
const DYNAMICS_MAX_CHARS = 300;

const PLAN_TYPES = [
  "value",
  "semi-bluff",
  "bluff",
  "bluff-catch",
  "pot-control",
  "give-up",
] as const;
const PLAN_TYPE_SET = new Set<string>(PLAN_TYPES);

const RETRY_INSTRUCTION =
  "Choose again from legalActions. Pick a different action, or a smaller legal size that " +
  "satisfies the floor. Folding is always acceptable.";
const FORMAT_RETRY_INSTRUCTION =
  "Choose again from legalActions. Reply with exactly one JSON object matching the required " +
  "schema, no prose. Folding is always acceptable.";
// Kept in step with floor rule 1: the old wording ("the equity you need to justify calling")
// repeated the preflop error in every single request, which is where "pot odds require 40%" in
// the hand log came from.
const POT_ODDS_NOTE =
  "potOddsToCall is the equity a call needs POSTFLOP (a ratio, not an amount); a preflop cold " +
  "call is priced by implied odds, position and playability instead. Every other number is in " +
  "big blinds. There are no implied odds against an all-in opponent.";

/** docs/AI决策改造设计.md §6.1 — shared by every persona, verbatim. */
const SYSTEM_FLOOR = `You are one seat in an 8-max no-limit Texas Hold'em cash game.
EVERY number in this hand is denominated in BIG BLINDS (BB). The blinds are 0.5/1. Stacks, pot,
bets, raise limits and the action history are all BB - there are no chip counts anywhere, so never
rescale them. Your raiseToBB answer is in BB too.
You receive ONLY your own hole cards and public information. Never assume hidden cards.
boardTexture is pre-computed and authoritative: trust it over your own reading of the card codes.

DECISION QUALITY FLOOR — applies to every persona, non-negotiable:
1. Compare equity with price, and use the right price. Estimate your equity vs the ranges
   implied by opponents' actions. potOddsToCall is the equity a call needs POSTFLOP, where the
   pot is already large and few streets remain. It is NOT the test for a preflop cold call: a
   3BB call 100BB deep buys three more streets, so it is paid for by implied odds, position and
   playability, not by immediate odds. Never fold before the flop for the sole reason that
   potOddsToCall exceeds your raw equity — that number does not price a preflop call. There are
   NO implied odds vs an all-in: against a jam the immediate price is the whole story.
2. Calling is a first-class action, not the absence of one. On a healthy table MOST of the
   hands you continue with are calls, not raises: suited aces, suited connectors, small and
   medium pairs and the softer broadways facing a single open are too good to fold and not
   good enough to 3-bet, so they call. Raising every hand you like turns your range into a
   billboard and folds out exactly the hands you beat. If you notice your options have
   collapsed to fold-or-raise, you are misplaying the spot — the call is the missing option.
3. Scale caution to the money at risk, not to a fixed range chart. Entering a pot cheaply is
   a small mistake; putting a large slice of your stack in behind is a big one. Play the range
   your PERSONA calls for, but the deeper the commitment, the stronger your holding must be.
4. Aggression needs a purpose: value bets expect worse hands to call; bluffs need credible
   fold equity plus draws or key blockers. Never jam more than 1.25x pot with neither.
5. Sizing: preflop opens 2.2-4BB (+1BB per limper); 3-bets 2.5-4.5x the open; 4-bets
   2.2-2.8x the 3-bet. Postflop bets 0.33-1.5x pot unless low SPR justifies a jam.
6. Your PERSONA controls only which defensible action you pick and how often - looseness,
   sizing taste, bluff frequency. It never overrides math.
7. Judge a made hand against the board, never against a fixed rank. On paired boards, boards
   with three of a suit, and boards four to a straight, top pair and even two pair are
   bluff-catchers: bet or raise them only when a worse hand can still call, and be ready to
   fold them to heavy action. "Two pair or better" is not a reason to put money in.
A strategy engine audits your decision. If rejected you get the reason and choose again.

OUTPUT: one JSON object only, no prose:
{"handClass":"A8o","planType":"value|semi-bluff|bluff|bluff-catch|pot-control|give-up",
 "estimatedEquity":0.31,"action":"<one of legalActions>","raiseToBB":<total bet size in BB if raise>,
 "reason":"<=140 chars"}`;

type FailReason =
  | "not-configured"
  | "timeout"
  | "provider-error"
  | "illegal-action"
  | "network";

type DecisionSource = "ds" | "ds-retry" | "override";
type GuardrailOutcome = "pass" | "pass-after-retry" | "overridden";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ModelFields {
  handClass: string | null;
  planType: string | null;
  estimatedEquity: number | null;
  reason: string | null;
}

interface GuardrailPayload {
  requiredEquity: number | null;
  engineEquity: number | null;
  assumedRange: string | null;
  verdict: GuardrailOutcome;
  vetoRule?: RuleId;
  detail?: string;
}

const EMPTY_MODEL_FIELDS: ModelFields = {
  handClass: null,
  planType: null,
  estimatedEquity: null,
  reason: null,
};

function clampTrait(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function roundEquity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

/** Client-supplied prompt text: collapse every newline so it cannot forge a new prompt section. */
function flattenPromptText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars).trim();
}

function heroHandCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Client-supplied instruction list: flattened, length-capped, de-duplicated and count-capped. */
function sanitizeDirectives(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    const line = flattenPromptText(entry, HERO_DIRECTIVE_MAX_CHARS);
    if (!line || lines.includes(line)) continue;
    lines.push(line);
    if (lines.length >= HERO_DIRECTIVE_MAX_COUNT) break;
  }
  return lines;
}

/**
 * CONTRACT-V2 §三 / CONTRACT-V3 §二.4 — the human's observed frequencies plus the exploit
 * instructions derived from them, injected ahead of PERSONA so every seat can use them.
 * Returns null (no block at all) when the profile is missing, empty or unsampled.
 *
 * The closing sample-size caution is not decoration: models handed opponent statistics
 * over-adjust off tiny samples, and this block is the only place in the prompt where such
 * statistics appear.
 */
function buildHeroRead(
  profile: RequestBody["heroProfile"],
  position: RequestBody["heroPosition"],
): string | null {
  const text = flattenPromptText(profile?.text, HERO_READ_MAX_CHARS);
  const seat = flattenPromptText(position, HERO_POSITION_MAX_CHARS);
  const directives = sanitizeDirectives(profile?.directives);
  if ((!text && directives.length === 0) || !seat) return null;
  return [
    `HERO READ (the human player is in seat ${seat}; these are observed public frequencies ` +
      `over ${heroHandCount(profile?.handsDealt)} hands):`,
    ...(text ? [text] : []),
    ...directives.map((line) => `- ${line}`),
    "Exploit these leaks when the spot allows it. They describe only that one seat — " +
      "every other seat is an AI.",
    "Sample sizes are small; treat these as tendencies, not certainties.",
  ].join("\n");
}

/** Legality gate: action must be in legalActions, raise sizes clamped into the legal band. */
function sanitizeDecision(value: unknown, observation: BotObservation): BotDecision | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { action?: ActionKind; raiseToBB?: number; raiseTo?: number };
  if (!candidate.action || !observation.legalActions.includes(candidate.action)) return null;
  if (candidate.action !== "raise") return { action: candidate.action };
  // The model answers in big blinds; `raiseTo` is accepted as a legacy alias and read the same way.
  const stated = typeof candidate.raiseToBB === "number" ? candidate.raiseToBB : candidate.raiseTo;
  const chips =
    typeof stated === "number" && Number.isFinite(stated)
      ? stated * bigBlind(observation)
      : undefined;
  return { action: "raise", raiseTo: clampRaiseTo(chips, observation) };
}

function clampRaiseTo(value: unknown, observation: BotObservation): number {
  const floor = Number.isFinite(observation.minimumRaiseTo) ? observation.minimumRaiseTo : 0;
  const ceiling = Number.isFinite(observation.maximumRaiseTo)
    ? observation.maximumRaiseTo
    : observation.streetBet + observation.stack;
  const desired = Math.round(Number(value) || floor);
  return Math.max(floor, Math.min(ceiling, desired));
}

/** Model reasoning fields are advisory: anything missing or malformed becomes null, never a failure. */
function extractModelFields(value: unknown): ModelFields {
  if (!value || typeof value !== "object") return EMPTY_MODEL_FIELDS;
  const candidate = value as Record<string, unknown>;
  const rawHandClass = candidate.handClass;
  const rawPlanType = candidate.planType;
  const rawReason = candidate.reason;
  const handClass =
    typeof rawHandClass === "string" && rawHandClass.trim()
      ? rawHandClass.trim().slice(0, HAND_CLASS_MAX_CHARS)
      : null;
  const planType =
    typeof rawPlanType === "string" && PLAN_TYPE_SET.has(rawPlanType.trim())
      ? rawPlanType.trim()
      : null;
  const estimatedEquity =
    typeof candidate.estimatedEquity === "number" && Number.isFinite(candidate.estimatedEquity)
      ? Math.min(1, Math.max(0, candidate.estimatedEquity))
      : null;
  const reason =
    typeof rawReason === "string" && rawReason.trim()
      ? rawReason.trim().slice(0, REASON_MAX_CHARS)
      : null;
  return { handClass, planType, estimatedEquity, reason };
}

/** The guardrail is allowed to be missing or to throw (parallel implementation) — fail open. */
function safeCheckDecision(
  observation: BotObservation,
  persona: PersonaTraits,
  decision: BotDecision,
): GuardrailVerdict {
  try {
    const verdict = checkDecision(observation, persona, decision) as GuardrailVerdict | undefined;
    if (!verdict || typeof verdict !== "object") return { ok: true };
    return verdict;
  } catch {
    return { ok: true };
  }
}

function safeHandClass(holeCards: string[]): string | null {
  try {
    const hint = describeHandClass(holeCards);
    return typeof hint === "string" && hint ? hint : null;
  } catch {
    return null;
  }
}

function fallbackSafeAction(observation: BotObservation): BotDecision {
  const legal = observation.legalActions;
  const preference: ActionKind[] = ["check", "fold", "call"];
  for (const action of preference) {
    if (legal.includes(action)) return { action };
  }
  return legal.length > 0 ? { action: legal[0] } : { action: "fold" };
}

function safeSuggestAction(observation: BotObservation, persona: PersonaTraits): BotDecision {
  try {
    const suggestion = suggestSafeAction(observation, persona) as BotDecision | undefined;
    const legal = suggestion && sanitizeDecision(suggestion, observation);
    if (legal) return legal;
  } catch {
    // Fall through to the local conservative pick.
  }
  return fallbackSafeAction(observation);
}

function applyClamp(decision: BotDecision, verdict: GuardrailVerdict, observation: BotObservation): BotDecision {
  if (decision.action !== "raise") return decision;
  if (typeof verdict.clampedRaiseTo !== "number" || !Number.isFinite(verdict.clampedRaiseTo)) {
    return decision;
  }
  return { action: "raise", raiseTo: clampRaiseTo(verdict.clampedRaiseTo, observation) };
}

/** docs/AI决策改造设计.md §4.4 — the rejection turn appended before the single retry. */
function buildVetoRejection(verdict: GuardrailVerdict): string {
  const numbers = verdict.numbers;
  return JSON.stringify({
    verdict: "rejected",
    violation: {
      rule: verdict.rule ?? null,
      requiredEquity: numbers ? roundEquity(numbers.requiredEquity) : null,
      engineEstimatedEquity: numbers ? roundEquity(numbers.engineEquity) : null,
      assumedVillainRange: numbers?.assumedRange ?? null,
      note: verdict.detail ?? "The proposed action violates the decision quality floor.",
    },
    instruction: RETRY_INSTRUCTION,
  });
}

function buildFormatRejection(note: string, legalActions: ActionKind[]): string {
  return JSON.stringify({
    verdict: "rejected",
    violation: { rule: "OUTPUT-FORMAT", note, legalActions },
    instruction: FORMAT_RETRY_INSTRUCTION,
  });
}

interface ProviderResult {
  content: string | null;
  failure: FailReason | null;
}

function classifyFetchError(error: unknown): FailReason {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

async function callProvider(options: {
  apiBase: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  timeoutMs: number;
  disableThinking: boolean;
}): Promise<ProviderResult> {
  try {
    const response = await fetch(`${options.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature,
        max_tokens: MAX_TOKENS,
        ...(options.disableThinking ? { thinking: { type: "disabled" } } : {}),
        response_format: { type: "json_object" },
        messages: options.messages,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return { content: null, failure: "provider-error" };
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      return { content: null, failure: "provider-error" };
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { content: null, failure: "provider-error" };
    }
    return { content, failure: null };
  } catch (error) {
    return { content: null, failure: classifyFetchError(error) };
  }
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Salvage an object wrapped in prose or code fences before spending the retry budget.
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildGuardrail(
  outcome: GuardrailOutcome,
  numbersSource: GuardrailVerdict | null,
  vetoSource: GuardrailVerdict | null,
  formatDetail: string | null,
): GuardrailPayload {
  const numbers = numbersSource?.numbers;
  const payload: GuardrailPayload = {
    requiredEquity: numbers ? roundEquity(numbers.requiredEquity) : null,
    engineEquity: numbers ? roundEquity(numbers.engineEquity) : null,
    assumedRange: typeof numbers?.assumedRange === "string" ? numbers.assumedRange : null,
    verdict: outcome,
  };
  if (vetoSource?.rule) payload.vetoRule = vetoSource.rule;
  const detail = vetoSource?.detail ?? formatDetail;
  if (detail) payload.detail = detail;
  return payload;
}

function decisionResponse(
  decision: BotDecision,
  source: DecisionSource,
  model: ModelFields,
  guardrail: GuardrailPayload,
) {
  return NextResponse.json({
    action: decision.action,
    raiseTo: decision.action === "raise" ? decision.raiseTo ?? null : null,
    source,
    model,
    guardrail,
  });
}

function failure(status: number, error: string, failReason: FailReason) {
  return NextResponse.json({ error, failReason }, { status });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const browserApiKey = body.api?.apiKey?.trim();
    const browserModel = body.api?.model?.trim();
    const useBrowserDeepSeek = Boolean(
      browserApiKey && browserModel && ALLOWED_DEEPSEEK_MODELS.has(browserModel),
    );
    const apiKey = useBrowserDeepSeek ? browserApiKey : process.env.AI_API_KEY;
    const model = useBrowserDeepSeek ? browserModel : process.env.AI_MODEL;
    const apiBase = useBrowserDeepSeek
      ? DEEPSEEK_API_BASE
      : (process.env.AI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    if (!apiKey || !model) {
      return failure(503, "AI API is not configured", "not-configured");
    }
    const observation = body.observation;
    if (
      !observation ||
      !Array.isArray(observation.holeCards) ||
      !Array.isArray(observation.legalActions) ||
      observation.holeCards.length !== 2
    ) {
      return NextResponse.json({ error: "Invalid observation" }, { status: 400 });
    }

    const personaTraits: PersonaTraits = {
      id: body.persona?.id?.trim() || "unknown",
      looseness: clampTrait(body.persona?.looseness),
      aggression: clampTrait(body.persona?.aggression),
      bluff: clampTrait(body.persona?.bluff),
    };

    // HERO READ, then the two dynamics blocks, all between the floor and PERSONA. With nothing
    // injected the assembled prompt is byte-identical to the floor + PERSONA pair alone.
    const heroRead = buildHeroRead(body.heroProfile, body.heroPosition);
    const calibration = flattenPromptText(body.selfCalibration, DYNAMICS_MAX_CHARS);
    const tableReadText = flattenPromptText(body.tableRead, DYNAMICS_MAX_CHARS);
    const system = [
      SYSTEM_FLOOR,
      ...(heroRead ? [heroRead] : []),
      ...(calibration ? [`FREQUENCY CHECK: ${calibration}`] : []),
      ...(tableReadText ? [`TABLE READ: ${tableReadText}`] : []),
      `PERSONA: ${body.persona?.prompt || "Play a coherent poker strategy."}`,
    ].join("\n\n");

    const userMessage = JSON.stringify({
      persona: body.persona?.title,
      units: "every amount below is in big blinds (BB)",
      observation: bigBlindView(observation),
      handClassHint: safeHandClass(observation.holeCards),
      note: POT_ODDS_NOTE,
      outputSchema: {
        handClass: "string, e.g. A8o / TT",
        planType: PLAN_TYPES,
        estimatedEquity: "number between 0 and 1",
        action: observation.legalActions,
        raiseToBB: "number in big blinds, required only when action is raise",
        reason: `string, <=${REASON_MAX_CHARS} chars`,
      },
    });

    const baseMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ];
    const disableThinking = useBrowserDeepSeek && process.env.AI_THINKING !== "1";
    const provider = { apiBase, apiKey, model, disableThinking };

    const first = await callProvider({
      ...provider,
      messages: baseMessages,
      temperature: FIRST_TEMPERATURE,
      timeoutMs: FIRST_TIMEOUT_MS,
    });

    // No usable first answer: only a provider-side HTTP/body failure earns a second attempt.
    if (!first.content) {
      if (first.failure === "timeout") {
        return failure(502, "AI decision timed out", "timeout");
      }
      if (first.failure === "network") {
        return failure(502, "AI provider unreachable", "network");
      }
      const repeat = await callProvider({
        ...provider,
        messages: baseMessages,
        temperature: RETRY_TEMPERATURE,
        timeoutMs: RETRY_TIMEOUT_MS,
      });
      if (!repeat.content) {
        const reason: FailReason = repeat.failure ?? "provider-error";
        const message =
          reason === "timeout"
            ? "AI decision timed out"
            : reason === "network"
              ? "AI provider unreachable"
              : "Provider rejected decision";
        return failure(502, message, reason);
      }
      const repeatParsed = parseContent(repeat.content);
      const repeatFields = extractModelFields(repeatParsed);
      const repeatDecision = sanitizeDecision(repeatParsed, observation);
      if (repeatDecision) {
        const verdict = safeCheckDecision(observation, personaTraits, repeatDecision);
        if (verdict.ok) {
          return decisionResponse(
            applyClamp(repeatDecision, verdict, observation),
            "ds-retry",
            repeatFields,
            buildGuardrail("pass-after-retry", verdict, null, null),
          );
        }
        return decisionResponse(
          safeSuggestAction(observation, personaTraits),
          "override",
          repeatFields,
          buildGuardrail("overridden", verdict, verdict, null),
        );
      }
      return decisionResponse(
        safeSuggestAction(observation, personaTraits),
        "override",
        repeatFields,
        buildGuardrail("overridden", null, null, "Provider returned no legal action after two attempts."),
      );
    }

    const firstParsed = parseContent(first.content);
    const firstFields = extractModelFields(firstParsed);
    const firstDecision = sanitizeDecision(firstParsed, observation);
    let firstVeto: GuardrailVerdict | null = null;
    let formatDetail: string | null = null;
    let rejection: string;

    if (firstDecision) {
      const verdict = safeCheckDecision(observation, personaTraits, firstDecision);
      if (verdict.ok) {
        return decisionResponse(
          applyClamp(firstDecision, verdict, observation),
          "ds",
          firstFields,
          buildGuardrail("pass", verdict, null, null),
        );
      }
      firstVeto = verdict;
      rejection = buildVetoRejection(verdict);
    } else {
      const parsedObject = Boolean(firstParsed) && typeof firstParsed === "object";
      formatDetail = parsedObject
        ? "Model chose an action outside legalActions."
        : "Model output was not valid JSON.";
      rejection = buildFormatRejection(
        parsedObject
          ? "Your previous reply chose an action that is not in legalActions."
          : "Your previous reply was not a valid JSON object matching the required schema.",
        observation.legalActions,
      );
    }

    // ONE retry: original system + original user + the model's raw answer + the rejection turn.
    const retry = await callProvider({
      ...provider,
      messages: [
        ...baseMessages,
        { role: "assistant", content: first.content },
        { role: "user", content: rejection },
      ],
      temperature: RETRY_TEMPERATURE,
      timeoutMs: RETRY_TIMEOUT_MS,
    });

    let retryFields: ModelFields | null = null;
    if (retry.content) {
      const retryParsed = parseContent(retry.content);
      retryFields = extractModelFields(retryParsed);
      const retryDecision = sanitizeDecision(retryParsed, observation);
      if (retryDecision) {
        const verdict = safeCheckDecision(observation, personaTraits, retryDecision);
        if (verdict.ok) {
          return decisionResponse(
            applyClamp(retryDecision, verdict, observation),
            "ds-retry",
            retryFields,
            buildGuardrail("pass-after-retry", firstVeto ?? verdict, firstVeto, formatDetail),
          );
        }
      }
    }

    return decisionResponse(
      safeSuggestAction(observation, personaTraits),
      "override",
      retryFields ?? firstFields,
      buildGuardrail("overridden", firstVeto, firstVeto, formatDetail),
    );
  } catch {
    return failure(502, "AI decision failed", "provider-error");
  }
}
