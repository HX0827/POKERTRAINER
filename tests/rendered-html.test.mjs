import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Mist Table product shell replaces the disposable starter", async () => {
  const [page, layout, trainer, hosting, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/components/PokerTrainer.tsx", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /PokerTrainer/);
  assert.match(layout, /Mist Table — AI 德州扑克训练桌/);
  assert.match(layout, /og\.png/);
  assert.match(trainer, /黑雾训练桌/);
  assert.match(trainer, /迷雾开启/);
  assert.match(trainer, /逐手记录/);
  assert.match(trainer, /一键清空记录/);
  assert.match(trainer, /method: "DELETE"/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);

  await access(new URL("dist/server/index.js", root));
  await access(new URL("public/og.png", root));
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
