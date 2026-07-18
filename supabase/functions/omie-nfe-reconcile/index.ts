// omie-nfe-reconcile — varredura de reconciliação (reconcile-only, idempotente). v3.
//
// PROBLEMA: a operação dá entrada das NF-e DIRETO no Omie (humano), e o app nunca
// fica sabendo — as NFs importadas ficam 'pendente' eternas no painel de recebimento.
// Esta edge alinha o app com a realidade do Omie SEM escrever nada no Omie.
//
// HISTÓRICO DO DESENHO:
// - v1 (consulta por NF, trégua 1.1s): 15/15 REDUNDANT em 3 rodadas — a trava
//   anti-redundância do Omie morde o MÉTODO ConsultarRecebimento por conta
//   (provado: params distintos a 4s → REDUNDANT), e o retry em 5xx renovava o timer.
// - v2 (listagem + confirmação espaçada 61s): descartada no design review (Codex):
//   2×61s no caminho síncrono de 150s é frágil, e até a paginação do mesmo método
//   pode conflitar com a trava.
// - v3: ListarRecebimentos traz cabec.cChaveNfe (doc oficial) → IDENTIDADE
//   FORTE direto da listagem, SEM ConsultarRecebimento nenhum. 1ª rodada em prod
//   (2026-07-16 23:10 UTC): transporte OK (zero REDUNDANT), mas janela ÚNICA de 60d
//   ancorada na pendente mais antiga (janeiro) deixou 15/24 "fora_da_listagem".
// - v3.1 (ATUAL): janelas de emissão CONSECUTIVAS e disjuntas (até 4 por conta,
//   trégua 1.5s entre chamadas — o import v2 pagina o mesmo método sem trava) da
//   pendente mais antiga até hoje/maior emissão → cruzamento forte (conta exata +
//   nIdReceb + chave 44 idêntica + cRecebido=S + não-cancelada + cardinalidade 1:1)
//   → reconciliação em lote com lock + compare-and-update.
//   Dúvida de identidade NUNCA reconcilia (fail-closed); falha visível no painel é
//   reservada à ação humana (Efetivar/Reprocessar na edge omie-nfe-recebimento).
//
// Chamada: cron (x-cron-secret) ou staff. Body opcional: { limite?: number } (1..25, default 25).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ESPELHO VERBATIM (subset usado pela v3) de src/lib/recebimento/efetivacao-helpers.ts
// (Edge Functions bundle independently — manter sincronizado com o src.)
// ════════════════════════════════════════════════════════════════════════════
interface OmieClassificacao { sucesso: boolean; erro: string | null; omieStatus: string | null; }

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
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

/** A trava do Omie: re-tentar renova o timer — retry PRECISA parar neste erro. */
function ehErroRedundante(erro: string | null | undefined): boolean {
  if (!erro) return false;
  return /redundant|redundante/i.test(erro);
}

interface EstadoListagem {
  recebido: boolean;
  cancelada: boolean;
  /** cChaveNfe/cChaveNFe do cabec da listagem (identidade forte), quando presente. */
  chave: string | null;
  /** nIdReceb apareceu mais de uma vez na listagem → fail-closed no cruzamento. */
  duplicado: boolean;
}

/**
 * Extrai de páginas do ListarRecebimentos o mapa nIdReceb → {recebido, cancelada, chave}.
 * Parse defensivo: nIdReceb no cabec OU na raiz, string ou number; chave em ambas as
 * grafias (cChaveNfe/cChaveNFe); página malformada é ignorada (nunca lança — a decisão
 * fail-closed acontece no cruzamento). nIdReceb repetido → marcado `duplicado`.
 */
