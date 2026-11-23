import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const ADMIN_HASH = "4f2c72b2e587690dd1b29266b4121a3714de9510dc1cb860369953d2b1119090";
const store = () => getStore({ name: "meeting", consistency: "strong" });

async function sha(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
async function idOf(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return (await sha("person:" + token)).slice(0, 20);
}
async function isAdmin(req: Request): Promise<boolean> {
  const k = req.headers.get("x-admin") || "";
  if (!k) return false;
  return (await sha(k)) === ADMIN_HASH;
}
const json = (o: unknown, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });

const strArr = (a: unknown, max = 3000) => Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.length <= 40).slice(0, max) : [];
const num = (x: unknown) => typeof x === "number" && isFinite(x);
const DRE = /^\d{4}-\d{2}-\d{2}$/;
const ruleArr = (a: unknown, max = 60) => Array.isArray(a)
  ? a.filter((r: any) => r && num(r.f) && num(r.t) && ((typeof r.d1 === "string" && DRE.test(r.d1) && typeof r.d2 === "string" && DRE.test(r.d2)) || (num(r.wd) && num(r.n)))).slice(0, max)
      .map((r: any) => ({ ...(typeof r.d1 === "string" ? { d1: r.d1, d2: r.d2 } : { wd: r.wd, n: r.n }), f: r.f, t: r.t, ...(typeof r.title === "string" ? { title: r.title.slice(0, 30) } : {}) }))
  : [];
const awayArr = (a: unknown) => Array.isArray(a)
  ? a.filter((x: any) => x && DRE.test(x.f) && DRE.test(x.t)).slice(0, 30).map((x: any) => ({ f: x.f, t: x.t, title: String(x.title || "").slice(0, 30) }))
  : [];
function slotOf(p: any) {
  p = p || {};
  return { blocked: strArr(p.blocked), weekly: strArr(p.weekly, 200), except: strArr(p.except), maybe: strArr(p.maybe),
    joined: strArr(p.joined, 60).map((x) => x.slice(0, 60)), rules: ruleArr(p.rules), away: awayArr(p.away) };
}
function itemsOf(a: unknown) {
  return Array.isArray(a) ? a.filter((it: any) => it && typeof it.id === "string" && typeof it.title === "string").slice(0, 30)
    .map((it: any) => ({ id: it.id.slice(0, 30), title: it.title.slice(0, 30), rules: ruleArr(it.rules) })) : [];
}
const CFG_DEF = { total: 7, meetings: 3, len: 2, allTpl: [] as any[] };
async function readConfig() {
  const c = (await store().get("config", { type: "json" })) as any;
  return { ...CFG_DEF, ...(c || {}) };
}
async function readAll(prefix: string) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const out: Record<string, any> = {};
  await Promise.all(blobs.map(async (b) => { const v = await s.get(b.key, { type: "json" }); if (v) out[b.key.slice(prefix.length)] = v; }));
  return out;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  try {
    if (req.method === "GET" && route === "state") {
      const admin = await isAdmin(req);
      const myId = await idOf(req.headers.get("x-token"));
      const [config, people, common] = await Promise.all([readConfig(), readAll("people/"), readAll("common/")]);
      const slots: Record<string, any> = {};
      const names: Record<string, any> = {};
      for (const [id, v] of Object.entries(people)) { slots[id] = v.slot || {}; if (admin) names[id] = { name: v.name || "", note: v.note || "" }; }
      const commonOut: Record<string, any> = {};
      for (const [id, v] of Object.entries(common)) commonOut[id] = v.items || [];
      const mine = myId && people[myId] ? { name: people[myId].name || "", note: people[myId].note || "" } : null;
      return json({ config, slots, common: commonOut, me: myId ? { id: myId, ...(mine || { name: "", note: "" }), saved: !!mine } : null, admin, ...(admin ? { names } : {}) });
    }
    if (req.method !== "POST") return json({ error: "not_found" }, 404);
    const body = (await req.json().catch(() => null)) as any;
    if (!body) return json({ error: "bad_request" }, 400);

    if (route === "save") {
      const id = await idOf(body.token);
      if (!id) return json({ error: "bad_token" }, 400);
      const name = String(body.name || "").trim().slice(0, 20);
      if (!name) return json({ error: "name_required" }, 400);
      await store().setJSON("people/" + id, { name, note: String(body.note || "").slice(0, 300), slot: slotOf(body.slot), updated: new Date().toISOString() });
      return json({ ok: true, id });
    }
    if (route === "common") {
      const id = await idOf(body.token);
      if (!id) return json({ error: "bad_token" }, 400);
      await store().setJSON("common/" + id, { items: itemsOf(body.items) });
      return json({ ok: true });
    }
    if (route === "admin") {
      if (!(await isAdmin(req))) return json({ error: "forbidden" }, 403);
      const s = store();
      if (body.action === "config") {
        const c = body.config || {};
        const cfg = { total: Math.min(50, Math.max(1, Math.round(+c.total || 7))), meetings: Math.min(20, Math.max(1, Math.round(+c.meetings || 3))),
          len: Math.min(13, Math.max(1, Math.round(+c.len || 2))), allTpl: itemsOf(c.allTpl) };
        await s.setJSON("config", cfg);
        return json({ ok: true });
      }
      if (body.action === "delete" && typeof body.id === "string" && /^[A-Za-z0-9-]{1,40}$/.test(body.id)) {
        await s.delete("people/" + body.id);
        return json({ ok: true });
      }
      if (body.action === "common" && typeof body.id === "string" && /^[A-Za-z0-9-]{1,40}$/.test(body.id)) {
        await s.setJSON("common/" + body.id, { items: itemsOf(body.items) });
        return json({ ok: true });
      }
      return json({ error: "bad_action" }, 400);
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

export const config: Config = { path: "/api/*" };
