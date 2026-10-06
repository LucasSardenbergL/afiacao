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
//   2) Fila = trackings PENDENTES (recebimento.ts, `pendenteNaFila`: com a pendência medida, decide
//      `itens_pendentes` > 0; sem medida — legado —, "sem linha em sku_leadtime_history"), MENOS o
//      CT-e (modelo 57 pela chave de acesso: o frete não tem item de produto — escopo.ts, contado em
//      `ctes_fora_da_fila`), ELEGÍVEIS pelo controle de tentativas (sku_items_sync_controle + backoff
//      6h/24h/72h), nunca-tentadas primeiro — NFe cuja consulta retorna 0 itens não upserta e não
//      sairia nunca da fila (poison que consumia o guard de 50s a cada run; OBEN 2026-07-14). Até
//      2026-10-05 a fila era só "sem linha": UMA linha gravada tirava o recebimento da fila com item
//      faltando, para sempre.
//   3) Para cada NFe → ConsultarRecebimento(nIdReceb) → itera itensRecebimento[]; TODA
//      consulta que a Omie RESPONDEU (sucesso, 0 itens, fault de negócio) ou que FALHOU de
//      verdade (HTTP/socket) marca tentativa no controle. Limite do RUN (REDUNDANT/rate-limit
//      que não cabe no deadline, deadline vencido) é ADIAMENTO: não marca, não vira `error` —
//      ver adiamento.ts (incidente OBEN 2026-08-27..09-23: 46 runs `error` falsos no ciclo :15).
//   4) Gravação do RECEBIMENTO (recebimento.ts, `gravarRecebimento`): controle em TODAS as irmãs
//      (mesma nid_receb), write-ahead da pendência, rota de cada item ao pedido dele
//      (numero_contrato_fornecedor = nNumPedCompra; sem casamento, o DONO do recebimento), UPSERT em
//      sku_leadtime_history (tracking_id, sku_codigo_omie) e fechamento da pendência com CAS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { cabeEspera } from "../_shared/omie-deadline.ts";
import { avaliarFilaParada, decidirErroDoRun, ELEGIVEL_HA_MUITO_MS, saidaDoLaco } from "./adiamento.ts";
import { consultarNfe, type ContadorRequisicoes, DEPS_REAIS } from "./consulta.ts";
import {
  type ControleFila,
  type DepsGravacao,
  type EstadoControle,
  gravarRecebimento,
  type Irma,
  type PedidoCasado,
  pendenteNaFila,
} from "./recebimento.ts";
import { separarCtes } from "./escopo.ts";
import { classificarSonda, EDGE, EFEITO, erroSondaAmbigua, FONTE, respostaSonda, VERSAO } from "./versao.ts";

// Tipos da resposta do Omie: consulta.ts (junto da chamada que os produz).

