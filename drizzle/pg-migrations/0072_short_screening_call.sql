-- Screening calls are planned at 3 minutes (screening call 1.8.0, 10 November 2026):
-- phone_screening_settings.max_minutes is now the call's planned length. The
-- assistant is told to close 30 s before it and the call is ended a minute after
-- it. 2-30 is allowed so saved values stay valid; the app uses at most 5.
-- Idempotent.
alter table phone_screening_settings
  drop constraint if exists phone_screening_settings_max_minutes_check;
alter table phone_screening_settings
  add constraint phone_screening_settings_max_minutes_check check (max_minutes between 2 and 30);
alter table phone_screening_settings alter column max_minutes set default 3;
