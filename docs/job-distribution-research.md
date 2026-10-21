# Job distribution — how each portal can be reached (verified 2026-10-21)

How ATSIQ can advertise a role on 14 job portals and get applications back.
Each claim was checked against the portal's own employer, partner, developer
or terms pages on 21 October 2026. **Confirmed** means it was read on an
official page; **Uncertain** means it was inferred, came from a third party,
or the official page could not be read. Re-verify before relying on anything
marked uncertain — partner programmes and pricing change often.

The product reads this as `src/lib/job-channels.ts` (one catalogue for the
requisition page, the Job distribution page, tracked apply links and the
reports). Update both together.

**Ground rule.** Every portal's terms forbid scraping, crawlers and automated
logins. ATSIQ never logs into a portal or reads a portal's CV database on a
customer's behalf. The only routes are open standards, feeds, approved
partner APIs, and a person posting by hand.

## Summary

| #   | Portal              | Posting route                                                                                                                                                   | Cost / approval                                                              | How applications come back                                                                                                                                | Status                                                 | ATSIQ route                                 |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| 1   | Google for Jobs     | JobPosting structured data on our apply page + Indexing API (200 publish requests/day per project)                                                              | Free; Search Console site verification                                       | Candidates apply on our apply page                                                                                                                        | Confirmed                                              | Structured data (phase 1)                   |
| 2   | Jora                | XML/JSON feed. **Stopped direct posting 17 Aug 2026; Australia only since 9 Sep 2026**                                                                          | Free; registered by contact form                                             | Redirect to our apply page                                                                                                                                | Confirmed                                              | Feed (phase 1)                              |
| 3   | Jooble              | XML feed by support ticket or form; paid PPC from about $200                                                                                                    | Feed submission free (not stated explicitly); PPC optional                   | Redirect, or Jooble e-mails applicant details to the feed's `email`                                                                                       | Confirmed                                              | Feed (phase 1)                              |
| 4   | Adzuna              | Free XML feed; sponsored ads; Easy Apply for partner ATSs                                                                                                       | Feed free; Easy Apply via partnerships team                                  | Redirect; Easy Apply delivers into partner ATSs (no public spec)                                                                                          | Confirmed (spec from 2020 copy)                        | Feed (phase 1); Easy Apply later            |
| 5   | LinkedIn Jobs       | **Job Posting API closed to new partners.** Basic Jobs XML feed needs approval (2–8 weeks), paying verified customers only                                      | Basic free; promoted pay-per-click                                           | Feed: redirect. Apply Connect (partner-only; customer needs Recruiter licence) POSTs applications to our webhook                                          | Confirmed                                              | Post by hand now; apply for partnership     |
| 6   | Indeed              | **Job Sync API** (GraphQL) under a Developer Agreement, about 6 weeks. Free single-source XML feeds stop listing free from 31 Mar 2026 when an ATS route exists | Integration cost unpublished; sponsored per click or per started application | Indeed Apply POSTs signed JSON to our endpoint; Disposition Sync mandatory                                                                                | Confirmed                                              | Post by hand now; apply for partnership     |
| 7   | Wellfound           | No public API; native sync only with Ashby, Greenhouse, Lever, Workable; every synced job reviewed by hand                                                      | Free posting; paid tiers from $135/seat/month                                | In Wellfound or a listed ATS                                                                                                                              | Confirmed                                              | Post by hand                                |
| 8   | Naukri              | **Partner API "Zwayam Amplify"** (Info Edge): create, update, refresh, unpublish jobs; pull applications (90 days, max 400 per job); push status                | Customer's paid Naukri plan + Naukri approval; API price unpublished         | Through the API. Status signals in near real time are mandatory; application data limited to that role, deleted when it closes; breach report within 72 h | Confirmed                                              | Post by hand now; partner API later         |
| 9   | TimesJobs           | Unknown — the site blocks automated reading and we did not work around it                                                                                       | Third-party figures only                                                     | Probably e-mail and dashboard                                                                                                                             | **Uncertain**                                          | Post by hand; ask sales about a feed or API |
| 10  | PlacementIndia      | Employer dashboard only; no API or feed                                                                                                                         | Free single post; packages about $200–700                                    | Dashboard, e-mail, SMS                                                                                                                                    | Confirmed                                              | Post by hand                                |
| 11  | Job Hai (Info Edge) | Recruiter app or dashboard only                                                                                                                                 | Free: 3 live jobs, 5 posts a month; paid credits                             | Candidates phone the employer; app dashboard                                                                                                              | **Uncertain** (pages timed out; read via search index) | Post by hand                                |
| 12  | WorkIndia           | Manual, paid; does not serve placement agencies                                                                                                                 | ₹2,350–11,000 plans                                                          | Phone calls, WhatsApp, dashboard                                                                                                                          | Confirmed                                              | Post by hand                                |
| 13  | Apna                | Manual credits; enterprise plan advertises "ATS integrations" and an API by sales deal (no public docs)                                                         | From ₹699 a post                                                             | Dashboard, CSV export, WhatsApp                                                                                                                           | Confirmed exists / details uncertain                   | Post by hand; enterprise deal later         |
| 14  | Internshala         | Manual; each listing reviewed; **help centre: applications cannot be sent to an outside ATS**                                                                   | Free: 1 listing/month; paid ₹2,999–89,999                                    | Internshala's own tracker; Excel export on paid plans                                                                                                     | Confirmed                                              | Post by hand                                |

