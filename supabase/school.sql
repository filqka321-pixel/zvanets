-- Звънец · училищен режим: един администратор, учители и ученици с профили.
-- Пусни в Supabase → SQL Editor → Run (след всички предишни файлове). Може да се пуска повторно.
--
-- Администраторът (редовете с клас „*“ в editors) въвежда и променя програмата, класовете и звънеца.
-- Учителите се регистрират, избират името си от програмата и чакат одобрение от администратора;
-- после добавят тестове и домашни само за класовете, в които преподават.
-- Учениците се регистрират и веднага могат да добавят домашни за своя клас.

-- 0. Отговорниците на отделни класове вече ги няма: остават само администраторите
delete from editors where class_name <> '*';

-- 1. Имената на учителите: същите правила като в приложението (иницал + фамилия)
create or replace function t_lower(s text) returns text language sql immutable as $$
  select lower(translate(coalesce(s, ''), 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯЁ', 'абвгдежзийклмнопрстуфхцчшщъьюяё'))
$$;
create or replace function t_norm(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(replace(t_lower(s), 'ё', 'е'), '[.\-]', ' ', 'g'), '\s+', ' ', 'g'))
$$;
create or replace function t_key(n text) returns text language sql immutable as $$
  select case when coalesce(array_length(w, 1), 0) > 1 then left(w[1], 1) || ' ' || w[array_length(w, 1)] else coalesce(w[1], '') end
  from (select string_to_array(nullif(t_norm(n), ''), ' ') as w) x
$$;
-- „В. Филипова-Панкова (104) · Н. Емин-Хасанова (103)“ → {в панкова, н хасанова}
create or replace function lesson_teacher_keys(t text) returns setof text language sql immutable as $$
  select t_key(p) from (
    select btrim(regexp_replace(regexp_replace(btrim(x), '\([^)]*\)\s*$', ''), '^[Гг]р\.?\s*\d+\s+', '')) as p
    from regexp_split_to_table(coalesce(t, ''), '\s*[·/]\s*') x
  ) y
  where char_length(p) >= 4 and p ~ '[А-ЯЁA-Z][а-яёa-z]' and t_lower(p) !~ '^(само|група|гр(\s|\.|$))'
$$;
create or replace function teacher_classes(k text) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct l.class_name order by l.class_name), '{}')
  from lessons l where coalesce(k, '') <> '' and exists (select 1 from lesson_teacher_keys(l.teacher) x where x = k)
$$;

-- 2. Профили
create table if not exists members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null default '',
  role         text not null check (role in ('student', 'teacher')),
  name         text not null check (char_length(name) between 2 and 60),
  class_name   text not null default '',
  teacher_name text not null default '',
  teacher_key  text not null default '',
  status       text not null default 'active' check (status in ('pending', 'active', 'blocked')),
  created_at   timestamptz not null default now(),
  approved_at  timestamptz
);
create index if not exists members_status_idx on members (status);
alter table members enable row level security;
drop policy if exists "own or admin read" on members;
drop policy if exists "admin manage" on members;
create policy "own or admin read" on members for select to authenticated using (user_id = auth.uid() or is_admin());
create policy "admin manage" on members for all to authenticated using (is_admin()) with check (is_admin());
grant select, insert, update, delete on members to authenticated;
revoke all on members from anon;

create or replace function my_member() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('role', m.role, 'status', m.status, 'name', m.name, 'class_name', m.class_name,
    'teacher_name', m.teacher_name, 'email', m.email,
    'classes', case when m.role = 'teacher' then teacher_classes(m.teacher_key) else array[m.class_name] end)
  from members m where m.user_id = auth.uid()
$$;
grant execute on function my_member() to authenticated;

