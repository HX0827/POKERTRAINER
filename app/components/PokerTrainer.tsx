"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionKind,
  BIG_BLIND,
  Card,
  GameState,
  Player,
  amountBB,
  applyAction,
  botObservation,
  cardCode,
  cardLabel,
  compactHandLog,
  isRed,
  legalActions,
  localBotDecision,
  markdownLog,
  startHand,
  totalPot,
} from "../lib/poker";

interface StoredHand {
  id: number;
  handId: string;
  markdown: string;
  resultBb: number;
  createdAt: string;
}

function PlayingCard({
  card,
  hidden = false,
  small = false,
}: {
  card?: Card;
  hidden?: boolean;
  small?: boolean;
}) {
  if (hidden || !card) {
    return (
      <span className={`playing-card card-back ${small ? "small" : ""}`} aria-label="暗牌">
        <i />
      </span>
    );
  }
  return (
    <span
      className={`playing-card ${isRed(card) ? "red" : "black"} ${small ? "small" : ""}`}
      aria-label={cardLabel(card)}
    >
      <b>{card.rank}</b>
      <em>{cardLabel(card).slice(-1)}</em>
    </span>
  );
}

function PlayerSeat({
  player,
  seat,
  active,
  winner,
  reveal,
}: {
  player: Player;
  seat: number;
  active: boolean;
  winner: boolean;
  reveal: boolean;
}) {
  const showCards = player.isHero || reveal;
  return (
    <div
      className={`player-seat seat-${seat} ${active ? "active" : ""} ${
        player.folded ? "folded" : ""
      } ${player.isHero ? "hero-seat" : ""} ${winner ? "winner" : ""}`}
      style={{ "--player-color": player.persona.color } as React.CSSProperties}
      data-testid={`seat-${seat}`}
    >
      <div className="hole-cards">
        {player.hole.map((card, index) => (
          <PlayingCard
            key={`${cardCode(card)}-${index}`}
            card={card}
            hidden={!showCards}
            small={!player.isHero}
          />
        ))}
      </div>
      <div className="player-panel">
        <div className="avatar">{player.persona.icon}</div>
        <div className="player-info">
          <div className="player-name-line">
            <strong>{player.name}</strong>
          </div>
          <span className="persona-name">
            {player.persona.title} · {player.persona.subtitle}
          </span>
          <b className="stack">{player.stack.toLocaleString()} <small>({amountBB(player.stack)})</small></b>
        </div>
        <span className="position-pill">{player.position}</span>
      </div>
    </div>
  );
}

function TableMarker({
  player,
  seat,
  dealer,
}: {
  player: Player;
  seat: number;
  dealer: boolean;
}) {
  if (!dealer && !player.lastAction && player.streetBet <= 0) return null;
  return (
    <div
      className={`table-marker marker-seat-${seat} ${player.folded ? "marker-folded" : ""}`}
      aria-label={`${player.name} 桌面标记`}
    >
      {player.lastAction && <div className="marker-action">{player.lastAction}</div>}
      <div className="marker-row">
        {dealer && <span className="table-dealer">D</span>}
        {player.streetBet > 0 && (
          <span className="table-bet">
            <i className="chip-stack" />
            <b>{player.streetBet}</b>
          </span>
        )}
      </div>
    </div>
  );
}

function FrequencyBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="trait">
      <span>{label}</span>
      <div>
        <i style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </div>
      <b>{Math.round(value * 100)}</b>
    </div>
  );
}

