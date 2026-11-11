-- Pay terms, Phase 4 (docs/pay-terms-plan.md, 11 November 2026): an offer is
-- written in its role's pay currency and basis, carries its kind of work and,
-- for a contract, its end date; the exchange rate to the organisation's
-- reporting currency is fixed when the offer is approved. Existing offers are
-- backfilled from their requisition (today: INR, annual, permanent).
-- Idempotent.
alter table offers add column if not exists currency text not null default 'INR';
alter table offers add column if not exists pay_basis text not null default 'annual';
alter table offers add column if not exists kind_of_work text not null default 'permanent';
alter table offers add column if not exists contract_end date;
alter table offers add column if not exists reporting_amount numeric(16,2);
alter table offers add column if not exists reporting_currency text;
alter table offers add column if not exists rate jsonb;
alter table offers add column if not exists rate_locked_at timestamptz;
alter table offers drop constraint if exists offers_currency_check;
alter table offers add constraint offers_currency_check check (currency ~ '^[A-Z]{3}$');
alter table offers drop constraint if exists offers_pay_basis_check;
alter table offers add constraint offers_pay_basis_check check (pay_basis in ('annual','monthly','daily','hourly'));

update offers o
   set currency = r.pay_currency, pay_basis = r.pay_basis, kind_of_work = r.kind_of_work
  from applications a join requisitions r on r.id = a.requisition_id
 where a.id = o.application_id
   and o.org_id = a.org_id
   and (o.currency, o.pay_basis, o.kind_of_work) is distinct from (r.pay_currency, r.pay_basis, r.kind_of_work);
