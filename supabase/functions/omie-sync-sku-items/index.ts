// Edge Function: omie-sync-sku-items
// Popula sku_leadtime_history com 1 linha por item de NFe recebida (purchase_orders_tracking).
// Pública (verify_jwt = false).
//
// Body opcional:
//   { "empresa": "OBEN" | "COLACOR", "dias": 30, "fornecedor_codigo_omie": 8689681266 }
//
// Estratégia:
//   0) RECOMPUTE DERIVADO (RPC recomputar_leadtime_derivado, LOCAL — zero Omie), ANTES de
//      qualquer chamada externa. A linha de leadtime nasce no FATURAMENTO, quando o t4 ainda
//      é NULL ⇒ lt_bruto NULL (correto: não fabrica). O t4 chega dias depois pelo sync irmão,
//      mas a fila daqui é "NFe SEM linha em sku_leadtime_history" ⇒ a NFe nunca volta ⇒ o
//      lt_bruto morria NULL para sempre (1103 linhas, ~30% do histórico OBEN em 2026-07-16).
//      Os itens já estão gravados; só as DATAS faltavam — a Omie não tem o que acrescentar.
//   1) Lê NFes da empresa no período com t2_data_faturamento e nfe_chave_acesso.
//   2) Fila = pendentes (sem linha em sku_leadtime_history) ELEGÍVEIS pelo controle de
//      tentativas (sku_items_sync_controle + backoff 6h/24h/72h), nunca-tentadas primeiro —
//      NFe cuja consulta retorna 0 itens não upserta e não sairia nunca da fila (poison que
//      consumia o guard de 50s a cada run e deixava as antigas inalcançáveis; OBEN 2026-07-14).
//   3) Para cada NFe → ConsultarRecebimento(nIdReceb) → itera itensRecebimento[]; TODA
//      consulta (sucesso, 0 itens ou falha) marca tentativa no controle.
//   4) Para cada item, tenta achar o pedido específico via numero_contrato_fornecedor = nNumPedCompra.
//   5) UPSERT em sku_leadtime_history (tracking_id, sku_codigo_omie).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface OmieItemCabec {
  nIdProduto?: number | string;
  cCodigoProduto?: string;
  cDescricaoProduto?: string;
  cUnidadeNfe?: string;
  cNCM?: string;
  nQtdeNFe?: number | string;
  nPrecoUnit?: number | string;
  vTotalItem?: number | string;
}

interface OmieItemInfoAdic {
  nNumPedCompra?: number | string;
}

interface OmieItemAjustes {
  nQtdeRecebida?: number | string;
}

interface OmieRecebimentoItem {
  itensCabec?: OmieItemCabec;
  itensInfoAdic?: OmieItemInfoAdic;
  itensAjustes?: OmieItemAjustes;
}

interface OmieConsultarRecebimentoResponse {
  itensRecebimento?: OmieRecebimentoItem[];
  faultstring?: string;
  raw?: string;
}

interface NFeRawData {
  cabec?: { nIdReceb?: number | string };
}

interface PedidoTrackingMatchRow {
  id: string;
  t1_data_pedido: string;
  numero_pedido: string | null;
  grupo_leadtime: string | null;
  fornecedor_nome: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const RATE_LIMIT_DELAY_MS = 5000;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const TIMEOUT_GUARD_MS = 50_000;
const TIMEOUT_CHECK_EVERY_NFES = 5;

function redundantWaitMs(faultstring: string): number | null {
  const match = faultstring.match(/Aguarde\s+(\d+)\s+segundos/i);
  if (!match) return null;
  return (Number(match[1]) + 3) * 1000;
}

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: Empresa;
  dias?: number;
  fornecedor_codigo_omie?: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  /** Linhas cujo lt_* foi derivado do t4 que já estava no tracking (sem Omie). */
  recompute_recomputadas: number;
  /** Linhas cujo lt_bruto/lt_faturamento foi ANULADO por o t1 não ser data de pedido
   *  (NFe órfã ou fallback provado da edge) — mentira que subestimava o leadtime. */
  recompute_anuladas: number;
  recompute_erro: string | null;
  fila_pendente: number;
  fila_em_backoff: number;
  /** Linhas tiradas da fila por dividirem o nIdReceb com uma já eleita (NFe que fatura
   *  N pedidos). = chamadas Omie economizadas E duplicatas de leadtime não criadas. */
  recebimentos_deduplicados: number;
  nfes_processadas: number;
  nfes_sem_nidreceb: number;
  nfes_sem_nidreceb_dias_max: number;
  consultas_tentadas: number;
  consultas_detalhadas: number;
  itens_processados: number;
  /** Itens crus fundidos por SKU repetido na mesma NFe (Σ n_itens_agregados − 1). >0 = o
   *  bug de sobrescrita item-a-item teria mordido aqui; agora são somados, não perdidos. */
  itens_fundidos_sku_repetido: number;
  /** Grupos (tracking, sku) cujo t1 divergia entre os itens fundidos (proveniências
   *  distintas: um casou o pedido, outro caiu no fallback). Nestes o lt_bruto/lt_faturamento
   *  sai NULL de propósito — t1 ambíguo não vira leadtime. >0 merece olhar. */
  grupos_t1_ambiguo: number;
  itens_com_pedido_mapeado: number;
  itens_sem_pedido: number;
  skus_distintos: number;
  erros: number;
  controle_falhas: number;
  interrompido_por_timeout: boolean;
}

interface ExistingTrackingRow {
  tracking_id: string;
}

// ─── Fila com backoff (espelho verbatim de src/lib/reposicao/sku-items-fila-helpers.ts;
//     paridade provada em src/__tests__/edge-money-path-invariants.test.ts) ───
// MIRROR-START sku-items-fila
interface SkuItemsFilaControle {
  tentativas: number;
  ultima_tentativa: string | null;
}

