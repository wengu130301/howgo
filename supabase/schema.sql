-- HowGo 云端数据表（Supabase / 任意 PostgREST 兼容服务）
-- 用法：Supabase 控制台 → SQL Editor → 粘贴执行一次
-- 说明：整份 db（用户、会话、消息、审核记录）以单行 jsonb 存储，
--       server.js 通过 PostgREST 读写，不依赖持久磁盘，实例重建 / 休眠唤醒都不丢数据。

create table if not exists public.howgo_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- 仅服务端用 service_role key 访问，service_role 绕过 RLS，无需额外策略；
-- 打开 RLS 可防止 anon key 被误用读取。
alter table public.howgo_kv enable row level security;

-- 可选：给 updated_at 自动维护
create or replace function public.howgo_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_howgo_touch on public.howgo_kv;
create trigger trg_howgo_touch
  before update on public.howgo_kv
  for each row execute function public.howgo_touch_updated_at();