function extrairRecebidosDaListagem(paginas: unknown[]): Map<number, EstadoListagem> {
  const mapa = new Map<number, EstadoListagem>();
  for (const pagina of paginas) {
    const recs = asRecord(pagina).recebimentos;
    if (!Array.isArray(recs)) continue;
    for (const raw of recs) {
      const rec = asRecord(raw);
      const cabec = asRecord(rec.cabec);
      const id = Number(cabec.nIdReceb ?? rec.nIdReceb);
      if (!Number.isFinite(id) || id <= 0) continue;
      const info = asRecord(rec.infoCadastro);
      const chaveRaw = cabec.cChaveNfe ?? cabec.cChaveNFe;
      const estado: EstadoListagem = {
        recebido: String(info.cRecebido ?? "").trim().toUpperCase() === "S",
        cancelada: String(info.cCancelada ?? "").trim().toUpperCase() === "S",
        chave: typeof chaveRaw === "string" && chaveRaw.trim() !== "" ? chaveRaw.trim() : null,
        duplicado: false,
      };
      if (mapa.has(id)) {
        estado.duplicado = true;
        const prev = mapa.get(id)!;
        mapa.set(id, { ...prev, duplicado: true });
        continue;
      }
      mapa.set(id, estado);
    }
  }
  return mapa;
}

interface PendenteReconcile {
  id: string;
  omie_id_receb: number | null;
  chave_acesso: string | null;
}

interface SelecaoCandidatas<T extends PendenteReconcile> {
  /** Correspondências FORTES (id + chave 44 iguais, recebida, não-cancelada, sem duplicata) — reconciliáveis direto. */
  candidatas: T[];
  foraDaListagem: number;
  naoRecebidas: number;
  canceladas: number;
  /** Sem chave em um dos lados, chave inválida (≠44 dígitos) ou divergente — fail-closed. */
  identidadeFraca: number;
  /** nIdReceb duplicado na listagem OU repetido entre as pendentes do app (sem UNIQUE no banco). */
  duplicadas: number;
}

/**
 * Cruza as pendentes do app com o mapa da listagem usando IDENTIDADE FORTE (Codex v2 P1):
 * reconciliável direto da listagem SOMENTE quando (nIdReceb igual) E (chave de acesso
 * presente nos DOIS lados, com 44 dígitos, idêntica) E (cRecebido=S) E (não cancelada)
 * E (cardinalidade 1:1 — sem duplicata na listagem nem entre as pendentes).
 * Qualquer identidade em dúvida → contador, nunca candidata. `cap` limita o lote.
 * A ordem de `pendentes` é preservada (chame com mais antigas primeiro).
 */
function selecionarCandidatasReconcile<T extends PendenteReconcile>(
  pendentes: T[],
  listagem: Map<number, EstadoListagem>,
  cap: number,
): SelecaoCandidatas<T> {
  const sel: SelecaoCandidatas<T> = {
    candidatas: [], foraDaListagem: 0, naoRecebidas: 0, canceladas: 0, identidadeFraca: 0, duplicadas: 0,
  };
  const idsRepetidos = new Set<number>();
  const vistos = new Set<number>();
  for (const p of pendentes) {
    const id = Number(p.omie_id_receb);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (vistos.has(id)) idsRepetidos.add(id);
    vistos.add(id);
  }
  for (const p of pendentes) {
    const id = Number(p.omie_id_receb);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (idsRepetidos.has(id)) { sel.duplicadas++; continue; }
    const estado = listagem.get(id);
    if (!estado) { sel.foraDaListagem++; continue; }
    if (estado.duplicado) { sel.duplicadas++; continue; }
    if (estado.cancelada) { sel.canceladas++; continue; }
    if (!estado.recebido) { sel.naoRecebidas++; continue; }
    const chaveApp = (p.chave_acesso ?? "").trim();
    if (chaveApp.length !== 44 || estado.chave == null || estado.chave !== chaveApp) {
      sel.identidadeFraca++;
      continue;
    }
    if (sel.candidatas.length < cap) sel.candidatas.push(p);
  }
  return sel;
}

interface JanelaEmissao { de: Date; ate: Date }

