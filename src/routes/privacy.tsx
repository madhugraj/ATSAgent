import { createFileRoute } from "@tanstack/react-router";

import { AgreementPage } from "@/components/LegalPage";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — ATSIQ by Yavar AI" },
      {
        name: "description",
        content:
          "How Yavar AI collects, uses, stores and protects recruiter and candidate data inside the ATSIQ applicant tracking platform, and the rights available to data subjects.",
      },
      { property: "og:title", content: "Privacy Policy — ATSIQ by Yavar AI" },
      {
        property: "og:description",
        content:
          "Data collection, purpose, retention, sharing and data-subject rights for the ATSIQ platform.",
      },
      { property: "og:type", content: "article" },
      { property: "og:url", content: "https://atsiq.yavar.ai/privacy" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://atsiq.yavar.ai/privacy" }],
  }),
  component: Privacy,
});

function Privacy() {
  return <AgreementPage kind="privacy" />;
}
