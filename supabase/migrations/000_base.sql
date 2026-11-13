-- Звънец · базови таблици (програма, звънец, класове, събития)
-- Възстановено от кода на приложението: оригиналните schema.sql/seed.sql не бяха в repo-то.
-- В истинската база тези таблици вече съществуват; файлът е за НОВА база (ново училище, тестове).
-- Може да се пуска повторно.

create table if not exists settings (
  id         int primary key default 1,
  rev        text not null default 'r0',
  updated_at timestamptz not null default now(),
  school     text not null default ''
);
insert into settings (id) values (1) on conflict do nothing;

create table if not exists classes (
  name  text primary key,
  shift int  not null default 1 check (shift in (1, 2))
);

create table if not exists bells (
  shift      int  not null,
  idx        int  not null,
  n          int  not null,
  start_time time not null,
  end_time   time not null,
  primary key (shift, idx)
);

create table if not exists lessons (
  class_name text not null references classes(name) on update cascade on delete cascade,
  weekday    int  not null check (weekday between 1 and 7),
  idx        int  not null,
  subject    text not null default '',
  room       text not null default '',
  teacher    text not null default '',
  primary key (class_name, weekday, idx)
);

create table if not exists events (
  id         text primary key,
  type       text not null,
  date       date not null,
  period     int,
  subject    text not null default '',
  note       text not null default '',
  classes    text[] not null default '{}',
  all_school boolean not null default false,
  cancel     boolean not null default false,
  room       text not null default '',
  substitute text not null default ''
);
create index if not exists events_date on events (date);

alter table settings enable row level security;
alter table classes  enable row level security;
alter table bells    enable row level security;
alter table lessons  enable row level security;
alter table events   enable row level security;

-- всеки (и без вход) може да чете програмата и записите
do $$
declare t text;
begin
  foreach t in array array['settings', 'classes', 'bells', 'lessons', 'events'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd = 'SELECT') then
      execute format('create policy "public read" on %I for select using (true)', t);
    end if;
  end loop;
end $$;
