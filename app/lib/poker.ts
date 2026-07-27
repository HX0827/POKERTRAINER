export type Suit = "s" | "h" | "d" | "c";
export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "T"
  | "J"
  | "Q"
  | "K"
  | "A";
export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";
export type ActionKind = "fold" | "check" | "call" | "raise" | "allin";

export interface Card {
  rank: Rank;
  suit: Suit;
}

/**
 * How a persona manages chips between hands. Casino rule: chips may only be added
 * between hands, never mid-hand, so this is evaluated once at the start of each deal.
 */
export interface RebuyStyle {
  /** Top up once the stack falls below this fraction of the persona's table target. 0 = only after busting. */
  trigger: number;
  /** Also top up while holding less than this fraction of the biggest stack at the table. 0 = indifferent. */
  cover: number;
  /** Hard ceiling for a top-up as a multiple of buyInBB — 1 keeps the short-stack specialist short. */
  ceiling: number;
  /** How reliably a triggered top-up actually happens; recreational players are inconsistent. */
  chance: number;
  /** Shown in the lineup modal. */
  label: string;
}

export interface Persona {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  buyInBB: number;
  looseness: number;
  aggression: number;
  bluff: number;
  patience: number;
  rebuy: RebuyStyle;
  prompt: string;
}

export interface RebuyRecord {
  playerId: string;
  name: string;
  position: string;
  /** "rebuy" = bought back in after busting; "top-up" = added chips to a live stack. */
  kind: "rebuy" | "top-up";
  from: number;
  to: number;
  amount: number;
}

export interface Player {
  id: string;
  name: string;
  isHero: boolean;
  persona: Persona;
  stack: number;
  position: string;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  totalCommitted: number;
  acted: boolean;
  raiseLocked: boolean;
  lastAction: string;
  result: number;
}

export interface ActionRecord {
  street: Street;
  playerId: string;
  position: string;
  name: string;
  kind: ActionKind;
  amount: number;
  toAmount: number;
  facedBet: number;
  allInAfterAction: boolean;
  potBefore: number;
  label: string;
}

export interface PotResult {
  kind: "main" | "side" | "return";
  label: string;
  amount: number;
  contributors: string[];
  eligible: string[];
  winners: string[];
  awards: Record<string, number>;
}

export interface AllInEvRecord {
  street: Exclude<Street, "showdown">;
  expectedResult: number;
  expectedPayout: number;
  heroCommitted: number;
  pot: number;
  method: "exact" | "monte-carlo";
  trials: number;
  standardError: number;
}

export interface HeroEvSummary extends AllInEvRecord {
  actualResult: number;
  luck: number;
}

/** Which lineup of AI personas is sitting at the table (CONTRACT-V3 §三.2). */
export type TableTier = "casual" | "regular" | "tough";

export interface TierDefinition {
  id: TableTier;
  title: string;
  blurb: string;
  /**
   * The seven non-hero seats, in seat order 1..7. A persona id may repeat — the repeated seat
   * gets a distinct `player.id` and display name while keeping the original `persona.id`,
   * because planRebuy, strategy's PersonaTraits and the frequency targets all key off that.
   */
  lineup: string[];
  /** How much of the hero exploit-directive list the seats are told (§三.4). */
  heroReadStrength: "light" | "normal" | "hard";
}

export interface GameState {
  handNo: number;
  /** The lineup this hand was dealt with. Switching it re-opens the table. */
  tier: TableTier;
  dealerIndex: number;
  players: Player[];
  deck: Card[];
  community: Card[];
  street: Street;
  pot: number;
  currentBet: number;
  minRaise: number;
  actingIndex: number;
  actions: ActionRecord[];
  message: string;
  handComplete: boolean;
  revealed: string[];
  winners: string[];
  startingStacks: Record<string, number>;
  potResults: PotResult[];
  heroStartStack: number;
  heroAllInEv: AllInEvRecord | null;
  /** Chips added between the previous hand and this one. */
  rebuys: RebuyRecord[];
}

/**
 * Pre-computed board structure. The model demonstrably mis-reads suits when left to parse
 * `communityCards` itself (it called T-heart 3-spade 6-heart "T63r"), and the decision floor's
 * board-texture rule is useless if the board cannot be classified. So classify it here.
 */
export interface BoardTexture {
  cards: number;
  paired: boolean;
  tripsOnBoard: boolean;
  /** Highest number of cards sharing one suit. 3+ means a flush is already possible. */
  maxSuitCount: number;
  suit: Suit | null;
  monotone: boolean;
  twoTone: boolean;
  rainbow: boolean;
  flushPossible: boolean;
  /** Exactly two of a suit with cards still to come. */
  flushDrawLive: boolean;
  /** Distinct ranks inside the tightest five-rank window. 4 means one card completes a straight. */
  straightCards: number;
  straightPossible: boolean;
  /** What the most recently dealt card changed, in plain English. Empty preflop/flop. */
  lastCardEffect: string;
  /** One line for the prompt. */
  summary: string;
}

export interface OpponentProfile {
  position: string;
  name: string;
  allIn: boolean;
  totalCommitted: number;
  /** Highest preflop raise number this opponent initiated: 0 none, 1 open, 2 3bet, 3 4bet, 4 5bet+ */
  preflopAggression: 0 | 1 | 2 | 3 | 4;
  calledRaisePreflop: boolean;
  /** Made a bet/raise increment of >= 0.75x the pot at that moment on the current street */
  bigAggressionThisStreet: boolean;
}

export interface BotObservation {
  handNo: number;
  street: Street;
  position: string;
  holeCards: string[];
  communityCards: string[];
  stack: number;
  startingStack: number;
  effectiveStack: number;
  pot: number;
  streetBet: number;
  toCall: number;
  potOddsToCall: number;
  spr: number;
  currentBet: number;
  minRaise: number;
  minimumRaiseTo: number;
  maximumRaiseTo: number;
  legalActions: ActionKind[];
  publicActions: string[];
  playersRemaining: number;
  opponentsAbleToAct: number;
  raiseCountThisStreet: number;
  opponentProfiles: OpponentProfile[];
  /** Absent preflop. */
  boardTexture?: BoardTexture;
  /**
   * What this seat's own two cards actually are on this board, in one sentence — see
   * `describeHoleStrength`. Absent preflop. The model mis-reads its own holding often enough
   * that it cannot be left to infer this from `holeCards` + `communityCards`.
   */
  handStrength?: string;
  blinds: {
    smallBlind: number;
    bigBlind: number;
  };
  publicPlayers: Array<{
    name: string;
    position: string;
    stack: number;
    startingStack: number;
    streetBet: number;
    totalCommitted: number;
    folded: boolean;
    allIn: boolean;
    acted: boolean;
    lastAction: string;
  }>;
}

export const SMALL_BLIND = 1;
export const BIG_BLIND = 2;
/** Chips are added one rack at a time; a rack is 100BB, and a top-up is always a whole number of them. */
export const REBUY_RACK = 100 * BIG_BLIND;

export const PERSONAS: Persona[] = [
  {
    id: "hero",
    title: "训练者",
    subtitle: "由你决策",
    icon: "灯",
    color: "#f4c34f",
    buyInBB: 100,
    looseness: 0.5,
    aggression: 0.5,
    bluff: 0.5,
    patience: 0.5,
    rebuy: {
      trigger: 0, cover: 0, ceiling: 1, chance: 1,
      label: "由你在买入面板决定",
    },
    prompt: "",
  },
  {
    id: "gto",
    title: "均衡派",
    subtitle: "接近 GTO",
    icon: "Ω",
    color: "#67d7ff",
    buyInBB: 100,
    looseness: 0.49,
    aggression: 0.57,
    bluff: 0.48,
    patience: 0.62,
    rebuy: {
      trigger: 0.85, cover: 0, ceiling: 2, chance: 1,
      label: "低于 85% 就补一手 100BB，始终不让自己变短",
    },
    prompt:
      "Balanced, disciplined cash-game regular. Mix sizes, protect checking ranges, avoid " +
      "result-oriented decisions. Zero style tolerance: always the highest-EV defensible action. " +
      "Your HUD line should read 24/20 over a large sample: 24% of all hands dealt are entered " +
      "and 20% are raised preflop, so about one entry in six is a flat call rather than a raise. " +
      "You 3-bet roughly 8% of the spots where you face an open - that is the solver baseline, " +
      "not a target to beat.",
  },
  {
    id: "boss",
    title: "老板",
    subtitle: "松凶 · 爱施压",
    icon: "王",
    color: "#ffb13b",
    buyInBB: 250,
    looseness: 0.78,
    aggression: 0.84,
    bluff: 0.76,
    patience: 0.25,
    rebuy: {
      trigger: 0.75, cover: 0.6, ceiling: 1.8, chance: 1,
      label: "讨厌短码：后手一少就整手补，还要补到压住最大对手",
    },
    prompt:
      "Loose-aggressive table captain. Play many pots (top ~45% preflop, wider in position), " +
      "isolate weak limpers, and take the aggressive option when EV is close. Prefer big sizings " +
      "(0.75-1.25x pot, occasional 1.5x overbet) WHEN you hold equity, blockers, or a range " +
      "advantage. Your pressure targets capped ranges and likely folds - never a wall of made " +
      "hands. The quality floor always wins over machismo. " +
      "Your HUD line should read 35/27 over a large sample: 35% of all hands dealt are entered " +
      "and 27% are raised preflop, so roughly one entry in four is a call rather than a raise. " +
      "That is a LAG, not a maniac. You 3-bet about 11% of the spots where you face an open.",
  },
  {
    id: "tag",
    title: "猎手",
    subtitle: "紧凶 · 位置纪律",
    icon: "准",
    color: "#5ce6aa",
    buyInBB: 120,
    looseness: 0.34,
    aggression: 0.7,
    bluff: 0.34,
    patience: 0.82,
    rebuy: {
      trigger: 0.8, cover: 0, ceiling: 1.9, chance: 1,
      label: "纪律性补码，低于 80% 补一手 100BB",
    },
    prompt:
      "Tight-aggressive positional player. Strong entries in position, value-heavy isolation, " +
      "credible pressure. Without initiative or equity, give up quickly and fold with discipline. " +
      "Your HUD line should read 25/20 over a large sample: 25% of all hands dealt are entered " +
      "and 20% are raised preflop, so one entry in five is a call rather than a raise - usually " +
      "a small pair or a suited hand that plays well in position. You 3-bet about 9% of the " +
      "spots where you face an open.",
  },
  {
    id: "station",
    title: "老陈",
    subtitle: "松被动 · 跟注站",
    icon: "跟",
    color: "#89a8ff",
    buyInBB: 180,
    looseness: 0.82,
    aggression: 0.16,
    bluff: 0.12,
    patience: 0.66,
    rebuy: {
      trigger: 0, cover: 0, ceiling: 1, chance: 1,
      label: "娱乐心态：输光才重新买入，中途从不补码",
    },
    prompt:
      "Sticky loose-passive recreational caller. Preflop: play lots of suited, connected and " +
      "paired hands whenever the price is fair - you are here to see flops. Postflop: you hate " +
      "folding any pair or draw when the price is within a few percent of break-even, and you " +
      "bet or raise only when you are clearly ahead of the hands that would call you. On a dry " +
      "board two pair is worth betting; on a paired board, a three-flush board or a four-straight " +
      "board a bare two pair is a hand you call with, never one you shove. You are sticky, not " +
      "suicidal: when a huge bet or all-in prices out your hand with no draw, you fold. " +
      "Your HUD line should read 40/10 over a large sample: you enter about 40% of hands and " +
      "raise only 10% - three of every four pots you play, you got there by CALLING. You almost " +
      "never 3-bet (about 1 in 50 spots).",
  },
  {
    id: "short",
    title: "短码哥",
    subtitle: "50BB · 再加注全压",
    icon: "短",
    color: "#ff6c7a",
    buyInBB: 50,
    looseness: 0.42,
    aggression: 0.79,
    bluff: 0.38,
    patience: 0.56,
    rebuy: {
      trigger: 0.7, cover: 0, ceiling: 1, chance: 1,
      label: "永远只打 50BB：整手 100BB 太深，宁可不补",
    },
    prompt:
      "Compact 50BB strategy: raise-or-fold preflop, no marginal cold calls, well-timed jams " +
      "vs 3-bets with strong pairs and AK. At SPR <= 2 you are usually committed with top pair " +
      "or better - but not when the board is paired or three of a suit and you hold only one " +
      "pair. Avoid bloating pots with marginal hands out of position. " +
      "Your HUD line should read 22/19 over a large sample: 22% of all hands dealt are entered " +
      "and 19% are raised preflop - at 50BB most entries are a raise and only about one in seven " +
      "is a call. You 3-bet about 12% of the spots where you face an open, often as a jam.",
  },
  {
    id: "rock",
    title: "岩石",
    subtitle: "极紧 · 重价值",
    icon: "岩",
    color: "#b7becb",
    buyInBB: 80,
    looseness: 0.22,
    aggression: 0.45,
    bluff: 0.12,
    patience: 0.95,
    rebuy: {
      trigger: 0.5, cover: 0, ceiling: 1.9, chance: 0.6,
      label: "很不情愿：输掉一半才可能补一手，常常就这么短着打",
    },
    prompt:
      "Very tight, value-heavy nit. Fold marginal holdings, choose low-variance lines, bluff " +
      "rarely and only with excellent blockers. Patience is your edge. " +
      "Your HUD line should read 15/11 over a large sample: 15% of all hands dealt are entered " +
      "and 11% are raised preflop, so about one entry in four is a call rather than a raise. " +
      "You 3-bet only about 4% of the spots where you face an open - when you do, the table " +
      "should be right to believe you.",
  },
  {
    id: "maniac",
    title: "火山",
    subtitle: "超松凶 · 多尺度",
    icon: "火",
    color: "#ec4b3f",
    buyInBB: 300,
    looseness: 0.92,
    aggression: 0.96,
    bluff: 0.9,
    patience: 0.08,
    rebuy: {
      trigger: 0.8, cover: 0.75, ceiling: 1.9, chance: 1,
      label: "疯狂补码：只要不是最大的那堆就整手往上加",
    },
    prompt:
      "Hyper-aggressive maniac WITH a calculator. Highest bluff frequency at the table: attack " +
      "capped ranges, squeeze light, barrel scare cards, prefer big sizings (0.75-1.5x pot; " +
      "overbet when the board favors your range or you hold key blockers). What keeps you " +
      "dangerous instead of dead money: bluffs always carry blockers, draws, or clear fold " +
      "equity; jams beyond 1.25x pot need a real hand, a 12+ out draw, or SPR <= 1.2; and you " +
      "never call off with hopeless equity. Your chaos lives in aggression, never in calls. " +
      "Your HUD line should read 45/35: the loosest and most aggressive player at the table, but " +
      "still a human one. About one in five of your entries is a call, not a raise, and you " +
      "3-bet roughly one spot in six. A player who raises literally every hand is not a maniac, " +
      "he is a malfunction.",
  },
];

