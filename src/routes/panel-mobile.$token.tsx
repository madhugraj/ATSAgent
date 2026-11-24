import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Phone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPanelistMobile, savePanelistMobile } from "@/lib/panelist-mobile.functions";

export const Route = createFileRoute("/panel-mobile/$token")({
  head: () => ({
    meta: [{ title: "Your mobile number" }, { name: "robots", content: "noindex" }],
  }),
  component: PanelMobilePage,
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-md place-items-center px-6 py-12">
      <div className="panel w-full space-y-4 p-8">{children}</div>
    </main>
  );
}

function PanelMobilePage() {
  const { token } = Route.useParams();
  const load = useServerFn(getPanelistMobile);
  const save = useServerFn(savePanelistMobile);
  const q = useQuery({
    queryKey: ["panelist_mobile", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });
  const [phone, setPhone] = useState("");
  const [noCalls, setNoCalls] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (q.isLoading)
    return (
      <Shell>
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </Shell>
    );
  if (q.isError || !q.data)
    return (
      <Shell>
        <p className="text-sm">This link is not valid. Please contact the hiring team.</p>
      </Shell>
    );
  const c = q.data;
  if (done)
    return (
      <Shell>
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" /> {done}
        </p>
      </Shell>
    );
  const submit = async () => {
    setBusy(true);
    try {
      const r = await save({
        data: { token, phone: noCalls ? null : phone, aiCalls: !noCalls },
      });
      setDone(noCalls ? "Saved. You will not get AI calls." : `Saved — ••${r.phoneLast4}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <h1 className="flex items-center gap-2 text-base font-semibold">
        <Phone className="h-4 w-4" /> Hi {c.firstName}
      </h1>
      <p className="text-sm text-muted-foreground">
        {c.orgName}&apos;s AI assistant calls you when an interview time is waiting on your answer.
      </p>
      {c.phoneLast4 ? <p className="text-sm">On file: ••{c.phoneLast4}</p> : null}
      <Input
        placeholder="Mobile number"
        inputMode="tel"
        maxLength={30}
        value={phone}
        disabled={noCalls}
        onChange={(e) => setPhone(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={noCalls} onChange={(e) => setNoCalls(e.target.checked)} />
        Don&apos;t call me
      </label>
      <Button
        className="w-full"
        disabled={busy || (!noCalls && phone.trim().length < 10)}
        onClick={submit}
      >
        Save
      </Button>
    </Shell>
  );
}
