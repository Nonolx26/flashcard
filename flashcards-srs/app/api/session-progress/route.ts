import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "flashcards-session-sync";

type ProgressRow = {
  reps?: number;
  ease?: number;
  interval?: number;
  due?: number;
  goodStreak?: number;
};

type SessionPayload = {
  code?: string;
  progress?: Record<string, ProgressRow>;
  history?: Array<{ ts?: number; grade?: string; cardId?: string }>;
};

function isValidCode(code: string) {
  return /^\d{6}$/.test(code);
}

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) return null;

  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isMissingStorageError(error: { message?: string; statusCode?: string | number } | null) {
  if (!error) return false;
  const msg = String(error.message ?? "").toLowerCase();
  const status = String(error.statusCode ?? "");
  return status === "404" || msg.includes("not found") || msg.includes("does not exist");
}

async function ensureBucket(supabase: NonNullable<ReturnType<typeof getServerSupabase>>) {
  const created = await supabase.storage.createBucket(BUCKET, { public: false });
  if (!created.error) return { ok: true };

  const msg = String(created.error.message ?? "").toLowerCase();
  if (msg.includes("already") || msg.includes("exists") || msg.includes("duplicate")) {
    return { ok: true };
  }

  return { ok: false, error: created.error.message };
}

function sanitizeProgress(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const next: Record<string, { reps: number; ease: number; interval: number; due: number; goodStreak: number }> = {};

  for (const [cardId, rowValue] of Object.entries(value)) {
    if (!rowValue || typeof rowValue !== "object") continue;
    const row = rowValue as ProgressRow;

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

function sanitizeHistory(value: unknown) {
  if (!Array.isArray(value)) return [];

  const filtered = value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const event = item as { ts?: number; grade?: string; cardId?: string };
    return (
      typeof event.ts === "number" &&
      typeof event.cardId === "string" &&
      (event.grade === "bad" || event.grade === "mid" || event.grade === "good")
    );
  }) as Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>;

  return filtered.slice(-5000);
}

function pathForCode(code: string) {
  return `${code}.json`;
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

  const { data, error } = await supabase.storage.from(BUCKET).download(pathForCode(code));

  if (error) {
    if (isMissingStorageError({ message: error.message, statusCode: (error as { statusCode?: string | number }).statusCode })) {
      return NextResponse.json({ progress: {}, history: [] });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const raw = await data.text();
  if (!raw) {
    return NextResponse.json({ progress: {}, history: [] });
  }

  try {
    const parsed = JSON.parse(raw) as { progress?: unknown; history?: unknown };
    return NextResponse.json({
      progress: sanitizeProgress(parsed.progress),
      history: sanitizeHistory(parsed.history),
    });
  } catch {
    return NextResponse.json({ progress: {}, history: [] });
  }
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

  const ensured = await ensureBucket(supabase);
  if (!ensured.ok) {
    return NextResponse.json({ error: ensured.error ?? "Bucket error" }, { status: 500 });
  }

  const payload = {
    progress: sanitizeProgress(body.progress),
    history: sanitizeHistory(body.history),
    updatedAt: Date.now(),
  };

  const up = await supabase.storage
    .from(BUCKET)
    .upload(pathForCode(code), JSON.stringify(payload), {
      contentType: "application/json",
      upsert: true,
    });

  if (up.error) {
    return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
