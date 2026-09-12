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
