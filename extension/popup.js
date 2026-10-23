const $ = (id) => document.getElementById(id);
// Capture posts carry the org's capture key — the destination must be one of
// ours. Never let the destination become user-editable text (phishing vector).
const ALLOWED_SITES = ["https://atsiq.yavar.ai", "http://localhost:8080", "http://localhost:9000"];
const status = (msg, cls = "") => {
  const el = $("status");
  el.textContent = msg;
  el.className = cls;
};

chrome.storage.local.get(["site", "token", "kind", "pace"], (saved) => {
  $("site").value = saved.site || "https://atsiq.yavar.ai";
  $("token").value = saved.token || "";
  $("kind").value = saved.kind || "cv";
  $("pace").value = saved.pace || "safe";
});

$("save").addEventListener("click", () => {
  chrome.storage.local.set(
    {
      site: $("site").value.trim(),
      token: $("token").value.trim(),
      kind: $("kind").value,
      pace: $("pace").value,
    },
    () => status("Settings saved.", "ok"),
  );
});

async function grabPage() {
  const main = document.querySelector("main") || document.body;
  const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

  const urls = [];
  const add = (u) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  for (const a of document.querySelectorAll("a[href], a[download]")) {
    const href = a.href || "";
    const label = (a.innerText || a.getAttribute("aria-label") || "").toLowerCase();
    if (!href) continue;
    if (/\.(pdf|docx?|txt|rtf)(\?|$)/i.test(href)) add(href);
    else if (/download|resume|cv/.test(label) && /linkedin|licdn|ambry|dms/i.test(href)) add(href);
    else if (/ambry|dms-|media-proxy|attachment|resume/i.test(href) && /licdn|linkedin/i.test(href))
      add(href);
  }
  for (const el of document.querySelectorAll("iframe[src], embed[src], object[data]")) {
    add(el.getAttribute("src") || el.getAttribute("data") || "");
  }

  let resume = null;
  for (const raw of urls.slice(0, 8)) {
    try {
      const u = new URL(raw, location.href).href;
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!/pdf|msword|officedocument|octet-stream|text\/plain/.test(ct)) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 800 || bytes.length > 6000000) continue;
      let bin = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk)
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      const stem = decodeURIComponent(u.split("?")[0].split("/").pop() || "resume");
      const ext = /\.(pdf|docx?|txt|rtf)$/i.test(stem)
        ? ""
        : ct.includes("word") || ct.includes("officedocument")
          ? ".docx"
          : ".pdf";
      resume = { filename: `${stem}${ext}`, content: btoa(bin) };
      break;
    } catch {
      /* try the next link */
    }
  }

  return { text, title: document.title || null, url: location.href, resume };
}

function settings() {
  const requested = $("site").value.trim().replace(/\/$/, "");
  const site = ALLOWED_SITES.includes(requested) ? requested : "https://atsiq.yavar.ai";
  const token = $("token").value.trim();
  return { site, token };
}

/* ------------------------------------------------------- single page capture */

$("send").addEventListener("click", async () => {
  const { site, token } = settings();
  const kind = $("kind").value;
  if (!site || !token) return status("Add your ATSIQ address and capture key first.", "err");

  chrome.storage.local.set({ site, token, kind });
  $("send").disabled = true;
  status("Reading this page…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPage,
    });
    if (!result || (!result.resume && result.text.length < 80))
      throw new Error("There was not enough readable text on this page.");

    // Deep read: open every tab and collapsed block on this page and follow its
    // own inner detail pages, so nothing is missed when no CV is attached.
    status("Reading every tab and section on this page…");
    const deepRes = await chrome.runtime
      .sendMessage({ type: "deepRead", tabId: tab.id })
      .catch(() => null);
    const deepText = deepRes?.ok ? deepRes.deep?.text : null;
    if (deepText && deepText.length > (result.text?.length ?? 0)) result.text = deepText;

    if (result.resume) status("Found the attached CV — sending it across…");

    const res = await fetch(`${site}/api/public/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        kind,
        text: result.text || null,
        title: result.title,
        sourceUrl: result.url,
        ...(kind === "cv" && result.resume ? { file: result.resume } : {}),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.detail) || `Capture failed (${res.status}).`);
    status(body.detail || "Sent to ATSIQ.", body.status === "error" ? "err" : "ok");
  } catch (e) {
    status(e.message || "Capture failed.", "err");
  } finally {
    $("send").disabled = false;
  }
});

/* ---------------------------------------------------------------- the sweep */

function paint(run) {
  const running = Boolean(run?.running);
  $("start").style.display = running ? "none" : "block";
  $("stop").style.display = running ? "block" : "none";
  const total = run?.total ?? 0;
  const index = run?.index ?? 0;
  $("cProg").textContent = `${index}/${total}`;
  $("cFiled").textContent = String(run?.imported ?? 0);
  $("cSkip").textContent = String((run?.skipped ?? 0) + (run?.failed ?? 0));
  $("bar").style.width = total ? `${Math.round((index / total) * 100)}%` : "0";
  $("runNote").textContent = [run?.current, run?.note].filter(Boolean).join(" — ");
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "status" });
    paint(res?.run);
  } catch {
    /* worker asleep with no run in flight */
  }
}

$("start").addEventListener("click", async () => {
  const { site, token } = settings();
  const pace = $("pace").value;
  if (!site || !token) return status("Add your ATSIQ address and capture key first.", "err");
  chrome.storage.local.set({ site, token, pace });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return status("Open your applicant list first.", "err");

  const res = await chrome.runtime.sendMessage({
    type: "start",
    payload: { site, token, pace, tabId: tab.id, captureJd: $("jd").checked },
  });
  if (!res?.ok) return status(res?.error || "The sweep could not start.", "err");
  status("Sweep running — you can close this window.", "ok");
  void refresh();
});

$("stop").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "stop" });
  if (!res?.ok) return status("The sweep could not be stopped.", "err");
  status("Sweep stopped.", "ok");
  await refresh();
});

void refresh();
setInterval(refresh, 1200);

/* ------------------------------------------------- posting on job portals */

// Portals people post on by hand that the companion supports so far.
const PORTALS = [
  { channel: "internshala", name: "Internshala", hosts: ["internshala.com"] },
  { channel: "apna", name: "Apna", hosts: ["apna.co"] },
];
const postStatus = (msg, cls = "") => {
  const el = $("postStatus");
  el.textContent = msg;
  el.style.color = cls === "err" ? "#b42318" : cls === "ok" ? "#027a48" : "";
};
let portal = null;
let queue = [];

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function distribution(body) {
  const { site, token } = settings();
  if (!token) throw new Error("Add your capture key and save settings first.");
  const res = await fetch(`${site}/api/public/distribution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.status !== "ok") throw new Error(out.detail || "ATSIQ did not accept that.");
  return out;
}

