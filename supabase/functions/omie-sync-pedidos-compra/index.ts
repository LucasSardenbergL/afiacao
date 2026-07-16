// Edge Function: omie-sync-pedidos-compra
// Sincroniza pedidos de compra do Omie (Oben + Colacor) para a tabela purchase_orders_tracking
// Pública (verify_jwt = false) - acionada via POST manual ou cron
//
// Método Omie usado: PesquisarPedCompra
// Doc: https://app.omie.com.br/api/v1/produtos/pedidocompra/#PesquisarPedCompra

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  computeJanelaPrevisao,
  deveRodarCompleto,
  type ModoSyncPedidos,
} from "../_shared/janela-pedidos-compra.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ===== Constantes =====
const SAYERLACK = {
  CNPJ: "61142865000691",
  OBEN_codigo_cliente_omie: 8689681266,
  COLACOR_codigo_cliente_omie: 393820664,
};

const OMIE_ENDPOINT_PEDIDOS =
  "https://app.omie.com.br/api/v1/produtos/pedidocompra/";

const PAGE_SIZE = 100; // MÁXIMO do PesquisarPedCompra — o Omie IGNORA >100 (sync.md); 100>50 corta as páginas pela metade
const RATE_LIMIT_DELAY_MS = 1100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

// [fix paginação+janela 2026-06-26] espelho de omie-sync-estoque (#979/#1009/#1072) — MESMA armadilha Omie:
// (a) PAGINAÇÃO — o nTotalPaginas SUB-REPORTA em listas grandes → confiar nele PARAVA a captura na 1ª página
//     (pedidos 1079+ sumiam do espelho purchase_orders_tracking). Paginar ATÉ A PÁGINA VAZIA + fingerprint
//     anti-loop + teto técnico FATAL.
// (b) JANELA — dDataInicial/dDataFinal do PesquisarPedCompra filtram pela DATA DE PREVISÃO DE ENTREGA
//     (dDtPrevisao), NÃO pela criação (provado no #1072, mesmo PO 1085). Com dDataFinal=hoje, todo pedido com
//     entrega FUTURA (= recém-feito, dentro do lead time) sumia. A janela cobre previsões PASSADAS e FUTURAS.
// [on-order jun/2026] Janela de previsão (passado por MODO, FUTURO fixo) extraída p/ helper PURO testado + espelhado
// byte-idêntico no edge: ../_shared/janela-pedidos-compra.ts (computeJanelaPrevisao). O cron alterna
// incremental (passado curto, frequente) × completo (passado amplo, ~1×/dia reconcilia atrasados); o FUTURO
// (+120d) é FIXO — encolher reintroduz o #1072 (some o pedido a caminho do tracking).
const MAX_PAGINAS = 200;              // teto técnico FATAL anti-loop (a janela ~485d cabe MUITO abaixo disso)
// fault do Omie que significa "fim legítimo" (sem registros), NÃO erro. Espelho VERBATIM de
// pendente-entrada-po.ts:FIM_SEM_REGISTROS (testada) via omie-sync-estoque.
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: "OBEN" | "COLACOR" | "ALL";
  dias?: number;
  fornecedor_codigo_omie?: number;
  modo?: ModoSyncPedidos; // override explícito (teste/backfill). cron decide auto; manual default = completo.
  trigger?: string;       // "cron" quando vem do omie-cron-diario (que NÃO repassa x-cron-secret p/ a filha)
}

interface EmpresaSummary {
  empresa: Empresa;
  total_paginas: number;
  pedidos_sincronizados: number;
  erros: number;
  // v3 publicação diferida (reconciliação PO excluído no Omie):
  janela_de: string | null;    // ISO yyyy-mm-dd da janela REAL do run (não CURRENT_DATE)
  janela_ate: string | null;
  ids_distintos: number;       // POs distintos vistos na varredura (telemetria + volume_ok)
  varredura_completa: boolean; // true = fim legítimo sem abort/truncamento/ID-inseguro (só então publica)
}

// ===== Omie API shapes (inline — Edge Function não pode importar de @/) =====
interface OmiePedidoCabecalho {
  nCodPed?: number | string | null;
  cCodIntPed?: string | null;
  dIncData?: string | null;
  cIncHora?: string | null;
  cEtapa?: string | null;
  cNumero?: string | null;
  cContrato?: string | null;
  dDtPrevisao?: string | null;
  nCodFor?: number | string | null;
  cObs?: string | null;
  cObsInt?: string | null;
  [key: string]: unknown;
}

interface OmiePedido {
  cabecalho?: OmiePedidoCabecalho;
  cabecalho_consulta?: OmiePedidoCabecalho;
  [key: string]: unknown;
}

interface OmieSearchResponse {
  pedidos_pesquisa?: OmiePedido[];
  pedido_compra_produto?: OmiePedido[];
  pedidoCompraProduto?: OmiePedido[];
  nTotalPaginas?: number;
  nTotalRegistros?: number;
  nPagina?: number;
  faultstring?: string;
  faultcode?: string;
  raw?: string;
  [key: string]: unknown;
}

// ===== Helpers =====
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatDateBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseBRDateToISO(dateBR?: string | null, timeBR?: string | null): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const time = timeBR && /^\d{2}:\d{2}(:\d{2})?$/.test(timeBR)
    ? (timeBR.length === 5 ? `${timeBR}:00` : timeBR)
    : "00:00:00";
  return `${yyyy}-${mm}-${dd}T${time}-03:00`;
}

function parseBRDateOnly(dateBR?: string | null): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

// MIRROR-START reposicao publicacao-run  (espelho de src/lib/reposicao/publicacao-run.ts — paridade textual normalizada no CI)
interface RunPublicacaoStatus {
  modo: "incremental" | "completo";
  varreduraCompleta: boolean;
  fornecedorCodigo: number | undefined;
}

// Publica o run SÓ no fim de um completo cuja COLETA foi LIMPA (varreduraCompleta = viu o fim sem
// abort/truncamento/ID-inseguro) e NÃO-filtrado por fornecedor (Codex P1 #1/#2: run filtrado carimbaria um
// subset; run abortado publicaria sinal inválido). NÃO checa summary.erros: um erro de PERSISTÊNCIA do espelho
// (upsert de linha torta) NÃO corrompe idsVistos (coletado ANTES do upsert), e erro de COLETA já vira
// varreduraCompleta=false (abortado/!fim) — gatear por erros travava a publicação num upsert torto (Codex v3.2 P1).
function devePublicarRun(s: RunPublicacaoStatus): boolean {
  return !s.fornecedorCodigo && s.modo === "completo" && s.varreduraCompleta;
}
// MIRROR-END reposicao publicacao-run