-- регистрация или смяна на профила: ученикът е активен веднага, учителят чака одобрение
create or replace function member_register(p_role text, p_name text, p_class text, p_teacher text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); old members; had boolean; k text; st text; nm text := btrim(coalesce(p_name, ''));
begin
  if uid is null then raise exception 'not signed in'; end if;
  if char_length(nm) < 2 or char_length(nm) > 60 then raise exception 'name: 2-60 characters'; end if;
  select * into old from members where user_id = uid;
  had := found;
  if had and old.status = 'blocked' then raise exception 'blocked'; end if;
  if p_role = 'student' then
    if not exists (select 1 from classes where name = p_class) then raise exception 'unknown class'; end if;
    insert into members (user_id, email, role, name, class_name, status) values (uid, my_email(), 'student', nm, p_class, 'active')
    on conflict (user_id) do update set email = excluded.email, role = 'student', name = excluded.name, class_name = excluded.class_name,
      teacher_name = '', teacher_key = '', status = 'active';
  elsif p_role = 'teacher' then
    k := t_key(p_teacher);
    if k = '' or cardinality(teacher_classes(k)) = 0 then raise exception 'unknown teacher'; end if;
    st := case when had and old.role = 'teacher' and old.teacher_key = k and old.status = 'active' then 'active' else 'pending' end;
    insert into members (user_id, email, role, name, class_name, teacher_name, teacher_key, status)
    values (uid, my_email(), 'teacher', nm, '', left(btrim(p_teacher), 60), k, st)
    on conflict (user_id) do update set email = excluded.email, role = 'teacher', name = excluded.name, class_name = '',
      teacher_name = excluded.teacher_name, teacher_key = excluded.teacher_key, status = st,
      approved_at = case when st = 'active' then members.approved_at else null end;
  else
    raise exception 'unknown role';
  end if;
  return my_member();
end $$;
revoke all on function member_register(text, text, text, text) from public;
grant execute on function member_register(text, text, text, text) to authenticated;

-- 3. Кой какво може да публикува
create or replace function can_post(p_type text, p_classes text[], p_all boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from members m
    where m.user_id = auth.uid() and m.status = 'active' and not coalesce(p_all, false) and coalesce(cardinality(p_classes), 0) > 0 and (
      (m.role = 'teacher' and p_type in ('test', 'entry', 'control', 'classwork', 'oral', 'project', 'event') and p_classes <@ teacher_classes(m.teacher_key))
      or (m.role = 'student' and p_type = 'project' and p_classes = array[m.class_name])))
