-- ============================================================
-- REMINISCE — COMPLETE CANONICAL SCHEMA
-- Run this entire file in Supabase → SQL Editor
-- Safe approach: run on a freshly reset public schema
-- (Dashboard → SQL Editor → paste → Run)
--
-- To reset first:
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres, service_role;
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- for fast text search

-- ============================================================
-- SECTION 1: TABLE DEFINITIONS
-- ============================================================

-- ── workspaces ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- ── projects ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  repo_url              text,
  tech_stack            text[],
  -- git integration
  repo_provider         text,
  editor_preference     text DEFAULT 'generic',
  git_branch            text,
  git_last_commit       text,
  created_via           text DEFAULT 'wizard'
    CHECK (created_via IN ('wizard', 'blank', 'import')),
  scan_source           text
    CHECK (scan_source IN ('local', 'github')),
  created_at            timestamptz DEFAULT now()
);

-- ── project_members ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE, -- nullable for pending invites
  role           text NOT NULL DEFAULT 'collaborator'
    CHECK (role IN ('head', 'collaborator', 'viewer')),
  invite_status  text NOT NULL DEFAULT 'accepted'
    CHECK (invite_status IN ('pending', 'accepted', 'declined')),
  invited_by     uuid REFERENCES auth.users(id),
  invite_email   text,
  created_at     timestamptz DEFAULT now()
);

-- ── phases ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.phases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  order_index integer NOT NULL,
  status      text DEFAULT 'planned',
  created_at  timestamptz DEFAULT now(),
  UNIQUE (project_id, name)
);

-- ── features ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.features (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id       uuid NOT NULL REFERENCES public.phases(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text,
  status         text DEFAULT 'planned',
  type           text DEFAULT 'frontend',
  assigned_model text,
  priority       integer DEFAULT 0,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (project_id, phase_id, name)
);

-- ── tasks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id  uuid NOT NULL REFERENCES public.features(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  status      text DEFAULT 'pending',
  complexity  integer,
  created_at  timestamptz DEFAULT now()
);

-- ── contexts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contexts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  file_path     text NOT NULL,
  content       text,
  version       integer DEFAULT 1,
  -- ownership / sync
  summary       text,
  owned_by      text DEFAULT 'reminisce',  -- 'reminisce' | 'developer' | 'shared'
  file_hash     text,
  last_synced_at timestamptz,
  last_modified  timestamptz DEFAULT now(),
  UNIQUE (project_id, file_path)
);

-- ── context_versions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.context_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id  uuid NOT NULL REFERENCES public.contexts(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  content     text,
  diff        text,
  sha         text,
  label       text,
  changed_at  timestamptz DEFAULT now(),
  created_at  timestamptz DEFAULT now()
);

-- ── prompts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prompts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  feature_id        uuid REFERENCES public.features(id) ON DELETE SET NULL,
  task_id           uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  raw_prompt        text,
  structured_prompt text,
  prompt_type       text,
  title             text,
  is_master_prompt  boolean DEFAULT false,
  phase_id          uuid REFERENCES public.phases(id) ON DELETE SET NULL,
  context_files     text[],
  checklist         jsonb,
  expected_output   text,
  model_suggested   text,
  run_count         integer DEFAULT 0,
  last_used_at      timestamptz,
  updated_at        timestamptz DEFAULT now(),
  created_at        timestamptz DEFAULT now()
);

-- ── agent_runs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  feature_id       uuid REFERENCES public.features(id) ON DELETE SET NULL,
  prompt_id        uuid REFERENCES public.prompts(id) ON DELETE SET NULL,
  model            text,
  model_used       text,
  context_snapshot text,
  prompt_used      text,
  response         text,
  output           text,
  tokens_used      integer,
  status           text,
  error_message    text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz DEFAULT now()
);