/** Seat count is fixed by POSITION_ORDER: one hero plus seven AI seats. */
const AI_SEATS = 7;

/**
 * Display name per persona. A lineup that seats the same persona twice numbers the repeats
 * (`老陈 2`), so the table, the log and the lineup modal can still tell the seats apart.
 */
const PERSONA_NAMES: Record<string, string> = {
  hero: "登邓灯",
  gto: "Atlas",
  boss: "钱老板",
  tag: "Mika",
  station: "老陈",
  short: "K.O.",
  rock: "Stone",
  maniac: "Volcano",
};

/**
 * Difficulty is expressed as WHO is sitting there, not as a hidden strength dial: the personas
 * keep their published frequencies, and the tier decides how many of each the hero faces.
 *
 * `regular` is byte-for-byte the historical lineup, so an existing session is unaffected.
 */
export const TABLE_TIERS: Record<TableTier, TierDefinition> = {
  casual: {
    id: "casual",
    title: "娱乐场",
    blurb:
      "两个跟注站、两个老板、一个火山：五个松座位在送钱，只有一个猎手真的会打。" +
      "价值下注拿钱，别对着跟注站诈唬。",
    // Recreational-heavy: two stations (the 40/10 calling stations), two loose-aggressive
    // bosses and a maniac. One nit and one TAG keep it a poker game rather than a freeroll.
    lineup: ["station", "boss", "station", "maniac", "rock", "boss", "tag"],
    heroReadStrength: "light",
  },
  regular: {
    id: "regular",
    title: "常规桌",
    blurb:
      "七种人格各一个：均衡派、老板、猎手、跟注站、短码哥、岩石、火山。" +
      "标准的现金桌生态，强弱都有。",
    lineup: ["gto", "boss", "tag", "station", "short", "rock", "maniac"],
    heroReadStrength: "normal",
  },
  tough: {
    id: "tough",
    title: "高手局",
    blurb:
      "没有跟注站，也没有火山：两个均衡派、两个猎手、一个短码哥、一个岩石、一个老板。" +
      "他们会读你的漏洞并全力剥削，薄价值和诈唬都要重新想。",
    // No station and no maniac — nothing here pays off a weak value bet, and every seat
    // 3-bets a real range.
    lineup: ["gto", "tag", "gto", "short", "tag", "rock", "boss"],
    heroReadStrength: "hard",
  },
};

export const DEFAULT_TIER: TableTier = "regular";

/** Tier ids arrive from localStorage and from stored state; anything unknown falls back. */
export function resolveTier(value: unknown): TableTier {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TABLE_TIERS, value)
    ? (value as TableTier)
    : DEFAULT_TIER;
}

const RANKS: Rank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
];
const SUITS: Suit[] = ["s", "h", "d", "c"];
const POSITION_ORDER = ["SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO", "BTN"];

