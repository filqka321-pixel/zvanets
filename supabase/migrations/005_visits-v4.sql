-- Звънец · статистика, версия 4 (пусни в Supabase → SQL Editor → Run; може да се пуска повторно)
-- Записването вече минава през функция log_visit, така че правилата за достъп не могат да го блокират.

create or replace function sofia_today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Sofia')::date $$;

create table if not exists visits (
  day        date    not null default sofia_today(),
  device     text    not null check (char_length(device) between 8 and 64),
  class_name text    not null default '' check (char_length(class_name) <= 8),
  installed  boolean not null default false
);
alter table visits drop constraint if exists visits_pkey;
alter table visits add primary key (day, device, class_name);
create index if not exists visits_day_idx on visits (day);

alter table visits enable row level security;
drop policy if exists "anyone insert today" on visits;
drop policy if exists "admin read" on visits;
create policy "admin read" on visits for select to authenticated using (is_admin());
revoke insert on visits from anon, authenticated;     -- пише се само през log_visit
grant select on visits to authenticated;

-- записва едно посещение (веднъж на ден за устройство и клас)
create or replace function log_visit(p_device text, p_class text default '', p_installed boolean default false)
returns void language sql volatile security definer set search_path = public as $$
  insert into visits (day, device, class_name, installed)
  select sofia_today(), p_device, coalesce(p_class, ''), coalesce(p_installed, false)
  where char_length(coalesce(p_device, '')) between 8 and 64 and char_length(coalesce(p_class, '')) <= 8
  on conflict do nothing;
$$;
revoke all on function log_visit(text, text, boolean) from public;
grant execute on function log_visit(text, text, boolean) to anon, authenticated;
-- обобщение за раздела „Статистика“ (само за админ)
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
               from (select (t - i) as d from generate_series(0, 13) i) g
               left join (select day, count(distinct device) as n from visits where day > t - 14 group by day) v on v.day = g.d),
    'classes', (select coalesce(json_agg(json_build_object('cls', c.class_name, 'n', c.n) order by c.n desc, c.class_name), '[]'::json)
               from (select class_name, count(distinct device) as n from visits v
                     where day > t - 7
                       and (class_name <> '' or not exists (select 1 from visits w where w.device = v.device and w.day > t - 7 and w.class_name <> ''))
                     group by class_name) c),
    'classes_today', (select coalesce(json_agg(json_build_object('cls', c.class_name, 'n', c.n) order by c.n desc, c.class_name), '[]'::json)
               from (select class_name, count(distinct device) as n from visits v
                     where day = t
                       and (class_name <> '' or not exists (select 1 from visits w where w.device = v.device and w.day = t and w.class_name <> ''))
                     group by class_name) c)
  ) into r;
  return r;
end $$;
grant execute on function visit_stats() to authenticated;
