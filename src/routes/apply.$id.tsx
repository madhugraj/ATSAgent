import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, MapPin, Upload } from "lucide-react";
import { useState } from "react";

import { BrandFooter, BrandLogo } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { publicJob, submitApplication, type PublicJob } from "@/lib/apply.functions";
import { extractResumeText } from "@/lib/cv-extract";

/** Where the link was shared: ?src=<channel>, or Google's utm_source. */
type ApplySearch = { src?: string | undefined; utm_source?: string | undefined };

export const Route = createFileRoute("/apply/$id")({
  validateSearch: (search: Record<string, unknown>): ApplySearch => ({
    src: typeof search["src"] === "string" ? search["src"].slice(0, 60) : undefined,
    utm_source:
      typeof search["utm_source"] === "string" ? search["utm_source"].slice(0, 60) : undefined,
  }),
  // Loaded on the server so the page (and Google's structured data) is in the HTML.
  loader: async ({ params }): Promise<PublicJob | null> => {
    try {
      return await publicJob({ data: { requisitionId: params.id } });
    } catch {
      return null;
    }
  },
  head: ({ loaderData }) => {
    const title = loaderData
      ? `${loaderData.title}${loaderData.company ? ` — ${loaderData.company}` : ""}`
      : "Apply for this role — ATSIQ by Yavar AI";
    return {
      scripts: loaderData?.jsonLd
        ? [{ type: "application/ld+json", children: loaderData.jsonLd }]
        : [],
      meta: [
        { title },
        {
          name: "description",
          content:
            "Upload your CV to apply. Your details are read automatically and shared with the hiring team for this role.",
        },
        { property: "og:title", content: title },
        { property: "og:description", content: "Upload your CV and apply in under a minute." },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
      ],
    };
  },
  component: ApplyPage,
});

function ApplyPage() {
  const { id } = Route.useParams();
  const { src, utm_source } = Route.useSearch();
  const submit = useServerFn(submitApplication);
  const j = Route.useLoaderData();

  const [file, setFile] = useState<File | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; already: boolean } | null>(null);

  async function send() {
    if (!file) {
      setError("Please attach your CV as a PDF or Word file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resumeText = await extractResumeText(file);
      const res = await submit({
        data: {
          requisitionId: id,
          fileName: file.name,
          resumeText: resumeText.slice(0, 60000),
          email: email.trim() || null,
          fullName: fullName.trim() || null,
          phone: phone.trim() || null,
          source: src ?? null,
          utmSource: utm_source ?? null,
        },
      });
      setDone({ name: res.name, already: res.alreadyApplied });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <BrandLogo />
          <span className="text-xs text-muted-foreground">Careers</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10">
        {!j ? (
          <div className="panel p-6">
            <h1 className="text-lg font-semibold">This job link is not valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The link may have expired. Please check the original post for an up-to-date link.
            </p>
          </div>
        ) : done ? (
          <div className="panel p-6">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="size-5" />
              <h1 className="text-lg font-semibold">
                {done.already ? "Your application is updated" : "Application received"}
              </h1>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Thank you{done.name ? `, ${done.name.split(" ")[0]}` : ""}. Your CV has been read and
              shared with the hiring team for{" "}
              <span className="font-medium text-foreground">{j.title}</span>. If your profile fits,
              a recruiter will contact you by email.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs font-medium uppercase tracking-wide text-primary">
              {j.company ? `${j.company} · ` : ""}We are hiring
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{j.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              {j.location ? (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-4" /> {j.location}
                </span>
              ) : null}
              <span>
                {j.experienceMin}–{j.experienceMax} years experience
              </span>
              <span>
                {j.openings} opening{j.openings === 1 ? "" : "s"}
              </span>
            </div>

            {j.mustHave.length ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {j.mustHave.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                  >
                    {s}
                  </span>
                ))}
                {j.goodToHave.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
                  >
                    {s}
                  </span>
                ))}
              </div>
            ) : null}

            {j.description || j.responsibilities ? (
              <p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {(j.description ?? j.responsibilities ?? "")
                  .replace(/^#{1,6}\s+/gm, "")
                  .replace(/\*\*(.+?)\*\*/g, "$1")}
              </p>
            ) : null}

            {!j.open ? (
              <div className="panel mt-8 p-6">
                <h2 className="font-semibold">Applications are closed</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  This role is not accepting applications at the moment.
                </p>
              </div>
            ) : (
              <section className="panel mt-8 p-6">
                <h2 className="font-semibold">Apply with your CV</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Attach a PDF or Word CV — your name, contact details, skills and experience are
                  read automatically, so there is no long form to fill in.
                </p>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label htmlFor="cv">Your CV</Label>
                    <label
                      htmlFor="cv"
                      className="mt-1.5 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm hover:border-primary/50"
                    >
                      <Upload className="size-4 text-primary" />
                      <span className={file ? "font-medium" : "text-muted-foreground"}>
                        {file ? file.name : "Choose a PDF or .docx file"}
                      </span>
                    </label>
                    <input
                      id="cv"
                      type="file"
                      className="hidden"
                      accept=".pdf,.docx,.txt"
                      onChange={(e) => {
                        setFile(e.target.files?.[0] ?? null);
                        setError(null);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="name">Full name (optional)</Label>
                    <Input
                      id="name"
                      className="mt-1.5"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Read from your CV if left blank"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">Email (optional)</Label>
                    <Input
                      id="email"
                      type="email"
                      className="mt-1.5"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Read from your CV if left blank"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone (optional)</Label>
                    <Input
                      id="phone"
                      className="mt-1.5"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
                </div>

                {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}

                <div className="mt-5 flex items-center gap-3">
                  <Button onClick={send} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {busy ? "Sending…" : "Submit application"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    By applying you agree to us storing your CV for this hiring process. Your CV may
                    be screened with the help of AI; a human reviewer makes every decision, and you
                    can ask about or contest an AI-assisted evaluation — see our{" "}
                    <a href="/privacy" className="underline">
                      privacy policy
                    </a>
                    .
                  </span>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <BrandFooter />
    </div>
  );
}
