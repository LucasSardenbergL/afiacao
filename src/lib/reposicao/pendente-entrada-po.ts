// Reposição — "a caminho" (estoque_pendente_entrada) via FONTE ÚNICA: pedidos de compra do Omie.
// ============================================================================================
// DESENHO (Codex design consult 2026-06-11, "Opção A endurecida"): a QUANTIDADE de "a caminho" tem
// fonte ÚNICA = saldo (nQtde − nQtdeRec) somado por SKU sobre as POs abertas APROVADAS do Omie
// (app + manual). O em_transito da RPC é REMOVIDO (era qtde_final cheia, inclusive já-recebido →
// inconsistente com o saldo → overcount → ruptura; o adversarial do Codex bloqueou o "keep-both").
//
// Este helper é PURO e FAIL-CLOSED: classifica cada item e devolve, além do mapa por SKU, a lista de
// `problemas`. Se `problemas` não for vazio, a edge NÃO aplica o snapshot (mantém o anterior) — nunca
// grava valor parcial/duvidoso no money-path. Overcount é o pior caso, então número inválido
// (não-finito ou negativo) e etapa ABERTA desconhecida com saldo>0 abortam o apply.
//
// SEM de-dup (fonte única — não há em_transito pra colidir). A latência do recém-disparado é coberta
// FORA daqui, pela barreira fail-closed da RPC + bump only_pending no disparo (ver spec).

export interface PoItemOmie {
  /** sku_codigo_omie (nCodProd do Omie), como string. */
  sku: string;
  /** Número do pedido de compra no Omie (cNumero) — só p/ diagnóstico nas mensagens de problema. */
  poNumero: string;
  /** cEtapa do pedido (códigos CUSTOMIZÁVEIS por conta — OBEN: 15=Aprovado, 10=Em Aprovação). */
  etapa: string;
  /** nQtde do item. */
  qtde: number;
  /** nQtdeRec do item (recebido). */
  recebido: number;
}

export interface ComputeOnOrderOpts {
  /** Etapas que CONTAM (aprovado-e-aberto). OBEN: {"15"}. */
  etapasAprovadas: ReadonlySet<string>;
  /** Etapas não-comprometidas que se IGNORA sem alarme (em aprovação). OBEN: {"10"}. */
  etapasIgnoradas: ReadonlySet<string>;
}

export interface ComputeOnOrderResult {
  /** "a caminho" por SKU (saldo a receber somado). Só é aplicado se `problemas` for vazio. */
  porSku: Map<string, number>;
  /** Razões pra ABORTAR o apply (fail-closed). Vazio = seguro aplicar. */
  problemas: string[];
}

/** Item tem número de quantidade válido? (não-finito ou negativo = dado torto → fail-closed). */
export function quantidadesValidas(qtde: number, recebido: number): boolean {
  return Number.isFinite(qtde) && Number.isFinite(recebido) && qtde >= 0 && recebido >= 0;
}

/** Saldo a receber de um item válido (nunca negativo). Pré-condição: quantidadesValidas === true. */
export function saldoAReceber(qtde: number, recebido: number): number {
  return Math.max(0, qtde - recebido);
}

/**
 * Soma o "a caminho" (saldo a receber) por SKU sobre as POs abertas APROVADAS do Omie.
 * FAIL-CLOSED: número inválido ou etapa aberta desconhecida com saldo>0 entram em `problemas`
 * (a edge aborta o apply e mantém o snapshot anterior).
 */
export function computeOnOrder(
  items: readonly PoItemOmie[],
  opts: ComputeOnOrderOpts,
): ComputeOnOrderResult {
  const porSku = new Map<string, number>();
  const problemas: string[] = [];

  for (const item of items) {
    if (!quantidadesValidas(item.qtde, item.recebido)) {
      problemas.push(
        `quantidade inválida (sku=${item.sku} po=${item.poNumero} qtde=${item.qtde} recebido=${item.recebido})`,
      );
      continue;
    }
    const saldo = saldoAReceber(item.qtde, item.recebido);
    if (saldo <= 0) continue; // nada a receber (recebido total / pedido zerado)

    if (opts.etapasAprovadas.has(item.etapa)) {
      porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + saldo);
    } else if (opts.etapasIgnoradas.has(item.etapa)) {
      continue; // em aprovação / não-comprometido: não conta, sem alarme
    } else {
      // etapa ABERTA desconhecida COM saldo: não classificável → fail-closed (não chutar no money-path)
      problemas.push(`etapa aberta desconhecida com saldo (etapa=${item.etapa} sku=${item.sku} po=${item.poNumero})`);
    }
  }

  return { porSku, problemas };
}

