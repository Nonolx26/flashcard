import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const GLOBAL_DECK_ID = "26080900-0000-4000-8000-000000000001";
const DUEL_CODE_LENGTH = 6;
const DUEL_REVEAL_SECONDS = 10;
const DUEL_ROUND_COUNT = 10;

type DuelStatus = "waiting" | "active" | "finished";
type DuelAction = "create" | "join" | "answer";

type StoredDuelCard = {
  id: string;
  question: string;
  answer: string;
  questionNumber: number;
};

type DuelSessionRow = {
  code: string;
  status: string;
  cards: unknown;
  current_round: number | null;
  reveal_seconds: number | null;
  round_started_at: string | null;
  player_one_id: string | null;
  player_two_id: string | null;
  finished_at: string | null;
};

type DuelAnswerRow = {
  round_index: number | null;
  player_slot: number | null;
  score: number | null;
};

type CreatePayload = {
  action?: DuelAction;
  playerId?: string;
};

type JoinPayload = {
  action?: DuelAction;
  code?: string;
  playerId?: string;
};

type AnswerPayload = {
  action?: DuelAction;
  code?: string;
  playerId?: string;
  score?: number;
};

type DuelPayload = CreatePayload | JoinPayload | AnswerPayload;

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) return null;

  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isValidCode(code: string) {
  return new RegExp(`^[0-9]{${DUEL_CODE_LENGTH}}$`).test(code);
}

function isValidPlayerId(playerId: string) {
  return /^[a-zA-Z0-9_-]{12,80}$/.test(playerId);
}

function isValidScore(score: number) {
  return score === 0 || score === 3 || score === 5;
}

function sanitizeStatus(value: string): DuelStatus {
  if (value === "active" || value === "finished") return value;
  return "waiting";
}

function toTimestamp(value: string | null) {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
}

function parseCards(value: unknown): StoredDuelCard[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<StoredDuelCard>;
      const questionNumber = Number(row.questionNumber ?? 0);
      if (
        typeof row.id !== "string" ||
        typeof row.question !== "string" ||
        typeof row.answer !== "string" ||
        !Number.isFinite(questionNumber) ||
        questionNumber <= 0
      ) {
        return null;
      }

      return {
        id: row.id,
        question: row.question,
        answer: row.answer,
        questionNumber: Math.floor(questionNumber),
      } satisfies StoredDuelCard;
    })
    .filter((card): card is StoredDuelCard => Boolean(card));
}

function sumScores(answers: DuelAnswerRow[], slot: 1 | 2) {
  return answers.reduce((total, row) => total + (row.player_slot === slot ? Number(row.score ?? 0) : 0), 0);
}

function buildSnapshot(session: DuelSessionRow, answers: DuelAnswerRow[], playerId: string) {
  const status = sanitizeStatus(session.status);
  const cards = parseCards(session.cards);
  const totalRounds = cards.length;
  const currentRound = Math.max(0, Math.min(Number(session.current_round ?? 0), totalRounds));
  const roundStartedAt = toTimestamp(session.round_started_at);
  const revealSeconds = Math.max(1, Math.floor(Number(session.reveal_seconds ?? DUEL_REVEAL_SECONDS)));
  const revealAt = roundStartedAt ? roundStartedAt + revealSeconds * 1000 : 0;
  const selfSlot = session.player_one_id === playerId ? 1 : session.player_two_id === playerId ? 2 : null;
  const currentAnswers = answers.filter((row) => row.round_index === currentRound);
  const currentCard = status === "active" && currentRound < totalRounds ? cards[currentRound] : null;

  return {
    code: session.code,
    status,
    serverNow: Date.now(),
    revealSeconds,
    roundIndex: currentRound,
    totalRounds,
    roundStartedAt,
    revealAt,
    finishedAt: toTimestamp(session.finished_at),
    joinedCount: Number(Boolean(session.player_one_id)) + Number(Boolean(session.player_two_id)),
    selfSlot,
    currentCard,
    currentScore:
      selfSlot === null ? null : currentAnswers.find((row) => row.player_slot === selfSlot)?.score ?? null,
    players: [
      {
        slot: 1,
        joined: Boolean(session.player_one_id),
        isSelf: selfSlot === 1,
        score: sumScores(answers, 1),
        answeredCurrentRound: currentAnswers.some((row) => row.player_slot === 1),
      },
      {
        slot: 2,
        joined: Boolean(session.player_two_id),
        isSelf: selfSlot === 2,
        score: sumScores(answers, 2),
        answeredCurrentRound: currentAnswers.some((row) => row.player_slot === 2),
      },
    ] as const,
  };
}

function pickCards(cards: StoredDuelCard[], count: number) {
  const next = [...cards];

  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }

  return next.slice(0, count);
}

async function getSession(supabase: SupabaseClient, code: string) {
  const { data, error } = await supabase
    .from("duel_sessions")
    .select("code,status,cards,current_round,reveal_seconds,round_started_at,player_one_id,player_two_id,finished_at")
    .eq("code", code)
    .maybeSingle();

  if (error) {
    return { data: null, error };
  }

  return {
    data: (data as DuelSessionRow | null) ?? null,
    error: null,
  };
}

