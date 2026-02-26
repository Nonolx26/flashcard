"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { supabase } from "@/lib/supabaseClient";
import { ArrowPathIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";

type Card = {
  id: string;
  question: string;
  answer: string;
  reps: number;
  ease: number;
  interval: number;
  due: number;
};

const AUTH_STORAGE_KEY = "flashcards_pin_ok";
const DECK_STORAGE_KEY = "flashcards_deck_id";
const DEFAULT_DECK_ID = "26080900-0000-4000-8000-000000000001";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default function Dashboard() {
  const [cards, setCards] = useState<Card[]>([]);
  const [current, setCurrent] = useState<Card>();
  const [showA, setShowA] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const deckIdRef = useRef(DEFAULT_DECK_ID);

  const load = useCallback(async (id: string) => {
    const { data } = await supabase.from("cards").select("*").order("due").eq("deck_id", id);
    setCards((data ?? []) as Card[]);
    setCurrent(data?.[0] as Card | undefined);
  }, []);

  useEffect(() => {
    const isAuthed = localStorage.getItem(AUTH_STORAGE_KEY) === "1";
    if (!isAuthed) {
      location.href = "/";
      return;
    }

    const storedDeckId = localStorage.getItem(DECK_STORAGE_KEY);
    const localDeckId = storedDeckId && isUuid(storedDeckId) ? storedDeckId : DEFAULT_DECK_ID;
    localStorage.setItem(DECK_STORAGE_KEY, localDeckId);
    deckIdRef.current = localDeckId;

    queueMicrotask(() => {
      void load(localDeckId);
    });
  }, [load]);

  async function parseCsv(file: File) {
    const deckId = deckIdRef.current;

    Papa.parse(file, {
      complete: async (res) => {
        const rows = res.data as string[][];
        const payload = rows
          .filter((r) => r[0] && r[1])
          .flatMap((r) => [
            { question: r[0], answer: r[1] },
            { question: r[1], answer: r[0] },
          ]);

        const { error } = await supabase
          .from("cards")
          .insert(payload.map((p) => ({ ...p, deck_id: deckId })));

        if (error) alert(error.message);
        await load(deckId);
      },
    });
  }

  async function grade(g: "bad" | "mid" | "good") {
    if (!current) return;
    const deckId = deckIdRef.current;

    const p = { bad: [0.5, 3], mid: [0.9, 6], good: [1.2, 12] }[g];
    const nextEase = Math.max(1.2, Math.min(2.6, current.ease * p[0]));
    const nextInt = Math.max(p[1], Math.round((current.interval || 1) * nextEase));
    const due = (current.due || 0) + nextInt;

    await supabase
      .from("cards")
      .update({
        reps: current.reps + 1,
        ease: nextEase,
        interval: nextInt,
        due,
      })
      .eq("id", current.id);

    await load(deckId);
    setShowA(false);
  }

  function logout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    location.href = "/";
  }

  function btn(type: "bad" | "mid" | "good") {
    return clsx(
      "flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-xl shadow-md",
      type === "bad" && "bg-rose-500/20 text-rose-300 hover:bg-rose-600/30",
      type === "mid" && "bg-amber-500/20 text-amber-300 hover:bg-amber-600/30",
      type === "good" && "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-600/30"
    );
  }

  if (!current) {
    return (
      <main className="min-h-screen grid place-items-center px-4 gap-4">
        <button
          onClick={() => fileRef.current?.click()}
          className="px-6 py-3 rounded-xl bg-sky-500 hover:bg-sky-600 font-semibold text-white shadow-lg"
        >
          Importer un CSV
        </button>
        <button onClick={logout} className="text-sm text-slate-300 hover:text-white">
          Se deconnecter
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          hidden
          onChange={(e) => e.target.files && parseCsv(e.target.files[0])}
        />
      </main>
    );
  }

  return (
    <main className="max-w-md mx-auto p-4">
      <div className="flex justify-between mb-4">
        <button onClick={() => fileRef.current?.click()} className="text-sky-400 text-sm">
          + CSV
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-400">{cards.length} cartes</span>
          <button onClick={logout} className="text-xs text-slate-300 hover:text-white">
            Quitter
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={current.id + (showA ? "-a" : "-q")}
          initial={{ opacity: 0, y: 20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.96 }}
          transition={{ duration: 0.18 }}
          className="rounded-3xl p-6 bg-white/5 backdrop-blur border border-white/10 shadow-xl select-none"
        >
          <p className="text-slate-300 text-xs mb-2">{showA ? "Reponse" : "Question"}</p>
          <p className="text-xl font-bold whitespace-pre-wrap">{showA ? current.answer : current.question}</p>
        </motion.div>
      </AnimatePresence>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {showA ? (
          <>
            <button onClick={() => grade("bad")} className={btn("bad")}>
              <XMarkIcon className="w-5" /> Pas du tout
            </button>
            <button onClick={() => grade("mid")} className={btn("mid")}>
              <ArrowPathIcon className="w-5" /> Moyen
            </button>
            <button onClick={() => grade("good")} className={btn("good")}>
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

      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        hidden
        onChange={(e) => e.target.files && parseCsv(e.target.files[0])}
      />
    </main>
  );
}
