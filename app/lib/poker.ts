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
  prompt: string;
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

export interface GameState {
  handNo: number;
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
    prompt:
      "Play a disciplined balanced cash-game strategy. Protect checking ranges, use mixed sizes, and avoid result-oriented decisions.",
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
    prompt:
      "You are a fearless loose-aggressive live-game boss. Enter many pots, punish weakness, apply oversized pressure, but do not make literally random illegal plays.",
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
    prompt:
      "Play tight-aggressive. Prefer strong positional entries, value isolation, credible pressure, and disciplined folds without initiative.",
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
    prompt:
      "Play loose-passive like a sticky recreational caller. See many flops, dislike folding pairs and draws, and raise mostly for obvious value.",
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
    prompt:
      "Play a compact 50BB strategy. Avoid marginal cold calls, prefer raise-or-fold and use well-timed preflop jams.",
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
    prompt:
      "Play very tight and value-heavy. Fold marginal holdings, choose low-variance lines, and rarely bluff without excellent blockers.",
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
    prompt:
      "Play an unpredictable hyper-aggressive maniac. Attack capped ranges, overbet frequently, and manufacture action while still respecting legal actions.",
  },
];

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

function freshPlayers(previous?: Player[]): Player[] {
  const names = [
    "登邓灯",
    "Atlas",
    "钱老板",
    "Mika",
    "老陈",
    "K.O.",
    "Stone",
    "Volcano",
  ];
  return PERSONAS.map((persona, index) => {
    const old = previous?.find((player) => player.id === persona.id);
    const targetStack = persona.buyInBB * BIG_BLIND;
    const carried = old && old.stack > 0 ? old.stack : targetStack;
    return {
      id: persona.id,
      name: names[index],
      isHero: index === 0,
      persona,
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

export function startHand(previous?: GameState): GameState {
  const dealerIndex = previous ? nextSeat(previous.dealerIndex) : 7;
  let players = positionPlayers(freshPlayers(previous?.players), dealerIndex);
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
  if (kind === "call") {
    if (player.allIn) {
      return `call all-in ${amountBB(amount)} to ${amountBB(player.streetBet)}`;
    }
    if (
      state.street === "preflop" &&
      state.actions.every((action) => action.toAmount <= action.facedBet)
    ) {
      return "limp";
    }
    return `call ${amountBB(amount)} to ${amountBB(player.streetBet)}`;
  }
  if (kind === "allin" && player.streetBet <= previousCurrentBet) {
    return `call all-in ${amountBB(amount)} to ${amountBB(player.streetBet)}`;
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

function heroPayoutForBoard(state: GameState, board: Card[]): number {
  const hero = state.players.find((player) => player.isHero);
  if (!hero || hero.folded) return 0;
  const contenders = livePlayers(state.players);
  const scores = new Map(
    contenders.map((player) => [player.id, bestScore([...player.hole, ...board])]),
  );
  const levels = [
    ...new Set(
      state.players.map((player) => player.totalCommitted).filter((value) => value > 0),
    ),
  ].sort((a, b) => a - b);
  let previousLevel = 0;
  let heroPayout = 0;

  levels.forEach((level) => {
    const contributors = state.players.filter((player) => player.totalCommitted >= level);
    const sidePot = (level - previousLevel) * contributors.length;
    previousLevel = level;
    const eligible = contenders.filter((player) => player.totalCommitted >= level);
    if (sidePot <= 0 || eligible.length === 0) return;
    let top = scores.get(eligible[0].id) as Score;
    eligible.slice(1).forEach((player) => {
      const score = scores.get(player.id) as Score;
      if (compareScore(score, top) > 0) top = score;
    });
    const sideWinners = eligible.filter(
      (player) => compareScore(scores.get(player.id) as Score, top) === 0,
    );
    if (sideWinners.some((player) => player.id === hero.id)) {
      heroPayout += sidePot / sideWinners.length;
    }
  });

  return heroPayout;
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

  const possibleRunouts = combinationCount(state.deck.length, missingBoardCards);
  const exact = possibleRunouts <= 50_000;
  const trialLimit = 25_000;
  let trials = 0;
  let payoutTotal = 0;
  let payoutSquaredTotal = 0;
  const scoreRunout = (runout: Card[]) => {
    const payout = heroPayoutForBoard(state, [...state.community, ...runout]);
    payoutTotal += payout;
    payoutSquaredTotal += payout * payout;
    trials += 1;
  };

  if (exact) {
    visitCombinations(state.deck, missingBoardCards, scoreRunout);
  } else {
    const random = seededRandom(stateSeed(state));
    for (let trial = 0; trial < trialLimit; trial += 1) {
      const pool = [...state.deck];
      const runout: Card[] = [];
      for (let cardIndex = 0; cardIndex < missingBoardCards; cardIndex += 1) {
        const chosenIndex =
          cardIndex + Math.floor(random() * (pool.length - cardIndex));
        [pool[cardIndex], pool[chosenIndex]] = [pool[chosenIndex], pool[cardIndex]];
        runout.push(pool[cardIndex]);
      }
      scoreRunout(runout);
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
  if (actors.length <= 1) {
    if (!state.heroAllInEv && state.community.length < 5) {
      state.heroAllInEv = calculateHeroAllInEv(state);
    }
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

function preflopStrength(cards: Card[]): number {
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

function preflopHandClass(cards: Card[]): string {
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

export function compactHandLog(state: GameState): string {
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
  const stackText = state.players
    .map(
      (player) =>
        `${player.position}${player.isHero ? "(hero)" : ""} ${amountBB(startingStack(state, player))}`,
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
  const cardPlayers = state.players.filter(
    (player) =>
      player.isHero ||
      state.revealed.includes(player.id) ||
      player.totalCommitted > BIG_BLIND * 2,
  );
  const cardsText = cardPlayers
    .map((player) => {
      const visible = player.isHero || state.revealed.includes(player.id);
      const cards = visible ? player.hole.map(cardCode).join("") : "??";
      return `${player.position}${player.isHero ? "(hero)" : ""}=${cards}`;
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
  const auditText = [
    `Stacks ${stackText}`,
    effectiveText ? `Eff(hero) ${effectiveText}` : "",
    `Committed ${committedText}`,
    `Cards ${cardsText}`,
    potsText ? `Pots ${potsText}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return `H#${String(state.handNo).padStart(4, "0")} | 1/2 | ${hero.position}(hero) ${heroCards} | ${auditText} | ${actionText} | ${winnerText} wins | Hero ${resultText}${evText}`;
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