export function PokerTrainer({ initialGame }: { initialGame: GameState }) {
  const [game, setGame] = useState<GameState>(initialGame);
  const [raiseTo, setRaiseTo] = useState(6);
  const [showLog, setShowLog] = useState(true);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showBuyIn, setShowBuyIn] = useState(false);
  const [buyInBB, setBuyInBB] = useState(100);
  const [buyInDraft, setBuyInDraft] = useState(100);
  const [hands, setHands] = useState<StoredHand[]>([]);
  const [apiReady, setApiReady] = useState(false);
  const [thinking, setThinking] = useState("");
  const [copied, setCopied] = useState(false);
  const [clearStatus, setClearStatus] = useState<"idle" | "clearing" | "cleared" | "error">("idle");
  const sessionId = useRef(`S${Date.now().toString(36)}`);
  const loggedHand = useRef(0);
  const decisionToken = useRef(0);

  const actor = game.players[game.actingIndex];
  const hero = game.players.find((player) => player.isHero) as Player;
  const heroLegal = actor?.isHero ? legalActions(game, actor) : [];
  const toCall = actor?.isHero ? Math.max(0, game.currentBet - actor.streetBet) : 0;
  const minRaiseTo = actor?.isHero
    ? Math.min(actor.streetBet + actor.stack, game.currentBet + game.minRaise)
    : 0;
  const maxRaiseTo = actor?.isHero ? actor.streetBet + actor.stack : 0;

  useEffect(() => {
    fetch("/api/ai/status")
      .then((response) => response.json())
      .then((data) => setApiReady(Boolean(data.configured)))
      .catch(() => setApiReady(false));
    fetch("/api/hands")
      .then((response) => response.json())
      .then((data) => setHands(Array.isArray(data.hands) ? data.hands : []))
      .catch(() => setHands([]));
  }, []);

  useEffect(() => {
    if (!actor?.isHero || game.handComplete) return;
    setRaiseTo(Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(totalPot(game) * 0.75 + game.currentBet))));
  }, [actor?.id, actor?.isHero, game.handComplete, game.handNo, game.street, maxRaiseTo, minRaiseTo]);

  const logFinishedHand = useCallback(async (finished: GameState) => {
    if (loggedHand.current === finished.handNo) return;
    loggedHand.current = finished.handNo;
    const line = compactHandLog(finished);
    const heroPlayer = finished.players.find((player) => player.isHero) as Player;
    const resultBb = (heroPlayer.stack - finished.heroStartStack) / BIG_BLIND;
    const optimistic: StoredHand = {
      id: Date.now(),
      handId: `${sessionId.current}-H${String(finished.handNo).padStart(4, "0")}`,
      markdown: line,
      resultBb,
      createdAt: new Date().toISOString(),
    };
    setHands((current) => [optimistic, ...current.filter((hand) => hand.handId !== optimistic.handId)]);
    try {
      const response = await fetch("/api/hands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handId: optimistic.handId,
          heroCards: heroPlayer.hole.map(cardCode).join(""),
          summary: finished.message,
          resultBb,
          markdown: line,
        }),
      });
      const data = await response.json();
      if (data.hand) {
        setHands((current) => [data.hand, ...current.filter((hand) => hand.handId !== data.hand.handId)]);
      }
    } catch {
      // The on-screen copy remains available even if durable storage is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    if (game.handComplete) void logFinishedHand(game);
  }, [game, logFinishedHand]);

  useEffect(() => {
    if (game.handComplete || !actor || actor.isHero) {
      setThinking("");
      return;
    }
    const token = ++decisionToken.current;
    setThinking(`${actor.name} 正在思考`);
    const delay = 420 + Math.round(Math.random() * 620);
    const timer = window.setTimeout(async () => {
      let decision = localBotDecision(game, actor);
      if (apiReady) {
        try {
          const response = await fetch("/api/ai/decision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              persona: {
                id: actor.persona.id,
                title: actor.persona.title,
                prompt: actor.persona.prompt,
              },
              observation: botObservation(game, actor),
            }),
          });
          if (response.ok) {
            const data = await response.json();
            if (data.action && legalActions(game, actor).includes(data.action)) {
              decision = { action: data.action, raiseTo: data.raiseTo };
            }
          }
        } catch {
          // Local personality engine keeps the table playable.
        }
      }
      if (token !== decisionToken.current) return;
      setGame((current) => {
        if (
          current.handNo !== game.handNo ||
          current.actingIndex !== game.actingIndex ||
          current.handComplete
        ) return current;
        return applyAction(current, decision.action, decision.raiseTo);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [actor, apiReady, game]);

  const act = (action: ActionKind, amount?: number) => {
    decisionToken.current += 1;
    setGame((current) => applyAction(current, action, amount));
  };

  const newHand = () => {
    decisionToken.current += 1;
    setCopied(false);
    setGame((current) => {
      const prepared: GameState = {
        ...current,
        players: current.players.map((player) =>
          player.isHero ? { ...player, stack: buyInBB * BIG_BLIND } : player,
        ),
      };
      return startHand(prepared);
    });
  };

  const copyLogs = async () => {
    const ordered = [...hands].reverse().map((hand) => hand.markdown);
    await navigator.clipboard.writeText(markdownLog(ordered));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const downloadLogs = () => {
    const ordered = [...hands].reverse().map((hand) => hand.markdown);
    const blob = new Blob([markdownLog(ordered)], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `AI训练牌局日志_${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const clearLogs = async () => {
    if (clearStatus === "clearing" || hands.length === 0) return;
    const previousHands = hands;
    setHands([]);
    setClearStatus("clearing");
    try {
      const response = await fetch("/api/hands", { method: "DELETE" });
      if (!response.ok) throw new Error("Clear failed");
      setClearStatus("cleared");
      window.setTimeout(() => setClearStatus("idle"), 1500);
    } catch {
      setHands(previousHands);
      setClearStatus("error");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <strong>MIST TABLE</strong>
            <small>AI POKER TRAINING ROOM</small>
          </div>
        </div>
        <div className="table-title">
          <strong>黑雾训练桌 · 8 MAX</strong>
          <span>NLH CASH&nbsp;&nbsp;1 / 2</span>
        </div>
        <nav>
          <button
            className="buyin-button"
            onClick={() => {
              setBuyInDraft(buyInBB);
              setShowBuyIn(true);
            }}
          >
            <span>BUY-IN</span>
            <b>{buyInBB}BB</b>
          </button>
          <span className="status-chip fog"><i /> 迷雾开启</span>
          <span className={`status-chip ${apiReady ? "online" : "local"}`}>
            <i /> {apiReady ? "统一 API 已连接" : "本地人格引擎"}
          </span>
          <button className="icon-button" onClick={() => setShowPlayers(true)} aria-label="AI 玩家设置">
            ⚙
          </button>
          <button className="icon-button log-toggle" onClick={() => setShowLog((value) => !value)} aria-label="牌局记录">
            ≡
          </button>
        </nav>
      </header>

      <section className={`game-layout ${showLog ? "" : "log-hidden"}`}>
        <div className="table-stage">
          <div className="ambient ambient-one" />
          <div className="ambient ambient-two" />
          <div className="poker-table">
            <div className="rail">
              <div className="felt">
                <div className="felt-lines" />
                <div className="table-center">
                  <div className="pot-label">
                    <span>总底池</span>
                    <strong>{totalPot(game)}</strong>
                    <small>{amountBB(totalPot(game))}</small>
                  </div>
                  <div className="community-cards" aria-label="公共牌">
                    {[0, 1, 2, 3, 4].map((index) =>
                      game.community[index] ? (
                        <PlayingCard key={index} card={game.community[index]} />
                      ) : (
                        <span className="card-slot" key={index} />
                      ),
                    )}
                  </div>
                </div>
              </div>
            </div>

            {game.players.map((player, seat) => (
              <PlayerSeat
                key={player.id}
                player={player}
                seat={seat}
                active={!game.handComplete && seat === game.actingIndex}
                winner={game.winners.includes(player.id)}
                reveal={game.revealed.includes(player.id)}
              />
            ))}
            {game.players.map((player, seat) => (
              <TableMarker
                key={`marker-${player.id}`}
                player={player}
                seat={seat}
                dealer={seat === game.dealerIndex}
              />
            ))}
          </div>

          <div className="table-footer">
            <div className="hand-meta">
              <span>H#{String(game.handNo).padStart(4, "0")}</span>
              <span>BTN {game.players[game.dealerIndex].name}</span>
              <span>{thinking || (actor?.isHero ? "轮到你行动" : game.message)}</span>
            </div>

            <div className={`action-dock ${game.handComplete ? "complete" : ""}`}>
              {game.handComplete ? (
                <>
                  <div className="result-copy">
                    <span>本手结果</span>
                    <strong className={hero.stack - game.heroStartStack >= 0 ? "positive" : "negative"}>
                      {hero.stack - game.heroStartStack >= 0 ? "+" : ""}
                      {amountBB(hero.stack - game.heroStartStack)}
                    </strong>
                    <small>{compactHandLog(game)}</small>
                  </div>
                  <button className="primary-action next-hand" onClick={newHand}>
                    下一手 <kbd>N</kbd>
                  </button>
                </>
              ) : actor?.isHero ? (
                <div className="decision-actions">
                  <div className="basic-actions">
                    {heroLegal.includes("fold") && (
                      <button className="fold-button" onClick={() => act("fold")}>
                        <span>Fold</span><kbd>F</kbd>
                      </button>
                    )}
                    {heroLegal.includes("check") && (
                      <button className="check-button" onClick={() => act("check")}>
                        <span>Check</span><kbd>X</kbd>
                      </button>
                    )}
                    {heroLegal.includes("call") && (
                      <button className="call-button" onClick={() => act("call")}>
                        <span>Call</span><b>{toCall}</b><kbd>C</kbd>
                      </button>
                    )}
                  </div>
                  <div className="raise-zone">
                    {heroLegal.includes("raise") && (
                      <div className="raise-control">
                        <div className="raise-presets">
                          {[0.33, 0.75, 1].map((size) => {
                            const target = Math.min(
                              maxRaiseTo,
                              Math.max(minRaiseTo, Math.round(game.currentBet + totalPot(game) * size)),
                            );
                            return (
                              <button key={size} onClick={() => setRaiseTo(target)}>
                                {Math.round(size * 100)}%
                              </button>
                            );
                          })}
                          <button onClick={() => setRaiseTo(maxRaiseTo)}>ALL-IN</button>
                        </div>
                        <div className="raise-main">
                          <input
                            aria-label="加注到"
                            type="range"
                            min={minRaiseTo}
                            max={Math.max(minRaiseTo, maxRaiseTo)}
                            value={Math.max(minRaiseTo, Math.min(maxRaiseTo, raiseTo))}
                            onChange={(event) => setRaiseTo(Number(event.target.value))}
                          />
                          <button className="primary-action" onClick={() => act("raise", raiseTo)}>
                            <span>Raise to</span><b>{raiseTo}</b><kbd>R</kbd>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="waiting-state">
                  <span className="thinking-dots"><i /><i /><i /></span>
                  <div>
                    <b>{thinking || "AI 正在行动"}</b>
                    <small>每位 AI 只收到自己的底牌和公开桌面信息</small>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="log-panel">
          <div className="panel-heading">
            <div>
              <span>SESSION LOG</span>
              <h2>逐手记录</h2>
            </div>
            <button onClick={() => setShowLog(false)} aria-label="关闭记录">×</button>
          </div>
          <div className="session-summary">
            <div>
              <span>已记录</span>
              <strong>{hands.length}<small> 手</small></strong>
            </div>
            <div>
              <span>Hero 净结果</span>
              <strong className={hands.reduce((sum, hand) => sum + hand.resultBb, 0) >= 0 ? "positive" : "negative"}>
                {hands.reduce((sum, hand) => sum + hand.resultBb, 0) >= 0 ? "+" : ""}
                {hands.reduce((sum, hand) => sum + hand.resultBb, 0).toFixed(1)}<small> BB</small>
              </strong>
            </div>
          </div>
          <div className="log-list">
            {hands.length === 0 ? (
              <div className="empty-log">
                <span>♠</span>
                <b>第一手正在进行</b>
                <p>结束后自动生成一行极简牌谱。</p>
              </div>
            ) : (
              hands.map((hand) => (
                <article key={`${hand.id}-${hand.handId}`}>
                  <div>
                    <b>{hand.markdown.match(/^H#\d+/)?.[0] ?? hand.handId}</b>
                    <span className={hand.resultBb >= 0 ? "positive" : "negative"}>
                      {hand.resultBb >= 0 ? "+" : ""}{hand.resultBb.toFixed(1)} BB
                    </span>
                  </div>
                  <p>{hand.markdown}</p>
                </article>
              ))
            )}
          </div>
          <div className="log-actions">
            <button onClick={copyLogs}>{copied ? "已复制" : "复制 Markdown"}</button>
            <button className="download" onClick={downloadLogs}>下载 .md</button>
            <button
              className="clear-logs"
              onClick={clearLogs}
              disabled={hands.length === 0 || clearStatus === "clearing"}
            >
              {clearStatus === "clearing"
                ? "正在清空…"
                : clearStatus === "cleared"
                  ? "已清空"
                  : clearStatus === "error"
                    ? "清空失败 · 重试"
                    : "一键清空记录"}
            </button>
          </div>
          <p className="storage-note"><i /> 自动保存到私人训练记录</p>
        </aside>
      </section>

      {showPlayers && (
        <div className="modal-backdrop" onClick={() => setShowPlayers(false)}>
          <section className="persona-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>TABLE LINEUP</span>
                <h2>7 位 AI 对手</h2>
                <p>同一 API，不同系统人格；买入与打法独立。</p>
              </div>
              <button onClick={() => setShowPlayers(false)} aria-label="关闭">×</button>
            </header>
            <div className="persona-grid">
              {game.players.filter((player) => !player.isHero).map((player) => (
                <article key={player.id} style={{ "--player-color": player.persona.color } as React.CSSProperties}>
                  <div className="persona-title">
                    <span>{player.persona.icon}</span>
                    <div>
                      <b>{player.name}</b>
                      <small>{player.persona.title} · {player.persona.subtitle}</small>
                    </div>
                    <strong>{player.persona.buyInBB}BB</strong>
                  </div>
                  <FrequencyBar label="入池" value={player.persona.looseness} color={player.persona.color} />
                  <FrequencyBar label="进攻" value={player.persona.aggression} color={player.persona.color} />
                  <FrequencyBar label="诈唬" value={player.persona.bluff} color={player.persona.color} />
                </article>
              ))}
            </div>
            <footer>
              <span className={`connection-light ${apiReady ? "connected" : ""}`} />
              {apiReady
                ? "统一 API 已连接：每次行动发送独立、脱敏后的玩家视角。"
                : "当前使用本地人格引擎；配置统一 API 后会自动切换。"}
            </footer>
          </section>
        </div>
      )}

      {showBuyIn && (
        <div className="modal-backdrop" onClick={() => setShowBuyIn(false)}>
          <section className="buyin-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>TABLE BUY-IN</span>
                <h2>选择下一手买入</h2>
                <p>盲注 1/2 · 选择后从下一手开始生效</p>
              </div>
              <button onClick={() => setShowBuyIn(false)} aria-label="关闭">×</button>
            </header>
            <div className="buyin-options">
              {[50, 100, 150, 200, 300].map((value) => (
                <button
                  key={value}
                  className={buyInDraft === value ? "selected" : ""}
                  onClick={() => setBuyInDraft(value)}
                >
                  <b>{value}</b>
                  <span>BB</span>
                  <small>{value * BIG_BLIND} 筹码</small>
                </button>
              ))}
            </div>
            <div className="buyin-slider">
              <div>
                <span>自定义买入</span>
                <strong>{buyInDraft}BB</strong>
              </div>
              <input
                aria-label="买入大盲数量"
                type="range"
                min={40}
                max={300}
                step={10}
                value={buyInDraft}
                onChange={(event) => setBuyInDraft(Number(event.target.value))}
              />
            </div>
            <button
              className="buyin-confirm"
              onClick={() => {
                setBuyInBB(buyInDraft);
                setShowBuyIn(false);
              }}
            >
              确认买入 {buyInDraft}BB
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
