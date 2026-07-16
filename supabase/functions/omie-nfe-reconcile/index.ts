// omie-nfe-reconcile — varredura de reconciliação (reconcile-only, idempotente).
//
// PROBLEMA: a operação dá entrada das NF-e DIRETO no Omie (humano), e o app nunca
// fica sabendo — as NFs importadas ficam 'pendente' eternas no painel de recebimento.
// Esta edge alinha o app com a realidade do Omie SEM escrever nada no Omie:
//   - consulta cada NF 'pendente' (ConsultarRecebimento, chave como identidade);
//   - cRecebido=S no Omie → marca 'efetivado' no app (reconciliação, read-only no Omie);
//   - QUALQUER outro caso (aguardando conferência, inconsistente, consulta falhou,
//     identidade em dúvida) → PULA sem tocar o status. Varredura automática nunca
//     pinta falha no painel — falha visível é reservada à ação humana (Efetivar/
//     Reprocessar na edge omie-nfe-recebimento).
//
// Chamada: cron (x-cron-secret) ou staff. Body opcional: { limite?: number } (1..30, default 15).
// Rate-limit Omie: lote sequencial com trégua de 1.1s entre consultas (a trava
// "Consumo redundante" do Omie é por chamada idêntica <60s; NFs distintas passam,
// mas a trégua protege o limite global de req/min).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ESPELHO VERBATIM (subset) de src/lib/recebimento/efetivacao-helpers.ts
// (Edge Functions bundle independently — manter sincronizado com o src.)
// ════════════════════════════════════════════════════════════════════════════
interface OmieClassificacao { sucesso: boolean; erro: string | null; omieStatus: string | null; }
interface ItemOmie {
  nSequencia: number; nIdProduto: number | null; cCodigoProduto: string | null;
  nQtdeNFe: number; nQtdeRecebida: number | null; cUnidadeNfe: string | null;
  cIgnorarItem: boolean; nFatorConversao: number | null;
}
interface EstadoConsulta { cRecebido: string | null; cEtapa: string | null; nIdReceb: number | null; cChaveNfe: string | null; itensOmie: ItemOmie[]; }

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Sucesso HTTP ≠ sucesso Omie: 200 com `faultstring`/`codigo_status≠0` é falha. */
function classificarRespostaOmie(r: { httpOk: boolean; status?: number; body: unknown }): OmieClassificacao {
  const obj = asRecord(r.body);
  const faultstring = typeof obj.faultstring === "string" ? obj.faultstring.trim() : "";
  const codRaw = obj.codigo_status ?? obj.cCodStatus;
  const omieStatus = codRaw == null ? null : String(codRaw).trim();
  const desc =
    (typeof obj.descricao_status === "string" && obj.descricao_status.trim()) ||
    (typeof obj.cDescStatus === "string" && obj.cDescStatus.trim()) ||
    "";
  if (!r.httpOk) return { sucesso: false, erro: faultstring || `HTTP ${r.status ?? "???"}`, omieStatus };
  if (faultstring) return { sucesso: false, erro: faultstring, omieStatus };
  if (omieStatus != null && omieStatus !== "" && omieStatus !== "0") {
    return { sucesso: false, erro: desc || `status ${omieStatus}`, omieStatus };
  }
  return { sucesso: true, erro: null, omieStatus };
}

