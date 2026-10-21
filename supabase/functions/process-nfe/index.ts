// `process-nfe` — recebimento de NF-e pela aba "Manual" de /admin/estoque/recebimento: conclui o
// recebimento NO OMIE (AlterarRecebimento → AlterarEtapaRecebimento → ConcluirRecebimento). Aqui
// ficam o gate, a sonda e a ligação das dependências reais; o fluxo mora em `fluxo.ts` (testado em
// `fluxo_test.ts`).
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { chamarOmie } from "../_shared/omie-cliente.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { type ChamadaOmie, corsHeaders, json, processarNfe } from "./fluxo.ts";
import type { Conta, DbTrilha } from "./trilha.ts";

const OMIE_BASE = "https://app.omie.com.br/api/v1/";

function credenciais(conta: Conta): { appKey: string; appSecret: string } {
  switch (conta) {
    case "oben":
      return { appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "", appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "" };
    case "colacor":
      return { appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "", appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "" };
    case "afiacao":
      return { appKey: Deno.env.get("OMIE_COLACOR_SC_APP_KEY") ?? "", appSecret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") ?? "" };
  }
}

const omie: ChamadaOmie = (conta, endpoint, metodo, param) => {
  const creds = credenciais(conta);
  if (!creds.appKey || !creds.appSecret) return Promise.reject(new Error(`Credenciais Omie não configuradas para ${conta}`));
  console.log(`[process-nfe] ${metodo} -> ${endpoint}`);
  return chamarOmie(
    { url: `${OMIE_BASE}${endpoint}`, metodo, param, credenciais: creds },
    {
      conta,
      aoRepetir: ({ tentativa, atrasoMs }) => console.warn(`[process-nfe] ${metodo} transitório, retry ${tentativa} em ${atrasoMs}ms`),
    },
  );
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  // ⚠️ SONDA DE VERSÃO — antes de tudo, porque daqui pra frente a edge EFETIVA a NF-e no Omie
  // (AlterarRecebimento → AlterarEtapaRecebimento etapa 40 → ConcluirRecebimento) e não existe
  // dry_run neste código. Fica logo após o authorizeCronOrStaff e ANTES do gate de staff do fluxo
  // (`processarNfe`) de propósito: é pelo SQL Editor (x-cron-secret) que a sonda é invocada em
  // produção. O FLUXO REAL exige JWT de staff. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // O corpo é consumido AQUI (req.json() só pode ser lido uma vez) e reaproveitado no fluxo real.
  let corpoBruto: unknown = {};
  try {
    corpoBruto = await req.json();
  } catch {
    corpoBruto = {};
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") return json({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO), versao: VERSAO }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  }) as unknown as DbTrilha;
  return processarNfe(__auth, corpoBruto, { omie, db, novoId: () => crypto.randomUUID() });
});
