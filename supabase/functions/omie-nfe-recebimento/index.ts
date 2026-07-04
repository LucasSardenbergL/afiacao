import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Local interfaces (Edge Functions bundle independently — no shared types) ──

interface OmieCallSuccess {
  error: false;
  data: unknown;
}

interface OmieCallError {
  error: true;
  status?: number;
  data: unknown;
}

type OmieCallResult = OmieCallSuccess | OmieCallError;

interface WarehouseJoin {
  id?: string;
  code?: string;
  name?: string;
}

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ESPELHO VERBATIM de src/lib/recebimento/efetivacao-helpers.ts
// (Edge Functions não importam de src/; manter sincronizado byte-a-byte.)
// ════════════════════════════════════════════════════════════════════════════
interface OmieClassificacao { sucesso: boolean; erro: string | null; omieStatus: string | null; }
type EfetivacaoStatus = "efetivado" | "falha_efetivacao" | "efetivacao_parcial";
interface PassoFlags {
  alterarOk: boolean; etapaOk: boolean; concluirOk: boolean;
  cteAplicavel: boolean; cteOk: boolean; ajustesTentados: number; ajustesOk: number;
}
interface ItemOmie {
  nSequencia: number; nIdProduto: number | null; cCodigoProduto: string | null;
  nQtdeNFe: number; nQtdeRecebida: number | null; cUnidadeNfe: string | null;
  cIgnorarItem: boolean; nFatorConversao: number | null;
}
interface ItemApp {
  sequencia: number; produto_omie_id: number | null; quantidade_conferida: number;
  quantidade_convertida: number | null; status_item: string; unidade_nfe: string | null; unidade_estoque: string | null;
}
interface ItemEditar { itensIde: { nSequencia: number; cAcao: "EDITAR" }; itensAjustes: { nQtdeRecebida: number }; }
interface ItemPretendido { nSequencia: number; nIdProduto: number | null; nQtdeRecebida: number; }
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

const BENIGNOS: Record<string, RegExp[]> = {
  alterar_etapa: [/j[áa]\s+est[áa]\s+(na|nesta|nessa)?\s*etapa/i, /mesma\s+etapa/i, /etapa\s+(atual|j[áa])/i],
  concluir_recebimento: [/j[áa]\s+(foi\s+)?conclu/i, /j[áa]\s+(foi\s+)?efetiv/i, /recebimento\s+conclu/i],
};
function erroBenigno(faultstring: string | null | undefined, operacao: string): boolean {
  const fs = (faultstring ?? "").trim();
  if (!fs) return false;
  const pats = BENIGNOS[operacao];
  return pats ? pats.some((re) => re.test(fs)) : false;
}