function fatorEfetivo(candidatos: unknown[]): number | null {
  const nums = candidatos.map(asNum).filter((n): n is number => n != null && n > 0);
  if (nums.length === 0) return null;
  const naoUm = nums.find((n) => Math.abs(n - 1) > 1e-9);
  return naoUm != null ? naoUm : 1;
}
function parseItemOmie(raw: unknown): ItemOmie {
  const it = asRecord(raw);
  const itc = asRecord(it.itensCabec);
  const aj = asRecord(it.itensAjustes);
  const conv = asRecord(it.itensConversao);
  const nfe = asRecord(it.itensNfe);
  return {
    nSequencia: asNum(itc.nSequencia) ?? 0,
    nIdProduto: asNum(itc.nIdProduto),
    cCodigoProduto: asStr(itc.cCodigoProduto),
    nQtdeNFe: asNum(itc.nQtdeNFe) ?? 0,
    nQtdeRecebida: asNum(aj.nQtdeRecebida),
    cUnidadeNfe: asStr(itc.cUnidadeNfe) ?? asStr(aj.cUnidade),
    cIgnorarItem: asStr(itc.cIgnorarItem) === "S",
    nFatorConversao: fatorEfetivo([
      itc.nFatorConversao, itc.nFatorConv, aj.nFatorConversao, aj.nFatorConv, conv.nFatorConversao, nfe.nFatorConversao,
    ]),
  };
}
function extrairEstadoConsulta(body: unknown): EstadoConsulta {
  const obj = asRecord(body);
  const cabec = asRecord(obj.cabec);
  const infoCadastro = asRecord(obj.infoCadastro);
  const itensRaw = Array.isArray(obj.itensRecebimento) ? obj.itensRecebimento : [];
  return {
    cRecebido: asStr(infoCadastro.cRecebido),
    cEtapa: asStr(cabec.cEtapa),
    nIdReceb: asNum(cabec.nIdReceb),
    cChaveNfe: asStr(cabec.cChaveNfe),
    itensOmie: itensRaw.map(parseItemOmie),
  };
}
function validarIdentidade(estado: EstadoConsulta, esperado: { nIdReceb: number; chaveAcesso: string }): { ok: boolean; erro: string | null } {
  if (estado.nIdReceb == null) return { ok: false, erro: "consulta do Omie sem nIdReceb" };
  if (estado.nIdReceb !== esperado.nIdReceb) {
    return { ok: false, erro: `nIdReceb diverge (Omie ${estado.nIdReceb} ≠ app ${esperado.nIdReceb})` };
  }
  if (estado.cChaveNfe != null && estado.cChaveNfe !== esperado.chaveAcesso) {
    return { ok: false, erro: "chave de acesso diverge entre Omie e app" };
  }
  return { ok: true, erro: null };
}
function decidirAcaoRecebimento(estado: EstadoConsulta): "reconciliar" | "escrever" | "inconsistente" {
  const rec = (estado.cRecebido ?? "").trim().toUpperCase();
  const etapa = (estado.cEtapa ?? "").trim();
  if (rec === "S") return "reconciliar";
  if (etapa === "80") return "inconsistente";
  return "escrever";
}

type EfeitoReconcile =
  | { efeito: "reconciliar" }
  | { efeito: "pular"; motivo: "consulta_falhou" | "cancelada" | "identidade_divergente" | "aguardando_conferencia" | "inconsistente" };

/**
 * Política da varredura automática sobre NF 'pendente': SÓ reconcilia (cRecebido=S no
 * Omie → marca efetivado no app, read-only no Omie). Qualquer outro caminho PULA sem
 * tocar o status. Fail-closed além do fluxo manual (Codex, design review 2026-07-14):
 * NF cancelada no Omie nunca reconcilia e a varredura EXIGE a chave de acesso na resposta.
 */
function decidirEfeitoReconcileLote(
  cls: OmieClassificacao,
  body: unknown,
  esperado: { nIdReceb: number; chaveAcesso: string },
): EfeitoReconcile {
  if (!cls.sucesso) return { efeito: "pular", motivo: "consulta_falhou" };
  const cancelada = asRecord(asRecord(body).infoCadastro).cCancelada;
  if (typeof cancelada === "string" && cancelada.trim().toUpperCase() === "S") {
    return { efeito: "pular", motivo: "cancelada" };
  }
  const estado = extrairEstadoConsulta(body);
  if (estado.cChaveNfe == null) return { efeito: "pular", motivo: "identidade_divergente" };
  if (!validarIdentidade(estado, esperado).ok) return { efeito: "pular", motivo: "identidade_divergente" };
  const acao = decidirAcaoRecebimento(estado);
  if (acao === "reconciliar") return { efeito: "reconciliar" };
  if (acao === "inconsistente") return { efeito: "pular", motivo: "inconsistente" };
  return { efeito: "pular", motivo: "aguardando_conferencia" };
}

