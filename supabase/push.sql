-- Звънец · известия на телефона (Web Push)
-- Пусни в Supabase → SQL Editor → Run (след zvanets-v5.sql). Може да се пуска повторно.

-- 1. Абонаменти: един ред на телефон. Никой не може да ги чете през API-то, само функцията push.
create table if not exists push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  class_name text not null default '',
  created_at timestamptz not null default now(),
  seen_at    timestamptz not null default now()
);
alter table push_subs drop constraint if exists push_subs_endpoint_check;
alter table push_subs add constraint push_subs_endpoint_check check (
  char_length(endpoint) <= 1000 and
  endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
);
alter table push_subs drop constraint if exists push_subs_keys_check;
alter table push_subs add constraint push_subs_keys_check check (char_length(p256dh) between 80 and 100 and char_length(auth) between 16 and 30);
create index if not exists push_subs_class_idx on push_subs (class_name);
alter table push_subs enable row level security;
revoke all on push_subs from anon, authenticated;

-- телефонът се записва (или сменя класа си)
create or replace function push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_class text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from classes where name = p_class) then return false; end if;
  insert into push_subs (endpoint, p256dh, auth, class_name) values (p_endpoint, p_p256dh, p_auth, p_class)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, class_name = excluded.class_name, seen_at = now();
  return true;
end $$;
create or replace function push_unsubscribe(p_endpoint text) returns boolean
language sql volatile security definer set search_path = public as $$
  with d as (delete from push_subs where endpoint = p_endpoint returning 1) select true;
$$;
revoke all on function push_subscribe(text, text, text, text) from public;
revoke all on function push_unsubscribe(text) from public;
grant execute on function push_subscribe(text, text, text, text) to anon, authenticated;
grant execute on function push_unsubscribe(text) to anon, authenticated;

-- 2. Кое събитие за какво вече е известено (за да няма второ известие при поправка на текста)
create table if not exists push_log (
  event_id text primary key,
  sig      text not null,
  sent_at  timestamptz not null default now()
);
alter table push_log enable row level security;
revoke all on push_log from anon, authenticated;

-- ново известие само при нов запис, сменена дата/клас, а при промени в програмата и при сменен час/стая/отмяна
create or replace function push_sig(e events) returns text
language sql immutable as $$
  select case when e.type = 'change'
    then concat_ws('|', e.type, e.date, e.period, e.cancel, e.room, e.substitute, e.subject, array_to_string(e.classes, ','), e.all_school)
    else concat_ws('|', e.type, e.date, array_to_string(e.classes, ','), e.all_school) end
$$;

-- вече съществуващите събития се смятат за известени
insert into push_log (event_id, sig) select e.id, push_sig(e) from events e on conflict (event_id) do nothing;

-- вика се от функцията push с входа на отговорника: връща само събитията, за които той има права и още няма известие
create or replace function push_claim(p_ids text[]) returns json
language plpgsql volatile security definer set search_path = public as $$
declare r json;
begin
  with ev as (
    select e.*, push_sig(e) as sig from events e
    where e.id = any(p_ids) and e.date >= sofia_today()
      and (not e.all_school or is_admin()) and can_edit_classes(e.classes)
  ), fresh as (
    select ev.* from ev left join push_log l on l.event_id = ev.id where l.sig is distinct from ev.sig
  ), up as (
    insert into push_log (event_id, sig) select id, sig from fresh
    on conflict (event_id) do update set sig = excluded.sig, sent_at = now()
    returning 1
  )
  select coalesce(json_agg(json_build_object('id', f.id, 'type', f.type, 'date', f.date, 'period', f.period, 'subject', f.subject, 'note', f.note,
           'classes', f.classes, 'all_school', f.all_school, 'cancel', f.cancel, 'room', f.room, 'substitute', f.substitute)), '[]'::json)
    into r from fresh f;
  return r;
end $$;
revoke all on function push_claim(text[]) from public;
grant execute on function push_claim(text[]) to authenticated;