interface NFeRawData {
  cabec?: { nIdReceb?: number | string };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMIT_DELAY_MS = 5000;
const TIMEOUT_GUARD_MS = 50_000;
// Teto por request, espera padrão de limite e nº de tentativas da chamada: OPCOES_PADRAO em consulta.ts.
const TIMEOUT_CHECK_EVERY_NFES = 5;

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
  /** Linhas PENDENTES na janela (`pendenteNaFila`: sem linha no legado; pendência medida > 0 — ver
   *  `fila_incompleta`) que são CONSULTÁVEIS por desenho (o CT-e já saiu: ver `ctes_fora_da_fila`).
   *  Inclui as em backoff, as irmãs de um mesmo recebimento e as sem nIdReceb. */
  fila_pendente: number;
  fila_em_backoff: number;
  /** Trackings pendentes COM linha gravada — só entram porque a pendência medida é > 0. */
  fila_incompleta: number;
  /** Trackings SEM linha que a pendência medida (0) tira da fila: irmã a quem nenhum item foi
   *  roteado, recebimento só de itens ignorados. Pela regra antiga seriam reconsultados para sempre. */
  fila_concluida_sem_linha: number;
  /** Linhas pendentes de modelo 57 (CT-e, o frete) tiradas da fila ANTES do backoff, sem consulta à
   *  Omie e sem escrita no controle: CT-e não tem item de produto (escopo.ts). Pendentes brutos =
   *  `fila_pendente` + `ctes_fora_da_fila`. Conta linhas, não requests economizados. */
  ctes_fora_da_fila: number;
  /** Linhas tiradas da fila por dividirem o nIdReceb com uma já eleita (NFe que fatura
   *  N pedidos). = chamadas Omie economizadas E duplicatas de leadtime não criadas. */
  recebimentos_deduplicados: number;
  nfes_processadas: number;
  nfes_sem_nidreceb: number;
  nfes_sem_nidreceb_dias_max: number;
  /** NFes para as quais ao menos 1 request SAIU para a Omie (inclui as que depois foram adiadas).
   *  Deadline vencido antes do 1º request conta ZERO. Sozinho não decide nada. */
  consultas_tentadas: number;
  /** Requests INICIADOS ao Omie (invocações do request, retentativas incluídas) — o consumo de
   *  cota do run. Uma invocação que lançou antes de sair para a rede também conta. */
  requisicoes_omie: number;
  /** NFes que a Omie RESPONDEU (2xx, objeto JSON): com itens, 0 itens ou faultstring de negócio. */
  consultas_detalhadas: number;
  /** NFes ADIADAS por limite do RUN (REDUNDANT/rate-limit que não cabe no deadline, limite que
   *  persistiu nas retentativas, deadline vencido antes da chamada). NÃO marcam tentativa e NÃO
   *  viram `error`: a NFe mantém as tentativas que tinha e segue elegível (adiamento.ts). */
  consultas_adiadas_por_limite: number;
  /** NFes com falha REAL (HTTP não-2xx, socket abortado, corpo que não é objeto JSON) — marcam tentativa. */
  consultas_falhas: number;
  /** RECEBIMENTOS da fila elegível deste run, com nIdReceb, com alguma linha ELEGÍVEL há mais de
   *  48h (fim do backoff, ou o maior entre nascimento e faturamento se nunca tentada), que o run NÃO
   *  tratou (nem resposta nem falha marcada): adiados por limite ou não alcançados pelo guard. >0 ⇒
   *  `error` "fila não anda" — o sensor pelo DADO que o adiamento silencioso exige (adiamento.ts).
   *  `null` = NÃO AVALIADO: chamada via orquestrador (o :15 do jobid 52), onde o adiamento por
   *  REDUNDANT é esperado enquanto o sku-items for step dele — ausente, nunca zero. */
  fila_parada_48h: number | null;
  /** O mesmo sensor sobre os INCOMPLETOS (recebimento com linha e pendência > 0, elegível há >48h, não
   *  tratado): fica no results e NÃO vira `error` — a retentativa de item que talvez nunca seja associado
   *  não pode fabricar "fila não anda". `null` = não avaliado (via orquestrador). */
  fila_incompleta_parada_48h: number | null;
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
  /** Itens SEM nIdProduto e não ignorados (associação pendente no recebimento da Omie) — pendência. */
  itens_aguardando_associacao: number;
  /** Itens sem nIdProduto com cIgnorarItem = "S": nunca viram SKU (terminais, fora da pendência). */
  itens_ignorados: number;
  /** Itens cujo lookup de pedido deu ERRO de banco (≠ "não casou"): pendência, nunca o fallback. */
  itens_sem_rota_pedido: number;
  /** Itens retidos por dividirem o SKU com um item sem rota — gravar o resto seria subtotal. */
  itens_retidos_sku_sem_rota: number;
  /** Recebimentos que terminaram o run com pendência > 0: voltam à fila depois do backoff. */
  recebimentos_incompletos: number;
  skus_distintos: number;
  erros: number;
  /** Recebimentos cujo controle o run tentou marcar (1 por NFe respondida ou com falha real),
   *  em todas as irmãs de uma vez. */
  controle_marcacoes: number;
  controle_falhas: number;
  /** Fechamentos da pendência (UPDATE com CAS no carimbo, depois dos upserts — recebimento.ts). */
  controle_fechamentos: number;
  /** Fechamentos com ERRO: fica a pendência conservadora do write-ahead (volta à fila, não some). */
  controle_fechamentos_falhos: number;
  /** Fechamentos PRETERIDOS pelo CAS: outro run gravou o controle depois do nosso carimbo. */
  controle_fechamentos_preteridos: number;
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
  /** Nascimento da linha — metade do "elegível desde" do sensor `fila_parada_48h` (adiamento.ts). */
  created_at: string | null;
}

