"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/lib/supabaseClient";
import { ArrowPathIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";

type Grade = "bad" | "mid" | "good";

type BaseCard = {
  id: string;
  question: string;
  answer: string;
};

type CardProgress = {
  reps: number;
  ease: number;
  interval: number;
  due: number;
  goodStreak: number;
};

type ReviewCard = BaseCard & CardProgress;

type ReviewEvent = {
  ts: number;
  grade: Grade;
  cardId: string;
};

type ReviewStats = {
  count: number;
  bad: number;
  mid: number;
  good: number;
};

type SessionSyncPayload = {
  progress: Record<string, CardProgress>;
  history: ReviewEvent[];
  updatedAt: number;
};

const AUTH_STORAGE_KEY = "flashcards_pin_ok";
const SESSION_CODE_STORAGE_KEY = "flashcards_session_code";
const ADMIN_LOGIN_CODE = "260809";
const GLOBAL_DECK_ID = "26080900-0000-4000-8000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1000;
const REMOTE_SYNC_INTERVAL_MS = 10000;

function dayNumber(ts = Date.now()) {
  return Math.floor(ts / DAY_MS);
}

function defaultProgress(): CardProgress {
  return { reps: 0, ease: 2, interval: 0, due: 0, goodStreak: 0 };
}

function sanitizeProgress(value: unknown): Record<string, CardProgress> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const next: Record<string, CardProgress> = {};
  for (const [cardId, rowValue] of Object.entries(value)) {
    if (!rowValue || typeof rowValue !== "object") continue;
    const row = rowValue as Partial<CardProgress>;

    const reps = Number(row.reps ?? 0);
    const ease = Number(row.ease ?? 2);
    const interval = Number(row.interval ?? 0);
    const due = Number(row.due ?? 0);
    const goodStreak = Number(row.goodStreak ?? 0);

    if (![reps, ease, interval, due, goodStreak].every(Number.isFinite)) continue;

    next[cardId] = {
      reps: Math.max(0, Math.floor(reps)),
      ease: Math.max(1.2, Math.min(3, ease)),
      interval: Math.max(0, Math.floor(interval)),
      due: Math.max(0, Math.floor(due)),
      goodStreak: Math.max(0, Math.floor(goodStreak)),
    };
  }

  return next;
}

function sanitizeHistory(value: unknown): ReviewEvent[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is ReviewEvent => {
      if (!item || typeof item !== "object") return false;
      const event = item as Partial<ReviewEvent>;
      return (
        typeof event.ts === "number" &&
        typeof event.cardId === "string" &&
        (event.grade === "bad" || event.grade === "mid" || event.grade === "good")
      );
    })
    .slice(-5000);
}

function mergeCardsWithProgress(baseCards: BaseCard[], progressMap: Record<string, CardProgress>) {
  return baseCards.map((card) => ({ ...card, ...(progressMap[card.id] ?? defaultProgress()) }));
}

function buildReviewQueue(
  allCards: ReviewCard[],
  events: ReviewEvent[],
  options?: { preserveCurrentId?: string; avoidCurrentId?: string }
) {
  if (!allCards.length) return [];

  const today = dayNumber();
  const lastGradeByCard = new Map<string, Grade>();
  const stepsSinceSeen = new Map<string, number>();
  const recentLimit = Math.min(events.length, 500);

  for (let i = events.length - 1, step = 0; i >= events.length - recentLimit; i -= 1, step += 1) {
    const event = events[i];
    if (!lastGradeByCard.has(event.cardId)) {
      lastGradeByCard.set(event.cardId, event.grade);
    }
    if (!stepsSinceSeen.has(event.cardId)) {
      stepsSinceSeen.set(event.cardId, step);
    }
  }

  const scored = allCards.map((card) => {
    let score = 10;

    if (card.reps <= 0) score += 24;
    if (card.due <= today) score += 14 + Math.min(10, today - card.due);

    score += Math.max(0, 5 - card.goodStreak) * 2;
    score += Math.max(0, 3 - card.interval);

    const lastGrade = lastGradeByCard.get(card.id);
    if (lastGrade === "bad") score += 18;
    if (lastGrade === "mid") score += 8;
    if (lastGrade === "good") score -= 4;

    const steps = stepsSinceSeen.get(card.id);
    if (steps === undefined) {
      score += 8;
    } else if (steps <= 1) {
      score -= 12;
    } else if (steps <= 3) {
      score -= 6;
    } else if (steps <= 7) {
      score -= 2;
    }

    return { card, score };
  });

  scored.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  const queue = scored.map((row) => row.card);

  if (options?.avoidCurrentId && queue.length > 1 && queue[0].id === options.avoidCurrentId) {
    const first = queue.shift();
    if (first) {
      queue.splice(Math.min(2, queue.length), 0, first);
    }
  }

  if (options?.preserveCurrentId) {
    const index = queue.findIndex((card) => card.id === options.preserveCurrentId);
    if (index > 0) {
      const [picked] = queue.splice(index, 1);
      queue.unshift(picked);
    }
  }

  return queue;
}

