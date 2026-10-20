-- 0041_requisition_work_mode.sql — where the work happens: onsite, hybrid or
-- remote. Asked for by the hiring desk, set by the Requisition agent, and
-- shown with the location in the job description and job-board posts
-- ("Chennai (Hybrid)"). Null for roles raised before this existed.
--
-- Idempotent: re-running is a no-op.

alter table requisitions add column if not exists work_mode text;
do $$ begin
  alter table requisitions add constraint requisitions_work_mode_check
    check (work_mode is null or work_mode in ('onsite', 'hybrid', 'remote'));
exception when duplicate_object then null; end $$;
