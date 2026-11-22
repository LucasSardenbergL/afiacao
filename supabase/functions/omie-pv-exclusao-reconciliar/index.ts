// Edge Function: omie-pv-exclusao-reconciliar  [money-path]
//
// PV EXCLUÍDO direto no Omie seguia no app contando nas vendas, com a reserva de estoque 'ativa' para sempre (o app
// só espelhava o CANCELAMENTO, etapa 80). Incidente: PV 13693 (Oben, 2026-11-21, limpeza manual PR #4082) e mais 10 da
// Oben (recibo #1295). Esta edge dá BAIXA automática, por evidência do próprio Omie:
//   1. gate canônico `authorizeCronOrStaff` (cron de hora em hora com x-cron-secret; staff pode disparar);
//   2. sonda de versão ANTES de qualquer leitura/escrita ou chamada ao Omie;
//   3. por conta (oben, colacor), em série e isoladas: triagem por janela de inclusão (ListarPedidos) → suspeitos no
//      ledger; e no máximo 1 ConsultarPedido, com a vez concedida pelo BANCO (1/h/conta). A baixa (deleted_at nas
//      linhas + reserva 'liberada' com trilha) acontece DENTRO da RPC, na 2ª ausência afirmada ≥ 1h depois da 1ª;
//   4. registro em `acoes_execucoes` (slug `vendas.pv_excluido_omie`, 1 escritor = esta edge).
// Nunca escreve no Omie.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { type Conta, reconciliarConta, type ResultadoConta } from "./reconciliar.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACAO_REGISTRO = "vendas.pv_excluido_omie";
const CONTAS: readonly Conta[] = ["oben", "colacor"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function credenciaisDe(conta: Conta): { appKey: string; appSecret: string } | null {
  const prefixo = conta === "colacor" ? "OMIE_COLACOR" : "OMIE_OBEN";
  const appKey = Deno.env.get(`${prefixo}_APP_KEY`);
  const appSecret = Deno.env.get(`${prefixo}_APP_SECRET`);
  return appKey && appSecret ? { appKey, appSecret } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    const texto = await req.text();
    const b = texto.trim() ? JSON.parse(texto) : {};
    body = b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
  } catch {
    return json({ ok: false, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial, antes de qualquer leitura/escrita ou do Omie.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const contas = await comRegistro(db as unknown as DbRegistro, ACAO_REGISTRO, { via: auth.via, userId: auth.userId }, async () => {
      const resultados: ResultadoConta[] = [];
      // Em série: uma conta não divide a janela de tempo da outra; o erro de uma não derruba a outra.
      for (const conta of CONTAS) {
        try {
          resultados.push(await reconciliarConta(conta, { db, credenciais: credenciaisDe(conta) }));
        } catch (e) {
          resultados.push({ conta, execucao: "erro", janelas: [], consulta: null, parou_por_cota: null, erro: (mensagemDeErro(e) ?? "erro").slice(0, 300) });
        }
      }
      return resultados;
    }, (r) => ({ versao: VERSAO, contas: r }));
    const algumErro = contas.some((c) => c.erro !== null);
    return json({ ok: !algumErro, versao: VERSAO, contas }, algumErro ? 207 : 200);
  } catch (e) {
    return json({ ok: false, versao: VERSAO, mensagem: (mensagemDeErro(e) ?? "erro inesperado").slice(0, 600) }, 500);
  }
});