/** NFeRow com o nIdReceb já extraído do raw_data — a fila dedup-a por ele, e o
 *  raw_data é jsonb MULTI-WRITER (o sync de pedidos o sobrescreve com o payload do
 *  pedido e apaga o nIdReceb), então lê-lo UMA vez por run evita depender de um campo
 *  que pode mudar debaixo do loop. */
type NFeFilaRow = NFeRow & { nIdReceb: string | null };

/** O nIdReceb da linha. Dual-read: a coluna dedicada VENCE; o jsonb fica como fallback da transição.
 *  Quando o backfill do sync de NFes convergir, ele para de re-consultar a Omie e portanto para de
 *  regravar o raw_data — um leitor só-jsonb regrediria em silêncio. */
function nIdRecebDe(n: NFeRow): string | null {
  return n.nid_receb != null
    ? String(n.nid_receb)
    : (n.raw_data?.cabec?.nIdReceb != null ? String(n.raw_data.cabec.nIdReceb) : null);
}

/** As irmãs lidas por nid_receb, com a ELEITA garantida entre elas (se o nIdReceb dela veio do jsonb,
 *  a coluna não a achou — ela vai sozinha, e o dono é ela, como antes). */
function irmasDoRecebimento(lidas: readonly Irma[] | undefined, eleita: NFeFilaRow): Irma[] {
  const irmas = [...(lidas ?? [])];
  if (!irmas.some((i) => i.id === eleita.id)) {
    irmas.push({
      id: eleita.id,
      t1_data_pedido: eleita.t1_data_pedido,
      t2_data_faturamento: eleita.t2_data_faturamento,
      t3_data_cte: eleita.t3_data_cte,
      t4_data_recebimento: eleita.t4_data_recebimento,
      fornecedor_codigo_omie: eleita.fornecedor_codigo_omie,
      fornecedor_nome: eleita.fornecedor_nome,
    });
  }
  return irmas;
}

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