-- ── wizard_sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wizard_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- chat state
  messages           jsonb DEFAULT '[]'::jsonb,
  stage              text NOT NULL DEFAULT 'idea',
  stage_data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_stages   text[] NOT NULL DEFAULT '{}',
  confirmed_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_idea     text,
  selected_stack     jsonb NOT NULL DEFAULT '{}'::jsonb,
  stack_options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_audience    text,
  -- generation state
  generation_status  text NOT NULL DEFAULT 'idle',
  generation_step    integer NOT NULL DEFAULT 0,
  last_error         text,
  -- legacy fields kept for compatibility
  architecture       jsonb DEFAULT '{}'::jsonb,
  workflow           jsonb DEFAULT '{}'::jsonb,
  status             text,
  created_at         timestamptz DEFAULT now()
);

-- ── notifications ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  message    text NOT NULL,
  type       text,
  read       boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- ── graph_nodes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.graph_nodes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  type       text,
  label      text,
  status     text,
  position_x float,
  position_y float,
  metadata   jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- ── graph_edges ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.graph_edges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL,
  target_id  uuid NOT NULL,
  edge_type  text,
  created_at timestamptz DEFAULT now()
);

-- ── pam_threads ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pam_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text,
  model_used      text,
  provider_used   text,
  message_count   integer DEFAULT 0,
  last_message_at timestamptz DEFAULT now(),
  archived        boolean DEFAULT false,
  summarised      boolean NOT NULL DEFAULT false,
  created_at      timestamptz DEFAULT now()
);

-- ── pam_thread_summaries ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pam_thread_summaries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  thread_id  uuid NOT NULL REFERENCES public.pam_threads(id) ON DELETE CASCADE,
  summary    text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ── pam_messages ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pam_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid NOT NULL REFERENCES public.pam_threads(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant','system')),
  content          text NOT NULL,
  model_used       text,
  tokens_used      integer,
  action_type      text,
  action_payload   jsonb,
  action_confirmed boolean,
  created_at       timestamptz DEFAULT now()
);

-- ── project_reminders ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message     text NOT NULL,
  remind_at   timestamptz NOT NULL,
  notified    boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

-- ── user_api_keys ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  encrypted_key text NOT NULL,
  label         text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE(user_id, provider)
);

-- ── provider_models ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_models (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  model_id       text NOT NULL,
  model_name     text NOT NULL,
  label          text,
  is_free        boolean DEFAULT false,
  enabled        boolean NOT NULL DEFAULT true,
  visible        boolean NOT NULL DEFAULT true,
  tier_required  text NOT NULL DEFAULT 'free',
  cost_coins     integer,
  cost_gems      integer,
  context_window integer,
  sort_order     integer NOT NULL DEFAULT 0,
  rate_limit_rpm integer NOT NULL DEFAULT 5,
  rate_limit_rpd integer NOT NULL DEFAULT 200,
  notes          text,
  UNIQUE(provider, model_id)
);

-- ── user_plans ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_plans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                   text NOT NULL DEFAULT 'free',
  status                 text NOT NULL DEFAULT 'active',
  projects_limit         integer NOT NULL DEFAULT 2,
  stripe_customer_id     text,
  stripe_subscription_id text,
  is_admin               boolean NOT NULL DEFAULT false,
  banned_at              timestamptz,
  ban_reason             text,
  notes                  text,
  updated_at             timestamptz DEFAULT now(),
  created_at             timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- ── user_wallets ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_wallets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gems                integer NOT NULL DEFAULT 0,
  coins               integer NOT NULL DEFAULT 50,
  coins_last_reset    timestamptz,
  daily_coins_limit   integer NOT NULL DEFAULT 50,
  max_coins_banked    integer NOT NULL DEFAULT 200,
  gems_monthly_grant  integer NOT NULL DEFAULT 0,
  gems_last_granted   timestamptz,
  updated_at          timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- ── wallet_transactions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type               text NOT NULL,      -- 'debit' | 'credit' | 'refund'
  amount             integer NOT NULL,
  currency           text NOT NULL,      -- 'coins' | 'gems'
  model_used         text,
  run_id             uuid,
  description        text,
  transaction_source text,               -- 'run' | 'refund' | 'daily_reset' | 'admin_grant' | etc
  metadata           jsonb DEFAULT '{}'::jsonb,
  created_at         timestamptz DEFAULT now()
);

