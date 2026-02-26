import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const ADMIN_COOKIE = "flashcards_admin";
const GLOBAL_DECK_ID = "26080900-0000-4000-8000-000000000001";

function isAdmin(request: NextRequest) {
  return request.cookies.get(ADMIN_COOKIE)?.value === "1";
}

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) return null;

  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    payload?: Array<{ question?: string; answer?: string }>;
  };

  const payload = Array.isArray(body.payload) ? body.payload : [];
  const cleanRows = payload
    .map((item) => ({
      question: String(item.question ?? "").trim(),
      answer: String(item.answer ?? "").trim(),
    }))
    .filter((item) => item.question && item.answer);

  const clean = cleanRows.map((item, index) => ({
    ...item,
    deck_id: GLOBAL_DECK_ID,
    question_number: index + 1,
    reps: 0,
    ease: 2,
    interval: 0,
    due: 0,
  }));

  if (!clean.length) {
    return NextResponse.json({ error: "Empty payload" }, { status: 400 });
  }

  const deckInsert = await supabase.from("decks").insert({ id: GLOBAL_DECK_ID });
  if (deckInsert.error && deckInsert.error.code !== "23505") {
    return NextResponse.json({ error: deckInsert.error.message }, { status: 500 });
  }

  const wipe = await supabase.from("cards").delete().eq("deck_id", GLOBAL_DECK_ID);
  if (wipe.error) {
    return NextResponse.json({ error: wipe.error.message }, { status: 500 });
  }

  const ins = await supabase.from("cards").insert(clean);
  if (ins.error) {
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: clean.length });
}