// MIRROR-START reposicao omie-pagina  (espelho de src/lib/reposicao/omie-pagina.ts — paridade normalizada no CI)
interface OmiePaginaResp {
  faultstring?: unknown;
  faultcode?: unknown;
  nPagina?: unknown;
  nTotalPaginas?: unknown;
  nTotalRegistros?: unknown;
  /** o PesquisarPedCompra devolve o tamanho de página que ecoou o nRegsPorPagina da chamada (contrato: integer) */
  nRegsPorPagina?: unknown;
  pedidos_pesquisa?: unknown;
  pedido_compra_produto?: unknown;
  pedidoCompraProduto?: unknown;
}

/** Maior total já declarado pelo Omie em QUALQUER resposta deste run (fault inclusive). Só cresce. */
interface PisoTotais {
  registros: number;
  paginas: number;
}

type ClassificacaoPagina =
  | { tipo: "dados"; ids: number[]; pedidos: unknown[] }
  | { tipo: "fim" }
  | { tipo: "anomalia"; motivo: string };

interface CtxPagina {
  /** página SOLICITADA nesta chamada */
  pagina: number;
  /** IDs canônicos distintos já coletados nas páginas ANTERIORES */
  idsVistos: ReadonlySet<number>;
  /** piso acumulado até aqui (já incluindo esta resposta — ver acumularPiso) */
  piso: PisoTotais;
}

const PISO_ZERO: PisoTotais = { registros: 0, paginas: 0 };

/**
 * TODO campo inteiro que o PesquisarPedCompra declara (contrato: integer). O classificarPagina varre esta lista —
 * a matriz de testes varre a MESMA lista × a classe inteira de lixo. Campo novo do contrato entra AQUI e ganha
 * validação + teste de graça. Escolher à mão quais validar foi o que deixou nRegsPorPagina sem cobertura (Codex #11).
 */
const CAMPOS_INTEIROS = ["nPagina", "nTotalPaginas", "nTotalRegistros", "nRegsPorPagina"] as const;

// Vocabulário do fault TERMINAL ("sem registros" = fim legítimo, NÃO erro). VERBATIM de
// pendente-entrada-po.ts:FIM_SEM_REGISTROS — a fonte canônica, já endurecida por 2 rodadas (P2-D: o `\b` após
// `h[áa]` falhava porque `á` não é `\w`; o `.{0,30}?` entre o verbo e "registros" abria OVER-MATCH — "Não há
// PERMISSÃO PARA ACESSAR registros" era ERRO virando fim → parava cedo → double-buy). Reescrever este vocabulário
// aqui divergiu da camada HTTP (que aceita o amplo) e congelava o run: fault terminal legítimo virava anomalia →
// NENHUM run publicava → o marcador velho persistia → PO excluído nunca virava candidato (Codex #10 P1).
const FIM_SEM_REGISTROS_RE =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;

/**
 * Metadado inteiro do Omie (nPagina/nTotalPaginas/nTotalRegistros) em 3 estados:
 *   número  = canônico (inteiro seguro >= 0, ou string de DÍGITOS — o contrato do Omie declara integer);
 *   null    = AUSENTE (undefined/null/"") — legítimo, nem toda resposta traz os totais;
 *   NaN     = ILEGÍVEL (presente mas não-canônico: true, "x", 1.5, "1e3", [], {}).
 * Pelo mesmo motivo do lerNCodPed: `Number()` direto COAGE (true→1, "1e3"→1000, [5]→5) e NaN some no
 * `isFinite`, então ilegível viraria "ausente" e um vazio malformado passaria por "empresa vazia legítima".
 */
function lerInteiroOmie(raw: unknown): number | null {
  // AUSENTE é só o campo OMITIDO (undefined/null). "" NÃO é ausente: é valor PRESENTE e não-canônico — o contrato
  // do Omie declara os totais como integer, e "" não é integer (Codex #11 P1: {"nTotalRegistros":""} escapava como
  // ausente → vazio virava "empresa vazia legítima" → marcador vazio falso-válido). Ele cai no ramo string abaixo,
  // não casa /^\d+$/ e vira NaN = ILEGÍVEL.
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : NaN;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
  }
  return NaN;
}

/**
 * String CANÔNICA do Omie (faultstring/faultcode) em 3 estados:
 *   string = presente (pode ser "" = presente-sem-conteúdo);
 *   null   = AUSENTE (omitido/null);
 *   false  = ILEGÍVEL (array/objeto/boolean/número — o contrato declara string).
 * Existe porque `String(raw)` e `regex.test(raw)` COAGEM: String(["Não existem registros"]) devolve a frase
 * TERMINAL e o fault vira "fim" → publica marcador vazio (Codex #11 P1). Mesma classe do lerInteiroOmie/lerNCodPed:
 * todo campo que entra do Omie passa por leitor canônico — nunca por coerção implícita.
 */
function lerStringOmie(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  return false;
}

/** true = o metadado está PRESENTE mas não é canônico (≠ ausente). */
function ilegivel(v: number | null): boolean {
  return typeof v === "number" && Number.isNaN(v);
}

/**
 * PISO ACUMULADO: o maior total declarado até agora. Nunca decresce — uma resposta terminal SEM totais não pode
 * apagar o que uma página anterior declarou (senão um run que perde as últimas páginas parece completo).
 * Só acumula CANÔNICO; ilegível é barrado antes, no classificarPagina (aqui seria silencioso).
 */
function acumularPiso(resp: OmiePaginaResp, piso: PisoTotais): PisoTotais {
  const reg = lerInteiroOmie(resp?.nTotalRegistros);
  const pag = lerInteiroOmie(resp?.nTotalPaginas);
  return {
    registros: reg !== null && !Number.isNaN(reg) && reg > piso.registros ? reg : piso.registros,
    paginas: pag !== null && !Number.isNaN(pag) && pag > piso.paginas ? pag : piso.paginas,
  };
}

/**
 * nCodPed CANÔNICO: presente, inteiro SEGURO (>2^53 o Number arredondaria → carimbaria um bigint ERRADO no
 * sinal) e positivo. Qualquer coisa fora disso é null → o chamador invalida a coleta (o PO não é rastreável).
 */