## What phase 1 built

- **Google for Jobs** — `JobPosting` structured data rendered on the server on
  `/apply/<id>` when the organisation switches it on (Job distribution page)
  and the role is approved, complete and not excluded. Google is told through
  the Indexing API (`GOOGLE_INDEXING_CREDENTIALS`) within
  `GOOGLE_INDEXING_DAILY_LIMIT` per Pacific day, shared by all organisations.
- **Job feeds** — `/api/public/feeds/<token>/<jooble|adzuna|jora>`, one token
  per organisation (encrypted, replaceable, audited). A role appears only after
  the HR head adds it; roles hired for a client are never listed (aggregators
  accept direct-employer jobs only).
- **Tracked apply links** — `?src=<channel>`; only known channels are recorded,
  Google's `utm_source=google_jobs_apply` is recognised, anything else is the
  careers site.
- **Posting packs** — copy-ready text (contact details stripped) with a tracked
  link where the portal accepts one, the portal's steps, and "mark as posted" /
  "taken down" (audited).
- **Source report** — applicants per channel and how far they got.

## Business steps (not code)

- LinkedIn: partner application form — https://business.linkedin.com/talent-solutions/ats-partners/partner-application
- Indeed: partner form via https://docs.indeed.com/support/faq (Job Sync API, Indeed Apply)
- Naukri: Zwayam Amplify demo — opendoors@zwayam.com
- Apna: enterprise sales — https://employer.apna.co/apna-enterprise
- Adzuna: Easy Apply partnership — https://www.adzuna.com/hire/ats-integration/
- TimesJobs: ask sales whether a partner feed or API exists

## Sources

### Google for Jobs

- JobPosting structured data (updated 2026-09-08): https://developers.google.com/search/docs/appearance/structured-data/job-posting — required `datePosted`, `description`, `hiringOrganization`, `jobLocation`, `title`; Indexing API recommended over sitemaps; remove expired jobs by `validThrough`, 404/410 or removing markup; only employers provide `baseSalary`.
- Indexing API quickstart (updated 2026-10-16): https://developers.google.com/search/apis/indexing-api/v3/quickstart
- Quota (200 publish/day, free): https://developers.google.com/search/apis/indexing-api/v3/quota-pricing

### Jora

