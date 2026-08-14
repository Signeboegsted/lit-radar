-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  description text not null,
  keywords text[] not null,
  created_at timestamptz default now()
);

-- Tracks which papers have already been sent to which project,
-- so the monthly job never repeats a paper.
create table if not exists sent_papers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  paper_id text not null,          -- e.g. Semantic Scholar paperId or DOI
  sent_at timestamptz default now(),
  unique (project_id, paper_id)
);

-- Row Level Security: lock the tables down, then open only what the
-- public signup form needs (insert into projects). The monthly job
-- uses a separate service key that bypasses RLS entirely.
alter table projects enable row level security;
alter table sent_papers enable row level security;

create policy "anyone can register a project"
  on projects for insert
  to anon
  with check (true);

-- No select/update/delete policies for anon — the public site can only
-- add new projects, never read or change existing ones.