function nextSchedule(card: ReviewCard, grade: Grade, reviewedAt = Date.now()) {
  const baseInterval = Math.max(1, card.interval || 1);
  const nextGoodStreak = grade === "good" ? card.goodStreak + 1 : 0;

  const easeFactor = { bad: 0.88, mid: 0.96, good: 1.08 }[grade];
  const nextEase = Math.max(1.2, Math.min(3.0, card.ease * easeFactor));

  let nextInterval = 1;
  if (grade === "bad") {
    nextInterval = 1;
  } else if (grade === "mid") {
    nextInterval = 1;
  } else if (nextGoodStreak === 1) {
    nextInterval = Math.max(2, Math.round(baseInterval * 1.6));
  } else if (nextGoodStreak === 2) {
    nextInterval = Math.max(7, Math.round(baseInterval * 2.8));
  } else {
    const veryLong = Math.max(30, Math.round(baseInterval * 4.5));
    nextInterval = Math.min(365, veryLong + (nextGoodStreak - 3) * 30);
  }

  return {
    reps: card.reps + 1,
    ease: nextEase,
    interval: nextInterval,
    due: dayNumber(reviewedAt) + nextInterval,
    goodStreak: nextGoodStreak,
  } satisfies CardProgress;
}

function progressFromHistory(events: ReviewEvent[]) {
  const map: Record<string, CardProgress> = {};

  for (const event of events) {
    const prev = map[event.cardId] ?? defaultProgress();
    const temp: ReviewCard = { id: event.cardId, question: "", answer: "", ...prev };
    map[event.cardId] = nextSchedule(temp, event.grade, event.ts);
  }

  return map;
}

function reviewStats(events: ReviewEvent[]): ReviewStats {
  return events.reduce(
    (acc, event) => {
      acc.count += 1;
      acc[event.grade] += 1;
      return acc;
    },
    { count: 0, bad: 0, mid: 0, good: 0 }
  );
}

function rate(part: number, total: number) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function dailySeries(events: ReviewEvent[], days: number) {
  const map = new Map<string, number>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const k = d.toISOString().slice(0, 10);
    map.set(k, 0);
  }

  for (const event of events) {
    const k = new Date(event.ts).toISOString().slice(0, 10);
    if (map.has(k)) {
      map.set(k, (map.get(k) ?? 0) + 1);
    }
  }

  return Array.from(map.entries()).map(([date, count]) => ({
    label: date.slice(5),
    count,
  }));
}

