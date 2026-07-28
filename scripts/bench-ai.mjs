/**
 * DeepSeek 决策延迟基准测试。
 *
 * 用法:  AI_API_KEY=sk-你的key node scripts/bench-ai.mjs
 * 可选:  AI_API_BASE_URL=https://api.deepseek.com  RUNS=4
 *
 * 用和牌桌同样形状的请求,把几种参数组合各测 RUNS 发,输出每发的延迟、
 * token 用量(重点看 reasoning token 有没有被 budget/effort 参数管住)、
 * 内容是否完整。跑完把整段输出贴回给 Claude 调参。Key 只存在这个进程的
 * 环境变量里,不落盘。
 */

const KEY = process.env.AI_API_KEY;
const BASE = (process.env.AI_API_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const RUNS = Math.max(1, Number(process.env.RUNS) || 4);

if (!KEY) {
  console.error("缺 Key。用法: AI_API_KEY=sk-xxx node scripts/bench-ai.mjs");
  process.exit(1);
}

// —— 逼真的牌局请求(和 route.ts 同一形状、相近长度) ——————————————
const SYSTEM = `You are Volcano, a loose-aggressive poker player at a private 1/2 8-max NLH table. Play in character: high aggression, wide opens, pressure on capped ranges. You will receive one decision point as JSON. Reply with ONLY a JSON object: {"handClass":"...","planType":"value|semi-bluff|bluff|bluff-catch|pot-control|give-up","estimatedEquity":0.0,"action":"fold|check|call|raise|allin","raiseToBB":0,"reason":"<=340 chars"}. The referee validates actions; illegal replies are rejected.`;

const OBSERVATION = {
  handNo: 42,
  street: "turn",
  position: "CO",
  holeCards: ["Jh", "Jd"],
  communityCards: ["9s", "7d", "2c", "Qh"],
  stackBB: 143.5,
  potBB: 46,
  toCallBB: 24,
  potOddsToCall: 0.343,
  sprEffective: 3.1,
  legalActions: ["fold", "call", "raise", "allin"],
  publicActions: [
    "PF UTG fold", "PF HJ open to 3BB", "PF CO 3bet to 9BB", "PF BTN fold",
    "PF HJ call 9BB", "F HJ check", "F CO bet 12BB", "F HJ check-raise to 30BB",
    "F CO call 30BB", "T HJ bet 24BB",
  ],
  boardTexture: "Q turn adds a broadway overcard to a rainbow 9-7-2 board; no flush possible; JT/KJ gutshots live",
  handStrength: "an overpair to the flop is now second pair below the queen",
  opponents: [{ position: "HJ", committedBB: 40, allIn: false, profile: "tight-aggressive, check-raised flop" }],
  blinds: { smallBlind: 0.5, bigBlind: 1 },
};

const USER = `Decision point (all amounts in BB):\n${JSON.stringify(OBSERVATION, null, 1)}\nRespond with the JSON object only.`;

const SHORT_USER = `Turn decision, amounts in BB: you are CO with JhJd on 9s7d2c-Qh (rainbow). Pot 46, to call 24 vs HJ's bet after his flop check-raise. Stack 143.5, legal: fold/call/raise/allin. JSON object only.`;

const THINK_NUDGE = "\n\nKeep your hidden reasoning SHORT (well under 200 words): verify what hands beat yours on this board, check the pot odds, then decide. No range combinatorics.";

// —— 参数组合 ————————————————————————————————————————————————
const CONFIGS = [
  {
    name: "flash 快答(禁思考)",
    body: { model: "deepseek-v4-flash", max_tokens: 700, thinking: { type: "disabled" } },
    system: SYSTEM,
    user: USER,
  },
  {
    name: "flash 思考·现行参数(budget+effort+短思考提示)",
    body: {
      model: "deepseek-v4-flash", max_tokens: 8000,
      thinking: { type: "enabled", budget_tokens: 800 }, reasoning_effort: "low",
    },
    system: SYSTEM + THINK_NUDGE,
    user: USER,
  },
  {
    name: "flash 思考·裸开(无任何限制参数)",
    body: { model: "deepseek-v4-flash", max_tokens: 8000, thinking: { type: "enabled" } },
    system: SYSTEM,
    user: USER,
  },
  {
    name: "flash 思考·短提示词",
    body: { model: "deepseek-v4-flash", max_tokens: 8000, thinking: { type: "enabled" } },
    system: SYSTEM + THINK_NUDGE,
    user: SHORT_USER,
  },
  {
    name: "pro 思考(对照)",
    body: { model: "deepseek-v4-pro", max_tokens: 8000, thinking: { type: "enabled" } },
    system: SYSTEM + THINK_NUDGE,
    user: USER,
  },
];

// —— 执行 ————————————————————————————————————————————————————
function extractSse(raw) {
  let text = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try {
      const c = JSON.parse(p);
      const piece = c.choices?.[0]?.delta?.content ?? c.choices?.[0]?.message?.content;
      if (typeof piece === "string") text += piece;
    } catch { /* skip */ }
  }
  return text.trim() || null;
}