export function makeDeck(): Card[] {
  const deck = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardCode(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function cardLabel(card: Card): string {
  const suit = { s: "♠", h: "♥", d: "♦", c: "♣" }[card.suit];
  return `${card.rank}${suit}`;
}

export function isRed(card: Card): boolean {
  return card.suit === "h" || card.suit === "d";
}

export function amountBB(amount: number): string {
  const value = amount / BIG_BLIND;
  return Number.isInteger(value) ? `${value}BB` : `${value.toFixed(1)}BB`;
}

export function totalPot(state: GameState): number {
  return state.pot + state.players.reduce((sum, player) => sum + player.streetBet, 0);
}

/** Used only if a lineup is somehow shorter than seven seats. */
const DEFAULT_LINEUP_FILLER = "gto";

function personaById(id: string): Persona {
  return PERSONAS.find((persona) => persona.id === id) ?? PERSONAS[1];
}

interface SeatBlueprint {
  /** Unique per seat. Stays the bare persona id for the first (usually only) occurrence, so
   *  every id that existed before tiers still exists — the hand log, the rebuy records and the
   *  rolling dynamics all address seats by this string. */
  id: string;
  name: string;
  persona: Persona;
  isHero: boolean;
}

/**
 * The eight seats a tier deals to: the hero, then `lineup` in seat order.
 *
 * A persona repeated in a lineup gets a suffixed seat id (`station#4`) and a numbered display
 * name (`老陈 2`), but `persona.id` is left untouched — planRebuy, the strategy guardrail's
 * PersonaTraits and tableDynamics' FREQUENCY_TARGETS all key off the persona, not the seat.
 */
function seatBlueprints(tier: TableTier): SeatBlueprint[] {
  const definition = TABLE_TIERS[tier] ?? TABLE_TIERS[DEFAULT_TIER];
  const heroPersona = PERSONAS[0];
  const seats: SeatBlueprint[] = [
    { id: heroPersona.id, name: PERSONA_NAMES[heroPersona.id], persona: heroPersona, isHero: true },
  ];
  // A short or over-long lineup must never change the seat count: the deal, the position map
  // and every `% 8` in this file assume exactly eight players.
  const lineup = definition.lineup.slice(0, AI_SEATS);
  while (lineup.length < AI_SEATS) lineup.push(DEFAULT_LINEUP_FILLER);
  const occurrences = new Map<string, number>();
  lineup.forEach((personaId, index) => {
    const persona = personaById(personaId);
    const nth = (occurrences.get(persona.id) ?? 0) + 1;
    occurrences.set(persona.id, nth);
    const baseName = PERSONA_NAMES[persona.id] ?? persona.title;
    seats.push({
      id: nth === 1 ? persona.id : `${persona.id}#${index + 1}`,
      name: nth === 1 ? baseName : `${baseName} ${nth}`,
      persona,
      isHero: false,
    });
  });
  return seats;
}

function freshPlayers(previous: Player[] | undefined, tier: TableTier): Player[] {
  return seatBlueprints(tier).map((blueprint) => {
    const old = previous?.find((player) => player.id === blueprint.id);
    const targetStack = blueprint.persona.buyInBB * BIG_BLIND;
    // Busted stacks are carried as 0 and settled by applyRebuys, so buying back in is recorded.
    const carried = old ? old.stack : targetStack;
    return {
      id: blueprint.id,
      name: blueprint.name,
      isHero: blueprint.isHero,
      persona: blueprint.persona,
      stack: carried,
      position: "",
      hole: [],
      folded: false,
      allIn: false,
      streetBet: 0,
      totalCommitted: 0,
      acted: false,
      raiseLocked: false,
      lastAction: "",
      result: 0,
    };
  });
}

/**
 * The stack a player wants in front of them for the coming hand — never less than what they
 * already have. `roll` is the persona's willingness draw (0..1), injected so the decision is
 * testable. The human is excluded: they manage their own stack through the buy-in panel.
 */
export function planRebuy(player: Player, biggestOtherStack: number, roll: number): number {
  const target = player.persona.buyInBB * BIG_BLIND;
  if (player.stack <= 0) return target; // busted: always buy back in, style is irrelevant
  if (player.isHero) return player.stack;

  const style = player.persona.rebuy;
  const wantsForOwnDepth = style.trigger > 0 && player.stack < target * style.trigger;
  const wantsToCover =
    style.cover > 0 && biggestOtherStack > 0 && player.stack < biggestOtherStack * style.cover;
  if (!wantsForOwnDepth && !wantsToCover) return player.stack;
  if (roll > style.chance) return player.stack; // decided to keep playing the short stack

  const ceiling = Math.round(target * style.ceiling);
  const covering = style.cover > 0 ? Math.min(biggestOtherStack, ceiling) : 0;
  const desired = Math.max(target, covering);
  if (desired <= player.stack) return player.stack;

  // Chips are bought a full rack at a time — never an odd "+51BB". A persona that cannot
  // fit even one rack under its ceiling simply keeps playing short (this is what holds the
  // short-stack specialist at 50BB).
  let racks = Math.max(1, Math.ceil((desired - player.stack) / REBUY_RACK));
  while (racks >= 1 && player.stack + racks * REBUY_RACK > ceiling) racks -= 1;
  if (racks < 1) return player.stack;
  return player.stack + racks * REBUY_RACK;
}

/** Applies every persona's between-hand chip management. Mutates stacks, returns what happened. */
function applyRebuys(players: Player[]): RebuyRecord[] {
  const before = players.map((player) => player.stack);
  const records: RebuyRecord[] = [];
  players.forEach((player, index) => {
    // Decisions are made against the pre-rebuy table so seat order cannot influence them.
    const biggestOther = Math.max(
      0,
      ...before.filter((_, otherIndex) => otherIndex !== index),
    );
    const to = planRebuy(player, biggestOther, Math.random());
    if (to <= player.stack) return;
    records.push({
      playerId: player.id,
      name: player.name,
      position: player.position,
      kind: player.stack <= 0 ? "rebuy" : "top-up",
      from: player.stack,
      to,
      amount: to - player.stack,
    });
    player.stack = to;
  });
  return records;
}

function nextSeat(index: number): number {
  return (index + 1) % 8;
}

function positionPlayers(players: Player[], dealerIndex: number): Player[] {
  const result = players.map((player) => ({ ...player }));
  POSITION_ORDER.forEach((position, offset) => {
    const seat = (dealerIndex + 1 + offset) % 8;
    result[seat].position = position;
  });
  return result;
}

function pay(player: Player, amount: number): number {
  const paid = Math.min(player.stack, amount);
  player.stack -= paid;
  player.streetBet += paid;
  player.totalCommitted += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

export interface StartHandOptions {
  /** Omitted: keep `previous.tier`. Different from `previous.tier`: re-open the table. */
  tier?: TableTier;
  /**
   * What the human buys in for when the table is re-opened. The AI seats reset to their own
   * persona buy-ins; the human's is chosen in the buy-in panel, so it has to be passed in.
   * Ignored while the table simply continues.
   */
  heroBuyInBB?: number;
}

export function startHand(previous?: GameState, options?: StartHandOptions): GameState {
  const previousTier = previous ? resolveTier(previous.tier) : DEFAULT_TIER;
  const tier = resolveTier(options?.tier ?? previousTier);
  // Changing the lineup changes who is sitting there, so carrying stacks would be meaningless:
  // everyone re-buys, and the button goes back to its opening seat.
  const reopened = Boolean(previous) && tier !== previousTier;
  const dealerIndex = previous && !reopened ? nextSeat(previous.dealerIndex) : 7;
  const carriedPlayers = reopened ? undefined : previous?.players;
  let players = positionPlayers(freshPlayers(carriedPlayers, tier), dealerIndex);
  if (reopened && typeof options?.heroBuyInBB === "number" && options.heroBuyInBB > 0) {
    const heroBuyIn = Math.max(BIG_BLIND, Math.round(options.heroBuyInBB * BIG_BLIND));
    players = players.map((player) => (player.isHero ? { ...player, stack: heroBuyIn } : player));
  }
  const rebuys = applyRebuys(players);
  const deck = makeDeck();
  const hero = players.find((player) => player.isHero);
  const heroStartStack = hero?.stack ?? PERSONAS[0].buyInBB * BIG_BLIND;
  const startingStacks = Object.fromEntries(
    players.map((player) => [player.id, player.stack]),
  );

  for (let round = 0; round < 2; round += 1) {
    for (let step = 1; step <= 8; step += 1) {
      const seat = (dealerIndex + step) % 8;
      players[seat].hole.push(deck.pop() as Card);
    }
  }

  const sbIndex = nextSeat(dealerIndex);
  const bbIndex = nextSeat(sbIndex);
  pay(players[sbIndex], SMALL_BLIND);
  players[sbIndex].lastAction = "SB 0.5BB";
  pay(players[bbIndex], BIG_BLIND);
  players[bbIndex].lastAction = "BB 1BB";
  const actingIndex = nextSeat(bbIndex);

  return {
    handNo: (previous?.handNo ?? 0) + 1,
    tier,
    dealerIndex,
    players,
    deck,
    community: [],
    street: "preflop",
    pot: 0,
    currentBet: BIG_BLIND,
    minRaise: BIG_BLIND,
    actingIndex,
    actions: [],
    message: `${players[actingIndex].position} 行动`,
    handComplete: false,
    revealed: [],
    winners: [],
    startingStacks,
    potResults: [],
    heroStartStack,
    heroAllInEv: null,
    rebuys,
  };
}

/**
 * 整份牌局状态的存取——刷新或重开页面后，连手牌、公共牌、底池、轮到谁全部原样接上，
 * 打到一半的手也不例外。牌谱在 SQLite 里，不归它管；「重置对局」和「一键清空记录」作废它。
 *
 * GameState 全是纯数据（没有函数、没有类实例），JSON 直接就是它的序列化格式。
 * 版本号包一层：状态结构改了就升版本，旧存档宁可作废也不能喂进新引擎。
 */
const SAVED_GAME_VERSION = 1;

export function serializeGame(state: GameState): string {
  return JSON.stringify({ v: SAVED_GAME_VERSION, game: state });
}

function isCard(value: unknown): value is Card {
  if (!value || typeof value !== "object") return false;
  const card = value as Card;
  return RANKS.includes(card.rank) && SUITS.includes(card.suit);
}

/** Copies as fresh objects so nothing in the restored state aliases the parsed JSON. */
function cardArray(value: unknown, max: number): Card[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const cards: Card[] = [];
  for (const item of value) {
    if (!isCard(item)) return null;
    cards.push({ rank: item.rank, suit: item.suit });
  }
  return cards;
}

const STREET_SET = new Set<Street>(["preflop", "flop", "turn", "river", "showdown"]);

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSeatIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < 8;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * Parse a saved game. Anything malformed returns null — corrupt or tampered storage must cost
 * the player their carried table at worst, never crash it. The engine-critical fields (cards,
 * amounts, seat indices) are validated one by one; static seat facts (name, persona, isHero)
 * are NOT trusted from storage but re-attached from the current code's blueprints, so an app
 * update that retunes a persona applies to restored tables too. History collections that are
 * only ever rendered (actions, potResults, rebuys) are shape-filtered rather than deep-checked.
 */
export function parseSavedGame(raw: string | null): GameState | null {
  if (!raw) return null;
  let envelope: { v?: unknown; game?: unknown };
  try {
    envelope = JSON.parse(raw) as { v?: unknown; game?: unknown };
  } catch {
    return null;
  }
  if (!envelope || envelope.v !== SAVED_GAME_VERSION) return null;
  const saved = envelope.game as Partial<GameState> | null;
  if (!saved || typeof saved !== "object") return null;

  if (!Number.isInteger(saved.handNo) || (saved.handNo as number) < 1 || (saved.handNo as number) > 1_000_000)
    return null;
  if (!isSeatIndex(saved.dealerIndex) || !isSeatIndex(saved.actingIndex)) return null;
  if (!STREET_SET.has(saved.street as Street)) return null;
  if (!isMoney(saved.pot) || !isMoney(saved.currentBet) || !isMoney(saved.minRaise)) return null;
  if (typeof saved.handComplete !== "boolean") return null;

  const tier = resolveTier(saved.tier);
  const blueprints = seatBlueprints(tier);
  if (!Array.isArray(saved.players) || saved.players.length !== blueprints.length) return null;
  const players: Player[] = [];
  for (let seat = 0; seat < blueprints.length; seat += 1) {
    const blueprint = blueprints[seat];
    const stored = saved.players[seat] as Partial<Player> | null;
    // Seat order is the deal order; a save whose seats do not line up belongs to another
    // lineup (or another version of the code) and cannot be continued.
    if (!stored || typeof stored !== "object" || stored.id !== blueprint.id) return null;
    if (!isMoney(stored.stack) || !isMoney(stored.streetBet) || !isMoney(stored.totalCommitted))
      return null;
    const hole = cardArray(stored.hole, 2);
    if (hole === null) return null;
    players.push({
      id: blueprint.id,
      name: blueprint.name,
      isHero: blueprint.isHero,
      persona: blueprint.persona,
      stack: stored.stack as number,
      position: typeof stored.position === "string" ? stored.position : "",
      hole,
      folded: Boolean(stored.folded),
      allIn: Boolean(stored.allIn),
      streetBet: stored.streetBet as number,
      totalCommitted: stored.totalCommitted as number,
      acted: Boolean(stored.acted),
      raiseLocked: Boolean(stored.raiseLocked),
      lastAction: typeof stored.lastAction === "string" ? stored.lastAction : "",
      result: typeof stored.result === "number" && Number.isFinite(stored.result) ? stored.result : 0,
    });
  }

  const deck = cardArray(saved.deck, 52);
  const community = cardArray(saved.community, 5);
  if (deck === null || community === null) return null;

  const startingStacks: Record<string, number> = {};
  if (saved.startingStacks && typeof saved.startingStacks === "object") {
    for (const [id, stack] of Object.entries(saved.startingStacks)) {
      if (isMoney(stack)) startingStacks[id] = stack;
    }
  }

  const hero = players.find((player) => player.isHero);
  return {
    handNo: saved.handNo as number,
    tier,
    dealerIndex: saved.dealerIndex as number,
    players,
    deck,
    community,
    street: saved.street as Street,
    pot: saved.pot as number,
    currentBet: saved.currentBet as number,
    minRaise: saved.minRaise as number,
    actingIndex: saved.actingIndex as number,
    actions: Array.isArray(saved.actions)
      ? (saved.actions.filter(
          (item) => item && typeof item === "object" && typeof (item as ActionRecord).label === "string",
        ) as ActionRecord[])
      : [],
    message: typeof saved.message === "string" ? saved.message : "",
    handComplete: saved.handComplete,
    revealed: stringList(saved.revealed),
    winners: stringList(saved.winners),
    startingStacks,
    potResults: Array.isArray(saved.potResults)
      ? (saved.potResults.filter(
          (item) => item && typeof item === "object" && isMoney((item as PotResult).amount),
        ) as PotResult[])
      : [],
    heroStartStack: isMoney(saved.heroStartStack) ? saved.heroStartStack : (hero?.stack ?? 0),
    heroAllInEv:
      saved.heroAllInEv && typeof saved.heroAllInEv === "object"
        ? (saved.heroAllInEv as AllInEvRecord)
        : null,
    rebuys: Array.isArray(saved.rebuys)
      ? (saved.rebuys.filter(
          (item) => item && typeof item === "object" && typeof (item as RebuyRecord).playerId === "string",
        ) as RebuyRecord[])
      : [],
  };
}

export function legalActions(state: GameState, player: Player): ActionKind[] {
  if (state.handComplete || player.folded || player.allIn) return [];
  const toCall = Math.max(0, state.currentBet - player.streetBet);
  const result: ActionKind[] = [];
  if (toCall > 0) result.push("fold", "call");
  else result.push("check");
  const opponentCanRespond = state.players.some(
    (other) => other.id !== player.id && !other.folded && !other.allIn,
  );
  const canAggress =
    opponentCanRespond && !Boolean(player.raiseLocked) && player.stack > toCall;
  if (canAggress) result.push("raise", "allin");
  return result;
}

function livePlayers(players: Player[]): Player[] {
  return players.filter((player) => !player.folded);
}

function canAct(player: Player): boolean {
  return !player.folded && !player.allIn;
}

function nextActor(players: Player[], from: number): number {
  for (let step = 1; step <= players.length; step += 1) {
    const index = (from + step) % players.length;
    if (canAct(players[index])) return index;
  }
  return from;
}

function firstPostflopActor(players: Player[], dealerIndex: number): number {
  for (let step = 1; step <= players.length; step += 1) {
    const index = (dealerIndex + step) % players.length;
    if (canAct(players[index])) return index;
  }
  return dealerIndex;
}

function drawStreet(state: GameState, count: number): Card[] {
  state.deck.pop();
  const cards: Card[] = [];
  for (let i = 0; i < count; i += 1) cards.push(state.deck.pop() as Card);
  return cards;
}

function collectStreet(state: GameState): void {
  state.pot += state.players.reduce((sum, player) => sum + player.streetBet, 0);
  state.players.forEach((player) => {
    player.streetBet = 0;
    player.acted = false;
    player.raiseLocked = false;
    if (!player.folded) player.lastAction = "";
  });
  state.currentBet = 0;
  state.minRaise = BIG_BLIND;
}

function streetComplete(state: GameState): boolean {
  const actors = state.players.filter(canAct);
  if (actors.length === 0) return true;
  return actors.every((player) => player.acted && player.streetBet === state.currentBet);
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    // States built by hand (tests, stored sessions from before tiers existed) may lack it.
    tier: resolveTier(state.tier),
    players: state.players.map((player) => ({
      ...player,
      hole: player.hole.map((card) => ({ ...card })),
    })),
    deck: state.deck.map((card) => ({ ...card })),
    community: state.community.map((card) => ({ ...card })),
    actions: state.actions.map((action) => ({ ...action })),
    revealed: [...state.revealed],
    winners: [...state.winners],
    startingStacks: { ...(state.startingStacks ?? {}) },
    potResults: (state.potResults ?? []).map((pot) => ({
      ...pot,
      contributors: [...pot.contributors],
      eligible: [...pot.eligible],
      winners: [...pot.winners],
      awards: { ...pot.awards },
    })),
    heroAllInEv: state.heroAllInEv ? { ...state.heroAllInEv } : null,
    rebuys: (state.rebuys ?? []).map((record) => ({ ...record })),
  };
}

function actionLabel(
  state: GameState,
  player: Player,
  kind: ActionKind,
  amount: number,
  previousCurrentBet: number,
): string {
  const priorRaises = state.actions.filter(
    (action) =>
      action.street === state.street &&
      action.toAmount > action.facedBet &&
      (action.kind === "raise" || action.kind === "allin"),
  ).length;
  const preflopRaiseVerb =
    priorRaises === 0 ? "open" : priorRaises === 1 ? "3bet" : `${priorRaises + 2}bet`;
  if (kind === "fold") return "fold";
  if (kind === "check") return "check";
  // 只说跟到多少，不再补一句 `to X`。跟注后 streetBet 就等于这条街的注额，两个数字在绝大多数
  // 情况下完全一样（`call 10BB to 10BB`），少数不一样的情况——大盲补齐、短码全下跟注——桌上
  // 正下方的筹码标记已经写着同一个 streetBet，说两遍只会让标签变长、把牌桌挤花。
  if (kind === "call") {
    if (player.allIn) {
      return `call all-in ${amountBB(player.streetBet)}`;
    }
    if (
      state.street === "preflop" &&
      state.actions.every((action) => action.toAmount <= action.facedBet)
    ) {
      return "limp";
    }
    return `call ${amountBB(player.streetBet)}`;
  }
  if (kind === "allin" && player.streetBet <= previousCurrentBet) {
    return `call all-in ${amountBB(player.streetBet)}`;
  }
  if (kind === "allin" || player.allIn) {
    if (state.street === "preflop") {
      return `${preflopRaiseVerb} all-in to ${amountBB(player.streetBet)}`;
    }
    return previousCurrentBet === 0
      ? `bet all-in ${amountBB(player.streetBet)}`
      : `raise all-in to ${amountBB(player.streetBet)}`;
  }
  if (state.street === "preflop") {
    return `${preflopRaiseVerb} to ${amountBB(player.streetBet)}`;
  }
  return previousCurrentBet === 0
    ? `bet ${amountBB(player.streetBet)}`
    : `raise to ${amountBB(player.streetBet)}`;
}

function awardSingleWinner(state: GameState): void {
  const winner = livePlayers(state.players)[0];
  const highestOpponentStreetBet = Math.max(
    0,
    ...state.players
      .filter((player) => player.id !== winner.id)
      .map((player) => player.streetBet),
  );
  const uncalled = Math.max(0, winner.streetBet - highestOpponentStreetBet);
  collectStreet(state);
  const contestedPot = Math.max(0, state.pot - uncalled);
  const payout = contestedPot + uncalled;
  state.pot = contestedPot;
  state.potResults = [
    {
      kind: "main",
      label: "Main",
      amount: contestedPot,
      contributors: state.players
        .filter((player) => player.totalCommitted > 0)
        .map((player) => player.id),
      eligible: [winner.id],
      winners: [winner.id],
      awards: { [winner.id]: contestedPot },
    },
  ];
  if (uncalled > 0) {
    state.potResults.push({
      kind: "return",
      label: "Uncalled return",
      amount: uncalled,
      contributors: [winner.id],
      eligible: [winner.id],
      winners: [winner.id],
      awards: { [winner.id]: uncalled },
    });
  }
  winner.stack += payout;
  winner.result = payout - winner.totalCommitted;
  state.players
    .filter((player) => player.id !== winner.id)
    .forEach((player) => {
      player.result = -player.totalCommitted;
  });
  state.winners = [winner.id];
  state.message = `${winner.name} 赢得 ${amountBB(contestedPot)}`;
  state.handComplete = true;
  state.street = "showdown";
}

type Score = [number, number, number, number, number, number];

function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 2;
}

function fiveCardScore(cards: Card[]): Score {
  const values = cards.map((card) => rankValue(card.rank)).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(values)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let i = 0; i <= unique.length - 5; i += 1) {
    if (unique[i] - unique[i + 4] === 4) {
      straightHigh = unique[i];
      break;
    }
  }
  if (flush && straightHigh) return [8, straightHigh, 0, 0, 0, 0];
  if (groups[0][1] === 4)
    return [7, groups[0][0], groups.find((group) => group[1] === 1)?.[0] ?? 0, 0, 0, 0];
  if (groups[0][1] === 3 && groups[1]?.[1] === 2)
    return [6, groups[0][0], groups[1][0], 0, 0, 0];
  if (flush) return [5, values[0], values[1], values[2], values[3], values[4]];
  if (straightHigh) return [4, straightHigh, 0, 0, 0, 0];
  if (groups[0][1] === 3) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]);
    return [3, groups[0][0], kickers[0], kickers[1], 0, 0];
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]);
    const kicker = groups.find((group) => group[1] === 1)?.[0] ?? 0;
    return [2, pairs[0], pairs[1], kicker, 0, 0];
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]);
    return [1, groups[0][0], kickers[0], kickers[1], kickers[2], 0];
  }
  return [0, values[0], values[1], values[2], values[3], values[4]];
}

