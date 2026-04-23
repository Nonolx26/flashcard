begin;

create table if not exists public.duel_sessions (
  code text primary key check (code ~ '^[0-9]{6}$'),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  cards jsonb not null,
  current_round integer not null default 0 check (current_round >= 0),
  reveal_seconds integer not null default 10 check (reveal_seconds between 3 and 30),
  round_started_at timestamptz null,
  player_one_id text null,
  player_two_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz null
);

create index if not exists duel_sessions_status_created_idx
  on public.duel_sessions(status, created_at desc);

create table if not exists public.duel_round_answers (
  id bigint generated always as identity primary key,
  session_code text not null references public.duel_sessions(code) on delete cascade,
  round_index integer not null check (round_index >= 0),
  player_slot integer not null check (player_slot in (1, 2)),
  card_id uuid not null references public.cards(id) on delete cascade,
  score integer not null check (score in (0, 3, 5)),
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (session_code, round_index, player_slot)
);

create index if not exists duel_round_answers_session_round_idx
  on public.duel_round_answers(session_code, round_index, answered_at);

alter table public.duel_sessions enable row level security;
alter table public.duel_round_answers enable row level security;

revoke all on public.duel_sessions from anon, authenticated;
revoke all on public.duel_round_answers from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.duel_sessions to service_role;
grant select, insert, update, delete on table public.duel_round_answers to service_role;
grant usage, select on sequence public.duel_round_answers_id_seq to service_role;
grant select on table public.cards to service_role;

drop policy if exists duel_sessions_service_role_all on public.duel_sessions;
create policy duel_sessions_service_role_all
  on public.duel_sessions
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists duel_round_answers_service_role_all on public.duel_round_answers;
create policy duel_round_answers_service_role_all
  on public.duel_round_answers
  for all
  to service_role
  using (true)
  with check (true);

commit;
