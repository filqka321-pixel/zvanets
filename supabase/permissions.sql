-- Звънец · who can edit which class
-- Run once in Supabase → SQL Editor. Safe to run again.
-- Before running: put YOUR login email on the line marked  <<< YOUR EMAIL  (you become admin = all classes).

-- 1. Editors table: one row per (email, class). class_name '*' = admin (all classes, bells, access list).
create table if not exists editors (
  email      text not null,
  class_name text not null default '*',
  primary key (email, class_name)
);
alter table editors add column if not exists class_name text not null default '*';   -- upgrades the old table
alter table editors drop constraint if exists editors_pkey;
alter table editors add primary key (email, class_name);
alter table editors alter column class_name drop default;
update editors set email = lower(email);

insert into editors (email, class_name) values (lower('YOUR-EMAIL@example.com'), '*')   -- <<< YOUR EMAIL
on conflict do nothing;

-- 2. Helper functions (run with owner rights so they can read the editors table)
create or replace function my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where email = my_email() and class_name = '*');
$$;

create or replace function can_edit_class(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where email = my_email() and (class_name = '*' or class_name = c));
$$;

create or replace function can_edit_classes(cs text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (coalesce(cardinality(cs), 0) > 0 and not exists (select 1 from unnest(cs) x where not can_edit_class(x)));
$$;

-- what the app asks after login: e.g. {10е} or {*}
create or replace function my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(class_name order by class_name), '{}') from editors where email = my_email();
$$;

-- 3. Rules. Everyone can still read the timetable.
do $$
declare t text;
begin
  foreach t in array array['settings','classes','bells','lessons','events'] loop
    execute format('drop policy if exists "auth write" on %I', t);
    execute format('drop policy if exists "editor write" on %I', t);
    execute format('drop policy if exists "admin write" on %I', t);
    execute format('drop policy if exists "class write" on %I', t);
  end loop;
end $$;

-- shared things: admin only
create policy "admin write" on settings for all to authenticated using (is_admin()) with check (is_admin());
create policy "admin write" on classes  for all to authenticated using (is_admin()) with check (is_admin());
create policy "admin write" on bells    for all to authenticated using (is_admin()) with check (is_admin());
-- timetable: only your class
create policy "class write" on lessons  for all to authenticated
  using (can_edit_class(class_name)) with check (can_edit_class(class_name));
-- tests/events: only entries that belong to your class(es); whole-school entries = admin
create policy "class write" on events   for all to authenticated
  using ((not all_school or is_admin()) and can_edit_classes(classes))
  with check ((not all_school or is_admin()) and can_edit_classes(classes));

-- access list: admin manages it, everyone can see their own rows
alter table editors enable row level security;
drop policy if exists "read own or admin" on editors;
drop policy if exists "admin manage" on editors;
create policy "read own or admin" on editors for select to authenticated using (is_admin() or email = my_email());
create policy "admin manage" on editors for all to authenticated using (is_admin()) with check (is_admin());

-- 4. "Обновено" time updates on every change (works for class editors too)
create or replace function touch_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update settings set updated_at = now(), rev = substr(md5(random()::text), 1, 11) where id = 1;
  return null;
end $$;
drop trigger if exists touch_lessons on lessons;
drop trigger if exists touch_events  on events;
drop trigger if exists touch_bells   on bells;
drop trigger if exists touch_classes on classes;
create trigger touch_lessons after insert or update or delete on lessons for each statement execute function touch_settings();
create trigger touch_events  after insert or update or delete on events  for each statement execute function touch_settings();
create trigger touch_bells   after insert or update or delete on bells   for each statement execute function touch_settings();
create trigger touch_classes after insert or update or delete on classes for each statement execute function touch_settings();

-- 5. Grants
grant usage on schema public to anon, authenticated;
grant select on settings, classes, bells, lessons, events to anon, authenticated;
grant insert, update, delete on settings, classes, bells, lessons, events to authenticated;
grant select, insert, update, delete on editors to authenticated;
revoke all on editors from anon;
grant execute on function my_permissions() to authenticated;
