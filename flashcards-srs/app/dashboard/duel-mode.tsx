"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  BoltIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  UserGroupIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";

const DUEL_PLAYER_STORAGE_KEY = "flashcards_duel_player_id";
const DUEL_CODE_STORAGE_KEY = "flashcards_duel_code";

type DuelPlayer = {
  slot: 1 | 2;
  joined: boolean;
  isSelf: boolean;
  score: number;
  answeredCurrentRound: boolean;
};

type DuelCard = {
  id: string;
  question: string;
  answer: string;
  questionNumber: number;
};

type ApiDuelSnapshot = {
  code: string;
  status: "waiting" | "active" | "finished";
  serverNow: number;
  revealSeconds: number;
  roundIndex: number;
  totalRounds: number;
  roundStartedAt: number;
  revealAt: number;
  finishedAt: number;
  joinedCount: number;
  selfSlot: 1 | 2 | null;
  currentCard: DuelCard | null;
  currentScore: number | null;
  players: DuelPlayer[];
};

type DuelSnapshot = ApiDuelSnapshot & {
  receivedAt: number;
};

function sanitizeCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

function makePlayerId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `duel_${crypto.randomUUID().replace(/-/g, "")}`;
  }

  return `duel_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function winnerLabel(selfScore: number, opponentScore: number) {
  if (selfScore > opponentScore) return "Victoire";
  if (selfScore < opponentScore) return "Defaite";
  return "Egalite";
}

async function readErrorMessage(response: Response) {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Erreur duel";
}

export function DuelModeButton({ deckCount }: { deckCount: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<"" | "create" | "join" | "answer">("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [playerId, setPlayerId] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [duel, setDuel] = useState<DuelSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const rememberCode = useCallback((code: string) => {
    localStorage.setItem(DUEL_CODE_STORAGE_KEY, code);
    setCodeInput(code);
  }, []);

  const forgetCode = useCallback(() => {
    localStorage.removeItem(DUEL_CODE_STORAGE_KEY);
    setDuel(null);
    setCodeInput("");
    setCopied(false);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: ApiDuelSnapshot) => {
      setDuel({ ...snapshot, receivedAt: Date.now() });
      rememberCode(snapshot.code);
      setError("");
    },
    [rememberCode]
  );

  const loadSnapshot = useCallback(
    async (code: string, nextPlayerId: string, options?: { silent?: boolean; clearOnMissing?: boolean }) => {
      if (!code || !nextPlayerId) return;

      if (!options?.silent) {
        setLoading(true);
      }

      try {
        const res = await fetch(`/api/duel?code=${encodeURIComponent(code)}&playerId=${encodeURIComponent(nextPlayerId)}`, {
          method: "GET",
          cache: "no-store",
        });

        if (!res.ok) {
          const message = await readErrorMessage(res);
          if (res.status === 404 && options?.clearOnMissing) {
            forgetCode();
          }
          if (!options?.silent) {
            setError(message);
          }
          return;
        }

        applySnapshot((await res.json()) as ApiDuelSnapshot);
      } catch {
        if (!options?.silent) {
          setError("Impossible de synchroniser le duel.");
        }
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [applySnapshot, forgetCode]
  );

  useEffect(() => {
    const storedPlayerId = localStorage.getItem(DUEL_PLAYER_STORAGE_KEY);
    const nextPlayerId = storedPlayerId || makePlayerId();

    if (!storedPlayerId) {
      localStorage.setItem(DUEL_PLAYER_STORAGE_KEY, nextPlayerId);
    }

    setPlayerId(nextPlayerId);

    const savedCode = sanitizeCode(localStorage.getItem(DUEL_CODE_STORAGE_KEY) ?? "");
    if (savedCode) {
      setCodeInput(savedCode);
    }
  }, []);

  useEffect(() => {
    if (!playerId) return;

    const savedCode = sanitizeCode(localStorage.getItem(DUEL_CODE_STORAGE_KEY) ?? "");
    if (!savedCode) return;

    void loadSnapshot(savedCode, playerId, { silent: true, clearOnMissing: true });
  }, [loadSnapshot, playerId]);

  useEffect(() => {
    if (!duel?.code || !playerId) return;
    if (!open && duel.status === "finished") return;

    const delay = duel.status === "waiting" ? 1500 : 2000;
    const timer = window.setInterval(() => {
      void loadSnapshot(duel.code, playerId, { silent: true });
    }, delay);

    return () => {
      window.clearInterval(timer);
    };
  }, [duel?.code, duel?.status, loadSnapshot, open, playerId]);

  useEffect(() => {
    if (!open || duel?.status !== "active") return;

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [duel?.status, open]);

  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 1400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  async function createDuel() {
    if (!playerId) return;

    setBusyAction("create");
    setError("");

    try {
      const res = await fetch("/api/duel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", playerId }),
      });

      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }

      applySnapshot((await res.json()) as ApiDuelSnapshot);
    } catch {
      setError("Creation du duel impossible.");
    } finally {
      setBusyAction("");
    }
  }

  async function joinDuel(e: FormEvent) {
    e.preventDefault();

    const code = sanitizeCode(codeInput);
    if (!playerId) return;
    if (code.length !== 6) {
      setError("Entre un code duel a 6 chiffres.");
      return;
    }

    setBusyAction("join");
    setError("");

    try {
      const res = await fetch("/api/duel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", code, playerId }),
      });

      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }

      applySnapshot((await res.json()) as ApiDuelSnapshot);
    } catch {
      setError("Impossible de rejoindre ce duel.");
    } finally {
      setBusyAction("");
    }
  }

  async function sendScore(score: 0 | 3 | 5) {
    if (!duel?.code || !playerId) return;

    setBusyAction("answer");
    setError("");

    try {
      const res = await fetch("/api/duel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "answer", code: duel.code, playerId, score }),
      });

      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }

      applySnapshot((await res.json()) as ApiDuelSnapshot);
    } catch {
      setError("Envoi du score impossible.");
    } finally {
      setBusyAction("");
    }
  }

  async function copyCode() {
    if (!duel?.code) return;

    try {
      await navigator.clipboard.writeText(duel.code);
      setCopied(true);
    } catch {
      setError("Copie du code impossible sur ce navigateur.");
    }
  }

  const selfPlayer = useMemo(() => duel?.players.find((player) => player.isSelf) ?? null, [duel]);
  const opponentPlayer = useMemo(() => duel?.players.find((player) => !player.isSelf) ?? duel?.players[1] ?? null, [duel]);
  const syncNow = duel ? now + (duel.serverNow - duel.receivedAt) : now;
  const msLeft = duel?.status === "active" ? Math.max(0, duel.revealAt - syncNow) : 0;
  const secondsLeft = msLeft > 0 ? Math.ceil(msLeft / 1000) : 0;
  const showAnswer = Boolean(duel && duel.status === "active" && msLeft <= 0);
  const selfScore = selfPlayer?.score ?? 0;
  const opponentScore = opponentPlayer?.score ?? 0;
  const finishedLabel = winnerLabel(selfScore, opponentScore);
  const canCreate = deckCount >= 10;

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setError("");
        }}
        className={clsx(
          "px-3 py-2 rounded-lg text-sm transition border",
          duel
            ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/15"
            : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
        )}
      >
        <span className="flex items-center gap-2">
          <BoltIcon className="w-4 h-4" />
          <span>Duel</span>
          {duel?.code && <span className="text-[11px] text-cyan-200/80">{duel.code}</span>}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm p-4 md:p-6"
          >
            <div className="min-h-full flex items-center justify-center">
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.98 }}
                transition={{ duration: 0.2 }}
                className="w-full max-w-3xl rounded-[28px] overflow-hidden border border-cyan-300/15 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.18),_transparent_42%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] shadow-2xl"
              >
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/10">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.26em] text-cyan-200/70">Mode duel</p>
                    <h2 className="text-xl font-bold text-white">10 cartes synchronisees, meme tirage pour les deux</h2>
                    <p className="text-sm text-slate-300 mt-1">
                      10 secondes pour reflechir, reponse auto, puis score personnel.
                    </p>
                  </div>
                  <button
                    onClick={() => setOpen(false)}
                    className="rounded-full p-2 bg-white/5 hover:bg-white/10 text-slate-300"
                    aria-label="Fermer le duel"
                  >
                    <XMarkIcon className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-5 md:p-6">
                  {!duel ? (
                    <div className="grid md:grid-cols-[1.1fr_0.9fr] gap-4">
                      <div className="rounded-3xl border border-white/10 bg-white/5 p-5 space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-full bg-cyan-400/10 px-3 py-1 text-xs text-cyan-100">
                          <UserGroupIcon className="w-4 h-4" />
                          2 joueurs, 10 manches, memes cartes
                        </div>
                        <h3 className="text-2xl font-bold">Creer un code duel ou rejoindre un code existant</h3>
                        <p className="text-sm text-slate-300">
                          Le duel reste dans ce pop-up et n&apos;interfere pas avec ton systeme de revision SRS.
                        </p>
                        <button
                          onClick={() => void createDuel()}
                          disabled={!canCreate || busyAction !== ""}
                          className={clsx(
                            "w-full rounded-2xl px-4 py-4 font-semibold transition",
                            canCreate
                              ? "bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                              : "bg-slate-800 text-slate-400 cursor-not-allowed"
                          )}
                        >
                          {busyAction === "create" ? "Creation..." : "Creer un duel"}
                        </button>
                        {!canCreate && (
                          <p className="text-sm text-amber-300">
                            Il faut au moins 10 cartes dans le deck global. Actuellement: {deckCount}.
                          </p>
                        )}
                      </div>

                      <form onSubmit={joinDuel} className="rounded-3xl border border-white/10 bg-black/20 p-5 space-y-4">
                        <p className="text-sm text-slate-300">Entre le code recu pour rejoindre la meme partie.</p>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="123456"
                          minLength={6}
                          maxLength={6}
                          value={codeInput}
                          onChange={(e) => {
                            setError("");
                            setCodeInput(sanitizeCode(e.target.value));
                          }}
                          className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4 text-center text-3xl tracking-[0.45em] font-bold text-white outline-none focus:border-cyan-300/50"
                        />
                        <button
                          type="submit"
                          disabled={busyAction !== ""}
                          className="w-full rounded-2xl px-4 py-4 bg-white/8 hover:bg-white/12 font-semibold"
                        >
                          {busyAction === "join" ? "Connexion..." : "Rejoindre le duel"}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <div className="grid md:grid-cols-[1fr_auto] gap-3 items-center">
                        <div className="rounded-3xl border border-cyan-300/15 bg-cyan-400/8 p-4">
                          <p className="text-xs uppercase tracking-[0.24em] text-cyan-100/70">Code duel</p>
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-3xl md:text-4xl font-black tracking-[0.35em] text-white">{duel.code}</span>
                            <button
                              onClick={() => void copyCode()}
                              className="rounded-xl border border-white/10 bg-white/5 p-3 hover:bg-white/10"
                              aria-label="Copier le code duel"
                            >
                              <ClipboardDocumentIcon className="w-5 h-5" />
                            </button>
                          </div>
                          <p className="text-xs text-cyan-100/70 mt-2">{copied ? "Code copie." : "Partage ce code a l'autre joueur."}</p>
                        </div>

                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => {
                              forgetCode();
                              setError("");
                            }}
                            className="rounded-xl px-3 py-2 bg-white/5 hover:bg-white/10 text-sm text-slate-200"
                          >
                            Quitter ce duel
                          </button>
                          <button
                            onClick={() => setOpen(false)}
                            className="rounded-xl px-3 py-2 bg-cyan-400/12 hover:bg-cyan-400/18 text-sm text-cyan-100"
                          >
                            Masquer
                          </button>
                        </div>
                      </div>

                      <div className="grid md:grid-cols-2 gap-3">
                        {duel.players.map((player) => (
                          <div
                            key={player.slot}
                            className={clsx(
                              "rounded-3xl border p-4",
                              player.isSelf
                                ? "border-cyan-300/30 bg-cyan-400/8"
                                : "border-white/10 bg-white/5"
                            )}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-xs uppercase tracking-[0.22em] text-slate-400">
                                  {player.isSelf ? "Toi" : "Adversaire"}
                                </p>
                                <p className="text-lg font-semibold text-white">
                                  {player.joined ? `Joueur ${player.slot}` : "En attente"}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="text-xs text-slate-400">Score</p>
                                <p className="text-2xl font-black text-white">{player.score}</p>
                              </div>
                            </div>
                            <p className="text-sm text-slate-300 mt-3">
                              {duel.status === "waiting"
                                ? player.joined
                                  ? "Pret pour le duel."
                                  : "Code en attente."
                                : duel.status === "finished"
                                  ? "Duel termine."
                                  : player.answeredCurrentRound
                                    ? "Score envoye pour cette manche."
                                    : "Score en attente pour cette manche."}
                            </p>
                          </div>
                        ))}
                      </div>

                      {duel.status === "waiting" && (
                        <div className="rounded-3xl border border-dashed border-cyan-300/20 bg-black/20 p-8 text-center space-y-3">
                          <p className="text-sm uppercase tracking-[0.28em] text-cyan-100/70">Lobby</p>
                          <h3 className="text-2xl font-bold">Le duel demarre des que le deuxieme joueur rejoint</h3>
                          <p className="text-slate-300">
                            Les 10 cartes sont deja verrouillees pour cette partie. Meme ordre, meme timing, meme reponse.
                          </p>
                        </div>
                      )}

                      {duel.status === "active" && duel.currentCard && (
                        <div className="space-y-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-sm text-slate-200">
                              <BoltIcon className="w-4 h-4 text-cyan-200" />
                              Manche {duel.roundIndex + 1}/{duel.totalRounds}
                            </div>
                            <div className="flex items-center gap-2 rounded-full bg-slate-950/70 px-3 py-1.5 text-sm text-slate-200">
                              <ClockIcon className="w-4 h-4 text-cyan-200" />
                              {showAnswer ? "Reponse visible" : `${secondsLeft}s avant la reponse`}
                            </div>
                          </div>

                          <AnimatePresence mode="wait">
                            <motion.div
                              key={`${duel.code}-${duel.roundIndex}-${showAnswer ? "answer" : "question"}`}
                              initial={{ opacity: 0, y: 18, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -18, scale: 0.98 }}
                              transition={{ duration: 0.18 }}
                              className={clsx(
                                "rounded-[30px] border p-6 md:p-8 shadow-xl",
                                showAnswer
                                  ? "border-emerald-300/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.12),rgba(15,23,42,0.92))]"
                                  : "border-cyan-300/20 bg-[linear-gradient(180deg,rgba(34,211,238,0.12),rgba(15,23,42,0.92))]"
                              )}
                            >
                              <p className="text-xs uppercase tracking-[0.24em] text-slate-300/80 mb-3">
                                {showAnswer ? "Reponse" : "Question"}
                              </p>
                              <p className="text-2xl md:text-3xl font-bold whitespace-pre-wrap text-white">
                                {showAnswer ? duel.currentCard.answer : duel.currentCard.question}
                              </p>
                              <p className="mt-4 text-sm text-slate-300">
                                {showAnswer
                                  ? "Choisis ton score personnel. La manche suivante part des que les deux ont note."
                                  : "Reflechis sans cliquer. La reponse apparait automatiquement."}
                              </p>
                            </motion.div>
                          </AnimatePresence>

                          <div className="grid md:grid-cols-3 gap-3">
                            {[
                              {
                                value: 5 as const,
                                label: "+5 Je savais",
                                hint: "Reponse nette, sans hesiter",
                                tone: "border-emerald-300/25 bg-emerald-400/12 text-emerald-100",
                              },
                              {
                                value: 3 as const,
                                label: "+3 Un peu",
                                hint: "Partiel, incomplet, presque bon",
                                tone: "border-amber-300/25 bg-amber-400/12 text-amber-100",
                              },
                              {
                                value: 0 as const,
                                label: "0 Pas du tout",
                                hint: "Tu n'avais pas la reponse",
                                tone: "border-rose-300/25 bg-rose-400/12 text-rose-100",
                              },
                            ].map((option) => {
                              const selected = duel.currentScore === option.value;
                              const disabled = !showAnswer || duel.currentScore !== null || busyAction === "answer";

                              return (
                                <button
                                  key={option.value}
                                  onClick={() => void sendScore(option.value)}
                                  disabled={disabled}
                                  className={clsx(
                                    "rounded-3xl border px-4 py-4 text-left transition",
                                    option.tone,
                                    !showAnswer && "opacity-45 cursor-not-allowed",
                                    duel.currentScore !== null && !selected && "opacity-45 cursor-not-allowed",
                                    selected && "ring-2 ring-white/60 scale-[1.01]"
                                  )}
                                >
                                  <p className="font-semibold">{option.label}</p>
                                  <p className="text-xs mt-1 opacity-80">{option.hint}</p>
                                </button>
                              );
                            })}
                          </div>

                          {duel.currentScore !== null && (
                            <div className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-slate-300">
                              {opponentPlayer?.answeredCurrentRound
                                ? "Scores recus. Synchronisation de la manche suivante..."
                                : "Ton score est envoye. On attend l'autre joueur."}
                            </div>
                          )}
                        </div>
                      )}

                      {duel.status === "finished" && (
                        <div className="rounded-[30px] border border-cyan-300/20 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.18),_transparent_44%),rgba(15,23,42,0.92)] p-6 md:p-8 text-center space-y-4">
                          <p className="text-xs uppercase tracking-[0.28em] text-cyan-100/70">Resultat final</p>
                          <h3 className="text-3xl font-black text-white">{finishedLabel}</h3>
                          <p className="text-slate-300">
                            Score final: {selfScore} a {opponentScore}
                          </p>
                          <div className="grid md:grid-cols-2 gap-3 text-left">
                            <div className="rounded-3xl border border-cyan-300/20 bg-cyan-400/10 p-4">
                              <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/70">Toi</p>
                              <p className="text-3xl font-black text-white mt-1">{selfScore}</p>
                            </div>
                            <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
                              <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Adversaire</p>
                              <p className="text-3xl font-black text-white mt-1">{opponentScore}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(error || loading) && (
                    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
                      <p className={error ? "text-rose-300" : "text-slate-400"}>{error || "Chargement du duel..."}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
