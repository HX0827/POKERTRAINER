# Mist Table

Mist Table 是一张私人 8-max NLH AI 训练桌。

- 盲注：1/2，无 straddle。
- Hero：`登邓灯`。
- 7 位 AI 对手分别采用均衡、老板松凶、紧凶、松被动、短码、岩石和超松凶人格。
- 裁判层负责洗牌、发牌、底池、主池/边池与合法动作。
- AI 决策只接收自己的底牌、公共牌、公开行动和合法动作。
- 每手结束后自动保存一行紧凑 Markdown，并支持复制或下载 `.md`。

## 统一 AI API

未配置 API 时，牌桌使用本地人格引擎，完整玩法不受影响。配置后，7 位 AI 共用同一 OpenAI-compatible endpoint，但使用各自独立的系统人格。

```dotenv
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=
```

API 返回值必须是合法 JSON：

```json
{"action":"fold|check|call|raise|allin","raiseTo":12}
```

`raiseTo` 只在 `action=raise` 时需要。裁判层会再次验证动作和金额，非法响应不会直接进入牌局。

## 牌谱格式

```text
H#0001 | 1/2 | BTN(hero) AhKd | PF UTG limp CO limp BTN(hero) open 5BB | F Qh7c2d BB check BTN(hero) raise 3BB | 登邓灯 wins | Hero +4.5BB
```
