// Edge function: omie-sync-estoque
// Sincroniza estoque físico de SKUs habilitados para reposição automática
// usando o endpoint Omie ListarPosicaoEstoque (1 chamada paginada vs N consultas).
//
// Invocação:
//  - Cron diário 06:00 BRT (09:00 UTC) — agendado via pg_cron
//  - Manual: POST { empresa: "OBEN" }

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  avaliarPagina,
  MAX_PAGINAS_POS_ESTOQUE,
  proximoTotalPaginas,
  varreduraTruncada as detectarVarreduraTruncada,
} from "../_shared/omie-paginacao.ts";
import { cabeEspera, timeoutRequestMs } from "../_shared/omie-deadline.ts";
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { criarColetorObservacao, type LinhaObservada, observacaoBateComPendente } from "./observacao-po.ts";
import { dispararFase } from "./fase-paralela.ts";

const corsHeaders = {
  ...sharedCors,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/estoque/consulta/";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;
// Coleira de RELÓGIO (#2017/#2031). Os guards desta edge são MAX_PAGINAS_* — CONTAGEM, que não
// limita tempo: um socket pendurado come o run inteiro sem estourar página nenhuma. Aqui, diferente
// dos steps do `omie-cron-diario`, a edge TEM cron próprio (jobids 31 e 124, teto 90s), então o kill
// já existe — o deadline não inventa truncamento, converte kill BRUTO em saída controlada.
// 80s (era 75s, que reservavam ~15s à cauda): o que roda depois da enumeração (upsert de 399 linhas em 2 chunks,
// observação, marcadores) não passa de poucos segundos — no run de 2026-10-05 19:40Z a observação foi chamada aos
// 53,0s e a resposta saiu aos 53,1s. Os 5s devolvidos vão para a varredura, que é onde o run morre (incidente das
// 17:40Z do mesmo dia: deadline aos 73,3s, net._http_response 104687). Teto do cron continua 90s.
const MAX_DURACAO_MS = 80_000;
// A publicação da observação (PR0 da baixa de PO) é ACESSÓRIA: roda depois do upsert e nunca pode comer o tempo
// da inativação e dos marcadores. Prazo = o que sobra até deadline + 5s — o MESMO corte absoluto de antes (75+10 =
// 80+5 = 85s, os 90s do cron menos ~5s de reserva) —, com teto de 8s; sem margem (timeoutRequestMs = 0), não publica.
const FOLGA_PUBLICACAO_MS = 5_000;
// Slug do registro do run em acoes_execucoes (_shared/registro-execucao.ts). Escritor ÚNICO: esta edge, que roda
// por cron E por clique. O botão da tela registra OUTRA ação (o composto 'reposicao.sincronizar_recalcular').
const ACAO_REGISTRO = "reposicao.sync_estoque";
const TETO_PUBLICACAO_MS = 8_000;
const FETCH_TIMEOUT_MS = 20_000;

type Empresa = "OBEN" | "COLACOR";

// Item do método ListarPosEstoque (response.produtos[])
interface OmiePosEstoqueItem {
  nCodProd?: number;
  cCodInt?: string;
  cCodigo?: string;
  cDescricao?: string;
  fisico?: number;
  reservado?: number;
  nPendente?: number; // pendente em pedidos de VENDA (saída), não entrada
  estoque_minimo?: number;
  codigo_local_estoque?: number;
  [k: string]: unknown;
}

interface OmiePosEstoqueResponse {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotRegistros?: number;
  produtos?: OmiePosEstoqueItem[];
  faultcode?: string;
  faultstring?: string;
}

// Item do método ListarSaldoPendente (response.saldo_pendente_lista[])
interface OmieSaldoPendenteItem {
  id_prod?: number;
  codigo_local_estoque?: number;
  qtde_saida?: number;
  qtde_entrada?: number; // <- pedidos de compra abertos
  [k: string]: unknown;
}

interface OmieSaldoPendenteResponse {
  pagina?: number;
  total_de_paginas?: number;
  registros?: number;
  total_de_registros?: number;
  saldo_pendente_lista?: OmieSaldoPendenteItem[];
  faultcode?: string;
  faultstring?: string;
}

async function callOmie<T>(
  appKey: string,
  appSecret: string,
  call: string,
  param: Record<string, unknown>,
  deadline: number,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // O teto do request ENCOLHE conforme o run se aproxima do deadline. LANÇA quando não sobra
    // tempo viável — este edge é fail-closed por desenho (varredura parcial jamais publica), então
    // exceção é o caminho certo: o caller aborta sem gravar, como já faz no teto de páginas.
    const timeoutMs = timeoutRequestMs(Date.now(), deadline, FETCH_TIMEOUT_MS);
    if (timeoutMs === 0) {
      throw new Error(`Omie ${call}: deadline do run atingido antes da chamada`);
    }
    try {
      const res = await fetch(OMIE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call,
          app_key: appKey,
          app_secret: appSecret,
          param: [param],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        // 60s de sono num run cujo teto de cron é 90s: antes isto era dormir até o cron matar, sem
        // gravar nada e sem dizer por quê. Agora recusa explicitamente — e quase nunca caberá, que
        // é o veredito honesto: não há como respeitar um rate-limit de 60s dentro deste orçamento.
        if (!cabeEspera(Date.now(), deadline, 60_000)) {
          throw new Error(`Omie ${call}: rate limit pede 60s de espera, não cabe antes do deadline do run`);
        }
        console.warn(`[omie-sync-estoque] 429 rate limit em ${call}, sleeping 60s`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        throw new Error(`AUTH_ERROR ${res.status}: ${body}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as T & { faultcode?: string; faultstring?: string };
      // faultstring SEM faultcode também é fault (achado Codex do challenge deste PR): passar
      // adiante virava "página 1/1 vazia" → inativação em massa no físico / zeros no pendente.
      // Os loops deste edge nunca pedem além do total declarado, então fault de fim-de-paginação
      // não chega aqui — fault é sempre erro. Transiente re-tenta pelo retry externo.
      if (json.faultcode || json.faultstring) {
        throw new Error(`Omie fault ${json.faultcode ?? "(sem faultcode)"}: ${json.faultstring}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("AUTH_ERROR")) throw err;
      // O catch engole TUDO e retenta, inclusive o TimeoutError do abort — sem esta guarda,
      // 3 tentativas de 20s mais os backoffs passariam do teto de 90s do cron.
      if (msg.includes("deadline do run")) throw err;
      const wait = 1000 * Math.pow(2, attempt - 1);
      if (!cabeEspera(Date.now(), deadline, wait)) {
        throw new Error(`Omie ${call}: falhou (${msg}) e o backoff de ${wait}ms não cabe antes do deadline do run`);
      }
      console.warn(
        `[omie-sync-estoque] ${call} attempt ${attempt}/${MAX_RETRIES} falhou: ${msg}. retry em ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("Falha desconhecida ao chamar Omie");
}

function getOmieCredentials(empresa: Empresa) {
  if (empresa === "OBEN") {
    return {
      appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
    };
  }
  return {
    appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "",
  };
}

// ===========================================================================================
// "A caminho" (estoque_pendente_entrada) via PEDIDOS DE COMPRA — OBEN
// ===========================================================================================
// Substitui o ListarSaldoPendente, que é CEGO à previsão FUTURA de PO aprovada (incidente
// 2026-06-11: PO 1054 aprovada, entrega 19/06, FUNDO PU 3un — o motor re-sugeria comprar).
// Lê os pedidos de compra ABERTOS (PesquisarPedCompra), soma (nQtde - nQtdeRec) por SKU sobre os
// APROVADOS (etapa "15" na OBEN), e DE-DUPA contra o que o em_transito da RPC já conta (pedido do
// app disparado/aprovado <7d) — senão a unidade contaria 2× (over-count → sub-compra).
const OMIE_ENDPOINT_PEDIDOS = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
// [fix entrega-futura 2026-06-26] dDataInicial/dDataFinal do PesquisarPedCompra filtram pela DATA DE
// PREVISÃO DE ENTREGA (dDtPrevisao), NÃO pela data de criação — PROVADO em prod: todo PO entra no espelho
// EXATAMENTE na data da previsão (lag-vs-criação 9–18d, lag-vs-previsão 0 em ~20 POs). Com dDataFinal=hoje,
// TODO pedido com entrega FUTURA (= todo pedido recém-feito dentro do lead time) sumia da resposta →
// estoque_pendente_entrada=0 → o motor RE-SUGERIA comprar o que já fora pedido (incidente PO 1085, entrega
// 08/07, invisível). A janela cobre previsões PASSADAS (atrasados não-recebidos) e FUTURAS (lead time).
// LT OBEN medido: mediana 10d, p95 18d, máx 39d, zero previsões nulas → +120d ≈ 3× o máx (folga).
const PEDIDOS_JANELA_PASSADO_DIAS = 365; // previsão atrasada: PO aberto não-recebido com entrega já vencida
const PEDIDOS_JANELA_FUTURO_DIAS = 120;  // previsão à frente: pedido em trânsito dentro do lead time
const ETAPAS_APROVADO_ABERTO = new Set<string>(["15"]); // OBEN: 15=Aprovado (confirmado 2026-06-11)
const ETAPAS_CONHECIDAS = new Set<string>(["15", "10"]); // 10=Em Aprovação; loga qualquer outra p/ pegar surpresa
// Filtros de situação do PesquisarPedCompra do "a caminho": inclui todos os estados potencialmente ABERTOS e
// exclui o que claramente fechou (o filtro fino de aprovado/saldo é em memória, robusto à incerteza do nome do
// flag). UMA constante para a chamada e para reposicao_po_observado_run.filtros — quem lê o conjunto observado
// precisa saber exatamente o que ele exclui (spec 2026-09-26 §15 item 2).
const FILTROS_PENDENTE = {
  lApenasImportadoApi: "F",
  lExibirPedidosPendentes: "T",
  lExibirPedidosFaturados: "T",
  lExibirPedidosRecParciais: "T",
  lExibirPedidosFatParciais: "T",
  lExibirPedidosRecebidos: "F",
  lExibirPedidosCancelados: "F",
  lExibirPedidosEncerrados: "F",
} as const;

interface OmiePedItem { nCodProd?: number | string; nQtde?: number; nQtdeRec?: number; [k: string]: unknown; }
interface OmiePedCab { nCodPed?: number | string; cNumero?: string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
interface OmiePedConsulta { cabecalho_consulta?: OmiePedCab; cabecalho?: OmiePedCab; produtos_consulta?: OmiePedItem[]; [k: string]: unknown; }
interface OmiePedResponse { pedidos_pesquisa?: OmiePedConsulta[]; nTotalPaginas?: number; faultstring?: string; faultcode?: string; [k: string]: unknown; }

// ── Helper puro (espelho VERBATIM de src/lib/reposicao/pendente-entrada-po.ts; 18 testes vitest) ──
interface PoItemOmie { sku: string; poNumero: string; etapa: string; qtde: number; recebido: number; }
// [Codex P1 2026-06-20] Parse ESTRITO de quantidade (espelho de pendente-entrada-po.ts). Number() mascara dado
// torto: ""/" "/null/false/[]→0, "0x10"→16, "1e3"→1000 — e um nQtdeRec mascarado como 0 conta saldo CHEIO = RUPTURA.
function parseQtd(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
// nQtdeRec AUSENTE (undefined) = nada recebido → 0 (Omie omite); null/""/inválido → NaN (fail-closed, não 0=saldo cheio).
function parseRecebido(v: unknown): number {
  return v === undefined ? 0 : parseQtd(v);
}
function quantidadesValidas(qtde: number, recebido: number): boolean {
  return Number.isFinite(qtde) && Number.isFinite(recebido) && qtde >= 0 && recebido >= 0;
}
function saldoAReceber(qtde: number, recebido: number): number {
  const q = Number.isFinite(qtde) ? qtde : 0;
  const r = Number.isFinite(recebido) ? recebido : 0;
  return Math.max(0, q - r);
}
function itemContaComoPendente(
  item: PoItemOmie,
  opts: { etapasAbertas: ReadonlySet<string>; poNumerosEmTransito: ReadonlySet<string> },
): boolean {
  if (!opts.etapasAbertas.has(item.etapa)) return false;
  if (opts.poNumerosEmTransito.has(item.poNumero)) return false;
  return saldoAReceber(item.qtde, item.recebido) > 0;
}
function computePendenteEntradaPorSku(
  items: readonly PoItemOmie[],
  opts: { etapasAbertas: ReadonlySet<string>; poNumerosEmTransito: ReadonlySet<string> },
): Map<string, number> {
  const porSku = new Map<string, number>();
  for (const item of items) {
    if (!itemContaComoPendente(item, opts)) continue;
    const add = saldoAReceber(item.qtde, item.recebido);
    porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + add);
  }
  return porSku;
}

async function callOmiePedidos(
  appKey: string, appSecret: string, pagina: number, dataDe: string, dataAte: string,
  deadline: number,
): Promise<OmiePedResponse> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const timeoutMs = timeoutRequestMs(Date.now(), deadline, FETCH_TIMEOUT_MS);
    if (timeoutMs === 0) {
      throw new Error(`PesquisarPedCompra: deadline do run atingido antes da chamada`);
    }
    const res = await fetch(OMIE_ENDPOINT_PEDIDOS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: "PesquisarPedCompra",
        app_key: appKey,
        app_secret: appSecret,
        param: [{
          nPagina: pagina,
          nRegsPorPagina: 100, // MÁXIMO do PesquisarPedCompra — o Omie rejeita >100 (HTTP 500 "valor máximo de registros por página é [100]"); 100 > 50 da edge antiga → ainda corta as páginas pela metade
          ...FILTROS_PENDENTE,
          dDataInicial: dataDe,
          dDataFinal: dataAte,
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    // 200 com corpo não-JSON re-LANÇA (abaixo): o `catch { json = {} }` antigo colapsava a
    // resposta malformada com `pedidos_pesquisa ?? []` → "fim" → pendente PARCIAL gravado
    // como confiável (a mesma troca de "não consegui ler" por "não existe" da classe #1581).
    let json: OmiePedResponse | null;
    try { json = JSON.parse(text) as OmiePedResponse; } catch { json = null; }
    if (res.status === 429 || (json?.faultstring && /rate limit/i.test(json.faultstring))) {
      console.warn(`[omie-sync-estoque] PesquisarPedCompra 429 (tentativa ${attempt}/${MAX_RETRIES}), aguardando 5s`);
      if (!cabeEspera(Date.now(), deadline, 5000)) {
        throw new Error(`PesquisarPedCompra: rate limit e os 5s de espera não cabem antes do deadline do run`);
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    // [fix 2026-06-23] O Omie sinaliza FIM DE PÁGINAS com HTTP 500 + faultstring "Não existem registros para a
    // página [N]" (faultcode 5113), NÃO com 200+lista-vazia. Sem isto, o throw em !res.ok matava a paginação-até-
    // vazia na 1ª página-além-do-fim → sync abortava (fail-closed, mas nunca completava). Devolve o json p/ o loop
    // tratar como fim via FIM_SEM_REGISTROS (conservadora — só o "fim" casa; erro real do Omie ainda lança abaixo).
    if (!res.ok && json?.faultstring && FIM_SEM_REGISTROS.test(json.faultstring)) return json;
    if (!res.ok) throw new Error(`PesquisarPedCompra HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (json === null) {
      throw new Error(`PesquisarPedCompra HTTP ${res.status} com corpo não-JSON (malformada ≠ fim): ${text.slice(0, 200)}`);
    }
    return json;
  }
  throw new Error("PesquisarPedCompra: rate limit excedido");
}

// Chaves do em_transito da RPC (anti double-count): pedido_compra_sugerido OBEN disparado/aprovado <7d.
// O mesmo predicado da CTE em_transito (1º ramo). De-dup por cNumero (=omie_pedido_compra_numero) E por
// cCodIntPed=AFI-<id> (carimbo do disparo, robusto caso o numero não tenha voltado do Omie).
async function fetchEmTransitoKeys(
  supabase: SupabaseClient,
): Promise<{ numeros: Set<string>; codInts: Set<string> }> {
  const numeros = new Set<string>();
  const codInts = new Set<string>();
  // A janela de 7 dias é a da RPC (atualizar_parametros_numericos_skus: dia de SP − 7, desde a
  // 20261001023000) — no Deno, `new Date()` + `getDate()` é o dia UTC, um a mais das 21h BRT em diante.
  const corte = somarDias(hojeSP(), -7);
  const { data, error } = await supabase
    .from("pedido_compra_sugerido")
    .select("id, omie_pedido_compra_numero")
    .eq("empresa", "OBEN")
    // [SIMULADO] 'disparado_simulado' é PO real (o dry_run chama IncluirPedCompra). Esta lista TEM de ser a
    // do 1º ramo da CTE: status que a RPC conta e o sync não exclui = contado 2× (suprime compra); o inverso
    // = contado 0× (compra dupla). Paridade vigiada em edges-onorder-guardrail.test.ts.
    .in("status", ["aprovado_aguardando_disparo", "disparado", "disparado_simulado", "concluido_recebido"])
    .gte("data_ciclo", corte);
  if (error) throw new Error(`em_transito query: ${error.message}`);
  for (const r of (data ?? []) as Array<{ id: string; omie_pedido_compra_numero: string | null }>) {
    if (r.omie_pedido_compra_numero) numeros.add(String(r.omie_pedido_compra_numero).trim());
    codInts.add(`AFI-${r.id}`);
  }
  return { numeros, codInts };
}

// ── Paginação ATÉ PÁGINA VAZIA (espelho das primitivas testadas do helper) ───────────────────────
// O nTotalPaginas do Omie SUB-REPORTA em listas grandes (bug conhecido, já mordeu CR/CP no financeiro):
// confiar nele lê só a 1ª página → POs aprovadas além dela somem → estoque_pendente_entrada subestimado
// → o motor re-sugere comprar = DOUBLE-BUY. Paginar até a página vazia + fingerprint anti-loop + de-dup
// de PO por nCodPed entre páginas + teto técnico fatal (espelho de pendente-entrada-po.ts, 9 rounds Codex).
const MAX_PAGINAS_PED = 200; // teto técnico FATAL anti-loop (a janela ~485d de POs ABERTOS cabe MUITO abaixo disso)
// fault do Omie que significa "fim legítimo" (sem registros), NÃO erro. Conservadora: exige "registro(s)"
// ADJACENTE a uma negação de EXISTÊNCIA (a fault canônica é "Não existem registros para a página informada").
// Espelho VERBATIM de pendente-entrada-po.ts:FIM_SEM_REGISTROS (endurecido por Codex P1.7/P1-D/P2-D).
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;
// fingerprint barato de página (anti-loop): mesma página não-vazia repetida = Omie em loop → abort FATAL.
function fingerprintPagina(pedidos: readonly OmiePedConsulta[]): string {
  if (!pedidos || pedidos.length === 0) return "";
  const prim = pedidos[0]?.cabecalho_consulta ?? pedidos[0]?.cabecalho ?? {};
  const ult = pedidos[pedidos.length - 1]?.cabecalho_consulta ?? pedidos[pedidos.length - 1]?.cabecalho ?? {};
  return `${pedidos.length}:${String(prim?.cNumero ?? "").trim()}:${String(ult?.cNumero ?? "").trim()}`;
}

async function computePendenteViaPedidosCompra(
  appKey: string, appSecret: string,
  habilitadoMap: Map<string, string | null>,
  supabase: SupabaseClient,
  deadline: number,
): Promise<{
  pendente: Map<string, number>; confiavel: boolean; problemas: string[];
  observados: LinhaObservada[]; janelaDe: string; janelaAte: string; varreduraCompleta: boolean;
  coletaIntegra: boolean; perdaColeta: string | null;
}> {
  const { numeros: emTransitoNumeros, codInts: emTransitoCodInts } = await fetchEmTransitoKeys(supabase);

  // A janela parte do dia de SP (o servidor é UTC: das 21h BRT em diante `new Date()` já é amanhã).
  const hoje = hojeSP();
  const inicioJanela = somarDias(hoje, -PEDIDOS_JANELA_PASSADO_DIAS);
  const fimJanela = somarDias(hoje, PEDIDOS_JANELA_FUTURO_DIAS);
  const dataDe = paraDataOmie(inicioJanela);
  const dataAte = paraDataOmie(fimJanela); // [fix] cobre previsões de entrega FUTURAS (era ddmmyyyyPed(hoje) → cortava tudo a caminho)

  const items: PoItemOmie[] = [];
  const etapasInesperadas = new Set<string>();
  // [fix double-buy 2026-06-20] PAGINA ATÉ A PÁGINA VAZIA — não confiar em nTotalPaginas (Omie SUB-REPORTA →
  // lia só a 1ª página → POs aprovadas além dela sumiam → pendente subestimado → motor re-sugeria = double-buy).
  const fpsVistos = new Set<string>();     // anti-loop: página inteira repetida (Omie em loop)
  const posComoApp = new Set<string>();    // POs vistas como app (no em_transito) — de-dup + detectar divergência app↔manual
  const posComoManual = new Set<string>(); // POs contadas como manual (pendente Omie) — de-dup + detectar divergência app↔manual
  const problemas: string[] = [];          // [Codex P1] fail-closed: dado torto → NÃO grava pendente (preserva anterior)
  let pedidosVistos = 0, pedidosApp = 0, paginasLidas = 0, fim = false;
  // Observação do conjunto que o motor contou (PR0 da baixa de PO): anotada nos MESMOS pontos de decisão abaixo,
  // sem mudar o que conta. 1 registro por PO (coletor) — a reaparição colidiria na PK. O handler publica.
  const coletor = criarColetorObservacao((sku) => habilitadoMap.has(sku), { parseQtd, parseRecebido });

  for (let pagina = 1; pagina <= MAX_PAGINAS_PED; pagina++) {
    const resp = await callOmiePedidos(appKey, appSecret, pagina, dataDe, dataAte, deadline);
    if (resp?.faultstring) {
      if (FIM_SEM_REGISTROS.test(resp.faultstring)) { fim = true; break; }
      throw new Error(`PesquisarPedCompra fault: ${resp.faultstring}`);
    }
    const pedidos = resp?.pedidos_pesquisa ?? [];
    if (pedidos.length === 0) { fim = true; break; }   // página vazia = FIM real (não nTotalPaginas)
    const fp = fingerprintPagina(pedidos);
    if (fp && fpsVistos.has(fp)) {
      throw new Error(`PesquisarPedCompra REPETIÇÃO de página (pág ${pagina}) — abort anti-overcount/double-buy`);
    }
    fpsVistos.add(fp);
    paginasLidas++;
    for (const ped of pedidos) {
      pedidosVistos++;
      const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
      const etapa = String(cab?.cEtapa ?? "").trim();
      const cNumero = String(cab?.cNumero ?? "").trim();
      const cCodIntPed = String(cab?.cCodIntPed ?? "").trim();
      const nCodPed = String(cab?.nCodPed ?? "").trim();
      const ehApp = (cNumero && emTransitoNumeros.has(cNumero)) || (cCodIntPed && emTransitoCodInts.has(cCodIntPed));
      if (etapa && !ETAPAS_CONHECIDAS.has(etapa)) etapasInesperadas.add(etapa);
      // [Codex round5] aliases de identidade da PO (prefixadas, não-vazias) p/ correlacionar a MESMA PO entre páginas
      // mesmo quando o Omie omite campos DIFERENTES em cada aparição (nCodPed numa, cNumero noutra). O cross-check
      // app↔manual bate em QUALQUER alias compartilhada. Resíduo só no caso de identidades 100% DISJUNTAS entre
      // páginas (sem nenhuma chave em comum) — inerente/irresolvível no client (sem correlação possível).
      const aliases: string[] = [];
      if (nCodPed) aliases.push(`id:${nCodPed}`);
      if (cNumero) aliases.push(`num:${cNumero}`);
      if (cCodIntPed) aliases.push(`cod:${cCodIntPed}`);
      const cabObs = { nCodPed: Number(nCodPed), cNumero: cNumero || null, cEtapa: etapa || null };
      const itensObs = ped?.produtos_consulta ?? [];
      // De-dup vs em_transito: PO do app já é contada pelo em_transito da RPC → NÃO entra no pendente Omie. Pula CEDO
      // (não exige nCodPed: uma PO app não pode congelar o snapshot — [Codex P2 round3]). Registra TODAS as aliases
      // como app; se a MESMA PO já foi contada como manual (qualquer alias) → app+manual = double-count → fail-closed.
      if (ehApp) {
        pedidosApp++;
        if (aliases.some((a) => posComoManual.has(a))) {
          problemas.push(`PO app↔manual divergente entre páginas (${aliases.join(",")}) — double-count`);
        }
        for (const a of aliases) posComoApp.add(a);
        coletor.registrar(cabObs, itensObs, "dedup_app");
        continue;
      }
      // Só etapa APROVADA-ABERTA (15) contribui pro pendente. Em-aprovação (10)/desconhecida não conta → ignora
      // sem exigir nCodPed nem de-dup (uma PO irrelevante não pode congelar o snapshot — [Codex P2 round3]).
      if (!ETAPAS_APROVADO_ABERTO.has(etapa)) {
        coletor.registrar(cabObs, itensObs, "etapa_nao_aberta");
        continue;
      }
      // [Codex P1.a] PO MANUAL etapa-aprovada que CONTA → exige nCodPed canônico (sempre presente → chave comum entre
      // páginas garantida p/ o de-dup manual-manual). Sem ele a MESMA PO somaria 2× → overcount → ruptura. Fail-closed.
      if (!nCodPed) {
        problemas.push(`PO etapa-aprovada sem nCodPed (cNumero=${cNumero || "—"}) — sem chave de de-dup`);
        continue;
      }
      // [Codex round4/5] mesma PO já vista como APP (em_transito) reaparece como manual (qualquer alias) → double-count.
      if (aliases.some((a) => posComoApp.has(a))) {
        problemas.push(`PO app↔manual divergente entre páginas (${aliases.join(",")}) — double-count`);
        continue;
      }
      // de-dup manual-manual: MESMA PO já contada (qualquer alias) reaparecendo (shift de paginação) → não soma 2×.
      if (aliases.some((a) => posComoManual.has(a))) {
        coletor.registrar(cabObs, itensObs, "repetido_na_varredura");
        continue;
      }
      for (const a of aliases) posComoManual.add(a);
      // [Codex P1-novo] fail-closed contra resposta truncada no NÍVEL DO ITEM (espelho do helper coletarDaPagina):
      // item sem nCodProd COM saldo>0/qtde inválida, ou PO aprovada SEM nenhum item com SKU = resposta anômala →
      // o saldo se perderia (subcontagem → double-buy). Marca problema (etapa aqui já CONTA: é etapa-15).
      let itensComSku = 0;
      for (const it of ped?.produtos_consulta ?? []) {
        const sku = String(it.nCodProd ?? "").trim();
        // [Codex P1.c] parsing ESTRITO: Number(nQtdeRec="" / null)=0 contaria saldo CHEIO numa PO parcialmente
        // recebida = supercontagem → ruptura. parseQtd/parseRecebido → NaN em dado torto → fail-closed (problema).
        const qtde = parseQtd(it.nQtde), recebido = parseRecebido(it.nQtdeRec);
        if (!sku) {
          if (!quantidadesValidas(qtde, recebido) || saldoAReceber(qtde, recebido) > 0) {
            problemas.push(`PO ${cNumero || nCodPed} (etapa ${etapa}) item SEM nCodProd com saldo/qtde suspeita`);
          }
          continue;
        }
        itensComSku++;
        if (!habilitadoMap.has(sku)) continue;
        if (!quantidadesValidas(qtde, recebido)) {
          problemas.push(`item inválido (sku=${sku} po=${cNumero} nQtde=${it.nQtde} nQtdeRec=${it.nQtdeRec})`);
          continue;
        }
        items.push({ sku, poNumero: cNumero, etapa, qtde, recebido });
      }
      if (itensComSku === 0) {
        problemas.push(`PO aprovada sem item com SKU (po=${cNumero || nCodPed} etapa=${etapa})`);
      }
      // A decisão FINAL do motor: o acumulador (computePendenteEntradaPorSku) ainda descarta por número o PO cujo
      // cNumero está no em_transito — só alcançável com cNumero "" e um número vazio no app, mas aí a soma por SKU
      // fecharia por compensação com outro PO se a observação o anotasse como contado.
      coletor.registrar(cabObs, itensObs, emTransitoNumeros.has(cNumero) ? "dedup_app" : null);
    }
    await new Promise((r) => setTimeout(r, 1100));   // rate-limit Omie entre páginas
  }
  if (!fim) {
    throw new Error(`PesquisarPedCompra excedeu ${MAX_PAGINAS_PED} páginas sem ver fim — abort anti-truncamento`);
  }
  // [Codex P1] CONFIABILIDADE do snapshot (fail-closed que PRESERVA): dado torto (problemas) ou varredura totalmente
  // vazia (0 pedidos — a OBEN sempre tem PO aberta) ⇒ pendente NÃO confiável → o caller NÃO grava a coluna (preserva
  // o último valor bom); o FÍSICO segue atualizando (não derruba o sync de estoque por 1 PO suja de fornecedor).
  const confiavel = problemas.length === 0 && pedidosVistos > 0;
  const pendente = confiavel
    ? computePendenteEntradaPorSku(items, { etapasAbertas: ETAPAS_APROVADO_ABERTO, poNumerosEmTransito: emTransitoNumeros })
    : new Map<string, number>();
  console.log(
    `[omie-sync-estoque] PesquisarPedCompra: ${paginasLidas} págs até vazia, ${pedidosVistos} pedidos abertos (${pedidosApp} do app de-dup), ` +
    `${items.length} itens habilitados, ${pendente.size} SKUs com a caminho, confiavel=${confiavel}.` +
    (problemas.length ? ` ⚠️ ${problemas.length} problema(s) → pendente PRESERVADO: ${problemas.slice(0, 3).join(" | ")}` : "") +
    (etapasInesperadas.size ? ` ⚠️ etapas fora de {15,10}: ${[...etapasInesperadas].join(",")}` : ""),
  );
  return {
    pendente, confiavel, problemas,
    observados: coletor.linhas, janelaDe: inicioJanela, janelaAte: fimJanela,
    varreduraCompleta: fim && problemas.length === 0,
    coletaIntegra: coletor.integra, perdaColeta: coletor.perda,
  };
}

// ===== Marcadores do Sentinela (sync_state) — writer que faltava ao check estoque_reposicao =====
// A v2 do check ("[FONTE-ÚNICA passo 5 / P1-A]", 20260611210000) lia DOIS marcadores 1-writer (account
// minúscula) que NENHUM writer gravava (o fluxo single-source #809 foi revertido no #817) → broken
// permanente + Sentinela SURDO 17d (o incidente 30/06–02/07 passou mudo). A v3 (#1144, 20260702212000)
// voltou o check ao dado real (max(ultima_sincronizacao)) e deixou a regra: "re-promover o marcador só
// COM a edge gravando" — ESTA função é essa edge. Ordem certa de deploy: WRITER primeiro (aqui), check
// v4 depois (partir do corpo v2 preservado na 20260626150000). Semântica dos marcadores:
//   - fim de run OK → 'complete' + last_sync_at (o check v2/v4 mede a idade por last_sync_at);
//   - pendente NÃO-confiável (OBEN) → OMITE o upsert do reposicao_pendente_po: o marcador envelhece e
//     a futura v4 enxerga o "a-caminho congelado" que o frescor do físico mascara (o ponto cego que
//     motivou o P1-A — a v3 ainda não o cobre);
//   - falha total do run → 'error' no full SEM avançar last_sync_at (contrato v2/v4: 'error' = broken
//     imediato; o horário do último sucesso fica preservado para o operador).
// Best-effort: o marcador nunca derruba o sync real (padrão da irmã omie-sync-pedidos-compra).
// 'syncing' do desenho P1-A não é usado: aqui os dois upserts saem juntos no fim do run (não existe a
// janela físico→a-caminho do fluxo #809 que o estado intermediário cobria).
const MARKER_FULL = "reposicao_estoque_full";
const MARKER_PENDENTE_PO = "reposicao_pendente_po";

async function gravarMarcadorSentinela(
  supabase: SupabaseClient,
  entityType: string,
  empresa: Empresa,
  status: "complete" | "error",
  meta: Record<string, unknown>,
  errorMessage: string | null = null,
): Promise<void> {
  const nowISO = new Date().toISOString();
  const row: Record<string, unknown> = {
    entity_type: entityType,
    account: empresa.toLowerCase(),
    status,
    updated_at: nowISO,
    error_message: errorMessage,
    metadata: { ...meta, gravado_em: nowISO },
  };
  if (status === "complete") row.last_sync_at = nowISO; // 'error' preserva o último sucesso
  try {
    const { error } = await supabase
      .from("sync_state")
      .upsert(row, { onConflict: "entity_type,account" });
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[omie-sync-estoque] marcador ${entityType} (${status}) falhou: ${msg}`);
  }
}

// Teto anti-runaway do ListarSaldoPendente: 200 × 500/pág = 100k linhas de saldo >> realidade COLACOR.
const MAX_PAGINAS_SALDO_PENDENTE = 200;

async function computePendenteViaSaldoPendente(
  appKey: string, appSecret: string, habilitadoMap: Map<string, string | null>,
  deadline: number,
): Promise<Map<string, number>> {
  const pendente = new Map<string, number>();
  let pPag = 1, pTot = 1;
  while (pPag <= pTot) {
    const resp = await callOmie<OmieSaldoPendenteResponse>(
      appKey, appSecret, "ListarSaldoPendente",
      { pagina: pPag, registros_por_pagina: PAGE_SIZE, tipo: "ENTRADA" },
      deadline,
    );
    // Piso monotônico + teto fail-fast (_shared/omie-paginacao.ts): o `?? 1` por resposta
    // encolhia o teto e um pendente PARCIAL era gravado com pendenteConfiavel=true.
    pTot = proximoTotalPaginas(pTot, resp.total_de_paginas, MAX_PAGINAS_SALDO_PENDENTE);
    const lista = resp.saldo_pendente_lista ?? [];
    const veredicto = avaliarPagina(lista.length, pPag, pTot);
    if (veredicto === "anomalia") {
      // Página vazia ANTES do fim declarado = fault disfarçado; o caller COLACOR converte o
      // throw em pendente NÃO-confiável → coluna PRESERVADA (nunca o parcial, nunca zeros).
      throw new Error(`página ${pPag}/${pTot} do ListarSaldoPendente veio vazia antes do fim declarado — abortando (retrato parcial)`);
    }
    if (veredicto === "fim") break;
    for (const item of lista) {
      const codigo = String(item.id_prod ?? "").trim();
      if (!codigo || !habilitadoMap.has(codigo)) continue;
      pendente.set(codigo, (pendente.get(codigo) ?? 0) + Number(item.qtde_entrada ?? 0));
    }
    pPag++;
  }
  console.log(`[omie-sync-estoque] ListarSaldoPendente: ${pendente.size} SKUs com entrada pendente.`);
  return pendente;
}

// O que vai para acoes_execucoes.detalhes num run bem-sucedido: o relógio por fase e o desfecho — a série que deixa
// responder, com denominador, quantos runs chegaram perto do deadline e em que fase. Na falha o comRegistro grava o
// texto do erro, que já nomeia a fase (e, no físico, a página e o relógio do run).
const CHAVES_REGISTRO = [
  "empresa", "duracao_ms", "fase_fisico_ms", "fase_po_ms", "espera_po_ms", "paginas_omie", "registros_lidos",
  "total_skus_esperados", "sincronizados", "nao_encontrados", "erros_upsert", "pendente_confiavel",
  "pendente_problemas", "varredura_truncada", "observacao_publicada",
] as const;

function detalhesDoRegistro(resumo: Record<string, unknown>): Record<string, unknown> {
  const detalhes: Record<string, unknown> = { versao: VERSAO };
  for (const chave of CHAVES_REGISTRO) {
    if (chave in resumo) detalhes[chave] = resumo[chave];
  }
  return detalhes;
}

// `versao` em TODA resposta (sucesso e erro), não só na da sonda: a pergunta "essa correção
// subiu?" quase sempre é feita sobre um run que JÁ aconteceu — e o caso que mais importa é o do
// run que falhou no meio e deixou saldo pela metade.
function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, versao: VERSAO }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que já aceita x-cron-secret) e ANTES do createClient,
  // de toda query e de toda chamada ao Omie: é o único caminho desta edge sem custo nenhum.
  // Daqui pra frente ela reescreve `sku_estoque_atual`/`sku_status_omie` e AVANÇA o marcador de
  // frescor — um run indevido não só suja o saldo, apaga o sinal de que sujou.
  // O corpo é consumido AQUI (req.json() é one-shot) e reaproveitado no fluxo real abaixo.
  // Ver versao.ts / _shared/sonda-versao.ts.
  const corpoBruto: unknown = req.method === "POST"
    ? await req.json().catch(() => ({}))
    : {};
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonRes({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const startedAt = new Date();
  const t0 = performance.now();
  // Relógio ÚNICO do run. Em `Date.now()` de propósito: `t0` acima é `performance.now()`, que tem
  // OUTRA origem — misturar as duas bases daria um deadline no passado ou no ano que vem.
  const deadline = Date.now() + MAX_DURACAO_MS;

  // Refs para o catch conseguir gravar o marcador 'error'. O client nasce ANTES do guard das credenciais (que
  // agora mora dentro do registro do run): só a empresa inválida (400 — não chega a ser run) fica sem marcador.
  let supabaseRef: SupabaseClient | null = null;
  let empresaRef: Empresa | null = null;

  try {
    // Corpo já consumido no bloco da sonda acima (req.json() é one-shot). Não-objeto vira {} —
    // cai no default "OBEN", como antes.
    const body: Record<string, unknown> =
      typeof corpoBruto === "object" && corpoBruto !== null && !Array.isArray(corpoBruto)
        ? corpoBruto as Record<string, unknown>
        : {};
    const empresa: Empresa = (body?.empresa ?? "OBEN") as Empresa;
    if (empresa !== "OBEN" && empresa !== "COLACOR") {
      return jsonRes({ error: "empresa inválida. Use OBEN ou COLACOR." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    supabaseRef = supabase;
    empresaRef = empresa;

    // Registro do run em acoes_execucoes — 1 linha por run, cron OU clique: início → sucesso/erro, com o texto do
    // erro (que já nomeia a fase). Aberto ANTES de qualquer chamada Omie e do guard das credenciais: guard fora do
    // callback não deixa linha de falha (lição do analytics-outbox-drain, apagão de 2026-08-26). Fail-open — o
    // registro nunca derruba o sync. Sem ele, "quantas falhas foram deadline, e em que fase" era irrecuperável
    // (medição de 2026-10-05: net._http_response retém ~6h; os logs da edge, ~10 min).
    const dbRegistro = supabase as unknown as DbRegistro;
    const origemRegistro = { via: auth.via, userId: auth.userId };
    const resumo = await comRegistro(dbRegistro, ACAO_REGISTRO, origemRegistro, async (): Promise<Record<string, unknown>> => {
      const { appKey, appSecret } = getOmieCredentials(empresa);
      if (!appKey || !appSecret) {
        throw new Error(`Credenciais Omie ausentes para ${empresa}`);
      }

      // 1) SKUs habilitados
      const { data: habilitadosRows, error: habErr } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie, sku_descricao")
        .eq("empresa", empresa)
        .eq("habilitado_reposicao_automatica", true);

      if (habErr) throw new Error(`Erro lendo sku_parametros: ${habErr.message}`);

      const habilitados = (habilitadosRows ?? []) as Array<{
        sku_codigo_omie: number | string;
        sku_descricao: string | null;
      }>;
      const habilitadoMap = new Map<string, string | null>();
      for (const r of habilitados) {
        habilitadoMap.set(String(r.sku_codigo_omie), r.sku_descricao ?? null);
      }
      const totalEsperado = habilitadoMap.size;
      console.log(
        `[omie-sync-estoque] ${empresa}: ${totalEsperado} SKUs habilitados para reposição.`,
      );

      if (totalEsperado === 0) {
        // Run vazio legítimo = complete (só o full; deixar o pendente_po envelhecer aqui é sinal útil —
        // reposição desabilitada em massa merece atenção humana, não um complete fabricado).
        await gravarMarcadorSentinela(supabase, MARKER_FULL, empresa, "complete", {
          trigger: "run",
          sincronizados: 0,
          nota: "nenhum SKU habilitado",
        });
        return {
          ok: true,
          empresa,
          total_skus_esperados: 0,
          mensagem: "Nenhum SKU habilitado, nada a sincronizar.",
        };
      }

      // 2) "A caminho" OBEN (PesquisarPedCompra) DISPARADO JÁ, em paralelo com o físico abaixo. [incidente
      //    2026-10-05 17:40Z, net._http_response 104687] Em série ele rodava DEPOIS das 75 páginas do ListarPosEstoque:
      //    com o Omie ~1,6× mais lento, esbarrou no deadline e o throw (fatal, ver 3.b) descartou o físico JÁ lido. Em
      //    paralelo ele termina nos primeiros segundos e sai da cauda do run, e o par (físico, pendente) continua sendo
      //    do MESMO run. A semântica não muda: erro de varredura do PO segue FATAL — só que agora ele aborta o físico
      //    CEDO (falhaJaConhecida) em vez de esperar 75 páginas para cair. A promise nunca rejeita sem handler
      //    (fase-paralela.ts): o laço do físico pode lançar antes de aguardá-la, e no Deno isso derrubaria o isolate.
      const fasePo = empresa === "OBEN"
        ? dispararFase(() => computePendenteViaPedidosCompra(appKey, appSecret, habilitadoMap, supabase, deadline))
        : null;

      // 3) Paginar Omie — ListarPosEstoque (físico + reservado)
      // IMPORTANTE: o método retorna UMA LINHA POR LOCAL DE ESTOQUE.
      // Se o mesmo nCodProd está em N locais (matriz, filial, depósito),
      // precisamos SOMAR físico/reservado/pendente de todos os locais —
      // sobrescrever (Map.set) gerava estoque menor que o do ME.
      const dataPosicao = paraDataOmie(hojeSP()); // a posição de HOJE em SP (no servidor UTC, getDate() é amanhã às 21h+)
      const encontrados = new Map<string, { fisico: number; reservado: number; pendente: number; locais: number }>();

      let page = 1;
      let totalPaginas = 1;
      let totalRegistros = 0;
      let registrosLidos = 0;
      const tFisicoIni = performance.now();

      while (page <= totalPaginas) {
        const falhaPo = fasePo?.falhaJaConhecida();
        if (falhaPo) throw falhaPo.erro; // fatal como sempre foi (3.b) — só não queima as páginas que faltam
        let resp: OmiePosEstoqueResponse;
        try {
          resp = await callOmie<OmiePosEstoqueResponse>(
            appKey, appSecret, "ListarPosEstoque",
            { nPagina: page, nRegPorPagina: PAGE_SIZE, dDataPosicao: dataPosicao, cExibeTodos: "S" },
            deadline,
          );
        } catch (err) {
          // SUFIXO com a página e o relógio do run (nunca prefixo: o catch final testa startsWith("AUTH_ERROR")).
          // É o que o registro em acoes_execucoes guarda para medir QUÃO lento estava o Omie quando o run caiu.
          throw new Error(
            `${mensagemDeErro(err) ?? "falha sem mensagem"} (pág ${page}/${totalPaginas}, ${Math.round(performance.now() - t0)}ms do run)`,
          );
        }
        // Piso monotônico + teto fail-fast (_shared/omie-paginacao.ts): o `?? 1` por resposta
        // encolhia o teto e a varredura PARCIAL completava — SKU habilitado da cauda perdida
        // virava ativo_no_omie=false + evento sku_inativado FALSO (money-path da reposição).
        totalPaginas = proximoTotalPaginas(totalPaginas, resp.nTotPaginas, MAX_PAGINAS_POS_ESTOQUE);
        totalRegistros = resp.nTotRegistros ?? totalRegistros;
        const lista = resp.produtos ?? [];
        const veredicto = avaliarPagina(lista.length, page, totalPaginas);
        if (veredicto === "anomalia") {
          throw new Error(`página ${page}/${totalPaginas} do ListarPosEstoque veio vazia antes do fim declarado — abortando (retrato parcial)`);
        }
        if (veredicto === "fim") break;
        registrosLidos += lista.length;
        for (const item of lista) {
          const codigo = String(item.nCodProd ?? "").trim();
          if (!codigo) continue;
          if (!habilitadoMap.has(codigo)) continue;
          const acc = encontrados.get(codigo) ?? { fisico: 0, reservado: 0, pendente: 0, locais: 0 };
          acc.fisico += Number(item.fisico ?? 0);
          acc.reservado += Number(item.reservado ?? 0);
          acc.pendente += Number(item.nPendente ?? 0);
          acc.locais += 1;
          encontrados.set(codigo, acc);
        }
        console.log(
          `[omie-sync-estoque] ListarPosEstoque pág ${page}/${totalPaginas} — ${lista.length} itens, ${encontrados.size}/${totalEsperado} casados.`,
        );
        page++;
      }
      const faseFisicoMs = Math.round(performance.now() - tFisicoIni);

      console.log(
        `[omie-sync-estoque] varredura concluída: ${totalRegistros} no Omie, ${encontrados.size}/${totalEsperado} habilitados encontrados.`,
      );

      // 3.b) "A caminho" (estoque_pendente_entrada) — pedidos de compra ABERTOS do Omie.
      // OBEN: via PesquisarPedCompra (pega previsão FUTURA de PO aprovada que o ListarSaldoPendente perdia —
      //   incidente 2026-06-11, FUNDO PU/1054), disparado no passo 2 e AGUARDADO aqui. Erro de VARREDURA
      //   (rede/fault/loop/truncamento) é FATAL (resultado() relança → sync falha → Sentinela pega o congelado). Já dado
      //   torto/varredura vazia NÃO derruba o sync: o pendente vira NÃO confiável e a coluna é PRESERVADA no upsert (o
      //   físico segue fresco). [Codex P1 2026-06-20]
      // COLACOR: mantém ListarSaldoPendente, não-fatal (reposição é OBEN; etapa-map do COLACOR não confirmada).
      let pendenteEntrada = new Map<string, number>();
      let pendenteConfiavel = true; // COLACOR (ListarSaldoPendente) sempre aplica; OBEN é gated pela confiabilidade
      let pendenteProblemas: string[] = [];
      // Só o ramo OBEN observa o conjunto aberto (o COLACOR lê o ListarSaldoPendente, que não tem PO).
      let observacaoPo: {
        observados: LinhaObservada[]; janelaDe: string; janelaAte: string; varreduraCompleta: boolean;
        coletaIntegra: boolean; perdaColeta: string | null;
      } | null = null;
      // ms que o físico, já pronto, ainda esperou pelo PO (~0 no normal; se crescer, o gargalo virou o PO).
      let esperaPoMs: number | null = null;
      if (fasePo) {
        const tEsperaIni = performance.now();
        const r = await fasePo.resultado();
        esperaPoMs = Math.round(performance.now() - tEsperaIni);
        pendenteEntrada = r.pendente;
        pendenteConfiavel = r.confiavel;
        pendenteProblemas = r.problemas;
        observacaoPo = r;
      } else {
        try {
          pendenteEntrada = await computePendenteViaSaldoPendente(appKey, appSecret, habilitadoMap, deadline);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Não-fatal ≠ zerar: sem confiável=false, o Map vazio do catch virava
          // estoque_pendente_entrada=0 em TODO SKU COLACOR (fabricação). false OMITE a coluna
          // no upsert → o último valor bom é PRESERVADO (mesmo mecanismo do ramo OBEN).
          pendenteConfiavel = false;
          pendenteProblemas = [msg];
          console.warn(`[omie-sync-estoque] COLACOR ListarSaldoPendente falhou (não-fatal, pendente PRESERVADO): ${msg}`);
        }
      }
      // [Codex P1 round3] pendente OBEN não confiável → PRESERVADO (físico segue fresco, evita double-buy/ruptura por
      // número errado/zerado). console.error + flag no summary = sinal nos logs; o alerta PROATIVO (Sentinela enxergar
      // o pendente congelado, que o frescor do físico mascara) depende do marcador sync_state — follow-up (#809 passo 5).
      if (empresa === "OBEN" && !pendenteConfiavel) {
        console.error(
          `[omie-sync-estoque] ⚠️ pendente OBEN NÃO confiável → PRESERVADO. ${pendenteProblemas.length} problema(s): ${pendenteProblemas.slice(0, 5).join(" | ")}`,
        );
      }

      // 4) UPSERT em sku_estoque_atual (valores já agregados por SKU)
      // [Codex P1] estoque_pendente_entrada só é gravado quando o snapshot é CONFIÁVEL; senão a coluna é OMITIDA
      // (no UPDATE o PostgREST não toca colunas ausentes → preserva o último valor bom) e o físico segue fresco.
      const upsertRows = Array.from(encontrados.entries()).map(([codigo, agg]) => {
        const row: Record<string, unknown> = {
          empresa,
          sku_codigo_omie: codigo,
          estoque_fisico: agg.fisico,
          estoque_disponivel: agg.fisico - agg.reservado,
          ultima_sincronizacao: new Date().toISOString(),
          fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
        };
        if (pendenteConfiavel) row.estoque_pendente_entrada = pendenteEntrada.get(codigo) ?? 0;
        return row;
      });

      let sincronizados = 0;
      const errosUpsert: Array<{ sku: string; erro: string }> = [];
      // Upsert em chunks para evitar payload gigante
      const CHUNK = 200;
      for (let i = 0; i < upsertRows.length; i += CHUNK) {
        const slice = upsertRows.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("sku_estoque_atual")
          .upsert(slice, { onConflict: "empresa,sku_codigo_omie" });
        if (error) {
          // Fallback: tentar individualmente para isolar SKU problemático
          console.error(
            `[omie-sync-estoque] erro upsert chunk ${i}-${i + slice.length}: ${error.message}. Tentando individual.`,
          );
          for (const row of slice) {
            const { error: e2 } = await supabase
              .from("sku_estoque_atual")
              .upsert(row, { onConflict: "empresa,sku_codigo_omie" });
            if (e2) {
              errosUpsert.push({ sku: String(row.sku_codigo_omie), erro: e2.message });
            } else {
              sincronizados++;
            }
          }
        } else {
          sincronizados += slice.length;
        }
      }

      // Falha TOTAL ≠ sucesso parcial (espelho do guard dos irmãos em sync-reprocess): se NENHUM
      // upsert escreveu, a infra PostgREST está degradada — 'error' honesto via catch (o marcador
      // 'complete' lá embaixo mentiria frescor pro Sentinela com nada escrito).
      if (upsertRows.length > 0 && sincronizados === 0) {
        throw new Error(`todos os ${upsertRows.length} upserts de sku_estoque_atual falharam — nada escrito`);
      }

      // 4.b) Observação do conjunto aberto (PR0 da baixa de PO) — DEPOIS do upsert do pendente e NUNCA fatal: sem a
      // RPC, ou com a observação divergindo do pendente calculado, a evidência fica indisponível neste run e o sync
      // segue igual. Só publica o que bate com o que o motor contou (senão mediria outra coisa); ausência de um PO
      // aqui nunca vira "fechado" — quem lê decide, e só dentro da janela de um run com varredura_completa.
      let observacaoPublicada = false;
      let observacaoMotivo: string | null = null;
      if (observacaoPo) {
        try {
          const prazoMs = timeoutRequestMs(Date.now(), deadline + FOLGA_PUBLICACAO_MS, TETO_PUBLICACAO_MS);
          if (!pendenteConfiavel) {
            observacaoMotivo = "pendente_nao_confiavel";
          } else if (!observacaoPo.coletaIntegra) {
            observacaoMotivo = `coleta_incompleta: ${observacaoPo.perdaColeta ?? "sem motivo"}`;
          } else if (!observacaoBateComPendente(observacaoPo.observados, pendenteEntrada)) {
            observacaoMotivo = "observacao_diverge_do_pendente";
          } else if (prazoMs === 0) {
            observacaoMotivo = "sem_tempo_no_run";
          } else {
            const { error } = await supabase.rpc("reposicao_po_observado_publicar", {
              p_run: {
                run_id: crypto.randomUUID(),
                empresa,
                iniciado_em: startedAt.toISOString(),
                concluido_em: new Date().toISOString(),
                janela_de: observacaoPo.janelaDe,
                janela_ate: observacaoPo.janelaAte,
                filtros: FILTROS_PENDENTE,
                varredura_completa: observacaoPo.varreduraCompleta,
                // a AFIRMAÇÃO da edge (pendente confiável, upsert sem erro); a RPC confere no banco, SKU a SKU
                pendente_aplicado: pendenteConfiavel && errosUpsert.length === 0,
                pedidos_lidos: new Set(observacaoPo.observados.map((o) => o.omie_codigo_pedido)).size,
                versao_edge: VERSAO,
              },
              p_itens: observacaoPo.observados,
            }).abortSignal(AbortSignal.timeout(prazoMs));
            if (error) observacaoMotivo = `rpc: ${mensagemDeErro(error) ?? "sem mensagem"}`;
            else observacaoPublicada = true;
          }
        } catch (err) {
          observacaoMotivo = mensagemDeErro(err) ?? "falha sem mensagem";
        }
        // pendente não confiável já tem o próprio console.error acima; o resto é sinal desta fatia
        if (!observacaoPublicada && observacaoMotivo !== "pendente_nao_confiavel") {
          console.error(`[omie-sync-estoque] observação do conjunto aberto não publicada: ${observacaoMotivo}`);
        }
      }

      // 5) SKUs habilitados que não apareceram → marca inativo + alerta
      //
      // ⚠️ SÓ com a varredura PROVADAMENTE completa. `nTotPaginas` é PISO, não teto (o Omie
      // SUB-REPORTA em listas grandes — docs/agent/sync.md), e o laço acima para no total
      // declarado: se ele veio curto, a cauda nunca é pedida e "não apareceu" significa
      // "não li", não "sumiu do Omie". Inativar aí é a fabricação mais cara deste edge —
      // ativo_no_omie=false + evento sku_inativado FALSO tiram o SKU da reposição (achado P0
      // do challenge Codex deste PR). O segundo sinal que DISTINGUE os dois casos é o
      // nTotRegistros que a própria resposta traz (money-path §8: truncar só é legítimo
      // quando o caller consegue distinguir): lidos < declarados ⇒ retrato truncado ⇒ NÃO
      // inativa. O físico já gravado segue fresco; o próximo ciclo re-tenta.
      const varreduraTruncada = detectarVarreduraTruncada(registrosLidos, totalRegistros);
      const naoEncontrados: string[] = [];
      if (!varreduraTruncada) {
        for (const codigo of habilitadoMap.keys()) {
          if (!encontrados.has(codigo)) naoEncontrados.push(codigo);
        }
      } else {
        console.error(
          `[omie-sync-estoque] ⚠️ varredura TRUNCADA (${registrosLidos}/${totalRegistros} registros em ${totalPaginas} pág. declaradas) — ` +
          `inativação de SKU SUSPENSA nesta rodada (não confundir "não li" com "sumiu do Omie").`,
        );
      }

      let alertasNovos = 0;
      if (naoEncontrados.length > 0) {
        console.warn(
          `[omie-sync-estoque] ${naoEncontrados.length} SKUs habilitados não vieram do Omie:`,
          naoEncontrados,
        );

        const statusRows = naoEncontrados.map((codigo) => ({
          empresa,
          sku_codigo_omie: codigo,
          sku_descricao: habilitadoMap.get(codigo) ?? null,
          ativo_no_omie: false,
          ultima_sincronizacao: new Date().toISOString(),
          fonte_sincronizacao: "nao_apareceu_em_ListarPosicaoEstoque",
        }));

        // Para preservar data_inativacao existente usamos fetch + upsert seletivo
        const { data: existentes } = await supabase
          .from("sku_status_omie")
          .select("sku_codigo_omie, data_inativacao")
          .eq("empresa", empresa)
          .in("sku_codigo_omie", naoEncontrados);

        const existentesMap = new Map(
          (existentes ?? []).map((r) => [r.sku_codigo_omie, r.data_inativacao]),
        );

        const nowIso = new Date().toISOString();
        const enrichedStatus = statusRows.map((r) => ({
          ...r,
          data_inativacao: existentesMap.get(r.sku_codigo_omie) ?? nowIso,
        }));

        const { error: statusErr } = await supabase
          .from("sku_status_omie")
          .upsert(enrichedStatus, { onConflict: "empresa,sku_codigo_omie" });
        if (statusErr) {
          console.error(
            `[omie-sync-estoque] erro upsert sku_status_omie: ${statusErr.message}`,
          );
        }

        // Eventos pendentes existentes para evitar duplicar
        const { data: eventosExistentes } = await supabase
          .from("eventos_outlier")
          .select("sku_codigo_omie")
          .eq("empresa", empresa)
          .eq("tipo", "sku_inativado_omie")
          .eq("status", "pendente")
          .in("sku_codigo_omie", naoEncontrados);

        const jaTemEvento = new Set(
          (eventosExistentes ?? []).map((e) => e.sku_codigo_omie),
        );

        const novosEventos = naoEncontrados
          .filter((c) => !jaTemEvento.has(c))
          .map((codigo) => ({
            empresa,
            sku_codigo_omie: codigo,
            sku_descricao: habilitadoMap.get(codigo) ?? null,
            tipo: "sku_inativado_omie",
            severidade: "atencao",
            data_evento: hojeSP(),
            detalhes: {
              mensagem:
                "SKU foi inativado no Omie. Decidir: (1) merge histórico com outro SKU, (2) descadastrar do módulo de reposição, (3) reativar manualmente no Omie.",
              detectado_em: new Date().toISOString(),
              fonte: "omie-sync-estoque",
            },
          }));

        if (novosEventos.length > 0) {
          const { error: evErr } = await supabase
            .from("eventos_outlier")
            .insert(novosEventos);
          if (evErr) {
            console.error(
              `[omie-sync-estoque] erro inserindo eventos_outlier: ${evErr.message}`,
            );
          } else {
            alertasNovos = novosEventos.length;
          }
        }
      }

      const finishedAt = new Date();
      const duracaoMs = Math.round(performance.now() - t0);

      const summary = {
        ok: true,
        empresa,
        sync_iniciado_em: startedAt.toISOString(),
        sync_concluido_em: finishedAt.toISOString(),
        duracao_ms: duracaoMs,
        // Relógio por fase (o PO roda EM PARALELO com o físico): é o que diz quão perto do deadline o run chegou e
        // quem foi o gargalo — o que a medição de 2026-10-05 não conseguiu reconstruir para 20 das 21 falhas.
        fase_fisico_ms: faseFisicoMs,
        fase_po_ms: fasePo?.duracaoMs() ?? null,
        espera_po_ms: esperaPoMs,
        total_skus_esperados: totalEsperado,
        sincronizados,
        nao_encontrados: naoEncontrados.length,
        erros_upsert: errosUpsert.length,
        alertas_novos: alertasNovos,
        pendente_confiavel: pendenteConfiavel,
        pendente_problemas: pendenteProblemas.length,
        observacao_publicada: observacaoPublicada,
        observacao_motivo: observacaoMotivo,
        paginas_omie: totalPaginas,
        total_produtos_omie: totalRegistros,
        registros_lidos: registrosLidos,
        varredura_truncada: varreduraTruncada,
        lista_nao_encontrados: naoEncontrados,
        lista_erros: errosUpsert,
      };

      console.log("[omie-sync-estoque] resumo:", JSON.stringify(summary));

      // Marcadores do Sentinela (check estoque_reposicao): full sempre; pendente_po SÓ OBEN e SÓ quando o
      // snapshot do a-caminho foi realmente gravado nesta rodada — não-confiável deixa o marcador envelhecer
      // (stale/broken) = o alerta de "a-caminho congelado". COLACOR não tem esteira de reposição (o check é
      // OBEN-only); o full dela fica gravado por uniformidade, o pendente não (ListarSaldoPendente é
      // best-effort não-fatal lá — um 'complete' incondicional seria sinal fabricado).
      // Truncada ainda avança o last_sync_at (o físico LIDO foi gravado e está fresco), mas NUNCA
      // como 'complete' limpo: o error_message é o que o watchdog/health enxerga (mesmo contrato do
      // reprocessOrders — reconcile parcial não derruba a run, e também não mente completude).
      await gravarMarcadorSentinela(
        supabase,
        MARKER_FULL,
        empresa,
        "complete",
        {
          trigger: "run",
          sincronizados,
          nao_encontrados: naoEncontrados.length,
          duracao_ms: duracaoMs,
          fase_fisico_ms: faseFisicoMs,
          fase_po_ms: fasePo?.duracaoMs() ?? null,
          ...(varreduraTruncada ? { varredura_truncada: true, registros_lidos: registrosLidos, total_registros: totalRegistros } : {}),
        },
        varreduraTruncada
          ? `varredura truncada (${registrosLidos}/${totalRegistros} registros) — inativação de SKU suspensa`
          : null,
      );
      if (empresa === "OBEN" && pendenteConfiavel) {
        await gravarMarcadorSentinela(supabase, MARKER_PENDENTE_PO, empresa, "complete", {
          trigger: "run",
          skus_com_pendente: pendenteEntrada.size,
          duracao_ms: duracaoMs,
        });
      }

      return summary;
    }, detalhesDoRegistro);

    return jsonRes(resumo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.startsWith("AUTH_ERROR");
    console.error(
      `[omie-sync-estoque] ${isAuth ? "CRÍTICO AUTH" : "ERRO"}: ${msg}`,
    );
    // Falha TOTAL do run → 'error' no full marker (broken imediato no check), sem avançar last_sync_at.
    if (supabaseRef && empresaRef) {
      await gravarMarcadorSentinela(supabaseRef, MARKER_FULL, empresaRef, "error", { trigger: "run" }, msg);
    }
    return jsonRes({
      ok: false,
      error: msg,
      critical: isAuth,
      duracao_ms: Math.round(performance.now() - t0),
    }, isAuth ? 401 : 500);
  }
});