/** Backoff entre re-tentativas de consulta por NFe: 1ª falha re-tenta em 6h,
 *  2ª em 24h, da 3ª em diante 72h. Tentativas <=0 = virgem (sempre elegível). */
function skuItemsBackoffMs(tentativas: number): number {
  if (tentativas <= 0) return 0;
  if (tentativas === 1) return 6 * 3_600_000;
  if (tentativas === 2) return 24 * 3_600_000;
  return 72 * 3_600_000;
}

/** Elegível para consultar se nunca tentada, controle ilegível ou backoff vencido. */
function skuItemsElegivel(
  controle: SkuItemsFilaControle | undefined,
  agoraMs: number,
): boolean {
  if (!controle || controle.tentativas <= 0 || !controle.ultima_tentativa) return true;
  const ultimaMs = Date.parse(controle.ultima_tentativa);
  if (!Number.isFinite(ultimaMs)) return true;
  return agoraMs - ultimaMs >= skuItemsBackoffMs(controle.tentativas);
}

/** Ordem da fila: nunca-tentadas primeiro (tentativas ASC); empate → faturamento
 *  mais ANTIGO primeiro. Poison (muitas tentativas) naturalmente vai pro fim.
 *
 *  O empate é earliest-deadline-first, não "mais recente primeiro": a NFe só é
 *  visível enquanto está dentro da janela de `dias` do run, então a mais antiga é
 *  a de menor folga — se o guard de 50s corta o run, quem fica de fora deve ser
 *  quem volta amanhã (folga grande), não quem expira sem nunca virar leadtime.
 *
 *  O 3º critério (id) NÃO é cosmético: ele dá ordem TOTAL à fila, e a eleição de
 *  skuItemsDedupPorRecebimento depende disso pra ser determinística entre runs. Sem
 *  ele, duas linhas irmãs empatadas elegeriam vencedores diferentes a cada execução e
 *  o item sem pedido casado pousaria ora numa, ora noutra. (t2 NÃO desempata as irmãs:
 *  linhas que dividem a mesma NFe têm t2 DIFERENTE — o sync de NFes preserva o valor
 *  pré-existente de cada pedido via `??`. Auditado em prod 2026-07-16.) */
function skuItemsCompararFila(
  a: { tentativas: number; t2: string; id?: string },
  b: { tentativas: number; t2: string; id?: string },
): number {
  if (a.tentativas !== b.tentativas) return a.tentativas - b.tentativas;
  if (a.t2 !== b.t2) return a.t2 < b.t2 ? -1 : 1;
  const ai = a.id ?? "";
  const bi = b.id ?? "";
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}

/** Elege UMA linha por (empresa, nIdReceb), preservando a ordem da fila.
 *
 *  Por que existe: uma NFe que fatura N pedidos deixa N linhas em
 *  purchase_orders_tracking com a MESMA nfe_chave_acesso — e o backfillRawData do sync
 *  de NFes grava o MESMO recebimento (logo o MESMO nIdReceb) no raw_data de todas. Sem
 *  deduplicar, cada uma consulta o MESMO recebimento e regrava os MESMOS itens sob o
 *  seu próprio tracking_id: peso N× pra mesma nota na estatística de leadtime, e N
 *  chamadas Omie onde 1 basta (a pressão de rate-limit que causou o poison de 07-14).
 *
 *  ⚠️ A eleita NÃO vira dona do dado: cada item é gravado sob o tracking do SEU pedido
 *  (nNumPedCompra → numero_contrato_fornecedor). A eleita decide só QUEM chama a Omie,
 *  e serve de pouso pros itens que não casaram com pedido nenhum. Como o recebimento
 *  traz os itens dos N pedidos, as N linhas ganham suas linhas de leadtime na MESMA
 *  chamada e saem da fila juntas — por isso deduplicar aqui não cria poison.
 *
 *  Linha sem nIdReceb passa direto (é contada como gap de cobertura pelo chamador). */
function skuItemsDedupPorRecebimento<T extends { id: string; nIdReceb: string | null }>(
  fila: readonly T[],
): T[] {
  const vistos = new Set<string>();
  const out: T[] = [];
  for (const linha of fila) {
    if (!linha.nIdReceb) {
      out.push(linha);
      continue;
    }
    if (vistos.has(linha.nIdReceb)) continue;
    vistos.add(linha.nIdReceb);
    out.push(linha);
  }
  return out;
}
// MIRROR-END

// ─── Agregação de itens de NFe por (tracking, sku) antes do upsert (espelho verbatim de
//     src/lib/reposicao/sku-items-fila-helpers.ts; paridade em edge-money-path-invariants.test.ts) ───
// MIRROR-START sku-items-agregacao
interface ItemRecebimentoResolvido {
  tracking_id: string;
  sku_codigo_omie: number;
  sku_codigo: string | null;
  sku_descricao: string | null;
  sku_unidade: string | null;
  sku_ncm: string | null;
  fornecedor_codigo_omie: number | null;
  fornecedor_nome: string | null;
  grupo_leadtime: string | null;
  quantidade_pedida: number | null;
  quantidade_recebida: number | null;
  valor_unitario: number | null;
  valor_total: number | null;
  t1_data_pedido: string;
  /** Proveniência do t1: true = veio do PEDIDO casado (nNumPedCompra → tracking do pedido);
   *  false = fallback para o t2 da própria NFe. Sem isto, dois itens do mesmo SKU com
   *  proveniências distintas caem no mesmo bucket e o t1 emitido dependeria da ORDEM da
   *  resposta da Omie. */
  t1_de_pedido: boolean;
  t2_data_faturamento: string;
  t3_data_cte: string | null;
  t4_data_recebimento: string | null;
}

