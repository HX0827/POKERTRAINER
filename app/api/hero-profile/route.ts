import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import {
  EMPTY_HERO_COUNTERS,
  mergeHeroCounters,
  summarizeHeroProfile,
  type HeroCounters,
} from "../../lib/heroProfile";

export const dynamic = "force-dynamic";

/** Per-field ceiling: a single hand can only ever produce single-digit increments. */
const MAX_COUNTER_VALUE = 1000;

const COUNTER_KEYS = Object.keys(EMPTY_HERO_COUNTERS) as Array<keyof HeroCounters>;

/**
 * Minimal structural view of the D1 binding. The worker types are not available to the
 * cloud typecheck, and this keeps the file checked instead of excluded.
 */
interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}

function database(): D1DatabaseLike {
  const binding: unknown = env.DB;
  if (!binding) throw new Error("DB unavailable");
  return binding as D1DatabaseLike;
}

/**
 * Same additive style as `app/api/hands/route.ts`: the production D1 database already
 * exists, so schema work is only ever CREATE TABLE IF NOT EXISTS plus column top-ups.
 */
async function ensureSchema(): Promise<D1DatabaseLike> {
  const db = database();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS hero_hand_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hand_id TEXT NOT NULL UNIQUE,
        counters TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS hero_hand_stats_created_at_idx ON hero_hand_stats(created_at DESC)",
    ),
  ]);
  const columns = await db.prepare("PRAGMA table_info(hero_hand_stats)").all<{ name: string }>();
  const columnNames = new Set(columns.results.map((column) => column.name));
  const additions = [
    ["counters", "ALTER TABLE hero_hand_stats ADD COLUMN counters TEXT NOT NULL DEFAULT '{}'"],
  ] as const;
  for (const [name, statement] of additions) {
    if (!columnNames.has(name)) await db.prepare(statement).run();
  }
  return db;
}

/** Stored JSON is untrusted input: unknown keys are dropped, bad values become 0. */
function parseCounters(raw: unknown): HeroCounters {
  if (typeof raw !== "string") return EMPTY_HERO_COUNTERS;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return EMPTY_HERO_COUNTERS;
  }
  return validateCounters(decoded) ?? EMPTY_HERO_COUNTERS;
}

/** Returns null when the payload is not a clean set of small non-negative integers. */
function validateCounters(value: unknown): HeroCounters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result = { ...EMPTY_HERO_COUNTERS } as HeroCounters;
  for (const key of COUNTER_KEYS) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (
      typeof entry !== "number" ||
      !Number.isFinite(entry) ||
      entry < 0 ||
      entry > MAX_COUNTER_VALUE
    ) {
      return null;
    }
    result[key] = Math.floor(entry);
  }
  return result;
}

const EMPTY_PROFILE = {
  handsDealt: 0,
  text: "",
  lines: [] as HeroProfileLines,
  counters: EMPTY_HERO_COUNTERS,
};
type HeroProfileLines = ReturnType<typeof summarizeHeroProfile>["lines"];

export async function GET() {
  try {
    const db = await ensureSchema();
    const result = await db
      .prepare(
        // 500 hands is far more than the profile needs to converge, and keeps the
        // aggregation bounded no matter how long the session log grows.
        `SELECT counters
         FROM hero_hand_stats
         ORDER BY id DESC
         LIMIT 500`,
      )
      .all<{ counters: string }>();
    let counters: HeroCounters = EMPTY_HERO_COUNTERS;
    for (const row of result.results) {
      counters = mergeHeroCounters(counters, parseCounters(row.counters));
    }
    const summary = summarizeHeroProfile(counters);
    return NextResponse.json({
      handsDealt: summary.handsDealt,
      text: summary.text,
      lines: summary.lines,
      counters,
    });
  } catch {
    // The profile is an enhancement; a storage outage must never break the table.
    return NextResponse.json({ ...EMPTY_PROFILE, storage: "unavailable" });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<{ handId: unknown; counters: unknown }>;
    const handId = typeof body?.handId === "string" ? body.handId : "";
    const counters = validateCounters(body?.counters);
    if (!handId || handId.length > 32 || !counters) {
      return NextResponse.json({ error: "Invalid hero profile record" }, { status: 400 });
    }
    const db = await ensureSchema();
    await db
      .prepare(
        `INSERT INTO hero_hand_stats (hand_id, counters)
         VALUES (?, ?)
         ON CONFLICT(hand_id) DO UPDATE SET
           counters = excluded.counters`,
      )
      .bind(handId, JSON.stringify(counters))
      .run();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not save hero profile" }, { status: 503 });
  }
}

export async function DELETE() {
  try {
    const db = await ensureSchema();
    const result = await db.prepare("DELETE FROM hero_hand_stats").run();
    return NextResponse.json({ ok: true, deleted: result.meta.changes ?? 0 });
  } catch {
    return NextResponse.json({ error: "Could not clear hero profile" }, { status: 503 });
  }
}