// ============================================================================================
// COLETA / PAGINAÇÃO do PesquisarPedCompra (parsing PURO; a edge omie-sync-estoque espelha VERBATIM).
// A edge pagina ATÉ A PÁGINA VAZIA — o nTotalPaginas do Omie SUB-REPORTA em listas grandes (bug
// conhecido, já mordeu CR/CP em omie-financeiro → PO omitida = double-buy). Estas funções fazem o
// parsing de cada página, a detecção de fim (página vazia) e a de loop (Omie repetindo página).
// ============================================================================================

export interface OmiePedItemRaw { nCodProd?: number | string; nQtde?: number; nQtdeRec?: number; [k: string]: unknown; }
export interface OmiePedCabRaw { cNumero?: number | string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
export interface OmiePedConsultaRaw {
  cabecalho_consulta?: OmiePedCabRaw;
  cabecalho?: OmiePedCabRaw;
  produtos_consulta?: OmiePedItemRaw[];
  [k: string]: unknown;
}

export interface ColetaPaginaOpts {
  /** Etapas que CONTAM como aprovado-e-aberto. OBEN: {"15"}. */
  etapasAprovadas: ReadonlySet<string>;
  /** Se dado, só inclui itens de SKU habilitado (reduz volume; o motor só lê habilitados). */
  skusHabilitados?: ReadonlySet<string>;
}

export interface ColetaPaginaResult {
  /** Itens (já filtrados por habilitado, se opts.skusHabilitados) p/ alimentar computeOnOrder. */
  items: PoItemOmie[];
  /** cCodIntPed de POs etapa-APROVADA vistas (independe de saldo) — alimenta a barreira do passo 3. */
  codintsAprovados: string[];
  pedidosVistos: number;
  /** etapas distintas vistas (diagnóstico; o fail-closed REAL é no computeOnOrder, sobre os items). */
  etapasVistas: string[];
}

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Parsing PURO de uma página de PesquisarPedCompra. NÃO decide fail-closed (isso é do computeOnOrder,
 * que recebe os items). Coleta os itens (filtrando por habilitado, se dado) e os cCodIntPed das POs
 * etapa-aprovada. A edge ACUMULA o resultado de todas as páginas e chama computeOnOrder UMA vez no fim.
 */
export function coletarDaPagina(
  pedidos: readonly OmiePedConsultaRaw[] | undefined,
  opts: ColetaPaginaOpts,
): ColetaPaginaResult {
  const items: PoItemOmie[] = [];
  const codints: string[] = [];
  const etapasVistas = new Set<string>();
  const lista = pedidos ?? [];
  for (const ped of lista) {
    const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
    const etapa = norm(cab.cEtapa);
    const cNumero = norm(cab.cNumero);
    const cCodIntPed = norm(cab.cCodIntPed);
    if (etapa) etapasVistas.add(etapa);
    if (opts.etapasAprovadas.has(etapa) && cCodIntPed) codints.push(cCodIntPed);
    for (const it of ped?.produtos_consulta ?? []) {
      const sku = norm(it.nCodProd);
      if (!sku) continue;
      if (opts.skusHabilitados && !opts.skusHabilitados.has(sku)) continue;
      items.push({
        sku,
        poNumero: cNumero,
        etapa,
        qtde: Number(it.nQtde ?? 0),
        recebido: Number(it.nQtdeRec ?? 0),
      });
    }
  }
  return { items, codintsAprovados: codints, pedidosVistos: lista.length, etapasVistas: [...etapasVistas] };
}

/** Página sem pedidos = FIM da paginação (paginar até aqui; NÃO confiar em nTotalPaginas). */
export function paginaVazia(pedidos: readonly OmiePedConsultaRaw[] | undefined): boolean {
  return !pedidos || pedidos.length === 0;
}

/**
 * Fingerprint barato de uma página (anti-loop). Se o Omie devolve a MESMA página não-vazia 2× seguidas
 * (em vez de avançar ou devolver vazia), é loop → a edge aborta (FATAL, não silencioso). Vazia → "".
 */
export function fingerprintPagina(pedidos: readonly OmiePedConsultaRaw[] | undefined): string {
  const peds = pedidos ?? [];
  if (peds.length === 0) return "";
  const prim = peds[0]?.cabecalho_consulta ?? peds[0]?.cabecalho ?? {};
  const ult = peds[peds.length - 1]?.cabecalho_consulta ?? peds[peds.length - 1]?.cabecalho ?? {};
  return `${peds.length}:${norm(prim.cNumero)}:${norm(ult.cNumero)}`;
}

/**
 * cCodInts esperados (AFI-<id> recém-disparados) que NÃO apareceram nos vistos. Vazio = todos vistos
 * (snapshot reflete os disparos). Usado pelo modo {only_pending, esperar_codints} do bump no disparo.
 */
export function codintsFaltantes(esperados: readonly string[], vistos: readonly string[]): string[] {
  const set = new Set(vistos.map((v) => v.trim()).filter(Boolean));
  const out: string[] = [];
  for (const e of esperados) {
    const k = (e ?? "").trim();
    if (k && !set.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export interface PaginaPedidos { pedidos?: OmiePedConsultaRaw[]; faultstring?: string; }
export interface VarrerPedidosOpts {
  etapasAprovadas: ReadonlySet<string>;
  skusHabilitados?: ReadonlySet<string>;
  /** Teto técnico FATAL anti-loop (se atinge sem ver página vazia, aborta). */
  maxPaginas: number;
}
export interface VarrerPedidosResult {
  items: PoItemOmie[];
  codintsAprovados: string[];
  etapasVistas: string[];
  pedidosVistos: number;
  paginasLidas: number;
}

/**
 * faults do Omie que significam "fim legítimo" (sem registros), NÃO erro. Conservadora de propósito:
 * exige negação + verbo-de-existência + "registros" próximos (OU "sem/nenhum registro" / "not found").
 * Money-path: preferimos FALSO-NEGATIVO (fault não-reconhecido → throw → sync falha, Sentinela pega) a
 * FALSO-POSITIVO (erro tratado como fim → paginação para cedo → PO perdida → double-buy). O sinal
 * PRIMÁRIO de fim é a página VAZIA (paginaVazia); este fault é o caminho secundário.
 */
const FIM_SEM_REGISTROS =
  /(not\s*found|sem\s+registros?\b|nenhum\s+registro|n[ãa]o\s+(existem?|h[áa]|foram|foi|possui|cont[ée]m|retornou)\b.{0,30}\bregistros?\b)/i;

/**
 * Loop PURO de paginação do PesquisarPedCompra (o `fetchPagina` é injetado → testável sem rede/timers;
 * a edge passa um fetcher que faz callOmiePedidos + sleep de rate-limit). Pagina ATÉ A PÁGINA VAZIA
 * (NÃO confia em nTotalPaginas — o Omie sub-reporta). FATAL (lança) em: página repetida (loop do Omie),
 * teto técnico atingido sem fim (anti-truncamento), ou fault que NÃO seja "sem registros". Acumula
 * items/codints/etapas de todas as páginas; o caller deriva o porSku com computeOnOrder.
 */
export async function varrerPedidos(
  fetchPagina: (pagina: number) => Promise<PaginaPedidos>,
  opts: VarrerPedidosOpts,
): Promise<VarrerPedidosResult> {
  const items: PoItemOmie[] = [];
  const codints = new Set<string>();
  const etapas = new Set<string>();
  let pedidosVistos = 0;
  let paginasLidas = 0;
  let fpAnterior = "";
  let fim = false;

  for (let pagina = 1; pagina <= opts.maxPaginas; pagina++) {
    const resp = await fetchPagina(pagina);
    if (resp.faultstring) {
      if (FIM_SEM_REGISTROS.test(resp.faultstring)) { fim = true; break; }
      throw new Error(`PesquisarPedCompra fault: ${resp.faultstring}`);
    }
    const pedidos = resp.pedidos ?? [];
    if (paginaVazia(pedidos)) { fim = true; break; } // FIM real = página vazia

    const fp = fingerprintPagina(pedidos);
    if (fp !== "" && fp === fpAnterior) {
      throw new Error(`PesquisarPedCompra LOOP (pág ${pagina} idêntica à anterior; fp=${fp}) — abortando p/ não double-buy`);
    }
    fpAnterior = fp;
    paginasLidas++;

    const c = coletarDaPagina(pedidos, { etapasAprovadas: opts.etapasAprovadas, skusHabilitados: opts.skusHabilitados });
    for (const it of c.items) items.push(it);
    for (const cc of c.codintsAprovados) codints.add(cc);
    for (const e of c.etapasVistas) etapas.add(e);
    pedidosVistos += c.pedidosVistos;
  }

  if (!fim) {
    throw new Error(`PesquisarPedCompra excedeu ${opts.maxPaginas} páginas sem ver fim — abortando (anti-truncamento)`);
  }
  return { items, codintsAprovados: [...codints], etapasVistas: [...etapas], pedidosVistos, paginasLidas };
}
