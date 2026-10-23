/**
 * ATSIQ Capture — fill a job portal's "post a job" form with a role's text.
 *
 * Injected into the portal tab only when the person presses "Fill this form"
 * in the companion, on a page they are signed in to. It finds the form's
 * fields by what they are labelled (title, location, openings, experience,
 * skills, description), fills the ones it recognises, and shows a small panel
 * with every value and a Copy button for anything it could not place. It
 * NEVER submits: the person reviews the form and presses the portal's own
 * button. No password or session ever leaves the page.
 */
(function () {
  /** Which role field a portal label is asking for, or null. Pure — unit-tested. */
  function atsiqFieldKey(text) {
    const t = String(text || "")
      .toLowerCase()
      .replace(/[*:()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return null;
    if (/salary|stipend|ctc|pay|incentive|perk|fee/.test(t)) return null;
    if (/apply|application link|external link|redirect/.test(t) && /link|url/.test(t))
      return "applyUrl";
    if (/(no\.?|number) of (openings|vacanc|positions|hires)|openings|vacancies|how many/.test(t))
      return "openings";
    if (/min(imum)? (experience|exp)|experience from|exp(erience)? min/.test(t)) return "expMin";
    if (/max(imum)? (experience|exp)|experience to|exp(erience)? max/.test(t)) return "expMax";
    if (/experience|years of exp/.test(t)) return "experience";
    if (/skill|key ?words|tags/.test(t)) return "skills";
    if (/work (mode|type|from)|remote|work from home|wfh|office type|job type/.test(t))
      return "workMode";
    if (
      /(job|role|internship|vacancy|position) ?(title|profile|name|role)|designation|^title$|^profile$|^job role$|^role$/.test(
        t,
      )
    )
      return "title";
    if (/locat|city|cities|where/.test(t)) return "location";
    if (
      /descri|responsib|about (the )?(job|role|internship)|what you.?ll do|job details|requirements/.test(
        t,
      )
    )
      return "description";
    return null;
  }

  function valueFor(key, f) {
    switch (key) {
      case "title":
        return f.title;
      case "location":
        return f.location || "";
      case "openings":
        return String(f.openings ?? 1);
      case "expMin":
        return String(f.experienceMin ?? 0);
      case "expMax":
        return String(f.experienceMax ?? "");
      case "experience":
        return `${f.experienceMin ?? 0}-${f.experienceMax ?? ""} years`;
      case "skills":
        return (f.skills || []).join(", ");
      case "workMode":
        return f.workMode || "";
      case "description":
        return f.description || "";
      case "applyUrl":
        return f.applyUrl || "";
      default:
        return "";
    }
  }

  function labelOf(el) {
    const parts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) parts.push(wrap.innerText);
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    const by = el.getAttribute("aria-labelledby");
    if (by)
      for (const id of by.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) parts.push(n.innerText);
      }
    // No real label: the nearest heading-like text just above the field
    // (common in portal forms). A placeholder ("e.g. Python") is only an example.
    let node = el;
    for (let i = 0; i < 4 && node && !parts.join("").trim(); i++) {
      node = node.parentElement;
      const prev = node?.previousElementSibling;
      if (prev && prev.innerText && prev.innerText.length < 80) parts.push(prev.innerText);
    }
    for (const attr of ["placeholder", "name", "data-placeholder", "title"])
      if (el.getAttribute(attr)) parts.push(el.getAttribute(attr));
    return parts.join(" ");
  }

  // React and other frameworks only see values set through the native setter.
  function setValue(el, value) {
    if (el.isContentEditable) {
      el.focus();
      el.innerText = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    }
    if (el.tagName === "SELECT") {
      const want = value.toLowerCase();
      const opt = [...el.options].find(
        (o) => o.text.toLowerCase().includes(want) || want.includes(o.text.toLowerCase()),
      );
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function panel(fields, filled, portal) {
    document.getElementById("atsiq-fill-panel")?.remove();
    const host = document.createElement("div");
    host.id = "atsiq-fill-panel";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    const rows = [
      ["title", "Title"],
      ["location", "Location"],
      ["openings", "Openings"],
      ["experience", "Experience"],
      ["skills", "Skills"],
      ["workMode", "Work mode"],
      ["description", "Description"],
      ["applyUrl", "Apply link"],
    ].filter(([k]) => valueFor(k, fields));
    root.innerHTML = `
      <style>
        .p{font:12px/1.45 system-ui,sans-serif;width:320px;max-height:70vh;overflow:auto;background:#fff;color:#0b0b0f;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:12px}
        h3{margin:0 0 4px;font-size:13px}.n{color:#6b7280;margin:0 0 8px}
        .r{border-top:1px solid #eef0f4;padding:6px 0}.k{display:flex;justify-content:space-between;align-items:center;font-weight:600}
        .v{white-space:pre-wrap;color:#374151;max-height:72px;overflow:auto}
        button{border:0;border-radius:999px;background:#edf0f5;padding:3px 10px;font:inherit;cursor:pointer}
        .ok{color:#027a48;font-weight:500}.x{position:absolute;top:8px;right:12px;background:none}
      </style>
      <div class="p"><button class="x" title="Close">✕</button>
        <h3>ATSIQ filled ${filled.length} field${filled.length === 1 ? "" : "s"} on ${portal}</h3>
        <p class="n">Check everything, add what the portal asks for that ATSIQ does not know (pay, perks), then press the portal's own button. Then press “I’ve submitted it” in ATSIQ Capture.</p>
        ${rows
          .map(
            ([k, label]) =>
              `<div class="r"><div class="k"><span>${label} ${filled.includes(k) ? '<span class="ok">✓ filled</span>' : ""}</span><button data-k="${k}">Copy</button></div><div class="v"></div></div>`,
          )
          .join("")}
      </div>`;
    rows.forEach(([k], i) => {
      root.querySelectorAll(".v")[i].textContent = valueFor(k, fields);
    });
    root.querySelectorAll("button[data-k]").forEach((b) =>
      b.addEventListener("click", async () => {
        await navigator.clipboard.writeText(valueFor(b.dataset.k, fields));
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = "Copy"), 1200);
      }),
    );
    root.querySelector(".x").addEventListener("click", () => host.remove());
    document.body.appendChild(host);
  }

  /** Fill the visible form; returns which role fields were placed. Never submits. */
  function atsiqFillForm(fields, portal) {
    const filled = [];
    const used = new Set();
    const controls = [
      ...document.querySelectorAll(
        'input:not([type=hidden]):not([type=password]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select, [contenteditable="true"]',
      ),
    ].filter((el) => el.offsetParent !== null && !el.disabled && !el.readOnly);
    for (const el of controls) {
      const key = atsiqFieldKey(labelOf(el));
      if (!key || used.has(key)) continue;
      const value = valueFor(key, fields);
      if (!value) continue;
      if (setValue(el, value)) {
        used.add(key);
        filled.push(key);
      }
    }
    panel(fields, filled, portal || location.hostname);
    return { filled, found: controls.length };
  }

  globalThis.atsiqFieldKey = atsiqFieldKey;
  globalThis.atsiqFillForm = atsiqFillForm;
  if (typeof module !== "undefined") module.exports = { atsiqFieldKey };
})();