async function loadPortal() {
  const tab = await activeTab();
  let host = "";
  try {
    host = new URL(tab.url || "").hostname.toLowerCase();
  } catch {
    return;
  }
  portal = PORTALS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null;
  if (!portal) return;
  $("post").style.display = "";
  $("portalName").textContent = portal.name;
  try {
    const out = await distribution({ action: "queue", channel: portal.channel });
    queue = out.roles || [];
    $("role").innerHTML = "";
    for (const r of queue) {
      const o = document.createElement("option");
      o.value = r.requisitionId;
      o.textContent = `${r.code} · ${r.title} — ${r.status === "posted" ? "posted" : "waiting"}`;
      $("role").appendChild(o);
    }
    postStatus(
      queue.length
        ? `${queue.filter((r) => r.status === "waiting").length} role(s) waiting to be posted on ${portal.name}.`
        : `Nothing is planned for ${portal.name} yet — the Distribution agent plans roles here.`,
    );
  } catch (e) {
    postStatus(e.message, "err");
  }
}

const chosen = () => queue.find((r) => r.requisitionId === $("role").value);

$("fill").addEventListener("click", async () => {
  const role = chosen();
  if (!role) return postStatus("Choose a role first.", "err");
  try {
    const tab = await activeTab();
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["portal-fill.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (fields, name) => globalThis.atsiqFillForm(fields, name),
      args: [role.fields, portal.name],
    });
    postStatus(
      result.filled.length
        ? `Filled ${result.filled.length} field(s). Check the form, then submit it on ${portal.name}.`
        : "No fields recognised on this page — use the Copy buttons in the panel on the page.",
      result.filled.length ? "ok" : "",
    );
  } catch (e) {
    postStatus(e.message || "Could not fill this page.", "err");
  }
});

$("recordPosted").addEventListener("click", async () => {
  const role = chosen();
  if (!role) return postStatus("Choose a role first.", "err");
  const tab = await activeTab();
  try {
    await distribution({
      action: "posted",
      channel: portal.channel,
      requisitionId: role.requisitionId,
      listingUrl: tab.url,
    });
    postStatus(`Recorded: ${role.code} is live on ${portal.name}.`, "ok");
    await loadPortal();
  } catch (e) {
    postStatus(e.message, "err");
  }
});

$("sendApplicant").addEventListener("click", async () => {
  const role = chosen();
  if (!role) return postStatus("Choose a role first.", "err");
  const { site, token } = settings();
  try {
    const tab = await activeTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPage,
    });
    if (!result || (!result.resume && result.text.length < 80))
      throw new Error("Open one applicant's profile or CV first.");
    const res = await fetch(`${site}/api/public/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        kind: "cv",
        text: result.text,
        file: result.resume,
        sourceUrl: result.url,
        title: result.title,
        requisitionId: role.requisitionId,
        channel: portal.channel,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.detail || "ATSIQ did not accept that.");
    postStatus(out.detail || "Sent.", "ok");
  } catch (e) {
    postStatus(e.message, "err");
  }
});

// After the saved address and key are back in the form (the read above runs first).
chrome.storage.local.get(null, () => loadPortal());
