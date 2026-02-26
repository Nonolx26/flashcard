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
  updatedAt?: number;
  reset?: boolean;
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

function normalizeUpdatedAt(value: unknown) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function sanitizeStoredPayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return { progress: {}, history: [], updatedAt: 0 };
  }

  const row = value as { progress?: unknown; history?: unknown; updatedAt?: unknown };
  return {
    progress: sanitizeProgress(row.progress),
    history: sanitizeHistory(row.history),
    updatedAt: normalizeUpdatedAt(row.updatedAt),
  };
}

function latestEventByCard(events: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>) {
  const map = new Map<string, number>();
  for (const event of events) {
    const prev = map.get(event.cardId) ?? 0;
    if (event.ts > prev) {
      map.set(event.cardId, event.ts);
    }
  }
  return map;
}

function mergeHistory(
  remote: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>,
  incoming: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>
) {
  const map = new Map<string, { ts: number; grade: "bad" | "mid" | "good"; cardId: string }>();

  for (const event of [...remote, ...incoming]) {
    map.set(`${event.ts}|${event.cardId}|${event.grade}`, event);
  }

  return Array.from(map.values())
    .sort((a, b) => a.ts - b.ts)
    .slice(-5000);
}

function progressRank(row: { reps: number; ease: number; interval: number; due: number; goodStreak: number } | undefined) {
  if (!row) return -1;
  return row.reps * 100000 + row.goodStreak * 1000 + row.interval;
}

function mergeProgress(
  remote: Record<string, { reps: number; ease: number; interval: number; due: number; goodStreak: number }>,
  incoming: Record<string, { reps: number; ease: number; interval: number; due: number; goodStreak: number }>,
  remoteHistory: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>,
  incomingHistory: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>,
  remoteUpdatedAt: number,
  incomingUpdatedAt: number
) {
  const remoteLatest = latestEventByCard(remoteHistory);
  const incomingLatest = latestEventByCard(incomingHistory);
  const out: Record<string, { reps: number; ease: number; interval: number; due: number; goodStreak: number }> = {};
  const ids = new Set<string>([...Object.keys(remote), ...Object.keys(incoming)]);

  for (const id of ids) {
    const remoteRow = remote[id];
    const incomingRow = incoming[id];
    const remoteTs = remoteLatest.get(id) ?? 0;
    const incomingTs = incomingLatest.get(id) ?? 0;

    if (incomingTs > remoteTs) {
      if (incomingRow) out[id] = incomingRow;
      continue;
    }

    if (remoteTs > incomingTs) {
      if (remoteRow) out[id] = remoteRow;
      continue;
    }

    if (remoteRow && !incomingRow) {
      out[id] = remoteRow;
      continue;
    }

    if (incomingRow && !remoteRow) {
      out[id] = incomingRow;
      continue;
    }

    if (!remoteRow || !incomingRow) continue;

    const remoteScore = progressRank(remoteRow);
    const incomingScore = progressRank(incomingRow);

    if (incomingScore > remoteScore) {
      out[id] = incomingRow;
      continue;
    }

    if (remoteScore > incomingScore) {
      out[id] = remoteRow;
      continue;
    }

    out[id] = incomingUpdatedAt >= remoteUpdatedAt ? incomingRow : remoteRow;
  }

  return out;
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
      return NextResponse.json({ progress: {}, history: [], updatedAt: 0 });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const raw = await data.text();
  if (!raw) {
    return NextResponse.json({ progress: {}, history: [], updatedAt: 0 });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const clean = sanitizeStoredPayload(parsed);

    return NextResponse.json({
      progress: clean.progress,
      history: clean.history,
      updatedAt: clean.updatedAt,
    });
  } catch {
    return NextResponse.json({ progress: {}, history: [], updatedAt: 0 });
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

  const incomingPayload = {
    progress: sanitizeProgress(body.progress),
    history: sanitizeHistory(body.history),
    updatedAt: normalizeUpdatedAt(body.updatedAt) || Date.now(),
  };

  let payload = incomingPayload;

  if (!body.reset) {
    let remotePayload = { progress: {}, history: [], updatedAt: 0 } as {
      progress: Record<string, { reps: number; ease: number; interval: number; due: number; goodStreak: number }>;
      history: Array<{ ts: number; grade: "bad" | "mid" | "good"; cardId: string }>;
      updatedAt: number;
    };

    const existing = await supabase.storage.from(BUCKET).download(pathForCode(code));
    if (existing.error) {
      if (
        !isMissingStorageError({
          message: existing.error.message,
          statusCode: (existing.error as { statusCode?: string | number }).statusCode,
        })
      ) {
        return NextResponse.json({ error: existing.error.message }, { status: 500 });
      }
    } else {
      const raw = await existing.data.text();
      if (raw) {
        try {
          remotePayload = sanitizeStoredPayload(JSON.parse(raw));
        } catch {
          remotePayload = { progress: {}, history: [], updatedAt: 0 };
        }
      }
    }

    const mergedHistory = mergeHistory(remotePayload.history, incomingPayload.history);
    const mergedProgress = mergeProgress(
      remotePayload.progress,
      incomingPayload.progress,
      remotePayload.history,
      incomingPayload.history,
      remotePayload.updatedAt,
      incomingPayload.updatedAt
    );

    const latestEventTs = mergedHistory.length ? mergedHistory[mergedHistory.length - 1].ts : 0;
    payload = {
      progress: mergedProgress,
      history: mergedHistory,
      updatedAt: Math.max(remotePayload.updatedAt, incomingPayload.updatedAt, latestEventTs),
    };
  }

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
