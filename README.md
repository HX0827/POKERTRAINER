# Mist Table

Mist Table 是一张私人 8-max NLH AI 训练桌。七位 AI 对手各有性格，由大模型实时决策，每手结束后生成可复制的 Markdown 牌谱，附带每个 AI 自己说的行动理由。

- 盲注 1/2，无 straddle，Hero 名为 `登邓灯`。
- 七位 AI 分别是均衡派、老板松凶、紧凶猎手、松被动跟注站、短码、岩石和超松凶。
- 裁判层负责洗牌、发牌、底池、主池/边池与合法动作校验；AI 只拿到自己的底牌、公共牌、公开行动和合法动作。
- 摊牌前锁定的全下会精确穷举所有可能的发牌，算出这手的期望结果和运气差。

## 快速开始

需要 Node 22.13 以上。

```bash
npm install
npm run dev
```

打开终端提示的地址即可。**不配任何 API 也能直接玩**——这时七位 AI 由本地人格引擎驱动，玩法完整，只是不会有大模型那种随机应变。

## 接上大模型（可选）

牌桌右上角的齿轮里填 DeepSeek 的 API Key 和模型，点验证即可。**Key 只存在你自己浏览器的 localStorage 里，不写进代码库，也不存到服务器上。**每个人用自己的 Key，各花各的额度。

如果想让整个服务共用一个 Key，可以在项目根目录建一个 `.env`：

```dotenv
AI_API_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=你的key
AI_MODEL=deepseek-chat
```

`.env` 已经在 `.gitignore` 里，不会被提交。要注意的是：一旦服务端配了 Key，任何能访问这个站点的人都在花你的额度，所以别在公开部署上这么做。

接口返回值必须是合法 JSON：

```json
{"action":"fold|check|call|raise|allin","raiseTo":12,"reason":"..."}
```

`raiseTo` 只在 `action=raise` 时需要，单位是大盲。裁判层会再次校验动作和金额，非法响应不会进入牌局。

## 你的数据在哪

牌谱和「AI 对你的漏洞画像」存在本机 `.wrangler/` 目录下的 SQLite 里，也就是 `npm run dev` 起的那个本地数据库。**不会上传到任何地方**，也不在版本库里——`.gitignore` 已经把整个 `.wrangler/` 排除掉了。换台机器就是一份全新的记录。想留存就用侧栏的「复制 Markdown」或「下载 .md」。

整份牌局状态存在浏览器的 localStorage 里：刷新或关掉页面再打开，**原样接着打**——手牌、公共牌、底池、轮到谁，全都和离开时一模一样，打到一半的手也不例外。两个按钮各管各的：「重置对局」只把牌桌回到第一手（所有座位按买入重新坐下，按钮位随机），牌谱一条不动；「一键清空记录」只删牌谱和漏洞画像，牌桌接着打。切换阵容仍会按各自买入重开牌桌。

## 牌谱格式

一手一行，每个 AI 的理由缩进跟在下面：

```text
- H#0017 | 1/2 | SB(hero) 5s4h | Stacks ... | Pots Main 132BB -> HJ:K.O. 132BB | PF UTG open to 3BB ... | K.O. wins | Hero -21BB | Src DS:12 RT:1
  - PF UTG+1 钱老板 open to 3BB — KQs 在中位，牌力够开池，这桌大盲跟得很松
  - F BTN Volcano bet 5BB — K72 彩虹我在按钮位有范围优势，1/3 池让小对子做决定
```

## 常用命令

```bash
npm run dev      # 开发模式，起本地牌桌
npm run build    # 构建
npm test         # 构建 + 跑全部测试
npm run lint     # 代码检查
npm run analyze -- 牌局日志.md   # 牌谱体检
```

`npm run analyze` 用来判断牌桌有没有退化：把导出的牌谱喂进去，它会算出看到翻牌的比例、3-bet 出现率、以及每个座位的 VPIP 与 PFR 差值。差值接近 0 说明那个座位只会弃牌或加注，冷跟消失了，牌局会打不到翻牌。