function compareScore(a: Score, b: Score): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function combinations<T>(items: T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  const result: T[][] = [];
  for (let i = 0; i <= items.length - count; i += 1) {
    combinations(items.slice(i + 1), count - 1).forEach((tail) =>
      result.push([items[i], ...tail]),
    );
  }
  return result;
}

export function bestScore(cards: Card[]): Score {
  return combinations(cards, 5)
    .map(fiveCardScore)
    .sort((a, b) => compareScore(b, a))[0];
}

const SCORE_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
];

export function handName(cards: Card[]): string {
  if (cards.length < 5) return "未成牌";
  return SCORE_NAMES[bestScore(cards)[0]];
}

function combinationCount(total: number, count: number): number {
  const chosen = Math.min(count, total - count);
  let result = 1;
  for (let index = 1; index <= chosen; index += 1) {
    result = (result * (total - chosen + index)) / index;
  }
  return Math.round(result);
}

function visitCombinations<T>(
  items: T[],
  count: number,
  visit: (selection: T[]) => void,
  start = 0,
  selection: T[] = [],
): void {
  if (selection.length === count) {
    visit([...selection]);
    return;
  }
  const remaining = count - selection.length;
  for (let index = start; index <= items.length - remaining; index += 1) {
    selection.push(items[index]);
    visitCombinations(items, count, visit, index + 1, selection);
    selection.pop();
  }
}

