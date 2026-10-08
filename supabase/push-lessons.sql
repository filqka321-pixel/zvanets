-- Звънец · известие за следващия час (пусни след push.sql). Може да се пуска повторно.
-- Преди да го пуснеш: замени ZV_CRON_SECRET в cron.schedule долу със същата стойност като CRON_SECRET във функцията push.

-- 1. Абонаментът помни групата по немски и дали ученикът иска напомняне за всеки час
alter table push_subs add column if not exists de_t text not null default '';
alter table push_subs add column if not exists de_l boolean;
alter table push_subs add column if not exists lessons boolean not null default true;

create or replace function push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_class text, p_de_t text, p_de_l boolean, p_lessons boolean) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from classes where name = p_class) then return false; end if;
  insert into push_subs (endpoint, p256dh, auth, class_name, de_t, de_l, lessons)
  values (p_endpoint, p_p256dh, p_auth, p_class, left(coalesce(p_de_t, ''), 60), p_de_l, coalesce(p_lessons, true))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, class_name = excluded.class_name,
    de_t = excluded.de_t, de_l = excluded.de_l, lessons = excluded.lessons, seen_at = now();
  return true;
end $$;
revoke all on function push_subscribe(text, text, text, text, text, boolean, boolean) from public;
grant execute on function push_subscribe(text, text, text, text, text, boolean, boolean) to anon, authenticated;

-- 2. Кое напомняне вече е изпратено (за да не идва два пъти)
create table if not exists push_sent (
  key text primary key,
  at  timestamptz not null default now()
);
alter table push_sent enable row level security;
revoke all on push_sent from anon, authenticated;

-- 3. Supabase вика функцията push всяка минута в учебно време, понеделник–петък
--    (часовете в cron са по UTC; 3–17 ч UTC покриват учебното време по българско време и през зимата, и през лятото)
-- ако тези два реда дадат грешка: Database → Extensions → включи pg_cron и pg_net, после пусни файла пак
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname = 'zvanets-lessons';
select cron.schedule('zvanets-lessons', '* 3-17 * * 1-5', $job$
  select net.http_post(
    url := 'https://atugivlnasrdjnuasuig.supabase.co/functions/v1/push',
    headers := '{"Content-Type": "application/json", "x-zv-cron": "ZV_CRON_SECRET"}'::jsonb,
    body := '{"tick": true}'::jsonb,
    timeout_milliseconds := 20000
  );
$job$);

-- Проверка след няколко минути:
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content, created from net._http_response order by created desc limit 5;
