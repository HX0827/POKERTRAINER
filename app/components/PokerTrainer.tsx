"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionKind,
  BIG_BLIND,
  Card,
  GameState,
  Player,
  TABLE_TIERS,
  amountBB,
  applyAction,
  botObservation,
  cardCode,
  cardLabel,
  compactHandLog,
  heroEvSummary,
  isRed,
  legalActions,
  localBotDecision,
  markdownLog,
  parseSavedGame,
  resolveTier,
  serializeGame,
  startHand,
  totalPot,
  type TableTier,
} from "../lib/poker";
import {
  checkDecision,
  suggestSafeAction,
  type BotDecision,
  type PersonaTraits,
} from "../lib/strategy";
import {
  EMPTY_HERO_COUNTERS,
  exploitDirectives,
  heroCountersForHand,
  mergeHeroCounters,
  summarizeHeroProfile,
  type HeroCounters,
  type HeroProfileSummary,
} from "../lib/heroProfile";
import {
  EMPTY_SEAT_DYNAMICS,
  EMPTY_TABLE_DYNAMICS,
  dynamicsForHand,
  mergeTableDynamics,
  selfCalibration,
  tableRead,
  type TableDynamics,
} from "../lib/tableDynamics";

interface StoredHand {
  id: number;
  handId: string;
  markdown: string;
  resultBb: number;
  evBb: number | null;
  luckBb: number | null;
  evMethod: string | null;
  createdAt: string;
}

interface BrowserApiSettings {
  apiKey: string;
  model: "deepseek-v4-pro" | "deepseek-v4-flash";
}

type ApiConnectionState = "idle" | "testing" | "connected" | "error";

/** Honest provenance of a single AI action — docs/AI决策改造设计.md §7.1. */
type ActionSource = "ds" | "ds-retry" | "override" | "local-fallback" | "local-engine";

/** Health of the decision pipeline as shown in the top-bar chip (§7.3). */
type ApiHealth = "connected" | "degraded" | "local";

interface DecisionRecord {
  actionIndex: number;
  playerId: string;
  position: string;
  street: string;
  /** The action originally proposed before any guardrail replacement. */
  kind: string;
  /** The action that actually reached the table, with size when relevant. */
  finalLabelHint: string;
  source: ActionSource;
  rule?: string;
  failReason?: string;
  /**
   * The model's own explanation. Post-hand inspection only — rendering it while the hand is
   * live would leak the opponent's intent and destroy the training value (§7.3).
   */
  reason?: string | null;
  /** 这条决策出自深度思考吗?对冲之后快答经常赢,复盘时要能分辨每个决策的成色。 */
  thought?: boolean;
}

interface DecisionResponse {
  action?: ActionKind;
  raiseTo?: number | null;
  source?: ActionSource;
  model?: {
    handClass?: string | null;
    planType?: string | null;
    estimatedEquity?: number | null;
    reason?: string | null;
  } | null;
  guardrail?: {
    requiredEquity?: number | null;
    engineEquity?: number | null;
    assumedRange?: string | null;
    verdict?: string;
    vetoRule?: string;
    detail?: string;
  } | null;
  thinking?: boolean;
}

const API_STORAGE_KEY = "mist-table-deepseek-settings-v1";
const REVEAL_STORAGE_KEY = "mist-table-reveal-all-v1";
/** 深度思考开关(只作用于翻后;翻前路由永远走快答)。默认开。 */
const DEEPTHINK_STORAGE_KEY = "mist-table-deepthink-v1";
const TIER_STORAGE_KEY = "mist-table-tier-v1";
/** 整份牌局状态:刷新/重开页面原样接上,打到一半也不例外。重置对局或清空记录时作废。 */
const GAME_STORAGE_KEY = "mist-table-game-v1";
/** 上一版只存两手之间的快照,已被整份状态取代;发现就顺手删掉。 */
const LEGACY_PROGRESS_KEY = "mist-table-progress-v1";
/**
 * How many finished hands the rolling behavioural window keeps (CONTRACT-V3 §一/§三.4).
 * Long enough for `selfCalibration`'s 8-hand floor to mean something, short enough that a seat
 * that has genuinely changed gear is not judged on a session-old sample.
 */
const DYNAMICS_WINDOW = 25;
/** Hero 输光后的自动重买额度,固定值——加码走 Add-on,不跟这个搅在一起。 */
const DEFAULT_HERO_REBUY_BB = 100;
/**
 * Exploit instructions handed to the AIs, by tier. A casual table is not supposed to be
 * reading the human at all; a tough one gets everything `exploitDirectives` will produce.
 */
const DIRECTIVE_LIMITS: Record<"light" | "normal" | "hard", number> = {
  light: 1,
  normal: 3,
  hard: 5,
};
/** Client-side ceiling; the route's worst path is a big-decision one (思考 25s + 快答 5s + 重问 3.5s ≈ 33.5s), so this only catches a hung socket. */
const DECISION_TIMEOUT_MS = 36000;
/** Provenance is kept for the current hand plus this many previous hands, then pruned. */
const KEPT_HAND_HISTORY = 2;
/** Persona-modal footer tallies at most this many of the most recent AI actions. */
const TALLY_WINDOW = 100;
const MAX_SUFFIX_DETAILS = 2;

/** 翻后：按底池比例。底池够大时这 11 档各不相同，是有意义的尺度。 */
const POT_PRESETS = [0.2, 0.25, 0.33, 0.5, 0.66, 0.75, 0.8, 1, 1.25, 1.5, 2];

/**
 * 翻前：按当前注的倍数。
 *
 * 翻前底池只有 1.5BB，用底池比例会全部挤在一起——33% 正好等于最小加注，
 * 50% 和 66% 算出同一个数，75% 和 80% 也是同一个数。真实扑克翻前本来就不按底池算，
 * 说的是「开到 2.5 倍」「3-bet 到 3 倍」「4-bet 到 2.5 倍」，倍数才是这条街的原生单位。
 * 覆盖范围：开池 2-4x、3-bet 2.5-4.5x、4-bet 2.2-2.8x。
 */
const MULTIPLE_PRESETS = [2, 2.2, 2.5, 2.8, 3, 3.5, 4, 4.5, 5, 6, 8];

/**
 * 「加注到底池的 X%」的正确算法。
 *
 * 面对一个下注时，你要先跟掉 toCall，底池才变成 pot + toCall，再按比例加注——
 * 所以 raiseTo = currentBet + size × (pot + toCall)。原来的写法漏了 toCall，
 * 于是在有人下注时，标着「100%」的按钮实际只打出约 75% 底池。
 * 无人下注时 toCall = 0，退化成「下注 X% 底池」，与直觉一致。
 */
function potRelativeRaiseTo(size: number, pot: number, currentBet: number, toCall: number): number {
  return Math.round(currentBet + size * (pot + toCall));
}

/**
 * 翻前的「加注到 N 倍」。倍数是对**当前注**取的，不做任何隐藏调整——
 * 有 limper 时标准开池是「3 倍再每人加 1BB」，但那要靠滑块自己补：
 * 按钮上写 3x 就必须正好是 3 倍，否则又变成按钮说谎。
 */
function multipleRaiseTo(multiple: number, currentBet: number): number {
  return Math.round(currentBet * multiple);
}

const STREET_LETTERS: Record<string, string> = {
  preflop: "PF",
  flop: "F",
  turn: "T",
  river: "R",
  showdown: "SD",
};

function emptySourceCounts(): Record<ActionSource, number> {
  return { ds: 0, "ds-retry": 0, override: 0, "local-fallback": 0, "local-engine": 0 };
}

function countSources(records: DecisionRecord[]): Record<ActionSource, number> {
  const counts = emptySourceCounts();
  records.forEach((record) => {
    counts[record.source] += 1;
  });
  return counts;
}

