-- Full setup for SQL event-based sync (run once)
-- Supabase SQL Editor

begin;

alter table public.cards
  add column if not exists question_number integer;

with ranked as (
  select
    id,
    row_number() over (partition by deck_id order by id) as rn
  from public.cards
)
update public.cards c
set question_number = ranked.rn
from ranked
where c.id = ranked.id
  and c.question_number is null;

alter table public.cards
  alter column question_number set not null;

create index if not exists cards_deck_question_number_idx
  on public.cards(deck_id, question_number);

do $$
begin
  create type public.review_grade as enum ('bad', 'mid', 'good');
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.review_actions (
  id bigint generated always as identity primary key,
  session_code text not null check (session_code ~ '^[0-9]{6}$'),
  card_id uuid not null references public.cards(id) on delete cascade,
  question_number integer not null check (question_number > 0),
  grade public.review_grade not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists review_actions_code_time_idx
  on public.review_actions(session_code, occurred_at, id);

create index if not exists review_actions_code_card_time_idx
  on public.review_actions(session_code, card_id, occurred_at desc, id desc);

alter table public.review_actions enable row level security;

revoke all on public.review_actions from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.review_actions to service_role;
grant usage, select on sequence public.review_actions_id_seq to service_role;
grant select on table public.cards to service_role;

drop policy if exists review_actions_service_role_all on public.review_actions;
create policy review_actions_service_role_all
  on public.review_actions
  for all
  to service_role
  using (true)
  with check (true);

commit;