-- ── gem_purchases ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gem_purchases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_gems              integer NOT NULL,
  amount_paid_cents        integer NOT NULL,
  stripe_payment_intent_id text,
  status                   text NOT NULL DEFAULT 'pending',
  created_at               timestamptz DEFAULT now()
);

-- ── prompt_templates ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prompt_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL,
  tags       text[] DEFAULT '{}',
  category   text NOT NULL DEFAULT 'GENERAL',
  use_count  integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── admin_logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_id   text,
  target_type text,
  target_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  payload     jsonb DEFAULT '{}'::jsonb,
  details     jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now()
);

-- ── memory_chunks (vector) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.memory_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type text NOT NULL
    CHECK (source_type IN ('context_file','pam_thread','blueprint')),
  source_id   text NOT NULL,
  source_path text,
  chunk_index integer NOT NULL,
  content     text NOT NULL,
  embedding   vector(1536),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── rate_events (per-user AI rate limiting) ──────────────────
CREATE TABLE IF NOT EXISTS public.rate_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- SECTION 2: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON public.projects(workspace_id);

CREATE INDEX IF NOT EXISTS idx_projects_repo_provider
  ON public.projects(repo_provider) WHERE repo_provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_project
  ON public.project_members(project_id);

CREATE INDEX IF NOT EXISTS idx_project_members_user
  ON public.project_members(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_phases_project
  ON public.phases(project_id, order_index);

CREATE INDEX IF NOT EXISTS idx_features_project
  ON public.features(project_id);

CREATE INDEX IF NOT EXISTS idx_features_phase
  ON public.features(phase_id);

CREATE INDEX IF NOT EXISTS idx_contexts_project_path
  ON public.contexts(project_id, file_path);

CREATE INDEX IF NOT EXISTS idx_contexts_project_owned
  ON public.contexts(project_id, owned_by);

CREATE INDEX IF NOT EXISTS idx_context_versions_context
  ON public.context_versions(context_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_versions_project
  ON public.context_versions(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_project
  ON public.prompts(project_id);

CREATE INDEX IF NOT EXISTS idx_prompts_run_count
  ON public.prompts(project_id, run_count DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project
  ON public.agent_runs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pam_threads_project
  ON public.pam_threads(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pam_threads_user
  ON public.pam_threads(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pam_thread_summaries_project
  ON public.pam_thread_summaries(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pam_thread_summaries_thread
  ON public.pam_thread_summaries(thread_id);

CREATE INDEX IF NOT EXISTS idx_pam_messages_thread
  ON public.pam_messages(thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_pam_messages_project
  ON public.pam_messages(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user
  ON public.wallet_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_project
  ON public.memory_chunks(project_id, source_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
  ON public.memory_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_user
  ON public.prompt_templates(user_id);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin
  ON public.admin_logs(admin_id, created_at DESC);

-- ── Additional performance indexes ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_pam_threads_archived
  ON public.pam_threads(project_id, archived, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_master
  ON public.prompts(project_id, is_master_prompt) WHERE is_master_prompt = true;

CREATE INDEX IF NOT EXISTS idx_project_members_invite_email
  ON public.project_members(project_id, invite_email) WHERE invite_email IS NOT NULL;

-- Prevent duplicate pending invites to the same email per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_pending_email_unique
  ON public.project_members(project_id, invite_email)
  WHERE invite_status = 'pending';

-- ── Rate limiting / admin / idempotency (folded from 0037-0038) ──
CREATE INDEX IF NOT EXISTS idx_rate_events_user_model_time
  ON public.rate_events (user_id, model_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_models_enabled
  ON public.provider_models(provider, model_id) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_pam_threads_summarised
  ON public.pam_threads(project_id, summarised) WHERE summarised = false;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_project_reward_idempotency
  ON public.wallet_transactions (user_id, transaction_source, (metadata->>'referenceId'))
  WHERE transaction_source IN ('wizard_complete', 'first_agent_run')
    AND metadata->>'referenceId' IS NOT NULL
    AND metadata->>'referenceId' != '';

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_daily_reward_idempotency
  ON public.wallet_transactions (
    user_id,
    transaction_source,
    date_trunc('day', created_at AT TIME ZONE 'UTC')
  )
  WHERE transaction_source IN ('daily_login', 'save_context');

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_refund_idempotency
  ON public.wallet_transactions (run_id, type)
  WHERE type = 'refund'
    AND run_id IS NOT NULL;

-- ============================================================
-- SECTION 3: ENABLE ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.workspaces          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phases              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contexts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wizard_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_nodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graph_edges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pam_threads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pam_thread_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pam_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_reminders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_models     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gem_purchases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_chunks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_events         ENABLE ROW LEVEL SECURITY; -- service-role only; no client policy

-- ============================================================
-- SECTION 4: RLS POLICIES
-- ============================================================

-- ── workspaces ── owner only ─────────────────────────────────
CREATE POLICY "ws_select" ON public.workspaces
  FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "ws_insert" ON public.workspaces
  FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "ws_update" ON public.workspaces
  FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "ws_delete" ON public.workspaces
  FOR DELETE USING (auth.uid() = owner_id);

-- ── helper: is user a member of this project? ────────────────
-- Used by multiple downstream policies.
-- We use inline EXISTS for clarity and stability.

-- ── projects ─── owner OR accepted member ───────────────────
CREATE POLICY "proj_select" ON public.projects
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = id
        AND pm.user_id = auth.uid()
        AND pm.invite_status = 'accepted'
    )
  );
CREATE POLICY "proj_insert" ON public.projects
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );
CREATE POLICY "proj_update" ON public.projects
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );
CREATE POLICY "proj_delete" ON public.projects
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );

-- ── project_members ──────────────────────────────────────────
-- Owner can manage all members; existing members can see the member list.
CREATE POLICY "pm_select" ON public.project_members
  FOR SELECT USING (
    -- user is themself a member
    user_id = auth.uid()
    OR
    -- or they own the workspace for this project
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );
CREATE POLICY "pm_insert" ON public.project_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );
CREATE POLICY "pm_update" ON public.project_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
    OR user_id = auth.uid()   -- user can update their own invite status
  );
CREATE POLICY "pm_delete" ON public.project_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── phases ── owner OR member ────────────────────────────────
CREATE POLICY "phases_all" ON public.phases
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── features ── owner OR member ──────────────────────────────
CREATE POLICY "features_all" ON public.features
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── tasks ────────────────────────────────────────────────────
CREATE POLICY "tasks_all" ON public.tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.features f
      JOIN public.projects p ON p.id = f.project_id
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE f.id = feature_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── contexts ─────────────────────────────────────────────────
CREATE POLICY "contexts_all" ON public.contexts
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── context_versions ─────────────────────────────────────────
CREATE POLICY "context_versions_all" ON public.context_versions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.contexts c
      JOIN public.projects p ON p.id = c.project_id
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE c.id = context_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── prompts ──────────────────────────────────────────────────
CREATE POLICY "prompts_all" ON public.prompts
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id
        AND (
          w.owner_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
              AND pm.invite_status = 'accepted'
          )
        )
    )
  );

-- ── agent_runs ── owner OR accepted member ───────────────────
CREATE POLICY "agent_runs_all" ON public.agent_runs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_id
        AND pm.user_id = auth.uid()
        AND pm.invite_status = 'accepted'
    )
  );