function seededRandom(seedValue: number): () => number {
  let seed = seedValue >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stateSeed(state: GameState): number {
  const text = [
    state.handNo,
    ...state.community.map(cardCode),
    ...state.players.flatMap((player) => player.hole.map(cardCode)),
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------------ *
 * 快速牌力评估
 *
 * 摊牌时用 `bestScore` 就够了——一手牌只跑一次，慢一点没人察觉。但全下 EV 要把所有可能的
 * 发牌走一遍：翻前是 C(36,5) = 376,992 个牌面，每个牌面还要给 2-4 个人各评一次。`bestScore`
 * 的做法是枚举 C(7,5)=21 个五张组合，每个组合再建一个 Map、开几个数组、排两次序——实测
 * 74-125μs 一次，穷举要 28-47 秒，只能退回蒙特卡洛，于是 EV 带上了 ±0.6-1.2BB 的抽样误差。
 *
 * 下面这个版本把七张牌直接压成一个可比大小的整数，全程零分配：类别占 4 位，5 张决胜牌各占
 * 4 位。同一手牌的结论必须和 `bestScore` 完全一致——`tests/hand-value.test.mjs` 拿 30 万手
 * 随机牌逐一对照两者的胜负判定。
 * ------------------------------------------------------------------ */

/** 0-51：花色 × 13 + 点数下标（点数下标 0 是 2，12 是 A）。 */
function cardIndex(card: Card): number {
  return SUITS.indexOf(card.suit) * 13 + RANKS.indexOf(card.rank);
}

/**
 * 顺子的最大点数（真实点数 5-14），没有顺子返回 0。
 * mask 的第 r 位代表点数 r+2。A 会额外复制一份到最低位，用来认 A2345 这种轮子。
 */
function straightHigh(mask: number): number {
  const extended = (mask << 1) | ((mask >> 12) & 1);
  for (let top = 13; top >= 4; top -= 1) {
    if (((extended >> (top - 4)) & 0b11111) === 0b11111) return top + 1;
  }
  return 0;
}

/** 从高到低取 mask 里最大的 count 个点数，写进 out，返回实际取到几个。 */
function topRanks(mask: number, count: number, out: number[]): number {
  let found = 0;
  for (let r = 12; r >= 0 && found < count; r -= 1) {
    if ((mask >> r) & 1) {
      out[found] = r + 2;
      found += 1;
    }
  }
  for (let i = found; i < count; i += 1) out[i] = 0;
  return found;
}

/** 类别 + 5 张决胜牌打包成一个整数，直接用 < > 比较。 */
function packValue(category: number, a: number, b: number, c: number, d: number, e: number): number {
  return ((((category * 16 + a) * 16 + b) * 16 + c) * 16 + d) * 16 + e;
}

// 模块级暂存区：EV 穷举会调用几十万次，每次新建数组的开销比评估本身还大。
const rankCountScratch = new Int32Array(13);
const suitMaskScratch = new Int32Array(4);
const kickerScratch: number[] = [0, 0, 0, 0, 0];

/** 七张牌（0-51 下标）的牌力值。越大越强，可直接与另一手的返回值比较。 */
function handValue(cards: Int32Array): number {
  rankCountScratch.fill(0);
  suitMaskScratch.fill(0);
  let rankMask = 0;
  for (let i = 0; i < 7; i += 1) {
    const index = cards[i];
    const rank = index % 13;
    rankCountScratch[rank] += 1;
    suitMaskScratch[(index / 13) | 0] |= 1 << rank;
    rankMask |= 1 << rank;
  }

  let flushSuit = -1;
  for (let suit = 0; suit < 4; suit += 1) {
    let bits = suitMaskScratch[suit];
    let size = 0;
    while (bits) {
      bits &= bits - 1;
      size += 1;
    }
    if (size >= 5) {
      flushSuit = suit;
      break;
    }
  }
  if (flushSuit >= 0) {
    const straightFlush = straightHigh(suitMaskScratch[flushSuit]);
    if (straightFlush) return packValue(8, straightFlush, 0, 0, 0, 0);
  }

  let quad = -1;
  let trips = -1;
  let secondTrips = -1;
  let pair = -1;
  let secondPair = -1;
  for (let rank = 12; rank >= 0; rank -= 1) {
    const size = rankCountScratch[rank];
    if (size === 4) {
      if (quad < 0) quad = rank;
    } else if (size === 3) {
      if (trips < 0) trips = rank;
      else if (secondTrips < 0) secondTrips = rank;
    } else if (size === 2) {
      if (pair < 0) pair = rank;
      else if (secondPair < 0) secondPair = rank;
    }
  }

  if (quad >= 0) {
    topRanks(rankMask & ~(1 << quad), 1, kickerScratch);
    return packValue(7, quad + 2, kickerScratch[0], 0, 0, 0);
  }
  if (trips >= 0 && (pair >= 0 || secondTrips >= 0)) {
    // 两组三条时，小的那组当葫芦的对子——它可能比场上任何一对都大。
    const filler = secondTrips > pair ? secondTrips : pair;
    return packValue(6, trips + 2, filler + 2, 0, 0, 0);
  }
  if (flushSuit >= 0) {
    topRanks(suitMaskScratch[flushSuit], 5, kickerScratch);
    return packValue(5, kickerScratch[0], kickerScratch[1], kickerScratch[2], kickerScratch[3], kickerScratch[4]);
  }
  const straight = straightHigh(rankMask);
  if (straight) return packValue(4, straight, 0, 0, 0, 0);
  if (trips >= 0) {
    topRanks(rankMask & ~(1 << trips), 2, kickerScratch);
    return packValue(3, trips + 2, kickerScratch[0], kickerScratch[1], 0, 0);
  }
  if (pair >= 0 && secondPair >= 0) {
    topRanks(rankMask & ~(1 << pair) & ~(1 << secondPair), 1, kickerScratch);
    return packValue(2, pair + 2, secondPair + 2, kickerScratch[0], 0, 0);
  }
  if (pair >= 0) {
    topRanks(rankMask & ~(1 << pair), 3, kickerScratch);
    return packValue(1, pair + 2, kickerScratch[0], kickerScratch[1], kickerScratch[2], 0);
  }
  topRanks(rankMask, 5, kickerScratch);
  return packValue(0, kickerScratch[0], kickerScratch[1], kickerScratch[2], kickerScratch[3], kickerScratch[4]);
}

/**
 * 测试入口：把 7 张牌交给快速评估器。生产代码不用它——EV 穷举直接走 `handValue`，
 * 但没有这个出口就没法逐手对照 `bestScore`，而这两者永远一致正是全下 EV 可信的前提。
 */
export function handStrengthValue(cards: Card[]): number {
  if (cards.length !== 7) throw new Error("handStrengthValue 只接受 7 张牌");
  const buffer = new Int32Array(7);
  for (let i = 0; i < 7; i += 1) buffer[i] = cardIndex(cards[i]);
  return handValue(buffer);
}

/**
 * 和牌面无关的部分只算一次：底池分层、每层谁有资格、每个人的底牌。
 * 穷举内层循环只需要填入公共牌再比大小。
 */
interface PayoutPlan {
  /** 每个参与者的 7 张牌缓冲，前 2 张是底牌，后 5 张每次填入新牌面。 */
  hands: Int32Array[];
  values: Float64Array;
  /** 每一层边池的金额，以及有资格分它的参与者在 hands 里的下标。 */
  levels: Array<{ amount: number; eligible: number[] }>;
  heroSlot: number;
}

function buildPayoutPlan(state: GameState): PayoutPlan | null {
  const hero = state.players.find((player) => player.isHero);
  if (!hero || hero.folded) return null;
  const contenders = livePlayers(state.players);
  const heroSlot = contenders.indexOf(hero);
  if (heroSlot < 0) return null;

  const hands = contenders.map((player) => {
    const buffer = new Int32Array(7);
    buffer[0] = cardIndex(player.hole[0]);
    buffer[1] = cardIndex(player.hole[1]);
    return buffer;
  });

  const levels: PayoutPlan["levels"] = [];
  const boundaries = [
    ...new Set(state.players.map((player) => player.totalCommitted).filter((value) => value > 0)),
  ].sort((a, b) => a - b);
  let previous = 0;
  for (const boundary of boundaries) {
    // 弃牌的人也出了钱，所以出资人数按全桌算，有资格拿的人只算还在牌里的。
    const contributors = state.players.filter((player) => player.totalCommitted >= boundary).length;
    const amount = (boundary - previous) * contributors;
    previous = boundary;
    const eligible: number[] = [];
    contenders.forEach((player, slot) => {
      if (player.totalCommitted >= boundary) eligible.push(slot);
    });
    if (amount > 0 && eligible.length > 0) levels.push({ amount, eligible });
  }

  return { hands, values: new Float64Array(hands.length), levels, heroSlot };
}

/** 给定完整牌面，英雄能收回多少筹码（含退还给自己的未被跟注部分）。 */
function heroPayoutForPlan(plan: PayoutPlan, board: Int32Array): number {
  for (let slot = 0; slot < plan.hands.length; slot += 1) {
    const hand = plan.hands[slot];
    for (let i = 0; i < 5; i += 1) hand[i + 2] = board[i];
    plan.values[slot] = handValue(hand);
  }
  let payout = 0;
  for (const level of plan.levels) {
    let best = -1;
    let winners = 0;
    let heroWins = false;
    for (const slot of level.eligible) {
      const value = plan.values[slot];
      if (value > best) {
        best = value;
        winners = 1;
        heroWins = slot === plan.heroSlot;
      } else if (value === best) {
        winners += 1;
        if (slot === plan.heroSlot) heroWins = true;
      }
    }
    if (heroWins) payout += level.amount / winners;
  }
  return payout;
}

export function calculateHeroAllInEv(state: GameState): AllInEvRecord | null {
  const hero = state.players.find((player) => player.isHero);
  const contenders = livePlayers(state.players);
  const missingBoardCards = 5 - state.community.length;
  if (
    !hero ||
    hero.folded ||
    contenders.length < 2 ||
    missingBoardCards <= 0 ||
    state.deck.length < missingBoardCards
  ) {
    return null;
  }

  const plan = buildPayoutPlan(state);
  if (!plan) return null;

  const possibleRunouts = combinationCount(state.deck.length, missingBoardCards);
  /**
   * 上限设在 40 万，是因为这副牌里最坏的情况正好在下面：八个人都发了牌，牌堆剩 36 张，
   * 翻前全下要补 5 张，C(36,5) = 376,992。也就是说这个游戏里的每一次全下 EV 都能穷举，
   * 抽样误差直接归零。（原来的上限是 5 万，翻前一律走蒙特卡洛。）
   */
  const exact = possibleRunouts <= 400_000;
  const trialLimit = 200_000;
  let trials = 0;
  let payoutTotal = 0;
  let payoutSquaredTotal = 0;

  // 公共牌固定在前面，每次只改后面补出来的那几张。
  const board = new Int32Array(5);
  for (let i = 0; i < state.community.length; i += 1) board[i] = cardIndex(state.community[i]);
  const deckIndices = new Int32Array(state.deck.length);
  for (let i = 0; i < state.deck.length; i += 1) deckIndices[i] = cardIndex(state.deck[i]);
  const known = state.community.length;

  const scoreRunout = () => {
    const payout = heroPayoutForPlan(plan, board);
    payoutTotal += payout;
    payoutSquaredTotal += payout * payout;
    trials += 1;
  };

  if (exact) {
    // 迭代式组合枚举，比递归回调省掉每个牌面一次数组分配。
    const pick = new Int32Array(missingBoardCards);
    for (let i = 0; i < missingBoardCards; i += 1) pick[i] = i;
    const last = missingBoardCards - 1;
    const limit = deckIndices.length;
    for (;;) {
      for (let i = 0; i < missingBoardCards; i += 1) board[known + i] = deckIndices[pick[i]];
      scoreRunout();
      let cursor = last;
      while (cursor >= 0 && pick[cursor] === limit - missingBoardCards + cursor) cursor -= 1;
      if (cursor < 0) break;
      pick[cursor] += 1;
      for (let i = cursor + 1; i < missingBoardCards; i += 1) pick[i] = pick[i - 1] + 1;
    }
  } else {
    const random = seededRandom(stateSeed(state));
    const pool = new Int32Array(deckIndices);
    for (let trial = 0; trial < trialLimit; trial += 1) {
      for (let slot = 0; slot < missingBoardCards; slot += 1) {
        const chosen = slot + Math.floor(random() * (pool.length - slot));
        const swap = pool[slot];
        pool[slot] = pool[chosen];
        pool[chosen] = swap;
        board[known + slot] = pool[slot];
      }
      scoreRunout();
    }
  }

  const expectedPayout = payoutTotal / trials;
  const payoutVariance = Math.max(
    0,
    payoutSquaredTotal / trials - expectedPayout * expectedPayout,
  );
  return {
    street: state.street as Exclude<Street, "showdown">,
    expectedResult: expectedPayout - hero.totalCommitted,
    expectedPayout,
    heroCommitted: hero.totalCommitted,
    pot: totalPot(state),
    method: exact ? "exact" : "monte-carlo",
    trials,
    standardError: exact ? 0 : Math.sqrt(payoutVariance / trials),
  };
}

export function heroEvSummary(state: GameState): HeroEvSummary | null {
  const hero = state.players.find((player) => player.isHero);
  if (!hero || !state.heroAllInEv || !state.handComplete) return null;
  const actualResult = hero.stack - state.heroStartStack;
  return {
    ...state.heroAllInEv,
    actualResult,
    luck: actualResult - state.heroAllInEv.expectedResult,
  };
}

function showdown(state: GameState): void {
  collectStreet(state);
  const contenders = livePlayers(state.players);
  const ranked = contenders.map((player) => ({
    player,
    score: bestScore([...player.hole, ...state.community]),
  }));
  const scores = new Map(ranked.map((entry) => [entry.player.id, entry.score]));
  const payouts = new Map<string, number>();
  const winnerIds = new Set<string>();
  const potResults: PotResult[] = [];
  const levels = [...new Set(state.players.map((player) => player.totalCommitted).filter((value) => value > 0))].sort(
    (a, b) => a - b,
  );
  let previousLevel = 0;
  let sidePotNumber = 0;

  levels.forEach((level) => {
    const contributors = state.players.filter((player) => player.totalCommitted >= level);
    const sidePot = (level - previousLevel) * contributors.length;
    previousLevel = level;
    const eligible = contenders.filter((player) => player.totalCommitted >= level);
    if (sidePot <= 0 || eligible.length === 0) return;
    if (contributors.length === 1 && eligible.length === 1) {
      const player = eligible[0];
      player.stack += sidePot;
      payouts.set(player.id, (payouts.get(player.id) ?? 0) + sidePot);
      potResults.push({
        kind: "return",
        label: "Uncalled return",
        amount: sidePot,
        contributors: [player.id],
        eligible: [player.id],
        winners: [player.id],
        awards: { [player.id]: sidePot },
      });
      return;
    }
    let top = scores.get(eligible[0].id) as Score;
    eligible.slice(1).forEach((player) => {
      const score = scores.get(player.id) as Score;
      if (compareScore(score, top) > 0) top = score;
    });
    const sideWinners = eligible.filter(
      (player) => compareScore(scores.get(player.id) as Score, top) === 0,
    );
    const share = Math.floor(sidePot / sideWinners.length);
    let remainder = sidePot - share * sideWinners.length;
    const awards: Record<string, number> = {};
    sideWinners.forEach((player) => {
      const award = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      player.stack += award;
      payouts.set(player.id, (payouts.get(player.id) ?? 0) + award);
      winnerIds.add(player.id);
      awards[player.id] = award;
    });
    const contributorIds = contributors.map((player) => player.id);
    const eligibleIds = eligible.map((player) => player.id);
    const winnerIdList = sideWinners.map((player) => player.id);
    const previousPot = potResults.at(-1);
    const sameEligibility =
      previousPot?.kind !== "return" &&
      previousPot?.eligible.length === eligibleIds.length &&
      previousPot.eligible.every((id, index) => id === eligibleIds[index]);
    if (previousPot && sameEligibility) {
      previousPot.amount += sidePot;
      previousPot.contributors = [
        ...new Set([...previousPot.contributors, ...contributorIds]),
      ];
      winnerIdList.forEach((playerId) => {
        previousPot.awards[playerId] =
          (previousPot.awards[playerId] ?? 0) + (awards[playerId] ?? 0);
      });
    } else {
      const kind = potResults.some((pot) => pot.kind === "main") ? "side" : "main";
      if (kind === "side") sidePotNumber += 1;
      potResults.push({
        kind,
        label: kind === "main" ? "Main" : `Side ${sidePotNumber}`,
        amount: sidePot,
        contributors: contributorIds,
        eligible: eligibleIds,
        winners: winnerIdList,
        awards,
      });
    }
  });
  state.potResults = potResults;
  state.pot = potResults
    .filter((pot) => pot.kind !== "return")
    .reduce((sum, pot) => sum + pot.amount, 0);
  state.players.forEach((player) => {
    player.result = (payouts.get(player.id) ?? 0) - player.totalCommitted;
  });
  contenders.forEach((player) => state.revealed.push(player.id));
  state.winners = [...winnerIds];
  const bestOverall = ranked
    .map((entry) => entry.score)
    .sort((a, b) => compareScore(b, a))[0];
  state.message = `${state.winners
    .map((id) => state.players.find((player) => player.id === id)?.name)
    .filter(Boolean)
    .join(" / ")} · ${SCORE_NAMES[bestOverall[0]]}`;
  state.handComplete = true;
  state.street = "showdown";
}

function runout(state: GameState): void {
  while (state.community.length < 5) {
    const count = state.community.length === 0 ? 3 : 1;
    state.community.push(...drawStreet(state, count));
  }
  showdown(state);
}

function advanceStreet(state: GameState): void {
  collectStreet(state);
  const actors = state.players.filter(canAct);

  /*
   * 什么时候给全下 EV 拍快照。
   *
   * 原来的条件是「桌上最多只剩一个人还能行动」，也就是只有牌局要一路发到河牌时才记。这漏掉了
   * 一整类牌：英雄在翻牌全下，后面还有两个带筹码的对手——他们在转牌、河牌继续过牌，牌局
   * 从来没有进入「只剩一个人能动」的状态，于是这手全下根本不产生 EV 记录，直接按实际输赢
   * 计入，运气全算在英雄头上。三人以上的池子里这种情况并不少见。
   *
   * 新条件：只要英雄自己已经动不了了（全下），牌还没发完，桌上还有至少两个人在牌里，就在
   * 这条街结算完的瞬间拍下快照。之所以等到街结束而不是英雄一推就拍，是因为同一条街后面的人
   * 还可能弃牌——按已经结清的这条街来算，对手名单才是确定的。
   */
  const hero = state.players.find((player) => player.isHero);
  const heroLocked = Boolean(hero) && !hero!.folded && !canAct(hero!);
  if (!state.heroAllInEv && state.community.length < 5 && (actors.length <= 1 || heroLocked)) {
    state.heroAllInEv = calculateHeroAllInEv(state);
  }

  if (actors.length <= 1) {
    runout(state);
    return;
  }
  if (state.community.length === 0) {
    state.community.push(...drawStreet(state, 3));
    state.street = "flop";
  } else if (state.community.length === 3) {
    state.community.push(...drawStreet(state, 1));
    state.street = "turn";
  } else if (state.community.length === 4) {
    state.community.push(...drawStreet(state, 1));
    state.street = "river";
  } else {
    showdown(state);
    return;
  }
  state.actingIndex = firstPostflopActor(state.players, state.dealerIndex);
  state.message = `${state.street.toUpperCase()} · ${state.players[state.actingIndex].position} 行动`;
}

export function applyAction(
  current: GameState,
  kind: ActionKind,
  requestedTo?: number,
): GameState {
  if (current.handComplete) return current;
  const state = cloneState(current);
  const player = state.players[state.actingIndex];
  if (!legalActions(state, player).includes(kind)) return current;

  const potBefore = totalPot(state);
  const previousCurrentBet = state.currentBet;
  let amount = 0;
  let toAmount = player.streetBet;

  if (kind === "fold") {
    player.folded = true;
    player.acted = true;
  } else if (kind === "check") {
    player.acted = true;
  } else if (kind === "call") {
    amount = pay(player, Math.max(0, state.currentBet - player.streetBet));
    toAmount = player.streetBet;
    player.acted = true;
  } else {
    const oldCurrent = state.currentBet;
    const maxTo = player.streetBet + player.stack;
    const minimumTo = Math.min(maxTo, oldCurrent + state.minRaise);
    const target =
      kind === "allin"
        ? maxTo
        : Math.max(minimumTo, Math.min(maxTo, requestedTo ?? minimumTo));
    amount = pay(player, target - player.streetBet);
    toAmount = player.streetBet;
    if (toAmount > oldCurrent) {
      const raiseSize = toAmount - oldCurrent;
      if (raiseSize >= state.minRaise) {
        state.minRaise = raiseSize;
        state.players.forEach((other) => {
          if (canAct(other)) {
            other.acted = false;
            other.raiseLocked = false;
          }
        });
      } else {
        state.players.forEach((other) => {
          if (!canAct(other) || other.id === player.id) return;
          if (other.acted) other.raiseLocked = true;
          if (other.streetBet < toAmount) other.acted = false;
        });
      }
      state.currentBet = toAmount;
    }
    player.acted = true;
  }

  const label = actionLabel(state, player, kind, amount, previousCurrentBet);
  player.lastAction = label;
  state.actions.push({
    street: state.street,
    playerId: player.id,
    position: player.position,
    name: player.name,
    kind,
    amount,
    toAmount,
    facedBet: previousCurrentBet,
    allInAfterAction: player.allIn,
    potBefore,
    label,
  });

  if (livePlayers(state.players).length === 1) {
    awardSingleWinner(state);
    return state;
  }

  if (streetComplete(state)) {
    advanceStreet(state);
    return state;
  }

  state.actingIndex = nextActor(state.players, state.actingIndex);
  state.message = `${state.players[state.actingIndex].position} 行动`;
  return state;
}

export function preflopStrength(cards: Card[]): number {
  const [a, b] = cards;
  const high = Math.max(rankValue(a.rank), rankValue(b.rank));
  const low = Math.min(rankValue(a.rank), rankValue(b.rank));
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = high - low;
  let score = (high - 2) / 12 * 0.46 + (low - 2) / 12 * 0.18;
  if (pair) score += 0.27 + (high - 2) / 12 * 0.16;
  if (suited) score += 0.06;
  if (gap <= 1) score += 0.05;
  else if (gap >= 4) score -= 0.05;
  if (high === 14) score += 0.06;
  return Math.max(0, Math.min(1, score));
}

function postflopStrength(cards: Card[], board: Card[]): number {
  const all = [...cards, ...board];
  if (all.length >= 5) {
    const category = bestScore(all)[0];
    const base = [0.14, 0.38, 0.58, 0.7, 0.76, 0.82, 0.91, 0.97, 1][category];
    return Math.min(1, base + Math.random() * 0.06);
  }
  return preflopStrength(cards) * 0.68;
}

function randomRaiseTo(state: GameState, player: Player, aggression: number): number {
  const maxTo = player.streetBet + player.stack;
  const minTo = Math.min(maxTo, state.currentBet + state.minRaise);
  if (state.street === "preflop") {
    const firstRaise = state.actions.every((action) => action.kind !== "raise");
    const target = firstRaise
      ? BIG_BLIND * (aggression > 0.86 ? 3.5 : 2.5)
      : Math.max(state.currentBet * (aggression > 0.75 ? 3.2 : 2.6), minTo);
    return Math.min(maxTo, Math.round(target));
  }
  const pot = totalPot(state);
  const multiplier =
    aggression > 0.88 ? [0.75, 1.25][Math.floor(Math.random() * 2)] : aggression > 0.55 ? 0.66 : 0.42;
  return Math.min(maxTo, Math.max(minTo, Math.round(state.currentBet + pot * multiplier)));
}

export function preflopHandClass(cards: Card[]): string {
  const [a, b] = cards;
  const high = rankValue(a.rank) >= rankValue(b.rank) ? a : b;
  const low = high === a ? b : a;
  if (high.rank === low.rank) return `${high.rank}${low.rank}`;
  return `${high.rank}${low.rank}${high.suit === low.suit ? "s" : "o"}`;
}

function raiseCountThisStreet(state: GameState): number {
  return state.actions.filter(
    (action) =>
      action.street === state.street &&
      (action.kind === "raise" || action.kind === "allin") &&
      action.toAmount > action.facedBet,
  ).length;
}

export function localBotDecision(
  state: GameState,
  player: Player,
): { action: ActionKind; raiseTo?: number } {
  const persona = player.persona;
  const legal = legalActions(state, player);
  const toCall = Math.max(0, state.currentBet - player.streetBet);
  const pot = Math.max(BIG_BLIND, totalPot(state));
  const callPressure = toCall / (pot + toCall);
  const strength =
    state.street === "preflop"
      ? preflopStrength(player.hole)
      : postflopStrength(player.hole, state.community);
  const noise = (Math.random() - 0.5) * (0.26 + persona.bluff * 0.18);
  const adjusted = strength + noise + (persona.looseness - 0.5) * 0.23;
  const canRaise = legal.includes("raise");
  const jamPressure = player.stack <= pot * 1.15 || player.persona.id === "short";
  const raiseDepth = raiseCountThisStreet(state);

  if (state.street === "preflop" && toCall > 0 && raiseDepth >= 3) {
    const hand = preflopHandClass(player.hole);
    const call = legal.includes("call") ? { action: "call" as const } : { action: "fold" as const };
    if (raiseDepth >= 5) {
      return hand === "AA" || hand === "KK" ? call : { action: "fold" };
    }
    if (raiseDepth >= 4) {
      return ["AA", "KK", "AKs"].includes(hand) ? call : { action: "fold" };
    }
    if (hand === "AA" || hand === "KK") {
      if (canRaise && player.stack <= pot * 1.35) return { action: "allin" };
      return call;
    }
    if (["QQ", "AKs", "AKo"].includes(hand)) return call;
    if (
      ["boss", "maniac"].includes(persona.id) &&
      ["JJ", "AQs"].includes(hand) &&
      callPressure <= 0.34
    ) {
      return call;
    }
    return { action: "fold" };
  }

  if (canRaise && jamPressure && adjusted > 0.66 - persona.aggression * 0.12) {
    return { action: "allin" };
  }
  if (
    canRaise &&
    adjusted > 0.63 - persona.aggression * 0.18 &&
    Math.random() < persona.aggression
  ) {
    return {
      action: "raise",
      raiseTo: randomRaiseTo(state, player, persona.aggression),
    };
  }
  if (toCall === 0) {
    if (
      canRaise &&
      adjusted > 0.42 - persona.aggression * 0.15 &&
      Math.random() < persona.aggression * 0.78
    ) {
      return {
        action: "raise",
        raiseTo: randomRaiseTo(state, player, persona.aggression),
      };
    }
    return { action: "check" };
  }
  const callThreshold =
    0.49 -
    persona.looseness * 0.24 +
    callPressure * 0.5 -
    (persona.id === "station" ? 0.17 : 0);
  if (adjusted >= callThreshold || Math.random() < persona.looseness * 0.08) {
    return { action: "call" };
  }
  return { action: "fold" };
}

const SUIT_WORDS: Record<Suit, string> = {
  s: "spades",
  h: "hearts",
  d: "diamonds",
  c: "clubs",
};
const SUIT_WORD_SINGULAR: Record<Suit, string> = {
  s: "spade",
  h: "heart",
  d: "diamond",
  c: "club",
};

/** Distinct ranks inside the tightest five-rank window (aces count high and low). */
function straightWindow(cards: Card[]): number {
  const values = [...new Set(cards.map((card) => rankValue(card.rank)))];
  if (values.includes(14)) values.push(1);
  let best = 0;
  for (const low of values) {
    const inWindow = new Set(values.filter((value) => value >= low && value <= low + 4)).size;
    if (inWindow > best) best = inWindow;
  }
  return best;
}

function textureCore(cards: Card[]) {
  const suitCounts = new Map<Suit, number>();
  cards.forEach((card) => suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1));
  let suit: Suit | null = null;
  let maxSuitCount = 0;
  suitCounts.forEach((count, key) => {
    if (count > maxSuitCount) {
      maxSuitCount = count;
      suit = key;
    }
  });
  const rankCounts = new Map<Rank, number>();
  cards.forEach((card) => rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1));
  const topRank = Math.max(0, ...[...rankCounts.values()]);
  return {
    suit,
    maxSuitCount,
    paired: topRank >= 2,
    tripsOnBoard: topRank >= 3,
    straightCards: straightWindow(cards),
  };
}

/**
 * Classify the board so the model never has to infer texture from raw card codes.
 * See BoardTexture — this exists because it demonstrably got that wrong.
 */
export function describeBoard(community: Card[]): BoardTexture | undefined {
  if (community.length < 3) return undefined;
  const core = textureCore(community);
  const toCome = 5 - community.length;
  const suitName = core.suit ? SUIT_WORDS[core.suit as Suit] : "";
  const suitOne = core.suit ? SUIT_WORD_SINGULAR[core.suit as Suit] : "";
  const flushPossible = core.maxSuitCount >= 3;
  const flushDrawLive = core.maxSuitCount === 2 && toCome > 0;
  const straightPossible = core.straightCards >= 5;

  let lastCardEffect = "";
  if (community.length > 3) {
    const before = textureCore(community.slice(0, -1));
    const card = community[community.length - 1];
    const effects: string[] = [];
    if (core.maxSuitCount >= 3 && before.maxSuitCount < 3) {
      effects.push(`brought the third ${suitOne} — a flush is now possible`);
    } else if (core.maxSuitCount > before.maxSuitCount && core.maxSuitCount >= 4) {
      effects.push(`added a fourth ${suitOne}`);
    }
    if (core.paired && !before.paired) effects.push("paired the board");
    if (core.tripsOnBoard && !before.tripsOnBoard) effects.push("made trips on board");
    if (core.straightCards > before.straightCards) {
      effects.push(
        core.straightCards >= 5
          ? "completed a straight on board"
          : `made it ${core.straightCards} to a straight`,
      );
    }
    const highest = Math.max(...community.slice(0, -1).map((other) => rankValue(other.rank)));
    if (rankValue(card.rank) > highest) effects.push("is the new highest card and hits overcard hands");
    lastCardEffect = effects.length > 0 ? `${cardCode(card)} ${effects.join(", ")}` : `${cardCode(card)} is a blank`;
  }

  const suitText =
    core.maxSuitCount >= 5 || (core.maxSuitCount === community.length && community.length >= 3)
      ? `monotone (${core.maxSuitCount} ${suitName})`
      : flushPossible
        ? `${core.maxSuitCount} ${suitName} — a flush is already possible`
        : core.maxSuitCount === 2
          ? `two-tone (2 ${suitName}${toCome > 0 ? ", flush draws live" : ""})`
          : "rainbow";
  const pairText = core.tripsOnBoard ? "trips on board" : core.paired ? "PAIRED" : "unpaired";
  const straightText =
    core.straightCards >= 5
      ? "a straight is already on board"
      : `${core.straightCards} to a straight`;
  const summary = [
    community.map(cardCode).join(" "),
    pairText,
    suitText,
    straightText,
    lastCardEffect,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    cards: community.length,
    paired: core.paired,
    tripsOnBoard: core.tripsOnBoard,
    maxSuitCount: core.maxSuitCount,
    suit: core.suit,
    monotone: core.maxSuitCount === community.length,
    twoTone: core.maxSuitCount === 2,
    rainbow: core.maxSuitCount === 1,
    flushPossible,
    flushDrawLive,
    straightCards: core.straightCards,
    straightPossible,
    lastCardEffect,
    summary,
  };
}

/** 14 -> "ace". Used for "ace high" and for naming the ranks inside a made hand. */
const RANK_WORDS: Record<number, string> = {
  2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
  9: "nine", 10: "ten", 11: "jack", 12: "queen", 13: "king", 14: "ace",
};
const RANK_PLURALS: Record<number, string> = {
  2: "twos", 3: "threes", 4: "fours", 5: "fives", 6: "sixes", 7: "sevens", 8: "eights",
  9: "nines", 10: "tens", 11: "jacks", 12: "queens", 13: "kings", 14: "aces",
};
/** Which board card the pair is made with, counting distinct board ranks from the top. */
const PAIR_ORDINALS = ["top", "second", "third", "fourth", "fifth"];

function rankWord(value: number): string {
  return RANK_WORDS[value] ?? String(value);
}

function rankPlural(value: number): string {
  return RANK_PLURALS[value] ?? `${value}s`;
}

/** 11 -> "J". The short form used inside parentheses, e.g. `top pair (J)`. */
function rankChar(value: number): string {
  return RANKS[value - 2] ?? String(value);
}

/** "an A kicker" / "an 8 kicker", but "a K kicker" — the article follows how the rank is said. */
function rankArticle(value: number): string {
  return value === 14 || value === 8 ? "an" : "a";
}

interface TaggedCard {
  card: Card;
  hole: boolean;
}

/** The best five, with each card still labelled as hole or board so we can say whether the
 *  player's own cards are doing any work. */
function bestFiveTagged(cards: TaggedCard[]): { score: Score; used: TaggedCard[] } {
  const options = combinations(cards, 5);
  let bestScoreSoFar = fiveCardScore(options[0].map((entry) => entry.card));
  let bestUsed = options[0];
  for (let index = 1; index < options.length; index += 1) {
    const score = fiveCardScore(options[index].map((entry) => entry.card));
    if (compareScore(score, bestScoreSoFar) > 0) {
      bestScoreSoFar = score;
      bestUsed = options[index];
    }
  }
  return { score: bestScoreSoFar, used: bestUsed };
}

/**
 * One factual sentence about what this hand IS right now — not advice, not an evaluation.
 *
 * Published analysis of LLM poker agents (and our own hand log) shows the model losing track of
 * its own holding: it will call a board-paired second pair "top pair" and reason from there. So
 * the category AND its relation to the board are computed here and handed over as text.
 *
 * Preflop there is no board to relate to, so this returns undefined.
 */
export function describeHoleStrength(hole: Card[], community: Card[]): string | undefined {
  if (!Array.isArray(hole) || hole.length < 2) return undefined;
  if (!Array.isArray(community) || community.length < 3) return undefined;

  const tagged: TaggedCard[] = [
    ...hole.map((card) => ({ card, hole: true })),
    ...community.map((card) => ({ card, hole: false })),
  ];
  const { score, used } = bestFiveTagged(tagged);
  const category = score[0];
  const usesHole = used.some((entry) => entry.hole);
  // Distinct board ranks, highest first: "top pair" means the highest of these.
  const boardRanks = [...new Set(community.map((card) => rankValue(card.rank)))].sort(
    (a, b) => b - a,
  );
  const holeRanks = hole.map((card) => rankValue(card.rank));
  const pocketPair = holeRanks[0] === holeRanks[1];

  let text: string;
  if (category === 8) {
    text = `a straight flush, ${rankWord(score[1])} high`;
  } else if (category === 7) {
    text = `four of a kind, ${rankPlural(score[1])}`;
  } else if (category === 6) {
    text = `a full house, ${rankPlural(score[1])} full of ${rankPlural(score[2])}`;
  } else if (category === 5) {
    const suitCounts = new Map<Suit, number>();
    [...hole, ...community].forEach((card) =>
      suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1),
    );
    let flushSuit: Suit | null = null;
    suitCounts.forEach((count, suit) => {
      if (count >= 5) flushSuit = suit;
    });
    const suitName = flushSuit ? ` in ${SUIT_WORDS[flushSuit as Suit]}` : "";
    text = `a flush${suitName}, ${rankWord(score[1])} high`;
  } else if (category === 4) {
    text = `a straight, ${rankWord(score[1])} high`;
  } else if (category === 3) {
    const tripRank = score[1];
    const fromHole = holeRanks.filter((value) => value === tripRank).length;
    text =
      fromHole === 2
        ? `a set of ${rankPlural(tripRank)} (your pocket pair)`
        : fromHole === 1
          ? `trips, ${rankPlural(tripRank)} (one of yours, two on board)`
          : `three of a kind on the board, ${rankPlural(tripRank)}`;
  } else if (category === 2) {
    const high = score[1];
    const low = score[2];
    text = `two pair, ${rankPlural(high)} and ${rankPlural(low)}`;
  } else if (category === 1) {
    const pairRank = score[1];
    const fromHole = holeRanks.filter((value) => value === pairRank).length;
    if (pocketPair && fromHole === 2) {
      const higher = boardRanks.filter((value) => value > pairRank).length;
      text =
        higher === 0
          ? `an overpair, pocket ${rankPlural(pairRank)} above every board card`
          : `pocket ${rankPlural(pairRank)} — an underpair, ${higher} board card${
              higher === 1 ? " is" : "s are"
            } higher`;
    } else if (fromHole === 1) {
      const slot = boardRanks.indexOf(pairRank);
      const ordinal = slot >= 0 ? (PAIR_ORDINALS[slot] ?? `${slot + 1}th`) : "no";
      const kickerRank = Math.max(...holeRanks.filter((value) => value !== pairRank));
      text = `${ordinal} pair (${rankChar(pairRank)}) with ${rankArticle(kickerRank)} ${rankChar(
        kickerRank,
      )} kicker`;
    } else {
      text = `${rankPlural(pairRank)} paired on the board; you have no pair of your own, ${rankWord(
        Math.max(...holeRanks),
      )} high`;
    }
  } else {
    text = `${rankWord(score[1])} high, no pair`;
  }

  // The single most expensive mistake this function exists to prevent: betting a hand the
  // board already makes for everyone.
  return usesHole ? text : `${text} — you are playing the board, neither of your cards plays`;
}

