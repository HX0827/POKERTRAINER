import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface HandInput {
  handId: string;
  heroCards: string;
  summary: string;
  resultBb: number;
  evBb: number | null;
  luckBb: number | null;
  evMethod: string | null;
  markdown: string;
}

async function ensureSchema() {
  if (!env.DB) throw new Error("DB unavailable");
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS poker_hands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hand_id TEXT NOT NULL UNIQUE,
        hero_cards TEXT NOT NULL,
        summary TEXT NOT NULL,
        result_bb REAL NOT NULL DEFAULT 0,
        ev_bb REAL,
        luck_bb REAL,
        ev_method TEXT,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS poker_hands_created_at_idx ON poker_hands(created_at DESC)",
    ),
  ]);
  const columns = await env.DB.prepare("PRAGMA table_info(poker_hands)").all<{ name: string }>();
  const columnNames = new Set(columns.results.map((column) => column.name));
  const additions = [
    ["ev_bb", "ALTER TABLE poker_hands ADD COLUMN ev_bb REAL"],
    ["luck_bb", "ALTER TABLE poker_hands ADD COLUMN luck_bb REAL"],
    ["ev_method", "ALTER TABLE poker_hands ADD COLUMN ev_method TEXT"],
  ] as const;
  for (const [name, statement] of additions) {
    if (!columnNames.has(name)) await env.DB.prepare(statement).run();
  }
}

export async function GET() {
  try {
    await ensureSchema();
    const result = await env.DB.prepare(
      `SELECT id, hand_id AS handId, result_bb AS resultBb,
              ev_bb AS evBb, luck_bb AS luckBb, ev_method AS evMethod,
              markdown, created_at AS createdAt
       FROM poker_hands
       ORDER BY id DESC
       LIMIT 100`,
    ).all();
    return NextResponse.json({ hands: result.results });
  } catch {
    return NextResponse.json({ hands: [], storage: "unavailable" });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureSchema();
    const body = (await request.json()) as Partial<HandInput>;
    if (
      typeof body.handId !== "string" ||
      typeof body.heroCards !== "string" ||
      typeof body.summary !== "string" ||
      typeof body.resultBb !== "number" ||
      (body.evBb !== undefined && body.evBb !== null && typeof body.evBb !== "number") ||
      (body.luckBb !== undefined && body.luckBb !== null && typeof body.luckBb !== "number") ||
      (body.evMethod !== undefined &&
        body.evMethod !== null &&
        !["exact", "monte-carlo"].includes(body.evMethod)) ||
      typeof body.markdown !== "string" ||
      body.markdown.length > 8000
    ) {
      return NextResponse.json({ error: "Invalid hand record" }, { status: 400 });
    }
    await env.DB.prepare(
      `INSERT INTO poker_hands (
         hand_id, hero_cards, summary, result_bb, ev_bb, luck_bb, ev_method, markdown
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET
         hero_cards = excluded.hero_cards,
         summary = excluded.summary,
         result_bb = excluded.result_bb,
         ev_bb = excluded.ev_bb,
         luck_bb = excluded.luck_bb,
         ev_method = excluded.ev_method,
         markdown = excluded.markdown`,
    )
      .bind(
        body.handId.slice(0, 32),
        body.heroCards.slice(0, 16),
        body.summary.slice(0, 240),
        body.resultBb,
        body.evBb ?? null,
        body.luckBb ?? null,
        body.evMethod ?? null,
        body.markdown,
      )
      .run();
    const result = await env.DB.prepare(
      `SELECT id, hand_id AS handId, result_bb AS resultBb,
              ev_bb AS evBb, luck_bb AS luckBb, ev_method AS evMethod,
              markdown, created_at AS createdAt
       FROM poker_hands WHERE hand_id = ?`,
    )
      .bind(body.handId)
      .first();
    return NextResponse.json({ hand: result });
  } catch {
    return NextResponse.json({ error: "Could not save hand" }, { status: 503 });
  }
}

export async function DELETE() {
  try {
    await ensureSchema();
    const result = await env.DB.prepare("DELETE FROM poker_hands").run();
    // "Clear everything" must also drop the hero profile (CONTRACT-V2 §二). Its table is
    // owned by /api/hero-profile and may not exist yet, so create-if-missing first and
    // never let a profile failure block the hand history from being cleared.
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS hero_hand_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hand_id TEXT NOT NULL UNIQUE,
          counters TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      await env.DB.prepare("DELETE FROM hero_hand_stats").run();
    } catch {
      // Hero profile storage is optional; the hand log has already been cleared.
    }
    return NextResponse.json({ ok: true, deleted: result.meta.changes ?? 0 });
  } catch {
    return NextResponse.json({ error: "Could not clear hand records" }, { status: 503 });
  }
}
