import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================
// Helper de autorização inlineado (de _shared/auth.ts)
// =============================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AuthResult =
  | { ok: true; via: "cron" | "service_role" | "staff"; userId?: string }
  | { ok: false; response: Response };

async function authorizeCronOrStaff(req: Request): Promise<AuthResult> {
  const expected = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (expected && cronSecret && cronSecret === expected) {
    return { ok: true, via: "cron" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized() };
  }
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) {
    return { ok: true, via: "service_role" };
  }

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
    });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };

    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    if (roles.some((r) => allowed.has(r.role))) {
      return { ok: true, via: "staff", userId: user.id };
    }
    return { ok: false, response: unauthorized("Forbidden") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// =============================================================
// Edge function: reconciliação intercompany automática
// =============================================================
const VALOR_TOLERANCIA = 0.01;
const DATA_TOLERANCIA_DIAS = 5;

type CR = {
  id: string;
  company: string;
  cnpj_cpf: string | null;
  valor_documento: number;
  data_emissao: string | null;
};

type CP = {
  id: string;
  company: string;
  cnpj_cpf: string | null;
  valor_documento: number;
  data_emissao: string | null;
};

function normalizeCnpj(s: string | null): string {
  return (s ?? "").replace(/[^0-9]/g, "");
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000)
  );
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) {
    return auth.response;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: cnpjs } = await supabase
    .from("company_cnpjs")
    .select("company, cnpj_normalized");

  if (!cnpjs || cnpjs.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, msg: "sem CNPJs configurados", matches: 0 }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const cnpjToCompany = new Map<string, string>();
  for (const c of cnpjs as Array<{ company: string; cnpj_normalized: string }>) {
    cnpjToCompany.set(c.cnpj_normalized, c.company);
  }
  const groupCnpjs = Array.from(cnpjToCompany.keys());

  const { data: crsRaw } = await supabase
    .from("fin_contas_receber")
    .select("id, company, cnpj_cpf, valor_documento, data_emissao");

  const crs = (crsRaw ?? []) as CR[];
  const crsIC = crs.filter((c) => groupCnpjs.includes(normalizeCnpj(c.cnpj_cpf)));

  const { data: cpsRaw } = await supabase
    .from("fin_contas_pagar")
    .select("id, company, cnpj_cpf, valor_documento, data_emissao");

  const cps = (cpsRaw ?? []) as CP[];
  const cpsIC = cps.filter((p) => groupCnpjs.includes(normalizeCnpj(p.cnpj_cpf)));

  type CPKey = string;
  const cpsByKey = new Map<CPKey, CP[]>();
  for (const cp of cpsIC) {
    const empresaDestino = cnpjToCompany.get(normalizeCnpj(cp.cnpj_cpf));
    if (!empresaDestino) continue;
    const key = `${empresaDestino}:${cp.company}`;
    if (!cpsByKey.has(key)) cpsByKey.set(key, []);
    cpsByKey.get(key)!.push(cp);
  }

  const upserts: Array<Record<string, unknown>> = [];

  for (const cr of crsIC) {
    const empresaDestino = cnpjToCompany.get(normalizeCnpj(cr.cnpj_cpf));
    if (!empresaDestino) continue;

    const key = `${cr.company}:${empresaDestino}`;
    const candidates = cpsByKey.get(key) ?? [];

    const exact = candidates.filter(
      (cp) =>
        Math.abs(cp.valor_documento - cr.valor_documento) <= VALOR_TOLERANCIA &&
        cr.data_emissao &&
        cp.data_emissao &&
        daysBetween(cr.data_emissao, cp.data_emissao) <= DATA_TOLERANCIA_DIAS
    );

    if (exact.length === 1) {
      upserts.push({
        empresa_origem: cr.company,
        empresa_destino: empresaDestino,
        cr_id: cr.id,
        cp_id: exact[0].id,
        valor_origem: cr.valor_documento,
        valor_destino: exact[0].valor_documento,
        diff_dias:
          cr.data_emissao && exact[0].data_emissao
            ? daysBetween(cr.data_emissao, exact[0].data_emissao)
            : null,
        status: "auto_matched",
      });
    } else if (exact.length > 1) {
      upserts.push({
        empresa_origem: cr.company,
        empresa_destino: empresaDestino,
        cr_id: cr.id,
        valor_origem: cr.valor_documento,
        status: "duplicidade_possivel",
        observacao: `${exact.length} CPs candidatos`,
      });
    } else {
      const looseValor = candidates.filter(
        (cp) =>
          Math.abs(cp.valor_documento - cr.valor_documento) / cr.valor_documento <= 0.05 &&
          cr.data_emissao &&
          cp.data_emissao &&
          daysBetween(cr.data_emissao, cp.data_emissao) <= DATA_TOLERANCIA_DIAS
      );
      if (looseValor.length === 1) {
        upserts.push({
          empresa_origem: cr.company,
          empresa_destino: empresaDestino,
          cr_id: cr.id,
          cp_id: looseValor[0].id,
          valor_origem: cr.valor_documento,
          valor_destino: looseValor[0].valor_documento,
          diff_dias:
            cr.data_emissao && looseValor[0].data_emissao
              ? daysBetween(cr.data_emissao, looseValor[0].data_emissao)
              : null,
          status: "divergencia_valor",
        });
        continue;
      }

      const looseData = candidates.filter(
        (cp) =>
          Math.abs(cp.valor_documento - cr.valor_documento) <= VALOR_TOLERANCIA &&
          cr.data_emissao &&
          cp.data_emissao &&
          daysBetween(cr.data_emissao, cp.data_emissao) > DATA_TOLERANCIA_DIAS &&
          daysBetween(cr.data_emissao, cp.data_emissao) <= 30
      );
      if (looseData.length === 1) {
        upserts.push({
          empresa_origem: cr.company,
          empresa_destino: empresaDestino,
          cr_id: cr.id,
          cp_id: looseData[0].id,
          valor_origem: cr.valor_documento,
          valor_destino: looseData[0].valor_documento,
          diff_dias:
            cr.data_emissao && looseData[0].data_emissao
              ? daysBetween(cr.data_emissao, looseData[0].data_emissao)
              : null,
          status: "divergencia_data",
        });
        continue;
      }

      upserts.push({
        empresa_origem: cr.company,
        empresa_destino: empresaDestino,
        cr_id: cr.id,
        valor_origem: cr.valor_documento,
        status: "sem_contrapartida",
      });
    }
  }

  const usedCpIds = new Set(upserts.map((u) => u.cp_id).filter(Boolean));
  for (const cp of cpsIC) {
    if (usedCpIds.has(cp.id)) continue;
    const empresaOrigem = cnpjToCompany.get(normalizeCnpj(cp.cnpj_cpf));
    if (!empresaOrigem) continue;
    upserts.push({
      empresa_origem: empresaOrigem,
      empresa_destino: cp.company,
      cp_id: cp.id,
      valor_destino: cp.valor_documento,
      status: "sem_contrapartida",
    });
  }

  await supabase
    .from("fin_ic_matches")
    .delete()
    .in("status", [
      "auto_matched",
      "divergencia_valor",
      "divergencia_data",
      "sem_contrapartida",
      "duplicidade_possivel",
    ]);

  if (upserts.length > 0) {
    const { error: insErr } = await supabase
      .from("fin_ic_matches")
      .insert(upserts);
    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response(
    JSON.stringify({ ok: true, total_matches: upserts.length }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
