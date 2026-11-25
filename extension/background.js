/**
 * Guided applicant sweep.
 *
 * Runs in the recruiter's own signed-in browser, at human pace. From the
 * applicant list they already have open it first sends the job description
 * across (so the role exists in ATSIQ), then works through each applicant in
 * the applicant queue by profile URL, understands the active profile, and grabs
 * the attached resume file itself (the same
 * file the Download button gives) and posts it to ATSIQ, where it is parsed,
 * de-duplicated, matched and scored. It never signs in, stores no credentials,
 * and stops the moment the recruiter presses Stop.
 */

const DEFAULT_LIMIT = 40;
const HARD_LIMIT = 100;
const MAX_PAGES = 10;
/** Where the sweep reads people from. Only applicants carry a CV file. */
const SOURCES = ["applicants", "recommended", "search"];
const PACE = {
  safe: [7000, 13000],
  balanced: [3000, 6000],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo));

async function stopRequested() {
  const state = await getRun();
  return !state || Boolean(state.stop);
}

/** Wait in short intervals so Stop is noticed without waiting for the full pace delay. */
async function interruptibleSleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await stopRequested()) return false;
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return true;
}

async function getRun() {
  const { run } = await chrome.storage.local.get("run");
  return run ?? null;
}

async function setRun(patch) {
  const run = (await getRun()) ?? {};
  const next = { ...run, ...patch };
  await chrome.storage.local.set({ run: next });
  return next;
}

/* --------------------------------------------------------------- page work */

function readPage() {
  const pick = (sel) => document.querySelector(sel);
  const main = pick("main") || pick("article") || pick("[role=main]") || document.body;
  const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, title: document.title || null, url: location.href };
}

