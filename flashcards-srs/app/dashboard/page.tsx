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

const AUTH_STORAGE_KEY = "flashcards_pin_ok";
const SESSION_CODE_STORAGE_KEY = "flashcards_session_code";
const HISTORY_STORAGE_PREFIX = "flashcards_review_history_";
const PROGRESS_STORAGE_PREFIX = "flashcards_progress_";
const GLOBAL_DECK_ID = "26080900-0000-4000-8000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(ts = Date.now()) {
  return Math.floor(ts / DAY_MS);
}

function shuffleCards<T>(list: T[]) {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function defaultProgress(): CardProgress {
  return { reps: 0, ease: 2, interval: 0, due: 0, goodStreak: 0 };
}

function parseProgress(raw: string | null): Record<string, CardProgress> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const next: Record<string, CardProgress> = {};
    for (const [cardId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Partial<CardProgress>;

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
  } catch {
    return {};
  }
}

function toProgressMap(cards: ReviewCard[]) {
  const map: Record<string, CardProgress> = {};
  for (const card of cards) {
    map[card.id] = {
      reps: card.reps,
      ease: card.ease,
      interval: card.interval,
      due: card.due,
      goodStreak: card.goodStreak,
    };
  }
  return map;
}

function mergeCardsWithProgress(baseCards: BaseCard[], progressMap: Record<string, CardProgress>) {
  return baseCards.map((card) => ({ ...card, ...(progressMap[card.id] ?? defaultProgress()) }));
}

function buildReviewQueue(allCards: ReviewCard[]) {
  const today = dayNumber();

  const unseen = allCards.filter((card) => card.reps <= 0);
  const dueCards = allCards
    .filter((card) => card.reps > 0 && card.due <= today)
    .sort((a, b) => a.due - b.due || a.reps - b.reps);

  return [...shuffleCards(unseen), ...shuffleCards(dueCards)];
}

function nextSchedule(card: ReviewCard, grade: Grade) {
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
    due: dayNumber() + nextInterval,
    goodStreak: nextGoodStreak,
  } satisfies CardProgress;
}

function historyKey(code: string) {
  return `${HISTORY_STORAGE_PREFIX}${code}`;
}

function progressKey(code: string) {
  return `${PROGRESS_STORAGE_PREFIX}${code}`;
}

function parseHistory(raw: string | null): ReviewEvent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is ReviewEvent => {
      if (!item || typeof item !== "object") return false;
      const event = item as Partial<ReviewEvent>;
      return (
        typeof event.ts === "number" &&
        typeof event.cardId === "string" &&
        (event.grade === "bad" || event.grade === "mid" || event.grade === "good")
      );
    });
  } catch {
    return [];
  }
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

  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [current, setCurrent] = useState<ReviewCard>();
  const [showA, setShowA] = useState(false);
  const [tab, setTab] = useState<"review" | "stats">("review");
  const [history, setHistory] = useState<ReviewEvent[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const historyKeyRef = useRef("");
  const progressKeyRef = useRef("");

  const persistHistory = useCallback((events: ReviewEvent[]) => {
    if (!historyKeyRef.current) return;
    localStorage.setItem(historyKeyRef.current, JSON.stringify(events));
  }, []);

  const persistProgress = useCallback((nextCards: ReviewCard[]) => {
    if (!progressKeyRef.current) return;
    localStorage.setItem(progressKeyRef.current, JSON.stringify(toProgressMap(nextCards)));
  }, []);

  const loadSharedCards = useCallback(async () => {
    const { data, error } = await supabase
      .from("cards")
      .select("id,question,answer")
      .eq("deck_id", GLOBAL_DECK_ID);

    if (error) {
      alert(error.message);
      return;
    }

    const progressMap = parseProgress(localStorage.getItem(progressKeyRef.current));
    const baseCards = (data ?? []) as BaseCard[];
    const merged = mergeCardsWithProgress(baseCards, progressMap);
    const reviewQueue = buildReviewQueue(merged);

    setCards(merged);
    setQueue(reviewQueue);
    setCurrent(reviewQueue[0]);
  }, []);

  const refreshAdminSession = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/session", { method: "GET" });
      if (!res.ok) {
        setIsAdmin(false);
        return false;
      }

      const data = (await res.json()) as { isAdmin?: boolean };
      const ok = Boolean(data.isAdmin);
      setIsAdmin(ok);
      return ok;
    } catch {
      setIsAdmin(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const isAuthed = localStorage.getItem(AUTH_STORAGE_KEY) === "1";
    const code = localStorage.getItem(SESSION_CODE_STORAGE_KEY) ?? "";

    if (!isAuthed || !code) {
      location.href = "/";
      return;
    }

    historyKeyRef.current = historyKey(code);
    progressKeyRef.current = progressKey(code);

    queueMicrotask(() => {
      setSessionCode(code);
      setHistory(parseHistory(localStorage.getItem(historyKeyRef.current)));
      void (async () => {
        await refreshAdminSession();
        await loadSharedCards();
      })();
    });
  }, [loadSharedCards, refreshAdminSession]);

  async function requestAdminAccess() {
    const code = window.prompt("Code admin:");
    if (!code) return;

    const res = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      alert("Code admin invalide");
      setIsAdmin(false);
      return;
    }

    setIsAdmin(true);
    alert("Mode admin active");
  }

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
            { question: q, answer: a, reps: 0, ease: 2, interval: 0, due: 0 },
            { question: a, answer: q, reps: 0, ease: 2, interval: 0, due: 0 },
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

        await loadSharedCards();
        setShowA(false);
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

    localStorage.removeItem(progressKeyRef.current);
    localStorage.removeItem(historyKeyRef.current);

    setHistory([]);
    setCards([]);
    setQueue([]);
    setCurrent(undefined);
    setShowA(false);
  }

  function grade(g: Grade) {
    if (!current) return;

    const schedule = nextSchedule(current, g);
    const updatedCard: ReviewCard = { ...current, ...schedule };

    const nextCards = cards.map((card) => (card.id === current.id ? updatedCard : card));
    const nextQueue = queue.filter((card) => card.id !== current.id);

    const nextHistory = [...history, { ts: Date.now(), grade: g, cardId: current.id }].slice(-5000);

    setCards(nextCards);
    setHistory(nextHistory);
    persistHistory(nextHistory);
    persistProgress(nextCards);

    if (nextQueue.length > 0) {
      setQueue(nextQueue);
      setCurrent(nextQueue[0]);
    } else {
      const rebuilt = buildReviewQueue(nextCards);
      setQueue(rebuilt);
      setCurrent(rebuilt[0]);
    }

    setShowA(false);
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

  return (
    <main className="max-w-5xl mx-auto p-4 md:p-6 space-y-4">
      <header className="rounded-2xl p-4 md:p-5 border border-white/10 bg-gradient-to-r from-slate-900/80 via-slate-800/70 to-slate-900/80 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Flashcards SRS</p>
            <h1 className="text-xl md:text-2xl font-bold">Revision + Stats</h1>
            <p className="text-xs text-slate-400 mt-1">
              Code: {sessionCode || "-"} | Mode: {isAdmin ? "Admin CSV global" : "Session perso"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin ? (
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
            ) : (
              <button
                onClick={requestAdminAccess}
                className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold"
              >
                Activer mode admin
              </button>
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
                      <p className="text-sm text-slate-400">Demande a l&apos;admin de charger le deck.</p>
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
            <p className="text-xs text-slate-400">Progression sauvegardee par ton code perso.</p>
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
