import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Grade = "bad" | "mid" | "good";

type ReviewEvent = {
  ts: number;
  grade: Grade;
  cardId: string;
};

type CardProgress = {
  reps: number;
  ease: number;
  interval: number;
  due: number;
  goodStreak: number;
};

type SessionPayload = {
  code?: string;
  cardId?: string;
  grade?: string;
  ts?: number;
  reset?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isValidCode(code: string) {
  return /^\d{6}$/.test(code);
}

function isValidCardId(cardId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cardId);
}

function isGrade(value: string): value is Grade {
  return value === "bad" || value === "mid" || value === "good";
}

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) return null;

  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function dayNumber(ts: number) {
  return Math.floor(ts / DAY_MS);
}

function defaultProgress(): CardProgress {
  return { reps: 0, ease: 2, interval: 0, due: 0, goodStreak: 0 };
}

function nextSchedule(progress: CardProgress, grade: Grade, reviewedAt: number): CardProgress {
  const baseInterval = Math.max(1, progress.interval || 1);
  const nextGoodStreak = grade === "good" ? progress.goodStreak + 1 : 0;

  const easeFactor = { bad: 0.88, mid: 0.96, good: 1.08 }[grade];
  const nextEase = Math.max(1.2, Math.min(3.0, progress.ease * easeFactor));

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
    reps: progress.reps + 1,
    ease: nextEase,
    interval: nextInterval,
    due: dayNumber(reviewedAt) + nextInterval,
    goodStreak: nextGoodStreak,
  };
}

function buildProgressFromHistory(history: ReviewEvent[]) {
  const map: Record<string, CardProgress> = {};

  for (const event of history) {
    const prev = map[event.cardId] ?? defaultProgress();
    map[event.cardId] = nextSchedule(prev, event.grade, event.ts);
  }

  return map;
}

function parseTs(value: unknown) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function isPermissionDenied(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "").toLowerCase();
  return code === "42501" || message.includes("permission denied");
}

function permissionDeniedMessage() {
  return "Permission SQL manquante sur review_actions. Execute le script sql/2026-02-26-review-actions-permissions-hotfix.sql dans Supabase SQL Editor.";
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";

  if (!isValidCode(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("review_actions")
    .select("id,card_id,grade,occurred_at")
    .eq("session_code", code)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(5000);

  if (error) {
    if (error.code === "42P01") {
      return NextResponse.json(
        {
          error: "Table review_actions manquante. Execute le SQL de migration avant de relancer l'app.",
        },
        { status: 500 }
      );
    }
    if (isPermissionDenied(error)) {
      return NextResponse.json(
        {
          error: permissionDeniedMessage(),
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const history: ReviewEvent[] = [];
  for (const row of data ?? []) {
    const grade = String((row as { grade?: string }).grade ?? "");
    const cardId = String((row as { card_id?: string }).card_id ?? "");
    const occurredAt = String((row as { occurred_at?: string }).occurred_at ?? "");
    const ts = Date.parse(occurredAt);

    if (!isGrade(grade) || !isValidCardId(cardId) || !Number.isFinite(ts) || ts <= 0) {
      continue;
    }

    history.push({ ts: Math.floor(ts), grade, cardId });
  }

  const trimmedHistory = history.slice(-5000);
  const progress = buildProgressFromHistory(trimmedHistory);
  const updatedAt = trimmedHistory.length ? trimmedHistory[trimmedHistory.length - 1].ts : 0;

  return NextResponse.json({
    progress,
    history: trimmedHistory,
    updatedAt,
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as SessionPayload;
  const code = String(body.code ?? "").trim();

  if (!isValidCode(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  if (body.reset) {
    const del = await supabase.from("review_actions").delete().eq("session_code", code);
    if (del.error) {
      if (isPermissionDenied(del.error)) {
        return NextResponse.json({ error: permissionDeniedMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: del.error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, reset: true });
  }

  const cardId = String(body.cardId ?? "").trim();
  const grade = String(body.grade ?? "").trim();

  if (!isValidCardId(cardId)) {
    return NextResponse.json({ error: "Invalid cardId" }, { status: 400 });
  }

  if (!isGrade(grade)) {
    return NextResponse.json({ error: "Invalid grade" }, { status: 400 });
  }

  const cardLookup = await supabase.from("cards").select("id,question_number").eq("id", cardId).single();
  if (cardLookup.error || !cardLookup.data) {
    if (cardLookup.error && isPermissionDenied(cardLookup.error)) {
      return NextResponse.json({ error: "Permission SQL manquante sur cards. Verifie les GRANT service_role." }, { status: 500 });
    }
    return NextResponse.json({ error: "Card not found" }, { status: 400 });
  }

  const questionNumber = Number((cardLookup.data as { question_number?: number }).question_number ?? 0);
  if (!Number.isFinite(questionNumber) || questionNumber <= 0) {
    return NextResponse.json(
      {
        error: "cards.question_number est invalide. Execute le SQL de migration puis reimporte le CSV.",
      },
      { status: 500 }
    );
  }

  const ts = parseTs(body.ts);
  const occurredAt = new Date(ts || Date.now()).toISOString();

  const ins = await supabase.from("review_actions").insert({
    session_code: code,
    card_id: cardId,
    question_number: Math.floor(questionNumber),
    grade,
    occurred_at: occurredAt,
  });

  if (ins.error) {
    if (ins.error.code === "42P01") {
      return NextResponse.json(
        {
          error: "Table review_actions manquante. Execute le SQL de migration avant de relancer l'app.",
        },
        { status: 500 }
      );
    }
    if (isPermissionDenied(ins.error)) {
      return NextResponse.json(
        {
          error: permissionDeniedMessage(),
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
