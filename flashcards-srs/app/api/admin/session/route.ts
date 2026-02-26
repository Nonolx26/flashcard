import { NextRequest, NextResponse } from "next/server";

const ADMIN_COOKIE = "flashcards_admin";
const ADMIN_CODE = process.env.ADMIN_CODE;

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export async function GET(request: NextRequest) {
  const isAdmin = request.cookies.get(ADMIN_COOKIE)?.value === "1";
  return NextResponse.json({ isAdmin });
}

export async function POST(request: NextRequest) {
  if (!ADMIN_CODE) {
    return NextResponse.json({ error: "ADMIN_CODE is not configured" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const code = String(body.code ?? "").trim();

  if (code !== ADMIN_CODE) {
    const res = NextResponse.json({ error: "Invalid admin code" }, { status: 401 });
    res.cookies.delete(ADMIN_COOKIE);
    return res;
  }

  const res = NextResponse.json({ ok: true, isAdmin: true });
  res.cookies.set(ADMIN_COOKIE, "1", cookieOptions);
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