function lerNCodPed(pedido: unknown): number | null {
  const p = pedido as
    | { cabecalho_consulta?: { nCodPed?: unknown }; cabecalho?: { nCodPed?: unknown } }
    | null
    | undefined;
  const raw = p?.cabecalho_consulta?.nCodPed ?? p?.cabecalho?.nCodPed;
  // NÃO usar Number(raw) direto: ele COAGE true→1, "1e3"→1000, [5]→5, " 7 "→7 — um ID ERRADO entraria no sinal
  // sem invalidar nada. Canônico = number inteiro seguro >0, ou string de DÍGITOS (o contrato do Omie declara
  // nCodPed integer). Qualquer outra representação = ilegível → null → o chamador invalida a coleta.
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * O FIM (lista vazia OU fault "sem registros") só é legítimo se COERENTE com o piso: se o Omie declarou mais
 * registros do que os IDs distintos coletados, ou declarou que ESTA página existe, então é TRUNCAMENTO — não
 * "empresa vazia". Publicar um vazio contraditório daria ids=0 → volume_ok=true → marcador VAZIO falso-válido,
 * e TODO PO viraria candidato de uma vez. Piso zerado/ausente => empresa vazia legítima, segue válida.
 */
function fimCoerente(ctx: CtxPagina): boolean {
  const faltamRegistros = ctx.piso.registros > ctx.idsVistos.size;
  const paginaDeveriaExistir = ctx.piso.paginas >= ctx.pagina;
  return !faltamRegistros && !paginaDeveriaExistir;
}

function incoerencia(ctx: CtxPagina, o_que: string): string {
  return `${o_que} contradiz o piso do Omie (registros=${ctx.piso.registros} ids_distintos=${ctx.idsVistos.size} paginas=${ctx.piso.paginas} pagina=${ctx.pagina})`;
}

/**
 * Classifica UMA página: `dados` (seguir), `fim` (encerrar limpo) ou `anomalia` (abortar e INVALIDAR a
 * publicação). Fail-closed: na dúvida, anomalia — publicar sinal de run inválido envenena a base de verdade que
 * o PR2 usa para decidir o que provar por ID.
 */
function classificarPagina(resp: OmiePaginaResp, ctx: CtxPagina): ClassificacaoPagina {
  if (!resp || typeof resp !== "object") return { tipo: "anomalia", motivo: "resposta não é um objeto" };

  // (a0) TODO metadado inteiro do contrato tem de ser CANÔNICO quando PRESENTE. Ilegível ("" , true, "x", 1.5,
  //      [], {}) NÃO é "ausente": tratá-lo como ausente APAGA a evidência de resposta malformada e promove o vazio
  //      a "empresa vazia legítima" → marcador vazio falso-válido (Codex #10/#11 P1). Só o campo OMITIDO
  //      (undefined/null) é ausente. Varredura pela LISTA do contrato — escolher à mão quais validar foi o que
  //      deixou "" e nRegsPorPagina escaparem. Fail-closed: shape torto = anomalia.
  for (const campo of CAMPOS_INTEIROS) {
    if (ilegivel(lerInteiroOmie(resp[campo]))) {
      return { tipo: "anomalia", motivo: `${campo} não-canônico (${String(resp[campo])}) — resposta malformada` };
    }
  }
  const nPagina = lerInteiroOmie(resp.nPagina);

  // (a) a página DECLARADA tem de ser a SOLICITADA — resposta stale/misrouted ({nPagina:3} quando pedimos a 2)
  //     publicaria um fim falso. Ausente é tolerado (nem toda resposta traz nPagina); divergente é anomalia.
  if (nPagina !== null && nPagina !== ctx.pagina) {
    return { tipo: "anomalia", motivo: `nPagina declarada (${String(resp.nPagina)}) != solicitada (${ctx.pagina})` };
  }

  const aliases = [resp.pedidos_pesquisa, resp.pedido_compra_produto, resp.pedidoCompraProduto];
  const listas = aliases.filter((a): a is unknown[] => Array.isArray(a));
  const algumConflitante = aliases.some((a) => a !== undefined && a !== null && !Array.isArray(a));

  // (b) fault: erro de APLICAÇÃO do Omie — pode vir com HTTP 200 carregando faultcode E/OU faultstring.
  //     LEITOR canônico, nunca String()/test() direto: ambos COAGEM, e String(["Não existem registros"]) devolve
  //     a frase terminal → o fault viraria "fim" e publicaria marcador vazio (Codex #11 P1).
  const fsLido = lerStringOmie(resp.faultstring);
  const fcLido = lerStringOmie(resp.faultcode);
  if (fsLido === false) {
    return { tipo: "anomalia", motivo: "faultstring não-canônica (não é string) — resposta malformada" };
  }
  if (fcLido === false) {
    return { tipo: "anomalia", motivo: "faultcode não-canônico (não é string) — resposta malformada" };
  }
  const temFault = (fsLido !== null && fsLido !== "") || (fcLido !== null && fcLido !== "");
  if (temFault) {
    const fs = fsLido ?? "";
    if (fs && FIM_SEM_REGISTROS_RE.test(fs)) {
      // fault TERMINAL ("não existem registros"). Se a PRÓPRIA resposta traz pedidos ou shape torto, ela se
      // CONTRADIZ → anomalia (senão publicaríamos ids=[] com um PO visível na mão).
      if (algumConflitante || listas.length > 1) {
        return { tipo: "anomalia", motivo: 'fault "sem registros" com aliases tortos' };
      }
      if (listas.length === 1 && listas[0].length > 0) {
        return { tipo: "anomalia", motivo: `fault "sem registros" mas a resposta traz ${listas[0].length} pedido(s)` };
      }
      return fimCoerente(ctx) ? { tipo: "fim" } : { tipo: "anomalia", motivo: incoerencia(ctx, 'fault "sem registros"') };
    }
    return { tipo: "anomalia", motivo: `fault: ${fs || (fcLido ?? "")}` };
  }

  // (c) 2xx sem fault: precisa ser EXATAMENTE 1 lista conhecida (o contrato do Omie declara só pedidos_pesquisa;
  //     2 listas divergentes ou alias em tipo conflitante já viraram fim espúrio antes).
  if (listas.length !== 1 || algumConflitante) {
    return {
      tipo: "anomalia",
      motivo: `shape anômalo (listas=${listas.length}, alias conflitante=${algumConflitante})`,
    };
  }
  const pedidos = listas[0];

  // (d) lista vazia → mesmo classificador terminal do fault.
  if (pedidos.length === 0) {
    return fimCoerente(ctx) ? { tipo: "fim" } : { tipo: "anomalia", motivo: incoerencia(ctx, "lista vazia") };
  }

  // (e) dados: todo registro precisa de nCodPed CANÔNICO, e nenhum pode REPETIR um ID (de página anterior ou da
  //     própria página). Sobreposição = a paginação girou/duplicou: o Set deduplicaria em silêncio e o piso
  //     bateria com menos POs do que o universo real → um PO sumiria do sinal sem ninguém notar.
  const ids: number[] = [];
  const idsDaPagina = new Set<number>();
  for (const p of pedidos) {
    const id = lerNCodPed(p);
    if (id === null) return { tipo: "anomalia", motivo: "pedido sem nCodPed canônico (ausente/ilegível/inseguro)" };
    if (ctx.idsVistos.has(id)) {
      return { tipo: "anomalia", motivo: `nCodPed ${id} repetido de página anterior (sobreposição de paginação)` };
    }
    if (idsDaPagina.has(id)) return { tipo: "anomalia", motivo: `nCodPed ${id} duplicado na mesma página` };
    idsDaPagina.add(id);
    ids.push(id);
  }
  return { tipo: "dados", ids, pedidos };
}
// MIRROR-END reposicao omie-pagina

function getCredentials(empresa: Empresa): { app_key: string; app_secret: string } {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) {
      throw new Error("Credenciais OBEN ausentes: OMIE_OBEN_APP_KEY e/ou OMIE_OBEN_APP_SECRET");
    }
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) {
    throw new Error("Credenciais COLACOR ausentes: OMIE_COLACOR_APP_KEY e/ou OMIE_COLACOR_APP_SECRET");
  }
  return { app_key, app_secret };
}