function opponentProfileFor(state: GameState, opponent: Player): OpponentProfile {
  let preflopRaiseNo = 0;
  let aggression: 0 | 1 | 2 | 3 | 4 = 0;
  let calledRaise = false;
  let bigAggression = false;
  state.actions.forEach((action) => {
    const isRaise =
      (action.kind === "raise" || action.kind === "allin") &&
      action.toAmount > action.facedBet;
    if (action.street === "preflop") {
      if (isRaise) {
        preflopRaiseNo += 1;
        if (action.playerId === opponent.id && preflopRaiseNo > aggression) {
          aggression = Math.min(4, preflopRaiseNo) as 0 | 1 | 2 | 3 | 4;
        }
      } else if (
        action.playerId === opponent.id &&
        action.kind === "call" &&
        action.facedBet > BIG_BLIND
      ) {
        calledRaise = true;
      }
    }
    if (action.street === state.street && action.playerId === opponent.id && isRaise) {
      const increment = action.toAmount - action.facedBet;
      if (increment >= 0.75 * Math.max(action.potBefore, BIG_BLIND)) {
        bigAggression = true;
      }
    }
  });
  return {
    position: opponent.position,
    name: opponent.name,
    allIn: opponent.allIn,
    totalCommitted: opponent.totalCommitted,
    preflopAggression: aggression,
    calledRaisePreflop: calledRaise,
    bigAggressionThisStreet: bigAggression,
  };
}

