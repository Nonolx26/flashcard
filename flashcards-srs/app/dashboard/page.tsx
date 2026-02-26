"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/lib/supabaseClient";
import { ArrowPathIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";

type Grade = "bad" | "mid" | "good";

type Card = {
  id: string;
  question: string;
  answer: string;
  reps: number;
  ease: number;
  interval: number;
  due: number;
};

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
const DECK_STORAGE_KEY = "flashcards_deck_id";
const HISTORY_STORAGE_PREFIX = "flashcards_review_history_";
const DEFAULT_DECK_ID = "26080900-0000-4000-8000-000000000001";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function shuffleCards(list: Card[]) {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function historyKey(deckId: string) {
  return `${HISTORY_STORAGE_PREFIX}${deckId}`;
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
  const [cards, setCards] = useState<Card[]>([]);
  const [current, setCurrent] = useState<Card>();
  const [showA, setShowA] = useState(false);
  const [tab, setTab] = useState<"review" | "stats">("review");
  const [history, setHistory] = useState<ReviewEvent[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const deckIdRef = useRef(DEFAULT_DECK_ID);
  const historyKeyRef = useRef(historyKey(DEFAULT_DECK_ID));

  const load = useCallback(async (deckId: string) => {
    const { data } = await supabase.from("cards").select("*").order("due").eq("deck_id", deckId);
    const mixed = shuffleCards((data ?? []) as Card[]);
    setCards(mixed);
    setCurrent(mixed[0] as Card | undefined);
  }, []);

  const ensureDeckExists = useCallback(async (deckId: string) => {
    const { error } = await supabase.from("decks").insert({ id: deckId });

    if (!error) return true;
    if (error.code === "23505") return true;

    alert(`Erreur deck: ${error.message}`);
    return false;
  }, []);

  const persistHistory = useCallback((events: ReviewEvent[]) => {
    localStorage.setItem(historyKeyRef.current, JSON.stringify(events));
  }, []);

  useEffect(() => {
    const isAuthed = localStorage.getItem(AUTH_STORAGE_KEY) === "1";
    if (!isAuthed) {
      location.href = "/";
      return;
    }

    const storedDeckId = localStorage.getItem(DECK_STORAGE_KEY);
    const deckId = storedDeckId && isUuid(storedDeckId) ? storedDeckId : DEFAULT_DECK_ID;

    localStorage.setItem(DECK_STORAGE_KEY, deckId);
    deckIdRef.current = deckId;
    historyKeyRef.current = historyKey(deckId);

    queueMicrotask(() => {
      const existingHistory = parseHistory(localStorage.getItem(historyKeyRef.current));
      setHistory(existingHistory);

      void (async () => {
        const ok = await ensureDeckExists(deckId);
        if (ok) await load(deckId);
      })();
    });
  }, [ensureDeckExists, load]);

  async function parseCsv(file: File) {
    const deckId = deckIdRef.current;
    const ok = await ensureDeckExists(deckId);
    if (!ok) return;

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

        const { error } = await supabase
          .from("cards")
          .insert(payload.map((p) => ({ ...p, deck_id: deckId })));

        if (error) {
          alert(error.message);
          return;
        }

        await load(deckId);
        setShowA(false);
      },
      error: (error) => {
        alert(`Erreur CSV: ${error.message}`);
      },
    });
  }

  async function clearCurrentCsv() {
    const deckId = deckIdRef.current;
    const ok = window.confirm("Supprimer toutes les cartes du CSV en cours ? Cette action est irreversible.");
    if (!ok) return;

    const { error } = await supabase.from("cards").delete().eq("deck_id", deckId);
    if (error) {
      alert(error.message);
      return;
    }

    localStorage.removeItem(historyKeyRef.current);
    setHistory([]);
    await load(deckId);
    setShowA(false);
  }

  async function grade(g: Grade) {
    if (!current) return;
    const deckId = deckIdRef.current;

    const p = { bad: [0.5, 3], mid: [0.9, 6], good: [1.2, 12] }[g];
    const nextEase = Math.max(1.2, Math.min(2.6, current.ease * p[0]));
    const nextInt = Math.max(p[1], Math.round((current.interval || 1) * nextEase));
    const due = (current.due || 0) + nextInt;

    const { error } = await supabase
      .from("cards")
      .update({
        reps: current.reps + 1,
        ease: nextEase,
        interval: nextInt,
        due,
      })
      .eq("id", current.id);

    if (error) {
      alert(error.message);
      return;
    }

    const nextHistory = [...history, { ts: Date.now(), grade: g, cardId: current.id }].slice(-5000);
    setHistory(nextHistory);
    persistHistory(nextHistory);

    await load(deckId);
    setShowA(false);
  }

  function logout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
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

  const globalStats = useMemo(() => reviewStats(history), [history]);
  const last30Stats = useMemo(() => reviewStats(history.slice(-30)), [history]);
  const last100Stats = useMemo(() => reviewStats(history.slice(-100)), [history]);

  const totalReps = useMemo(() => cards.reduce((sum, card) => sum + (card.reps || 0), 0), [cards]);
  const avgEase = useMemo(() => {
    if (!cards.length) return 0;
    return cards.reduce((sum, card) => sum + (card.ease || 0), 0) / cards.length;
  }, [cards]);
  const avgInterval = useMemo(() => {
    if (!cards.length) return 0;
    return cards.reduce((sum, card) => sum + (card.interval || 0), 0) / cards.length;
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
          </div>
          <div className="flex items-center gap-2">
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
                  <p className="text-slate-300">Aucune carte pour le moment.</p>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="px-6 py-3 rounded-xl bg-sky-500 hover:bg-sky-600 font-semibold text-white shadow-lg"
                  >
                    Importer un CSV
                  </button>
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
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Deck</p>
            <div className="grid grid-cols-2 gap-2">
              <StatChip label="Cartes" value={String(cards.length)} />
              <StatChip label="Revisions" value={String(globalStats.count)} />
              <StatChip label="Reps total" value={String(totalReps)} />
              <StatChip label="Ease moy." value={avgEase.toFixed(2)} />
            </div>
            <p className="text-xs text-slate-400">Les cartes sont melangees a chaque chargement.</p>
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
