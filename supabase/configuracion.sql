-- Configuración de la base de datos de AutoDJ en Supabase.
-- Se pega completo en Supabase → SQL Editor → New query → Run. Se puede volver a correr sin problema.

-- ---------- Listas guardadas (y la cola de cada usuario) ----------
-- Cada fila es una lista de una cuenta. La cola actual se guarda como la lista «__cola__».
create table if not exists public.playlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  tracks     jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Cada quien solo ve y cambia sus propias listas
alter table public.playlists enable row level security;
drop policy if exists "listas propias" on public.playlists;
create policy "listas propias" on public.playlists
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.playlists to authenticated;

-- ---------- «Olvidé mi contraseña»: saber si el correo tiene cuenta ----------
-- Solo responde sí o no; no muestra ningún otro dato de la cuenta.
create or replace function public.email_exists(p_email text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users where lower(email) = lower(trim(p_email)));
$$;

revoke all on function public.email_exists(text) from public;
grant execute on function public.email_exists(text) to anon, authenticated;
