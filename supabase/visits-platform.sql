-- Звънец · какви устройства влизат (iPhone, Android, компютър). Пусни след hardening.sql. Може да се пуска повторно.

-- 1. Посещението помни вида на устройството
alter table visits add column if not exists platform text not null default '';
alter table visits drop constraint if exists visits_platform_check;
alter table visits add constraint visits_platform_check check (platform in ('', 'iphone', 'android', 'other'));

-- старата функция без вид на устройството се заменя с нова (старите версии на приложението пак работят)
drop function if exists log_visit(text, text, boolean);
create or replace function log_visit(p_device text, p_class text default '', p_installed boolean default false, p_platform text default '')
returns void language plpgsql volatile security definer set search_path = public as $$
declare pf text := case when p_platform in ('iphone', 'android', 'other') then p_platform else '' end;
begin
  if coalesce(p_device, '') !~ '^[0-9a-z-]{20,40}$' then return; end if;
  if p_class is null or (p_class <> 'учител' and not exists (select 1 from classes where name = p_class)) then return; end if;
  if (select count(*) from visits where day = sofia_today()) >= 5000 then return; end if;
  insert into visits (day, device, class_name, installed, platform) values (sofia_today(), p_device, p_class, coalesce(p_installed, false), pf)
  on conflict (day, device, class_name) do update set platform = excluded.platform where visits.platform = '' and excluded.platform <> '';
end $$;
revoke all on function log_visit(text, text, boolean, text) from public;
grant execute on function log_visit(text, text, boolean, text) to anon, authenticated;

-- 2. Статистиката връща и видовете устройства за всеки ден
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
               from (select day, class_name, count(distinct device) as n from visits where day > t - 30 and class_name <> '' group by day, class_name) c),
    'platforms_by_day', (select coalesce(json_agg(json_build_object('day', c.day, 'p', c.platform, 'n', c.n) order by c.day, c.n desc), '[]'::json)
               from (select day, platform, count(distinct device) as n from visits where day > t - 30 group by day, platform) c)
  ) into r;
  return r;
end $$;
grant execute on function visit_stats() to authenticated;
