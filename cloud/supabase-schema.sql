-- MeetingBot account settings schema
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "meetingbot settings read own" on public.user_settings;
create policy "meetingbot settings read own"
  on public.user_settings for select
  using (auth.uid() = user_id);

drop policy if exists "meetingbot settings insert own" on public.user_settings;
create policy "meetingbot settings insert own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "meetingbot settings update own" on public.user_settings;
create policy "meetingbot settings update own"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "meetingbot settings delete own" on public.user_settings;
create policy "meetingbot settings delete own"
  on public.user_settings for delete
  using (auth.uid() = user_id);