$$;
-- учителят може да трие домашни на ученици от своите класове
create or replace function can_moderate(p_role text, p_classes text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select p_role = 'student' and exists (
    select 1 from members m where m.user_id = auth.uid() and m.status = 'active' and m.role = 'teacher'
      and coalesce(cardinality(p_classes), 0) > 0 and p_classes <@ teacher_classes(m.teacher_key))
$$;

alter table events add column if not exists created_by uuid;
alter table events add column if not exists author text not null default '';
alter table events add column if not exists author_role text not null default '';
alter table events add column if not exists created_at timestamptz not null default now();

-- авторът се записва от базата, не от приложението (не може да се подправи); най-много 30 записа на ден
create or replace function events_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare m members; n int;
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by; new.author := old.author; new.author_role := old.author_role; new.created_at := old.created_at;
    return new;
  end if;
  new.created_by := auth.uid(); new.created_at := now();
  if auth.uid() is null then return new; end if;
  select * into m from members where user_id = auth.uid();
  if is_admin() then
    new.author := coalesce(nullif(m.name, ''), 'Администрация'); new.author_role := 'admin';
  else
    select count(*) into n from events where created_by = auth.uid() and created_at > now() - interval '1 day';
    if n >= 30 then raise exception 'too many posts today'; end if;
    new.author := coalesce(m.name, ''); new.author_role := coalesce(m.role, '');
  end if;
  return new;
end $$;
drop trigger if exists events_author on events;
create trigger events_author before insert or update on events for each row execute function events_author();

do $$
declare p text;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'events' and cmd <> 'SELECT' loop
    execute format('drop policy if exists %I on events', p);
  end loop;
end $$;
create policy "post" on events for insert to authenticated with check (can_post(type, classes, all_school));
create policy "edit own" on events for update to authenticated
  using (is_admin() or created_by = auth.uid())
  with check (can_post(type, classes, all_school) and (is_admin() or created_by = auth.uid()));
create policy "delete own or moderate" on events for delete to authenticated
  using (is_admin() or created_by = auth.uid() or can_moderate(author_role, classes));

-- 4. Програмата, класовете и звънецът: само администраторът
create or replace function can_edit_class(c text) returns boolean
language sql stable security definer set search_path = public as $$ select is_admin() $$;
drop policy if exists "class write" on lessons;
drop policy if exists "admin write" on lessons;
create policy "admin write" on lessons for all to authenticated using (is_admin()) with check (is_admin());

-- записът на един ден е „всичко или нищо“: никога не остава ден без часове заради прекъсната връзка
create or replace function save_day(p_class text, p_weekday int, p_rows jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from lessons where class_name = p_class and weekday = p_weekday;
  insert into lessons (class_name, weekday, idx, subject, room, teacher)
  select p_class, p_weekday, (r->>'idx')::int, coalesce(r->>'subject', ''), coalesce(r->>'room', ''), coalesce(r->>'teacher', '')
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function save_bells(p_rows jsonb) returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if coalesce(jsonb_array_length(p_rows), 0) = 0 then raise exception 'empty bell schedule'; end if;
  delete from bells where shift >= 0;
  insert into bells (shift, idx, n, start_time, end_time)
  select (r->>'shift')::int, (r->>'idx')::int, (r->>'n')::int, (r->>'start_time')::time, (r->>'end_time')::time
  from jsonb_array_elements(p_rows) r;
  get diagnostics n = row_count;
  return n;
end $$;

-- импорт от aSc: класовете от файла получават изцяло новата програма, останалите не се пипат
create or replace function import_timetable(p_classes jsonb, p_lessons jsonb) returns json
language plpgsql volatile security definer set search_path = public as $$
declare names text[]; n int;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select coalesce(array_agg(c->>'name'), '{}') into names from jsonb_array_elements(coalesce(p_classes, '[]'::jsonb)) c;
  if cardinality(names) = 0 then raise exception 'no classes'; end if;
  insert into classes (name, shift)
  select c->>'name', (c->>'shift')::int from jsonb_array_elements(p_classes) c
  on conflict (name) do update set shift = excluded.shift;
  delete from lessons where class_name = any(names);
  insert into lessons (class_name, weekday, idx, subject, room, teacher)
  select l->>'class_name', (l->>'weekday')::int, (l->>'idx')::int, coalesce(l->>'subject', ''), coalesce(l->>'room', ''), coalesce(l->>'teacher', '')
  from jsonb_array_elements(coalesce(p_lessons, '[]'::jsonb)) l
  where l->>'class_name' = any(names);
  get diagnostics n = row_count;
  return json_build_object('classes', cardinality(names), 'lessons', n);
end $$;

create or replace function delete_class(p_name text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from lessons where class_name = p_name;
  delete from classes where name = p_name;
  return true;
end $$;

revoke all on function save_day(text, int, jsonb) from public;
revoke all on function save_bells(jsonb) from public;
revoke all on function import_timetable(jsonb, jsonb) from public;
revoke all on function delete_class(text) from public;
grant execute on function save_day(text, int, jsonb) to authenticated;
grant execute on function save_bells(jsonb) to authenticated;
grant execute on function import_timetable(jsonb, jsonb) to authenticated;
grant execute on function delete_class(text) to authenticated;

-- 5. Известия: за записите на учители и администратора (не за домашните от ученици)
create or replace function push_claim(p_ids text[]) returns json
language plpgsql volatile security definer set search_path = public as $$
declare r json;
begin
  with ev as (
    select e.*, push_sig(e) as sig from events e
    where e.id = any(p_ids) and e.date >= sofia_today()
      and (is_admin() or (e.created_by = auth.uid() and exists (
        select 1 from members m where m.user_id = auth.uid() and m.role = 'teacher' and m.status = 'active')))
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