async function once(config) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config.body,
        temperature: 0.45,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: config.system },
          { role: "user", content: config.user },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    const seconds = (Date.now() - started) / 1000;
    const raw = await response.text();
    if (!response.ok) return { seconds, ok: false, note: `HTTP ${response.status}: ${raw.slice(0, 120)}` };
    let data;
    let sse = false;
    try {
      data = JSON.parse(raw);
    } catch {
      const salvaged = extractSse(raw);
      if (!salvaged) return { seconds, ok: false, note: `非JSON也非流: ${raw.slice(0, 80)}` };
      return { seconds, ok: true, sse: true, contentChars: salvaged.length, note: "SSE流" };
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoningChars = String(choice?.message?.reasoning_content ?? "").length;
    const usage = data.usage ?? {};
    let parsedOk = false;
    try { parsedOk = Boolean(JSON.parse(content).action); } catch { /* not json */ }
    return {
      seconds, ok: content.trim().length > 0, sse,
      contentChars: content.length, reasoningChars, parsedOk,
      finish: choice?.finish_reason,
      usage: `prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? "?"}`,
      note: content.trim() ? "" : `空内容 finish=${choice?.finish_reason}`,
    };
  } catch (error) {
    const seconds = (Date.now() - started) / 1000;
    const name = error && typeof error === "object" ? error.name : "";
    return { seconds, ok: false, note: name === "TimeoutError" ? "45秒超时" : `网络错误 ${String(error).slice(0, 80)}` };
  }
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
}

const summary = [];
for (const config of CONFIGS) {
  console.log(`\n### ${config.name}`);
  const latencies = [];
  let okCount = 0;
  for (let run = 1; run <= RUNS; run += 1) {
    const result = await once(config);
    if (result.ok) { okCount += 1; latencies.push(result.seconds); }
    console.log(
      `  #${run} ${result.seconds.toFixed(1)}s ${result.ok ? "OK" : "FAIL"}` +
      (result.parsedOk === false && result.ok ? " (JSON不合法)" : "") +
      (result.sse ? " [SSE]" : "") +
      (result.reasoningChars ? ` 思考${result.reasoningChars}字` : "") +
      (result.usage ? ` | ${result.usage}` : "") +
      (result.note ? ` | ${result.note}` : ""),
    );
  }
  summary.push({ name: config.name, ok: `${okCount}/${RUNS}`, median: median(latencies) });
}

console.log("\n===== 汇总 =====");
for (const row of summary) {
  console.log(`${row.name}: 成功 ${row.ok}, 中位延迟 ${Number.isNaN(row.median) ? "-" : row.median.toFixed(1) + "s"}`);
}
console.log("\n把上面完整输出贴回给 Claude。");