function parseEmissao(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Janelas de emissão para o ListarRecebimentos: [emissãoMin - margem, +largura],
 * consecutivas e DISJUNTAS (de_{k+1} = ate_k + 1d — sobreposição faria a mesma NF
 * aparecer em 2 páginas e cair no fail-closed de duplicata), até alcançar
 * max(agora, emissãoMax) + 1d, com no máximo `maxJanelas` (cap de chamadas ao Omie
 * por conta por rodada). Âncora muito antiga → cobertura parcial honesta: o
 * chamador reporta `truncada` e a cobertura avança quando as antigas resolverem.
 * Datas inválidas/ausentes caem no fallback (agora - fallbackDias). Determinístico
 * (recebe `agora`); dias em UTC puro.
 */
function janelasEmissaoConsecutivas(
  emissaoMinIso: string | null,
  emissaoMaxIso: string | null,
  agora: Date,
  opts?: { margemDias?: number; larguraDias?: number; maxJanelas?: number; fallbackDias?: number },
): JanelaEmissao[] {
  const DIA = 86_400_000;
  const margem = (opts?.margemDias ?? 7) * DIA;
  const largura = (opts?.larguraDias ?? 60) * DIA;
  const max = opts?.maxJanelas ?? 4;
  const fallback = (opts?.fallbackDias ?? 210) * DIA;

  const min = parseEmissao(emissaoMinIso);
  const maxEmissao = parseEmissao(emissaoMaxIso);
  const base = min ? new Date(min.getTime() - margem) : new Date(agora.getTime() - fallback);
  const alvo = new Date(Math.max(agora.getTime(), maxEmissao?.getTime() ?? 0) + DIA);

  const janelas: JanelaEmissao[] = [];
  let de = base;
  while (janelas.length < max) {
    const ate = new Date(de.getTime() + largura);
    janelas.push({ de, ate });
    if (ate.getTime() >= alvo.getTime()) break;
    de = new Date(ate.getTime() + DIA);
  }
  return janelas;
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

// ── Retry with exponential backoff — PARA em REDUNDANT (re-tentar renova a trava) ──
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
        const faultstring = asStr(asRecord(data).faultstring);
        if (ehErroRedundante(faultstring)) {
          // trava anti-redundância: retry só renova o timer — devolve na hora
          return { error: true, status: res.status, data };
        }
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

// ── Credential mapping by warehouse code — SEM fallback (Codex v2 P1: conta exata) ──
function getOmieCredentials(warehouseCode: string): { appKey: string; appSecret: string } | null {
  if (warehouseCode === "CC") {
    const appKey = Deno.env.get("OMIE_COLACOR_SC_APP_KEY") ?? "";
    const appSecret = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") ?? "";
    return appKey && appSecret ? { appKey, appSecret } : null;
  }
  if (warehouseCode === "OB") {
    const appKey = Deno.env.get("OMIE_OBEN_APP_KEY") ?? "";
    const appSecret = Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "";
    return appKey && appSecret ? { appKey, appSecret } : null;
  }
  return null;
}

function formatarDataOmie(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

const RECEB_URL = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const LOCK_TTL_MIN = 5;
const LIMITE_DEFAULT = 25;
const LIMITE_MAX = 25;
const REGISTROS_POR_PAGINA = 50;
const TREGUA_LISTAGEM_MS = 1500;
// Guard global de chamadas de listagem por rodada (janelas × páginas). 7-8 chamadas/rodada
// provadas sem trava em prod; 12 dá folga pra paginação sem virar rajada (~18s de tréguas).
const MAX_CHAMADAS_LISTAGEM = 12;

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
  let diagnosticoListagem = false;
  try {
    const body = (await req.json()) as Record<string, unknown> | null;
    const l = Number(body?.limite);
    if (Number.isFinite(l)) limite = Math.min(LIMITE_MAX, Math.max(1, Math.trunc(l)));
    // Modo diagnóstico read-only: devolve registros CRUS da listagem (sem cruzar nem
    // reconciliar) — pra mapear os campos reais que o Omie retorna na LISTAGEM
    // (23 NFs avaliadas × zero cRecebido=S contradiz o ConsultarRecebimento de 04/jun).
    diagnosticoListagem = body?.diagnostico_listagem === true;
  } catch { /* body vazio (cron) — usa default */ }

  try {
    // Mais antigas primeiro: são as que seguram o alerta ">24h" do painel — e a janela
    // de emissão da listagem parte delas (avança sozinha conforme reconcilia).
    const { data: pendData, error: pendErr } = await supabase
      .from("nfe_recebimentos")
      .select("id, numero_nfe, omie_id_receb, chave_acesso, data_emissao, efetivacao_tentativas, warehouses(code)")
      .eq("status", "pendente")
      .not("omie_id_receb", "is", null)
      .not("chave_acesso", "is", null)
      .order("created_at", { ascending: true })
      .limit(100);
    if (pendErr) {
      console.error("[omie-nfe-reconcile] erro ao listar pendentes:", pendErr);
      return jsonRes({ error: "Erro ao listar pendentes" }, 500);
    }
    const rows = (pendData ?? []) as Array<{
      id: string; numero_nfe: string; omie_id_receb: number; chave_acesso: string;
      data_emissao: string | null; efetivacao_tentativas: number | null; warehouses: WarehouseJoin | null;
    }>;

    // ── Fase 1: 1 página de ListarRecebimentos por conta (método sem trava de rajada
    //    observada, mas 1 página/rodada por prudência — paginação fica pro follow-up) ──
    const porConta = new Map<string, typeof rows>();
    let semWarehouse = 0;
    for (const r of rows) {
      const wh = r.warehouses?.code;
      if (wh !== "OB" && wh !== "CC") { semWarehouse++; continue; } // sem fallback (Codex P1)
      const arr = porConta.get(wh) ?? [];
      arr.push(r);
      porConta.set(wh, arr);
    }

    type Candidata = (typeof rows)[number];
    const candidatas: Candidata[] = [];
    let foraDaListagem = 0;
    let naoRecebidas = 0;
    let canceladasListagem = 0;
    let identidadeFraca = 0;
    let duplicadas = 0;
    let puladasCredencial = 0;
    let listagemTruncada = false;
    let janelasConsultadas = 0;
    let chamadasListagem = 0;
    const errosListagem: string[] = [];
    const amostraCrua: Array<Record<string, unknown>> = [];
    const amostraNaoRecebidas: Array<Record<string, unknown>> = [];

    for (const [whCode, pendentesConta] of porConta) {
      const creds = getOmieCredentials(whCode);
      if (!creds) {
        puladasCredencial += pendentesConta.length;
        console.warn(`[omie-nfe-reconcile] credenciais ausentes p/ warehouse ${whCode} — ${pendentesConta.length} pendentes puladas`);
        continue;
      }

      // v3.1: janelas de emissão consecutivas e disjuntas, da pendente mais antiga até
      // hoje (ou a maior emissão registrada — dado sujo do Omie tem emissão futura).
      // Cap de 4 chamadas/conta/rodada com trégua — o import v2 pagina o mesmo método
      // ListarRecebimentos na mesma conta sem morder a trava anti-redundância.
      const emissoes = pendentesConta.map((p) => p.data_emissao).filter((d): d is string => !!d).sort();
      const janelas = janelasEmissaoConsecutivas(emissoes[0] ?? null, emissoes[emissoes.length - 1] ?? null, new Date());

      const paginas: unknown[] = [];
      for (const [j, janela] of janelas.entries()) {
        if (j > 0) await new Promise((r) => setTimeout(r, TREGUA_LISTAGEM_MS));
        janelasConsultadas++;
        // v3.3: PAGINA janelas cheias (7 fora_da_listagem estagnaram em prod com janelas
        // OBEN >50 registros truncadas na página 1). Padrão da casa p/ Omie: paginar até
        // página VAZIA/incompleta + guard — nTotalPaginas NÃO é confiável (CLAUDE.md §Omie).
        let nPagina = 1;
        while (true) {
          if (chamadasListagem >= MAX_CHAMADAS_LISTAGEM) {
            listagemTruncada = true; // cap global cortou — cobertura parcial honesta
            break;
          }
          if (nPagina > 1) await new Promise((r) => setTimeout(r, TREGUA_LISTAGEM_MS));
          chamadasListagem++;
          const lst = await omieCall(RECEB_URL, {
            call: "ListarRecebimentos",
            app_key: creds.appKey,
            app_secret: creds.appSecret,
            // cExibirDetalhes:'S' — SEM ele a listagem NÃO retorna infoCadastro (provado em
            // prod 2026-07-17 via diagnostico_listagem: keys_registro sem infoCadastro,
            // cRecebido null, com as NFs em cEtapa=80). Com o flag, cRecebido=S volta a vir
            // e o cruzamento forte reconcilia. Parse permanece fail-closed se faltar.
            param: [{ nPagina, nRegistrosPorPagina: REGISTROS_POR_PAGINA, dtEmissaoDe: formatarDataOmie(janela.de), dtEmissaoAte: formatarDataOmie(janela.ate), cExibirDetalhes: "S" }],
          });
          const cls = classificarRespostaOmie({ httpOk: !lst.error, status: lst.error ? lst.status : 200, body: lst.data });
          if (!cls.sucesso) {
            const msg = `${whCode} janela ${formatarDataOmie(janela.de)}–${formatarDataOmie(janela.ate)} p${nPagina}: ${cls.erro ?? "erro"}`;
            if (errosListagem.length < 3) errosListagem.push(msg);
            console.warn(`[omie-nfe-reconcile] listagem falhou — ${msg}`);
            break; // desiste DESTA janela; as demais ainda podem cobrir outras pendentes
          }
          const recsPagina = asRecord(lst.data).recebimentos;
          paginas.push(lst.data);
          if (diagnosticoListagem && amostraCrua.length < 4 && Array.isArray(recsPagina)) {
            for (const r of recsPagina.slice(0, 2)) amostraCrua.push({ conta: whCode, registro: r });
          }
          // Página incompleta/vazia = última desta janela (critério que não depende de nTotalPaginas).
          if (!Array.isArray(recsPagina) || recsPagina.length < REGISTROS_POR_PAGINA) break;
          nPagina++;
        }
      }
      if (janelas.length > 0 && janelas[janelas.length - 1].ate.getTime() < Date.now()) {
        listagemTruncada = true; // cap de janelas não alcançou hoje — cobertura parcial
      }

      const mapa = extrairRecebidosDaListagem(paginas);
      const sel = selecionarCandidatasReconcile(pendentesConta, mapa, limite - candidatas.length);

      // Observabilidade: amostra CRUA dos matches "não-recebidos" — se a listagem não
      // trouxer infoCadastro/cRecebido de verdade (doc diz que traz), isto revela.
      if (amostraNaoRecebidas.length < 3) {
        const rawPorId = new Map<number, unknown>();
        for (const pg of paginas) {
          const recs = asRecord(pg).recebimentos;
          if (!Array.isArray(recs)) continue;
          for (const raw of recs) {
            const rec = asRecord(raw);
            const id = Number(asRecord(rec.cabec).nIdReceb ?? rec.nIdReceb);
            if (Number.isFinite(id) && id > 0 && !rawPorId.has(id)) rawPorId.set(id, raw);
          }
        }
        for (const p of pendentesConta) {
          if (amostraNaoRecebidas.length >= 3) break;
          const id = Number(p.omie_id_receb);
          const estado = mapa.get(id);
          if (!estado || estado.recebido || estado.cancelada) continue;
          const raw = asRecord(rawPorId.get(id));
          const info = asRecord(raw.infoCadastro);
          amostraNaoRecebidas.push({
            numero_nfe: p.numero_nfe,
            nIdReceb: id,
            cEtapa: asRecord(raw.cabec).cEtapa ?? null,
            cRecebido_cru: info.cRecebido ?? null,
            keys_registro: Object.keys(raw),
            keys_infoCadastro: Object.keys(info),
          });
        }
      }
      candidatas.push(...sel.candidatas);
      foraDaListagem += sel.foraDaListagem;
      naoRecebidas += sel.naoRecebidas;
      canceladasListagem += sel.canceladas;
      identidadeFraca += sel.identidadeFraca;
      duplicadas += sel.duplicadas;
      console.log(`[omie-nfe-reconcile] ${whCode}: ${janelas.length} janelas, listagem ${mapa.size} registros${listagemTruncada ? " (TRUNCADA)" : ""}, pendentes ${pendentesConta.length}, candidatas ${sel.candidatas.length}, nao_recebidas ${sel.naoRecebidas}, canceladas ${sel.canceladas}, identidade_fraca ${sel.identidadeFraca}, duplicadas ${sel.duplicadas}, fora ${sel.foraDaListagem}`);
      if (candidatas.length >= limite) break;
    }

    // Modo diagnóstico: para AQUI — devolve o payload cru da listagem, sem reconciliar nada.
    if (diagnosticoListagem) {
      return jsonRes({
        success: true,
        versao: "v3.3-paginacao-janelas",
        modo: "diagnostico_listagem",
        pendentes_avaliadas: rows.length,
        janelas_consultadas: janelasConsultadas,
        chamadas_listagem: chamadasListagem,
        amostra_erros_listagem: errosListagem,
        amostra_nao_recebidas: amostraNaoRecebidas,
        amostra_crua: amostraCrua,
      });
    }

    // ── Fase 2: reconciliação DIRETA em lote (só escrita local — zero chamadas ao Omie) ──
    const reconciliadasNfe: string[] = [];
    let puladasLock = 0;
    let estadoMudou = 0;
    let errosUpdate = 0;

    for (const nfe of candidatas) {
      const lockTs = new Date().toISOString();
      const cutoff = new Date(Date.now() - LOCK_TTL_MIN * 60_000).toISOString();
      const { data: claimRows, error: claimErr } = await supabase
        .rpc("claim_nfe_efetivacao_lock", { p_nfe_id: nfe.id, p_lock_ts: lockTs, p_cutoff: cutoff });
      if (claimErr || !claimRows || claimRows.length === 0) {
        puladasLock++;
        continue;
      }
      try {
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
        await registrarTentativa(supabase, { nfe_recebimento_id: nfe.id, tentativa, operacao: "reconciliado_auto", sucesso: true, erro: null, omie_status: null });
        reconciliadasNfe.push(nfe.numero_nfe);
        console.log(`[omie-nfe-reconcile] NF ${nfe.numero_nfe} reconciliada (recebida no Omie — listagem, identidade forte).`);
      } finally {
        // libera o lock só se ainda é o MEU (compare-and-clear pelo timestamp gravado)
        await supabase.from("nfe_recebimentos")
          .update({ efetivacao_lock_at: null })
          .eq("id", nfe.id)
          .eq("efetivacao_lock_at", lockTs);
      }
    }

    const { count: restantes } = await supabase
      .from("nfe_recebimentos")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendente");

    console.log(`[omie-nfe-reconcile] v3.1: pendentes=${rows.length} janelas=${janelasConsultadas} candidatas=${candidatas.length} reconciliadas=${reconciliadasNfe.length} nao_recebidas=${naoRecebidas} canceladas=${canceladasListagem} identidade_fraca=${identidadeFraca} duplicadas=${duplicadas} fora_listagem=${foraDaListagem} sem_warehouse=${semWarehouse} lock=${puladasLock} estado_mudou=${estadoMudou} truncada=${listagemTruncada} restantes_pendentes=${restantes ?? "?"}`);

    return jsonRes({
      success: true,
      versao: "v3.3-paginacao-janelas",
      pendentes_avaliadas: rows.length,
      candidatas: candidatas.length,
      reconciliadas: reconciliadasNfe.length,
      listagem: {
        janelas_consultadas: janelasConsultadas,
        chamadas_listagem: chamadasListagem,
        nao_recebidas: naoRecebidas,
        canceladas: canceladasListagem,
        identidade_fraca: identidadeFraca,
        duplicadas,
        fora_da_listagem: foraDaListagem,
        truncada: listagemTruncada,
      },
      sem_warehouse: semWarehouse,
      puladas_lock: puladasLock,
      puladas_credencial: puladasCredencial,
      estado_mudou: estadoMudou,
      erros_update: errosUpdate,
      amostra_erros_listagem: errosListagem,
      amostra_nao_recebidas: amostraNaoRecebidas,
      reconciliadas_nfe: reconciliadasNfe,
      restantes_pendentes: restantes ?? null,
    });
  } catch (err) {
    console.error("[omie-nfe-reconcile] Erro inesperado:", err);
    return jsonRes({ error: "Erro interno", details: String(err) }, 500);
  }
});