/** `AbortSignal.timeout` rejects with a TimeoutError; a manual abort surfaces as AbortError. */
function isAbortError(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Idempotent by action index: React may invoke a state updater more than once (StrictMode,
 * eager evaluation), and the same action must never be counted twice.
 */
function pushDecisionRecord(
  store: Map<number, DecisionRecord[]>,
  handNo: number,
  entry: DecisionRecord,
): void {
  const existing = store.get(handNo);
  if (!existing) {
    store.set(handNo, [entry]);
    return;
  }
  if (existing.some((record) => record.actionIndex === entry.actionIndex)) return;
  existing.push(entry);
}

function pruneDecisionRecords(store: Map<number, DecisionRecord[]>, currentHandNo: number): void {
  const oldestKept = currentHandNo - KEPT_HAND_HISTORY;
  Array.from(store.keys()).forEach((handNo) => {
    if (handNo < oldestKept) store.delete(handNo);
  });
}

function orderedRecords(records: DecisionRecord[]): DecisionRecord[] {
  return [...records].sort((left, right) => left.actionIndex - right.actionIndex);
}

/** `F LJ POST-JAM-EQUITY` (override) or `T BB timeout` (local fallback). */
function sourceDetail(record: DecisionRecord): string {
  const street = STREET_LETTERS[record.street] ?? record.street.toUpperCase();
  const cause = record.source === "override" ? record.rule : record.failReason;
  return [street, record.position, cause].filter(Boolean).join(" ");
}

/** `DS:9 RT:1 OV:1(F LJ POST-JAM-EQUITY) LF:0` — appended to the hand log line (§7.2). */
function buildSourceSuffix(records: DecisionRecord[]): string {
  if (records.length === 0) return "";
  const ordered = orderedRecords(records);
  const counts = countSources(ordered);
  const details = (source: ActionSource): string => {
    const matches = ordered.filter((record) => record.source === source);
    if (matches.length === 0) return "";
    const shown = matches.slice(0, MAX_SUFFIX_DETAILS).map(sourceDetail).join(", ");
    return `(${shown}${matches.length > MAX_SUFFIX_DETAILS ? "…" : ""})`;
  };
  const parts = [
    `DS:${counts.ds}`,
    `RT:${counts["ds-retry"]}`,
    `OV:${counts.override}${details("override")}`,
    `LF:${counts["local-fallback"]}${details("local-fallback")}`,
  ];
  if (counts["local-engine"] > 0) parts.push(`LG:${counts["local-engine"]}`);
  // 深度思考给出的决策数。对冲机制下快答经常赢,这个数字告诉你本手 AI 的"认真程度"。
  const thoughtful = ordered.filter((record) => record.thought).length;
  parts.push(`TH:${thoughtful}`);
  return parts.join(" ");
}

/**
 * 每个 AI 自己说的行动理由，按行动顺序排好，一条一个元素：
 * `PF UTG+1 钱老板 open to 3BB — KQs 在中位，先开池施压`
 *
 * 这是模型的想法唯一被持久化的地方——牌局一滚出 provenance ref 就没了。以前这里砍了两刀：
 * 每条截到 72 字（模型本来就只被允许写 140 字，等于一半直接扔掉），每手最多 12 条（400 手
 * 模拟里每一手的 AI 决策数都远超 12，也就是说每手都在丢）。两刀都是白扔已经拿到手的信息，
 * 唯一的理由是当时所有理由要挤进 H# 那一行。现在理由各占一行，就没有挤的问题了。
 */
function buildReasonTrail(records: DecisionRecord[], players: Player[]): string[] {
  const nameById = new Map(players.map((player) => [player.id, player.name]));
  return orderedRecords(records)
    .filter((record) => typeof record.reason === "string" && record.reason.trim().length > 0)
    .map((record) => {
      const street = STREET_LETTERS[record.street] ?? record.street.toUpperCase();
      const name = nameById.get(record.playerId);
      const seat = name ? `${record.position} ${name}` : record.position;
      // 只压掉换行和多余空格——模型偶尔会返回带换行的文本，那会把子列表撑散。
      const text = (record.reason as string).replace(/\s+/g, " ").trim();
      // 〔深思〕= 这条决策出自深度思考。没有标记的是快答——复盘时看到嘴瓢
      // (比如说要从打得过自己的牌上拿价值),先看这里就知道是不是快答惹的祸。
      return `${street} ${seat} ${record.finalLabelHint} — ${text}${record.thought ? "〔深思〕" : ""}`;
    });
}

/** `DS 92 · 重问 5 · 替换 2 · 回退 1` over the most recent retained AI actions. */
function recentSourceTally(store: Map<number, DecisionRecord[]>): string {
  const flat: DecisionRecord[] = [];
  Array.from(store.keys())
    .sort((left, right) => left - right)
    .forEach((handNo) => flat.push(...orderedRecords(store.get(handNo) ?? [])));
  const window = flat.slice(-TALLY_WINDOW);
  const counts = countSources(window);
  const tracked =
    counts.ds + counts["ds-retry"] + counts.override + counts["local-fallback"];
  if (tracked === 0) return "";
  const thoughtful = window.filter((record) => record.thought).length;
  return [
    `DS ${counts.ds}`,
    thoughtful > 0 ? `深思 ${thoughtful}` : "",
    counts["ds-retry"] > 0 ? `重问 ${counts["ds-retry"]}` : "",
    counts.override > 0 ? `替换 ${counts.override}` : "",
    counts["local-fallback"] > 0 ? `回退 ${counts["local-fallback"]}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const EMPTY_HERO_SUMMARY: HeroProfileSummary = { handsDealt: 0, text: "", lines: [] };

/**
 * The stored counters arrive from the network, so every field is re-validated against the shape of
 * `EMPTY_HERO_COUNTERS` — an unexpected payload degrades to "no profile", never to a crash.
 */
function normalizeHeroCounters(value: unknown): HeroCounters {
  if (!value || typeof value !== "object") return EMPTY_HERO_COUNTERS;
  const source = value as Record<string, unknown>;
  const result = { ...EMPTY_HERO_COUNTERS } as unknown as Record<string, number>;
  Object.keys(result).forEach((key) => {
    const raw = source[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) result[key] = raw;
  });
  return result as unknown as HeroCounters;
}

/** The profile is an enhancement: any failure inside it collapses to "not enough sample yet". */
function safeSummarizeHeroProfile(counters: HeroCounters): HeroProfileSummary {
  try {
    const summary = summarizeHeroProfile(counters);
    if (!summary || typeof summary !== "object") return EMPTY_HERO_SUMMARY;
    return {
      handsDealt: Number.isFinite(summary.handsDealt) ? summary.handsDealt : 0,
      text: typeof summary.text === "string" ? summary.text : "",
      lines: Array.isArray(summary.lines) ? summary.lines : [],
    };
  } catch {
    const handsDealt = counters?.handsDealt;
    return {
      ...EMPTY_HERO_SUMMARY,
      handsDealt: typeof handsDealt === "number" && Number.isFinite(handsDealt) ? handsDealt : 0,
    };
  }
}

/**
 * Collapse the rolling per-hand dynamics into one set of counters. Kept as a list of hands
 * rather than a running total so that dropping the 26th-oldest hand is exact rather than a
 * subtraction that could drift.
 */
function mergeWindow(hands: TableDynamics[]): TableDynamics {
  let total: TableDynamics = EMPTY_TABLE_DYNAMICS;
  for (const hand of hands) total = mergeTableDynamics(total, hand);
  return total;
}

function signedBb(value: number): string {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(1)}BB`;
}

function PlayingCard({
  card,
  hidden = false,
  small = false,
}: {
  card?: Card;
  hidden?: boolean;
  small?: boolean;
}) {
  if (hidden || !card) {
    return (
      <span className={`playing-card card-back ${small ? "small" : ""}`} aria-label="暗牌">
        <i />
      </span>
    );
  }
  return (
    <span
      className={`playing-card ${isRed(card) ? "red" : "black"} ${small ? "small" : ""}`}
      aria-label={cardLabel(card)}
    >
      <b>{card.rank}</b>
      <em>{cardLabel(card).slice(-1)}</em>
    </span>
  );
}

function PlayerSeat({
  player,
  seat,
  active,
  winner,
  reveal,
}: {
  player: Player;
  seat: number;
  active: boolean;
  winner: boolean;
  reveal: boolean;
}) {
  const showCards = player.isHero || reveal;
  return (
    <div
      className={`player-seat seat-${seat} ${active ? "active" : ""} ${
        player.folded ? "folded" : ""
      } ${player.isHero ? "hero-seat" : ""} ${winner ? "winner" : ""}`}
      style={{ "--player-color": player.persona.color } as React.CSSProperties}
      data-testid={`seat-${seat}`}
    >
      <div className="hole-cards">
        {player.hole.map((card, index) => (
          <PlayingCard
            key={`${cardCode(card)}-${index}`}
            card={card}
            hidden={!showCards}
            small={!player.isHero}
          />
        ))}
      </div>
      <div className="player-panel">
        <div className="avatar">{player.persona.icon}</div>
        <div className="player-info">
          <div className="player-name-line">
            <strong>{player.name}</strong>
          </div>
          <span className="persona-name">
            {player.persona.title} · {player.persona.subtitle}
          </span>
          {/* BB 是主单位——牌桌、牌谱、AI 的提示词全部按 BB 计价，筹码数退成参考。 */}
          <b className="stack">
            {amountBB(player.stack)} <small>({player.stack.toLocaleString()})</small>
          </b>
        </div>
        <span className="position-pill">{player.position}</span>
      </div>
    </div>
  );
}

function TableMarker({
  player,
  seat,
  dealer,
  won,
}: {
  player: Player;
  seat: number;
  dealer: boolean;
  /** 结算时这个座位从底池里分到的筹码；0 表示没赢。 */
  won: number;
}) {
  // 赢家的标记整个变成那堆筹码：结算这一刻要一眼看出钱去了谁那里，再挂一句
  // 「call 10BB」只会让金色筹码旁边多一个抢视线的黑框。动作历史在牌谱里查得到。
  const showAction = Boolean(player.lastAction && player.lastAction !== "fold") && won <= 0;
  if (!dealer && !showAction && player.streetBet <= 0 && won <= 0) return null;
  return (
    <div
      className={`table-marker marker-seat-${seat} ${player.folded ? "marker-folded" : ""} ${
        won > 0 ? "marker-won" : ""
      }`}
      aria-label={`${player.name} 桌面标记`}
    >
      {showAction && <div className="marker-action">{player.lastAction}</div>}
      <div className="marker-row">
        {dealer && <span className="table-dealer">D</span>}
        {won > 0 ? (
          <span className="table-bet won-bet">
            <i className="chip-pile" />
            <b>+{amountBB(won)}</b>
          </span>
        ) : (
          player.streetBet > 0 && (
            <span className="table-bet">
              <i className="chip-stack" />
              {/* 与正上方的动作标签同为 BB：桌上出现「3bet to 9BB」再配一个「18」会直接打架。 */}
              <b>{amountBB(player.streetBet)}</b>
            </span>
          )
        )}
      </div>
    </div>
  );
}

function FrequencyBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="trait">
      <span>{label}</span>
      <div>
        <i style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </div>
      <b>{Math.round(value * 100)}</b>
    </div>
  );
}