function decidirStatusEfetivacao(f: PassoFlags): EfetivacaoStatus {
  const ajustesCompletos = f.ajustesOk >= f.ajustesTentados;
  const cteCompleto = !f.cteAplicavel || f.cteOk;
  const todosOk = f.alterarOk && f.etapaOk && f.concluirOk && cteCompleto && ajustesCompletos;
  if (todosOk) return "efetivado";
  const algumEfeito = f.alterarOk || f.etapaOk || f.concluirOk || (f.cteAplicavel && f.cteOk) || f.ajustesOk > 0;
  return algumEfeito ? "efetivacao_parcial" : "falha_efetivacao";
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
function normUnidade(u: string | null): string {
  return (u ?? "").trim().toUpperCase();
}
function detectarConversao(itensOmie: ItemOmie[], itensApp: ItemApp[]): { temConversao: boolean; motivo: string | null } {
  if (itensOmie.some((i) => i.nFatorConversao != null && Math.abs(i.nFatorConversao - 1) > 1e-9)) {
    return { temConversao: true, motivo: "fator de conversão ≠ 1 no Omie" };
  }
  if (itensApp.some((i) => i.quantidade_convertida != null)) {
    return { temConversao: true, motivo: "quantidade convertida preenchida no app" };
  }
  if (itensApp.some((i) => i.unidade_estoque != null && i.unidade_nfe != null && normUnidade(i.unidade_nfe) !== normUnidade(i.unidade_estoque))) {
    return { temConversao: true, motivo: "unidade da NF ≠ unidade de estoque" };
  }
  return { temConversao: false, motivo: null };
}
function cruzarItensParaEscrita(
  itensOmie: ItemOmie[],
  itensApp: ItemApp[],
): { ok: boolean; erro: string | null; itensEditar: ItemEditar[]; pretendidos: ItemPretendido[] } {
  const vazio = { itensEditar: [] as ItemEditar[], pretendidos: [] as ItemPretendido[] };
  const omieAtivos = itensOmie.filter((i) => !i.cIgnorarItem);
  const omieBySeq = new Map<number, ItemOmie>(omieAtivos.map((i) => [i.nSequencia, i]));
  if (itensApp.length !== omieAtivos.length) {
    return { ok: false, erro: `contagem de itens diverge (app ${itensApp.length} ≠ Omie ${omieAtivos.length})`, ...vazio };
  }
  const editar: ItemEditar[] = [];
  const pretendidos: ItemPretendido[] = [];
  for (const app of itensApp) {
    if (app.status_item !== "conferido") {
      return { ok: false, erro: `item seq ${app.sequencia} não conferido (status ${app.status_item})`, ...vazio };
    }
    if (!Number.isFinite(app.quantidade_conferida) || app.quantidade_conferida < 0) {
      return { ok: false, erro: `item seq ${app.sequencia} com quantidade conferida inválida`, ...vazio };
    }
    if (app.produto_omie_id == null) {
      return { ok: false, erro: `item seq ${app.sequencia} sem produto associado no app`, ...vazio };
    }
    const omie = omieBySeq.get(app.sequencia);
    if (!omie) return { ok: false, erro: `item seq ${app.sequencia} sem par no Omie`, ...vazio };
    if (omie.nIdProduto == null || omie.nIdProduto !== app.produto_omie_id) {
      return { ok: false, erro: `produto diverge na seq ${app.sequencia} (app ${app.produto_omie_id} ≠ Omie ${omie.nIdProduto})`, ...vazio };
    }
    editar.push({ itensIde: { nSequencia: app.sequencia, cAcao: "EDITAR" }, itensAjustes: { nQtdeRecebida: app.quantidade_conferida } });
    pretendidos.push({ nSequencia: app.sequencia, nIdProduto: app.produto_omie_id, nQtdeRecebida: app.quantidade_conferida });
  }
  editar.sort((a, b) => a.itensIde.nSequencia - b.itensIde.nSequencia);
  pretendidos.sort((a, b) => a.nSequencia - b.nSequencia);
  return { ok: true, erro: null, itensEditar: editar, pretendidos };
}
function validarGatesEscrita(input: { statusApp: string; temLoteEscaneado: boolean; temConversao: boolean; motivoConversao: string | null }): { ok: boolean; erro: string | null } {
  if (input.statusApp !== "conferido") {
    return { ok: false, erro: `status "${input.statusApp}" — confira a NF no app antes de efetivar` };
  }
  if (input.temLoteEscaneado) {
    return { ok: false, erro: "NF com lote/validade escaneado — fluxo de lote não automatizado (follow-up)" };
  }
  if (input.temConversao) {
    return { ok: false, erro: input.motivoConversao ?? "NF com conversão de unidade — não automatizado (follow-up)" };
  }
  return { ok: true, erro: null };
}
function confirmarEfetivacao(
  estadoReconsulta: EstadoConsulta,
  esperado: { chaveAcesso: string; pretendidos: ItemPretendido[] },
): { confirmado: boolean; divergencias: string[] } {
  const div: string[] = [];
  const rec = (estadoReconsulta.cRecebido ?? "").trim().toUpperCase();
  if (rec !== "S") div.push("cRecebido ≠ S no Omie após a conclusão");
  if (estadoReconsulta.cChaveNfe != null && estadoReconsulta.cChaveNfe !== esperado.chaveAcesso) {
    div.push("chave de acesso diverge na reconsulta");
  }
  const omieBySeq = new Map<number, ItemOmie>(estadoReconsulta.itensOmie.map((i) => [i.nSequencia, i]));
  for (const p of esperado.pretendidos) {
    const o = omieBySeq.get(p.nSequencia);
    if (!o) { div.push(`seq ${p.nSequencia}: ausente na reconsulta`); continue; }
    if (o.nIdProduto !== p.nIdProduto) div.push(`seq ${p.nSequencia}: produto ${o.nIdProduto} ≠ ${p.nIdProduto}`);
    if (asNum(o.nQtdeRecebida) !== asNum(p.nQtdeRecebida)) div.push(`seq ${p.nSequencia}: qtd recebida ${o.nQtdeRecebida} ≠ ${p.nQtdeRecebida}`);
  }
  return { confirmado: div.length === 0, divergencias: div };
}
function decidirStatusComConfirmacao(flags: PassoFlags, recebidoConfirmado: boolean): EfetivacaoStatus {
  const s = decidirStatusEfetivacao(flags);
  if (s === "efetivado" && !recebidoConfirmado) return "efetivacao_parcial";
  return s;
}
function resumirErros(falhas: { operacao: string; erro: string }[], max = 500): string {
  const txt = falhas.map((f) => `${f.operacao}: ${f.erro}`).join(" | ");
  if (txt.length <= max) return txt;
  return txt.slice(0, Math.max(0, max - 1)) + "…";
}

/** Registra uma tentativa no ledger append-only (best-effort: nunca derruba o fluxo). */
async function registrarTentativa(
  supabase: SupabaseClient,
  row: { nfe_recebimento_id: string; tentativa: number; operacao: string; item_id?: string | null; sucesso: boolean; erro?: string | null; omie_status?: string | null },
): Promise<void> {
  try {
    const { error } = await supabase.from("nfe_efetivacao_tentativas").insert(row);
    if (error) console.error("[omie-nfe-recebimento] erro PostgREST ao registrar tentativa no ledger:", error);
  } catch (e) {
    console.error("[omie-nfe-recebimento] exceção ao registrar tentativa no ledger:", e);
  }
}

// ── Retry with exponential backoff ──
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
        // Omie returns 500 for many transient errors
        if (attempt < maxRetries && res.status >= 500) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`[omie-nfe-recebimento] Omie ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return { error: true, status: res.status, data };
      }
      return { error: false, data };
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500;
        console.warn(`[omie-nfe-recebimento] Network error, retry ${attempt}/${maxRetries} in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return { error: true, data: { message: String(err) } };
    }
  }
  // Unreachable — loop always returns inside; satisfies TS control flow analysis.
  return { error: true, data: { message: "exhausted retries" } };
}

