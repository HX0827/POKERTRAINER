import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface HandInput {
  handId: string;
  heroCards: string;
  summary: string;
  resultBb: number;
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
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS poker_hands_created_at_idx ON poker_hands(created_at DESC)",
    ),
  ]);
}

export async function GET() {
  try {
    await ensureSchema();
    const result = await env.DB.prepare(
      `SELECT id, hand_id AS handId, result_bb AS resultBb, markdown, created_at AS createdAt
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
      typeof body.markdown !== "string" ||
      body.markdown.length > 8000
    ) {
      return NextResponse.json({ error: "Invalid hand record" }, { status: 400 });
    }
    await env.DB.prepare(
      `INSERT INTO poker_hands (hand_id, hero_cards, summary, result_bb, markdown)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET
         hero_cards = excluded.hero_cards,
         summary = excluded.summary,
         result_bb = excluded.result_bb,
         markdown = excluded.markdown`,
    )
      .bind(
        body.handId.slice(0, 32),
        body.heroCards.slice(0, 16),
        body.summary.slice(0, 240),
        body.resultBb,
        body.markdown,
      )
      .run();
    const result = await env.DB.prepare(
      `SELECT id, hand_id AS handId, result_bb AS resultBb, markdown, created_at AS createdAt
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
    return NextResponse.json({ ok: true, deleted: result.meta.changes ?? 0 });
  } catch {
    return NextResponse.json({ error: "Could not clear hand records" }, { status: 503 });
  }
}