interface ResumoReconcileLote {
  processadas: number;
  reconciliadas: number;
  puladas: { consulta_falhou: number; cancelada: number; identidade_divergente: number; aguardando_conferencia: number; inconsistente: number };
}
function resumirReconcileLote(efeitos: EfeitoReconcile[]): ResumoReconcileLote {
  const resumo: ResumoReconcileLote = {
    processadas: efeitos.length,
    reconciliadas: 0,
    puladas: { consulta_falhou: 0, cancelada: 0, identidade_divergente: 0, aguardando_conferencia: 0, inconsistente: 0 },
  };
  for (const e of efeitos) {
    if (e.efeito === "reconciliar") resumo.reconciliadas++;
    else resumo.puladas[e.motivo]++;
  }
  return resumo;
}
// ════════════════════════════════════════════════════════════════════════════
// (fim do espelho)
// ════════════════════════════════════════════════════════════════════════════

interface WarehouseJoin { id?: string; code?: string; name?: string }
interface OmieCallSuccess { error: false; data: unknown }
interface OmieCallError { error: true; status?: number; data: unknown }
type OmieCallResult = OmieCallSuccess | OmieCallError;

/** Registra uma tentativa no ledger append-only (best-effort: nunca derruba o fluxo). */
async function registrarTentativa(
  supabase: SupabaseClient,
  row: { nfe_recebimento_id: string; tentativa: number; operacao: string; sucesso: boolean; erro?: string | null; omie_status?: string | null },
): Promise<void> {
  try {
    const { error } = await supabase.from("nfe_efetivacao_tentativas").insert(row);
    if (error) console.error("[omie-nfe-reconcile] erro PostgREST ao registrar tentativa no ledger:", error);
  } catch (e) {
    console.error("[omie-nfe-reconcile] exceção ao registrar tentativa no ledger:", e);
  }
}

// ── Retry with exponential backoff (mesmo padrão da edge omie-nfe-recebimento) ──
async function omieCall(
  url: string,
  payload: Record<string, unknown>,
  maxRetries = 3,
): Promise<OmieCallResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        if (attempt < maxRetries && res.status >= 500) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`[omie-nfe-reconcile] Omie ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return { error: true, status: res.status, data };
      }
      return { error: false, data };
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500;
        console.warn(`[omie-nfe-reconcile] Network error, retry ${attempt}/${maxRetries} in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return { error: true, data: { message: String(err) } };
    }
  }
  return { error: true, data: { message: "exhausted retries" } };
}

// ── Credential mapping by warehouse code (mesmo padrão da edge omie-nfe-recebimento) ──
function getOmieCredentials(warehouseCode: string): { appKey: string; appSecret: string } {
  if (warehouseCode === "CC") {
    return {
      appKey: Deno.env.get("OMIE_COLACOR_SC_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") ?? "",
    };
  }
  return {
    appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
  };
}