interface ItemRecebimentoAgregado extends ItemRecebimentoResolvido {
  /** Quantos itens crus da NFe foram fundidos neste (tracking, sku). 1 = caso comum. */
  n_itens_agregados: number;
  /** true = o bucket mistura itens com t1 DIFERENTE (proveniências distintas). Não dá para
   *  saber qual t1 vale, e leadtime derivado de t1 errado é exatamente o defeito que o #1365
   *  matou → o chamador grava lt_* = NULL em vez de escolher. Medido em prod (psql-ro
   *  2026-07-18): 40 itens / 12 trackings casam o PRÓPRIO tracking e podem produzir bucket
   *  misto. [Codex xhigh, bloqueador] */
  t1_ambiguo: boolean;
}

/** Soma COMPLETO-ou-NULL para campo aditivo money-path: qualquer parcela ausente anula o
 *  total. Somar só o que existe faria o total representar um SUBCONJUNTO e o consumidor
 *  (AVG(valor_total/NULLIF(quantidade_recebida,0)) com filtro qr>0 AND vt>0) o aceitaria
 *  como se fosse a compra inteira — fabricando um preço que nenhum item real teve
 *  (vt=100/qr=null + vt=null/qr=10 → par (100,10), preço 10). [Codex xhigh, bloqueador] */
function somaCompletaOuNull(valores: readonly (number | null)[]): number | null {
  if (valores.length === 0) return null;
  let soma = 0;
  for (const v of valores) {
    if (v === null) return null;
    soma += v;
  }
  return soma;
}

/** valor_unitario agregado = média PONDERADA por quantidade_pedida (não AVG simples — o
 *  achado de 2ª ordem da função dropada #1373), FAIL-CLOSED: só pondera se TODO item do
 *  grupo tiver vu presente e qp > 0. Peso ausente, zero ou negativo → null, nunca um preço
 *  derivado de peso inválido (vu=100/qp=-1 + vu=10/qp=2 daria -80) nem média de subconjunto
 *  apresentada como média do grupo. [Codex xhigh] */
function valorUnitarioPonderado(itens: readonly ItemRecebimentoResolvido[]): number | null {
  if (itens.length === 0) return null;
  let numerador = 0;
  let pesoTotal = 0;
  for (const i of itens) {
    if (i.valor_unitario === null) return null;
    if (i.quantidade_pedida === null || !(i.quantidade_pedida > 0)) return null;
    numerador += i.valor_unitario * i.quantidade_pedida;
    pesoTotal += i.quantidade_pedida;
  }
  if (!(pesoTotal > 0)) return null;
  return numerador / pesoTotal;
}

/** Agrega os itens de UMA NFe por (tracking_id, sku_codigo_omie): soma quantidade_pedida,
 *  quantidade_recebida e valor_total; deriva valor_unitario como média ponderada por qtd;
 *  toma descritivos e datas do 1º item do grupo (iguais entre itens do mesmo tracking).
 *
 *  POR QUE existe: o writer fazia 1 upsert por item com onConflict (tracking_id,
 *  sku_codigo_omie). SKU repetido na NFe caindo no mesmo tracking → o 2º upsert
 *  SOBRESCREVIA o 1º (valor_total virava o do ÚLTIMO item, não o total). Medido em prod
 *  (psql-ro 2026-07-17): PRD02377 gravou R$139,90 de R$1.214,37; PRD03594 R$1.190,98 de
 *  R$1.984,96; 10,9% das NFes recentes têm SKU repetido. */
function agregarItensRecebimento(
  itens: readonly ItemRecebimentoResolvido[],
): ItemRecebimentoAgregado[] {
  const buckets = new Map<string, ItemRecebimentoResolvido[]>();
  for (const item of itens) {
    const chave = `${item.tracking_id}::${item.sku_codigo_omie}`;
    const bucket = buckets.get(chave);
    if (bucket) bucket.push(item);
    else buckets.set(chave, [item]);
  }
  const out: ItemRecebimentoAgregado[] = [];
  for (const bucket of buckets.values()) {
    // Base DETERMINÍSTICA: prefere o item cujo t1 veio de PEDIDO real (mais informativo para
    // auditoria) em vez do 1º da resposta da Omie — assim o t1 emitido não depende da ordem.
    const base = bucket.find((i) => i.t1_de_pedido) ?? bucket[0];
    const t1Ambiguo = new Set(bucket.map((i) => i.t1_data_pedido)).size > 1;
    out.push({
      ...base,
      quantidade_pedida: somaCompletaOuNull(bucket.map((i) => i.quantidade_pedida)),
      quantidade_recebida: somaCompletaOuNull(bucket.map((i) => i.quantidade_recebida)),
      valor_unitario: valorUnitarioPonderado(bucket),
      valor_total: somaCompletaOuNull(bucket.map((i) => i.valor_total)),
      n_itens_agregados: bucket.length,
      t1_ambiguo: t1Ambiguo,
    });
  }
  return out;
}
// MIRROR-END

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getCredentials(
  empresa: Empresa,
): { app_key: string; app_secret: string } {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) throw new Error("Credenciais OBEN ausentes");
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) throw new Error("Credenciais COLACOR ausentes");
  return { app_key, app_secret };
}

