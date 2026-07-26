import { NextRequest, NextResponse } from "next/server";
import type { ActionKind, BotObservation } from "../../../lib/poker";

export const dynamic = "force-dynamic";

interface RequestBody {
  persona?: {
    id?: string;
    title?: string;
    prompt?: string;
  };
  observation?: BotObservation;
}

function sanitizeDecision(
  value: unknown,
  observation: BotObservation,
): { action: ActionKind; raiseTo?: number } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { action?: ActionKind; raiseTo?: number };
  if (!candidate.action || !observation.legalActions.includes(candidate.action)) return null;
  if (candidate.action !== "raise") return { action: candidate.action };
  const maximum = observation.streetBet + observation.stack;
  const raiseTo = Math.max(
    observation.minimumRaiseTo,
    Math.min(maximum, Math.round(Number(candidate.raiseTo) || observation.minimumRaiseTo)),
  );
  return { action: "raise", raiseTo };
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  const apiBase = (process.env.AI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (!apiKey || !model) {
    return NextResponse.json({ error: "AI API is not configured" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as RequestBody;
    const observation = body.observation;
    if (
      !observation ||
      !Array.isArray(observation.holeCards) ||
      !Array.isArray(observation.legalActions) ||
      observation.holeCards.length !== 2
    ) {
      return NextResponse.json({ error: "Invalid observation" }, { status: 400 });
    }

    const system = [
      "You are one seat in an 8-max no-limit Texas Hold'em training game.",
      "You may use only the private hole cards and public table information supplied below.",
      "Never infer or request hidden cards, the deck order, or other players' private state.",
      "Choose exactly one legal action. Return JSON only.",
      body.persona?.prompt || "Play a coherent poker strategy.",
    ].join(" ");

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        max_tokens: 100,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              persona: body.persona?.title,
              observation,
              outputSchema: {
                action: observation.legalActions,
                raiseTo: "number, required only when action is raise",
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Provider rejected decision" }, { status: 502 });
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    const parsed = content ? JSON.parse(content) : null;
    const decision = sanitizeDecision(parsed, observation);
    if (!decision) {
      return NextResponse.json({ error: "Provider returned an illegal action" }, { status: 502 });
    }
    return NextResponse.json(decision);
  } catch {
    return NextResponse.json({ error: "AI decision failed" }, { status: 502 });
  }
}
