-- ============================================================
-- GERADOR DE PROMPTS — Schema do Supabase
-- Rode este arquivo inteiro no SQL Editor do Supabase
-- (Dashboard do projeto > SQL Editor > New query > colar > Run)
--
-- Variáveis de ambiente que o app precisa na Vercel:
--   SUPABASE_URL           (URL do projeto — Settings > API)
--   SUPABASE_ANON_KEY      (chave anon/public — Settings > API)
--   SUPABASE_SERVICE_ROLE_KEY (chave service_role — Settings > API, SÓ no servidor)
--   GEMINI_API_KEY         (chave do Google AI Studio — SÓ no servidor)
--   MP_ACCESS_TOKEN        (access token do Mercado Pago — SÓ no servidor)
-- NENHUMA chave vai para o código. Todas são lidas de process.env.
-- ============================================================

-- ---------- Tabelas ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null check (plan in ('trial', 'monthly')),
  status text not null default 'active' check (status in ('active', 'expired', 'canceled')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  prompt_count int not null default 0,
  primary key (user_id, day)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null default 'foto'
    check (mode in ('foto', 'video', 'edicao_foto', 'edicao_video')),
  title text not null default 'Nova conversa',
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.processed_payments (
  payment_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null check (plan in ('trial', 'monthly')),
  amount_cents int not null,
  created_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------

alter table public.profiles enable row level security;
alter table public.user_access enable row level security;
alter table public.usage enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.processed_payments enable row level security;

-- profiles: cada usuário vê e cria só o próprio perfil
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- user_access: leitura do próprio acesso (escrita só via service_role no backend)
drop policy if exists "user_access_select_own" on public.user_access;
create policy "user_access_select_own" on public.user_access
  for select using (auth.uid() = user_id);

-- usage: leitura do próprio uso (escrita só via service_role no backend)
drop policy if exists "usage_select_own" on public.usage;
create policy "usage_select_own" on public.usage
  for select using (auth.uid() = user_id);

-- conversations: CRUD só das próprias conversas
drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own" on public.conversations
  for select using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own" on public.conversations
  for insert with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own" on public.conversations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own" on public.conversations
  for delete using (auth.uid() = user_id);

-- messages: acesso só via conversas próprias
drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages
  for select using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages
  for insert with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- processed_payments: SEM policies de cliente — só o service_role (backend) acessa.
-- Com RLS ativo e nenhuma policy, o acesso via anon key é negado por padrão.

-- ---------- Trigger: criar perfil ao cadastrar ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Índices ----------

create index if not exists idx_messages_conversation_created
  on public.messages (conversation_id, created_at asc);
create index if not exists idx_conversations_user_created
  on public.conversations (user_id, created_at desc);
create index if not exists idx_processed_payments_user
  on public.processed_payments (user_id, created_at desc);
