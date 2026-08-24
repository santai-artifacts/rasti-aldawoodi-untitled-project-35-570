import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────────
const TZ = "America/New_York";
// Weekday evenings, 30-minute slots (5:00pm – 8:00pm ET → last start 7:30pm)
const SLOT_TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30"];
const DAYS_AHEAD = 28; // how far out people can book
// Passcode for the /admin dashboard. Set the ADMIN_PASSCODE secret before deploy.
// The fallback only exists so the admin page is testable in the preview.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "preview-admin";

// ── Database ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DATABASE_URL || `${import.meta.dir}/data/app.db`;
try { mkdirSync(`${import.meta.dir}/data`, { recursive: true }); } catch {}
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    topic      TEXT,
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(date, time)
  )
`);

// ── Time helpers (everything is expressed in ET) ─────────────────────────
function etTodayYMD(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function etNowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

function slotMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function to12h(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  }).format(dt);
}

// Enumerate the upcoming bookable weekday dates (Mon–Fri) in ET.
function upcomingDates(): string[] {
  const [y, m, d] = etTodayYMD().split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d, 12);
  const out: string[] = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const dt = new Date(anchor + i * 86400000);
    const dow = dt.getUTCDay(); // 0 Sun … 6 Sat
    if (dow >= 1 && dow <= 5) {
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      out.push(`${yy}-${mm}-${dd}`);
    }
  }
  return out;
}

function bookedSet(): Set<string> {
  const rows = db.query("SELECT date, time FROM bookings").all() as
    { date: string; time: string }[];
  return new Set(rows.map((r) => `${r.date}|${r.time}`));
}

// Full availability payload for the next few weeks.
function buildAvailability() {
  const today = etTodayYMD();
  const nowMin = etNowMinutes();
  const booked = bookedSet();
  const dates = upcomingDates().map((date) => {
    const slots = SLOT_TIMES.map((time) => {
      const isPast = date === today && slotMinutes(time) <= nowMin;
      const isBooked = booked.has(`${date}|${time}`);
      return { time, label: to12h(time), available: !isPast && !isBooked };
    });
    return {
      date,
      label: dateLabel(date),
      hasOpen: slots.some((s) => s.available),
      slots,
    };
  }).filter((d) => d.slots.length > 0);
  return { timezone: "ET", dates };
}

function isValidSlot(date: string, time: string): { ok: boolean; reason?: string } {
  if (!SLOT_TIMES.includes(time)) return { ok: false, reason: "Invalid time slot." };
  if (!upcomingDates().includes(date)) return { ok: false, reason: "That date isn't available for booking." };
  if (date === etTodayYMD() && slotMinutes(time) <= etNowMinutes())
    return { ok: false, reason: "That time has already passed." };
  return { ok: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── HTTP ─────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serveFile(name: string, type: string) {
  try {
    return new Response(readFileSync(`${import.meta.dir}/${name}`), {
      headers: { "content-type": type },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── API ──
    if (path === "/api/slots" && req.method === "GET") {
      return json(buildAvailability());
    }

    if (path === "/api/book" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
      const name = String(body?.name || "").trim();
      const email = String(body?.email || "").trim();
      const topic = String(body?.topic || "").trim().slice(0, 500);
      const date = String(body?.date || "").trim();
      const time = String(body?.time || "").trim();

      if (!name) return json({ error: "Please enter your name." }, 400);
      if (!EMAIL_RE.test(email)) return json({ error: "Please enter a valid email." }, 400);
      const valid = isValidSlot(date, time);
      if (!valid.ok) return json({ error: valid.reason }, 400);

      try {
        db.query(
          "INSERT INTO bookings (name, email, topic, date, time, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(name, email, topic, date, time, new Date().toISOString());
      } catch (e: any) {
        if (String(e?.message || "").includes("UNIQUE"))
          return json({ error: "Sorry — that slot was just taken. Please pick another." }, 409);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }

      return json({
        ok: true,
        confirmation: {
          name, date, time,
          dateLabel: dateLabel(date),
          timeLabel: to12h(time),
        },
      });
    }

    if (path === "/api/admin/bookings" && req.method === "GET") {
      if (url.searchParams.get("passcode") !== ADMIN_PASSCODE)
        return json({ error: "Unauthorized" }, 401);
      const rows = db.query(
        "SELECT id, name, email, topic, date, time, created_at FROM bookings ORDER BY date ASC, time ASC"
      ).all() as any[];
      const nowMin = etNowMinutes();
      const today = etTodayYMD();
      const bookings = rows.map((r) => ({
        ...r,
        dateLabel: dateLabel(r.date),
        timeLabel: to12h(r.time),
        past: r.date < today || (r.date === today && slotMinutes(r.time) <= nowMin),
      }));
      return json({ bookings });
    }

    if (path === "/api/admin/cancel" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
      if (body?.passcode !== ADMIN_PASSCODE) return json({ error: "Unauthorized" }, 401);
      const id = Number(body?.id);
      if (!id) return json({ error: "Missing booking id." }, 400);
      db.query("DELETE FROM bookings WHERE id = ?").run(id);
      return json({ ok: true });
    }

    // ── Static ──
    if (path === "/" || path === "/index.html") return serveFile("index.html", "text/html; charset=utf-8");
    if (path === "/admin" || path === "/admin.html") return serveFile("admin.html", "text/html; charset=utf-8");

    return new Response("Not found", { status: 404 });
  },
};
