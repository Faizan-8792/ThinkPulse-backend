-- Run this in Supabase SQL editor before saving premium API settings from admin panel.

create table if not exists public.app_settings (
  id bigserial primary key,
  setting_key text not null unique,
  setting_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_app_settings_setting_key
  on public.app_settings (setting_key);
