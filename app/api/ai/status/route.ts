import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
    mode: process.env.AI_API_KEY && process.env.AI_MODEL ? "api" : "local",
  });
}