async function callOmie(
  app_key: string,
  app_secret: string,
  pagina: number,
  dataDe: string,
  dataAte: string,
): Promise<OmieSearchResponse> {
  // PesquisarPedCompra NÃO suporta filtro nativo por fornecedor.
  // Filtramos pós-resposta em syncEmpresa().
  const param: Record<string, unknown> = {
    nPagina: pagina,
    nRegsPorPagina: PAGE_SIZE,
    lApenasImportadoApi: "F",
    lExibirPedidosPendentes: "T",
    lExibirPedidosFaturados: "T",
    lExibirPedidosRecebidos: "T",
    lExibirPedidosCancelados: "T",
    lExibirPedidosEncerrados: "T",
    lExibirPedidosRecParciais: "T",
    lExibirPedidosFatParciais: "T",
    dDataInicial: dataDe,
    dDataFinal: dataAte,
  };

  const body = {
    call: "PesquisarPedCompra",
    app_key,
    app_secret,
    param: [param],
  };

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await fetch(OMIE_ENDPOINT_PEDIDOS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json: OmieSearchResponse;
    try {
      json = JSON.parse(text) as OmieSearchResponse;
    } catch {
      json = { raw: text };
    }

    // typeof string ANTES do .test(): RegExp.test() COAGE o argumento — test(["rate limit"]) é true (Codex #11 P1,
    // mesma classe do faultstring array virando fault terminal). faultstring não-string = shape torto: o parser o
    // rejeita adiante como anomalia; aqui só não podemos LER como se fosse texto.
    if (res.status === 429 || (typeof json?.faultstring === "string" && /rate limit/i.test(json.faultstring))) {
      console.warn(`[omie] rate limit atingido (tentativa ${attempt}/${MAX_RETRIES}), aguardando ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    // [fix paginação] O Omie sinaliza FIM DE PÁGINAS com HTTP 500 + faultstring "Não existem registros para a
    // página [N]" (faultcode 5113), NÃO com 200+lista-vazia. Sem isto, o throw em !res.ok mataria a paginação-
    // até-vazia na 1ª página-além-do-fim. Devolve o json p/ o loop tratar como fim (via FIM_SEM_REGISTROS).
    // typeof string ANTES do .test() (Codex #11 P1): test() coage, então faultstring:["Não existem registros"]
    // devolveria o json como TERMINAL e o fim viraria "empresa vazia" → marcador vazio falso-válido. Não-string
    // cai no throw abaixo e o loop invalida a publicação — fail-closed.
    if (!res.ok && typeof json?.faultstring === "string" && FIM_SEM_REGISTROS.test(json.faultstring)) {
      return json;
    }

    if (!res.ok) {
      throw new Error(`Omie HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    return json;
  }
  throw new Error(`Omie: rate limit excedido após ${MAX_RETRIES} tentativas`);
}

// Campos que NÃO devem ser sobrescritos (preenchidos por outros syncs)
const PRESERVE_FIELDS = new Set([
  "id",
  "created_at",
  "t2_data_faturamento",
  "t3_data_cte",
  "t4_data_recebimento",
  "nfe_chave_acesso",
  "nfe_numero",
  "nfe_serie",
  "cte_chave_acesso",
  "cte_numero",
  "numero_pedido_fornecedor",
  "infcpl_raw",
  "transportadora_cnpj",
  "transportadora_nome",
  "representante_codigo",
  "representante_nome",
  "lt_bruto_dias_uteis",
  "lt_faturamento_dias_uteis",
  "lt_logistica_dias_uteis",
]);

/**
 * Mapeia um pedido retornado por PesquisarPedCompra → linha de purchase_orders_tracking.
 * Estrutura do retorno (pedidos_pesquisa[]):
 *   {
 *     cabecalho: { nCodPed, cCodIntPed, dIncData, cIncHora, cEtapa, cNumero,
 *                  dDtPrevisao, nCodFor, cObs, cObsInt, ... }
 *     ...
 *   }
 * Status derivado de cEtapa (etapas Omie):
 *   "10"=Digitação, "20"=Aprovação, "50"=Aprovado, "60"=Faturado,
 *   "70"=Recebido, "80"=Encerrado, "90"=Cancelado
 */
function mapPedidoToRow(empresa: Empresa, pedido: OmiePedido): Record<string, unknown> {
  // PesquisarPedCompra retorna o cabeçalho em "cabecalho_consulta" (não "cabecalho")
  const cab = pedido?.cabecalho_consulta ?? pedido?.cabecalho ?? {};
  const etapa = String(cab?.cEtapa ?? "").trim();

  let status = "CRIADO";
  if (etapa === "90") status = "CANCELADO";
  else if (etapa === "80") status = "ENCERRADO";
  else if (etapa === "70") status = "RECEBIDO";
  else if (etapa === "60") status = "FATURADO";

  return {
    empresa,
    omie_codigo_pedido: cab?.nCodPed ?? null,
    omie_codigo_integracao: cab?.cCodIntPed ?? null,
    numero_pedido: cab?.cNumero ?? null,
    numero_contrato_fornecedor: cab?.cContrato
      ? String(cab.cContrato).trim() || null
      : null,
    fornecedor_codigo_omie: cab?.nCodFor ?? null,
    grupo_leadtime: "OUTRO",
    status,
    t1_data_pedido: parseBRDateToISO(cab?.dIncData, cab?.cIncHora),
    data_previsao_original: parseBRDateOnly(cab?.dDtPrevisao),
    observacoes: cab?.cObs ?? null,
    raw_data: pedido,
  };
}

// Upsert em LOTE (1 chamada/página via uq_pedido_omie = UNIQUE(empresa, omie_codigo_pedido)), NÃO N+1.
// [fix wall-clock] a janela ampla (~485d) traz centenas de pedidos; o SELECT+UPDATE/INSERT por pedido (2
// round-trips × N) estourava o step de 25s do omie-cron-diario. O payload EXCLUI PRESERVE_FIELDS (campos de
// OUTROS syncs: t2/t3/t4, nfe, cte, transportadora, representante, lt_*) → o ON CONFLICT DO UPDATE não os
// toca = preserva o último valor bom (MESMO efeito do upsert seletivo antigo). Fallback individual em erro de
// lote isola a linha torta sem perder a página inteira (espelho de omie-sync-estoque).
async function upsertPedidosLote(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<{ sincronizados: number; erros: number }> {
  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown>[] = [];
  let erros = 0;

  for (const row of rows) {
    // nCodPed ausente → omie_codigo_pedido null não casa o UNIQUE (null≠null no Postgres) → inseriria duplicata
    // órfã a cada sync. Pula e conta erro (mesma guarda do upsert antigo).
    if (row.omie_codigo_pedido === null || row.omie_codigo_pedido === undefined) {
      console.error(`[sync-pedidos] pedido sem nCodPed (numero=${row.numero_pedido ?? "—"}) — pulado`);
      erros++;
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!PRESERVE_FIELDS.has(k)) clean[k] = v;
    }
    clean.updated_at = nowIso;
    payload.push(clean);
  }

  if (payload.length === 0) return { sincronizados: 0, erros };

  const { error } = await supabase
    .from("purchase_orders_tracking")
    .upsert(payload, { onConflict: "empresa,omie_codigo_pedido" });
  if (!error) return { sincronizados: payload.length, erros };

  // Lote falhou (1 linha torta derruba o batch) → individual p/ isolar a culpada e salvar o resto.
  console.error(`[sync-pedidos] erro upsert lote (${payload.length}): ${error.message}. Tentando individual.`);
  let sincronizados = 0;
  for (const row of payload) {
    const { error: e2 } = await supabase
      .from("purchase_orders_tracking")
      .upsert(row, { onConflict: "empresa,omie_codigo_pedido" });
    if (e2) {
      console.error(`[sync-pedidos] erro upsert pedido=${row.omie_codigo_pedido}: ${e2.message}`);
      erros++;
    } else {
      sincronizados++;
    }
  }
  return { sincronizados, erros };
}

// fingerprint barato de página (anti-loop): mesma página NÃO-VAZIA repetida = Omie em loop → abort FATAL.
// Espelho de omie-sync-estoque, adaptado: usa nCodPed (sempre presente) + cNumero do cabeçalho da consulta.
function fingerprintPagina(pedidos: readonly OmiePedido[]): string {
  if (!pedidos || pedidos.length === 0) return "";
  const prim = pedidos[0]?.cabecalho_consulta ?? pedidos[0]?.cabecalho ?? {};
  const ult = pedidos[pedidos.length - 1]?.cabecalho_consulta ?? pedidos[pedidos.length - 1]?.cabecalho ?? {};
  const chave = (c: OmiePedidoCabecalho) =>
    `${String(c?.nCodPed ?? "").trim()}/${String(c?.cNumero ?? "").trim()}`;
  return `${pedidos.length}:${chave(prim)}:${chave(ult)}`;
}

async function syncEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  modo: ModoSyncPedidos,
  dias: number,
  fornecedorCodigo: number | undefined,
  idsVistos: Set<number>,
): Promise<EmpresaSummary> {
  const summary: EmpresaSummary = {
    empresa,
    total_paginas: 0,
    pedidos_sincronizados: 0,
    erros: 0,
    janela_de: null,
    janela_ate: null,
    ids_distintos: 0,
    varredura_completa: false,
  };
  let registrosVistos = 0;      // LINHAS lidas (observabilidade: linhas × ids_distintos denuncia sobreposição)

  const { app_key, app_secret } = getCredentials(empresa);

  const hoje = new Date();
  // [fix janela #1072] o filtro dDataInicial/dDataFinal do PesquisarPedCompra é por DATA DE PREVISÃO DE
  // ENTREGA (dDtPrevisao), não por criação. computeJanelaPrevisao (helper testado): passado por MODO
  // (incremental curto × completo amplo), FUTURO fixo +120d (a caminho, dentro do lead time — encolher o
  // futuro reintroduz o #1072). `dias` só AMPLIA o passado no modo completo (backfill manual).
  const { passadoDias, futuroDias } = computeJanelaPrevisao(modo, dias);
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - passadoDias);
  const fimJanela = new Date();
  fimJanela.setDate(hoje.getDate() + futuroDias);
  const dataDe = formatDateBR(inicio);
  const dataAte = formatDateBR(fimJanela);
  // Janela REAL do run em ISO (yyyy-mm-dd) p/ a publicação diferida — NÃO CURRENT_DATE (design §5).
  summary.janela_de = parseBRDateOnly(dataDe);
  summary.janela_ate = parseBRDateOnly(dataAte);
  console.log(
    `[sync-pedidos] empresa=${empresa} modo=${modo} janela previsão ${dataDe}→${dataAte} (passado ${passadoDias}d, futuro ${futuroDias}d)`,
  );

  // [fix paginação] PAGINA ATÉ A PÁGINA VAZIA — não confiar em nTotalPaginas (Omie SUB-REPORTA → lia só a 1ª
  // página → pedidos 1079+ sumiam). Fingerprint anti-loop por página repetida + teto técnico (espelho do irmão).
  const fpsVistos = new Set<string>();
  let fim = false;       // vi o fim legítimo dos dados (página vazia / fault "sem registros")
  let abortado = false;  // saí por erro/anomalia (fetch, fault real, loop) — já contado em summary.erros
  // PISO acumulado dos totais do Omie (nTotalRegistros/nTotalPaginas). Semântica e guards no parser puro
  // (omie-pagina.ts): é PISO de sanidade, NUNCA teto — o Omie SUB-REPORTA (#979/#1009), então paginamos até a
  // página vazia e jamais paramos pelo total; e só cresce (resposta terminal sem totais não apaga o piso).
  let piso: PisoTotais = PISO_ZERO;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    let resp: OmieSearchResponse;
    try {
      resp = await callOmie(app_key, app_secret, pagina, dataDe, dataAte);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} erro fetch: ${msg}`);
      summary.erros++;
      abortado = true;
      break;
    }

    // [v3.9] PISO acumulado + classificação da página são do PARSER PURO (espelhado abaixo; fonte em
    // src/lib/reposicao/omie-pagina.ts). SEIS Codex challenge xhigh acharam furos nesta lógica um shape por vez
    // (raw→[]; faultcode sem faultstring; alias conflitante; 2 listas; vazio contradizendo totais; fault
    // escapando do guard; piso não acumulando; linhas vs IDs distintos; sobreposição parcial; nPagina stale) —
    // remendo não convergia e guardrail textual não prova comportamento. Agora a matriz inteira é teste de
    // vitest (omie-pagina.test.ts). O piso entra ANTES de classificar: os totais podem vir no PRÓPRIO fault.
    piso = acumularPiso(resp, piso);
    const cls = classificarPagina(resp, { pagina, idsVistos, piso });

    if (cls.tipo === "anomalia") {
      // fail-closed: qualquer shape que não seja dados/fim COERENTE invalida a publicação (um sinal parcial
      // publicado como válido envenena a base de verdade que o PR2 usa p/ decidir quem provar por ID).
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} ${cls.motivo} — abort/invalida publicação`);
      summary.erros++;
      abortado = true;
      break;
    }
    if (cls.tipo === "fim") {
      console.log(
        `[sync-pedidos] empresa=${empresa} pagina=${pagina} fim legítimo (piso registros=${piso.registros} ` +
          `paginas=${piso.paginas} · ids_distintos=${idsVistos.size} linhas=${registrosVistos})`,
      );
      fim = true;
      break;
    }

    // dados: o parser já garantiu 1 lista conhecida, nCodPed CANÔNICO em todo registro e ZERO sobreposição
    // (ID repetido de página anterior/da mesma página → anomalia acima, pois o Set deduplicaria em silêncio e
    // um PO sumiria do sinal — Codex #9 P1).
    let pedidos = cls.pedidos as OmiePedido[];
    registrosVistos += pedidos.length;

    const fp = fingerprintPagina(pedidos);
    if (fp && fpsVistos.has(fp)) {
      console.error(`[sync-pedidos] empresa=${empresa} REPETIÇÃO de página (pág ${pagina}) — abort anti-loop`);
      summary.erros++;
      abortado = true;
      break;
    }
    fpsVistos.add(fp);

    // [publicação diferida v3] IDs VISTOS na varredura (ANTES do filtro fornecedor — no run de publicação não há
    // filtro; representa TODOS os POs da janela). Publicados 1× no fim LIMPO via reposicao_publicar_run_completo
    // — NUNCA carimba last_seen durante o upsert (Codex P1 #1).
    for (const id of cls.ids) idsVistos.add(id);

    // DEBUG: log shape do primeiro pedido (página 1) e top-level keys
    if (pagina === 1) {
      console.log(`[sync-pedidos] DEBUG top-level keys: ${JSON.stringify(Object.keys(resp || {}))}`);
      if (pedidos.length > 0) {
        console.log(`[sync-pedidos] SHAPE primeiro pedido: ${JSON.stringify(pedidos[0], null, 2).slice(0, 4000)}`);
      }
    }

    // Filtro pós-resposta por fornecedor (PesquisarPedCompra não filtra nativamente)
    if (fornecedorCodigo) {
      const before = pedidos.length;
      pedidos = pedidos.filter(
        (p) => Number(p?.cabecalho_consulta?.nCodFor ?? p?.cabecalho?.nCodFor) === Number(fornecedorCodigo),
      );
      if (before !== pedidos.length) {
        console.log(
          `[sync-pedidos] empresa=${empresa} pagina=${pagina} filtro fornecedor: ${before} → ${pedidos.length}`,
        );
      }
    }

    console.log(`[sync-pedidos] empresa=${empresa} pagina=${pagina} recebidos=${pedidos.length}`);

    const rows = pedidos.map((pedido) => mapPedidoToRow(empresa, pedido));
    const upsertRes = await upsertPedidosLote(supabase, rows);
    summary.pedidos_sincronizados += upsertRes.sincronizados;
    summary.erros += upsertRes.erros;

    summary.total_paginas = pagina;
    await sleep(RATE_LIMIT_DELAY_MS); // rate-limit Omie entre páginas
  }

  if (!fim && !abortado) {
    // Esgotou MAX_PAGINAS sem ver o fim (e sem erro pelo caminho). O irmão (estoque) faz THROW aqui (fail-closed,
    // pois alimenta double-buy). AQUI o consumidor é um ESPELHO DE ACOMPANHAMENTO (leadtime/telas), não um
    // gatilho de compra: dado parcial vale mais que derrubar o sync. Registra erro (sinal no summary) e preserva
    // o já capturado (upsert idempotente retoma no próximo ciclo).
    console.error(`[sync-pedidos] empresa=${empresa} excedeu ${MAX_PAGINAS} páginas sem ver fim — abort anti-truncamento`);
    summary.erros++;
  }

  summary.ids_distintos = idsVistos.size;
  // limpo = vi o FIM legítimo (coerente com o piso) e nenhuma anomalia abortou. Toda invalidação da coleta
  // (shape torto, nCodPed não-canônico, sobreposição, fim contraditório) já veio como anomalia → abortado.
  summary.varredura_completa = fim && !abortado;
  return summary;
}