async function getAnswers(supabase: SupabaseClient, code: string) {
  const { data, error } = await supabase
    .from("duel_round_answers")
    .select("round_index,player_slot,score")
    .eq("session_code", code)
    .order("round_index", { ascending: true })
    .order("player_slot", { ascending: true });

  if (error) {
    return { data: null, error };
  }

  return {
    data: ((data ?? []) as DuelAnswerRow[]).map((row) => ({
      round_index: Number(row.round_index ?? 0),
      player_slot: Number(row.player_slot ?? 0),
      score: Number(row.score ?? 0),
    })),
    error: null,
  };
}

function tableMissingMessage() {
  return "Tables duel manquantes. Execute sql/2026-04-23-duel-mode.sql dans Supabase SQL Editor.";
}

async function fetchSnapshot(supabase: SupabaseClient, code: string, playerId: string) {
  const [sessionResult, answersResult] = await Promise.all([getSession(supabase, code), getAnswers(supabase, code)]);

  if (sessionResult.error || answersResult.error) {
    const error = sessionResult.error ?? answersResult.error;
    if (error?.code === "42P01") {
      return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
    }
    return NextResponse.json({ error: error?.message ?? "Duel fetch failed" }, { status: 500 });
  }

  if (!sessionResult.data || !answersResult.data) {
    return NextResponse.json({ error: "Duel introuvable" }, { status: 404 });
  }

  return NextResponse.json(buildSnapshot(sessionResult.data, answersResult.data, playerId));
}

async function generateCode(supabase: SupabaseClient) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(DUEL_CODE_LENGTH, "0");
    const existing = await getSession(supabase, code);
    if (existing.error?.code === "42P01") {
      throw new Error(tableMissingMessage());
    }
    if (!existing.data) {
      return code;
    }
  }

  throw new Error("Impossible de generer un code duel unique.");
}

