# CONTRACT — AI 决策改造并行实施契约

Read this FIRST, then `docs/AI决策改造设计.md` (the authoritative design, esp. §4–§7, §10).
All amounts in code are **chips** (SB=1, BB=2). Design-doc numbers are in BB — multiply by 2.

## File ownership (STRICT — never touch another agent's file)

| Agent | Files |
|---|---|
| A (strategy) | `app/lib/strategy.ts` ONLY (replace the stub; **signatures are frozen**) |
| B (route) | `app/api/ai/decision/route.ts` ONLY |
| C (personas+tests) | `app/lib/poker.ts` (ONLY the 7 `prompt` strings inside `PERSONAS`) + `tests/strategy-guardrail.test.mjs` (new) |
| D (client) | `app/components/PokerTrainer.tsx` + `app/globals.css` (append styles only) |

Shared pre-work already landed in `app/lib/poker.ts` (do NOT redo): `OpponentProfile` +
`BotObservation.opponentProfiles`, exported `preflopStrength` / `preflopHandClass`,
`compactHandLog(state, sourceSuffix?)`.

## Frozen strategy API (in the stub — keep exactly)

`checkDecision(observation, persona, decision) => GuardrailVerdict`,
`suggestSafeAction(observation, persona) => BotDecision`,
`describeHandClass(holeCards) => string`, plus the exported types
(`RuleId`, `PersonaTraits`, `GuardrailNumbers`, `GuardrailVerdict`, `BotDecision`).
Semantics: fold/check always ok; range/equity violations veto (`ok:false` + `rule` + `detail`
+ `numbers`); pure sizing issues clamp (`ok:true` + `clampedRaiseTo`). Deterministic
(seed any Monte-Carlo from a stable hash of the observation, NOT `Math.random`).

### Effective-amount math (MANDATORY — H#0004 lesson)

- `effCall = min(observation.toCall, observation.stack)`
- villain excess that cannot be won: `excess = observation.toCall - effCall`
- `requiredEquity = effCall / ((observation.pot - excess) + effCall)`
  (`observation.pot` already includes all street bets). Do NOT trust
  `observation.potOddsToCall` when stack < toCall.
- Jam evaluation: the effective jam size is bounded by the largest live opponent stack
  (join `opponentProfiles` to `observation.publicPlayers` by `position` for current stacks).
- No implied-odds allowance when every live opponent is all-in.

### Villain range modeling (from `observation.opponentProfiles`)

Top-percentile of the 1326 combos ranked by exported `preflopStrength` (build the 52-card
deck locally): `preflopAggression` 4→6%, 3→6%, 2→12%, 1→30% (40% if position BTN/CO),
`calledRaisePreflop`→45%, else 70% (BB never-voluntary → 100%).
If `bigAggressionThisStreet`, multiply percentile by 0.55. Exclude hero hole + board cards.
MC 1200–2000 rollouts, <30ms typical. Multi-way: sample each villain independently,
hero must beat all.

## Client → server request (B parses, D sends)

`POST /api/ai/decision` body:

```json
{
  "persona": { "id": "maniac", "title": "火山", "prompt": "<persona prompt>",
               "looseness": 0.92, "aggression": 0.96, "bluff": 0.9 },
  "observation": { "...": "botObservation() output, includes opponentProfiles" },
  "api": { "apiKey": "sk-...", "model": "deepseek-v4-pro" }
}
```

B: numeric traits default to 0.5 when absent/invalid. Keep existing browser-key /
`ALLOWED_DEEPSEEK_MODELS` / env-fallback logic unchanged.

## Server response (B produces, D consumes)

Success:

```json
{
  "action": "fold", "raiseTo": null,
  "source": "ds" | "ds-retry" | "override",
  "model": { "handClass": "A8o", "planType": "bluff-catch", "estimatedEquity": 0.4,
             "reason": "<=340 chars" },
  "guardrail": { "requiredEquity": 0.387, "engineEquity": 0.223,
                 "assumedRange": "...", "verdict": "pass" | "pass-after-retry" | "overridden",
                 "vetoRule": "POST-CALL-ALLIN", "detail": "..." }
}
```

`model` fields come from the LLM JSON (missing fields → nulls, do not fail). `guardrail`
present whenever `checkDecision` ran; `vetoRule`/`detail` only when a veto happened at
some point. Failure: HTTP 502 with `{ "error": "...", "failReason":
"not-configured" | "timeout" | "provider-error" | "illegal-action" | "network" }`
(503 + `not-configured` when unconfigured, as today).

## Route flow (B)

