-- Звънец · статистика за известията (само за админ). Пусни в SQL Editor → Run. Може да се пуска повторно.
-- Показва само бройки: кой точно си е включил известията не се пази никъде.
create or replace function push_stats() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  if not is_admin() then return null; end if;
  select json_build_object(
    'total',   (select count(*) from push_subs),
    'lessons', (select count(*) from push_subs where lessons),
    'today',   (select count(*) from push_subs where (created_at at time zone 'Europe/Sofia')::date = sofia_today()),
    'week',    (select count(*) from push_subs where created_at > now() - interval '7 days'),
    'platforms', (select coalesce(json_agg(json_build_object('p', p, 'n', n) order by n desc), '[]'::json) from (
        select case
                 when endpoint ~ '^https://([a-z0-9.-]+\.)?push\.apple\.com/' then 'iPhone'
                 when endpoint ~ '^https://(fcm|android)\.googleapis\.com/' then 'Android / Chrome'
                 when endpoint like 'https://updates.push.services.mozilla.com/%' then 'Firefox'
                 else 'Друго' end as p,
               count(*) as n
        from push_subs group by 1) x),
    'classes', (select coalesce(json_agg(json_build_object('cls', class_name, 'n', n, 'lessons', l) order by n desc, class_name), '[]'::json) from (
        select class_name, count(*) as n, count(*) filter (where lessons) as l from push_subs group by class_name) c)
  ) into r;
  return r;
end $$;
revoke all on function push_stats() from public;
grant execute on function push_stats() to authenticated;
