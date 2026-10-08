-- Звънец · защита срещу спам (пусни след push-lessons.sql). Може да се пуска повторно.

-- 1. Посещения: само истински идентификатори на устройства, само съществуващ клас, най-много 5000 на ден
create or replace function log_visit(p_device text, p_class text default '', p_installed boolean default false)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if coalesce(p_device, '') !~ '^[0-9a-z-]{20,40}$' then return; end if;
  if p_class is null or (p_class <> 'учител' and not exists (select 1 from classes where name = p_class)) then return; end if;
  if (select count(*) from visits where day = sofia_today()) >= 5000 then return; end if;
  insert into visits (day, device, class_name, installed) values (sofia_today(), p_device, p_class, coalesce(p_installed, false))
  on conflict do nothing;
end $$;
revoke all on function log_visit(text, text, boolean) from public;
grant execute on function log_visit(text, text, boolean) to anon, authenticated;

-- 2. Абонаменти за известия: най-много 1500 нови на ден и 20000 общо
alter table push_subs add column if not exists last_test timestamptz;

create or replace function push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_class text, p_de_t text, p_de_l boolean, p_lessons boolean) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from classes where name = p_class) then return false; end if;
  if not exists (select 1 from push_subs where endpoint = p_endpoint) then
    if (select count(*) from push_subs where created_at > now() - interval '1 day') >= 1500
       or (select count(*) from push_subs) >= 20000 then
      raise exception 'too many new subscriptions, try later';
    end if;
  end if;
  insert into push_subs (endpoint, p256dh, auth, class_name, de_t, de_l, lessons)
  values (p_endpoint, p_p256dh, p_auth, p_class, left(coalesce(p_de_t, ''), 60), p_de_l, coalesce(p_lessons, true))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, class_name = excluded.class_name,
    de_t = excluded.de_t, de_l = excluded.de_l, lessons = excluded.lessons, seen_at = now();
  return true;
end $$;

-- старата версия (без групата по немски) минава през същите правила
create or replace function push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_class text) returns boolean
language sql volatile security definer set search_path = public as $$
  select push_subscribe(p_endpoint, p_p256dh, p_auth, p_class, '', null::boolean, true);
$$;
revoke all on function push_subscribe(text, text, text, text, text, boolean, boolean) from public;
revoke all on function push_subscribe(text, text, text, text) from public;
grant execute on function push_subscribe(text, text, text, text, text, boolean, boolean) to anon, authenticated;
grant execute on function push_subscribe(text, text, text, text) to anon, authenticated;
