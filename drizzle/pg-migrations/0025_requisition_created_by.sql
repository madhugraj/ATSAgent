-- 0025_requisition_created_by.sql — who raised each requisition.
--
-- Agents act on behalf of a human principal (docs/agentic-plan.md §6.1); for
-- event-triggered work on a requisition that principal is the member who
-- raised it. Existing rows stay null (the orchestrator falls back to the
-- member whose action triggered the event).
--
-- Idempotent: re-running is a no-op.

alter table requisitions
  add column if not exists created_by uuid references users (id) on delete set null;
