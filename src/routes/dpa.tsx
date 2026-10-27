import { createFileRoute } from "@tanstack/react-router";

import { AgreementPage } from "@/components/LegalPage";

export const Route = createFileRoute("/dpa")({
  head: () => ({
    meta: [
      { title: "Data Processing Agreement — ATSIQ by Yavar AI" },
      {
        name: "description",
        content:
          "How Yavar AI processes personal data as processor for organisations using ATSIQ: scope, instructions, security measures, sub-processor categories, data-subject requests, retention and breaches.",
      },
      { property: "og:title", content: "Data Processing Agreement — ATSIQ by Yavar AI" },
      { property: "og:description", content: "Processor terms for organisations using ATSIQ." },
      { property: "og:type", content: "article" },
      { property: "og:url", content: "https://atsiq.yavar.ai/dpa" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://atsiq.yavar.ai/dpa" }],
  }),
  component: Dpa,
});

function Dpa() {
  return <AgreementPage kind="dpa" />;
}