export async function GET(request: NextRequest) {
  const code = String(request.nextUrl.searchParams.get("code") ?? "").trim();
  const playerId = String(request.nextUrl.searchParams.get("playerId") ?? "").trim();

  if (!isValidCode(code)) {
    return NextResponse.json({ error: "Code duel invalide" }, { status: 400 });
  }

  if (!isValidPlayerId(playerId)) {
    return NextResponse.json({ error: "playerId invalide" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  return fetchSnapshot(supabase, code, playerId);
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as DuelPayload;
  const action = String(body.action ?? "").trim() as DuelAction;

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Server Supabase env missing" }, { status: 500 });
  }

  if (action === "create") {
    const { playerId: rawPlayerId } = body as CreatePayload;
    const playerId = String(rawPlayerId ?? "").trim();
    if (!isValidPlayerId(playerId)) {
      return NextResponse.json({ error: "playerId invalide" }, { status: 400 });
    }

    const cardsQuery = await supabase
      .from("cards")
      .select("id,question,answer,question_number")
      .eq("deck_id", GLOBAL_DECK_ID)
      .order("question_number", { ascending: true });

    if (cardsQuery.error) {
      if (cardsQuery.error.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: cardsQuery.error.message }, { status: 500 });
    }

    const allCards = ((cardsQuery.data ?? []) as Array<{
      id?: string;
      question?: string;
      answer?: string;
      question_number?: number;
    }>)
      .map((row) => ({
        id: String(row.id ?? ""),
        question: String(row.question ?? ""),
        answer: String(row.answer ?? ""),
        questionNumber: Number(row.question_number ?? 0),
      }))
      .filter((row) => row.id && row.question && row.answer && Number.isFinite(row.questionNumber) && row.questionNumber > 0);

    if (allCards.length < DUEL_ROUND_COUNT) {
      return NextResponse.json(
        {
          error: `Il faut au moins ${DUEL_ROUND_COUNT} cartes dans le CSV global pour lancer un duel.`,
        },
        { status: 400 }
      );
    }

    let code = "";
    try {
      code = await generateCode(supabase);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Impossible de generer le code duel.";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const pickedCards = pickCards(allCards, DUEL_ROUND_COUNT);
    const insert = await supabase
      .from("duel_sessions")
      .insert({
        code,
        status: "waiting",
        cards: pickedCards,
        current_round: 0,
        reveal_seconds: DUEL_REVEAL_SECONDS,
        player_one_id: playerId,
      })
      .select("code,status,cards,current_round,reveal_seconds,round_started_at,player_one_id,player_two_id,finished_at")
      .single();

    if (insert.error || !insert.data) {
      if (insert.error?.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: insert.error?.message ?? "Creation duel impossible" }, { status: 500 });
    }

    return NextResponse.json(buildSnapshot(insert.data as DuelSessionRow, [], playerId));
  }

  if (action === "join") {
    const { code: rawCode, playerId: rawPlayerId } = body as JoinPayload;
    const code = String(rawCode ?? "").trim();
    const playerId = String(rawPlayerId ?? "").trim();

    if (!isValidCode(code)) {
      return NextResponse.json({ error: "Code duel invalide" }, { status: 400 });
    }

    if (!isValidPlayerId(playerId)) {
      return NextResponse.json({ error: "playerId invalide" }, { status: 400 });
    }

    const existing = await getSession(supabase, code);
    if (existing.error) {
      if (existing.error.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: existing.error.message }, { status: 500 });
    }

    if (!existing.data) {
      return NextResponse.json({ error: "Code duel introuvable" }, { status: 404 });
    }

    const session = existing.data;
    if (session.player_one_id === playerId || session.player_two_id === playerId) {
      return fetchSnapshot(supabase, code, playerId);
    }

    if (session.player_one_id && session.player_two_id) {
      return NextResponse.json({ error: "Ce duel est deja complet." }, { status: 409 });
    }

    const nowIso = new Date().toISOString();
    const joinUpdate =
      !session.player_one_id
        ? await supabase
            .from("duel_sessions")
            .update({
              player_one_id: playerId,
              updated_at: nowIso,
            })
            .eq("code", code)
            .is("player_one_id", null)
        : await supabase
            .from("duel_sessions")
            .update({
              player_two_id: playerId,
              status: "active",
              round_started_at: nowIso,
              updated_at: nowIso,
            })
            .eq("code", code)
            .is("player_two_id", null);

    if (joinUpdate.error) {
      if (joinUpdate.error.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: joinUpdate.error.message }, { status: 500 });
    }

    return fetchSnapshot(supabase, code, playerId);
  }

  if (action === "answer") {
    const { code: rawCode, playerId: rawPlayerId, score: rawScore } = body as AnswerPayload;
    const code = String(rawCode ?? "").trim();
    const playerId = String(rawPlayerId ?? "").trim();
    const score = Number(rawScore ?? NaN);

    if (!isValidCode(code)) {
      return NextResponse.json({ error: "Code duel invalide" }, { status: 400 });
    }

    if (!isValidPlayerId(playerId)) {
      return NextResponse.json({ error: "playerId invalide" }, { status: 400 });
    }

    if (!isValidScore(score)) {
      return NextResponse.json({ error: "Score duel invalide" }, { status: 400 });
    }

    const sessionResult = await getSession(supabase, code);
    if (sessionResult.error) {
      if (sessionResult.error.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: sessionResult.error.message }, { status: 500 });
    }

    if (!sessionResult.data) {
      return NextResponse.json({ error: "Duel introuvable" }, { status: 404 });
    }

    const session = sessionResult.data;
    const status = sanitizeStatus(session.status);
    if (status !== "active") {
      return NextResponse.json({ error: "Le duel n'est pas actif." }, { status: 409 });
    }

    const selfSlot = session.player_one_id === playerId ? 1 : session.player_two_id === playerId ? 2 : null;
    if (selfSlot === null) {
      return NextResponse.json({ error: "Tu n'appartiens pas a ce duel." }, { status: 403 });
    }

    const cards = parseCards(session.cards);
    const currentRound = Math.max(0, Number(session.current_round ?? 0));
    if (currentRound >= cards.length) {
      return NextResponse.json({ error: "Le duel est deja termine." }, { status: 409 });
    }

    const roundStartedAt = toTimestamp(session.round_started_at);
    const revealAt = roundStartedAt + Math.max(1, Number(session.reveal_seconds ?? DUEL_REVEAL_SECONDS)) * 1000;
    if (!roundStartedAt || Date.now() < revealAt) {
      return NextResponse.json({ error: "Patiente jusqu'a l'affichage de la reponse." }, { status: 409 });
    }

    const currentCard = cards[currentRound];
    const insert = await supabase.from("duel_round_answers").insert({
      session_code: code,
      round_index: currentRound,
      player_slot: selfSlot,
      card_id: currentCard.id,
      score,
    });

    if (insert.error && insert.error.code !== "23505") {
      if (insert.error.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: insert.error.message }, { status: 500 });
    }

    const answersResult = await getAnswers(supabase, code);
    if (answersResult.error || !answersResult.data) {
      if (answersResult.error?.code === "42P01") {
        return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
      }
      return NextResponse.json({ error: answersResult.error?.message ?? "Lecture duel impossible" }, { status: 500 });
    }

    const expectedAnswers = Number(Boolean(session.player_one_id)) + Number(Boolean(session.player_two_id));
    const roundAnswers = answersResult.data.filter((row) => row.round_index === currentRound);

    if (roundAnswers.length >= expectedAnswers) {
      const nextRound = currentRound + 1;
      const nextStatus: DuelStatus = nextRound >= cards.length ? "finished" : "active";
      const nextUpdate =
        nextStatus === "finished"
          ? {
              status: "finished",
              current_round: nextRound,
              finished_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : {
              current_round: nextRound,
              round_started_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

      const update = await supabase.from("duel_sessions").update(nextUpdate).eq("code", code).eq("current_round", currentRound);
      if (update.error) {
        if (update.error.code === "42P01") {
          return NextResponse.json({ error: tableMissingMessage() }, { status: 500 });
        }
        return NextResponse.json({ error: update.error.message }, { status: 500 });
      }
    }

    return fetchSnapshot(supabase, code, playerId);
  }

  return NextResponse.json({ error: "Action duel inconnue" }, { status: 400 });
}
