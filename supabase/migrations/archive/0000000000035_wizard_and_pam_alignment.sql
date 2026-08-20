-- Migration 0035: Wizard & PAM alignment
-- Adds all columns that wizard/chat and pam/summarise routes need but that
-- were absent from the post-reset schema used by existing databases.
-- Every statement is idempotent (IF NOT EXISTS / ON CONFLICT).
-- Safe to re-run against any DB state.

-- ── wizard_sessions ──────────────────────────────────────────────────────────
-- The wizard/chat route reads and writes all of these columns.
-- Missing any one causes PGRST204 500s on every chat turn.

ALTER TABLE public.wizard_sessions
  ADD COLUMN IF NOT EXISTS stage              text NOT NULL DEFAULT 'idea',
  ADD COLUMN IF NOT EXISTS stage_data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_stages   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS confirmed_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_idea     text,
  ADD COLUMN IF NOT EXISTS selected_stack     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS stack_options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS target_audience    text,
  ADD COLUMN IF NOT EXISTS generation_status  text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS generation_step    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error         text;

-- ── pam_threads ──────────────────────────────────────────────────────────────
-- pam/summarise marks threads as summarised to avoid re-summarising.

ALTER TABLE public.pam_threads
  ADD COLUMN IF NOT EXISTS summarised boolean NOT NULL DEFAULT false;

-- ── pam_thread_summaries ─────────────────────────────────────────────────────
-- Stores compressed thread summaries used as cross-thread PAM memory.

CREATE TABLE IF NOT EXISTS public.pam_thread_summaries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  thread_id  uuid NOT NULL REFERENCES public.pam_threads(id) ON DELETE CASCADE,
  summary    text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.pam_thread_summaries ENABLE ROW LEVEL SECURITY;

-- Owner of the project can manage summaries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pam_thread_summaries'
      AND policyname = 'pam_thread_summaries_all'
  ) THEN
    CREATE POLICY "pam_thread_summaries_all" ON public.pam_thread_summaries
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM public.projects p
          JOIN public.workspaces w ON w.id = p.workspace_id
          WHERE p.id = project_id AND w.owner_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pam_thread_summaries_project
  ON public.pam_thread_summaries(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pam_thread_summaries_thread
  ON public.pam_thread_summaries(thread_id);

-- Ensure authenticated role has access to the new table
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.pam_thread_summaries TO authenticated;
GRANT ALL ON public.pam_thread_summaries TO service_role;
