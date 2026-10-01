-- Звънец · поправка на статистиката (пусни веднъж в Supabase → SQL Editor → Run)
-- Брои и устройствата, които още не са си избрали клас, и смяната на клас в същия ден.
alter table visits drop constraint if exists visits_pkey;
alter table visits add primary key (day, device, class_name);

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
                     group by class_name) c)
  ) into r;
  return r;
end $$;
grant execute on function visit_stats() to authenticated;