-- ── wizard_sessions ──────────────────────────────────────────
CREATE POLICY "wizard_sessions_all" ON public.wizard_sessions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── notifications ────────────────────────────────────────────
CREATE POLICY "notifications_all" ON public.notifications
  FOR ALL USING (auth.uid() = user_id);

-- ── graph_nodes ──────────────────────────────────────────────
CREATE POLICY "graph_nodes_all" ON public.graph_nodes
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── graph_edges ──────────────────────────────────────────────
CREATE POLICY "graph_edges_all" ON public.graph_edges
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── pam_threads ──────────────────────────────────────────────
CREATE POLICY "pam_threads_all" ON public.pam_threads
  FOR ALL USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── pam_thread_summaries ─────────────────────────────────────
CREATE POLICY "pam_thread_summaries_all" ON public.pam_thread_summaries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── pam_messages ─────────────────────────────────────────────
CREATE POLICY "pam_messages_all" ON public.pam_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.pam_threads t
      WHERE t.id = thread_id AND t.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.workspaces w ON w.id = p.workspace_id
      WHERE p.id = project_id AND w.owner_id = auth.uid()
    )
  );

-- ── project_reminders ────────────────────────────────────────
CREATE POLICY "reminders_all" ON public.project_reminders
  FOR ALL USING (user_id = auth.uid());