// ===== Heartbeat do Sentinela (sync_state) =====
// Marcador 1-writer dedicado: entity_type='pedidos_compra', account=<empresa minúscula>.
// O check pedidos_compra_sync em _data_health_compute() lê este marcador.
//   last_sync_at = horário do último SUCESSO (complete/partial) — NÃO avança em falha total,
//                  para preservar "última coleta boa" ao operador.
//   updated_at   = heartbeat de execução (todo upsert o avança) — usado p/ detectar 'running' órfão.
//   status       = running → complete | partial | error.
//   metadata     = { trigger, dias, ... } para auditoria (qual execução o marcador representa).
// purchase_orders_tracking é multi-writer (nfes/ctes/sku-items também escrevem updated_at), então
// frescor pela tabela NÃO isola este sync — daí o marcador dedicado. Só gravado em sync ABRANGENTE
// (sem fornecedor específico); investigação manual por-fornecedor não polui o sinal.
const HEARTBEAT_ENTITY = "pedidos_compra";

async function heartbeatRunning(
  supabase: SupabaseClient,
  empresa: Empresa,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase.from("sync_state").upsert(
      {
        entity_type: HEARTBEAT_ENTITY,
        account: empresa.toLowerCase(),
        status: "running",
        updated_at: new Date().toISOString(),
        metadata: { ...meta, started_at: new Date().toISOString() },
      },
      { onConflict: "entity_type,account" },
    );
    if (error) throw error;
  } catch (err) {
    // Heartbeat é best-effort: nunca derruba o sync por causa do marcador.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] heartbeat running falhou empresa=${empresa}: ${msg}`);
  }
}

