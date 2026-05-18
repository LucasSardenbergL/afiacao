import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

  // 1. Fetch company_cnpjs to map company → CNPJ
  const { data: cnpjs } = await supabase
    .from("company_cnpjs")
    .select("company, cnpj_normalized");

  if (!cnpjs || cnpjs.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        msg: "sem CNPJs configurados",
        matches: 0,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const cnpjToCompany = new Map<string, string>();
  for (const c of cnpjs as Array<{ company: string; cnpj_normalized: string }>) {
    cnpjToCompany.set(c.cnpj_normalized, c.company);
  }
  const groupCnpjs = Array.from(cnpjToCompany.keys());

  // 2. Fetch CR (Contas a Receber) with CNPJs from group
  const { data: crsRaw } = await supabase
    .from("fin_contas_receber")
    .select("id, company, cnpj_cpf, valor_documento, data_emissao");

  const crs = (crsRaw ?? []) as CR[];
  const crsIC = crs.filter((c) =>
    groupCnpjs.includes(normalizeCnpj(c.cnpj_cpf))
  );

  // 3. Fetch CP (Contas a Pagar) with CNPJs from group
  const { data: cpsRaw } = await supabase
    .from("fin_contas_pagar")
    .select("id, company, cnpj_cpf, valor_documento, data_emissao");

  const cps = (cpsRaw ?? []) as CP[];
  const cpsIC = cps.filter((p) =>
    groupCnpjs.includes(normalizeCnpj(p.cnpj_cpf))
  );

  // 4. Bucket CP by (empresa_origem_da_CR : empresa_destino_que_eh_empresa_do_CP)
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

  // 5. Match CRs to CPs
  for (const cr of crsIC) {
    const empresaDestino = cnpjToCompany.get(normalizeCnpj(cr.cnpj_cpf));
    if (!empresaDestino) continue;

    const key = `${cr.company}:${empresaDestino}`;
    const candidates = cpsByKey.get(key) ?? [];

    // Try exact match: valor within tolerance + data within tolerance
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
      // Multiple candidates with exact match
      upserts.push({
        empresa_origem: cr.company,
        empresa_destino: empresaDestino,
        cr_id: cr.id,
        valor_origem: cr.valor_documento,
        status: "duplicidade_possivel",
        observacao: `${exact.length} CPs candidatos`,
      });
    } else {
      // No exact match, try loose valor (±5%) + data ok
      const looseValor = candidates.filter(
        (cp) =>
          Math.abs(cp.valor_documento - cr.valor_documento) /
            cr.valor_documento <=
            0.05 &&
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

      // Try loose data (6-30d) + valor ok
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

      // No candidate match at all
      upserts.push({
        empresa_origem: cr.company,
        empresa_destino: empresaDestino,
        cr_id: cr.id,
        valor_origem: cr.valor_documento,
        status: "sem_contrapartida",
      });
    }
  }

  // 6. Find orphan CPs (not matched)
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

  // 7. Idempotency: delete auto-generated status, keep manual_matched + desconsiderado
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

  // 8. Insert new matches
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
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
