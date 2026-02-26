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

export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  const del = await supabase.from("cards").delete().eq("deck_id", GLOBAL_DECK_ID);
  if (del.error) {
    return NextResponse.json({ error: del.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
