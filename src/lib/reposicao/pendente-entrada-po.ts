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

/**
 * [P2 round6/7] Parse ESTRITO de quantidade do Omie. `Number()` mascara dado torto: `""`/`" "`/`false`/`[]`→0,
 * `[5]`→5, `"0x10"`→16, `"1e3"`→1000 — e um `nQtdeRec` mascarado como 0 conta saldo CHEIO = RUPTURA. Aqui: number
 * finito passa; string SÓ no formato DECIMAL (`5`/`5.5`/`-5`/`.5`, via regex — rejeita ""/" "/hex/binário/
 * científico/`abc`); boolean/array/objeto/undefined/null → NaN. NaN → o caller (quantidadesValidas/computeOnOrder)
 * marca `problema` → abort. (nQtdeRec ausente=nada recebido é tratado por parseRecebido, NÃO aqui.)
 */
export function parseQtd(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN; // boolean, array, objeto, undefined, null
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN; // só decimal (rejeita ''/' '/0x10/1e3/abc)
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * [P1 round7] Parse do RECEBIDO (nQtdeRec). AUSENTE (undefined) = nada recebido → 0 (normal: o Omie omite). Mas
 * `null` EXPLÍCITO (ou qualquer valor inválido) → NaN → flag: tratar `null` como 0 num item PARCIALMENTE recebido
 * contaria saldo cheio = overcount → RUPTURA. Só undefined vira 0; null/""/inválido vira NaN.
 */
export function parseRecebido(v: unknown): number {
  return v === undefined ? 0 : parseQtd(v);
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

export interface OmiePedItemRaw { nCodProd?: number | string; nQtde?: number | null; nQtdeRec?: number | null; [k: string]: unknown; }
export interface OmiePedCabRaw { nCodPed?: number | string; cNumero?: number | string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
export interface OmiePedConsultaRaw {
  cabecalho_consulta?: OmiePedCabRaw;
  cabecalho?: OmiePedCabRaw;
  produtos_consulta?: OmiePedItemRaw[];
  [k: string]: unknown;
}

export interface ColetaPaginaOpts {
  /** Etapas que CONTAM como aprovado-e-aberto. OBEN: {"15"}. */
  etapasAprovadas: ReadonlySet<string>;
  /** Etapas EM APROVAÇÃO (não-comprometidas; não contam saldo). OBEN: {"10"}. Alimentam codintsEmAprovacao. */
  etapasEmAprovacao?: ReadonlySet<string>;
  /** Se dado, só inclui itens de SKU habilitado (reduz volume; o motor só lê habilitados). */
  skusHabilitados?: ReadonlySet<string>;
}

export interface ColetaPaginaResult {
  /** Itens (já filtrados por habilitado, se opts.skusHabilitados) p/ alimentar computeOnOrder. */
  items: PoItemOmie[];
  /** cCodIntPed de POs etapa-APROVADA COM itens (independe de saldo) — alimenta a barreira (3a) do passo 3. */
  codintsAprovados: string[];
  /** cCodIntPed de POs EM APROVAÇÃO (etapa-10) — a barreira (3b) aborta enquanto a PO do app não virar etapa-15. */
  codintsEmAprovacao: string[];
  pedidosVistos: number;
  /** etapas distintas vistas (diagnóstico; o fail-closed REAL é no computeOnOrder, sobre os items). */
  etapasVistas: string[];
  /** [P1 round7/9/10] aliases de identidade das POs desta página: `id:<nCodPed>` CANÔNICO (obrigatório em toda PO)
   *  + `numero:<cNumero>` secundário — p/ o varrerPedidos detectar PO REPETIDA entre páginas (bate em qualquer alias). */
  numerosVistos: string[];
  /** Razões fail-closed detectadas na COLETA (ex.: PO aprovada sem item com SKU = resposta suspeita). */
  problemas: string[];
}

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Parsing PURO de uma página de PesquisarPedCompra. Coleta os itens (filtrando por habilitado, se dado),
 * os cCodIntPed das POs etapa-aprovada (P1.1: SÓ se a PO tem ≥1 item com SKU — uma PO aprovada sem item é
 * resposta truncada/suspeita → `problemas` fail-closed, e o codint NÃO entra; senão a barreira passaria
 * com saldo zero = double-buy), e os cCodIntPed das POs em APROVAÇÃO (P1.2 / barreira 3b). A edge ACUMULA
 * o resultado de todas as páginas; `problemas` (daqui + do computeOnOrder) não-vazio ⇒ a edge NÃO aplica.
 */
export function coletarDaPagina(
  pedidos: readonly OmiePedConsultaRaw[] | undefined,
  opts: ColetaPaginaOpts,
): ColetaPaginaResult {
  const items: PoItemOmie[] = [];
  const codintsAprovados: string[] = [];
  const codintsEmAprovacao: string[] = [];
  const etapasVistas = new Set<string>();
  const numerosVistos: string[] = [];
  const problemas: string[] = [];
  const lista = pedidos ?? [];
  for (const ped of lista) {
    const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
    const etapa = norm(cab.cEtapa);
    const cNumero = norm(cab.cNumero);
    const cCodIntPed = norm(cab.cCodIntPed);
    if (etapa) etapasVistas.add(etapa);
    // [P1 round8/9/10] identidade da PO p/ de-dup entre páginas. O de-dup precisa de uma chave CANÔNICA presente
    // em TODA aparição da PO. Aceitar "id OU numero" (round9) ainda deixava escapar OMISSÕES COMPLEMENTARES: a
    // MESMA PO vindo só com nCodPed numa página (alias id:A) e só com cNumero noutra (alias numero:N) → chaves
    // DISJUNTAS → sem colisão → soma dupla → overcount → ruptura (Codex round10). nCodPed é o ID interno do Omie
    // (PK da PO, não muda A→B). [round10] EXIGIR nCodPed em TODA PO → toda aparição compartilha `id:<nCodPed>` →
    // o de-dup sempre pega. PO sem nCodPed → fail-closed (a edge não aplica; halt LOUD > overcount silencioso).
    // `numero:<cNumero>` entra como alias SECUNDÁRIO (cobertura extra; colisão de cNumero entre POs distintas =
    // abort = seguro). Prefixo evita colisão entre um nCodPed e um cNumero de mesmo valor.
    const nCodPed = norm(cab.nCodPed);
    if (!nCodPed) {
      problemas.push(`PO sem nCodPed (ID interno) — sem chave canônica p/ de-dup entre páginas → fail-closed (etapa=${etapa}, cNumero=${cNumero || "—"})`);
    } else {
      numerosVistos.push(`id:${nCodPed}`);
      if (cNumero) numerosVistos.push(`numero:${cNumero}`);
    }

    // [novo furo Codex] uma etapa CONTA o saldo se não é "em aprovação" (aprovada OU desconhecida). Um item
    // SEM nCodProd numa etapa que conta, COM saldo>0, teria seu saldo OMITIDO silenciosamente (subcontagem →
    // double-buy). Detecta e marca `problema` (fail-closed → a edge não aplica). Em etapa em-aprovação o item
    // não contaria de qualquer forma → ignora.
    const etapaConta = !opts.etapasEmAprovacao?.has(etapa);
    // processa os itens primeiro; conta os que têm SKU (independe de habilitado).
    let itensComSku = 0;
    let itemSemSkuComSaldo = false;
    for (const it of ped?.produtos_consulta ?? []) {
      const sku = norm(it.nCodProd);
      if (!sku) {
        // [P2 round4/5] item sem nCodProd numa etapa que conta: anômalo se a qty/recebido é INVÁLIDA (ausente,
        // NaN, Infinity ou negativa → saldo DESCONHECIDO, pode estar truncado junto com o nCodProd) OU se o saldo
        // é >0. quantidadesValidas cobre q E r (round5 — antes só checava q; r=NaN/Inf ou q<0 escapava). Só ignora
        // quando AMBAS são finitas/não-negativas E o saldo ≤ 0 (linha vazia/zerada genuína). Fail-closed → aborta.
        if (etapaConta) {
          // [round6/7] parseQtd estrito (q: ausente/null/inválido→NaN); parseRecebido (r: SÓ undefined→0, null→NaN→flag).
          const q = parseQtd(it.nQtde), r = parseRecebido(it.nQtdeRec);
          if (!quantidadesValidas(q, r) || (q - r) > 0) itemSemSkuComSaldo = true;
        }
        continue;
      }
      itensComSku++;
      if (opts.skusHabilitados && !opts.skusHabilitados.has(sku)) continue;
      // [P1-E] nQtde AUSENTE (undefined/null) ⇒ NaN ⇒ computeOnOrder marca `problema` ⇒ abort apply.
      // Todo item de PO tem quantidade pedida; ausência = resposta anômala/truncada → fail-closed (não
      // virar 0 silencioso, que sumiria o saldo da PO = subcontagem do "a caminho" gravada). nQtdeRec
      // ausente é NORMAL (Omie omite quando nada recebido) → parseRecebido devolve 0. [round6/7] parseQtd/parseRecebido
      // estritos: ""/" "/false/array/hex/null → NaN (Number() mascararia como 0/coerção; nQtdeRec null/""→0 = ruptura).
      items.push({
        sku,
        poNumero: cNumero,
        etapa,
        qtde: parseQtd(it.nQtde),
        recebido: parseRecebido(it.nQtdeRec),
      });
    }

    // [novo furo] item sem nCodProd com saldo>0 numa etapa que conta → fail-closed em QUALQUER caso (saldo omitido).
    if (etapaConta && itemSemSkuComSaldo) {
      problemas.push(`PO com item SEM nCodProd e saldo>0 (po=${cNumero} etapa=${etapa}) — saldo seria omitido`);
    }

    if (opts.etapasAprovadas.has(etapa)) {
      // [P1.1] PO aprovada SEM item com SKU = resposta truncada/anômala → fail-closed (o saldo dela se perderia
      // e, se tiver codint, a barreira passaria com pendente 0 → double-buy). NÃO coleta o codint.
      if (itensComSku === 0) {
        problemas.push(`PO aprovada sem item com SKU (po=${cNumero} codint=${cCodIntPed || "manual"})`);
      } else if (cCodIntPed) {
        codintsAprovados.push(cCodIntPed);
      }
    } else if (opts.etapasEmAprovacao?.has(etapa) && cCodIntPed) {
      // [P1.2] PO do app em APROVAÇÃO (não conta saldo, mas existe no Omie) → a barreira (3b) aborta a geração
      // enquanto a PO não virar etapa-15 (sem janela de tempo).
      codintsEmAprovacao.push(cCodIntPed);
    }
    // etapa aberta DESCONHECIDA (nem aprovada nem em-aprovação): o computeOnOrder pega via items (saldo>0 → problema).
  }
  return {
    items, codintsAprovados, codintsEmAprovacao, pedidosVistos: lista.length,
    etapasVistas: [...etapasVistas], numerosVistos, problemas,
  };
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
  etapasEmAprovacao?: ReadonlySet<string>;
  skusHabilitados?: ReadonlySet<string>;
  /** Teto técnico FATAL anti-loop (se atinge sem ver página vazia, aborta). */
  maxPaginas: number;
}
export interface VarrerPedidosResult {
  items: PoItemOmie[];
  codintsAprovados: string[];
  codintsEmAprovacao: string[];
  etapasVistas: string[];
  pedidosVistos: number;
  paginasLidas: number;
  /** Razões fail-closed acumuladas das páginas (coletarDaPagina). Não-vazio ⇒ a edge NÃO aplica. */
  problemas: string[];
}

/**
 * faults do Omie que significam "fim legítimo" (sem registros), NÃO erro. Conservadora de propósito:
 * exige a palavra "registro(s)" colada a uma negação de EXISTÊNCIA específica. [P1.7] o "not found"
 * SOLTO foi REMOVIDO (casava "Produto not found"). [P1-D] os verbos GENÉRICOS `foi|foram(bare)|possui|
 * cont[ée]m|retornou` foram REMOVIDOS — casavam ERROS reais como "Não foi possível retornar registros"
 * (verbo=foi) → pararia a paginação cedo = PO perdida = double-buy. Só ficam negações inequívocas de
 * existência: `não existe(m)`, `não há`, `não foram encontrados`, `registros não encontrados/existem`,
 * `sem registros`, `nenhum registro` (a fault canônica do Omie nessas listagens é "Não existem registros
 * para a página informada."). Money-path: FALSO-NEGATIVO (fault não-reconhecido → throw → Sentinela pega)
 * é preferível a FALSO-POSITIVO (erro tratado como fim → para cedo → PO perdida → double-buy). O sinal
 * PRIMÁRIO de fim é a página VAZIA (paginaVazia); este fault é o caminho secundário.
 */
// [P2-D] o `\b` após `h[áa]` falhava no regex JS (á não é `\w`) → "Não há registros" não casava. [P2-D round3]
// o `.{0,30}?` entre o verbo e "registros" ABRIA over-match ("Não há PERMISSÃO PARA ACESSAR registros" = ERRO
// virava fim → para cedo → double-buy). Fix: exige "registros" ADJACENTE ao verbo (`\s+registros`), sem palavras
// entre. A fault canônica do Omie é "Não existem registros para a página informada" (registros logo após existem).
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;

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
  const codintsAprovados = new Set<string>();
  const codintsEmAprovacao = new Set<string>();
  const etapas = new Set<string>();
  const problemas: string[] = [];
  let pedidosVistos = 0;
  let paginasLidas = 0;
  // [P1.7] rastreia TODOS os fingerprints vistos (não só o anterior): pega repetição NÃO-consecutiva
  // (A/B/A/vazia somaria A duas vezes = overcount → ruptura).
  const fpsVistos = new Set<string>();
  // [P1 round7/9/10] aliases de identidade de PO (`id:<nCodPed>` canônico + `numero:<cNumero>` secundário) vistas
  // GLOBALMENTE: pega a MESMA PO repetida entre páginas DISTINTAS (insert/remove durante a paginação por offset
  // desloca a janela → uma PO reaparece → itens somados 2× → overcount → ruptura). O fingerprint de página só pega
  // página INTEIRA repetida, não a sobreposição parcial. Exigir `nCodPed` em toda PO garante a chave canônica
  // compartilhada em TODA aparição (round10: "id OU numero" escapava em omissões complementares).
  const numerosGlobais = new Set<string>();
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
    if (fp !== "" && fpsVistos.has(fp)) {
      throw new Error(`PesquisarPedCompra REPETIÇÃO de página (pág ${pagina} fp=${fp} já vista) — abortando p/ não overcount/double-buy`);
    }
    fpsVistos.add(fp);
    paginasLidas++;

    const c = coletarDaPagina(pedidos, {
      etapasAprovadas: opts.etapasAprovadas,
      etapasEmAprovacao: opts.etapasEmAprovacao,
      skusHabilitados: opts.skusHabilitados,
    });
    // [P1 round7/9] PO (qualquer alias de identidade) já vista em página anterior = sobreposição por shift de
    // paginação → FATAL (não somar 2×).
    for (const alias of c.numerosVistos) {
      if (numerosGlobais.has(alias)) {
        throw new Error(`PesquisarPedCompra PO REPETIDA entre páginas (identidade ${alias} na pág ${pagina} já vista) — abortando p/ não overcount/double-buy`);
      }
      numerosGlobais.add(alias);
    }
    for (const it of c.items) items.push(it);
    for (const cc of c.codintsAprovados) codintsAprovados.add(cc);
    for (const cc of c.codintsEmAprovacao) codintsEmAprovacao.add(cc);
    for (const e of c.etapasVistas) etapas.add(e);
    for (const p of c.problemas) problemas.push(p);
    pedidosVistos += c.pedidosVistos;
  }

  if (!fim) {
    throw new Error(`PesquisarPedCompra excedeu ${opts.maxPaginas} páginas sem ver fim — abortando (anti-truncamento)`);
  }
  return {
    items, codintsAprovados: [...codintsAprovados], codintsEmAprovacao: [...codintsEmAprovacao],
    etapasVistas: [...etapas], pedidosVistos, paginasLidas, problemas,
  };
}
