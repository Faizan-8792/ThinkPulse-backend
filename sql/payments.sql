-- Run this in Supabase SQL editor before enabling Razorpay webhooks.

create table if not exists public.payments (
  id bigserial primary key,
  user_id text not null,
  amount numeric(10,2) not null check (amount >= 0),
  status text not null,
  payment_id text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_payments_user_id on public.payments (user_id);
create index if not exists idx_payments_created_at on public.payments (created_at desc);
