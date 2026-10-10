# Local database runbook

Development uses a local PostgreSQL that behaves like production: same major
version (Cloud SQL `POSTGRES_14`), password authentication, and backups that
are verified and can be restored. One script manages it:
`scripts/local-db.sh` (`bun run db:local <command>`).

| Command | What it does |
| --- | --- |
| `init` | Creates the cluster in a durable per-user folder, a random superuser password (scram-sha-256, kept in `~/.pgpass` and the gitignored `.env.local`), the `atsagent` and `atsagent_test` databases, and runs every migration on both. |
| `start` / `stop` / `status` | Runs the server on `127.0.0.1:54377` only. `status` shows the data folder and the latest backups. |
| `migrate` | Applies pending migrations to both databases. |
| `backup` | Compressed `pg_dump` of `atsagent`, read back with `pg_restore --list` before it counts; keeps the newest 14. |
| `restore FILE` | Needs `ATSAGENT_RESTORE_CONFIRM=atsagent`; backs up the current database first, restores into a scratch database, then swaps it in. |
| `schedule-backups` / `unschedule-backups` | A daily backup (13:00) through launchd on macOS (cron line printed elsewhere). |

Where things live (macOS; Linux uses `$XDG_DATA_HOME/atsagent`):

- data: `~/Library/Application Support/ATSAgent/postgres-14`
- backups: `~/Library/Application Support/ATSAgent/backups`
- server log: `~/Library/Application Support/ATSAgent/postgres.log`

The script refuses a data folder under `/tmp`, `/var/tmp` or `/var/folders`.

Tests run only against `atsagent_test` (the suites delete their own records,
and `integration.verify` truncates everything) — never against `atsagent`.

## Incident 2026-10-10: development database lost

- **What happened:** the development cluster had been started by hand with
  its data folder in `/tmp/atsagent-smoke-pg`. macOS removes old files from
  `/tmp`; overnight it deleted most of the cluster's files and every
  connection failed with `could not open file "global/pg_filenode.map"`.
  The server had no password and there was no backup, so the development
  data (test organisations, requisitions, desk threads) was not recoverable.
  Production and CI were not affected (CI builds its own database).
- **Fix:** `scripts/local-db.sh` — durable folder (temporary folders
  refused), password auth on 127.0.0.1, verified daily backups with
  rotation, a confirmed restore, and CI moved from Postgres 16 to 14 to
  match production.
- **After a rebuild:** re-create the organisation, re-enter its AI provider
  key on Integrations (keys are encrypted with this environment's secret and
  are never copied between databases), and replay any demo data needed.
