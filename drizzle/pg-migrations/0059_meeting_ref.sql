-- 0059_meeting_ref.sql — silent panel agents, step S0
-- (docs/silent-panel-agent-plan.md).
--
-- * interviews.meeting_provider / meeting_external_id: which provider a
--   round's meeting is on and the reference its API needs to fetch the call's
--   transcript afterwards (Zoom meeting id, Meet meeting code, Teams join
--   link). Read from the join link when the round is booked
--   (src/lib/meeting-ref.ts); null for in-person rounds and unknown links.
-- * Existing rounds are backfilled from their link by the same rules.
--
-- Idempotent: re-running is a no-op.

alter table interviews add column if not exists meeting_provider text;
alter table interviews add column if not exists meeting_external_id text;
do $$ begin
  alter table interviews add constraint interviews_meeting_provider_check
    check (meeting_provider is null or meeting_provider in ('zoom', 'google_meet', 'teams'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table interviews add constraint interviews_meeting_ref_check
    check ((meeting_provider is null) = (meeting_external_id is null));
exception when duplicate_object then null; end $$;

update interviews
   set meeting_provider = 'zoom',
       meeting_external_id = substring(btrim(teams_link) from '^https?://[^/]*/(?:j|w|s)/([0-9]{9,12})(?:/|\?|#|$)')
 where meeting_provider is null
   and btrim(teams_link) ~* '^https?://([a-z0-9-]+\.)*zoom(gov)?\.(us|com)/(j|w|s)/[0-9]{9,12}(/|\?|#|$)';

update interviews
   set meeting_provider = 'google_meet',
       meeting_external_id = lower(substring(btrim(teams_link) from '(?i)^https?://meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:/|\?|#|$)'))
 where meeting_provider is null
   and btrim(teams_link) ~* '^https?://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(/|\?|#|$)';

update interviews
   set meeting_provider = 'teams',
       meeting_external_id = btrim(teams_link)
 where meeting_provider is null
   and btrim(teams_link) ~* '^https?://teams\.(microsoft|live)\.com/(l/meetup-join|meet)/';
