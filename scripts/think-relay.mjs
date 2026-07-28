/**
 * 思考请求的本机中继。
 *
 * 为什么存在:牌桌的 API 路由跑在 workerd 里,而 workerd 直连 DeepSeek 拿"开思考"
 * 的回复时,响应体会挂死(实测流式限速慢吐、非流式不吐,基准见 scripts/bench-ai.mjs);
 * 同一台机器上 Node 的 fetch 却 0.2 秒拿到全文。所以思考请求绕道这里:
 * workerd -> 本机回环 -> Node fetch -> DeepSeek。
 *
 * 安全边界:只监听 127.0.0.1;只转发到 api.deepseek.com;不落盘任何请求内容。
 * 生命周期:由 scripts/launch-mist-table.sh 拉起/重启,pid 和日志在 .local-run/。
 */

import { createServer } from "node:http";

const PORT = Number(process.env.THINK_RELAY_PORT) || 3210;
const UPSTREAM = "https://api.deepseek.com";

const server = createServer((request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("mist-think-relay ok");
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405);
    response.end();
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", async () => {
    const started = Date.now();
    try {
      const upstream = await fetch(`${UPSTREAM}${request.url}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: request.headers.authorization || "",
        },
        body,
        signal: AbortSignal.timeout(26000),
      });
      const text = await upstream.text();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[think-relay] ${upstream.status} in ${seconds}s, ${text.length} chars`);
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
      });
      response.end(text);
    } catch (error) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.warn(`[think-relay] upstream failed in ${seconds}s: ${String(error).slice(0, 160)}`);
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "relay upstream failed" }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[think-relay] listening on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