-- ── user_api_keys ────────────────────────────────────────────
CREATE POLICY "api_keys_all" ON public.user_api_keys
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── provider_models ── anyone can read, only service role writes
CREATE POLICY "provider_models_read" ON public.provider_models
  FOR SELECT USING (true);

-- ── user_plans ───────────────────────────────────────────────
CREATE POLICY "plans_select" ON public.user_plans
  FOR SELECT USING (auth.uid() = user_id);
-- All writes come from service role only (triggers + API routes)

-- ── user_wallets ─────────────────────────────────────────────
CREATE POLICY "wallets_select" ON public.user_wallets
  FOR SELECT USING (auth.uid() = user_id);
-- All writes come from service role only

-- ── wallet_transactions ──────────────────────────────────────
CREATE POLICY "tx_select" ON public.wallet_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- ── gem_purchases ────────────────────────────────────────────
CREATE POLICY "gem_purchases_select" ON public.gem_purchases
  FOR SELECT USING (auth.uid() = user_id);

-- ── prompt_templates ─────────────────────────────────────────
CREATE POLICY "templates_all" ON public.prompt_templates
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── admin_logs ── admins only ────────────────────────────────
CREATE POLICY "admin_logs_admin" ON public.admin_logs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.user_plans
      WHERE user_id = auth.uid() AND is_admin = true
    )
  );

-- ── memory_chunks ────────────────────────────────────────────
CREATE POLICY "memory_chunks_all" ON public.memory_chunks
  FOR ALL USING (user_id = auth.uid());

-- ============================================================
-- SECTION 5: GRANTS
-- ── Table-level grants for authenticated and anon roles ──────
-- These are required even when RLS is enabled.
-- Schema-level GRANT USAGE is not sufficient.
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- Future tables will also get grants automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon;

-- Service role needs full access for API routes
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ============================================================
-- SECTION 6: FUNCTIONS & TRIGGERS
-- ============================================================

-- ── Auto-provision user_plans + user_wallets on signup ───────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_plans (user_id, plan, status, projects_limit)
  VALUES (NEW.id, 'free', 'active', 2)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_wallets (
    user_id, gems, coins,
    daily_coins_limit, max_coins_banked, gems_monthly_grant
  )
  VALUES (NEW.id, 0, 50, 50, 200, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Auto-assign project head on project creation ─────────────
CREATE OR REPLACE FUNCTION public.assign_project_head()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace_owner uuid;
BEGIN
  SELECT owner_id INTO workspace_owner
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  INSERT INTO public.project_members (project_id, user_id, role, invite_status)
  VALUES (NEW.id, workspace_owner, 'head', 'accepted')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_project_created ON public.projects;
CREATE TRIGGER on_project_created
  AFTER INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.assign_project_head();

-- ── Enforce project member limit (8 total: 1 head + 7) ───────
CREATE OR REPLACE FUNCTION public.enforce_member_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.project_members
    WHERE project_id = NEW.project_id
      AND invite_status != 'declined'
  ) >= 8 THEN
    RAISE EXCEPTION 'Project member limit reached (7 members + 1 head)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_member_limit ON public.project_members;
CREATE TRIGGER trg_enforce_member_limit
  BEFORE INSERT ON public.project_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_limit();

-- ── PAM: auto-title thread + increment message count ─────────
CREATE OR REPLACE FUNCTION public.pam_auto_title()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'user' AND (
    SELECT COUNT(*) FROM public.pam_messages
    WHERE thread_id = NEW.thread_id AND role = 'user'
  ) = 1 THEN
    UPDATE public.pam_threads
    SET title = LEFT(NEW.content, 60)
    WHERE id = NEW.thread_id AND title IS NULL;
  END IF;

  UPDATE public.pam_threads
  SET
    message_count   = message_count + 1,
    last_message_at = NOW()
  WHERE id = NEW.thread_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pam_message_after_insert ON public.pam_messages;
