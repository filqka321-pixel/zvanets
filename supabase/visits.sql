-- Звънец · анонимна статистика за посещенията
-- Пусни веднъж в Supabase → SQL Editor → Run (след permissions.sql). Може да се пуска повторно.
-- Пази се само: ден, случаен номер на устройството, избран клас и дали е инсталирано. Без имена и имейли.

create or replace function sofia_today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Sofia')::date $$;

create table if not exists visits (
  day        date    not null default sofia_today(),
  device     text    not null check (char_length(device) between 8 and 64),
  class_name text    not null default '' check (char_length(class_name) <= 8),
  installed  boolean not null default false,
  primary key (day, device)                       -- едно устройство = един ред на ден
);
create index if not exists visits_day_idx on visits (day);

alter table visits enable row level security;
drop policy if exists "anyone insert today" on visits;
drop policy if exists "admin read" on visits;
-- всеки може да добави посещение само за днес; никой освен админа не може да чете
create policy "anyone insert today" on visits for insert to anon, authenticated with check (day = sofia_today());
create policy "admin read" on visits for select to authenticated using (is_admin());
grant insert on visits to anon, authenticated;
grant select on visits to authenticated;

-- обобщение за раздела „Статистика“ (само за админ)
create or replace function visit_stats() returns json
language plpgsql stable security definer set search_path = public as $$
declare t date := sofia_today(); r json;
begin
  if not is_admin() then return null; end if;
  select json_build_object(
    'today',  (select count(*) from visits where day = t),
    'week',   (select count(distinct device) from visits where day > t - 7),
    'month',  (select count(distinct device) from visits where day > t - 30),
    'total',  (select count(distinct device) from visits),
    'installed_week', (select count(distinct device) from visits where installed and day > t - 7),
    'daily',  (select coalesce(json_agg(json_build_object('day', g.d, 'n', coalesce(v.n, 0)) order by g.d), '[]'::json)
               from (select (t - i) as d from generate_series(0, 13) i) g
               left join (select day, count(*) as n from visits where day > t - 14 group by day) v on v.day = g.d),
    'classes', (select coalesce(json_agg(json_build_object('cls', c.class_name, 'n', c.n) order by c.n desc, c.class_name), '[]'::json)
               from (select class_name, count(distinct device) as n from visits where day > t - 7 group by class_name) c)
  ) into r;
  return r;
end $$;
grant execute on function visit_stats() to authenticated;
