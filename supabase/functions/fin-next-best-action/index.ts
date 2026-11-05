// supabase/functions/fin-next-best-action/index.ts
// A4 — Próxima Melhor Ação. Gate gestor+master. Compõe A1/A2/A3 via service_role.
// Helper (fila + transporte do caixa da A1) em ./fila.ts, cópia VERBATIM do bloco MIRROR de
// src/lib/financeiro/next-best-action-helpers.ts; a composição pura das respostas em ./orquestracao.ts.
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import type { RespostaA1Caixa } from "./fila.ts";
import { montarRespostaA4, type RespostaA2, type RespostaA3 } from "./orquestracao.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(m = "Unauthorized"): Response { return jsonResponse({ error: m }, 401); }

async function authorizeGestorOuMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const roles = roleRes.ok ? (await roleRes.json()) as Array<{ role: string }> : [];
    if (roles.some((r) => r.role === "master")) return { ok: true };
    const comRes = await fetch(`${SUPABASE_URL}/rest/v1/commercial_roles?user_id=eq.${user.id}&select=commercial_role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const com = comRes.ok ? (await comRes.json()) as Array<{ commercial_role: string }> : [];
    const gestor = new Set(["gerencial", "estrategico", "super_admin"]);
    if (com.some((c) => gestor.has(c.commercial_role))) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — gestor comercial ou master") };
  } catch { return { ok: false, response: unauthorized() }; }
}


// ===== Orquestração: chama A1/A2/A3 via service_role =====
const EMPRESAS = ["oben", "colacor", "colacor_sc"];
const RESERVA_DIAS_MIN = 21; // ~3 semanas de cobertura como piso

async function invoke<T>(fn: string, body: unknown): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20s por function — não trava a fila inteira
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; } finally { clearTimeout(timer); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Sonda de versão — ANTES do gate normal e de qualquer IO, com gate PRÓPRIO (GATE_PROPRIO):
  // o gate normal exige Bearer + role e o caminho do SQL Editor (`x-cron-secret`) morreria nele.
  // Ver versao.ts / _shared/sonda-versao.ts.
  let corpoBruto: unknown = {};
  try {
    corpoBruto = await req.json();
  } catch {
    // sem corpo (o front chama sem body): segue como disparo
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo !== "disparo") {
    const authSonda = await authorizeCronOrStaff(req);
    if (!authSonda.ok) return authSonda.response;
    if (decisaoSonda.tipo === "sonda") return jsonResponse(respostaSonda(VERSAO), 200);
    return jsonResponse({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;

  // Paralelo: A1+A2 das 3 empresas + A3 (cockpit Oben) ao mesmo tempo (uma function lenta não trava as outras).
  const [cashResults, valorResults, cockpit] = await Promise.all([
    Promise.all(EMPRESAS.map((e) => invoke<RespostaA1Caixa>("fin-cashflow-engine", { company: e }))),
    Promise.all(EMPRESAS.map((e) => invoke<RespostaA2>("fin-valor-engine", { company: e }))),
    invoke<RespostaA3>("fin-valor-cockpit", {}),
  ]);

  const result = montarRespostaA4({ empresas: EMPRESAS, reservaDiasMin: RESERVA_DIAS_MIN, cashResults, valorResults, cockpit });
  return jsonResponse(result, 200);
});
