import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
    mode: process.env.AI_API_KEY && process.env.AI_MODEL ? "api" : "local",
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { apiKey?: string; model?: string };
    const apiKey = body.apiKey?.trim();
    const model = body.model?.trim();
    if (!apiKey || !["deepseek-v4-pro", "deepseek-v4-flash"].includes(model ?? "")) {
      return NextResponse.json(
        { configured: false, error: "请输入有效的 DeepSeek API Key 和模型" },
        { status: 400 },
      );
    }
    const response = await fetch("https://api.deepseek.com/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json(
        { configured: false, error: "连接失败，请检查 API Key 或账户状态" },
        { status: 401 },
      );
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const available = data.data?.some((candidate) => candidate.id === model) ?? false;
    return NextResponse.json({
      configured: true,
      mode: "deepseek",
      model,
      available,
    });
  } catch {
    return NextResponse.json(
      { configured: false, error: "连接 DeepSeek 时发生错误" },
      { status: 502 },
    );
  }
}