async function callOmie(
  app_key: string,
  app_secret: string,
  call: "ConsultarRecebimento",
  param: Record<string, unknown>,
): Promise<OmieConsultarRecebimentoResponse> {
  const body = { call, app_key, app_secret, param: [param] };
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await fetch(OMIE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: OmieConsultarRecebimentoResponse;
    try {
      json = JSON.parse(text) as OmieConsultarRecebimentoResponse;
    } catch {
      json = { raw: text };
    }
    const faultstring = typeof json?.faultstring === "string" ? json.faultstring : "";
    const waitMs = redundantWaitMs(faultstring) ?? RETRY_DELAY_MS;
    if (res.status === 429 || /rate limit|redundant|consumo redundante/i.test(faultstring)) {
      console.warn(
        `[sync-sku-items] ${call} aguardando ${Math.round(waitMs / 1000)}s por limite Omie (try ${attempt}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Omie ${call} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return json;
  }
  throw new Error(`Omie ${call}: rate limit após ${MAX_RETRIES} tentativas`);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Dias úteis entre duas datas ISO (segunda..sexta). Convenção: lead time exclui o dia inicial. */
function diasUteisEntre(
  inicioIso: string | null,
  fimIso: string | null,
): number | null {
  if (!inicioIso || !fimIso) return null;
  const ini = new Date(inicioIso);
  const fim = new Date(fimIso);
  if (isNaN(ini.getTime()) || isNaN(fim.getTime()) || fim < ini) return null;
  let total = 0;
  const cursor = new Date(
    Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), ini.getUTCDate()),
  );
  const last = new Date(
    Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), fim.getUTCDate()),
  );
  while (cursor <= last) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) total++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(total - 1, 0);
}

interface NFeRow {
  id: string;
  nfe_chave_acesso: string;
  t1_data_pedido: string;
  t2_data_faturamento: string;
  t3_data_cte: string | null;
  t4_data_recebimento: string | null;
  fornecedor_codigo_omie: number;
  fornecedor_nome: string | null;
  raw_data: NFeRawData | null;
  /** Sinal do recebimento em coluna DEDICADA — sobrevive ao sync de pedidos, que
   *  sobrescreve o raw_data. Fonte preferida; o jsonb fica só como fallback. */
  nid_receb: number | null;
}

/** NFeRow com o nIdReceb já extraído do raw_data — a fila dedup-a por ele, e o
 *  raw_data é jsonb MULTI-WRITER (o sync de pedidos o sobrescreve com o payload do
 *  pedido e apaga o nIdReceb), então lê-lo UMA vez por run evita depender de um campo
 *  que pode mudar debaixo do loop. */
type NFeFilaRow = NFeRow & { nIdReceb: string | null };

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SVC_KEY) return true;
  try {
    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SVC_KEY } });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(`${SUPA_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } });
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

// ─── Observabilidade em fin_sync_log (best-effort; NUNCA derruba o sync) ───
// Rastreabilidade independente do orquestrador: action LIKE 'sync_%' + companies em
// minúsculo (ex.: ['oben']) → o fin_sync_watchdog_check (*/30) JÁ reclassifica órfã
// 'running' (>30min) e alerta sync_error (≥2 falhas consecutivas) SEM mudar o watchdog.
// Como a edge completa em BACKGROUND além do abort de 25s do orquestrador, o completeSync
// roda no fim REAL (registra 'complete' de verdade); se a edge morrer antes (guard interno),
// a órfã 'running' é o sinal confiável de morte. Erro PARCIAL fica em results (NÃO vira
// status 'error' — evita alerta falso); só falha FATAL marca 'error'.
// empresa REAL sincronizada (espelha getCredentials: OBEN só se exatamente OBEN,
// senão COLACOR) → companies em minúsculo, sempre no conjunto que o watchdog varre
// (provado: o watchdog compara case-sensitive contra ['oben','colacor','colacor_sc']).
function empresaParaLog(e: string): string {
  return e.toUpperCase() === "OBEN" ? "oben" : "colacor";
}

async function logSync(
  db: SupabaseClient,
  action: string,
  companies: string[],
  triggeredBy: string,
): Promise<string> {
  try {
    // supabase-js NÃO lança em erro PostgREST — retorna { error }. Checar explícito,
    // senão um insert barrado por RLS/quota/schema some silencioso (logId vazio).
    const { data, error } = await db
      .from("fin_sync_log")
      .insert({ action, companies, status: "running", triggered_by: triggeredBy, started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) {
      console.error("[sync-sku-items] logSync erro PostgREST (segue sem log):", error.message);
      return "";
    }
    return (data as { id?: string } | null)?.id ?? "";
  } catch (e) {
    console.error("[sync-sku-items] logSync exceção (segue sem log):", e instanceof Error ? e.message : e);
    return "";
  }
}

async function completeSync(
  db: SupabaseClient,
  logId: string,
  results: Record<string, unknown>,
  errorMsg: string | undefined,
  duracaoMs: number,
): Promise<void> {
  if (!logId) return;
  try {
    const { error } = await db
      .from("fin_sync_log")
      .update({
        status: errorMsg ? "error" : "complete",
        results,
        error_message: errorMsg ?? null,
        duracao_ms: duracaoMs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logId);
    if (error) {
      // update que falha deixa a linha 'running' → vira órfã 'error' no watchdog.
      console.error("[sync-sku-items] completeSync erro PostgREST (linha fica 'running'):", error.message);
    }
  } catch (e) {
    console.error("[sync-sku-items] completeSync exceção (best-effort):", e instanceof Error ? e.message : e);
  }
}

// Marca tentativa de consulta no controle da fila (writer único desta tabela é esta edge).
// Não derruba o run (o leadtime já upsertado continua válido), mas devolve `false` para
// o chamador contar: se NENHUMA marcação persistir, o backoff está inoperante e o run
// termina 'error' — sem isso o fix falharia em silêncio, que é o defeito original.
// Corrida (cron × manual): dois runs podem ler `tentativas` e gravar o mesmo valor,
// perdendo um incremento. Custo = uma consulta Omie a mais lá na frente (backoff mais
// curto), nunca dado errado — o upsert do leadtime é idempotente por (tracking, sku).
async function marcarTentativa(
  db: SupabaseClient,
  trackingId: string,
  tentativas: number,
  motivo: string,
): Promise<boolean> {
  try {
    const { error } = await db.from("sku_items_sync_controle").upsert(
      {
        tracking_id: trackingId,
        tentativas,
        ultima_tentativa: new Date().toISOString(),
        motivo: motivo.slice(0, 300),
      },
      { onConflict: "tracking_id" },
    );
    if (error) {
      console.warn("[sync-sku-items] marcarTentativa falhou (segue):", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      "[sync-sku-items] marcarTentativa exceção (segue):",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

interface RecomputeEtapa {
  etapa: string;
  valor: number;
}

interface RecomputeResultado {
  recomputadas: number;
  anuladas: number;
  erro: string | null;
}

// Recompute derivado dos leadtimes — LOCAL, sem tocar a Omie (a RPC deriva do t4 que o sync
// irmão já gravou em purchase_orders_tracking). Ver a migration
// 20260716200000_reposicao_recompute_leadtime_derivado.sql para o porquê e as medições.
//
// Best-effort de propósito: se o recompute falhar, o leadtime fica como está hoje (não
// PIORA), e derrubar o run aqui desperdiçaria a quota Omie do sync de itens, que é o
// trabalho principal. Mas a falha NÃO some: vira `recompute_erro` no summary e marca o
// fin_sync_log como 'error' (o Sentinela acorda) — senão o gap voltaria a crescer em
// silêncio, que é exatamente o defeito original.
async function recomputarLeadtimeDerivado(
  db: SupabaseClient,
  empresa: Empresa,
): Promise<RecomputeResultado> {
  try {
    // supabase-js NÃO lança em erro PostgREST — retorna { error }. Checar explícito.
    const { data, error } = await db.rpc("recomputar_leadtime_derivado", {
      p_empresa: empresa,
    });
    if (error) {
      console.error("[sync-sku-items] recompute derivado falhou (segue):", error.message);
      return { recomputadas: 0, anuladas: 0, erro: error.message };
    }
    const etapas = (data ?? []) as RecomputeEtapa[];
    const valorDe = (nome: string): number =>
      etapas.find((e) => e?.etapa === nome)?.valor ?? 0;
    return {
      recomputadas: valorDe("leadtime_recomputado"),
      anuladas: valorDe("leadtime_anulado_t1_nao_e_pedido"),
      erro: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sync-sku-items] recompute derivado exceção (segue):", msg);
    return { recomputadas: 0, anuladas: 0, erro: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let logId = "";
  // cron = x-cron-secret (cron diário direto) OU service-role (via orquestrador omie-cron-diario,
  // que chama as edges com Bearer SERVICE_ROLE, sem repassar o x-cron-secret). user JWT (staff) = manual.
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const triggeredBy = (req.headers.get("x-cron-secret") ||
    (svcKey && req.headers.get("Authorization") === `Bearer ${svcKey}`)) ? "cron" : "manual";

  try {
    const body: RequestBody = await req.json().catch(() => ({}));
    const empresa: Empresa = (body.empresa ?? "OBEN") as Empresa;
    const dias = Math.max(1, Math.min(365, body.dias ?? 30));
    const fornecedorFiltro = body.fornecedor_codigo_omie ?? null;

    const { app_key, app_secret } = getCredentials(empresa);
    logId = await logSync(supabase, "sync_sku_items", [empresaParaLog(empresa)], triggeredBy);

    // ── ETAPA 0: recompute derivado, ANTES de qualquer chamada Omie ──
    // No INÍCIO, não no fim: o guard de TIMEOUT_GUARD_MS dá `break` no meio do loop
    // justamente quando a fila está grande — um recompute no fim deixaria de rodar
    // EXATAMENTE nos dias em que mais há t4 novo para derivar. Aqui ele independe da fila
    // (roda até com fila vazia), do rate-limit e do guard de 50s.
    const recompute = await recomputarLeadtimeDerivado(supabase, empresa);
    if (recompute.recomputadas > 0 || recompute.anuladas > 0) {
      console.log(
        `[sync-sku-items] recompute derivado: ${recompute.recomputadas} recomputadas, ${recompute.anuladas} anuladas`,
      );
    }

    const cutoffIso = new Date(Date.now() - dias * 86_400_000).toISOString();

    let q = supabase
      .from("purchase_orders_tracking")
      .select(
        "id, nfe_chave_acesso, t1_data_pedido, t2_data_faturamento, t3_data_cte, t4_data_recebimento, fornecedor_codigo_omie, fornecedor_nome, raw_data, nid_receb",
      )
      .eq("empresa", empresa)
      .gte("t2_data_faturamento", cutoffIso)
      .not("t2_data_faturamento", "is", null)
      .not("nfe_chave_acesso", "is", null)
      .order("t2_data_faturamento", { ascending: false });
    if (fornecedorFiltro) q = q.eq("fornecedor_codigo_omie", fornecedorFiltro);

    const { data: nfes, error: nfesErr } = await q;
    if (nfesErr) throw nfesErr;

    const trackingIds = ((nfes ?? []) as NFeRow[]).map((nfe) => nfe.id);
    const existingTrackingIds = new Set<string>();
    if (trackingIds.length > 0) {
      const { data: existingRows, error: existingErr } = await supabase
        .from("sku_leadtime_history")
        .select("tracking_id")
        .in("tracking_id", trackingIds);
      if (existingErr) throw existingErr;
      for (const row of (existingRows ?? []) as ExistingTrackingRow[]) {
        if (row?.tracking_id) existingTrackingIds.add(row.tracking_id);
      }
    }

    // Controle de tentativas — FAIL-CLOSED, antes de qualquer chamada Omie.
    // Sem o controle não há backoff: a NFe que responde 0 itens volta à fila para
    // sempre e consome o guard de 50s (o incidente que esta edge conserta). Degradar
    // aqui reviveria o poison EM SILÊNCIO, então a ausência da tabela (deploy fora de
    // ordem: edge antes da migration) tem de gritar — 'error' acionável no Sentinela.
    const controleMap = new Map<string, SkuItemsFilaControle>();
    if (trackingIds.length > 0) {
      const { data: controleRows, error: controleErr } = await supabase
        .from("sku_items_sync_controle")
        .select("tracking_id, tentativas, ultima_tentativa")
        .in("tracking_id", trackingIds);
      if (controleErr) {
        throw new Error(
          `sku_items_sync_controle ilegível (migration aplicada? cache do PostgREST?): ${controleErr.message}`,
        );
      }
      for (
        const row of (controleRows ?? []) as Array<
          { tracking_id: string; tentativas: number | null; ultima_tentativa: string | null }
        >
      ) {
        if (!row?.tracking_id) continue;
        controleMap.set(row.tracking_id, {
          tentativas: row.tentativas ?? 0,
          ultima_tentativa: row.ultima_tentativa,
        });
      }
    }

    const agoraMs = Date.now();
    const pendentes = ((nfes ?? []) as NFeRow[]).filter((n) => !existingTrackingIds.has(n.id));
    const filaOrdenada: NFeFilaRow[] = pendentes
      .map((n) => ({
        ...n,
        // Dual-read: a coluna dedicada VENCE; o jsonb fica como fallback da transição.
        // Quando o backfill do sync de NFes convergir, ele para de re-consultar a Omie e
        // portanto para de regravar o raw_data — um leitor só-jsonb regrediria em silêncio.
        nIdReceb: n.nid_receb != null
          ? String(n.nid_receb)
          : (n.raw_data?.cabec?.nIdReceb != null
            ? String(n.raw_data.cabec.nIdReceb)
            : null),
      }))
      .filter((n) => skuItemsElegivel(controleMap.get(n.id), agoraMs))
      .sort((a, b) =>
        skuItemsCompararFila(
          { tentativas: controleMap.get(a.id)?.tentativas ?? 0, t2: a.t2_data_faturamento, id: a.id },
          { tentativas: controleMap.get(b.id)?.tentativas ?? 0, t2: b.t2_data_faturamento, id: b.id },
        )
      );
    // Uma NFe que fatura N pedidos deixa N linhas com o MESMO nIdReceb (o backfill do
    // sync de NFes o grava em todas). Sem isto, cada uma consulta o MESMO recebimento e
    // regrava os MESMOS itens sob o seu tracking_id — peso N× na estatística de leadtime.
    // A eleita só faz a CHAMADA; o destino de cada item é o pedido dele (ver upsert).
    const fila = skuItemsDedupPorRecebimento(filaOrdenada);
    const recebimentosDeduplicados = filaOrdenada.length - fila.length;

    const summary: EmpresaSummary = {
      empresa,
      recompute_recomputadas: recompute.recomputadas,
      recompute_anuladas: recompute.anuladas,
      recompute_erro: recompute.erro,
      fila_pendente: pendentes.length,
      fila_em_backoff: pendentes.length - filaOrdenada.length,
      recebimentos_deduplicados: recebimentosDeduplicados,
      nfes_processadas: 0,
      nfes_sem_nidreceb: 0,
      nfes_sem_nidreceb_dias_max: 0,
      consultas_tentadas: 0,
      consultas_detalhadas: 0,
      itens_processados: 0,
      itens_fundidos_sku_repetido: 0,
      grupos_t1_ambiguo: 0,
      itens_com_pedido_mapeado: 0,
      itens_sem_pedido: 0,
      skus_distintos: 0,
      erros: 0,
      controle_falhas: 0,
      interrompido_por_timeout: false,
    };

    const skusVistos = new Set<number>();
    let nfesInspecionadas = 0;

    for (const nfeRaw of fila) {
      nfesInspecionadas++;
      if (
        nfesInspecionadas % TIMEOUT_CHECK_EVERY_NFES === 0 &&
        Date.now() - startedAt > TIMEOUT_GUARD_MS
      ) {
        summary.interrompido_por_timeout = true;
        break;
      }

      summary.nfes_processadas++;
      const tentativasPrevias = controleMap.get(nfeRaw.id)?.tentativas ?? 0;

      const nIdReceb = nfeRaw.nIdReceb;
      if (!nIdReceb) {
        // Sem nIdReceb não há o que consultar. NÃO marca tentativa (re-checar não custa
        // chamada Omie), mas também NÃO se auto-resolve: a linha com pedido casado quase
        // nunca ganha nIdReceb — o raw_data dela é o do PEDIDO, e o recebimento só traz
        // nIdReceb nas linhas órfãs (uma mesma chave de NFe não aparece nos dois papéis).
        // Ou seja, estas NFes nunca viram leadtime: é um gap de COBERTURA pré-existente,
        // não o poison deste fix. Fica contado aqui (nfes_sem_nidreceb + idade da mais
        // antiga) para não seguir invisível; a correção é rastreada à parte.
        summary.nfes_sem_nidreceb++;
        const idadeDias = Math.floor(
          (agoraMs - Date.parse(nfeRaw.t2_data_faturamento)) / 86_400_000,
        );
        if (Number.isFinite(idadeDias) && idadeDias > summary.nfes_sem_nidreceb_dias_max) {
          summary.nfes_sem_nidreceb_dias_max = idadeDias;
        }
        console.warn(`[sync-sku-items] NFe ${nfeRaw.id} sem nIdReceb (${idadeDias}d)`);
        continue;
      }

      let detalhe: OmieConsultarRecebimentoResponse;
      try {
        await sleep(RATE_LIMIT_DELAY_MS);
        summary.consultas_tentadas++;
        detalhe = await callOmie(app_key, app_secret, "ConsultarRecebimento", {
          nIdReceb: Number(nIdReceb),
        });
        summary.consultas_detalhadas++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const marcou = await marcarTentativa(
          supabase,
          nfeRaw.id,
          tentativasPrevias + 1,
          `consulta_falhou: ${msg}`,
        );
        if (!marcou) summary.controle_falhas++;
        console.error(`[sync-sku-items] ConsultarRecebimento ${nIdReceb} falhou:`, msg);
        continue;
      }

      const itens: OmieRecebimentoItem[] = Array.isArray(detalhe?.itensRecebimento)
        ? detalhe.itensRecebimento
        : [];
      const faultstring = typeof detalhe?.faultstring === "string" && detalhe.faultstring
        ? detalhe.faultstring
        : null;
      let itensDaNfe = 0;

      // ── Passada 1: RESOLVER cada item ao seu tracking destino (lookup de pedido por item).
      // NÃO upserta aqui: o mesmo SKU pode se repetir na NFe e cair no mesmo tracking; upsert
      // item-a-item com onConflict (tracking_id, sku_codigo_omie) faria o 2º SOBRESCREVER o 1º
      // em vez de somar (bug medido em prod 2026-07-17 — ver agregarItensRecebimento).
      const resolvidos: ItemRecebimentoResolvido[] = [];
      for (const item of itens) {
        const cab = item?.itensCabec ?? {};
        const adic = item?.itensInfoAdic ?? {};
        const ajustes = item?.itensAjustes ?? {};

        const skuCodigoOmie = toNum(cab?.nIdProduto);
        if (!skuCodigoOmie) {
          continue;
        }

        const nNumPedCompra = toStr(adic?.nNumPedCompra);

        // Tentar mapear o pedido específico via numero_contrato_fornecedor
        let pedidoMatch: PedidoTrackingMatchRow | null = null;
        if (nNumPedCompra && nNumPedCompra !== "0") {
          const { data: pedidoRows, error: pedErr } = await supabase
            .from("purchase_orders_tracking")
            .select(
              "id, t1_data_pedido, numero_pedido, grupo_leadtime, fornecedor_nome",
            )
            .eq("empresa", empresa)
            .eq("fornecedor_codigo_omie", nfeRaw.fornecedor_codigo_omie)
            .eq("numero_contrato_fornecedor", nNumPedCompra)
            .limit(1);
          if (!pedErr && pedidoRows && pedidoRows.length > 0) {
            pedidoMatch = pedidoRows[0] as unknown as PedidoTrackingMatchRow;
          }
        }

        if (pedidoMatch) summary.itens_com_pedido_mapeado++;
        else summary.itens_sem_pedido++;

        // O item vai pro tracking do SEU pedido, não pro da linha que estava iterando.
        // Era ESTE o defeito histórico: gravar sob `nfeRaw.id` fazia cada uma das N linhas
        // da NFe regravar a NFe inteira. Com o dedup da fila (1 linha por nIdReceb) + este
        // destino, as N linhas ganham só os SEUS itens, da MESMA chamada Omie.
        //
        // ⚠️ Sem pedido casado o item cai na linha eleita (fallback). NÃO é o dono
        // correto — é um pouso determinístico (a eleição é estável: a fila tem ordem
        // total, com id de desempate). O destino honesto seria tracking_id=NULL +
        // match_status, mas a coluna é NOT NULL: o modelo atual não sabe dizer "não sei"
        // (por isso o receipt-first ledger é a fase seguinte, não este patch).
        resolvidos.push({
          tracking_id: pedidoMatch?.id ?? nfeRaw.id,
          sku_codigo_omie: skuCodigoOmie,
          sku_codigo: toStr(cab?.cCodigoProduto),
          sku_descricao: toStr(cab?.cDescricaoProduto),
          sku_unidade: toStr(cab?.cUnidadeNfe),
          sku_ncm: toStr(cab?.cNCM),
          fornecedor_codigo_omie: nfeRaw.fornecedor_codigo_omie,
          fornecedor_nome: pedidoMatch?.fornecedor_nome ?? nfeRaw.fornecedor_nome,
          grupo_leadtime: pedidoMatch?.grupo_leadtime ?? "OUTRO",
          quantidade_pedida: toNum(cab?.nQtdeNFe),
          quantidade_recebida: toNum(ajustes?.nQtdeRecebida),
          valor_unitario: toNum(cab?.nPrecoUnit),
          valor_total: toNum(cab?.vTotalItem),
          t1_data_pedido: pedidoMatch?.t1_data_pedido ?? nfeRaw.t2_data_faturamento,
          // Proveniência do t1 — sem ela, itens do MESMO sku com origens distintas (um casando
          // o pedido, outro no fallback) caem no mesmo bucket e o t1 emitido dependeria da
          // ordem da resposta da Omie. Em prod há 40 itens / 12 trackings capazes disso.
          t1_de_pedido: pedidoMatch !== null,
          t2_data_faturamento: nfeRaw.t2_data_faturamento,
          t3_data_cte: nfeRaw.t3_data_cte,
          t4_data_recebimento: nfeRaw.t4_data_recebimento,
        });
      }

      // ── Passada 2: AGREGAR por (tracking, sku) e upsertar 1 linha por grupo. O lt_* é
      // derivado das datas do AGREGADO (iguais entre itens do mesmo tracking).
      const agregados = agregarItensRecebimento(resolvidos);
      summary.itens_fundidos_sku_repetido += resolvidos.length - agregados.length;
      for (const ag of agregados) {
        // Bucket com t1 AMBÍGUO (itens do mesmo sku com proveniências/t1 distintos): não dá
        // para saber qual t1 é a data de pedido, e leadtime derivado de t1 errado é o defeito
        // que o #1365 matou (subestima e faz pedir tarde). Fail-closed: grava as datas mas
        // NÃO emite lt_bruto/lt_faturamento. O lt_logistica (t2→t4) não depende do t1 e segue.
        const t1Confiavel = !ag.t1_ambiguo;
        if (ag.t1_ambiguo) summary.grupos_t1_ambiguo++;
        const upsertRow = {
          tracking_id: ag.tracking_id,
          empresa,
          sku_codigo_omie: ag.sku_codigo_omie,
          sku_codigo: ag.sku_codigo,
          sku_descricao: ag.sku_descricao,
          sku_unidade: ag.sku_unidade,
          sku_ncm: ag.sku_ncm,
          fornecedor_codigo_omie: ag.fornecedor_codigo_omie,
          fornecedor_nome: ag.fornecedor_nome,
          grupo_leadtime: ag.grupo_leadtime,
          quantidade_pedida: ag.quantidade_pedida,
          quantidade_recebida: ag.quantidade_recebida,
          valor_unitario: ag.valor_unitario,
          valor_total: ag.valor_total,
          t1_data_pedido: ag.t1_data_pedido,
          t2_data_faturamento: ag.t2_data_faturamento,
          t3_data_cte: ag.t3_data_cte,
          t4_data_recebimento: ag.t4_data_recebimento,
          // t1 ambíguo ⇒ lt que DEPENDE do t1 não é emitido (degradação honesta: "não sei"
          // vale mais que um leadtime derivado do t1 errado — o #1365 mostrou que o lt
          // subestimado faz pedir TARDE). O lt_logistica (t2→t4) não usa t1 e segue válido.
          lt_bruto_dias_uteis: t1Confiavel
            ? diasUteisEntre(ag.t1_data_pedido, ag.t4_data_recebimento)
            : null,
          lt_faturamento_dias_uteis: t1Confiavel
            ? diasUteisEntre(ag.t1_data_pedido, ag.t2_data_faturamento)
            : null,
          lt_logistica_dias_uteis: diasUteisEntre(ag.t2_data_faturamento, ag.t4_data_recebimento),
          updated_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from("sku_leadtime_history")
          .upsert(upsertRow, { onConflict: "tracking_id,sku_codigo_omie" });
        if (upErr) {
          summary.erros++;
          console.error(
            `[sync-sku-items] upsert NFe ${nfeRaw.id} sku ${ag.sku_codigo_omie} falhou:`,
            upErr.message,
          );
          continue;
        }
        summary.itens_processados++;
        itensDaNfe++;
        skusVistos.add(ag.sku_codigo_omie);
      }

      // Consulta feita → marca tentativa SEMPRE. Sem isto, NFe com 0 itens upsertados
      // nunca sai da fila (não ganha linha em sku_leadtime_history) e vira poison
      // re-consultado a cada run — o backoff só funciona se a tentativa for registrada.
      const marcou = await marcarTentativa(
        supabase,
        nfeRaw.id,
        tentativasPrevias + 1,
        itensDaNfe > 0
          ? "ok_com_itens"
          : (faultstring ? `fault: ${faultstring}` : "ok_0_itens"),
      );
      if (!marcou) summary.controle_falhas++;

      if (Date.now() - startedAt > TIMEOUT_GUARD_MS) {
        summary.interrompido_por_timeout = true;
        break;
      }
    }

    summary.skus_distintos = skusVistos.size;
    // Falha sistêmica = consultas Omie foram TENTADAS e nenhuma respondeu (rate-limit 3x /
    // HTTP). NFe pendente sem nIdReceb NÃO é tentativa (não há chamada) — janela só com
    // elas marcava 'error' "rate-limit?" falso e acordava o Sentinela (OBEN 2026-07-14).
    // Resposta 200 com faultstring de negócio ("recebimento inexistente") CONTA como
    // respondida: é defeito de uma NFe (vai pro `motivo` do controle e sai por backoff),
    // não indisponibilidade da Omie — tratá-la como falha recriaria o alerta falso.
    const falhaSistemica = summary.consultas_tentadas > 0 && summary.consultas_detalhadas === 0
      ? `${summary.consultas_tentadas} consultas Omie tentadas, 0 OK — rate-limit/indisponibilidade?`
      : undefined;
    // Backoff inoperante (grant/RLS): o leadtime gravado continua válido, mas sem
    // persistir tentativa o poison volta — falha silenciosa. Só grita se NENHUMA marcou.
    const falhaControle = !falhaSistemica && summary.consultas_tentadas > 0 &&
        summary.controle_falhas === summary.consultas_tentadas
      ? `controle não persistiu em ${summary.controle_falhas}/${summary.consultas_tentadas} tentativas — backoff inoperante (grant/RLS?)`
      : undefined;
    // Recompute quebrado é acionável: a causa provável é migration não aplicada (deploy fora
    // de ordem — edge antes do SQL Editor) ou grant faltando no service_role. Não derruba o
    // run (o leadtime só deixa de MELHORAR, não piora), mas tem de gritar: em silêncio, o
    // gap de ~30% volta a crescer sem ninguém saber — o defeito que esta edge conserta.
    const falhaRecompute = recompute.erro
      ? `recompute derivado do leadtime falhou (migration 20260716200000 aplicada? grant do service_role?): ${recompute.erro}`
      : undefined;
    await completeSync(
      supabase,
      logId,
      summary as unknown as Record<string, unknown>,
      falhaSistemica ?? falhaControle ?? falhaRecompute,
      Date.now() - startedAt,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        duracao_ms: Date.now() - startedAt,
        summary: [summary],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[sync-sku-items] erro fatal:", e);
    await completeSync(supabase, logId, {}, e instanceof Error ? e.message : String(e), Date.now() - startedAt);
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        duracao_ms: Date.now() - startedAt,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
