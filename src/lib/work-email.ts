/**
 * Work-email originality checks. There is no way to prove a company exists from an
 * email address alone, so we enforce the checks that actually stop casual abuse:
 *
 * 1. the address must be deliverable-looking and not a free consumer mailbox,
 * 2. it must not be a known disposable/throwaway domain,
 * 3. every internal user of a tenant must share the owner's verified domain,
 * 4. the emailed confirmation link (/api/auth/register) proves the mailbox before sign-in.
 */

const FREE_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "rediffmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hushmail.com",
  "inbox.com",
  "fastmail.com",
]);

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "trashmail.com",
  "yopmail.com",
  "dispostable.com",
  "getnada.com",
  "sharklasers.com",
  "throwawaymail.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mytemp.email",
  "moakt.com",
  "emailondeck.com",
  "tempr.email",
  "spam4.me",
  "mailnesia.com",
  "discard.email",
]);

export function emailDomain(email: string) {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isFreeEmailDomain(email: string) {
  return FREE_DOMAINS.has(emailDomain(email));
}

export function isDisposableEmailDomain(email: string) {
  const d = emailDomain(email);
  return DISPOSABLE_DOMAINS.has(d) || /(^|\.)(mailinator|yopmail|tempmail|trashmail)\./.test(d);
}

/** Returns a human message when the address is not usable as a corporate identity. */
export function workEmailProblem(email: string): string | null {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return "Enter a valid email address.";
  const domain = emailDomain(value);
  if (!domain || domain.length < 4) return "Enter a valid email domain.";
  if (isDisposableEmailDomain(value)) return "Disposable email domains are not accepted.";
  if (isFreeEmailDomain(value))
    return `Use your company email address — ${domain} is a personal mailbox provider.`;
  return null;
}

/** Internal users must live on the same verified domain as the organisation owner. */
export function sameDomain(a: string, b: string) {
  return emailDomain(a) === emailDomain(b);
}

/**
 * Multi-part public suffixes we care about, so `abc.as.co.in` and `sdf.as.co.in`
 * both reduce to `as.co.in` instead of the useless `co.in`.
 */
const MULTI_SUFFIXES = new Set([
  "co.in",
  "net.in",
  "org.in",
  "gen.in",
  "firm.in",
  "ind.in",
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "com.br",
  "com.mx",
  "com.sg",
  "com.my",
  "com.hk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "co.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "co.za",
  "com.tr",
  "com.ar",
  "com.ph",
  "co.id",
  "com.sa",
  "com.eg",
  "co.il",
  "com.tw",
  "com.vn",
  "com.pk",
  "com.bd",
  "com.ng",
]);

/**
 * The registrable company domain behind an email or hostname: every subdomain of
 * the same company collapses to one identity, which is what a tenant claims.
 */
export function registrableDomain(emailOrDomain: string) {
  const host = (
    emailOrDomain.includes("@") ? emailDomain(emailOrDomain) : emailOrDomain.trim().toLowerCase()
  ).replace(/^\.+|\.+$/g, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}