1. System prompt = design doc §6.1 verbatim (floor + OUTPUT schema) + `PERSONA: <prompt>`.
2. User message: JSON with persona title, observation, `handClassHint:
   describeHandClass(observation.holeCards)`, and note that `potOddsToCall` is required
   equity. `max_tokens: 420`, `temperature: 0.45`, keep `response_format: json_object`,
   keep DeepSeek `thinking: disabled` unless `process.env.AI_THINKING === "1"`.
3. Parse → legality (existing sanitize) → `checkDecision`.
4. On veto: ONE retry — same system, append assistant turn (model's raw JSON) + user turn
   (design §4.4 rejection JSON built from `GuardrailVerdict`), `temperature: 0.2`.
   Retry result → legality → `checkDecision` again.
5. Still bad (or illegal) → `suggestSafeAction`, `source: "override"`.
6. Total budget 9s: wrap both fetches with `AbortSignal.timeout(...)` (~5s first, ~3.5s retry);
   on timeout → 502 `failReason: "timeout"`. Clamped sizes: apply `clampedRaiseTo` silently.

## Client flow (D)

1. Send extended persona (traits) in the POST body.
2. On ok response: use `action`/`raiseTo`; record source (`"ds" | "ds-retry" | "override"`).
3. On failure/timeout (client guard `AbortSignal.timeout(12000)`) or !ok: `raw =
   localBotDecision(...)`, then `verdict = checkDecision(obs, persona, raw)`; use
   `verdict.ok ? {action: raw.action, raiseTo: verdict.clampedRaiseTo ?? raw.raiseTo} :
   suggestSafeAction(obs, persona)`. Source: `"local-fallback"` (API was expected) or
   `"local-engine"` (API not configured). Record `failReason` when present. Guardrail may
   throw on malformed input — wrap in try/catch, fall back to raw decision.
4. Per-action records `{handNo, actionIndex, playerId, source, rule?, failReason?}` in a
   `useRef` map keyed by handNo (prune old hands). On hand completion build suffix:
   `DS:9 RT:1 OV:1(F LJ allin→bet 56, POST-JAM-EQUITY) LF:0` — counts: DS, RT, OV, LF
   (+` LG:n` only when local-engine mode was used); each OV/LF gets a parenthesized
   detail `(street-letter position originalAction→finalAction, rule-or-reason)`, max 2
   details, then `…`. Pass to `compactHandLog(finished, suffix)`; omit suffix when no AI
   acted. Street letters: PF/F/T/R.
5. apiHealth state machine: `"connected"` (green, "DeepSeek 已连接" / "统一 API 已连接"),
   `"degraded"` (amber, "DeepSeek 波动 · 本手回退 N 次") — entered on any local-fallback,
   back to connected on next successful ds/ds-retry; `"local"` (gray, "本地人格引擎").
   Replace the current always-green chip logic. Persona modal footer: last-100-actions
   tally `DS 92 · 重问 5 · 替换 2 · 回退 1`.
6. `model.reason` must NOT be rendered during a live hand (information leak). It may go
   into the per-action record for post-hand inspection only.
7. `app/globals.css`: append a `.status-chip.degraded` amber variant consistent with
   existing `.status-chip.online/.local` styles (find them in the file).

## Personas + tests (C)

- Replace ONLY the 7 `prompt` strings in `PERSONAS` with design §6.2 texts verbatim.
- `tests/strategy-guardrail.test.mjs`: node:test + assert, import from
  `../app/lib/strategy.ts` (runner uses `--experimental-strip-types`). Implement design
  §10 cases 1–9 with observation fixtures as plain object literals **in chips**
  (H#0004: 3-bet to 24 chips, 4-bet to 72, flop pot 169, BB stack behind 288, LJ jam 903).
  Assert on `ok` + `rule` (and `clampedRaiseTo` presence where relevant), NEVER on exact
  equity values. Personas: use real trait numbers from `PERSONAS` (import from poker.ts).
  Case 1 note: BB facing a 3-bet with only the posted blind (`streetBet <= BB`) is COLD
  (`PF-COLD-VS-3BET`); after calling the 3-bet, facing the 4-bet is invested
  (`PF-RANGE-VS-4BET`). Include fixtures' `opponentProfiles` per the modeling table.

## Verification every agent runs before finishing

```
cd /home/claude/work
tsc -p tsconfig.check.json          # must be 0 errors (global tsc 6.x)
node --experimental-strip-types --test tests/poker-ev.test.mjs   # must stay 13/13
```

A additionally runs C's test file if it exists (it may land later — do not block on it).
`npm run build` / dev server are NOT runnable in this sandbox — do not try.
Do not install packages. Do not create extra files beyond your ownership row.
`typestubs/` and `tsconfig.check.json` are cloud-only scaffolding — leave untouched.