export function botObservation(state: GameState, player: Player): BotObservation {
  const pot = totalPot(state);
  const toCall = Math.max(0, state.currentBet - player.streetBet);
  const opponents = state.players.filter(
    (other) => other.id !== player.id && !other.folded,
  );
  const effectiveStack = Math.min(
    startingStack(state, player),
    Math.max(0, ...opponents.map((opponent) => startingStack(state, opponent))),
  );
  return {
    handNo: state.handNo,
    street: state.street,
    position: player.position,
    holeCards: player.hole.map(cardCode),
    communityCards: state.community.map(cardCode),
    stack: player.stack,
    startingStack: startingStack(state, player),
    effectiveStack,
    pot,
    streetBet: player.streetBet,
    toCall,
    potOddsToCall: toCall > 0 ? toCall / (pot + toCall) : 0,
    spr: pot > 0 ? player.stack / pot : 0,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    minimumRaiseTo: Math.min(
      player.streetBet + player.stack,
      state.currentBet + state.minRaise,
    ),
    maximumRaiseTo: player.streetBet + player.stack,
    legalActions: legalActions(state, player),
    publicActions: state.actions.map(
      (action) => `${action.street}:${action.position} ${action.label}`,
    ),
    playersRemaining: livePlayers(state.players).length,
    opponentsAbleToAct: opponents.filter((opponent) => !opponent.allIn).length,
    raiseCountThisStreet: raiseCountThisStreet(state),
    opponentProfiles: opponents.map((opponent) => opponentProfileFor(state, opponent)),
    boardTexture: describeBoard(state.community),
    handStrength: describeHoleStrength(player.hole, state.community),
    blinds: {
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
    },
    publicPlayers: state.players.map((publicPlayer) => ({
      name: publicPlayer.name,
      position: publicPlayer.position,
      stack: publicPlayer.stack,
      startingStack: startingStack(state, publicPlayer),
      streetBet: publicPlayer.streetBet,
      totalCommitted: publicPlayer.totalCommitted,
      folded: publicPlayer.folded,
      allIn: publicPlayer.allIn,
      acted: publicPlayer.acted,
      lastAction: publicPlayer.lastAction,
    })),
  };
}