function inspectActiveProfile(expectedName) {
  const clean = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  const normalise = (value) =>
    clean(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const namesMatch = (left, right) => {
    const a = normalise(left);
    const b = normalise(right);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const aTokens = new Set(a.split(" ").filter((token) => token.length > 1));
    const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
    const smaller = aTokens.size <= bTokens.size ? aTokens : bTokens;
    const larger = smaller === aTokens ? bTokens : aTokens;
    return smaller.size >= 2 && [...smaller].every((token) => larger.has(token));
  };
  const expected = normalise(expectedName);
  const main = document.querySelector("main, [role=main]") || document.body;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const headings = [...main.querySelectorAll('h1, h2, h3, [role="heading"]')]
    .filter(visible)
    .map((el) => clean(el.innerText || el.textContent))
    .filter((value) => value.length >= 3 && value.length <= 140)
    .filter(
      (value) =>
        !/notifications? total|profile activity|row decorations|linkedin recruiter|highlights for this project|most recent activity/i.test(
          value,
        ),
    );
  const headingName = headings.find((value) => expected && namesMatch(value, expected)) || null;
  const publicAnchors = [
    ...main.querySelectorAll(
      'a[href*="linkedin.com/in/"], a[href*="/in/"], a[href*="public-profile"]',
    ),
  ].filter(visible);
  const profileContainers = [...main.querySelectorAll("header, section, article, div")]
    .filter(visible)
    .filter((el) => publicAnchors.some((anchor) => el.contains(anchor)))
    .filter((el) => !expected || namesMatch(el.innerText, expected))
    .sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
  const header = profileContainers[0] || publicAnchors[0]?.closest("header, section, article, div");
  const headerLines = clean(header?.innerText).split(/\n+/).map(clean).filter(Boolean);
  const headerName = headerLines.find((value) => {
    return expected && namesMatch(value.replace(/\s*[·|].*$/, ""), expected);
  });
  const candidateName = headingName || headerName?.replace(/\s*[·|].*$/, "").trim() || null;
  const publicAnchor =
    header?.querySelector(
      'a[href*="linkedin.com/in/"], a[href*="/in/"], a[href*="public-profile"]',
    ) || publicAnchors[0];
  const publicHref = publicAnchor?.href || null;
  const redirectTarget = publicHref
    ? new URL(publicHref, location.href).searchParams.get("url") ||
      new URL(publicHref, location.href).searchParams.get("redirect")
    : null;
  const publicProfileUrl = (redirectTarget || publicHref)?.split(/[?#]/)[0] || null;
  const text = (main.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  const headerMatchesExpected = Boolean(
    expected && header && namesMatch(header.innerText, expected),
  );
  const candidateMatchesExpected = Boolean(
    expected && candidateName && namesMatch(candidateName, expected),
  );
  const identityConfirmed = Boolean(
    candidateName && (!expected || headerMatchesExpected || candidateMatchesExpected),
  );
  return {
    ready: Boolean(candidateName && text.length > 200),
    identityConfirmed,
    candidateName,
    publicProfileUrl,
    text,
    title: document.title || null,
    url: location.href,
  };
}

/**
 * One injected worker for everything to do with the applicant list, so the
 * same idea of "a row" is used to count, to scroll and to click.
 *
 * action: "names" | "click" | "scroll"
 */
function rowScan(action, arg) {
  const mid = window.innerWidth / 2;

  const qualifies = (el) => {
    const r = el.getBoundingClientRect();
    if (r.height < 55 || r.height > 460) return false;
    if (r.width < 180 || r.width > mid + 240) return false;
    if (r.left > mid + 60) return false;
    const t = (el.innerText || "").trim();
    if (t.length < 15 || t.length > 1400) return false;
    if (!t.includes("\n")) return false;
    const hasProfile = Boolean(el.querySelector('a[href*="/talent/profile"], a[href*="/in/"]'));
    const looksApplicant =
      hasProfile ||
      Boolean(el.querySelector("img")) ||
      /applied|·\s*\d(?:st|nd|rd)|qualification|maybe|good fit|not a fit/i.test(t);
    return looksApplicant;
  };

  const found = [];
  for (const el of document.querySelectorAll("li, div, article, tr")) {
    if (qualifies(el)) found.push(el);
  }
  // keep only the innermost matches, so a wrapper around the whole list is dropped
  const rows = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));

  const nameOf = (el) => {
    const lines = (el.innerText || "")
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return (lines[0] || "").replace(/\s*·.*$/, "").slice(0, 120);
  };

  if (action === "names") {
    const seen = new Set();
    const out = [];
    for (const el of rows) {
      const n = nameOf(el);
      if (n.length < 3 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  if (action === "click") {
    const want = String(arg || "").toLowerCase();
    const head = want.slice(0, 18);
    const el =
      rows.find((r) => nameOf(r).toLowerCase() === want) ||
      rows.find((r) => nameOf(r).toLowerCase().startsWith(head));
    if (!el) return { ok: false };
    el.scrollIntoView({ block: "center" });
    const target =
      el.querySelector('a[href*="/talent/"], a[href*="/in/"], a[href], button, [role="button"]') ||
      el;
    target.click();
    return { ok: true, name: nameOf(el) };
  }

  if (action === "scroll") {
    let node = rows[0] || null;
    while (node && !(node.scrollHeight > node.clientHeight + 40)) node = node.parentElement;
    const target = node || document.scrollingElement || document.body;
    const before = target.scrollTop;
    target.scrollTop = before + Math.max(300, target.clientHeight * 0.85);
    return { moved: target.scrollTop > before };
  }

  return null;
}

/**
 * Read the applicant currently on screen AND pull the attached resume file the
 * page links to, using the recruiter's own session cookies. Only the detail
 * active profile is read, so recommendation cards can never bleed into one
 * person's record.
 */
async function grabApplicant(expectedName) {
  const normalise = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const usableName = (value) => {
    const clean = String(value || "")
      .replace(/\s*[|–-]\s*(LinkedIn|Recruiter).*$/i, "")
      .trim();
    if (clean.length < 3 || clean.length > 120) return null;
    if (/notifications? total|profile activity|row decorations|linkedin recruiter/i.test(clean))
      return null;
    return clean;
  };
  const candidateName = usableName(expectedName) || usableName(document.title);
  const wanted = normalise(candidateName);
  const main =
    document.querySelector("main") || document.querySelector("[role=main]") || document.body;
  const candidates = [...main.querySelectorAll("section, article, div")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const value = normalise(el.innerText);
      return (
        r.width >= 420 &&
        r.height >= 300 &&
        (!wanted || value.includes(wanted)) &&
        /summary|experience|highlights for this project|attachments?/.test(value)
      );
    })
    .sort((a, b) => a.innerText.length - b.innerText.length);
  const scope = candidates[0] || main;
  const text = (scope.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  const publicAnchor = [
    ...scope.querySelectorAll(
      'a[href*="linkedin.com/in/"], a[href*="/in/"], a[href*="public-profile"]',
    ),
    ...main.querySelectorAll(
      'a[href*="linkedin.com/in/"], a[href*="/in/"], a[href*="public-profile"]',
    ),
  ].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const publicHref = publicAnchor?.href || null;
  const redirectTarget = publicHref
    ? new URL(publicHref, location.href).searchParams.get("url") ||
      new URL(publicHref, location.href).searchParams.get("redirect")
    : null;
  const publicProfileUrl = (redirectTarget || publicHref)?.split(/[?#]/)[0] || null;

  const urls = [];
  const add = (u) => {
    if (u && !urls.includes(u)) urls.push(u);
  };

  const linkScope = scope.querySelector("a[href], iframe[src]") ? scope : document;
  for (const a of linkScope.querySelectorAll("a[href], a[download]")) {
    const href = a.href || "";
    const label = (a.innerText || a.getAttribute("aria-label") || "").toLowerCase();
    if (!href) continue;
    if (/\.(pdf|docx?|txt|rtf)(\?|$)/i.test(href)) add(href);
    else if (/download|resume|cv/.test(label) && /linkedin|licdn|ambry|dms/i.test(href)) add(href);
    else if (/ambry|dms-|media-proxy|attachment|resume/i.test(href) && /licdn|linkedin/i.test(href))
      add(href);
  }
  for (const el of linkScope.querySelectorAll("iframe[src], embed[src], object[data]")) {
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
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const stem = decodeURIComponent(u.split("?")[0].split("/").pop() || "resume");
      const ext = /\.(pdf|docx?|txt|rtf)$/i.test(stem)
        ? ""
        : ct.includes("word") || ct.includes("officedocument")
          ? ".docx"
          : ".pdf";
      resume = { filename: `${stem}${ext}`, content: btoa(bin) };
      break;
    } catch {
      /* try the next candidate link */
    }
  }

  return {
    text,
    title: document.title || null,
    url: location.href,
    resume,
    candidateName,
    publicProfileUrl,
  };
}

/** Rank attachment controls by file-row structure, not visible button text. */
function discoverResumeActions(expectedName) {
  const normalise = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const namesMatch = (left, right) => {
    const a = normalise(left);
    const b = normalise(right);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const aTokens = new Set(a.split(" ").filter((token) => token.length > 1));
    const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
    const smaller = aTokens.size <= bTokens.size ? aTokens : bTokens;
    const larger = smaller === aTokens ? bTokens : aTokens;
    return smaller.size >= 2 && [...smaller].every((token) => larger.has(token));
  };
  const wanted = normalise(expectedName);
  const main = document.querySelector("main, [role=main]") || document.body;
  if (wanted && !namesMatch(main.innerText, wanted)) {
    return {
      stage: "identity",
      error: `LinkedIn did not finish opening ${expectedName}`,
      actions: [],
    };
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const valueOf = (el) =>
    [
      el.innerText,
      el.textContent,
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-test-icon"),
      el.getAttribute("data-view-name"),
      el.querySelector("svg")?.getAttribute("aria-label"),
      el.querySelector("svg use")?.getAttribute("href"),
    ]
      .filter(Boolean)
      .join(" ");

  const tabs = [...main.querySelectorAll('[role="tab"], button, a')].filter(visible);
  const attachmentsTab = tabs.find((el) => /attachments?/i.test(valueOf(el)));
  const panelId = attachmentsTab?.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  const roots = [panel, main].filter(Boolean);
  const attachmentRows = [
    ...new Set(
      roots.flatMap((root) => [...root.querySelectorAll("li, tr, article, section, div")]),
    ),
  ]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const rawText = String(el.innerText || el.textContent || "");
      const text = normalise(rawText);
      return (
        visible(el) &&
        r.width >= 260 &&
        r.height >= 28 &&
        r.height <= 900 &&
        (/\.(?:pdf|docx?|rtf)\b/i.test(rawText) ||
          /\b(?:resume|curriculum vitae|cv)\b/.test(text) ||
          Boolean(
            el.querySelector('[data-test-icon*="document" i], [data-test-icon*="file" i]'),
          )) &&
        el.querySelector('button, a[href], [role="button"]')
      );
    })
    .filter((el, index, all) => {
      const ownFile = /\.(?:pdf|docx?|rtf)\b/i.test(String(el.innerText || el.textContent || ""));
      if (!ownFile) return false;
      const childFileRow = all.some(
        (other, i) =>
          i !== index &&
          el.contains(other) &&
          /\.(?:pdf|docx?|rtf)\b/i.test(String(other.innerText || other.textContent || "")) &&
          other.querySelector('button, a[href], [role="button"], [tabindex]'),
      );
      return !childFileRow;
    })
    .sort((a, b) => a.innerText.length - b.innerText.length);

  const actions = [];
  attachmentRows.slice(0, 8).forEach((row, rowIndex) => {
    const filename = (row.innerText || "").match(/[^\n]+\.(?:pdf|docx?|rtf)/i)?.[0]?.trim() || null;
    const structuralRow = (() => {
      let current = row;
      for (let depth = 0; depth < 5 && current?.parentElement; depth += 1) {
        const parent = current.parentElement;
        const parentText = String(parent.innerText || parent.textContent || "");
        if (!/\.(?:pdf|docx?|rtf)\b/i.test(parentText)) break;
        if (parent.getBoundingClientRect().height > 900) break;
        current = parent;
      }
      return current;
    })();
    const controls = [
      ...structuralRow.querySelectorAll(
        'a[href], button, [role="button"], [tabindex]:not([tabindex="-1"]), [data-view-name], [data-control-name]',
      ),
    ].filter(visible);
    controls.forEach((control, controlIndex) => {
      const semantic = valueOf(control).toLowerCase();
      const href = control.href || "";
      if (
        /preview|hide preview|open viewer/.test(semantic) ||
        control.getAttribute("aria-haspopup") === "menu"
      )
        return;
      let score = 0;
      if (control.hasAttribute("download")) score += 100;
      if (/download|save|arrow-down|download-small/.test(semantic)) score += 90;
      if (/licdn|linkedin|ambry|dms|media-proxy|attachment/.test(href)) score += 70;
      if (controlIndex === controls.length - 1) score += 45;
      if (!(control.innerText || "").trim() && control.querySelector("svg")) score += 20;
      if (!(control.innerText || "").trim() && controlIndex > 0) score += 20;
      if (score < 20) return;
      const token = `atsiq-${Date.now()}-${rowIndex}-${controlIndex}`;
      control.setAttribute("data-atsiq-download-token", token);
      actions.push({ token, score, filename, href: href || null });
    });
  });
  actions.sort((a, b) => b.score - a.score);
  return {
    stage: actions.length ? "ready" : attachmentRows.length ? "control" : "attachment",
    error: actions.length
      ? null
      : attachmentRows.length
        ? "CV attachment was found, but its download control could not be identified"
        : "No CV file row was found in Highlights, Attachments, or recent activity",
    actions,
    canOpenAttachments: Boolean(
      attachmentsTab && attachmentsTab.getAttribute("aria-selected") !== "true",
    ),
  };
}

/** When LinkedIn expands Preview instead of emitting a browser download, read the preview file. */
function discoverPreviewResumeUrls() {
  const urls = [];
  const add = (value) => {
    if (!value) return;
    try {
      const href = new URL(value, location.href).href;
      if (
        !urls.includes(href) &&
        /licdn|linkedin|ambry|dms|media-proxy|attachment|\.pdf|\.doc/i.test(href)
      ) {
        urls.push(href);
      }
    } catch {
      /* ignore malformed page URLs */
    }
  };
  for (const el of document.querySelectorAll("iframe[src], embed[src], object[data], a[href]")) {
    add(el.getAttribute("src") || el.getAttribute("data") || el.getAttribute("href"));
  }
  for (const entry of performance.getEntriesByType("resource")) add(entry.name);
  return urls.slice(-20).reverse();
}

/**
 * Deep read of the profile that is on screen: expand every collapsed block,
 * walk every tab on the record, then follow the profile's own inner detail
 * pages (experience, education, skills, certifications, projects,
 * recommendations, recent activity) in the recruiter's signed-in session.
 * Runs whether or not a CV is attached, so a missing file never costs the
 * written record.
 */
async function deepHarvestProfile(expectedName, publicProfileUrl) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (value) =>
    String(value || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const root = () => document.querySelector("main, [role=main]") || document.body;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el) =>
    [el.innerText, el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  const sections = [];
  const seen = new Set();
  const push = (name, body) => {
    const text = clean(body);
    if (text.length < 40) return;
    const key = text.slice(0, 500);
    if (seen.has(key)) return;
    seen.add(key);
    sections.push({ label: clean(name).slice(0, 60) || "Section", text });
  };

  /* 1. open everything that is collapsed */
  const EXPAND =
    /see more|show more|show all|see all|read more|…\s*more|\bmore\b|expand|view all|show \d+ more/i;
  const SKIP =
    /message|connect|follow|invite|save to|hide|show less|see less|feedback|report|download|attachments?/i;
  let expanded = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const controls = [
      ...root().querySelectorAll(
        'button, [role="button"], a[role="button"], [aria-expanded="false"]',
      ),
    ].filter(visible);
    let clicked = 0;
    for (const el of controls) {
      if (el.dataset?.atsiqExpanded) continue;
      const text = labelOf(el);
      if (SKIP.test(text)) continue;
      const wants = el.getAttribute("aria-expanded") === "false" || EXPAND.test(text);
      if (!wants) continue;
      if (el.dataset) el.dataset.atsiqExpanded = "1";
      try {
        el.click();
        clicked += 1;
        expanded += 1;
      } catch {
        /* control refused the click */
      }
      if (clicked >= 12) break;
    }
    if (!clicked) break;
    await pause(500);
  }

  /* 2. nudge lazy sections into the DOM */
  const scroller = document.scrollingElement || document.body;
  const home = scroller.scrollTop;
  for (let step = 1; step <= 6; step += 1) {
    scroller.scrollTop = (scroller.scrollHeight * step) / 6;
    await pause(250);
  }
  scroller.scrollTop = home;
  push("Profile", root().innerText);

  /* 3. every tab on the record */
  const tabs = [...root().querySelectorAll('[role="tab"], [data-test-tab], nav a')]
    .filter(visible)
    .filter((el) => {
      const text = labelOf(el);
      return text.length > 1 && text.length < 40;
    });
  const wasSelected = tabs.find((el) => el.getAttribute("aria-selected") === "true") || null;
  const visited = [];
  for (const tab of tabs.slice(0, 12)) {
    const name = labelOf(tab);
    try {
      tab.scrollIntoView({ block: "center" });
      tab.click();
    } catch {
      continue;
    }
    await pause(900);
    const panelId = tab.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    push(name, (panel || root()).innerText);
    visited.push(name);
  }
  if (wasSelected) {
    try {
      wasSelected.click();
    } catch {
      /* leaving the last tab open is harmless */
    }
    await pause(400);
  }

  /* 4. follow the profile's own inner detail pages */
  const WANTED =
    /\/details\/|\/overlay\/|recent-activity|\/skills|\/experience|\/education|\/certifications|\/courses|\/projects|\/publications|\/patents|\/recommendations|\/volunteering|\/honors/i;
  const inner = new Set();
  for (const anchor of [...root().querySelectorAll("a[href]")].filter(visible)) {
    try {
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && WANTED.test(url.pathname)) inner.add(url.href);
    } catch {
      /* malformed href */
    }
  }
  if (publicProfileUrl) {
    const base = String(publicProfileUrl).replace(/\/+$/, "");
    for (const part of [
      "experience",
      "education",
      "skills",
      "certifications",
      "projects",
      "publications",
      "recommendations",
      "courses",
    ]) {
      inner.add(`${base}/details/${part}/`);
    }
  }
  let followed = 0;
  for (const href of [...inner].slice(0, 14)) {
    try {
      const res = await fetch(href, { credentials: "include" });
      if (!res.ok) continue;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, style, noscript, svg").forEach((node) => node.remove());
      const scope = doc.querySelector("main, [role=main]") || doc.body;
      const name = new URL(href).pathname.split("/").filter(Boolean).slice(-2).join(" / ");
      push(name, scope?.innerText || scope?.textContent);
      followed += 1;
    } catch {
      /* inner page unavailable in this session */
    }
    await pause(250);
  }

  const text = sections
    .map((section) => `## ${section.label}\n${section.text}`)
    .join("\n\n")
    .slice(0, 380000);
  return {
    text,
    expanded,
    tabs: visited,
    followed,
    name: expectedName || null,
  };
}

function openAttachmentsTab() {
  const main = document.querySelector("main, [role=main]") || document.body;
  const tab = [...main.querySelectorAll('[role="tab"], button, a')].find((el) =>
    /attachments?/i.test(
      [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")]
        .filter(Boolean)
        .join(" "),
    ),
  );
  if (!tab) return false;
  tab.scrollIntoView({ block: "center" });
  tab.click();
  return true;
}

function clickMarkedResumeAction(token) {
  const target = document.querySelector(`[data-atsiq-download-token="${CSS.escape(token)}"]`);
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  target.click();
  return true;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Read an intercepted attachment URL inside LinkedIn's signed-in page. */
async function fetchResumeUrl(url, fallbackName) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`CV download returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 800 || bytes.length > 6000000)
    throw new Error("downloaded CV has an invalid size");
  const disposition = res.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let filename = encoded
    ? decodeURIComponent(encoded)
    : plain ||
      String(fallbackName || "")
        .split(/[\\/]/)
        .pop() ||
      "resume.pdf";
  if (!/\.(pdf|docx?|txt|rtf)$/i.test(filename)) {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    filename += ct.includes("word") || ct.includes("officedocument") ? ".docx" : ".pdf";
  }
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { filename, content: btoa(bin) };
}

/**
 * Recruiter uses a real Download button rather than an <a href>. Observe the
 * browser download it creates, cancel the local copy, then read that same
 * authenticated URL into the capture payload.
 */
async function waitForDownloadEvent(timeoutMs = 6500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (item) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onCreated.removeListener(listener);
      clearTimeout(timer);
      clearInterval(stopMonitor);
      resolve(item);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const stopMonitor = setInterval(() => {
      void stopRequested().then((stopped) => {
        if (stopped) finish(null);
      });
    }, 250);
    const listener = (item) => {
      if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;
      finish(item);
    };
    chrome.downloads.onCreated.addListener(listener);
  });
}

/**
 * Read an attachment URL from the extension's own context. LinkedIn's
 * attachment hosts send no CORS headers, so a page-context fetch of the
 * intercepted download URL is blocked even though the file is right there —
 * the extension has host permission for those hosts and is not.
 */
async function fetchResumeInBackground(url, fallbackName) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`CV download returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 800 || bytes.length > 6000000)
    throw new Error("downloaded CV has an invalid size");
  const disposition = res.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let filename = encoded
    ? decodeURIComponent(encoded)
    : plain ||
      String(fallbackName || "")
        .split(/[\\/]/)
        .pop() ||
      "resume.pdf";
  if (!/\.(pdf|docx?|txt|rtf)$/i.test(filename)) {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    filename += ct.includes("word") || ct.includes("officedocument") ? ".docx" : ".pdf";
  }
  return { filename, content: bytesToBase64(bytes) };
}

/** Try the signed-in page first, then the extension context (no CORS limits). */
async function readResumeUrl(tabId, url, fallbackName) {
  const viaPage = await run(tabId, fetchResumeUrl, [url, fallbackName]).catch(() => null);
  if (viaPage) return viaPage;
  return await fetchResumeInBackground(url, fallbackName).catch(() => null);
}

async function downloadResumeFromButton(tabId, expectedName) {
  let discovery = await run(tabId, discoverResumeActions, [expectedName]).catch(() => null);
  if (discovery?.canOpenAttachments && !discovery.actions?.length) {
    await run(tabId, openAttachmentsTab).catch(() => false);
    await sleep(900);
    discovery = await run(tabId, discoverResumeActions, [expectedName]).catch(() => null);
  }
  if (!discovery?.actions?.length) {
    throw new Error(
      `[${discovery?.stage || "attachment"}] ${discovery?.error || "CV attachment discovery failed"}`,
    );
  }

  const failures = [];
  for (const action of discovery.actions.slice(0, 4)) {
    if (action.href && /\.(pdf|docx?|rtf)(\?|$)/i.test(action.href)) {
      const direct = await readResumeUrl(tabId, action.href, action.filename);
      if (direct) return direct;
      failures.push("direct link unreadable");
    }
    const waiting = waitForDownloadEvent(12000);
    const clicked = await run(tabId, clickMarkedResumeAction, [action.token]).catch(() => false);
    if (!clicked) {
      await waiting;
      continue;
    }
    const created = await waiting;
    if (!created?.id) {
      await sleep(1200);
      const previewUrls = (await run(tabId, discoverPreviewResumeUrls).catch(() => [])) ?? [];
      for (const previewUrl of previewUrls) {
        const previewResume = await readResumeUrl(tabId, previewUrl, action.filename);
        if (previewResume) return previewResume;
      }
      failures.push("no browser download and no readable preview file");
      continue;
    }
    const url = created.finalUrl || created.url;
    // Read the same authenticated URL before releasing LinkedIn's own copy: a
    // cancelled item can invalidate the single-use attachment link.
    const resume = url ? await readResumeUrl(tabId, url, created.filename) : null;
    await chrome.downloads.cancel(created.id).catch(() => {});
    await chrome.downloads.erase({ id: created.id }).catch(() => {});
    if (resume) return resume;
    failures.push(url ? "attachment link refused the read" : "download carried no URL");
  }
  throw new Error(
    `[download] CV controls were tried, but LinkedIn did not deliver a readable file${
      failures.length ? ` (${[...new Set(failures)].join("; ")})` : ""
    }`,
  );
}

/** Collect applicant/profile links from a Recruiter list page. */
function collectApplicantLinks(source = "applicants") {
  const sourced = source !== "applicants";
  const out = [];
  const seen = new Set();
  const current = new URL(location.href);
  const currentProject = current.searchParams.get("project");
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    const recruiterProfile =
      /linkedin\.com\/talent\/(profile|hire\/[^/]+\/(?:discover|manage)(?:\/[^/?#]+)*\/profile)/i.test(
        href,
      );
    const publicProfile = /linkedin\.com\/in\//i.test(href);
    if (!recruiterProfile && !publicProfile) continue;
    const row = a.closest("li, tr, article, [role=row], [data-test-applicant-row]");
    if (publicProfile && !sourced) {
      const explicitApplicantRow = Boolean(
        row &&
        !row.closest("aside") &&
        (row.matches('[role="row"], [data-test-applicant-row], li, tr') ||
          /applicant|applied|qualification|good fit|not a fit|maybe/i.test(row.innerText || "")),
      );
      if (!explicitApplicantRow) continue;
    }
    const target = new URL(href, location.href);
    const targetProject = target.searchParams.get("project");
    if (currentProject && targetProject && targetProject !== currentProject) continue;
    if (recruiterProfile && currentProject && !targetProject) continue;
    if (publicProfile && sourced && (!row || row.closest("aside"))) continue;
    // On the applicant list, recommendation panels are someone else's list.
    if (
      !sourced &&
      /recommended|suggested|similar/i.test(a.closest("section, aside")?.innerText || "")
    )
      continue;
    const clean = href.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const candidates = [a.innerText || "", row?.innerText || ""]
      .flatMap((value) => value.split("\n"))
      .map((value) =>
        value
          .trim()
          .replace(/^view\s+/i, "")
          .replace(/\s+profile$/i, ""),
      )
      .filter(
        (value) =>
          value.length >= 3 &&
          value.length <= 120 &&
          !/^(profile|applicant|applied|view profile|profile activity row decorations)$/i.test(
            value,
          ) &&
          !/notifications? total|ago$|qualification|good fit|not a fit|maybe|pipeline|message/i.test(
            value,
          ),
      );
    const label = candidates[0] || null;
    out.push({ url: clean, label });
  }
  return out;
}

async function run(tabId, func, args = []) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result ?? null;
}

async function waitForTab(tabId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await stopRequested()) return false;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.status === "complete") return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

/* ------------------------------------------------------------------ upload */

async function send(site, token, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const stopMonitor = setInterval(() => {
    void stopRequested().then((stopped) => {
      if (stopped) controller.abort();
    });
  }, 250);
  try {
    const res = await fetch(`${site}/api/public/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, ...payload }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok)
      throw new Error((body && body.detail) || `ATSIQ refused the page (${res.status}).`);
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (await stopRequested()) throw new Error("Sweep stopped");
      throw new Error("ATSIQ did not respond within two minutes");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(stopMonitor);
  }
}

async function fileApplicant({
  site,
  token,
  page,
  requisitionId,
  candidateName,
  profileOnly = false,
  sourced = false,
}) {
  const payload = {
    kind: "cv",
    text: page.text && page.text.length > 80 ? page.text : null,
    title: page.title,
    sourceUrl: page.url,
    publicProfileUrl: page.publicProfileUrl || null,
    candidateName: candidateName || null,
    profileOnly,
    sourced,
    ...(page.resume ? { file: page.resume } : {}),
    ...(requisitionId ? { requisitionId } : {}),
  };
  return send(site, token, payload);
}

async function tally(result) {
  const ok =
    result?.status === "imported" || result?.status === "updated" || result?.status === "stored";
  const s = await getRun();
  await setRun({
    imported: (s?.imported ?? 0) + (ok ? 1 : 0),
    skipped: (s?.skipped ?? 0) + (ok ? 0 : 1),
    note: result?.detail ?? "",
  });
}

/**
 * Press the list's own "Next" page control, if there is one and it is enabled.
 * Returns the first profile link before the click so the caller can tell when
 * the new page has replaced the old one.
 */
function clickNextPage() {
  const controls = [
    ...document.querySelectorAll(
      'button[aria-label*="next" i], a[aria-label*="next" i], [data-test-pagination-next], button, a[role="button"]',
    ),
  ];
  const next = controls.find((el) => {
    const label = `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`.trim();
    if (!/^next\b|next page|\bnext$/i.test(label)) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!next) return { ok: false, marker: null };
  const marker =
    document.querySelector('a[href*="/talent/"][href*="/profile"], a[href*="linkedin.com/in/"]')
      ?.href || null;
  next.scrollIntoView({ block: "center" });
  next.click();
  return { ok: true, marker };
}

function firstProfileHref() {
  return (
    document.querySelector('a[href*="/talent/"][href*="/profile"], a[href*="linkedin.com/in/"]')
      ?.href || null
  );
}

const LIST_NAME = {
  applicants: "the applicant list",
  recommended: "recommended matches",
  search: "the search results",
};

/**
 * Walk LinkedIn's virtual list — and its following pages — retaining each
 * person's exact profile URL, up to the run's limit.
 */
async function gatherApplicantLinks(tabId, source = "applicants", limit = DEFAULT_LIMIT) {
  const links = [];
  const seen = new Set();
  const listName = LIST_NAME[source] || LIST_NAME.applicants;
  for (let page = 1; page <= MAX_PAGES && links.length < limit; page += 1) {
    for (let pass = 0; pass < 16 && links.length < limit; pass += 1) {
      if (await stopRequested()) return links;
      const batch = (await run(tabId, collectApplicantLinks, [source]).catch(() => [])) ?? [];
      let added = 0;
      for (const item of batch) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url);
        links.push(item);
        added += 1;
      }
      await setRun({
        note: `Reading ${listName}, page ${page} — ${links.length} found so far…`,
      });
      const scrolled = await run(tabId, rowScan, ["scroll"]).catch(() => null);
      if (!scrolled?.moved && added === 0) break;
      if (!(await interruptibleSleep(900))) return links;
    }
    if (links.length >= limit) break;
    const turned = await run(tabId, clickNextPage).catch(() => null);
    if (!turned?.ok) break;
    // Wait for the next page to replace this one, at human pace.
    let changed = false;
    for (let t = 0; t < 20; t += 1) {
      if (!(await interruptibleSleep(600))) return links;
      const first = await run(tabId, firstProfileHref).catch(() => null);
      if (first && first !== turned.marker) {
        changed = true;
        break;
      }
    }
    if (!changed) break;
    if (!(await interruptibleSleep(jitter([1500, 3000])))) return links;
  }
  return links.slice(0, limit);
}

/* -------------------------------------------------------------------- sweep */

async function sweep({ site, token, pace, tabId, captureJd, source, limit }) {
  let requisitionId = null;
  source = SOURCES.includes(source) ? source : "applicants";
  // Only applicants have a CV on LinkedIn; everyone else is a sourced profile.
  const sourced = source !== "applicants";
  limit = Math.min(HARD_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  // Use the Recruiter tab the HR user opened. LinkedIn changes its address to
  // the selected applicant, which makes the sweep visible and gives ATSIQ the
  // exact Recruiter profile link for every candidate.
  const workTabId = tabId;
  await chrome.tabs.update(workTabId, { active: true }).catch(() => {});

  if (captureJd) {
    await setRun({ note: "Sending the job description across…" });
    try {
      const page = await run(workTabId, readPage);
      if (page && page.text.length > 200) {
        const jd = await send(site, token, {
          kind: "jd",
          text: page.text,
          title: page.title,
          sourceUrl: page.url,
        });
        requisitionId = jd?.requisitionId ?? null;
        await setRun({ role: jd?.title ?? null });
      }
    } catch (e) {
      await setRun({ note: `Job description skipped — ${e.message}` });
    }
  }

  if (await stopRequested()) {
    await setRun({ running: false, note: "Stopped." });
    return;
  }

  // Keep exact profile URLs before leaving the virtualised applicant list. A
  // hard navigation per person prevents LinkedIn's previous detail panel (and
  // its CV button) from being reused for the next applicant.
  const queue = await gatherApplicantLinks(workTabId, source, limit);
  await setRun({
    total: queue.length,
    note: queue.length
      ? `${queue.length} ${sourced ? "profiles" : "applicants"} found — opening each profile directly…`
      : `No profile links were found on ${LIST_NAME[source]} — open it for one job and try again.`,
  });

  for (let i = 0; i < queue.length; i += 1) {
    const state = await getRun();
    if (!state || state.stop) {
      await setRun({ running: false, note: "Stopped." });
      return;
    }
    const item = queue[i];
    await setRun({ index: i + 1, current: item.label ?? "Applicant" });

    try {
      await chrome.tabs.update(workTabId, { url: item.url, active: true });
      const ready = await waitForTab(workTabId);
      if (!ready) throw new Error("[navigation] the page did not finish loading");
      let snapshot = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await stopRequested()) {
          await setRun({ running: false, note: "Stopped." });
          return;
        }
        snapshot = await run(workTabId, inspectActiveProfile, [item.label]).catch(() => null);
        if (snapshot?.ready && snapshot.identityConfirmed) break;
        if (!(await interruptibleSleep(500))) {
          await setRun({ running: false, note: "Stopped." });
          return;
        }
      }
      if (!snapshot?.ready)
        throw new Error("[navigation] the active profile did not finish rendering");
      if (!snapshot.identityConfirmed)
        throw new Error(
          `[identity] the opened profile did not match ${item.label || "the queued applicant"}`,
        );
      const page = await run(workTabId, grabApplicant, [item.label]);
      if (!page) throw new Error("[profile] applicant details could not be read");
      const candidateName = page.candidateName || item.label;
      if (!candidateName) throw new Error("the applicant name could not be confirmed");
      // Deep read: every tab, every collapsed block and the profile's own inner
      // detail pages, done before the CV step so a missing file never costs the
      // written record.
      await setRun({ note: `Reading every tab and section for ${candidateName}…` });
      const deep = await run(workTabId, deepHarvestProfile, [
        candidateName,
        page.publicProfileUrl || null,
      ]).catch(() => null);
      if (deep?.text && deep.text.length > (page.text?.length ?? 0)) page.text = deep.text;
      if (sourced) {
        // A sourced person has not applied and has no CV on LinkedIn: file the
        // profile text, marked as sourced, never as an application with a CV.
        page.resume = null;
        await tally(
          await fileApplicant({
            site,
            token,
            page,
            requisitionId,
            candidateName,
            profileOnly: true,
            sourced: true,
          }),
        );
      } else if (!page.resume) {
        try {
          page.resume = await downloadResumeFromButton(workTabId, candidateName);
        } catch (downloadError) {
          const retained = await fileApplicant({
            site,
            token,
            page,
            requisitionId,
            candidateName,
            profileOnly: true,
          });
          await tally(retained);
          await setRun({
            note: `${candidateName} — profile captured and analysed; CV pending because ${downloadError.message}.`,
          });
          if (
            i < queue.length - 1 &&
            !(await interruptibleSleep(jitter(PACE[pace] ?? PACE.safe)))
          ) {
            await setRun({ running: false, note: "Stopped." });
            return;
          }
          continue;
        }
      }
      if (!sourced)
        await tally(await fileApplicant({ site, token, page, requisitionId, candidateName }));
    } catch (e) {
      if (await stopRequested()) {
        await setRun({ running: false, note: "Stopped." });
        return;
      }
      const s = await getRun();
      await setRun({
        failed: (s?.failed ?? 0) + 1,
        note: `Skipped ${item.label || "one applicant"} — ${e.message}.`,
      });
    }

    if (await stopRequested()) {
      await setRun({ running: false, note: "Stopped." });
      return;
    }
    if (i < queue.length - 1 && !(await interruptibleSleep(jitter(PACE[pace] ?? PACE.safe)))) {
      await setRun({ running: false, note: "Stopped." });
      return;
    }
  }

  const done = await getRun();
  await setRun({
    running: false,
    note: `Finished — ${done?.imported ?? 0} filed${sourced ? " as sourced profiles" : ""}, ${done?.skipped ?? 0} ${sourced ? "not stored" : "without a readable CV"}, ${
      done?.failed ?? 0
    } skipped.`,
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage)
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "deepRead") {
      (async () => {
        try {
          const deep = await run(msg.tabId, deepHarvestProfile, [
            msg.candidateName || null,
            msg.publicProfileUrl || null,
          ]);
          respond({ ok: true, deep });
        } catch (error) {
          respond({ ok: false, error: error?.message || "deep read failed" });
        }
      })();
      return true;
    }
    if (msg?.type === "status") {
      getRun().then((r) => respond({ run: r }));
      return true;
    }
    if (msg?.type === "stop") {
      setRun({ stop: true, running: false, note: "Stopped." }).then(() => respond({ ok: true }));
      return true;
    }
    if (msg?.type === "start") {
      (async () => {
        const existing = await getRun();
        if (existing?.running) return respond({ ok: false, error: "A sweep is already running." });
        await chrome.storage.local.set({
          run: {
            running: true,
            stop: false,
            index: 0,
            total: 0,
            imported: 0,
            skipped: 0,
            failed: 0,
            note: "Reading the applicant list…",
            startedAt: Date.now(),
          },
        });
        respond({ ok: true });
        sweep(msg.payload).catch(async (e) => {
          await setRun({ running: false, note: e.message || "The sweep stopped unexpectedly." });
        });
      })();
      return true;
    }
    return false;
  });