- Employer closed (updated 2026-09-22): https://support.jora.com/hc/en-us/articles/16818144682127-Jora-Employer-has-closed
- Closing outside Australia (updated 2026-10-11): https://support.jora.com/hc/en-us/articles/17112986994191-Why-is-Jora-closing-in-my-market
- XML feed (updated 2026-10-13): https://support.jora.com/hc/en-us/articles/13919677306383-Get-your-jobs-published-on-Jora-with-an-XML-feed
- Feed content requirements (updated 2026-08-11): https://support.jora.com/hc/en-us/articles/13919751300239-XML-Feed-content-requirements

### Jooble

- Publishing via ATS: https://help.jooble.org/en/support/solutions/articles/60000700159-can-i-publish-my-vacancies-via-ats-
- Ways to post: https://help.jooble.org/en/support/solutions/articles/60000037108
- Feed specification: https://jooble.org/files/xml_feed_specifications.pdf
- PPC: https://jooble.org/partner/ppc
- Posting terms (effective 2026-10-30): https://help.jooble.org/en/support/solutions/articles/60001485518-terms-of-job-posting-and-content-requirements

### Adzuna

- Job listings: https://www.adzuna.com/hire/products/job-listings/
- ATS integration / Easy Apply: https://www.adzuna.com/hire/ats-integration/
- XML specification (archived, "Last updated: June 2020"): https://www.adzuna.co.uk/jobs/xml-specification.html
- Developer API is search-only: https://developer.adzuna.com/overview

### LinkedIn

- Job Posting API (closed to new partners; updated 2026-06-03): https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview
- Apply Connect (updated 2026-09-09): https://learn.microsoft.com/en-us/linkedin/talent/apply-connect/apply-connect-overview
- Basic Jobs XML feeds: https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds and https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-faq
- Feed guidelines (updated 2025-12-03): https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-job-posting-guidelines
- Partner application: https://business.linkedin.com/talent-solutions/ats-partners/partner-application

### Indeed

- Job Sync API: https://docs.indeed.com/job-sync-api/ and https://docs.indeed.com/job-sync-api/integrate-with-job-sync-api (updated 2026-10-07)
- Single-source feed policy (31 Mar 2026): https://www.indeed.com/help/employers/articles/single-source-feed-policy-effective-march-31-2026?hl=en&co=US
- Indeed Apply: https://docs.indeed.com/indeed-apply/ and https://docs.indeed.com/indeed-apply/ats
- Pricing (updated 2026-05-01): https://www.indeed.com/hire/resources/howtohub/how-pricing-works-on-indeed

### Wellfound

- ATS setup: https://help.wellfound.com/article/729-how-to-set-up-ats
- Job sync review: https://help.wellfound.com/article/746-how-do-i-sync-new-jobs
- Pricing: https://wellfound.com/recruit/pricing

### Naukri

- Zwayam Amplify docs: https://developers.zwayam.com/amplify/zwayam-amplify (changelog updated 2026-10-13)
- Applications (90-day window): https://developers.zwayam.com/amplify/zwayam-amplify/applications/get-applications-for-a-job
- Terms, §10 Resdex and §13 Naukri Apply Integration: https://www.naukri.com/termsconditions
- Job posting plans: https://www.naukri.com/recruit/job-posting

### TimesJobs

- https://www.timesjobs.com/ — not readable by automated tools; nothing confirmed.

### PlacementIndia

- Employers: https://www.placementindia.com/job-recruiters/
- Packages: https://www.placementindia.com/job-recruiters/advertise/recruitment-packages.htm
- Terms: https://www.placementindia.com/terms-recruiter.htm

### Job Hai

- https://employer.jobhai.com/hire, https://employer.jobhai.com/hire/recruiter-faqs, https://www.jobhai.com/terms (timed out; read via search index)

### WorkIndia

- Pricing: https://www.workindia.in/pricing/
- Terms: https://www.workindia.in/terms/

### Apna

- Pricing: https://employer.apna.co/pricing
- Enterprise: https://employer.apna.co/apna-enterprise
- Terms (updated 2025-12-21): https://apna.co/terms-of-service

### Internshala

- No ATS integration: https://internshala.com/employer/help_center_faq/16/15
- Plans: https://internshala.com/employer-premium-plans/
- Terms: https://internshala.com/terms/
