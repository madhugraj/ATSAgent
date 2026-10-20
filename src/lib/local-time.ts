/**
 * A time as people read it, in the organisation's time zone: "Wed 14 Oct,
 * 14:00 IST". Shared by agent tools and the hiring desk so every thread
 * message speaks one time zone, never UTC.
 */
export function localWhen(at: string | Date, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return String(at);
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // The short name for India is "GMT+5:30" in Intl; people say IST.
  const zone = timeZone === "Asia/Kolkata" ? "IST" : get("timeZoneName");
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${zone}`;
}
