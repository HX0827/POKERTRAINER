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
  /** 齿轮面板里的深度思考开关。只在翻后生效——翻前永远快答。缺省视为开。 */
  deepThink?: boolean;
}

const DEEPSEEK_API_BASE = "https://api.deepseek.com";
const ALLOWED_DEEPSEEK_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

// 340 字符的理由 + JSON 其余字段,700 tokens 依然宽裕;上限太紧会把 JSON 本身切坏,
// 那比理由被截更糟——整个决策都要重问。
const MAX_TOKENS = 700;
// 思考要设预算:不设的话模型高兴起来想上几千 token,一个决策十几秒,牌桌等不起。
// 800 token 足够把"牌面上有没有人打得过我"这类事想明白——要的是不读错牌,不是解 GTO。
const THINKING_BUDGET_TOKENS = 800;
// 思考模式下思考 token 计入 max_tokens,而 budget_tokens 疑似被 API 忽略(实测思考
// 跑长后返回 200 + 空 content,正是"额度被思考吃光"的症状)。给到 8000:思考再长
// 也轮得到答案落地,按实际生成计费,不吃亏。真正的延迟上限由超时和耐心档管。
const MAX_TOKENS_THINKING = 8000;
const FIRST_TEMPERATURE = 0.45;
const RETRY_TEMPERATURE = 0.2;
// 教训:bench-ai.mjs 第一版每轮发相同提示词,命中服务端缓存,得出"思考 0.2 秒"的
// 假结论;think-relay 的日志才是真相——真实(不重复的)牌局提示词,思考生成要
// 6~20 秒,传输从来不是瓶颈。所以:思考只留给大决策,一次机会,25 秒封顶,像真人
// tank 大池子;小池子直接快答,不再白等。
const PATIENT_THINK_TIMEOUT_MS = 25000;
const FIRST_TIMEOUT_FAST_MS = 5000;
const RETRY_TIMEOUT_FAST_MS = 3500;
// 思考一律用 Flash,不管齿轮里选的什么:思考的用途只是"牌面上谁打得过我"这类
// 基础验算,Flash 的推理够用,而延迟只有 Pro 思考的一小半——对冲延迟才敢收到 4 秒。
// 快答/翻前/重问仍然用玩家选的模型,人格和语感不变。
const THINKING_MODEL = "deepseek-v4-flash";
// 思考请求不直连 DeepSeek,走本机 Node 中继(scripts/think-relay.mjs,启动器负责拉起):
// workerd 直连拿思考回复时响应体会挂死(流式限速、非流式不吐,实测),Node 的 fetch
// 却 0.2 秒拿全文。中继只听回环地址;不在线时请求秒失败,重发逻辑自然落回快答。
const THINK_RELAY_BASE = process.env.THINK_RELAY_URL || "http://127.0.0.1:3210";
// 大决策多给一次思考重发:底池或面对的注到了这个量级,决策质量比一两秒等待重要——
// H#0018 一个 157BB 的池子四个决策全是快答,这不该发生。
const BIG_POT_THINK_BB = 50;
const BIG_CALL_THINK_BB = 20;
// 牌谱里 AI 的理由整句保留才有复盘价值。以前是 140,模型稍一展开就被拦腰切断
// ("reverse implied od")。340 够写三四句完整的英文;真超了由 clampReason 在词界收尾。
const REASON_MAX_CHARS = 340;
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
    typeof rawReason === "string" && rawReason.trim() ? clampReason(rawReason.trim()) : null;
  return { handClass, planType, estimatedEquity, reason };
}

/**
 * A reason over the limit is cut at the last word boundary and marked with an ellipsis —
 * never mid-word ("reverse implied od"). 中文没有空格,词界找不到或太靠前就按原样硬切。
 */