async function heartbeatFim(
  supabase: SupabaseClient,
  s: EmpresaSummary,
  meta: Record<string, unknown>,
  errFatal: string | null,
): Promise<void> {
  const nowISO = new Date().toISOString();
  // Falha TOTAL (0 sincronizados + erros>0) → 'error' SEM avançar last_sync_at (preserva último sucesso).
  // Parcial (algum progresso + erros)      → 'partial' COM last_sync_at (houve coleta, mas truncada).
  // Sucesso (0 erros, mesmo 0 pedidos = janela vazia legítima) → 'complete' COM last_sync_at.
  const falhaTotal = s.pedidos_sincronizados === 0 && s.erros > 0;
  const parcial = s.pedidos_sincronizados > 0 && s.erros > 0;
  const status = falhaTotal ? "error" : parcial ? "partial" : "complete";
  const row: Record<string, unknown> = {
    entity_type: HEARTBEAT_ENTITY,
    account: s.empresa.toLowerCase(),
    status,
    updated_at: nowISO,
    total_synced: s.pedidos_sincronizados,
    error_message: s.erros > 0
      ? (errFatal ?? `${s.erros} erro(s) na coleta, ${s.pedidos_sincronizados} sincronizado(s)`)
      : null,
    // metadata.modo é só para VISIBILIDADE (incremental×completo). A CADÊNCIA do completo NÃO mora aqui —
    // vive no marcador dedicado HEARTBEAT_FULL_ENTITY (escrito só por completos bem-sucedidos), p/ não
    // sofrer lost-update de um incremental concorrente regravando o metadata inteiro (Codex 2026-06-26).
    metadata: { ...meta, finished_at: nowISO, erros: s.erros, total_paginas: s.total_paginas },
  };
  // last_sync_at só avança quando houve progresso (complete/partial). Em falha total, OMITIMOS a coluna
  // → o upsert não a sobrescreve (mantém o horário do último sucesso). Coluna ausente em 1º run = NULL.
  if (!falhaTotal) row.last_sync_at = nowISO;
  try {
    const { error } = await supabase.from("sync_state").upsert(row, { onConflict: "entity_type,account" });
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] heartbeat fim falhou empresa=${s.empresa}: ${msg}`);
  }
}

// Marcador DEDICADO da cadência do completo: entity_type='pedidos_compra_full', account=<empresa>. SÓ um
// sync COMPLETO bem-sucedido o escreve (idempotente: grava last_sync_at=agora). O incremental NUNCA o toca →
// imune ao lost-update que um campo no metadata multi-writer sofreria com execuções concorrentes (um
// incremental atrasado regravaria o metadata inteiro por cima de um completo recente — Codex 2026-06-26).
const HEARTBEAT_FULL_ENTITY = "pedidos_compra_full";

// Epoch ms do último COMPLETO bem-sucedido (marcador HEARTBEAT_FULL_ENTITY). Best-effort: erro/ausência →
// null → o cron roda COMPLETO (fail-safe conservador: reconcilia em vez de pular; auto-recupera no próximo
// completo bom). Lido ANTES de decidir o modo.
async function lerLastFullAt(supabase: SupabaseClient, empresa: Empresa): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("sync_state")
      .select("last_sync_at")
      .eq("entity_type", HEARTBEAT_FULL_ENTITY)
      .eq("account", empresa.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    const raw = (data as { last_sync_at?: string | null } | null)?.last_sync_at;
    if (!raw) return null;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] lerLastFullAt falhou empresa=${empresa}: ${msg} — assumindo completo`);
    return null;
  }
}