// Marca a tentativa do RECEBIMENTO no controle de TODAS as irmãs, num statement só (writer único
// desta tabela é esta edge). Sem `itens_pendentes` no estado, a pendência medida antes NÃO é tocada:
// o upsert do PostgREST atualiza só as colunas do payload. Não derruba o run, mas devolve `false`
// para o chamador contar: se NENHUMA marcação persistir, o backoff está inoperante e o run termina
// 'error' — sem isso o fix falharia em silêncio, que é o defeito original.
// Corrida (cron × manual): dois runs podem ler `tentativas` e gravar o mesmo valor, perdendo um
// incremento — custo de uma consulta Omie a mais, nunca dado errado. A PENDÊNCIA não corre esse
// risco: o fechamento só a reduz onde `ultima_tentativa` ainda é o carimbo deste run (CAS).
async function marcarTentativa(
  db: SupabaseClient,
  trackingIds: readonly string[],
  estado: EstadoControle,
): Promise<boolean> {
  try {
    const linhas = trackingIds.map((tracking_id) => ({
      tracking_id,
      tentativas: estado.tentativas,
      ultima_tentativa: estado.ultima_tentativa,
      motivo: estado.motivo.slice(0, 300),
      ...(estado.itens_pendentes !== undefined ? { itens_pendentes: estado.itens_pendentes } : {}),
    }));
    const { error } = await db.from("sku_items_sync_controle").upsert(linhas, { onConflict: "tracking_id" });
    if (error) {
      console.warn("[sync-sku-items] marcarTentativa falhou (segue):", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[sync-sku-items] marcarTentativa exceção (segue):", mensagemDeErro(e) ?? "sem mensagem");
    return false;
  }
}

// O banco que `gravarRecebimento` usa (recebimento.ts): nenhum método lança — erro volta no
// retorno, e o módulo o transforma em pendência ou desfecho.
function depsDeGravacao(db: SupabaseClient, empresa: Empresa): DepsGravacao {
  return {
    async buscarPedido(fornecedor, numero) {
      // Sem fornecedor não há como escopar o pedido — casar por número entre fornecedores seria
      // chute. "Não casou" (o fallback de sempre), não erro.
      if (fornecedor === null) return { ok: true, pedido: null };
      try {
        // Ordem TOTAL (.order("id")): o mesmo número de pedido pode casar mais de uma linha, e sem
        // ordem o item caía ora numa, ora noutra entre runs — a reconsulta criava chave nova.
        const { data, error } = await db
          .from("purchase_orders_tracking")
          .select("id, t1_data_pedido, grupo_leadtime, fornecedor_nome")
          .eq("empresa", empresa)
          .eq("fornecedor_codigo_omie", fornecedor)
          .eq("numero_contrato_fornecedor", numero)
          .order("id")
          .limit(1);
        if (error) return { ok: false, erro: error.message };
        return { ok: true, pedido: ((data ?? []) as PedidoCasado[])[0] ?? null };
      } catch (e) {
        return { ok: false, erro: mensagemDeErro(e) ?? "lookup do pedido lançou sem mensagem" };
      }
    },
    async gravarLinha(linha) {
      try {
        const { error } = await db
          .from("sku_leadtime_history")
          .upsert(linha, { onConflict: "tracking_id,sku_codigo_omie" });
        return error ? error.message : null;
      } catch (e) {
        return mensagemDeErro(e) ?? "upsert lançou sem mensagem";
      }
    },
    marcarControle: (ids, estado) => marcarTentativa(db, ids, estado),
    async fecharControle(ids, carimbo, final) {
      try {
        const { data, error } = await db
          .from("sku_items_sync_controle")
          .update({ itens_pendentes: final.itens_pendentes, motivo: final.motivo.slice(0, 300) })
          .in("tracking_id", [...ids])
          .eq("ultima_tentativa", carimbo)
          .select("tracking_id");
        if (error) return { ok: false, erro: error.message };
        return { ok: true, atualizadas: (data ?? []).length };
      } catch (e) {
        return { ok: false, erro: mensagemDeErro(e) ?? "fechamento lançou sem mensagem" };
      }
    },
    agora: () => new Date().toISOString(),
  };
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

// `versao` em TODA resposta (sucesso e erro), não só na da sonda — é a metade da prova que
// dispensa invocação. O `omie-cron-diario` faz `JSON.parse` do corpo deste step e o devolve
// inteiro em `resultados.sku_items.body`, então o marcador viaja para `net._http_response` no tick
// de 2h do jobid 52 e o deploy se prova sem ninguém chamar nada e sem pagar efeito.
function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, versao: VERSAO, edge: EDGE, fonte: FONTE }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que já aceita x-cron-secret) e ANTES do createClient e
  // de qualquer escrita. O parse do corpo SUBIU para cá de propósito: no desenho anterior ele vinha
  // dentro do try, depois do `createClient`, e a sonda ali já teria custo. Daqui pra frente a edge
  // roda o recompute derivado da ETAPA 0 e abre linha em `fin_sync_log`, que o cálculo de frescor
  // lê sem filtrar `action` — sondar de graça exige responder antes.
  // req.json() é one-shot: o corpo lido aqui é reaproveitado no fluxo real abaixo.
  // Ver versao.ts / _shared/sonda-versao.ts.
  const body: RequestBody = await req.json().catch(() => ({}));

  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
  // Fail-CLOSED: `probe` com valor não reconhecido NUNCA cai no fluxo real por omissão.
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonRes({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const startedAt = Date.now();
  // Relógio ÚNICO do run: requests e backoffs da consulta se medem contra ESTE instante, o mesmo
  // que o TIMEOUT_GUARD_MS do laço usa. Teto por request isolado não bastaria — 3 tentativas de
  // 20s mais as esperas "Aguarde N segundos" do Omie passam MUITO dos 50s.
  const deadline = startedAt + TIMEOUT_GUARD_MS;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let logId = "";
  // cron = x-cron-secret (cron diário direto) OU service-role (via orquestrador omie-cron-diario,
  // que chama as edges com Bearer SERVICE_ROLE, sem repassar o x-cron-secret). user JWT (staff) = manual.
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Via ORQUESTRADOR = Bearer service-role SEM x-cron-secret (é assim que o `omie-cron-diario` chama
  // os steps). Só decide se o sensor `fila_parada_48h` é avaliado — ver adiamento.ts.
  const viaOrquestrador = !req.headers.get("x-cron-secret") && !!svcKey &&
    req.headers.get("Authorization") === `Bearer ${svcKey}`;
  const triggeredBy = (req.headers.get("x-cron-secret") ||
    (svcKey && req.headers.get("Authorization") === `Bearer ${svcKey}`)) ? "cron" : "manual";

  try {
    // Corpo já consumido no bloco da sonda acima (req.json() é one-shot) — uma segunda leitura
    // devolveria vazio e `empresa`/`dias` do chamador seriam descartados em SILÊNCIO.
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
        "id, nfe_chave_acesso, t1_data_pedido, t2_data_faturamento, t3_data_cte, t4_data_recebimento, fornecedor_codigo_omie, fornecedor_nome, raw_data, nid_receb, created_at",
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
    // `itens_pendentes` vem desde 2026-10-05 (migration 20261005170000): sem a coluna esta leitura
    // FALHA e o run grita aqui — edge nova antes da migration não roda a regra velha em silêncio.
    const controleMap = new Map<string, ControleFila>();
    if (trackingIds.length > 0) {
      const { data: controleRows, error: controleErr } = await supabase
        .from("sku_items_sync_controle")
        .select("tracking_id, tentativas, ultima_tentativa, itens_pendentes")
        .in("tracking_id", trackingIds);
      if (controleErr) {
        throw new Error(
          `sku_items_sync_controle ilegível (migration aplicada? cache do PostgREST?): ${controleErr.message}`,
        );
      }
      for (
        const row of (controleRows ?? []) as Array<
          {
            tracking_id: string;
            tentativas: number | null;
            ultima_tentativa: string | null;
            itens_pendentes: number | null;
          }
        >
      ) {
        if (!row?.tracking_id) continue;
        controleMap.set(row.tracking_id, {
          tentativas: row.tentativas ?? 0,
          ultima_tentativa: row.ultima_tentativa,
          itens_pendentes: row.itens_pendentes ?? null,
        });
      }
    }

    const agoraMs = Date.now();
    // Pendente = pela pendência MEDIDA quando há (k>0 volta mesmo com linha; k=0 sai mesmo sem); pela
    // regra antiga ("sem linha") no legado — recebimento.ts, `pendenteNaFila`.
    const todas = (nfes ?? []) as NFeRow[];
    const pendentesBrutos = todas.filter((n) => pendenteNaFila(controleMap.get(n.id), existingTrackingIds.has(n.id)));
    // CT-e (modelo 57, o conhecimento de FRETE) sai aqui: a Omie o responde sem `itensRecebimento`,
    // e o produto que ele transporta vira leadtime pela NF-e dele. Era 17 de 17 linhas da fila do
    // diário das 07:00 (2026-10-05), girando no backoff para sempre. A posição é contrato
    // (escopo.ts): ANTES do backoff, do sensor e do dedup. Sem escrita no controle: o motivo antigo
    // fica como histórico.
    const { consultaveis: pendentes, ctes: ctesForaDaFila } = separarCtes(pendentesBrutos);
    // Recebimentos que JÁ têm leadtime em alguma linha da janela. Com pendência eles voltam à fila, mas
    // não são "fila parada": o sensor que pagina segue medindo o recebimento SEM NENHUMA linha — a
    // semântica de antes, quando o recebimento com linha nem entrava na fila (ver o sensor no fim).
    const recebimentosComLinha = new Set(
      todas.filter((n) => existingTrackingIds.has(n.id)).map(nIdRecebDe).filter((r): r is string => r !== null),
    );
    const filaOrdenada: NFeFilaRow[] = pendentes
      .map((n) => ({ ...n, nIdReceb: nIdRecebDe(n) }))
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
    // A eleita só faz a CHAMADA; o destino de cada item é o pedido dele, ou o DONO (recebimento.ts).
    const fila = skuItemsDedupPorRecebimento(filaOrdenada);
    const recebimentosDeduplicados = filaOrdenada.length - fila.length;

    // IRMÃS de cada recebimento da fila: TODAS as linhas com a mesma nid_receb, dentro ou fora da
    // janela de `dias` (cobertura da coluna: 548/548 em 2026-10-05). O recebimento é a unidade: o
    // controle é gravado em todas, e o DONO (menor t2) recebe os itens sem pedido — sem isso o
    // destino dependia da eleita do run, que muda entre runs. FAIL-CLOSED antes de qualquer chamada
    // Omie: sem as irmãs o run não sabe onde gravar.
    const recebimentosDaFila = [...new Set(fila.map((n) => n.nIdReceb).filter((r): r is string => r !== null))];
    const irmasPorRecebimento = new Map<string, Irma[]>();
    if (recebimentosDaFila.length > 0) {
      const { data: irmasRows, error: irmasErr } = await supabase
        .from("purchase_orders_tracking")
        .select(
          "id, nid_receb, t1_data_pedido, t2_data_faturamento, t3_data_cte, t4_data_recebimento, fornecedor_codigo_omie, fornecedor_nome",
        )
        .eq("empresa", empresa)
        .in("nid_receb", recebimentosDaFila)
        .order("id");
      if (irmasErr) throw new Error(`irmãs do recebimento ilegíveis (purchase_orders_tracking): ${irmasErr.message}`);
      const linhasIrmas = (irmasRows ?? []) as Array<Irma & { nid_receb: number | string | null }>;
      // O PostgREST corta em 1.000 linhas EM SILÊNCIO: chegar no teto é leitura possivelmente parcial.
      if (linhasIrmas.length >= 1000) {
        throw new Error(`irmãs do recebimento: ${linhasIrmas.length} linhas — teto do PostgREST, leitura possivelmente parcial`);
      }
      for (const linha of linhasIrmas) {
        if (linha.nid_receb === null || linha.nid_receb === undefined) continue;
        const chave = String(linha.nid_receb);
        const lista = irmasPorRecebimento.get(chave) ?? [];
        lista.push(linha);
        irmasPorRecebimento.set(chave, lista);
      }
    }

    const summary: EmpresaSummary = {
      empresa,
      recompute_recomputadas: recompute.recomputadas,
      recompute_anuladas: recompute.anuladas,
      recompute_erro: recompute.erro,
      fila_pendente: pendentes.length,
      fila_em_backoff: pendentes.length - filaOrdenada.length,
      fila_incompleta: pendentes.filter((n) => existingTrackingIds.has(n.id)).length,
      fila_concluida_sem_linha: todas.filter((n) =>
        !existingTrackingIds.has(n.id) && !pendenteNaFila(controleMap.get(n.id), false)
      ).length,
      ctes_fora_da_fila: ctesForaDaFila.length,
      recebimentos_deduplicados: recebimentosDeduplicados,
      nfes_processadas: 0,
      nfes_sem_nidreceb: 0,
      nfes_sem_nidreceb_dias_max: 0,
      consultas_tentadas: 0,
      requisicoes_omie: 0,
      consultas_detalhadas: 0,
      consultas_adiadas_por_limite: 0,
      consultas_falhas: 0,
      fila_parada_48h: 0,
      fila_incompleta_parada_48h: 0,
      itens_processados: 0,
      itens_fundidos_sku_repetido: 0,
      grupos_t1_ambiguo: 0,
      itens_com_pedido_mapeado: 0,
      itens_sem_pedido: 0,
      itens_aguardando_associacao: 0,
      itens_ignorados: 0,
      itens_sem_rota_pedido: 0,
      itens_retidos_sku_sem_rota: 0,
      recebimentos_incompletos: 0,
      skus_distintos: 0,
      erros: 0,
      controle_marcacoes: 0,
      controle_falhas: 0,
      controle_fechamentos: 0,
      controle_fechamentos_falhos: 0,
      controle_fechamentos_preteridos: 0,
      interrompido_por_timeout: false,
    };
    const deps = depsDeGravacao(supabase, empresa);

    const skusVistos = new Set<number>();
    // RECEBIMENTOS (nIdReceb) que o run TRATOU: a Omie respondeu, ou a falha foi MARCADA no controle.
    // Por recebimento, e não por linha, porque a chamada é por recebimento — as linhas irmãs saem
    // da fila juntas. O sensor "fila não anda" (adiamento.ts) mede o que ficou de fora.
    const recebimentosTratados = new Set<string>();
    // Requests físicos ao Omie (retentativas incluídas) — mutável para sobreviver a exceção.
    const contador: ContadorRequisicoes = { requisicoes: 0 };
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

      // O recebimento é a unidade: as irmãs dividem o controle (recebimento.ts). A eleita está entre
      // elas por construção (mesma nid_receb); se o nIdReceb dela veio do jsonb, ela vai sozinha.
      const irmas = irmasDoRecebimento(irmasPorRecebimento.get(nIdReceb), nfeRaw);
      const idsIrmas = irmas.map((i) => i.id);
      // Tentativas do RECEBIMENTO = a maior entre as irmãs lidas: backoff conservador na transição,
      // enquanto o legado ainda tem contagens diferentes por irmã.
      const tentativasPrevias = Math.max(0, ...idsIrmas.map((id) => controleMap.get(id)?.tentativas ?? 0));

      // Deadline ANTES do sleep de cadência (5s), e não só a cada 5 NFes como o guard do topo:
      // dormir 5s para a consulta adiar em seguida gasta 10% do run à toa. (Até 2026-09-24 havia
      // um 2º motivo, money-path: a recusa por deadline LANÇAVA e a NFe caía no catch com
      // `marcarTentativa` — backoff por um limite do RUN. Hoje ela seria ADIADA, sem marcar.)
      if (!cabeEspera(Date.now(), deadline, RATE_LIMIT_DELAY_MS)) {
        summary.interrompido_por_timeout = true;
        break;
      }

      await sleep(RATE_LIMIT_DELAY_MS);
      const requisicoesAntes = contador.requisicoes;
      // Desfecho já classificado (consulta.ts): respondida · adiada · falhou. A exceção vira
      // `falhou` LÁ, e o adiamento é reconhecido pela marca ESTRUTURAL — nunca pelo texto.
      const resultado = await consultarNfe(DEPS_REAIS, { app_key, app_secret }, Number(nIdReceb), deadline, contador);
      if (contador.requisicoes > requisicoesAntes) summary.consultas_tentadas++;

      if (resultado.tipo === "adiada") {
        // ADIAMENTO por limite do RUN (REDUNDANT/rate-limit que não cabe no deadline, limite que
        // persistiu, deadline vencido): NÃO é defeito da NFe → NÃO marca tentativa (ela mantém as
        // tentativas que tinha e segue elegível) e NÃO conta como falha para o status do run.
        // Punir aqui era o incidente OBEN 2026-08-27..09-23: backoff de 6h por um limite de 50s e
        // 46 runs `error` falsos. Recebimento que siga sem consulta por mais de 48h elegível grita
        // pelo sensor `fila_parada_48h` — pelo dado, não pelo status da chamada.
        summary.consultas_adiadas_por_limite++;
        console.warn(
          `[sync-sku-items] ConsultarRecebimento ${nIdReceb} ADIADA (${resultado.adiamento.motivo}): ${resultado.adiamento.detalhe}`,
        );
        if (saidaDoLaco(resultado.adiamento.motivo) === "encerrar") {
          summary.interrompido_por_timeout = true;
          break;
        }
        continue;
      }

      if (resultado.tipo === "falhou") {
        summary.consultas_falhas++;
        summary.controle_marcacoes++;
        // Sem `itens_pendentes`: a falha não mede nada, e a pendência de antes fica como está.
        const marcou = await marcarTentativa(supabase, idsIrmas, {
          tentativas: tentativasPrevias + 1,
          ultima_tentativa: new Date().toISOString(),
          motivo: `consulta_falhou: ${resultado.mensagem}`,
        });
        // Falha só conta como TRATADA se a marcação persistiu: sem ela a NFe não ganhou backoff nem
        // progresso, e chamá-la de tratada escondia do sensor a NFe parada (achado do Codex).
        if (marcou) recebimentosTratados.add(nIdReceb);
        else summary.controle_falhas++;
        console.error(`[sync-sku-items] ConsultarRecebimento ${nIdReceb} falhou:`, resultado.mensagem);
        continue;
      }

      summary.consultas_detalhadas++;
      summary.controle_marcacoes++;
      // A gravação do recebimento inteira mora em recebimento.ts (testada em Deno contra banco falso):
      // classificação do item, rota do pedido, write-ahead da pendência, upserts e fechamento com CAS.
      const gravado = await gravarRecebimento(
        deps,
        { empresa, irmas, tentativas: tentativasPrevias + 1 },
        resultado.detalhe,
      );
      // Tratado = o controle persistiu (com ele vão a pendência e o backoff). Sem ele nada foi gravado,
      // e chamar de tratado esconderia do sensor o recebimento parado — a regra do ramo da falha.
      if (gravado.controle === "persistiu") recebimentosTratados.add(nIdReceb);
      else summary.controle_falhas++;
      if (gravado.fechamento !== "nao_se_aplica") summary.controle_fechamentos++;
      if (gravado.fechamento === "falhou") summary.controle_fechamentos_falhos++;
      if (gravado.fechamento === "preterido") summary.controle_fechamentos_preteridos++;
      if ((gravado.itensPendentes ?? 0) > 0) summary.recebimentos_incompletos++;
      summary.itens_processados += gravado.gruposGravados;
      summary.erros += gravado.gruposFalhos;
      summary.itens_fundidos_sku_repetido += gravado.itensFundidos;
      summary.grupos_t1_ambiguo += gravado.gruposT1Ambiguo;
      summary.itens_com_pedido_mapeado += gravado.itensComPedido;
      summary.itens_sem_pedido += gravado.itensSemPedido;
      summary.itens_aguardando_associacao += gravado.itensAguardando;
      summary.itens_ignorados += gravado.itensIgnorados;
      summary.itens_sem_rota_pedido += gravado.itensSemRota;
      summary.itens_retidos_sku_sem_rota += gravado.itensContaminados;
      for (const sku of gravado.skusGravados) skusVistos.add(sku);
      if (gravado.ultimoErro) console.error(`[sync-sku-items] recebimento ${nIdReceb}: ${gravado.motivo}`);

      if (Date.now() - startedAt > TIMEOUT_GUARD_MS) {
        summary.interrompido_por_timeout = true;
        break;
      }
    }

    summary.skus_distintos = skusVistos.size;
    summary.requisicoes_omie = contador.requisicoes;
    // Sensor pelo DADO (medido DEPOIS do laço, sobre a fila elegível ANTES do dedup — entram as não
    // alcançadas pelo guard e as irmãs, cada recebimento com a sua linha mais antiga): recebimento
    // consultável, elegível há mais de 48h, que o run não tratou. Via orquestrador: não avaliado.
    // Só recebimento SEM NENHUMA linha conta (`recebimentosComLinha` fica de fora): a retentativa de um
    // item que talvez nunca seja associado (etapa 40 há meses) disputaria os ~8 slots do diário das
    // 07:00 e fabricaria `error` "fila não anda" — o sensor de antes nunca o via.
    summary.fila_parada_48h = viaOrquestrador ? null : avaliarFilaParada(
      filaOrdenada,
      controleMap,
      recebimentosTratados,
      Date.now(),
      skuItemsBackoffMs,
      ELEGIVEL_HA_MUITO_MS,
      recebimentosComLinha,
    );
    // Os INCOMPLETOS parados: à vista no results, sem página.
    summary.fila_incompleta_parada_48h = viaOrquestrador ? null : avaliarFilaParada(
      filaOrdenada.filter((l) => l.nIdReceb !== null && recebimentosComLinha.has(l.nIdReceb)),
      controleMap,
      recebimentosTratados,
      Date.now(),
      skuItemsBackoffMs,
    );
    // Status do run — regras e precedência em adiamento.ts (decidirErroDoRun), testadas em Deno:
    //   · falha sistêmica = falha REAL com 0 resposta. NFe sem nIdReceb não é tentativa (OBEN
    //     2026-07-14); faultstring de NEGÓCIO em 2xx conta como resposta; ADIAMENTO por limite do
    //     run não é falha (OBEN 2026-08-27..09-23: 46 runs `error` falsos "1 consultas Omie
    //     tentadas, 0 OK", com a chamada REDUNDANT do step NFe segundos antes);
    //   · controle inoperante = nenhuma das marcações FEITAS persistiu (grant/RLS);
    //   · escrita morta = upserts de leadtime tentados e nenhum gravado;
    //   · fila não anda = NFe antiga, elegível e consultável sem tratamento neste run;
    //   · recompute derivado falhou (migration 20260716200000 / grant) — o leadtime deixa de
    //     MELHORAR, não piora; por isso vem por último. Chega aqui por `recompute_erro`.
    await completeSync(
      supabase,
      logId,
      summary as unknown as Record<string, unknown>,
      decidirErroDoRun(summary),
      Date.now() - startedAt,
    );

    return jsonRes({
      ok: true,
      duracao_ms: Date.now() - startedAt,
      summary: [summary],
    });
  } catch (e) {
    console.error("[sync-sku-items] erro fatal:", e);
    await completeSync(supabase, logId, {}, e instanceof Error ? e.message : String(e), Date.now() - startedAt);
    return jsonRes({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      duracao_ms: Date.now() - startedAt,
    }, 500);
  }
});