function playerActionName(action: ActionRecord, heroId: string): string {
  const who = action.playerId === heroId ? `${action.position}(hero)` : action.position;
  return `${who} ${action.label}`;
}

function playerLogName(state: GameState, playerId: string): string {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return playerId;
  return `${player.position}${player.isHero ? "(hero)" : ""}:${player.name}`;
}

function startingStack(state: GameState, player: Player): number {
  return state.startingStacks?.[player.id] ?? player.stack - player.result;
}

export interface HandLogOptions {
  /**
   * Write every seat's hole cards into the log, including folded seats. Mirrors the
   * "结算亮牌" review toggle. `state.revealed` is deliberately left alone — it records a
   * real showdown and feeds the hero profile's WTSD stat.
   */
  revealAll?: boolean;
  /**
   * 每个 AI 自己说的行动理由，一条一个元素，由调用方排好版（理由来自模型的返回值，引擎本身
   * 看不到）。以前这是一个 string，全部塞进 H# 那一行的 `Why` 段里——一行几百字，复制出来
   * 没法读，而且为了让那一行不至于失控，调用方把每条砍到 72 字、每手只留 12 条。
   * 现在改成数组：H# 行保持原样（`analyze-log.mjs` 照常解析），理由跟在它下面，一条一行。
   */
  reasons?: string[];
}

export function compactHandLog(
  state: GameState,
  sourceSuffix?: string,
  options?: HandLogOptions,
): string {
  const hero = state.players.find((player) => player.isHero) as Player;
  const streets: Street[] = ["preflop", "flop", "turn", "river"];
  const streetLabels: Record<Street, string> = {
    preflop: "PF",
    flop: "F",
    turn: "T",
    river: "R",
    showdown: "SD",
  };
  const communityByStreet: Partial<Record<Street, string>> = {
    flop: state.community.slice(0, 3).map(cardCode).join(""),
    turn: state.community[3] ? cardCode(state.community[3]) : "",
    river: state.community[4] ? cardCode(state.community[4]) : "",
  };
  const actionText = streets
    .map((street) => {
      const actions = state.actions
        .filter((action) => action.street === street)
        .map((action) => playerActionName(action, hero.id))
        .join(" ");
      const boardCards = communityByStreet[street] ?? "";
      if (!actions && street !== "preflop" && !boardCards) return "";
      const board = street === "preflop" ? "" : ` ${communityByStreet[street] ?? ""}`;
      return `${streetLabels[street]}${board} ${actions}`.trim();
    })
    .filter(Boolean)
    .join(" | ");
  const heroCards = hero.hole.map(cardCode).join("");
  const winnerText = state.winners
    .map((id) => state.players.find((player) => player.id === id)?.name)
    .filter(Boolean)
    .join("/");
  const result = hero.stack - state.heroStartStack;
  const resultText = `${result >= 0 ? "+" : ""}${amountBB(result)}`;
  const ev = heroEvSummary(state);
  const evText = ev
    ? ` | All-in EV ${ev.expectedResult >= 0 ? "+" : ""}${amountBB(ev.expectedResult)} | Luck ${ev.luck >= 0 ? "+" : ""}${amountBB(ev.luck)} ${ev.method === "exact" ? "[exact]" : `[MC ${ev.trials}]`}`
    : "";
  // Names on every seat: the pot summary only names winners, which left reviews guessing
  // which persona sat where.
  const stackText = state.players
    .map(
      (player) =>
        `${playerLogName(state, player.id)} ${amountBB(startingStack(state, player))}`,
    )
    .join("; ");
  const relevantOpponents = state.players.filter(
    (player) =>
      !player.isHero &&
      (player.totalCommitted > BIG_BLIND ||
        state.revealed.includes(player.id) ||
        state.winners.includes(player.id)),
  );
  const effectiveText = relevantOpponents
    .map(
      (player) =>
        `${player.position} ${amountBB(
          Math.min(startingStack(state, hero), startingStack(state, player)),
        )}`,
    )
    .join("; ");
  const committedText = state.players
    .filter((player) => player.totalCommitted > 0)
    .map(
      (player) =>
        `${player.position}${player.isHero ? "(hero)" : ""} ${amountBB(player.totalCommitted)}${player.allIn ? " [all-in]" : ""}`,
    )
    .join("; ");
  const revealAll = Boolean(options?.revealAll);
  const cardPlayers = state.players.filter(
    (player) =>
      revealAll ||
      player.isHero ||
      state.revealed.includes(player.id) ||
      player.totalCommitted > BIG_BLIND * 2,
  );
  const cardsText = cardPlayers
    .map((player) => {
      const visible = revealAll || player.isHero || state.revealed.includes(player.id);
      const cards = visible && player.hole.length > 0 ? player.hole.map(cardCode).join("") : "??";
      // Folded seats are marked so a fully-revealed log still shows who was actually contesting.
      const tag = revealAll && player.folded ? "[f]" : "";
      return `${player.position}${player.isHero ? "(hero)" : ""}=${cards}${tag}`;
    })
    .join("; ");
  const potsText = (state.potResults ?? [])
    .map((pot) => {
      const awards = Object.entries(pot.awards)
        .map(([playerId, award]) => `${playerLogName(state, playerId)} ${amountBB(award)}`)
        .join("/");
      return `${pot.label} ${amountBB(pot.amount)} -> ${awards}`;
    })
    .join("; ");
  const rebuyText = (state.rebuys ?? [])
    .map(
      (record) =>
        `${record.position} ${record.kind === "rebuy" ? "buy-in" : "top-up"} +${amountBB(record.amount)}`,
    )
    .join("; ");
  const auditText = [
    `Stacks ${stackText}`,
    rebuyText ? `Rebuys ${rebuyText}` : "",
    effectiveText ? `Eff(hero) ${effectiveText}` : "",
    `Committed ${committedText}`,
    `Cards ${cardsText}`,
    potsText ? `Pots ${potsText}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  const sourceText = sourceSuffix ? ` | Src ${sourceSuffix}` : "";
  const headline = `H#${String(state.handNo).padStart(4, "0")} | 1/2 | ${hero.position}(hero) ${heroCards} | ${auditText} | ${actionText} | ${winnerText} wins | Hero ${resultText}${evText}${sourceText}`;
  const reasons = options?.reasons ?? [];
  if (reasons.length === 0) return headline;
  // 缩进两格的子列表：markdown 渲染出来是 H# 这一条下面的嵌套项，纯文本读起来也是分行的。
  // 缩进同时让 `analyze-log.mjs` 的 `startsWith("H#")` 自动跳过这些行。
  return [headline, ...reasons.map((reason) => `  - ${reason}`)].join("\n");
}

export function markdownLog(lines: string[]): string {
  return [
    "# AI 训练牌局日志",
    "",
    `- 牌局：8-max NLH Cash，盲注 1/2`,
    `- Hero：登邓灯`,
    `- 记录时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    ...lines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}