// Carimba o marcador de cadência APÓS um completo bem-sucedido (idempotente). Best-effort — nunca derruba o sync.
async function marcarCompletoOk(supabase: SupabaseClient, empresa: Empresa): Promise<void> {
  const nowISO = new Date().toISOString();
  try {
    const { error } = await supabase.from("sync_state").upsert(
      {
        entity_type: HEARTBEAT_FULL_ENTITY,
        account: empresa.toLowerCase(),
        status: "complete",
        last_sync_at: nowISO,
        updated_at: nowISO,
      },
      { onConflict: "entity_type,account" },
    );
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] marcarCompletoOk falhou empresa=${empresa}: ${msg}`);
  }
}

// ===== Publicação diferida ATÔMICA (v3 — reconciliação PO excluído) =====
// Grava o marcador de run E (se o run for VÁLIDO) carimba last_seen dos POs vistos numa RPC SQL única
// (advisory lock por empresa + service_role-only). Chamada 1× no fim do completo LIMPO e NÃO-filtrado.
// Retorna TRUE se a PUBLICAÇÃO teve SUCESSO (marcador gravado), FALSE se a RPC deu erro. A CADÊNCIA do cron
// avança só nesse sucesso — NÃO no volume_ok (true/false/null é decisão de reconciliação p/ o PR2, gravada no
// marcador pela RPC): gatear a cadência por volume_ok travava o completo num run de baixo volume/vazio (Codex
// v3.2 P1). Erro → não avança → o próximo ciclo re-tenta o completo (fail-closed real — Codex P1 #3).
// Aloca o FENCING TOKEN (ordem de INÍCIO da coleta) ANTES da 1ª página. É a chave de ordem total da publicação:
// um coletor que começa antes tem token MENOR mesmo publicando depois → não suprime o sinal de um mais novo
// (Codex v3.3 P1). Falha na alocação → null → o run NÃO publica (fail-closed: sem token não há ordem confiável).
async function alocarRunSeq(supabase: SupabaseClient, empresa: Empresa): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("reposicao_alocar_run_seq");
    if (error) throw error;
    const seq = Number(data);
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error(`seq inválido: ${JSON.stringify(data)}`);
    return seq;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] alocarRunSeq FALHOU empresa=${empresa}: ${msg} — run não publicará (fail-closed)`);
    return null;
  }
}

