// `process-nfe` — recebimento de NF-e pela aba "Manual" de /admin/estoque/recebimento: conclui o
// recebimento NO OMIE (AlterarRecebimento → AlterarEtapaRecebimento → ConcluirRecebimento). O fluxo
// mora em `fluxo.ts` (testado em `fluxo_test.ts`); aqui só se ligam as dependências reais.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { chamarOmie } from "../_shared/omie-cliente.ts";
import { type ChamadaOmie, tratarRequisicao } from "./fluxo.ts";
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

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
}) as unknown as DbTrilha;

Deno.serve((req) => tratarRequisicao(req, { autorizar: authorizeCronOrStaff, omie, db, novoId: () => crypto.randomUUID() }));