// ── Credential mapping by warehouse code ──
function getOmieCredentials(warehouseCode: string): { appKey: string; appSecret: string } {
  if (warehouseCode === "CC") {
    // CC = Colacor SC (afiação)
    return {
      appKey: Deno.env.get("OMIE_COLACOR_SC_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") ?? "",
    };
  }
  // OB (Oben) - default
  return {
    appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "Method not allowed" }, 405);
  }

  // ── Auth check ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsErr } = await supabaseAuth.auth.getClaims(token);
  if (claimsErr || !claimsData?.claims) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  // SECURITY: staff-only — fixes privilege escalation that allowed any
  // authenticated user to finalize NF-e receiving via service_role.
  const callerUserId = (claimsData.claims as { sub?: string }).sub;
  if (!callerUserId) return jsonRes({ error: "Unauthorized" }, 401);
  const { data: callerRoles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId);
  const allowed = new Set(["employee", "master"]);
  if (!(callerRoles ?? []).some((r: { role: string }) => allowed.has(r.role))) {
    return jsonRes({ error: "Forbidden" }, 403);
  }

  try {
    const body = await req.json();
    const nfeRecebimentoId: string = body.nfe_recebimento_id;
    if (!nfeRecebimentoId) {
      return jsonRes({ error: "nfe_recebimento_id obrigatório" }, 400);
    }

    // ── A0: modo DIAGNÓSTICO read-only ──
    // Lê o estado real do recebimento no Omie (ConsultarRecebimento) SEM escrever nada.
    // Pro founder ver os campos reais (etapa/kanban, itens, datas, lote, CT-e) antes de
    // qualquer efetivação (Fase A1). É o de-risk "diagnóstico-first" (Codex).
    if (body.diagnostico === true) {
      const { data: nfeDiag, error: nfeDiagErr } = await supabase
        .from("nfe_recebimentos")
        .select("omie_id_receb, numero_nfe, status, efetivacao_tentativas, warehouses(code)")
        .eq("id", nfeRecebimentoId)
        .single();
      if (nfeDiagErr || !nfeDiag) {
        return jsonRes({ error: "NF-e não encontrada" }, 404);
      }
      if (!nfeDiag.omie_id_receb) {
        return jsonRes({ error: "omie_id_receb ausente — NF-e não importada pelo Omie" }, 400);
      }
      const whCode = (nfeDiag.warehouses as WarehouseJoin | null)?.code ?? "OB";
      const credD = getOmieCredentials(whCode);
      if (!credD.appKey || !credD.appSecret) {
        return jsonRes({ error: `Credenciais Omie não configuradas para warehouse ${whCode}` }, 500);
      }
      console.log(`[omie-nfe-recebimento] DIAGNÓSTICO read-only nIdReceb=${nfeDiag.omie_id_receb}`);
      const consultaRes = await omieCall(
        "https://app.omie.com.br/api/v1/produtos/recebimentonfe/",
        {
          call: "ConsultarRecebimento",
          app_key: credD.appKey,
          app_secret: credD.appSecret,
          param: [{ nIdReceb: nfeDiag.omie_id_receb }],
        },
      );
      const cls = classificarRespostaOmie({
        httpOk: !consultaRes.error,
        status: consultaRes.error ? consultaRes.status : 200,
        body: consultaRes.data,
      });
      await registrarTentativa(supabase, {
        nfe_recebimento_id: nfeRecebimentoId,
        tentativa: (nfeDiag.efetivacao_tentativas as number) ?? 0,
        operacao: "diagnostico",
        sucesso: cls.sucesso,
        erro: cls.erro,
        omie_status: cls.omieStatus,
      });
      return jsonRes({
        ok: cls.sucesso,
        modo: "diagnostico",
        nfe_recebimento_id: nfeRecebimentoId,
        numero_nfe: nfeDiag.numero_nfe,
        status_app: nfeDiag.status,
        warehouse: whCode,
        omie_id_receb: nfeDiag.omie_id_receb,
        classificacao: cls,
        consultar_recebimento: consultaRes.data, // JSON CRU do Omie (campos reais)
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // A1 — efetivação honesta: consultar ANTES → reconciliar | escrever | inconsistente
    // Lock atômico (token = o próprio efetivacao_lock_at gravado, compare-and-clear).
    // Fail-closed por passo + ledger. NF simples (sem lote/conversão) — gates fortes.
    // ════════════════════════════════════════════════════════════════════════
    console.log(`[omie-nfe-recebimento] Efetivação A1: ${nfeRecebimentoId}`);
    const RECEB_URL = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
    const LOCK_TTL_MIN = 5;

    // ── Claim do lock (atômico): só pega se livre ou expirado (TTL 5 min) ──
    const lockTs = new Date().toISOString();
    const cutoff = new Date(Date.now() - LOCK_TTL_MIN * 60_000).toISOString();
    // RPC SQL-pura (claim_nfe_efetivacao_lock): o PostgREST QUEBRA .or() em UPDATE com 42703.
    // UPDATE...WHERE...RETURNING é atômico (row lock) — só o primeiro concorrente casa o predicado.
    const { data: claimRows, error: claimErr } = await supabase
      .rpc("claim_nfe_efetivacao_lock", {
        p_nfe_id: nfeRecebimentoId,
        p_lock_ts: lockTs,
        p_cutoff: cutoff,
      });
    if (claimErr) {
      console.error("[omie-nfe-recebimento] erro ao reservar a efetivação:", claimErr);
      return jsonRes({ error: "Erro ao reservar a efetivação" }, 500);
    }
    if (!claimRows || claimRows.length === 0) {
      return jsonRes({ error: "Efetivação já em andamento para esta NF-e", modo: "lock" }, 409);
    }

    try {
      // ── Fetch NF-e (campos do ledger + identidade) ──
      const { data: nfe, error: nfeErr } = await supabase
        .from("nfe_recebimentos")
        .select("id, numero_nfe, status, omie_id_receb, chave_acesso, cnpj_emitente, efetivacao_tentativas, alterar_recebimento_ok, alterar_etapa_ok, concluir_recebimento_ok, warehouses(code)")
        .eq("id", nfeRecebimentoId)
        .single();
      if (nfeErr || !nfe) return jsonRes({ error: "NF-e não encontrada" }, 404);
      if (!nfe.omie_id_receb) return jsonRes({ error: "omie_id_receb ausente — NF-e não importada pelo Omie" }, 400);

      const tentativa = ((nfe.efetivacao_tentativas as number | null) ?? 0) + 1;
      await supabase.from("nfe_recebimentos").update({ efetivacao_tentativas: tentativa }).eq("id", nfeRecebimentoId);

      const whCode = (nfe.warehouses as WarehouseJoin | null)?.code ?? "OB";
      const creds = getOmieCredentials(whCode);
      if (!creds.appKey || !creds.appSecret) {
        return jsonRes({ error: `Credenciais Omie não configuradas para warehouse ${whCode}` }, 500);
      }
      const nIdReceb = nfe.omie_id_receb as number;
      const chaveAcesso = (nfe.chave_acesso as string) ?? "";
      const callReceb = (call: string, param: Record<string, unknown>) =>
        omieCall(RECEB_URL, { call, app_key: creds.appKey, app_secret: creds.appSecret, param: [param] });

      const persistir = async (status: string, erro: string | null) => {
        const patch: Record<string, unknown> = { status, efetivacao_erro: erro };
        if (status === "efetivado") patch.efetivado_at = new Date().toISOString();
        await supabase.from("nfe_recebimentos").update(patch).eq("id", nfeRecebimentoId);
      };
      const falhaOp = async (operacao: string, erro: string) => {
        await persistir("falha_efetivacao", `${operacao}: ${erro}`);
        await registrarTentativa(supabase, { nfe_recebimento_id: nfeRecebimentoId, tentativa, operacao, sucesso: false, erro, omie_status: null });
        return jsonRes({ success: false, modo: "falha_efetivacao", nfe_recebimento_id: nfeRecebimentoId, numero_nfe: nfe.numero_nfe, erro }, 200);
      };

      // ── 1. Consultar ANTES (com a chave como filtro de identidade) ──
      const consulta1 = await callReceb("ConsultarRecebimento", { nIdReceb, cChaveNfe: chaveAcesso });
      const cls1 = classificarRespostaOmie({ httpOk: !consulta1.error, status: consulta1.error ? consulta1.status : 200, body: consulta1.data });
      await registrarTentativa(supabase, { nfe_recebimento_id: nfeRecebimentoId, tentativa, operacao: "consultar", sucesso: cls1.sucesso, erro: cls1.erro, omie_status: cls1.omieStatus });
      if (!cls1.sucesso) return await falhaOp("consultar", cls1.erro ?? "erro na consulta");
      const estado = extrairEstadoConsulta(consulta1.data);

      // ── 2. Identidade (Codex P1.1) ──
      const ident = validarIdentidade(estado, { nIdReceb, chaveAcesso });
      if (!ident.ok) return await falhaOp("identidade", ident.erro ?? "identidade não confere");

      // ── 3. Bifurcação tríplice ──
      const acao = decidirAcaoRecebimento(estado);

      if (acao === "reconciliar") {
        await supabase.from("nfe_recebimentos").update({
          status: "efetivado", efetivado_at: new Date().toISOString(),
          alterar_recebimento_ok: true, alterar_etapa_ok: true, concluir_recebimento_ok: true, efetivacao_erro: null,
        }).eq("id", nfeRecebimentoId);
        await registrarTentativa(supabase, { nfe_recebimento_id: nfeRecebimentoId, tentativa, operacao: "reconciliado", sucesso: true, erro: null, omie_status: null });
        console.log(`[omie-nfe-recebimento] NF ${nfe.numero_nfe} reconciliada (já recebida no Omie).`);
        return jsonRes({ success: true, modo: "reconciliado", nfe_recebimento_id: nfeRecebimentoId, numero_nfe: nfe.numero_nfe }, 200);
      }
      if (acao === "inconsistente") {
        return await falhaOp("inconsistente", "etapa 80 sem cRecebido=S no Omie — requer conferência/recebimento manual");
      }

      // ── acao === "escrever" — gates fortes ANTES de qualquer write ──
      // itens app (fail-closed)
      const { data: itensData, error: itensErr } = await supabase
        .from("nfe_recebimento_itens")
        .select("id, sequencia, produto_omie_id, quantidade_conferida, quantidade_convertida, status_item, unidade_nfe, unidade_estoque")
        .eq("nfe_recebimento_id", nfeRecebimentoId)
        .order("sequencia");
      if (itensErr) return await falhaOp("ler_itens", itensErr.message);
      const itensRows = (itensData ?? []) as Array<{
        id: string; sequencia: number; produto_omie_id: number | null; quantidade_conferida: number;
        quantidade_convertida: number | null; status_item: string; unidade_nfe: string | null; unidade_estoque: string | null;
      }>;
      if (itensRows.length === 0) return await falhaOp("itens", "sem itens conferidos no app");
      const itensApp: ItemApp[] = itensRows.map((r) => ({
        sequencia: r.sequencia, produto_omie_id: r.produto_omie_id, quantidade_conferida: r.quantidade_conferida,
        quantidade_convertida: r.quantidade_convertida, status_item: r.status_item, unidade_nfe: r.unidade_nfe, unidade_estoque: r.unidade_estoque,
      }));

      // lote escaneado (fail-closed) — nfe_lotes_escaneados é por nfe_recebimento_item_id (Codex)
      // count/data nulo SEM error também é fail-closed (não vira "sem lote" silencioso → entrada sem rastreabilidade).
      const itemIds = itensRows.map((r) => r.id);
      const { count: loteCount, error: loteErr } = await supabase
        .from("nfe_lotes_escaneados")
        .select("nfe_recebimento_item_id", { count: "exact", head: true })
        .in("nfe_recebimento_item_id", itemIds);
      if (loteErr) return await falhaOp("ler_lotes", loteErr.message);
      if (loteCount == null) return await falhaOp("ler_lotes", "contagem de lotes indisponível (fail-closed)");
      const temLoteEscaneado = loteCount > 0;

      // conversão por CNPJ (fail-closed) — reforço do gate por fator. CNPJ ausente NÃO permite
      // confirmar ausência de conversão → falha (NF-e sempre tem emitente; vazio = dado incompleto).
      const cnpjClean = (nfe.cnpj_emitente as string | null ?? "").replace(/\D/g, "");
      if (!cnpjClean) return await falhaOp("conversao", "NF sem CNPJ do emitente — não é possível verificar conversão de unidade");
      const { data: convData, error: convErr } = await supabase
        .from("conversao_unidades").select("id").eq("cnpj_fornecedor", cnpjClean).eq("is_active", true).limit(1);
      if (convErr) return await falhaOp("ler_conversoes", convErr.message);
      if (!Array.isArray(convData)) return await falhaOp("ler_conversoes", "consulta de conversões indisponível (fail-closed)");
      const temConversaoCnpj = convData.length > 0;
      const conv = detectarConversao(estado.itensOmie, itensApp);
      const temConversao = conv.temConversao || temConversaoCnpj;
      const motivoConversao = conv.motivo ?? (temConversaoCnpj ? "fornecedor com conversão de unidade cadastrada" : null);

      const gates = validarGatesEscrita({ statusApp: (nfe.status as string) ?? "", temLoteEscaneado, temConversao, motivoConversao });
      if (!gates.ok) return await falhaOp("gate", gates.erro ?? "pré-condição não atendida");

      const cz = cruzarItensParaEscrita(estado.itensOmie, itensApp);
      if (!cz.ok) return await falhaOp("cruzar_itens", cz.erro ?? "itens incompatíveis");

      // ── Coreografia (retoma só os passos sem flag ok) ──
      const flags: PassoFlags = {
        alterarOk: (nfe.alterar_recebimento_ok as boolean | null) ?? false,
        etapaOk: (nfe.alterar_etapa_ok as boolean | null) ?? false,
        concluirOk: (nfe.concluir_recebimento_ok as boolean | null) ?? false,
        cteAplicavel: false, cteOk: false, ajustesTentados: 0, ajustesOk: 0,
      };
      const falhas: { operacao: string; erro: string }[] = [];
      const executarPasso = async (operacao: string, flagCol: string, run: () => Promise<OmieCallResult>): Promise<boolean> => {
        const res = await run();
        const cls = classificarRespostaOmie({ httpOk: !res.error, status: res.error ? res.status : 200, body: res.data });
        let sucesso = cls.sucesso;
        if (!sucesso && erroBenigno(cls.erro, operacao)) sucesso = true;
        await registrarTentativa(supabase, { nfe_recebimento_id: nfeRecebimentoId, tentativa, operacao, sucesso, erro: sucesso ? null : cls.erro, omie_status: cls.omieStatus });
        if (sucesso) await supabase.from("nfe_recebimentos").update({ [flagCol]: true }).eq("id", nfeRecebimentoId);
        else falhas.push({ operacao, erro: cls.erro ?? "erro" });
        return sucesso;
      };
      const pararParcial = async () => {
        const status = decidirStatusEfetivacao(flags);
        await persistir(status, resumirErros(falhas));
        return jsonRes({ success: false, modo: status, nfe_recebimento_id: nfeRecebimentoId, numero_nfe: nfe.numero_nfe, erro: resumirErros(falhas) }, 200);
      };

      if (!flags.alterarOk) {
        flags.alterarOk = await executarPasso("alterar_recebimento", "alterar_recebimento_ok", () =>
          callReceb("AlterarRecebimento", { ide: { nIdReceb }, itensRecebimentoEditar: cz.itensEditar }));
        if (!flags.alterarOk) return await pararParcial();
      }
      if (!flags.etapaOk) {
        flags.etapaOk = await executarPasso("alterar_etapa", "alterar_etapa_ok", () =>
          callReceb("AlterarEtapaRecebimento", { nIdReceb, cChaveNfe: chaveAcesso, cEtapa: "40" }));
        if (!flags.etapaOk) return await pararParcial();
      }
      if (!flags.concluirOk) {
        flags.concluirOk = await executarPasso("concluir_recebimento", "concluir_recebimento_ok", () =>
          callReceb("ConcluirRecebimento", { nIdReceb, cChaveNfe: chaveAcesso }));
        if (!flags.concluirOk) return await pararParcial();
      }

      // ── 4. Reconsulta — juiz final (cRecebido=S + quantidades), com retry/backoff p/ lag do Omie ──
      const RECONSULTA_TENTATIVAS = 4;
      let conf = { confirmado: false, divergencias: ["reconsulta não realizada"] as string[] };
      for (let r = 1; r <= RECONSULTA_TENTATIVAS; r++) {
        const consulta2 = await callReceb("ConsultarRecebimento", { nIdReceb, cChaveNfe: chaveAcesso });
        const cls2 = classificarRespostaOmie({ httpOk: !consulta2.error, status: consulta2.error ? consulta2.status : 200, body: consulta2.data });
        if (cls2.sucesso) {
          conf = confirmarEfetivacao(extrairEstadoConsulta(consulta2.data), { chaveAcesso, pretendidos: cz.pretendidos });
          if (conf.confirmado) break;
        } else {
          conf = { confirmado: false, divergencias: [`reconsulta: ${cls2.erro}`] };
        }
        if (r < RECONSULTA_TENTATIVAS) await new Promise((res) => setTimeout(res, 1000 * r));
      }
      await registrarTentativa(supabase, { nfe_recebimento_id: nfeRecebimentoId, tentativa, operacao: "reconsultar", sucesso: conf.confirmado, erro: conf.confirmado ? null : conf.divergencias.join(" | "), omie_status: null });

      const statusFinal = decidirStatusComConfirmacao(flags, conf.confirmado);
      const erroFinal = statusFinal === "efetivado"
        ? null
        : resumirErros([...falhas, ...conf.divergencias.map((d) => ({ operacao: "reconsulta", erro: d }))]);
      await persistir(statusFinal, erroFinal);
      console.log(`[omie-nfe-recebimento] NF ${nfe.numero_nfe} → ${statusFinal}.`);
      return jsonRes({
        success: statusFinal === "efetivado",
        modo: statusFinal,
        nfe_recebimento_id: nfeRecebimentoId,
        numero_nfe: nfe.numero_nfe,
        divergencias: conf.confirmado ? [] : conf.divergencias,
      }, 200);
    } finally {
      // libera o lock só se ainda é o MEU (compare-and-clear pelo timestamp gravado — Codex P1.7)
      await supabase.from("nfe_recebimentos")
        .update({ efetivacao_lock_at: null })
        .eq("id", nfeRecebimentoId)
        .eq("efetivacao_lock_at", lockTs);
    }
  } catch (err) {
    console.error("[omie-nfe-recebimento] Erro inesperado:", err);
    return jsonRes({ error: "Erro interno", details: String(err) }, 500);
  }
});
