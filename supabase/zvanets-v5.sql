-- Звънец · версия 5: заявки за отговорници, сигнали за грешки, статистика по дни
-- Пусни в Supabase → SQL Editor → Run (след permissions.sql и visits-v3/v4.sql). Може да се пуска повторно.

-- 1. Заявки за отговорник на клас -------------------------------------------------
create table if not exists editor_requests (
  email      text not null,
  class_name text not null check (char_length(class_name) <= 8),
  name       text not null default '' check (char_length(name) <= 60),
  created_at timestamptz not null default now(),
  primary key (email, class_name)
);
alter table editor_requests enable row level security;
drop policy if exists "own insert" on editor_requests;
drop policy if exists "own update" on editor_requests;
drop policy if exists "own or admin read" on editor_requests;
drop policy if exists "own or admin delete" on editor_requests;
-- заявка само за себе си и само за съществуващ клас (никога за „*“ = админ)
create policy "own insert" on editor_requests for insert to authenticated
  with check (email = my_email() and exists (select 1 from classes c where c.name = class_name));
create policy "own update" on editor_requests for update to authenticated
  using (email = my_email()) with check (email = my_email() and exists (select 1 from classes c where c.name = class_name));
create policy "own or admin read" on editor_requests for select to authenticated using (email = my_email() or is_admin());
create policy "own or admin delete" on editor_requests for delete to authenticated using (email = my_email() or is_admin());
grant select, insert, update, delete on editor_requests to authenticated;
revoke all on editor_requests from anon;

-- 2. Сигнали за грешки ----------------------------------------------------------------
create table if not exists reports (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  class_name text not null default '' check (char_length(class_name) <= 8),
  message    text not null check (char_length(message) between 3 and 500),
  device     text not null default '' check (char_length(device) <= 64)
);
alter table reports enable row level security;
drop policy if exists "editors read" on reports;
drop policy if exists "editors delete" on reports;
-- админът вижда всички сигнали, отговорникът само тези за своя клас
create policy "editors read" on reports for select to authenticated using (is_admin() or can_edit_class(class_name));
create policy "editors delete" on reports for delete to authenticated using (is_admin() or can_edit_class(class_name));
grant select, delete on reports to authenticated;
revoke all on reports from anon;

-- изпраща сигнал; най-много 5 на ден от едно устройство и 300 на ден общо
create or replace function send_report(p_class text, p_message text, p_device text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare m text := btrim(coalesce(p_message, '')); d text := left(coalesce(p_device, ''), 64);
begin
  if char_length(m) < 3 then return false; end if;
  if (select count(*) from reports where device = d and created_at > now() - interval '1 day') >= 5 then return false; end if;
  if (select count(*) from reports where created_at > now() - interval '1 day') >= 300 then return false; end if;
  insert into reports (class_name, message, device) values (left(coalesce(p_class, ''), 8), left(m, 500), d);
  return true;
end $$;
revoke all on function send_report(text, text, text) from public;
grant execute on function send_report(text, text, text) to anon, authenticated;

-- 3. Статистика: 30 дни назад и разбивка по класове за всеки ден ---------------------
create or replace function visit_stats() returns json
language plpgsql stable security definer set search_path = public as $$
declare t date := sofia_today(); r json;
begin
  if not is_admin() then return null; end if;
  select json_build_object(
    'today',  (select count(distinct device) from visits where day = t),
    'week',   (select count(distinct device) from visits where day > t - 7),
    'month',  (select count(distinct device) from visits where day > t - 30),
    'total',  (select count(distinct device) from visits),
    'installed_week', (select count(distinct device) from visits where installed and day > t - 7),
    'daily',  (select coalesce(json_agg(json_build_object('day', g.d, 'n', coalesce(v.n, 0)) order by g.d), '[]'::json)
               from (select (t - i) as d from generate_series(0, 29) i) g
               left join (select day, count(distinct device) as n from visits where day > t - 30 group by day) v on v.day = g.d),
    'classes', (select coalesce(json_agg(json_build_object('cls', c.class_name, 'n', c.n) order by c.n desc, c.class_name), '[]'::json)
               from (select class_name, count(distinct device) as n from visits where day > t - 7 and class_name <> '' group by class_name) c),
    'classes_today', (select coalesce(json_agg(json_build_object('cls', c.class_name, 'n', c.n) order by c.n desc, c.class_name), '[]'::json)
               from (select class_name, count(distinct device) as n from visits where day = t and class_name <> '' group by class_name) c),
    'by_day', (select coalesce(json_agg(json_build_object('day', c.day, 'cls', c.class_name, 'n', c.n) order by c.day, c.n desc, c.class_name), '[]'::json)
               from (select day, class_name, count(distinct device) as n from visits where day > t - 30 and class_name <> '' group by day, class_name) c)
  ) into r;
  return r;
end $$;
grant execute on function visit_stats() to authenticated;
