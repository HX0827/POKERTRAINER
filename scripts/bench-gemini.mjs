/**
 * Gemini 思考延迟基准测试(接思考臂前的验货)。
 *
 * 用法:  GEMINI_API_KEY=你的key node scripts/bench-gemini.mjs
 * 可选:  GEMINI_MODEL=gemini-xxx  RUNS=3
 *
 * 每一发的牌局提示词都随机化(牌、筹码、底池全都变),杜绝服务端缓存假象。
 * 重点看:thinkingBudget 是否被严格执行(thoughts token 数)、各档延迟分布、
 * OpenAI 兼容端点(reasoning_effort)的表现——接线走的就是它。
 * Key 只在环境变量里,不落盘。
 */

const KEY = process.env.GEMINI_API_KEY;
const RUNS = Math.max(1, Number(process.env.RUNS) || 3);
const BASE = "https://generativelanguage.googleapis.com";

if (!KEY) {
  console.error("缺 Key。用法: GEMINI_API_KEY=xxx node scripts/bench-gemini.mjs");
  process.exit(1);
}

// —— 随机牌局提示词 ————————————————————————————————————————
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];
function randCard(used) {
  for (;;) {
    const card = RANKS[Math.floor(Math.random() * 13)] + SUITS[Math.floor(Math.random() * 4)];
    if (!used.has(card)) {
      used.add(card);
      return card;
    }
  }
}
function randomPrompt() {
  const used = new Set();
  const hole = [randCard(used), randCard(used)];
  const board = [randCard(used), randCard(used), randCard(used), randCard(used)];
  const pot = 20 + Math.floor(Math.random() * 120);
  const toCall = 5 + Math.floor(Math.random() * 60);
  const stack = 60 + Math.floor(Math.random() * 200);
  const system = `You are a loose-aggressive poker player at a 1/2 8-max NLH table. Reply with ONLY a JSON object: {"handClass":"...","planType":"value|semi-bluff|bluff|bluff-catch|pot-control|give-up","estimatedEquity":0.0,"action":"fold|call|raise|allin","raiseToBB":0,"reason":"<=340 chars"}\n\nKeep your hidden reasoning SHORT (well under 200 words): verify what hands beat yours on this board, check the pot odds, then decide. No range combinatorics.`;
  const user = `Turn decision, amounts in BB: you hold ${hole.join("")} on ${board.slice(0, 3).join("")}-${board[3]}. Pot ${pot}, to call ${toCall} vs a bet. Your stack ${stack}. Legal: fold/call/raise/allin. JSON object only.`;
  return { system, user };
}

// —— 调用两种端点 ——————————————————————————————————————————
async function nativeCall(model, thinkingConfig) {
  const { system, user } = randomPrompt();
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/v1beta/models/${model}:generateContent?key=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.45,
          maxOutputTokens: 4000,
          responseMimeType: "application/json",
          ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
        },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const seconds = (Date.now() - started) / 1000;
    const raw = await response.text();
    if (!response.ok) return { seconds, ok: false, note: `HTTP ${response.status}: ${raw.slice(0, 160)}` };
    const data = JSON.parse(raw);
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const usage = data.usageMetadata ?? {};
    let parsedOk = false;
    try { parsedOk = Boolean(JSON.parse(text).action); } catch { /* not json */ }
    return {
      seconds, ok: text.trim().length > 0, parsedOk,
      note: `思考tok=${usage.thoughtsTokenCount ?? 0} 输出tok=${usage.candidatesTokenCount ?? "?"} finish=${data.candidates?.[0]?.finishReason ?? "?"}`,
    };
  } catch (error) {
    return { seconds: (Date.now() - started) / 1000, ok: false, note: String(error?.name === "TimeoutError" ? "45秒超时" : error).slice(0, 120) };
  }
}

async function compatCall(model, reasoningEffort) {
  const { system, user } = randomPrompt();
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.45,
        max_tokens: 4000,
        stream: false,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    const seconds = (Date.now() - started) / 1000;
    const raw = await response.text();
    if (!response.ok) return { seconds, ok: false, note: `HTTP ${response.status}: ${raw.slice(0, 160)}` };
    const data = JSON.parse(raw);
    const content = data.choices?.[0]?.message?.content ?? "";
    let parsedOk = false;
    try { parsedOk = Boolean(JSON.parse(content).action); } catch { /* not json */ }
    const usage = data.usage ?? {};
    return {
      seconds, ok: content.trim().length > 0, parsedOk,
      note: `completion=${usage.completion_tokens ?? "?"} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? "?"}`,
    };
  } catch (error) {
    return { seconds: (Date.now() - started) / 1000, ok: false, note: String(error?.name === "TimeoutError" ? "45秒超时" : error).slice(0, 120) };
  }
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
}

// —— 主流程 ————————————————————————————————————————————————
console.log("### 可用的 Flash 型号");
let model = process.env.GEMINI_MODEL || "";
try {
  const listed = await (await fetch(`${BASE}/v1beta/models?key=${KEY}&pageSize=100`)).json();
  const names = (listed.models ?? [])
    .map((m) => (m.name ?? "").replace("models/", ""))
    .filter((n) => n.includes("flash") && !n.includes("image") && !n.includes("tts") && !n.includes("live"));
  for (const n of names) console.log("  " + n);
  if (!model) {
    model =
      names.filter((n) => n.startsWith("gemini-3")).sort().pop() ||
      names.sort().pop() ||
      "gemini-flash-latest";
  }
} catch (error) {
  console.log("  列表拉取失败:", String(error).slice(0, 120));
  if (!model) model = "gemini-flash-latest";
}
console.log(`\n选用型号: ${model}(想换: GEMINI_MODEL=xxx)\n`);

const CONFIGS = [
  { name: "native·思考关闭(budget 0)", run: () => nativeCall(model, { thinkingBudget: 0 }) },
  { name: "native·思考预算 800", run: () => nativeCall(model, { thinkingBudget: 800 }) },
  { name: "native·思考不设限(默认)", run: () => nativeCall(model, undefined) },
  { name: "OpenAI兼容·reasoning_effort=low(接线路径)", run: () => compatCall(model, "low") },
];

const summary = [];
for (const config of CONFIGS) {
  console.log(`### ${config.name}`);
  const latencies = [];
  let okCount = 0;
  for (let i = 1; i <= RUNS; i += 1) {
    const r = await config.run();
    if (r.ok) { okCount += 1; latencies.push(r.seconds); }
    console.log(`  #${i} ${r.seconds.toFixed(1)}s ${r.ok ? "OK" : "FAIL"}${r.parsedOk === false && r.ok ? " (JSON不合法)" : ""} | ${r.note}`);
  }
  summary.push({ name: config.name, ok: `${okCount}/${RUNS}`, median: median(latencies) });
  console.log("");
}

console.log("===== 汇总 =====");
for (const row of summary) {
  console.log(`${row.name}: 成功 ${row.ok}, 中位延迟 ${Number.isNaN(row.median) ? "-" : row.median.toFixed(1) + "s"}`);
}
console.log("\n把完整输出贴回给 Claude,数据好就把思考臂切到 Gemini。");
