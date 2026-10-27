import { createFileRoute } from "@tanstack/react-router";

import { AgreementPage } from "@/components/LegalPage";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — ATSIQ by Yavar AI" },
      {
        name: "description",
        content:
          "The terms on which organisations and their users use the ATSIQ applicant tracking platform: workspaces, responsibilities for candidate data, AI features and acceptable use.",
      },
      { property: "og:title", content: "Terms of Service — ATSIQ by Yavar AI" },
      {
        property: "og:description",
        content:
          "Workspaces, candidate-data responsibilities, AI features and acceptable use on ATSIQ.",
      },
      { property: "og:type", content: "article" },
      { property: "og:url", content: "https://atsiq.yavar.ai/terms" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://atsiq.yavar.ai/terms" }],
  }),
  component: Terms,
});

function Terms() {
  return <AgreementPage kind="terms" />;
}