async function publicarRunCompleto(
  supabase: SupabaseClient,
  s: EmpresaSummary,
  idsVistos: Set<number>,
  runSeq: number,
): Promise<boolean> {
  const runId = crypto.randomUUID();
  const ids = [...idsVistos];
  try {
    const { data, error } = await supabase.rpc("reposicao_publicar_run_completo", {
      p_empresa: s.empresa,
      p_run_id: runId,
      p_seq: runSeq, // fencing token de INÍCIO da coleta (alocado ANTES da 1ª página)
      p_janela_de: s.janela_de,
      p_janela_ate: s.janela_ate,
      p_ids: ids,
    });
    if (error) throw error;
    const volumeOk = (data ?? null) as boolean | null; // gravado no marcador p/ o PR2 (NÃO gateia a cadência)
    console.log(
      `[sync-pedidos] publicou run empresa=${s.empresa} run_id=${runId} ids=${ids.length} volume_ok=${JSON.stringify(volumeOk)}`,
    );
    return true; // publicou (marcador gravado) — a cadência pode avançar independentemente do volume_ok
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] publicarRunCompleto FALHOU empresa=${s.empresa}: ${msg} — cadência NÃO avança`);
    return false; // erro = publicação falhou → cadência não avança, o próximo ciclo re-tenta o completo
  }
}

// ===== Handler =====
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let body: RequestBody = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  const empresaParam = (body.empresa ?? "ALL").toUpperCase() as "OBEN" | "COLACOR" | "ALL";
  const dias = typeof body.dias === "number" && body.dias > 0 ? body.dias : 30;
  const fornecedorCodigo = body.fornecedor_codigo_omie;
  // O omie-cron-diario chama a edge filha via service_role e sinaliza o caminho cron pelo BODY (trigger:
  // "cron") — NÃO repassa x-cron-secret. Detectar cron por header AQUI não funcionava (bug latente do #1081).
  // NÃO basear em mera PRESENÇA de x-cron-secret (não-validado): isCron só decide MODO+label, não autoriza
  // (a auth é a authorizeCronOrStaff acima). (Codex challenge 2026-06-26.)
  const isCron = body.trigger === "cron";
  const modoExplicito: ModoSyncPedidos | null =
    body.modo === "incremental" || body.modo === "completo" ? body.modo : null;

  const empresas: Empresa[] =
    empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam as Empresa];

  // Heartbeat do Sentinela só em sync ABRANGENTE (sem fornecedor específico) — investigação manual
  // filtrada por fornecedor não representa o frescor geral e não deve sobrescrever o marcador do cron.
  const gravaHeartbeat = !fornecedorCodigo;
  const triggerLabel = isCron ? "cron" : "manual";

  console.log(
    `[sync-pedidos] início empresas=${empresas.join(",")} trigger=${triggerLabel} modo=${modoExplicito ?? "auto"} dias=${dias} fornecedor=${fornecedorCodigo ?? "todos"}`,
  );

  // Trabalho real (loop de empresas) — SÍNCRONO de propósito. O omie-cron-diario aborta o fetch em 25s, mas
  // a edge segue server-side até terminar (medido ~90s incremental / ~185s completo; teto do worker ~400s) e
  // cada upsert de página é commitado (provado em prod 2026-06-26). NÃO usar waitUntil/202: responder cedo
  // soltaria os steps seguintes do orquestrador (nfes/ctes/sku) ANTES do espelho de pedidos existir → linhas
  // ÓRFÃS (omie-sync-nfes insertOrfa). O modo incremental encurta o background → MENOS sobreposição com esses
  // steps que ler purchase_orders_tracking (Codex challenge 2026-06-26).
  const processarTudo = async (): Promise<{ summary: EmpresaSummary[]; falhaTotalGeral: boolean }> => {
    const summary: EmpresaSummary[] = [];
    for (const empresa of empresas) {
      // Modo por empresa. Override explícito vence; senão: cron decide por last_full_at (incremental ×
      // completo, robusto a schedule — NÃO por hora); manual default = completo (reconcilia, Codex 2026-06-26).
      const lastFullAtMs = gravaHeartbeat ? await lerLastFullAt(supabase, empresa) : null;
      const modo: ModoSyncPedidos = modoExplicito ??
        (isCron && !deveRodarCompleto(lastFullAtMs, Date.now()) ? "incremental" : "completo");
      const meta = { trigger: triggerLabel, modo, dias };

      const idsVistos = new Set<number>(); // POs vistos neste run (publicados 1× no fim do completo limpo)
      // heartbeat ANTES do fencing token: qualquer await de REDE entre o token e a 1ª página alarga a janela em
      // que um run mais NOVO coleta e publica primeiro — aí o token velho deixa de refletir a ordem de início e
      // o PO excluído no meio fica com last_seen == marcador (não vira candidato, a prova por ID nunca roda e o
      // fantasma sobrevive). Codex #9 P1: o heartbeatRunning estava exatamente nessa janela.
      if (gravaHeartbeat) await heartbeatRunning(supabase, empresa, meta);
      // fencing token (ordem de INÍCIO da coleta) — alocado IMEDIATAMENTE antes de syncEmpresa, sem nenhum await
      // de rede no meio; só p/ o run que PODE publicar (completo não-filtrado). Ordena a publicação pela ordem de
      // INÍCIO, não de fim (Codex v3.3 P1: coletor que começa antes mas publica depois NÃO suprime um mais novo).
      // null = não-publicável ou alocação falhou → não publica (fail-closed).
      const podePublicarRun = modo === "completo" && !fornecedorCodigo;
      const runSeq = podePublicarRun ? await alocarRunSeq(supabase, empresa) : null;
      let s: EmpresaSummary;
      let errFatal: string | null = null;
      try {
        s = await syncEmpresa(supabase, empresa, modo, dias, fornecedorCodigo, idsVistos);
        console.log(
          `[sync-pedidos] empresa=${empresa} modo=${modo} TOTAL: paginas=${s.total_paginas} pedidos=${s.pedidos_sincronizados} erros=${s.erros} duracao=${Date.now() - t0}ms`,
        );
      } catch (err) {
        errFatal = err instanceof Error ? err.message : String(err);
        console.error(`[sync-pedidos] empresa=${empresa} erro fatal: ${errFatal}`);
        s = {
          empresa, total_paginas: 0, pedidos_sincronizados: 0, erros: 1,
          janela_de: null, janela_ate: null, ids_distintos: 0, varredura_completa: false,
        };
      }
      summary.push(s);
      if (gravaHeartbeat) await heartbeatFim(supabase, s, meta, errFatal);
      // Publicação diferida (v3): SÓ no fim de um completo cuja COLETA foi LIMPA e NÃO-filtrada (devePublicarRun:
      //   !fornecedorCodigo + completo + varredura_completa — NÃO checa erros: erro de PERSISTÊNCIA do espelho não
      //   corrompe idsVistos; erro de COLETA já zera varredura_completa). A RPC grava o marcador (sempre, p/ o
      //   baseline) e carimba last_seen SÓ se o run é VÁLIDO (volume_ok=true). A cadência do completo
      //   (marcarCompletoOk, marcador dedicado HEARTBEAT_FULL_ENTITY — imune a lost-update de incremental
      //   concorrente) avança se a PUBLICAÇÃO teve SUCESSO (não pelo volume_ok — senão baixo volume/vazio travaria
      //   o completo, Codex v3.2 P1); erro da RPC NÃO avança → o próximo ciclo re-tenta o completo (fail-closed).
      const runLimpoCompleto = devePublicarRun({
        modo, varreduraCompleta: s.varredura_completa, fornecedorCodigo,
      });
      if (runLimpoCompleto) {
        if (runSeq == null) {
          // run limpo mas sem fencing token (alocação falhou) → não publica nem avança a cadência: o próximo
          // ciclo re-tenta o completo (fail-closed — sem token não há ordem confiável de publicação).
          console.error(`[sync-pedidos] empresa=${empresa} run limpo mas SEM fencing token — não publica (cadência não avança)`);
        } else {
          const publicou = await publicarRunCompleto(supabase, s, idsVistos, runSeq);
          if (publicou) await marcarCompletoOk(supabase, empresa);
        }
      }
    }
    // Fail-CLOSED na coleta total: 0 sincronizados em TODAS as empresas + algum erro → 502 no caminho
    // síncrono (chamada manual/direta enxerga). Janela vazia legítima = 0 sinc + 0 erros → 200. ⚠️ No
    // caminho cron a detecção é o heartbeat sync_state (o omie-cron-diario mascara o status HTTP).
    const algumSucesso = summary.some((x) => x.pedidos_sincronizados > 0);
    const totalErros = summary.reduce((a, x) => a + x.erros, 0);
    return { summary, falhaTotalGeral: !algumSucesso && totalErros > 0 };
  };

  const responderSincrono = async (
    work: Promise<{ summary: EmpresaSummary[]; falhaTotalGeral: boolean }>,
  ): Promise<Response> => {
    try {
      const { summary, falhaTotalGeral } = await work;
      return new Response(
        JSON.stringify({ ok: !falhaTotalGeral, duracao_ms: Date.now() - t0, sayerlack: SAYERLACK, summary }),
        { status: falhaTotalGeral ? 502 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync-pedidos] erro fatal:", msg);
      return new Response(
        JSON.stringify({ ok: false, error: msg, duracao_ms: Date.now() - t0 }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  };

  return await responderSincrono(processarTudo());
});
