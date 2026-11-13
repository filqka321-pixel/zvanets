-- Звънец · по-малко лични данни и ограничения (13.11.2026)
-- Пусни в Supabase → SQL Editor → Run. Може да се пуска повторно.
-- 1) Под домашните на ученици се пази само „Иван П.“, не цялото име (записите се виждат от всички).
-- 2) Предмет до 80 знака, описание до 500 (за всички освен администратора).
-- 3) Ученик, който смени класа си (или учител, който стане ученик), чака одобрение от администратора.

create or replace function short_name(n text) returns text language sql immutable as $$
  select case
    when array_length(w, 1) > 1 then w[1] || ' ' || left(w[array_length(w, 1)], 1) || '.'
    else coalesce(w[1], '') end
  from (select regexp_split_to_array(btrim(regexp_replace(coalesce(n, ''), '\s+', ' ', 'g')), ' ') as w) x
$$;

create or replace function events_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare m members; n int;
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by; new.author := old.author; new.author_role := old.author_role; new.created_at := old.created_at;
  else
    new.created_by := auth.uid(); new.created_at := now();
  end if;
  if auth.uid() is null then return new; end if;
  if not is_admin() then
    if char_length(coalesce(new.subject, '')) > 80 or char_length(coalesce(new.note, '')) > 500 then raise exception 'text too long'; end if;
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  select * into m from members where user_id = auth.uid();
  if is_admin() then
    new.author := coalesce(nullif(m.name, ''), 'Администрация'); new.author_role := 'admin';
  else
    select count(*) into n from events where created_by = auth.uid() and created_at > now() - interval '1 day';
    if n >= 30 then raise exception 'too many posts today'; end if;
    new.author := case when m.role = 'student' then short_name(m.name) else coalesce(m.name, '') end;
    new.author_role := coalesce(m.role, '');
  end if;
  return new;
end $$;
drop trigger if exists events_author on events;
create trigger events_author before insert or update on events for each row execute function events_author();

-- съкрати имената под вече публикуваните домашни от ученици
alter table events disable trigger events_author;
update events set author = short_name(author) where author_role = 'student' and author <> short_name(author);
alter table events enable trigger events_author;

-- регистрация: смяна на класа (или от учител към ученик) чака одобрение
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
    st := case when not had then 'active'
               when old.role = 'student' and old.class_name = p_class then old.status
               else 'pending' end;
    insert into members (user_id, email, role, name, class_name, status) values (uid, my_email(), 'student', nm, p_class, st)
    on conflict (user_id) do update set email = excluded.email, role = 'student', name = excluded.name, class_name = excluded.class_name,
      teacher_name = '', teacher_key = '', status = st,
      approved_at = case when st = 'active' then members.approved_at else null end;
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