const RECEB_URL = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const LOCK_TTL_MIN = 5;
const TREGUA_MS = 1100;
const LIMITE_DEFAULT = 15;
const LIMITE_MAX = 15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405);
  }
  {
    const __auth = await authorizeCronOrStaff(req);
    if (!__auth.ok) return __auth.response;
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let limite = LIMITE_DEFAULT;
  try {
    const body = await req.json();
    const l = Number((body as Record<string, unknown> | null)?.limite);
    if (Number.isFinite(l)) limite = Math.min(LIMITE_MAX, Math.max(1, Math.trunc(l)));
  } catch { /* body vazio (cron) — usa default */ }

  try {
    // Mais antigas primeiro: são as que seguram o alerta ">24h" do painel.
    const { data: pendData, error: pendErr } = await supabase
      .from("nfe_recebimentos")
      .select("id, numero_nfe, omie_id_receb, chave_acesso, efetivacao_tentativas, warehouses(code)")
      .eq("status", "pendente")
      .not("omie_id_receb", "is", null)
      .not("chave_acesso", "is", null)
      .order("created_at", { ascending: true })
      .limit(limite);
    if (pendErr) {
      console.error("[omie-nfe-reconcile] erro ao listar pendentes:", pendErr);
      return jsonRes({ error: "Erro ao listar pendentes" }, 500);
    }
    const rows = (pendData ?? []) as Array<{
      id: string; numero_nfe: string; omie_id_receb: number; chave_acesso: string;
      efetivacao_tentativas: number | null; warehouses: WarehouseJoin | null;
    }>;

    const efeitos: EfeitoReconcile[] = [];
    const reconciliadasNfe: string[] = [];
    let puladasLock = 0;
    let puladasCredencial = 0;
    let estadoMudou = 0;
    let errosUpdate = 0;
    const errosConsulta: string[] = []; // amostra (até 3 distintos) do motivo de consulta_falhou

    for (let i = 0; i < rows.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, TREGUA_MS));
      const nfe = rows[i];

      const whCode = nfe.warehouses?.code ?? "OB";
      const creds = getOmieCredentials(whCode);
      if (!creds.appKey || !creds.appSecret) {
        puladasCredencial++;
        console.warn(`[omie-nfe-reconcile] NF ${nfe.numero_nfe}: credenciais ausentes p/ warehouse ${whCode}, pulando`);
        continue;
      }

      // Lock atômico compartilhado com a efetivação manual (RPC claim_nfe_efetivacao_lock,
      // compare-and-clear) — se um humano está efetivando esta NF agora, a varredura pula.
      const lockTs = new Date().toISOString();
      const cutoff = new Date(Date.now() - LOCK_TTL_MIN * 60_000).toISOString();
      const { data: claimRows, error: claimErr } = await supabase
        .rpc("claim_nfe_efetivacao_lock", { p_nfe_id: nfe.id, p_lock_ts: lockTs, p_cutoff: cutoff });
      if (claimErr || !claimRows || claimRows.length === 0) {
        puladasLock++;
        continue;
      }

      try {
        const consulta = await omieCall(RECEB_URL, {
          call: "ConsultarRecebimento",
          app_key: creds.appKey,
          app_secret: creds.appSecret,
          param: [{ nIdReceb: nfe.omie_id_receb, cChaveNfe: nfe.chave_acesso }],
        });
        const cls = classificarRespostaOmie({ httpOk: !consulta.error, status: consulta.error ? consulta.status : 200, body: consulta.data });
        const esperado = { nIdReceb: nfe.omie_id_receb, chaveAcesso: nfe.chave_acesso };
        const efeito = decidirEfeitoReconcileLote(cls, consulta.data, esperado);

        if (efeito.efeito === "reconciliar") {
          const tentativa = (nfe.efetivacao_tentativas ?? 0) + 1;
          // Compare-and-update (Codex P1): só reconcilia se a NF AINDA está 'pendente' e o
          // lock ainda é meu — se um humano moveu o status entre o SELECT e aqui, 0 linhas.
          const { data: updRows, error: updErr } = await supabase.from("nfe_recebimentos").update({
            status: "efetivado", efetivado_at: new Date().toISOString(),
            alterar_recebimento_ok: true, alterar_etapa_ok: true, concluir_recebimento_ok: true,
            efetivacao_erro: null, efetivacao_tentativas: tentativa,
          }).eq("id", nfe.id).eq("status", "pendente").eq("efetivacao_lock_at", lockTs).select("id");
          if (updErr) {
            errosUpdate++;
            console.error(`[omie-nfe-reconcile] NF ${nfe.numero_nfe}: erro ao marcar efetivado:`, updErr);
            continue;
          }
          if (!updRows || updRows.length === 0) {
            estadoMudou++;
            console.warn(`[omie-nfe-reconcile] NF ${nfe.numero_nfe}: estado mudou entre o SELECT e o update — pulada.`);
            continue;
          }
          efeitos.push(efeito); // só conta como reconciliada com o update confirmado
          await registrarTentativa(supabase, { nfe_recebimento_id: nfe.id, tentativa, operacao: "reconciliado_auto", sucesso: true, erro: null, omie_status: null });
          reconciliadasNfe.push(nfe.numero_nfe);
          console.log(`[omie-nfe-reconcile] NF ${nfe.numero_nfe} reconciliada (já recebida no Omie).`);
          continue;
        }

        efeitos.push(efeito);
        if (efeito.motivo === "identidade_divergente") {
          // Grave o bastante pra deixar rastro no ledger, mas o status/painel ficam intactos.
          const erroIdent = validarIdentidade(extrairEstadoConsulta(consulta.data), esperado).erro ?? "identidade não confere";
          await registrarTentativa(supabase, { nfe_recebimento_id: nfe.id, tentativa: nfe.efetivacao_tentativas ?? 0, operacao: "reconcile_identidade", sucesso: false, erro: erroIdent, omie_status: null });
          console.warn(`[omie-nfe-reconcile] NF ${nfe.numero_nfe}: ${erroIdent} — pulada.`);
        } else if (efeito.motivo === "consulta_falhou") {
          // Observabilidade (lição 2026-07-16: 15/15 consultas falharam e o MOTIVO não era
          // visível de fora — só contadores). Amostra na resposta → fica em net._http_response,
          // legível via psql-ro sem depender de clique/log; warn por NF cobre o resto.
          const erroConsulta = `${cls.erro ?? "erro desconhecido"}${cls.omieStatus ? ` (omie_status ${cls.omieStatus})` : ""}`;
          if (errosConsulta.length < 3 && !errosConsulta.includes(erroConsulta)) errosConsulta.push(erroConsulta);
          console.warn(`[omie-nfe-reconcile] NF ${nfe.numero_nfe}: consulta falhou — ${erroConsulta}`);
        }
      } finally {
        // libera o lock só se ainda é o MEU (compare-and-clear pelo timestamp gravado)
        await supabase.from("nfe_recebimentos")
          .update({ efetivacao_lock_at: null })
          .eq("id", nfe.id)
          .eq("efetivacao_lock_at", lockTs);
      }
    }

    const resumo = resumirReconcileLote(efeitos);
    const { count: restantes } = await supabase
      .from("nfe_recebimentos")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendente");

    console.log(`[omie-nfe-reconcile] lote=${rows.length} reconciliadas=${resumo.reconciliadas} aguardando=${resumo.puladas.aguardando_conferencia} falha_consulta=${resumo.puladas.consulta_falhou} canceladas=${resumo.puladas.cancelada} inconsistentes=${resumo.puladas.inconsistente} identidade=${resumo.puladas.identidade_divergente} lock=${puladasLock} estado_mudou=${estadoMudou} erros_update=${errosUpdate} restantes_pendentes=${restantes ?? "?"}`);

    return jsonRes({
      success: true,
      lote: rows.length,
      ...resumo,
      puladas_lock: puladasLock,
      puladas_credencial: puladasCredencial,
      estado_mudou: estadoMudou,
      erros_update: errosUpdate,
      amostra_erros_consulta: errosConsulta,
      reconciliadas_nfe: reconciliadasNfe,
      restantes_pendentes: restantes ?? null,
    });
  } catch (err) {
    console.error("[omie-nfe-reconcile] Erro inesperado:", err);
    return jsonRes({ error: "Erro interno", details: String(err) }, 500);
  }
});