CREATE TRIGGER pam_message_after_insert
  AFTER INSERT ON public.pam_messages
  FOR EACH ROW EXECUTE FUNCTION public.pam_auto_title();

-- ── Semantic search RPC ──────────────────────────────────────
CREATE OR REPLACE FUNCTION match_memory_chunks (
  query_embedding  vector(1536),
  match_threshold  float,
  match_count      int,
  p_project_id     uuid,
  p_source_types   text[] DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  source_type text,
  source_path text,
  similarity  float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mc.id,
    mc.content,
    mc.source_type,
    mc.source_path,
    1 - (mc.embedding <=> query_embedding) AS similarity
  FROM public.memory_chunks mc
  WHERE mc.project_id = p_project_id
    AND (mc.embedding <=> query_embedding) < 1 - match_threshold
    AND (p_source_types IS NULL OR mc.source_type = ANY(p_source_types))
  ORDER BY mc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── Admin & economy RPCs (folded from 0037-0038) ─────────────
-- A5: atomic plan upgrade/downgrade (user_plans + user_wallets in one tx)
CREATE OR REPLACE FUNCTION public.admin_set_plan(
  p_user_id uuid,
  p_plan    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_plan = 'pro' THEN
    UPDATE user_plans
       SET plan = 'pro', status = 'active', projects_limit = 999,
           updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE user_wallets
       SET daily_coins_limit = 200, max_coins_banked = 500,
           gems_monthly_grant = 100, updated_at = now()
     WHERE user_id = p_user_id;
  ELSIF p_plan = 'free' THEN
    UPDATE user_plans
       SET plan = 'free', status = 'active', projects_limit = 2,
           stripe_subscription_id = NULL, updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE user_wallets
       SET daily_coins_limit = 50, max_coins_banked = 200,
           gems_monthly_grant = 0, updated_at = now()
     WHERE user_id = p_user_id;
  ELSE
    RAISE EXCEPTION 'admin_set_plan: unknown plan "%"', p_plan;
  END IF;
END;
$$;

-- A1: atomic user deletion via cascade (deletes auth.users row; everything
-- user-owned cascades from it, directly or via workspaces -> projects)
CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

-- Atomic wallet increment (admin add_coins / add_gems) — avoids read-then-write TOCTOU
CREATE OR REPLACE FUNCTION public.increment_wallet_field(
  p_user_id uuid,
  p_field    text,
  p_amount   integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_field = 'coins' THEN
    UPDATE user_wallets
    SET coins      = coins + p_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_field = 'gems' THEN
    UPDATE user_wallets
    SET gems       = gems + p_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    RAISE EXCEPTION 'increment_wallet_field: unknown field "%"', p_field;
  END IF;
END;
$$;

-- Atomic template use_count increment (templates/use)
CREATE OR REPLACE FUNCTION public.increment_template_use_count(p_template_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE prompt_templates
  SET use_count  = use_count + 1,
      updated_at = now()
  WHERE id = p_template_id;
$$;

-- Platform-wide wallet balance aggregate (admin stats)
CREATE OR REPLACE FUNCTION public.sum_wallet_balances()
RETURNS TABLE(total_coins bigint, total_gems bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(coins), 0)::bigint AS total_coins,
    COALESCE(SUM(gems),  0)::bigint AS total_gems
  FROM user_wallets;
$$;

-- ============================================================
-- SECTION 7: BACKFILL EXISTING USERS
-- (Safe no-op if empty; creates missing plan/wallet rows)
-- ============================================================

INSERT INTO public.user_plans (user_id, plan, status, projects_limit)
SELECT id, 'free', 'active', 2
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_wallets (
  user_id, gems, coins,
  daily_coins_limit, max_coins_banked, gems_monthly_grant
)
SELECT id, 0, 50, 50, 200, 0
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- Backfill project heads for existing projects
INSERT INTO public.project_members (project_id, user_id, role, invite_status)
SELECT p.id, w.owner_id, 'head', 'accepted'
FROM public.projects p
JOIN public.workspaces w ON p.workspace_id = w.id
ON CONFLICT DO NOTHING;

-- ============================================================
-- SECTION 8: MODEL SEED DATA (2026-verified IDs)
-- All model_ids verified against provider APIs as of May 2026.
-- rate_limit_rpm / rate_limit_rpd = per-user limits.
-- ============================================================

TRUNCATE public.provider_models;

INSERT INTO public.provider_models
  (provider, model_id, model_name, label, is_free, enabled, tier_required,
   cost_coins, cost_gems, sort_order, rate_limit_rpm, rate_limit_rpd)
VALUES
  -- ── Groq (free tier) ────────────────────────────────────
  ('groq','llama-3.1-8b-instant',                          'Llama 3.1 8B',    'Llama 3.1 8B (Groq)',         true,  true,'free',1,NULL, 1,30,14400),
  ('groq','llama-3.3-70b-versatile',                       'Llama 3.3 70B',   'Llama 3.3 70B (Groq)',        true,  true,'free',2,NULL, 2,30,14400),
  ('groq','meta-llama/llama-4-scout-17b-16e-instruct',     'Llama 4 Scout',   'Llama 4 Scout ⚡',            true,  true,'free',2,NULL, 3,30,14400),
  ('groq','meta-llama/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick','Llama 4 Maverick (Groq)',     true,  true,'free',3,NULL, 4,30,14400),
  ('groq','moonshotai/kimi-k2-instruct',                   'Kimi K2',         'Kimi K2 (Groq)',              true,  true,'free',3,NULL, 5,30,14400),
  ('groq','qwen/qwen3-32b',                                'Qwen3 32B',       'Qwen3 32B (Groq)',            true,  true,'free',2,NULL, 6,30,14400),

  -- ── Cerebras (ultra-fast — free tier) ───────────────────
  ('cerebras','llama3.1-8b',                    'Llama 3.1 8B', 'Llama 3.1 8B (Cerebras) ⚡', true,true,'free',1,NULL,11,30,14400),
  ('cerebras','llama3.3-70b',                   'Llama 3.3 70B','Llama 3.3 70B (Cerebras) ⚡',true,true,'free',2,NULL,12,30,14400),
  ('cerebras','llama-4-scout-17b-16e-instruct', 'Llama 4 Scout','Llama 4 Scout (Cerebras) ⚡',true,true,'free',2,NULL,13,30,14400),
  ('cerebras','gpt-oss-120b',                   'GPT-OSS 120B', 'GPT-OSS 120B (Cerebras) ⚡', true,true,'free',3,NULL,14,30,14400),

  -- ── SambaNova (free tier) ───────────────────────────────
  ('sambanova','Meta-Llama-3.3-70B-Instruct',        'Llama 3.3 70B',      'Llama 3.3 70B (SN)',       true,true,'free',2,NULL,21,10,1000),
  ('sambanova','Llama-4-Maverick-17B-128E-Instruct',  'Llama 4 Maverick',   'Llama 4 Maverick (SN)',    true,true,'free',3,NULL,22,10,1000),
  ('sambanova','DeepSeek-V3.2',                       'DeepSeek V3.2',      'DeepSeek V3.2 (SN)',       true,true,'free',3,NULL,23,10,1000),
  ('sambanova','DeepSeek-R1-Distill-Llama-70B',       'DeepSeek R1 Distill','DeepSeek R1 Distill (SN)', true,true,'free',3,NULL,24,10,1000),

  -- ── OpenRouter (free :free suffix — 2026 verified) ──────
  ('openrouter','meta-llama/llama-3.3-70b-instruct:free','Llama 3.3 70B',   'Llama 3.3 70B (OR)',   true,true,'free',2,NULL,31,20,9999),
  ('openrouter','meta-llama/llama-4-maverick:free',      'Llama 4 Maverick', 'Llama 4 Maverick (OR)',true,true,'free',2,NULL,32,20,9999),
  ('openrouter','deepseek/deepseek-chat-v3.1:free',      'DeepSeek V3.1',   'DeepSeek V3.1 (OR)',    true,true,'free',2,NULL,33,20,9999),
  ('openrouter','deepseek/deepseek-r1:free',             'DeepSeek R1',     'DeepSeek R1 (OR)',      true,true,'free',2,NULL,34,20,9999),
  ('openrouter','qwen/qwen3-235b-a22b:free',             'Qwen3 235B',      'Qwen3 235B (OR)',       true,true,'free',2,NULL,35,20,9999),
  ('openrouter','google/gemma-3-12b-it:free',            'Gemma 3 12B',     'Gemma 3 12B (OR)',      true,true,'free',1,NULL,36,20,9999),

  -- ── Gemini (free quota) ─────────────────────────────────
  ('gemini','gemini-2.0-flash','Gemini 2.0 Flash','Gemini 2.0 Flash',true,true,'free',1,NULL,41,15,1500),
  ('gemini','gemini-2.5-flash','Gemini 2.5 Flash','Gemini 2.5 Flash',true,true,'free',2,NULL,42,15,1500),

  -- ── Anthropic (pro — gems) ──────────────────────────────
  ('anthropic','claude-haiku-4-5-20251001', 'Claude Haiku 4.5','Claude Haiku 4.5',   false,true,'pro',NULL,3,101,5,200),
  ('anthropic','claude-3-5-haiku-20241022', 'Claude 3.5 Haiku','Claude 3.5 Haiku ⚡',false,true,'pro',NULL,3,102,5,200),
  ('anthropic','claude-3-5-sonnet-20241022','Claude 3.5 Sonnet','Claude 3.5 Sonnet', false,true,'pro',NULL,5,103,5,200),
  ('anthropic','claude-sonnet-4-20250514',  'Claude Sonnet 4', 'Claude Sonnet 4',    false,true,'pro',NULL,6,104,5,200),

  -- ── Gemini (pro — gems) ─────────────────────────────────
  ('gemini','gemini-2.5-pro','Gemini 2.5 Pro','Gemini 2.5 Pro',false,true,'pro',NULL,5,111,5,200),

  -- ── OpenAI (pro — gems) ─────────────────────────────────
  ('openai','gpt-4o-mini','GPT-4o Mini','GPT-4o Mini ⚡',false,true,'pro',NULL,3,121,5,200),
  ('openai','gpt-4o',     'GPT-4o',    'GPT-4o',        false,true,'pro',NULL,6,122,5,200),
  ('openai','gpt-4.1',    'GPT-4.1',   'GPT-4.1',       false,true,'pro',NULL,6,123,5,200),

  -- ── Mistral (pro — gems) ────────────────────────────────
  ('mistral','codestral-latest',    'Codestral',    'Codestral (Code)',false,true,'pro',NULL,4,131,5,200),
  ('mistral','mistral-small-latest','Mistral Small','Mistral Small',  false,true,'pro',NULL,3,132,5,200),
  ('mistral','mistral-large-latest','Mistral Large','Mistral Large',  false,true,'pro',NULL,6,133,5,200)

ON CONFLICT (provider, model_id) DO UPDATE
  SET label          = EXCLUDED.label,
      model_name     = EXCLUDED.model_name,
      is_free        = EXCLUDED.is_free,
      enabled        = EXCLUDED.enabled,
      tier_required  = EXCLUDED.tier_required,
      cost_coins     = EXCLUDED.cost_coins,
      cost_gems      = EXCLUDED.cost_gems,
      sort_order     = EXCLUDED.sort_order,
      rate_limit_rpm = EXCLUDED.rate_limit_rpm,
      rate_limit_rpd = EXCLUDED.rate_limit_rpd;

-- ============================================================
-- SECTION 9: GRANT ADMIN TO OWNER ACCOUNT
-- Replace UUID below with your actual Supabase auth user ID
-- ============================================================

UPDATE public.user_plans
  SET is_admin = true
  WHERE user_id = 'c8152b0c-5182-4e8b-8c7f-3b689902ccd6';

-- ============================================================
-- SECTION 10: VERIFY
-- ============================================================

SELECT
  t.table_name,
  (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS col_count
FROM information_schema.tables t
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
ORDER BY t.table_name;

SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT COUNT(*) AS model_count FROM public.provider_models;
SELECT COUNT(*) AS admin_count FROM public.user_plans WHERE is_admin = true;
