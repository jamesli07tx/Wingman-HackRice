-- ORCHESTRATOR-OWNED (cross-cutting): Supabase schema. Run once in the
-- Supabase SQL editor (INTEGRATION-DAY: human runs this when the Supabase
-- project keys land in .env). Column names are snake_case; TS maps to the
-- camelCase shapes in @wingman/shared.

create table if not exists companies (
  company_id   text primary key,
  name         text not null,
  aliases      text[] not null default '{}',
  tier         text not null check (tier in ('sponsor', 'marquee')),
  summary_md   text not null default '',
  roles        text[] not null default '{}',
  deadlines    text[] not null default '{}',
  careers_url  text not null default '',
  facts_json   jsonb not null default '{}',
  summary_card jsonb,            -- pre-generated HudCard content (contract term D7)
  source       text not null default '',
  updated_at   timestamptz not null default now()
);

create table if not exists profiles (
  user_id    text primary key,   -- Clerk user id
  summary    jsonb,              -- ProfileSummary (null until resume parsed)
  links      jsonb not null default '{}',  -- ProfileLinks
  updated_at timestamptz not null default now()
);

create table if not exists devices (
  device_id   text primary key,
  user_id     text not null,
  device_type text not null check (device_type in ('glasses_bridge', 'phone_web')),
  name        text not null,
  token_hash  text not null,     -- sha256 of deviceToken; raw token never stored
  last_seen   timestamptz not null default now()
);

create table if not exists link_codes (
  code       text primary key,   -- 6 digits
  user_id    text not null,
  expires_at timestamptz not null
);

-- Per-user company briefs: a user's own edit of a company's lens card. Overrides the shared
-- companies.summary_card (and a live-researched card with the same slug) for THAT user's sessions only.
create table if not exists user_company_cards (
  user_id    text not null,      -- Clerk user id
  company_id text not null,      -- companies.company_id, or slugify(name) for a company not on file
  name       text not null,
  card       jsonb not null,     -- SummaryCardContent (C3 limits enforced by Cortex)
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id)
);