export function PokerTrainer({ initialGame }: { initialGame: GameState }) {
  const [game, setGame] = useState<GameState>(initialGame);
  const [raiseTo, setRaiseTo] = useState(6);
  const [showLog, setShowLog] = useState(true);
  // Review aid: once a hand is settled, turn every seat face-up. On by default.
  const [revealAllAtEnd, setRevealAllAtEnd] = useState(true);
  /** 翻后让模型先想再答。读牌更准,但每个翻后决策慢几秒。 */
  const [deepThink, setDeepThink] = useState(true);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showBuyIn, setShowBuyIn] = useState(false);
  const [buyInDraft, setBuyInDraft] = useState(100);
  /** 一次性 add-on:下一手开始前把这个数(BB)直接加到 hero 筹码上。赌场规则,手内不能加码。 */
  const [pendingAddOnBB, setPendingAddOnBB] = useState<number | null>(null);
  const [hands, setHands] = useState<StoredHand[]>([]);
  const [apiReady, setApiReady] = useState(false);
  const [apiSettings, setApiSettings] = useState<BrowserApiSettings | null>(null);
  const [apiDraft, setApiDraft] = useState<BrowserApiSettings>({
    apiKey: "",
    // 默认 Flash:快答本来就靠它的速度,思考臂也是它;Pro 留给想换口味的人手动选。
    model: "deepseek-v4-flash",
  });
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>("idle");
  const [apiMessage, setApiMessage] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [thinking, setThinking] = useState("");
  const [copied, setCopied] = useState(false);
  const [clearStatus, setClearStatus] = useState<"idle" | "clearing" | "cleared" | "error">("idle");
  /** Observed public frequencies of the human seat, fed to every AI's system prompt (V2 §三). */
  const [heroCounters, setHeroCounters] = useState<HeroCounters>(EMPTY_HERO_COUNTERS);
  /** Which lineup is seated. Mirrors `game.tier`; the two only ever change together. */
  const [tier, setTier] = useState<TableTier>(() => resolveTier(initialGame.tier));
  const sessionId = useRef(`S${Date.now().toString(36)}`);
  const loggedHand = useRef(0);
  const decisionToken = useRef(0);
  /** Read inside logFinishedHand, which intentionally keeps an empty dependency list. */
  const revealAllRef = useRef(true);
  /** Read inside the decision timer; a toggle mid-hand must not restart the acting AI's timer. */
  const deepThinkRef = useRef(true);
  /** handNo -> provenance of every AI action that actually reached the table (§7.1). */
  const decisionRecords = useRef<Map<number, DecisionRecord[]>>(new Map());
  /**
   * Mirror of the derived profile. The decision effect reads it inside the timer callback so the
   * profile never enters that effect's dependency array (a profile update mid-hand would otherwise
   * restart the acting AI's think timer) and never goes stale in its closure.
   */
  const heroProfileRef = useRef<HeroProfileSummary>(EMPTY_HERO_SUMMARY);
  /** Same reasoning as heroProfileRef: read inside the decision timer, never a dependency. */
  const heroDirectivesRef = useRef<string[]>([]);
  /**
   * One entry per finished hand, newest last, at most DYNAMICS_WINDOW of them. A ref rather
   * than state because nothing on screen depends on it and a re-render mid-hand would restart
   * the acting AI's think timer. Cleared when the lineup changes: seat ids belong to a table.
   */
  const dynamicsRef = useRef<TableDynamics[]>([]);
  /** Guards the one-shot "apply the tier saved in localStorage" deal. */
  const tierRestored = useRef(false);

  const tierDefinition = TABLE_TIERS[tier] ?? TABLE_TIERS[resolveTier(undefined)];
  const actor = game.players[game.actingIndex];
  const hero = game.players.find((player) => player.isHero) as Player;
  const heroLegal = actor?.isHero ? legalActions(game, actor) : [];
  const toCall = actor?.isHero ? Math.max(0, game.currentBet - actor.streetBet) : 0;
  const preflop = game.street === "preflop";
  const minRaiseTo = actor?.isHero
    ? Math.min(actor.streetBet + actor.stack, game.currentBet + game.minRaise)
    : 0;
  const maxRaiseTo = actor?.isHero ? actor.streetBet + actor.stack : 0;

  /**
   * 结算后每个赢家分到多少筹码。有边池时同一个人会出现在好几条 potResult 里，所以要累加。
   *
   * 排掉 kind === "return"：那是无人跟注时退还给自己的部分，本来就没进过底池。算进来的话，
   * 桌上那堆筹码会比刚才「总底池」显示的数字大，也会跟结算文案里的「赢得 X」对不上。
   */
  const potAwards = useMemo(() => {
    const totals: Record<string, number> = {};
    if (!game.handComplete) return totals;
    for (const pot of game.potResults ?? []) {
      if (pot.kind === "return") continue;
      for (const [playerId, amount] of Object.entries(pot.awards ?? {})) {
        if (amount > 0) totals[playerId] = (totals[playerId] ?? 0) + amount;
      }
    }
    return totals;
  }, [game.handComplete, game.potResults]);

  const sessionResultBb = hands.reduce((sum, hand) => sum + hand.resultBb, 0);
  const sessionEvBb = hands.reduce(
    (sum, hand) => sum + (typeof hand.evBb === "number" ? hand.evBb : hand.resultBb),
    0,
  );
  const sessionLuckBb = hands.reduce(
    (sum, hand) => sum + (typeof hand.luckBb === "number" ? hand.luckBb : 0),
    0,
  );
  const allInEvHands = hands.filter((hand) => typeof hand.evBb === "number").length;
  /** 只把全下那几手自己的 EV 加起来——上面那个 sessionEvBb 混进了其他牌局的实际结果。 */
  const sessionAllInEvBb = hands.reduce(
    (sum, hand) => sum + (typeof hand.evBb === "number" ? hand.evBb : 0),
    0,
  );
  const heroProfile = useMemo(() => safeSummarizeHeroProfile(heroCounters), [heroCounters]);
  /**
   * Sample discipline lives in `exploitDirectives` (nothing below 12 observations); the tier
   * only decides how many of the surviving instructions the table is allowed to act on.
   */
  const heroDirectives = useMemo(() => {
    try {
      const all = exploitDirectives(heroCounters);
      return Array.isArray(all)
        ? all.slice(0, DIRECTIVE_LIMITS[tierDefinition.heroReadStrength] ?? 3)
        : [];
    } catch {
      return [];
    }
  }, [heroCounters, tierDefinition.heroReadStrength]);

  useEffect(() => {
    heroProfileRef.current = heroProfile;
  }, [heroProfile]);

  useEffect(() => {
    heroDirectivesRef.current = heroDirectives;
  }, [heroDirectives]);

  // Chip state is derived from the provenance records themselves: every record is written in the
  // same guarded path that applies the action, so each write is followed by a re-render and the
  // derived value can never drift. A new hand starts with no records, i.e. green and zero.
  const currentHandRecords = decisionRecords.current.get(game.handNo) ?? [];
  const handFallbackCount = currentHandRecords.filter(
    (record) => record.source === "local-fallback",
  ).length;
  const lastApiSignal = orderedRecords(currentHandRecords)
    .filter(
      (record) =>
        record.source === "ds" ||
        record.source === "ds-retry" ||
        record.source === "local-fallback",
    )
    .pop();
  const apiHealth: ApiHealth = !apiReady
    ? "local"
    : lastApiSignal?.source === "local-fallback"
      ? "degraded"
      : "connected";
  const sourceTally = recentSourceTally(decisionRecords.current);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REVEAL_STORAGE_KEY);
      if (saved !== null) setRevealAllAtEnd(saved === "1");
      const savedThink = window.localStorage.getItem(DEEPTHINK_STORAGE_KEY);
      if (savedThink !== null) setDeepThink(savedThink === "1");
    } catch {
      // A blocked localStorage just means the defaults (both on) apply for this session.
    }
  }, []);

  useEffect(() => {
    revealAllRef.current = revealAllAtEnd;
  }, [revealAllAtEnd]);

  useEffect(() => {
    deepThinkRef.current = deepThink;
  }, [deepThink]);

  // 每次牌局状态一变就整份存盘。Defined ABOVE the restore effect on purpose: on mount the
  // effects run in this order, the guard is still false, and the server-rendered fresh table
  // is skipped — so the restore below always reads what LAST session wrote, never what this
  // render just made up.
  useEffect(() => {
    if (!tierRestored.current) return;
    try {
      window.localStorage.setItem(GAME_STORAGE_KEY, serializeGame(game));
    } catch {
      // Blocked storage only costs cross-session continuity, never the live hand.
    }
  }, [game]);

  // The server renders a fresh default table, so the saved tier and the saved game are applied
  // once on mount. A valid save wins outright: the exact state — hole cards, board, pot, whose
  // turn — continues as if the refresh never happened. The AI think effect keys off the acting
  // seat and has proper timer cleanup, so a hand restored mid-decision simply resumes thinking.
  // No save (or a save from another lineup/version, which parseSavedGame rejects): fresh table
  // on the saved tier, from hand one.
  useEffect(() => {
    if (tierRestored.current) return;
    tierRestored.current = true;
    let saved: TableTier = tier;
    let savedGame: GameState | null = null;
    try {
      saved = resolveTier(window.localStorage.getItem(TIER_STORAGE_KEY));
      savedGame = parseSavedGame(window.localStorage.getItem(GAME_STORAGE_KEY));
      window.localStorage.removeItem(LEGACY_PROGRESS_KEY);
    } catch {
      return; // Blocked storage: play the default lineup, from zero, for this session.
    }
    if (savedGame && resolveTier(savedGame.tier) === saved) {
      decisionToken.current += 1;
      // A finished hand was already logged by the session that finished it; restoring it must
      // not log (and store) it a second time.
      if (savedGame.handComplete) loggedHand.current = savedGame.handNo;
      setTier(saved);
      setGame(savedGame);
      return;
    }
    if (saved === tier) return;
    decisionToken.current += 1;
    setTier(saved);
    setGame(startHand(undefined, { tier: saved }));
  }, [tier]);

  const switchTier = useCallback(
    (next: TableTier) => {
      if (next === tier) return;
      const definition = TABLE_TIERS[next];
      const confirmed = window.confirm(
        `切换到「${definition.title}」会重开牌桌：换一套 AI 阵容，所有筹码按各自买入重置。确定吗？`,
      );
      if (!confirmed) return;
      // A think timer for a seat that is about to stop existing must not be allowed to land.
      decisionToken.current += 1;
      try {
        window.localStorage.setItem(TIER_STORAGE_KEY, next);
      } catch {
        // Not persisting still leaves the switch in effect for this session.
      }
      // Both are scoped to a table: seat ids and the provenance of seats that have left it
      // would only pollute the new lineup's reads.
      dynamicsRef.current = [];
      decisionRecords.current.clear();
      setCopied(false);
      setPendingAddOnBB(null);
      setTier(next);
      setGame((current) => startHand(current, { tier: next, heroBuyInBB: DEFAULT_HERO_REBUY_BB }));
    },
    [tier],
  );

  const toggleRevealAll = useCallback(() => {
    setRevealAllAtEnd((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(REVEAL_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Not persisting is acceptable; the toggle still applies to this session.
      }
      return next;
    });
  }, []);

  const toggleDeepThink = useCallback(() => {
    setDeepThink((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(DEEPTHINK_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Not persisting is acceptable; the toggle still applies to this session.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let hasBrowserSettings = false;
    try {
      const saved = window.localStorage.getItem(API_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as BrowserApiSettings;
        if (
          parsed.apiKey &&
          ["deepseek-v4-pro", "deepseek-v4-flash"].includes(parsed.model)
        ) {
          hasBrowserSettings = true;
          setApiSettings(parsed);
          setApiDraft(parsed);
          setApiConnection("connected");
          setApiMessage("已读取本机保存的 DeepSeek 设置");
          setApiReady(true);
        }
      }
    } catch {
      window.localStorage.removeItem(API_STORAGE_KEY);
    }
    fetch("/api/ai/status")
      .then((response) => response.json())
      .then((data) => setApiReady(hasBrowserSettings || Boolean(data.configured)))
      .catch(() => setApiReady(hasBrowserSettings));
    fetch("/api/hands")
      .then((response) => response.json())
      .then((data) => setHands(Array.isArray(data.hands) ? data.hands : []))
      .catch(() => setHands([]));
    // The profile is intel for the AIs, not a prerequisite for playing: an outage leaves it empty.
    fetch("/api/hero-profile")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || typeof data !== "object") return;
        setHeroCounters(normalizeHeroCounters((data as { counters?: unknown }).counters));
      })
      .catch(() => setHeroCounters(EMPTY_HERO_COUNTERS));
  }, []);

  const testAndSaveApi = async () => {
    const candidate = {
      apiKey: apiDraft.apiKey.trim(),
      model: apiDraft.model,
    };
    if (!candidate.apiKey) {
      setApiConnection("error");
      setApiMessage("请先输入 DeepSeek API Key");
      return;
    }
    setApiConnection("testing");
    setApiMessage("正在验证 Key 与模型…");
    try {
      const response = await fetch("/api/ai/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      });
      const data = (await response.json()) as { configured?: boolean; error?: string };
      if (!response.ok || !data.configured) {
        throw new Error(data.error || "连接失败");
      }
      window.localStorage.setItem(API_STORAGE_KEY, JSON.stringify(candidate));
      setApiSettings(candidate);
      setApiReady(true);
      setApiConnection("connected");
      setApiMessage("连接成功，下一次 AI 行动起生效");
    } catch (error) {
      setApiConnection("error");
      setApiMessage(error instanceof Error ? error.message : "连接失败，请检查 API Key");
    }
  };

  const removeApiSettings = async () => {
    window.localStorage.removeItem(API_STORAGE_KEY);
    setApiSettings(null);
    setApiDraft({ apiKey: "", model: "deepseek-v4-flash" });
    setApiConnection("idle");
    setApiMessage("已移除本机保存的 API Key");
    try {
      const response = await fetch("/api/ai/status");
      const data = await response.json();
      setApiReady(Boolean(data.configured));
    } catch {
      setApiReady(false);
    }
  };

  useEffect(() => {
    if (!actor?.isHero || game.handComplete) return;
    const suggested = preflop
      ? multipleRaiseTo(2.5, game.currentBet)
      : potRelativeRaiseTo(0.75, totalPot(game), game.currentBet, toCall);
    setRaiseTo(Math.max(minRaiseTo, Math.min(maxRaiseTo, suggested)));
  }, [actor?.id, actor?.isHero, game.handComplete, game.handNo, game.street, maxRaiseTo, minRaiseTo]);

  const logFinishedHand = useCallback(async (finished: GameState) => {
    if (loggedHand.current === finished.handNo) return;
    loggedHand.current = finished.handNo;
    // Before any network call, so an outage never costs the table its memory of the hand.
    try {
      dynamicsRef.current = [...dynamicsRef.current, dynamicsForHand(finished)].slice(
        -DYNAMICS_WINDOW,
      );
    } catch {
      // Dynamics are an enhancement; a malformed hand just is not counted.
    }
    const records = decisionRecords.current.get(finished.handNo) ?? [];
    const suffix = buildSourceSuffix(records);
    const line = compactHandLog(finished, suffix || undefined, {
      revealAll: revealAllRef.current,
      reasons: buildReasonTrail(records, finished.players),
    });
    const heroPlayer = finished.players.find((player) => player.isHero) as Player;
    const resultBb = (heroPlayer.stack - finished.heroStartStack) / BIG_BLIND;
    const ev = heroEvSummary(finished);
    const optimistic: StoredHand = {
      id: Date.now(),
      handId: `${sessionId.current}-H${String(finished.handNo).padStart(4, "0")}`,
      markdown: line,
      resultBb,
      evBb: ev ? ev.expectedResult / BIG_BLIND : null,
      luckBb: ev ? ev.luck / BIG_BLIND : null,
      evMethod: ev?.method ?? null,
      createdAt: new Date().toISOString(),
    };
    setHands((current) => [optimistic, ...current.filter((hand) => hand.handId !== optimistic.handId)]);
    try {
      const response = await fetch("/api/hands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handId: optimistic.handId,
          heroCards: heroPlayer.hole.map(cardCode).join(""),
          summary: finished.message,
          resultBb,
          evBb: optimistic.evBb,
          luckBb: optimistic.luckBb,
          evMethod: optimistic.evMethod,
          markdown: line,
        }),
      });
      const data = await response.json();
      if (data.hand) {
        setHands((current) => [data.hand, ...current.filter((hand) => hand.handId !== data.hand.handId)]);
      }
    } catch {
      // The on-screen copy remains available even if durable storage is temporarily unavailable.
    }

    // Hero profile: its own guarded block, so a hand-log failure above never skips it and a
    // profile failure here never touches the table. Merged locally only once the row is stored,
    // which keeps this session's view identical to what a reload would fetch back.
    try {
      const counters = heroCountersForHand(finished);
      const stored = await fetch("/api/hero-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handId: optimistic.handId, counters }),
      });
      if (!stored.ok) return;
      // Functional update: `logFinishedHand` is memoized with no deps and must never close over
      // the current counters.
      setHeroCounters((current) => {
        try {
          return normalizeHeroCounters(mergeHeroCounters(current, counters));
        } catch {
          return current;
        }
      });
    } catch {
      // Profile is an enhancement — a storage outage just means the AIs read one hand less.
    }
  }, []);

  useEffect(() => {
    if (game.handComplete) void logFinishedHand(game);
  }, [game, logFinishedHand]);

  useEffect(() => {
    if (game.handComplete || !actor || actor.isHero) {
      setThinking("");
      return;
    }
    const token = ++decisionToken.current;
    setThinking(`${actor.name} 正在思考`);
    const delay = 420 + Math.round(Math.random() * 620);
    const timer = window.setTimeout(async () => {
      const traits: PersonaTraits = {
        id: actor.persona.id,
        looseness: actor.persona.looseness,
        aggression: actor.persona.aggression,
        bluff: actor.persona.bluff,
      };
      let remote: BotDecision | null = null;
      let source: ActionSource = apiReady ? "local-fallback" : "local-engine";
      let rule: string | undefined;
      let failReason: string | undefined;
      let reason: string | null = null;
      let thought = false;

      if (apiReady) {
        // Read from the ref, never fetched here: the profile must add zero latency to a decision.
        const profile = heroProfileRef.current;
        const directives = heroDirectivesRef.current;
        const heroSeat = game.players.find((player) => player.isHero)?.position;
        // The rolling window over the last DYNAMICS_WINDOW hands, turned into the two prompt
        // lines by tableDynamics. Both return "" below their own sample floors, and the route
        // omits the whole block when they do.
        let calibration = "";
        let read = "";
        try {
          const rolling = mergeWindow(dynamicsRef.current);
          calibration = selfCalibration(
            rolling[actor.id] ?? EMPTY_SEAT_DYNAMICS,
            actor.persona.id,
          );
          read = tableRead(
            rolling,
            game.players.map((player) => ({
              playerId: player.id,
              position: player.position,
              personaId: player.persona.id,
            })),
            actor.id,
          );
        } catch {
          calibration = "";
          read = "";
        }
        try {
          const response = await fetch("/api/ai/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              persona: {
                id: actor.persona.id,
                title: actor.persona.title,
                prompt: actor.persona.prompt,
                looseness: actor.persona.looseness,
                aggression: actor.persona.aggression,
                bluff: actor.persona.bluff,
              },
              observation: botObservation(game, actor),
              api: apiSettings ?? undefined,
              // Ref, not state: a toggle mid-hand applies from the NEXT decision without
              // restarting the acting AI's think timer. 思考只花在和真人对战的决策上:
              // 你一弃牌,剩下的 AI 互殴全部降回快答——那些底池的输赢跟训练无关,
              // 等它们慢慢想纯属浪费你的时间。
              deepThink:
                deepThinkRef.current &&
                !(game.players.find((player) => player.isHero)?.folded ?? true),
              // Omitted entirely while the sample is too small — then the route emits no HERO READ.
              heroProfile:
                profile.text || directives.length > 0
                  ? { text: profile.text, handsDealt: profile.handsDealt, directives }
                  : undefined,
              heroPosition: heroSeat,
              // Empty strings are dropped so an early session's prompt stays byte-identical
              // to the one the route built before this feature existed.
              selfCalibration: calibration || undefined,
              tableRead: read || undefined,
            }),
            signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
          });
          if (response.ok) {
            const data = (await response.json()) as DecisionResponse;
            if (data.action && legalActions(game, actor).includes(data.action)) {
              remote = {
                action: data.action,
                raiseTo: typeof data.raiseTo === "number" ? data.raiseTo : undefined,
              };
              source =
                data.source === "ds-retry" || data.source === "override" ? data.source : "ds";
              rule = data.guardrail?.vetoRule;
              // Stored for post-hand review only — never rendered while the hand is live.
              reason = data.model?.reason ?? null;
              thought = data.thinking === true;
            } else {
              failReason = "illegal-action";
            }
          } else {
            const body = (await response.json().catch(() => null)) as {
              failReason?: string;
            } | null;
            failReason = body?.failReason || "network";
          }
        } catch (error) {
          failReason = isAbortError(error) ? "timeout" : "network";
        }
      }

      let applied: BotDecision;
      let originalKind: ActionKind;
      if (remote) {
        applied = remote;
        originalKind = remote.action;
      } else {
        // The local engine gets the same floor as DeepSeek (§8); there is no "ask again" here.
        const raw = localBotDecision(game, actor);
        originalKind = raw.action;
        applied = raw;
        try {
          const observation = botObservation(game, actor);
          const verdict = checkDecision(observation, traits, raw);
          if (verdict.ok) {
            applied = { action: raw.action, raiseTo: verdict.clampedRaiseTo ?? raw.raiseTo };
          } else {
            applied = suggestSafeAction(observation, traits);
            rule = verdict.rule;
          }
        } catch {
          // Guardrail unavailable or unhappy with the input: keep the raw local decision.
          applied = raw;
          rule = undefined;
        }
        if (!legalActions(game, actor).includes(applied.action)) {
          // A replacement the table would refuse must never stall the hand.
          applied = raw;
          rule = undefined;
        }
      }

      if (token !== decisionToken.current) return;
      setGame((current) => {
        if (
          current.handNo !== game.handNo ||
          current.actingIndex !== game.actingIndex ||
          current.handComplete
        ) return current;
        const seat = current.players[current.actingIndex];
        const actionIndex = current.actions.length;
        const next = applyAction(current, applied.action, applied.raiseTo);
        // applyAction returns the same state when it refuses the action; record only real actions.
        if (next === current) return current;
        pushDecisionRecord(decisionRecords.current, current.handNo, {
          actionIndex,
          playerId: seat.id,
          position: seat.position,
          street: current.street,
          kind: originalKind,
          finalLabelHint:
            applied.action === "raise" && typeof applied.raiseTo === "number"
              ? `raise ${applied.raiseTo}`
              : applied.action,
          source,
          rule,
          failReason,
          reason,
          thought,
        });
        return next;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [actor, apiReady, apiSettings, game]);

  const act = (action: ActionKind, amount?: number) => {
    decisionToken.current += 1;
    setGame((current) => applyAction(current, action, amount));
  };

  const newHand = () => {
    decisionToken.current += 1;
    setCopied(false);
    pruneDecisionRecords(decisionRecords.current, game.handNo + 1);
    // 筹码变动在两手之间结算(赌场规则):输光了自动重买 100BB;安排了 add-on 就把
    // 选的数量直接加上去——两者可叠加(破产手 armed 了 add-on:100 + add-on)。一次性,用完即清。
    const addOnBB = pendingAddOnBB;
    if (addOnBB !== null) setPendingAddOnBB(null);
    setGame((current) => {
      const prepared: GameState = {
        ...current,
        players: current.players.map((player) => {
          if (!player.isHero) return player;
          const base = player.stack <= 0 ? DEFAULT_HERO_REBUY_BB * BIG_BLIND : player.stack;
          const stack = base + (addOnBB ?? 0) * BIG_BLIND;
          return stack === player.stack ? player : { ...player, stack };
        }),
      };
      return startHand(prepared);
    });
  };

  const copyLogs = async () => {
    const ordered = [...hands].reverse().map((hand) => hand.markdown);
    await navigator.clipboard.writeText(markdownLog(ordered));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const downloadLogs = () => {
    const ordered = [...hands].reverse().map((hand) => hand.markdown);
    const blob = new Blob([markdownLog(ordered)], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `AI训练牌局日志_${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  /**
   * 牌桌归零:作废存盘,手数、筹码、按钮位、桌面动态全部回到第一手。只有「重置对局」用它。
   * 牌谱完全不归它管——「一键清空记录」只删记录、不动牌桌,两个按钮各管各的。
   */
  const resetTable = useCallback(() => {
    // A think timer for a hand that is about to stop existing must not be allowed to land.
    decisionToken.current += 1;
    dynamicsRef.current = [];
    decisionRecords.current.clear();
    loggedHand.current = 0;
    setCopied(false);
    setPendingAddOnBB(null);
    try {
      window.localStorage.removeItem(GAME_STORAGE_KEY);
    } catch {
      // The save effect will overwrite it with the fresh table anyway.
    }
    // 按钮位随机:每次重置从不同位置开局,不然第一手永远是同一个座位视角。
    setGame(startHand(undefined, { tier, dealerIndex: Math.floor(Math.random() * 8) }));
  }, [tier]);

  const resetGame = () => {
    const confirmed = window.confirm(
      "重置对局会把牌桌回到第一手：所有座位按各自买入重新坐下，按钮位随机，正在进行的这手作废。已存的牌谱保留。确定吗？",
    );
    if (!confirmed) return;
    resetTable();
  };

  const clearLogs = async () => {
    if (clearStatus === "clearing" || hands.length === 0) return;
    const previousHands = hands;
    setHands([]);
    setClearStatus("clearing");
    try {
      const response = await fetch("/api/hands", { method: "DELETE" });
      if (!response.ok) throw new Error("Clear failed");
      // The same DELETE drops hero_hand_stats server-side, so the local profile resets with it.
      // The table itself is deliberately left alone — the live hand, stacks and hand numbering
      // keep going; only「重置对局」touches those.
      setHeroCounters(EMPTY_HERO_COUNTERS);
      setClearStatus("cleared");
      window.setTimeout(() => setClearStatus("idle"), 1500);
    } catch {
      setHands(previousHands);
      setClearStatus("error");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand" aria-label="Mist Table">
            <span className="brand-mark">M</span>
          </div>
          <button
            className="buyin-button"
            onClick={() => setShowBuyIn(true)}
          >
            <span>ADD-ON</span>
            <b>{pendingAddOnBB !== null ? `+${pendingAddOnBB}BB · 待加` : "加码"}</b>
          </button>
        </div>
        <div className="table-title">
          <strong>黑雾训练桌 · 8 MAX</strong>
          <span>NLH CASH&nbsp;&nbsp;1 / 2</span>
        </div>
        <nav>
          <span className="status-chip fog"><i /> 迷雾开启</span>
          <span className={`status-chip ${apiHealth === "connected" ? "online" : apiHealth}`}>
            <i />{" "}
            {apiHealth === "degraded"
              ? `DeepSeek 波动 · 本手回退 ${handFallbackCount} 次`
              : apiHealth === "connected"
                ? apiSettings
                  ? apiSettings.model === "deepseek-v4-pro"
                    ? "DeepSeek V4 Pro"
                    : "DeepSeek V4 Flash"
                  : "统一 API 已连接"
                : "本地人格引擎"}
          </span>
          <button className="icon-button" onClick={() => setShowPlayers(true)} aria-label="AI 玩家设置">
            ⚙
          </button>
          <button className="icon-button log-toggle" onClick={() => setShowLog((value) => !value)} aria-label="牌局记录">
            ≡
          </button>
        </nav>
      </header>

      <section className={`game-layout ${showLog ? "" : "log-hidden"}`}>
        <div className="table-stage">
          <div className="ambient ambient-one" />
          <div className="ambient ambient-two" />
          <div className="poker-table">
            <div className="rail">
              <div className="felt">
                <div className="felt-lines" />
                <div className="table-center">
                  {/* 结算后底池已经推给赢家，中间这块要空出来——但保留元素占位，
                      否则公共牌会往上跳一格。 */}
                  <div className={`pot-label ${game.handComplete ? "pot-settled" : ""}`}>
                    <span>总底池</span>
                    <strong>{amountBB(totalPot(game))}</strong>
                    <small>{totalPot(game).toLocaleString()}</small>
                  </div>
                  <div className="community-cards" aria-label="公共牌">
                    {[0, 1, 2, 3, 4].map((index) =>
                      game.community[index] ? (
                        <PlayingCard key={index} card={game.community[index]} />
                      ) : (
                        <span className="card-slot" key={index} />
                      ),
                    )}
                  </div>
                </div>
              </div>
            </div>

            {game.players.map((player, seat) => (
              <PlayerSeat
                key={player.id}
                player={player}
                seat={seat}
                active={!game.handComplete && seat === game.actingIndex}
                winner={game.winners.includes(player.id)}
                reveal={game.revealed.includes(player.id) || (revealAllAtEnd && game.handComplete)}
              />
            ))}
            {game.players.map((player, seat) => (
              <TableMarker
                key={`marker-${player.id}`}
                player={player}
                seat={seat}
                dealer={seat === game.dealerIndex}
                won={potAwards[player.id] ?? 0}
              />
            ))}
          </div>

          <div className="table-footer">
            <div className={`action-dock ${game.handComplete ? "complete" : ""}`}>
              {game.handComplete ? (
                <>
                  <div className="result-copy">
                    <div className="ev-metric">
                      <span>本手结果</span>
                      <strong className={hero.stack - game.heroStartStack >= 0 ? "positive" : "negative"}>
                        {signedBb((hero.stack - game.heroStartStack) / BIG_BLIND)}
                      </strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`reveal-toggle ${revealAllAtEnd ? "on" : ""}`}
                    onClick={toggleRevealAll}
                    aria-pressed={revealAllAtEnd}
                    title="结算后把所有座位的底牌翻开，并写进牌谱"
                  >
                    <i />
                    <span>结算亮牌</span>
                  </button>
                  <button className="primary-action next-hand" onClick={newHand}>
                    下一手 <kbd>N</kbd>
                  </button>
                </>
              ) : actor?.isHero ? (
                <div className="decision-actions">
                  <div className="basic-actions">
                    {heroLegal.includes("fold") && (
                      <button className="fold-button" onClick={() => act("fold")}>
                        <span>Fold</span><kbd>F</kbd>
                      </button>
                    )}
                    {heroLegal.includes("check") && (
                      <button className="check-button" onClick={() => act("check")}>
                        <span>Check</span><kbd>X</kbd>
                      </button>
                    )}
                    {heroLegal.includes("call") && (
                      <button className="call-button" onClick={() => act("call")}>
                        <span>Call</span><b>{amountBB(toCall)}</b><kbd>C</kbd>
                      </button>
                    )}
                  </div>
                  <div className="raise-zone">
                    {heroLegal.includes("raise") && (
                      <div className="raise-control">
                        <div className="raise-presets">
                          {(preflop ? MULTIPLE_PRESETS : POT_PRESETS).map((size) => {
                            const natural = preflop
                              ? multipleRaiseTo(size, game.currentBet)
                              : potRelativeRaiseTo(size, totalPot(game), game.currentBet, toCall);
                            // 低于最小加注额的尺寸做不出来，点了只会得到别的数字——直接禁用，
                            // 而不是悄悄钳到最小值让按钮说谎。
                            const tooSmall = natural < minRaiseTo;
                            const target = Math.min(maxRaiseTo, natural);
                            return (
                              <button
                                key={size}
                                type="button"
                                className={raiseTo === target && !tooSmall ? "active" : ""}
                                disabled={tooSmall}
                                title={
                                  tooSmall
                                    ? `低于最小加注 ${amountBB(minRaiseTo)}`
                                    : `加注到 ${amountBB(target)}`
                                }
                                onClick={() => setRaiseTo(target)}
                              >
                                {preflop ? `${size}x` : `${Math.round(size * 100)}%`}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            className={raiseTo === maxRaiseTo ? "active" : ""}
                            title={`全下 ${amountBB(maxRaiseTo)}`}
                            onClick={() => setRaiseTo(maxRaiseTo)}
                          >
                            ALL-IN
                          </button>
                        </div>
                        <div className="raise-main">
                          <input
                            aria-label="加注到"
                            type="range"
                            min={minRaiseTo}
                            max={Math.max(minRaiseTo, maxRaiseTo)}
                            value={Math.max(minRaiseTo, Math.min(maxRaiseTo, raiseTo))}
                            onChange={(event) => setRaiseTo(Number(event.target.value))}
                          />
                          <button className="primary-action" onClick={() => act("raise", raiseTo)}>
                            <span>Raise to</span><b>{amountBB(raiseTo)}</b><kbd>R</kbd>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="waiting-state">
                  <span className="thinking-dots"><i /><i /><i /></span>
                  <div>
                    <b>{thinking || "AI 正在行动"}</b>
                    <small>每位 AI 只收到自己的底牌和公开桌面信息</small>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="log-panel">
          <div className="panel-heading">
            <div>
              <span>SESSION LOG</span>
              <h2>逐手记录</h2>
            </div>
            <button onClick={() => setShowLog(false)} aria-label="关闭记录">×</button>
          </div>
          <div className="session-summary">
            <div>
              <span>已记录</span>
              <strong>{hands.length}<small> 手</small></strong>
            </div>
            <div>
              <span>实际净结果</span>
              <strong className={sessionResultBb >= 0 ? "positive" : "negative"}>
                {signedBb(sessionResultBb)}
              </strong>
            </div>
            {/* 这一栏原来叫「ALL-IN EV」，但它从来不是那几手全下的 EV，而是把全下牌局换成
                期望值之后的整段盈亏——只打了一手全下的人看到 -46BB 会以为是那一手的 EV。
                改名叫「全下调整后」，并把那几手全下自己的 EV 单独列出来。 */}
            <div title="把在河牌前锁定全下的牌局换成它们的期望结果，其余牌局按实际结果计入；这是剔除发牌运气后的整段盈亏">
              <span>全下调整后 · 累计</span>
              <strong className={sessionEvBb >= 0 ? "positive" : "negative"}>
                {signedBb(sessionEvBb)}
              </strong>
              <small>
                {allInEvHands === 0
                  ? "本段没有全下牌局"
                  : `${allInEvHands} 手全下，其 EV 合计 ${signedBb(sessionAllInEvBb)}`}
              </small>
            </div>
            <div title="只统计全下牌局：实际拿到的减去应该拿到的。正数是赢了本不该赢的，负数是被反超">
              <span>运气差 · 累计</span>
              <strong className={sessionLuckBb >= 0 ? "lucky" : "unlucky"}>
                {signedBb(sessionLuckBb)}
              </strong>
              <small>实际 = 调整后 + 运气差</small>
            </div>
          </div>
          <div className="log-list">
            {hands.length === 0 ? (
              <div className="empty-log">
                <span>♠</span>
                <b>第一手正在进行</b>
                <p>结束后自动生成一行极简牌谱。</p>
              </div>
            ) : (
              hands.map((hand) => (
                <article key={`${hand.id}-${hand.handId}`}>
                  <div>
                    <b>{hand.markdown.match(/^H#\d+/)?.[0] ?? hand.handId}</b>
                    <span className={hand.resultBb >= 0 ? "positive" : "negative"}>
                      {hand.resultBb >= 0 ? "+" : ""}{hand.resultBb.toFixed(1)} BB
                    </span>
                  </div>
                  {/* 侧栏只显示 H# 那一行：理由现在跟在它下面，全塞进这个 8px、
                      三行截断的预览框里只会把牌局摘要挤掉。完整内容走复制/下载。 */}
                  <p>{hand.markdown.split("\n")[0]}</p>
                  {typeof hand.evBb === "number" && typeof hand.luckBb === "number" && (
                    <div className="hand-ev-line">
                      <span>All-in EV {signedBb(hand.evBb)}</span>
                      <span className={hand.luckBb >= 0 ? "lucky" : "unlucky"}>
                        运气 {signedBb(hand.luckBb)}
                      </span>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          <div className="log-actions">
            <button onClick={copyLogs}>{copied ? "已复制" : "复制 Markdown"}</button>
            <button className="download" onClick={downloadLogs}>下载 .md</button>
            <button
              className="clear-logs"
              onClick={clearLogs}
              disabled={hands.length === 0 || clearStatus === "clearing"}
            >
              {clearStatus === "clearing"
                ? "正在清空…"
                : clearStatus === "cleared"
                  ? "已清空"
                  : clearStatus === "error"
                    ? "清空失败 · 重试"
                    : "一键清空记录"}
            </button>
            <button className="clear-logs" onClick={resetGame}>
              重置对局
            </button>
          </div>
          <p className="storage-note"><i /> 自动保存到私人训练记录</p>
        </aside>
      </section>

      {showPlayers && (
        <div className="modal-backdrop" onClick={() => setShowPlayers(false)}>
          <section className="persona-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>TABLE LINEUP</span>
                <h2>7 位 AI 对手</h2>
                <p>
                  当前档位「{tierDefinition.title}」·
                  同一 API，不同系统人格；买入与打法独立。
                </p>
              </div>
              <button onClick={() => setShowPlayers(false)} aria-label="关闭">×</button>
            </header>
            {/*
              Difficulty is a lineup, not a hidden dial: each tier seats a different mix of the
              same seven personas, so the blurb below is the whole truth about what changed.
            */}
            <section className="tier-card" aria-label="难度档位">
              <div className="tier-heading">
                <span>TABLE TIER</span>
                <h3>难度档位</h3>
                <em>切换会重开牌桌</em>
              </div>
              <div className="tier-options" role="radiogroup" aria-label="难度档位选择">
                {(Object.keys(TABLE_TIERS) as TableTier[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={tier === id}
                    className={tier === id ? "selected" : ""}
                    onClick={() => switchTier(id)}
                  >
                    <b>{TABLE_TIERS[id].title}</b>
                    <small>{id.toUpperCase()}</small>
                  </button>
                ))}
              </div>
              <p className="tier-blurb">{tierDefinition.blurb}</p>
            </section>
            <section className={`api-settings-card ${apiConnection}`}>
              <div className="api-settings-copy">
                <span>DEEPSEEK API</span>
                <div>
                  <h3>让 7 位 AI 使用同一个模型</h3>
                  <p>每个座位只会收到自己的底牌和桌面公开信息，Key 只保存在当前浏览器。</p>
                </div>
                <em>api.deepseek.com</em>
              </div>
              <div className="api-settings-form">
                <label>
                  <span>模型</span>
                  <select
                    value={apiDraft.model}
                    onChange={(event) =>
                      setApiDraft((current) => ({
                        ...current,
                        model: event.target.value as BrowserApiSettings["model"],
                      }))
                    }
                  >
                    <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                    <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                  </select>
                </label>
                <button
                  type="button"
                  className={`reveal-toggle ${deepThink ? "on" : ""}`}
                  onClick={toggleDeepThink}
                  aria-pressed={deepThink}
                  title="只在大池子、大注、全下这类关键决策上让模型真正想清楚（AI 会像真人一样 tank 10~25 秒）。其余决策一律秒答。"
                >
                  <i />
                  <span>深度思考（大决策）</span>
                </button>
                <label className="api-key-field">
                  <span>API Key</span>
                  <div>
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={apiDraft.apiKey}
                      onChange={(event) =>
                        setApiDraft((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }))
                      }
                      placeholder="sk-..."
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="DeepSeek API Key"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((value) => !value)}
                      aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    >
                      {showApiKey ? "隐藏" : "显示"}
                    </button>
                  </div>
                </label>
                <button
                  type="button"
                  className="api-save-button"
                  onClick={testAndSaveApi}
                  disabled={apiConnection === "testing"}
                >
                  {apiConnection === "testing" ? "正在连接…" : "测试并保存"}
                </button>
                {apiSettings && (
                  <button type="button" className="api-remove-button" onClick={removeApiSettings}>
                    移除
                  </button>
                )}
              </div>
              <div className="api-settings-status" role="status">
                <i />
                <span>
                  {apiMessage ||
                    (apiReady
                      ? "API 已连接，下一次 AI 行动会自动使用。"
                      : "未填写时继续使用本地人格引擎。")}
                </span>
                <small>不会写入牌谱、训练记录或云端数据库</small>
              </div>
              {/*
                Read-only mirror of what the AIs are told about you. It lives in this modal on
                purpose: showing it at the table during a live hand would turn the AIs' intel into
                a hint for the human (V2 §三.5).
              */}
              <div className="api-settings-status hero-profile-line" role="status">
                <i />
                <span>
                  已建模 {heroProfile.handsDealt} 手 ·{" "}
                  {heroProfile.text || "样本不足，继续打"}
                </span>
                <small>每位 AI 都会读到这一行</small>
              </div>
            </section>
            <div className="persona-grid">
              {game.players.filter((player) => !player.isHero).map((player) => (
                <article key={player.id} style={{ "--player-color": player.persona.color } as React.CSSProperties}>
                  <div className="persona-title">
                    <span>{player.persona.icon}</span>
                    <div>
                      <b>{player.name}</b>
                      <small>{player.persona.title} · {player.persona.subtitle}</small>
                    </div>
                    <strong>{player.persona.buyInBB}BB</strong>
                  </div>
                  <FrequencyBar label="入池" value={player.persona.looseness} color={player.persona.color} />
                  <FrequencyBar label="进攻" value={player.persona.aggression} color={player.persona.color} />
                  <FrequencyBar label="诈唬" value={player.persona.bluff} color={player.persona.color} />
                  <p className="persona-rebuy">
                    <span>补码</span>
                    {player.persona.rebuy.label}
                  </p>
                </article>
              ))}
            </div>
            <footer>
              <span className={`connection-light ${apiReady ? "connected" : ""}`} />
              {apiReady
                ? `${apiSettings ? "DeepSeek 已连接" : "统一 API 已连接"}：每次行动发送独立、脱敏后的玩家视角。`
                : "当前使用本地人格引擎；配置统一 API 后会自动切换。"}
              {sourceTally && (
                <small className="source-tally" title="最近 100 个 AI 动作的来源统计">
                  {sourceTally}
                </small>
              )}
            </footer>
          </section>
        </div>
      )}

      {showBuyIn && (
        <div className="modal-backdrop" onClick={() => setShowBuyIn(false)}>
          <section className="buyin-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>TABLE ADD-ON</span>
                <h2>加码 Add-on</h2>
                <p>盲注 1/2 · 下一手开始前把选的数量直接加到你的筹码上；输光自动重买 100BB</p>
              </div>
              <button onClick={() => setShowBuyIn(false)} aria-label="关闭">×</button>
            </header>
            <div className="buyin-options">
              {[50, 100, 200, 300, 500].map((value) => (
                <button
                  key={value}
                  className={buyInDraft === value ? "selected" : ""}
                  onClick={() => setBuyInDraft(value)}
                >
                  <b>{value}</b>
                  <span>BB</span>
                  <small>{value * BIG_BLIND} 筹码</small>
                </button>
              ))}
            </div>
            <div className="buyin-slider">
              <div>
                <span>自定义加码</span>
                <strong>{buyInDraft}BB</strong>
              </div>
              <input
                aria-label="加码大盲数量"
                type="range"
                min={40}
                max={500}
                step={10}
                value={buyInDraft}
                onChange={(event) => setBuyInDraft(Number(event.target.value))}
              />
            </div>
            <button
              className="buyin-confirm"
              onClick={() => {
                setPendingAddOnBB(buyInDraft);
                setShowBuyIn(false);
              }}
              title="手内不能加码(赌场规则),下一手开始前筹码直接增加这个数量"
            >
              下一手 Add-on +{buyInDraft}BB（现有 {amountBB(hero.stack)}BB）
            </button>
            {pendingAddOnBB !== null && (
              <button
                className="buyin-confirm buyin-secondary"
                onClick={() => {
                  setPendingAddOnBB(null);
                  setShowBuyIn(false);
                }}
              >
                取消待加的 +{pendingAddOnBB}BB
              </button>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
