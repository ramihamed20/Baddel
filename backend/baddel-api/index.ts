/**
 * Baddel anonymous API — runs as a Supabase Edge Function.
 * Deploy with verify_jwt=false, because visitors must not need an account.
 * This function enforces origin, validation, rate limiting and owner-token checks.
 * The secret database key is read ONLY from the Edge Function environment.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || serviceKeys.default || "";
if (!url || !secret) throw new Error("Baddel Edge Function needs Supabase server environment");
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const origins = new Set([
  "https://ramihamed20.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  ...(Deno.env.get("BADDEL_ALLOWED_ORIGINS") || "").split(",").map(s => s.trim()).filter(Boolean),
]);
const groupSets: Record<number, Set<string>> = {
  1: new Set(["A","B","C","D"]),
  2: new Set(["A1","A2","B1","B2","C1","C2","D1","D2"]),
  3: new Set(["A1","A2","B1","B2","C1","C2","D1","D2","E1","E2"]),
};
const validSections = new Set(["A","B"]);
const userRE = /^[A-Za-z0-9_]{5,32}$/;
const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenRE = /^[a-f0-9]{64}$/i;
const columns = "id,academic_year,current_section,current_group,target_section,target_group,telegram,created_at,expires_at";

function cors(origin: string | null): Record<string,string> {
  return {
    "Access-Control-Allow-Origin": origin && origins.has(origin) ? origin : "https://ramihamed20.github.io",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Owner-Token",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
function json(status: number, data: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors(origin),
    },
  });
}
async function sha256(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashed), n => n.toString(16).padStart(2,"0")).join("");
}
function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),
    n => n.toString(16).padStart(2,"0")).join("");
}
function validPair(x: Record<string,unknown>): boolean {
  // Omitted year is supported for previously cached year-two clients.
  const year = x.academic_year === undefined ? 2 : x.academic_year;
  if (typeof year !== "number" || !Number.isInteger(year) || !groupSets[year]) return false;
  if (!validSections.has(x.current_section as string) ||
      !validSections.has(x.target_section as string)) return false;
  if (year === 3 && (x.current_section !== "A" || x.target_section !== "A")) return false;
  if (!groupSets[year].has(x.current_group as string) ||
      !groupSets[year].has(x.target_group as string)) return false;
  return x.current_section !== x.target_section || x.current_group !== x.target_group;
}
function clientIp(req: Request): string {
  // Supabase proxy-provided IP when available. Never store an IP in plaintext.
  const value = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown";
  return value.split(",")[0].trim().slice(0, 120);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (origin && !origins.has(origin)) {
    return json(403, { error: "هذا المصدر غير مسموح له باستخدام الخدمة" }, origin);
  }
  const query = new URL(req.url).searchParams;
  const action = query.get("action") || "requests";

  try {
    if (req.method === "GET" && action === "health") {
      return json(200, { ok: true }, origin);
    }
    if (req.method === "GET" && action === "requests") {
      const limit = Math.min(100, Math.max(1, Number(query.get("limit") || 100) || 100));
      const offset = Math.min(20000, Math.max(0, Number(query.get("offset") || 0) || 0));
      const now = new Date().toISOString();
      const yearParam = query.get("year");
      if (yearParam !== null && !["1","2","3"].includes(yearParam)) {
        return json(400, { error: "السنة الدراسية غير صحيحة" }, origin);
      }
      let listing = db.from("baddel_requests").select(columns, { count: "exact" })
        .gt("expires_at", now);
      if (yearParam) listing = listing.eq("academic_year", Number(yearParam));
      const result = await listing.order("created_at", { ascending: false })
        .range(Math.floor(offset), Math.floor(offset) + Math.floor(limit) - 1);
      if (result.error) throw result.error;
      return json(200, {
        requests: result.data || [],
        total: result.count || 0,
        has_more: Math.floor(offset) + (result.data?.length || 0) < (result.count || 0),
      }, origin);
    }
    if (req.method === "GET" && action === "matches") {
      const id = query.get("id") || "";
      if (!uuidRE.test(id)) return json(400, { error: "معرّف الطلب غير صالح" }, origin);
      const now = new Date().toISOString();
      const { data: request, error: requestError } = await db.from("baddel_requests")
        .select(columns).eq("id", id).gt("expires_at", now).maybeSingle();
      if (requestError) throw requestError;
      if (!request) return json(404, { error: "هذا الطلب غير موجود" }, origin);
      const { data, error } = await db.from("baddel_requests").select(columns)
        .eq("academic_year", request.academic_year)
        .eq("current_section", request.target_section)
        .eq("current_group", request.target_group)
        .eq("target_section", request.current_section)
        .eq("target_group", request.current_group)
        .gt("expires_at", now)
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      const matches = (data || []).filter(x =>
        x.id !== id && x.telegram.toLowerCase() !== request.telegram.toLowerCase());
      return json(200, { matches }, origin);
    }
    if (req.method === "POST" && action === "requests") {
      if (!(req.headers.get("content-type") || "").startsWith("application/json")) {
        return json(415, { error: "صيغة الطلب يجب أن تكون JSON" }, origin);
      }
      const length = Number(req.headers.get("content-length") || "0");
      if (length > 2500) return json(413, { error: "الطلب طويل جدًا" }, origin);
      const raw = await req.text();
      if (raw.length > 2500) return json(413, { error: "الطلب طويل جدًا" }, origin);
      let body: Record<string,unknown>;
      try { body = JSON.parse(raw); } catch {
        return json(400, { error: "تعذّر قراءة الطلب" }, origin);
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || !validPair(body)) {
        return json(400, { error: "اختار الشعبة والقروب من وإلى بشكل صحيح" }, origin);
      }
      const telegram = typeof body.telegram === "string" ?
        body.telegram.trim().replace(/^@/, "") : "";
      if (!userRE.test(telegram)) {
        return json(400, { error: "يوزر تيليجرام غير صحيح" }, origin);
      }
      if (body.consent !== true) {
        return json(400, { error: "تحتاج الموافقة على نشر يوزر تيليجرام" }, origin);
      }

      const now = Date.now();
      const previousHour = new Date(now - 3600000).toISOString();
      const hashedIp = await sha256(clientIp(req) + ":" + secret);
      const rate = await db.from("baddel_rate_events")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", hashedIp).gte("created_at", previousHour);
      if (rate.error) throw rate.error;
      if ((rate.count || 0) >= 8) {
        return json(429, { error: "نشرت طلبات كثيرة، جرب بعد ساعة" }, origin);
      }

      const { error: rateWrite } = await db.from("baddel_rate_events")
        .insert({ ip_hash: hashedIp });
      if (rateWrite) throw rateWrite;
      // Prune expired requests so a stale duplicate can be posted again.
      const cleanup = await db.from("baddel_requests").delete()
        .lte("expires_at", new Date(now).toISOString());
      if (cleanup.error) throw cleanup.error;

      const ownerToken = token();
      const payload = {
        academic_year: body.academic_year === undefined ? 2 : body.academic_year,
        current_section: body.current_section,
        current_group: body.current_group,
        target_section: body.target_section,
        target_group: body.target_group,
        telegram,
        owner_hash: await sha256(ownerToken),
      };
      const { data, error } = await db.from("baddel_requests")
        .insert(payload).select(columns).single();
      if (error) {
        if (error.code === "23505") {
          return json(409, { error: "عندك طلب مطابق منشور بنفس يوزر تيليجرام" }, origin);
        }
        throw error;
      }
      return json(201, { request: data, owner_token: ownerToken }, origin);
    }
    if (req.method === "DELETE" && action === "requests") {
      const id = query.get("id") || "";
      const ownerToken = req.headers.get("x-owner-token") || "";
      if (!uuidRE.test(id)) return json(400, { error: "معرّف الطلب غير صالح" }, origin);
      if (!tokenRE.test(ownerToken)) return json(403, { error: "ليس لديك صلاحية حذف الطلب" }, origin);
      const { data, error } = await db.from("baddel_requests").delete()
        .eq("id", id).eq("owner_hash", await sha256(ownerToken))
        .select("id").maybeSingle();
      if (error) throw error;
      if (!data) return json(403, { error: "لا يمكنك حذف هذا الطلب" }, origin);
      return json(200, { deleted: true }, origin);
    }
    return json(404, { error: "المسار غير موجود" }, origin);
  } catch (error) {
    console.error("Baddel API failure", error);
    return json(500, { error: "حصل خطأ مؤقت، حاول مرة ثانية" }, origin);
  }
});