function clampReason(text: string): string {
  if (text.length <= REASON_MAX_CHARS) return text;
  const cut = text.slice(0, REASON_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > REASON_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
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
  /** 这条内容是深度思考给出的吗?对冲之后快答经常赢,牌谱要能看出每个决策的成色。 */
  thought?: boolean;
  /** 服务端错误正文片段。只进终端日志帮人排障,不进牌局。 */
  detail?: string;
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
  // 失败时标记挂在哪个阶段:connect = fetch 头都没回来(连接/服务端问题);
  // read-body = 头回来了但响应体收不完(流不关门)。下次看日志一眼定位。
  let phase = "connect";
  try {
    const response = await fetch(`${options.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        // 思考流禁用压缩:gzip 会把小流量攒在压缩缓冲里不吐,凑不满就一直"有货不发",
        // 正是 hung at read-body 的典型成因之一。identity = 字节即产即到。
        ...(options.disableThinking ? {} : { "Accept-Encoding": "identity" }),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature,
        max_tokens: options.disableThinking ? MAX_TOKENS : MAX_TOKENS_THINKING,
        // 一律非流式。之前思考请求 hung at read-body 的元凶是压缩缓冲(gzip 攒着
        // 不吐),上面的 Accept-Encoding: identity 才是真正的解;流式反而更糟——
        // 这个 API 的 SSE 推送限速,思考增量要流好几秒,答案永远在最后。
        stream: false,
        ...(options.disableThinking
          ? { thinking: { type: "disabled" } }
          : {
              thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS },
              // budget_tokens 实测被忽略;再补一道 OpenAI 风格的档位参数。API 不认识
              // 就会当没看见,认识就能把思考砍短一大截。
              reasoning_effort: "low",
            }),
        response_format: { type: "json_object" },
        messages: options.messages,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    phase = "read-body";
    if (!response.ok) {
      // 错误正文进终端:思考参数被拒、模型名不对这类问题,不看正文永远猜不到。
      const errorBody = (await response.text().catch(() => "")).slice(0, 300);
      console.warn(
        `[decision] provider ${response.status} (${options.model}${options.disableThinking ? "" : " +thinking"}): ${errorBody}`,
      );
      return { content: null, failure: "provider-error", detail: errorBody };
    }
    const raw = await response.text();
    let data: {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
      usage?: unknown;
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      // 不是 JSON:先当 SSE 流拼一把,拼出来照用;拼不出来把正文开头晒进日志。
      const salvaged = salvageStreamContent(raw);
      if (salvaged) return { content: salvaged, failure: null, thought: !options.disableThinking };
      console.warn(
        `[decision] provider 返回非 JSON,也不是可解析的流 (${options.model}${options.disableThinking ? "" : " +thinking"}): ${raw.slice(0, 200)}`,
      );
      return { content: null, failure: "provider-error", detail: "non-json body" };
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      // 200 + 空内容:大概率是思考吃光了 max_tokens(finish=length),这行日志能证实。
      const reasoningLen = String(choice?.message?.reasoning_content ?? "").length;
      console.warn(
        `[decision] provider 空内容 (${options.model}${options.disableThinking ? "" : " +thinking"}): finish=${choice?.finish_reason ?? "?"} 思考文本=${reasoningLen}字 usage=${JSON.stringify(data.usage ?? null)}`,
      );
      return {
        content: null,
        failure: "provider-error",
        detail: `empty content, finish=${choice?.finish_reason ?? "?"}`,
      };
    }
    return { content, failure: null, thought: !options.disableThinking };
  } catch (error) {
    return { content: null, failure: classifyFetchError(error), detail: `hung at ${phase}` };
  }
}



/**
 * 把 SSE 流(`data: {...}` 行)拼回完整内容。思考请求实测会拿到 200 + 流式正文,
 * 即使请求里写了 stream: false 也可能如此。只取 content 增量,思考文本(reasoning)
 * 本来就不需要;解析不动的行直接跳过,拼不出内容返回 null,由调用方决定去留。
 */
function salvageStreamContent(raw: string): string | null {
  let text = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const piece = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
      if (typeof piece === "string") text += piece;
    } catch {
      // 坏行跳过:拼回内容是尽力而为,不值得为一行日志中断整个决策。
    }
  }
  const result = text.trim();
  return result ? result : null;
}

/** Resolve with the first result that carries content; if none does, with the last failure. */
/** 大池子、大注、或跟注等于全下:值得多给一次重发机会的决策。 */
function isBigDecision(observation: BotObservation): boolean {
  const bb = observation.blinds?.bigBlind || 2;
  return (
    observation.pot >= BIG_POT_THINK_BB * bb ||
    observation.toCall >= BIG_CALL_THINK_BB * bb ||
    (observation.toCall > 0 && observation.toCall >= observation.stack)
  );
}

/**
 * 大决策的思考请求:一次机会,走本机中继,25 秒封顶——真实提示词的思考生成要
 * 6~20 秒(见 think-relay 日志),这是生成速度,不是故障,等它就是像真人 tank。
 * 失败(挂死/出错)落到快答;快答再失败,调用方的老逻辑一路兜到本地引擎。
 */
async function patientThinkingCall(
  provider: { apiBase: string; apiKey: string; model: string },
  messages: ChatMessage[],
  temperature: number,
): Promise<ProviderResult> {
  // budget_tokens 和 reasoning_effort 都被 API 无视,这句软约束是唯一能压思考
  // 长度的手段,同时让理由聚焦在要紧的验算上。
  const thinkingMessages = messages.map((message, index) =>
    index === 0 && message.role === "system"
      ? {
          ...message,
          content: `${message.content}\n\nKeep your hidden reasoning SHORT (well under 200 words): verify what hands beat yours on this board, check the pot odds, then decide. No range combinatorics.`,
        }
      : message,
  );
  const startedAt = Date.now();
  // 快答从第一秒就并行候着(几十个 token 的成本):思考成了它作废,思考撞上
  // 长尾超时就零额外等待地顶上——绝不再出现"白等 25 秒还要再等快答"的双重折磨。
  const fallback = callProvider({
    ...provider,
    disableThinking: true,
    messages,
    temperature,
    timeoutMs: PATIENT_THINK_TIMEOUT_MS,
  });
  const result = await callProvider({
    ...provider,
    apiBase: THINK_RELAY_BASE,
    model: THINKING_MODEL,
    disableThinking: false,
    messages: thinkingMessages,
    temperature,
    timeoutMs: PATIENT_THINK_TIMEOUT_MS,
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.content) {
    console.log(`[decision] 深思完成 ${seconds}s (大决策)`);
    return result;
  }
  console.warn(
    `[decision] 大决策思考未产出 (${result.failure ?? "unknown"}) ${seconds}s${result.detail ? `: ${result.detail}` : ""}`,
  );
  return fallback;
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
  /** 最终采纳的那条内容是否出自深度思考。override(本地替换)一律 false。 */
  thinking: boolean,
) {
  return NextResponse.json({
    action: decision.action,
    raiseTo: decision.action === "raise" ? decision.raiseTo ?? null : null,
    source,
    model,
    guardrail,
    thinking,
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
    // 思考只开在翻后。翻前决策真人几乎不假思索(垃圾牌直接扔),而且翻前没有牌面
    // 可读错——handClassHint 已经替模型认好了手牌;读牌错乱(把 Ax 当价值目标)全发生
    // 在翻后,那里才值得让模型先想再答。齿轮面板的 deepThink 开关可整体关掉思考,
    // AI_THINKING=0 是服务端的总闸。
    // 思考只留给大决策(大池子/大注/全下跟注):真实思考生成要 6~20 秒,小决策
    // 等不起也不值得,直接快答。翻前永远快答;齿轮开关关掉则全部快答。
    const wantThinking =
      process.env.AI_THINKING !== "0" &&
      body.deepThink !== false &&
      observation.street !== "preflop" &&
      isBigDecision(observation);
    // 重问一律快答,不管首问走的哪档:重问是在纠错格式/非法动作,不值得再想一遍。
    const provider = { apiBase, apiKey, model, disableThinking: true };
    const retryTimeoutMs = RETRY_TIMEOUT_FAST_MS;

    const first = wantThinking
      ? await patientThinkingCall({ apiBase, apiKey, model }, baseMessages, FIRST_TEMPERATURE)
      : await callProvider({
          ...provider,
          messages: baseMessages,
          temperature: FIRST_TEMPERATURE,
          timeoutMs: FIRST_TIMEOUT_FAST_MS,
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
        timeoutMs: retryTimeoutMs,
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
            Boolean(repeat.thought),
          );
        }
        return decisionResponse(
          safeSuggestAction(observation, personaTraits),
          "override",
          repeatFields,
          buildGuardrail("overridden", verdict, verdict, null),
          false,
        );
      }
      return decisionResponse(
        safeSuggestAction(observation, personaTraits),
        "override",
        repeatFields,
        buildGuardrail("overridden", null, null, "Provider returned no legal action after two attempts."),
        false,
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
          Boolean(first.thought),
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
      timeoutMs: retryTimeoutMs,
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
            Boolean(retry.thought),
          );
        }
      }
    }

    return decisionResponse(
      safeSuggestAction(observation, personaTraits),
      "override",
      retryFields ?? firstFields,
      buildGuardrail("overridden", firstVeto, firstVeto, formatDetail),
      false,
    );
  } catch {
    return failure(502, "AI decision failed", "provider-error");
  }
}