export default function Dashboard() {
  const [sessionCode, setSessionCode] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(0);

  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [current, setCurrent] = useState<ReviewCard>();
  const [showA, setShowA] = useState(false);
  const [tab, setTab] = useState<"review" | "stats">("review");
  const [history, setHistory] = useState<ReviewEvent[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const sessionCodeRef = useRef("");
  const syncInFlightRef = useRef(false);
  const currentIdRef = useRef<string | undefined>(undefined);
  const showARef = useRef(false);

  useEffect(() => {
    currentIdRef.current = current?.id;
  }, [current]);

  useEffect(() => {
    showARef.current = showA;
  }, [showA]);

  const loadSharedCards = useCallback(
    async (
      progressOverride: Record<string, CardProgress>,
      historyOverride: ReviewEvent[],
      options?: { preserveCurrentId?: string; avoidCurrentId?: string }
    ) => {
      const { data, error } = await supabase
        .from("cards")
        .select("id,question,answer")
        .eq("deck_id", GLOBAL_DECK_ID)
        .order("question_number", { ascending: true });

      if (error) {
        alert(error.message);
        return undefined;
      }

      const baseCards = (data ?? []) as BaseCard[];
      const merged = mergeCardsWithProgress(baseCards, progressOverride);
      const orderedQueue = buildReviewQueue(merged, historyOverride, options);
      const nextCurrent = orderedQueue[0];

      setCards(merged);
      setQueue(orderedQueue);
      setCurrent(nextCurrent);
      return nextCurrent?.id;
    },
    []
  );

  const applyRemoteSnapshot = useCallback(
    async (snapshot: SessionSyncPayload) => {
      const cleanHistory = sanitizeHistory(snapshot.history);
      const progressMap = progressFromHistory(cleanHistory);
      const lastHistoryTs = cleanHistory.length ? cleanHistory[cleanHistory.length - 1].ts : 0;
      const previousCurrentId = currentIdRef.current;
      const previousShowAnswer = showARef.current;

      setHistory(cleanHistory);
      setLastSyncedAt(Math.max(snapshot.updatedAt || 0, lastHistoryTs));

      const nextCurrentId = await loadSharedCards(progressMap, cleanHistory, { preserveCurrentId: previousCurrentId });
      const keepAnswerVisible = Boolean(previousCurrentId) && nextCurrentId === previousCurrentId;
      setShowA(keepAnswerVisible ? previousShowAnswer : false);
    },
    [loadSharedCards]
  );

  const fetchSessionSync = useCallback(async (code: string): Promise<SessionSyncPayload> => {
    const res = await fetch(`/api/session-progress?code=${encodeURIComponent(code)}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "session fetch failed");
    }

    const data = (await res.json()) as {
      progress?: unknown;
      history?: unknown;
      updatedAt?: unknown;
    };

    const updatedAt = Number(data.updatedAt ?? 0);
    return {
      progress: sanitizeProgress(data.progress),
      history: sanitizeHistory(data.history),
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0,
    };
  }, []);

  const logReviewAction = useCallback(
    async (payload: {
      code: string;
      cardId: string;
      grade: Grade;
      ts: number;
    }) => {
      const res = await fetch("/api/session-progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "action sync failed");
      }
    },
    []
  );

  const refreshFromRemote = useCallback(
    async (force = false) => {
      const code = sessionCodeRef.current;
      if (!code || syncInFlightRef.current) return;

      syncInFlightRef.current = true;
      try {
        const remote = await fetchSessionSync(code);
        const remoteTs = remote.updatedAt || (remote.history.length ? remote.history[remote.history.length - 1].ts : 0);

        if (force || remoteTs > lastSyncedAt) {
          await applyRemoteSnapshot({ ...remote, updatedAt: remoteTs });
        }
      } catch {
        // Keep current UI when sync is temporarily unavailable.
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [applyRemoteSnapshot, fetchSessionSync, lastSyncedAt]
  );

  const refreshAdminSession = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/session", { method: "GET" });
      if (!res.ok) {
        setIsAdmin(false);
        return;
      }

      const data = (await res.json()) as { isAdmin?: boolean };
      setIsAdmin(Boolean(data.isAdmin));
    } catch {
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => {
    const isAuthed = localStorage.getItem(AUTH_STORAGE_KEY) === "1";
    const code = localStorage.getItem(SESSION_CODE_STORAGE_KEY) ?? "";

    if (!isAuthed || !code) {
      location.href = "/";
      return;
    }

    sessionCodeRef.current = code;
    setSessionCode(code);

    queueMicrotask(() => {
      void (async () => {
        if (code === ADMIN_LOGIN_CODE) {
          await fetch("/api/admin/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          }).catch(() => null);
        }

        await refreshAdminSession();

        try {
          const remote = await fetchSessionSync(code);
          await applyRemoteSnapshot(remote);
        } catch {
          setHistory([]);
          setLastSyncedAt(0);
          await loadSharedCards({}, []);
        }
      })();
    });
  }, [applyRemoteSnapshot, fetchSessionSync, loadSharedCards, refreshAdminSession]);

  useEffect(() => {
    if (!sessionCode) return;

    const onFocus = () => {
      void refreshFromRemote();
    };

    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      void refreshFromRemote();
    }, REMOTE_SYNC_INTERVAL_MS);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refreshFromRemote, sessionCode]);

  async function parseCsv(file: File) {
    if (!isAdmin) {
      alert("Seul le code 260809 peut importer un CSV global.");
      return;
    }

    Papa.parse(file, {
      skipEmptyLines: true,
      complete: async (res) => {
        const rawRows = (res.data as string[][]).slice(1);
        const payload = rawRows
          .map((r) => [String(r[0] ?? "").trim(), String(r[1] ?? "").trim()])
          .filter(([q, a]) => q && a)
          .flatMap(([q, a]) => [
            { question: q, answer: a },
            { question: a, answer: q },
          ]);

        if (!payload.length) {
          alert("Le CSV ne contient pas de cartes valides (colonnes A/B). La premiere ligne est ignoree.");
          return;
        }

        const resp = await fetch("/api/admin/cards/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload }),
        });

        if (!resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as { error?: string };
          alert(data.error ?? "Import impossible");
          return;
        }

        await refreshFromRemote(true);
      },
      error: (error) => {
        alert(`Erreur CSV: ${error.message}`);
      },
    });
  }

  async function clearCurrentCsv() {
    if (!isAdmin) {
      alert("Seul le code 260809 peut supprimer le CSV global.");
      return;
    }

    const ok = window.confirm("Supprimer toutes les cartes du CSV global ? Cette action est irreversible.");
    if (!ok) return;

    const resp = await fetch("/api/admin/cards", { method: "DELETE" });
    if (!resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? "Suppression impossible");
      return;
    }

    setHistory([]);
    setLastSyncedAt(Date.now());
    setCards([]);
    setQueue([]);
    setCurrent(undefined);
    setShowA(false);
    await refreshFromRemote(true);
  }

  function grade(g: Grade) {
    if (!current) return;

    const reviewedAt = Date.now();
    const schedule = nextSchedule(current, g, reviewedAt);
    const updatedCard: ReviewCard = { ...current, ...schedule };

    const nextCards = cards.map((card) => (card.id === current.id ? updatedCard : card));
    const nextHistory = [...history, { ts: reviewedAt, grade: g, cardId: current.id }].slice(-5000);
    const nextQueue = buildReviewQueue(nextCards, nextHistory, { avoidCurrentId: current.id });

    setCards(nextCards);
    setHistory(nextHistory);
    setLastSyncedAt(reviewedAt);
    setQueue(nextQueue);
    setCurrent(nextQueue[0]);

    setShowA(false);

    if (sessionCodeRef.current) {
      void (async () => {
        try {
          await logReviewAction({
            code: sessionCodeRef.current,
            cardId: current.id,
            grade: g,
            ts: reviewedAt,
          });
          await refreshFromRemote(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : "sync error";
          alert(`Erreur de synchronisation: ${message}`);
        }
      })();
    }
  }

  function logout() {
    void fetch("/api/admin/session", { method: "DELETE" });
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(SESSION_CODE_STORAGE_KEY);
    location.href = "/";
  }

  function gradeButton(type: Grade) {
    return clsx(
      "flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-xl shadow-md",
      type === "bad" && "bg-rose-500/20 text-rose-300 hover:bg-rose-600/30",
      type === "mid" && "bg-amber-500/20 text-amber-300 hover:bg-amber-600/30",
      type === "good" && "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-600/30"
    );
  }

  const today = dayNumber();
  const unseenCount = useMemo(() => cards.filter((card) => card.reps <= 0).length, [cards]);
  const dueCount = useMemo(() => cards.filter((card) => card.reps > 0 && card.due <= today).length, [cards, today]);
  const masteredCount = useMemo(() => cards.filter((card) => card.goodStreak >= 3).length, [cards]);

  const globalStats = useMemo(() => reviewStats(history), [history]);
  const last30Stats = useMemo(() => reviewStats(history.slice(-30)), [history]);
  const last100Stats = useMemo(() => reviewStats(history.slice(-100)), [history]);

  const totalReps = useMemo(() => cards.reduce((sum, card) => sum + card.reps, 0), [cards]);
  const avgEase = useMemo(() => {
    if (!cards.length) return 0;
    return cards.reduce((sum, card) => sum + card.ease, 0) / cards.length;
  }, [cards]);
  const avgInterval = useMemo(() => {
    if (!cards.length) return 0;
    return cards.reduce((sum, card) => sum + card.interval, 0) / cards.length;
  }, [cards]);

  const trend = useMemo(() => dailySeries(history.slice(-100), 14), [history]);
  const trendMax = Math.max(...trend.map((d) => d.count), 1);
  const syncLabel = useMemo(() => {
    if (!lastSyncedAt) return "-";
    return new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }, [lastSyncedAt]);

  return (
    <main className="max-w-5xl mx-auto p-4 md:p-6 space-y-4">
      <header className="rounded-2xl p-4 md:p-5 border border-white/10 bg-gradient-to-r from-slate-900/80 via-slate-800/70 to-slate-900/80 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Flashcards SRS</p>
            <h1 className="text-xl md:text-2xl font-bold">Revision + Stats</h1>
            <p className="text-xs text-slate-400 mt-1">
              Code: {sessionCode || "-"} | Mode: {isAdmin ? "Admin CSV global" : "Session perso"} | Sync SQL: {syncLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 text-sm font-semibold"
                >
                  Import CSV
                </button>
                <button
                  onClick={clearCurrentCsv}
                  className="px-3 py-2 rounded-lg bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 text-sm font-semibold"
                >
                  Supprimer CSV
                </button>
              </>
            )}
            <button onClick={logout} className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm">
              Quitter
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-xl bg-black/30 p-1 w-fit">
          <button
            onClick={() => setTab("review")}
            className={clsx(
              "px-3 py-1.5 rounded-lg text-sm font-semibold transition",
              tab === "review" ? "bg-sky-500 text-white" : "text-slate-300 hover:text-white"
            )}
          >
            Revision
          </button>
          <button
            onClick={() => setTab("stats")}
            className={clsx(
              "px-3 py-1.5 rounded-lg text-sm font-semibold transition",
              tab === "stats" ? "bg-sky-500 text-white" : "text-slate-300 hover:text-white"
            )}
          >
            Stats
          </button>
        </div>
      </header>

      {tab === "review" ? (
        <section className="grid lg:grid-cols-[1fr_290px] gap-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 md:p-6 min-h-[320px]">
            {!current ? (
              <div className="h-full min-h-[280px] grid place-items-center text-center">
                <div className="space-y-3">
                  {cards.length > 0 ? (
                    <>
                      <p className="text-slate-300">Aucune carte due pour le moment.</p>
                      <p className="text-sm text-slate-400">Tu peux revenir plus tard, les cartes acquises sont repoussees.</p>
                    </>
                  ) : isAdmin ? (
                    <>
                      <p className="text-slate-300">Aucune carte globale pour le moment.</p>
                      <button
                        onClick={() => fileRef.current?.click()}
                        className="px-6 py-3 rounded-xl bg-sky-500 hover:bg-sky-600 font-semibold text-white shadow-lg"
                      >
                        Importer un CSV global
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-slate-300">Le CSV global n&apos;est pas encore importe.</p>
                      <p className="text-sm text-slate-400">Le deck sera visible des qu&apos;il sera importe.</p>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={current.id + (showA ? "-a" : "-q")}
                    initial={{ opacity: 0, y: 20, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -20, scale: 0.97 }}
                    transition={{ duration: 0.18 }}
                    className="rounded-3xl p-6 bg-gradient-to-b from-slate-800/60 to-slate-900/70 border border-white/10 shadow-xl select-none"
                  >
                    <p className="text-slate-300 text-xs mb-2">{showA ? "Reponse" : "Question"}</p>
                    <p className="text-xl md:text-2xl font-bold whitespace-pre-wrap">{showA ? current.answer : current.question}</p>
                  </motion.div>
                </AnimatePresence>

                <div className="mt-6 grid grid-cols-3 gap-3">
                  {showA ? (
                    <>
                      <button onClick={() => grade("bad")} className={gradeButton("bad")}>
                        <XMarkIcon className="w-5" /> Pas du tout
                      </button>
                      <button onClick={() => grade("mid")} className={gradeButton("mid")}>
                        <ArrowPathIcon className="w-5" /> Moyen
                      </button>
                      <button onClick={() => grade("good")} className={gradeButton("good")}>
                        <CheckIcon className="w-5" /> Bien
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setShowA(true)}
                      className="col-span-3 py-3 rounded-xl bg-sky-500/80 hover:bg-sky-600 font-semibold shadow-md"
                    >
                      Afficher la reponse
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <aside className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Session</p>
            <div className="grid grid-cols-2 gap-2">
              <StatChip label="Cartes" value={String(cards.length)} />
              <StatChip label="A revoir" value={String(dueCount)} />
              <StatChip label="Nouvelles" value={String(unseenCount)} />
              <StatChip label="Acquises 3x" value={String(masteredCount)} />
              <StatChip label="Dans la queue" value={String(queue.length)} />
              <StatChip label="Reps total" value={String(totalReps)} />
              <StatChip label="Ease moy." value={avgEase.toFixed(2)} />
            </div>
            <p className="text-xs text-slate-400">Progression reconstruite depuis les actions en base SQL.</p>
          </aside>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="grid md:grid-cols-4 gap-3">
            <StatChip label="Cartes" value={String(cards.length)} />
            <StatChip label="Revisions globales" value={String(globalStats.count)} />
            <StatChip label="Intervalle moyen" value={avgInterval.toFixed(1)} />
            <StatChip label="Taux de bonnes" value={`${rate(globalStats.good, globalStats.count)}%`} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <StatsPanel title="Global" stats={globalStats} />
            <StatsPanel title="30 dernieres" stats={last30Stats} />
            <StatsPanel title="100 dernieres" stats={last100Stats} />
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Activite (14 derniers jours)</h3>
              <p className="text-xs text-slate-400">Basee sur les 100 dernieres revisions</p>
            </div>
            <div className="grid grid-cols-7 md:grid-cols-14 gap-2 items-end min-h-[120px]">
              {trend.map((point) => (
                <div key={point.label} className="flex flex-col items-center gap-1">
                  <div
                    className="w-full rounded-md bg-gradient-to-t from-sky-500/70 to-cyan-300/70"
                    style={{ height: `${Math.max(8, (point.count / trendMax) * 100)}px` }}
                    title={`${point.label}: ${point.count}`}
                  />
                  <span className="text-[10px] text-slate-400">{point.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void parseCsv(file);
          }
          e.target.value = "";
        }}
      />
    </main>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}

function StatsPanel({ title, stats }: { title: string; stats: ReviewStats }) {
  const rows = [
    { key: "good", label: "Bien", color: "bg-emerald-400/80", value: stats.good },
    { key: "mid", label: "Moyen", color: "bg-amber-400/80", value: stats.mid },
    { key: "bad", label: "Rate", color: "bg-rose-400/80", value: stats.bad },
  ] as const;
  const max = Math.max(stats.good, stats.mid, stats.bad, 1);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-slate-400">{stats.count} rev.</span>
      </div>

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-300">
              <span>{row.label}</span>
              <span>
                {row.value} ({rate(row.value, stats.count)}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div className={clsx("h-full rounded-full", row.color)} style={{ width: `${(row.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
