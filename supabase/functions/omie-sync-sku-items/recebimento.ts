// A gravação de UM recebimento (ConsultarRecebimento → sku_leadtime_history) e a regra da fila do
// `omie-sync-sku-items`. Sem I/O próprio: o banco entra por `DepsGravacao` — a edge injeta o
// supabase, o teste (recebimento_test.ts, Deno `--no-remote`) injeta um banco falso com o mesmo
// contrato do PostgREST.
//
// ── Por que existe (2026-10-05; docs/historico/sku-items-pendencia-por-item.md) ─────────────────
// A fila era "tracking SEM NENHUMA linha em sku_leadtime_history": bastava UMA linha gravada para o
// recebimento sair da fila para sempre, e o que faltava nunca voltava. O P1 do Codex apontou a falha
// de upsert (2 SKUs, 1 grava, 1 falha) — medido: 0 casos em 1.287 runs. O que de fato mordeu foi o
// ITEM SEM nIdProduto no instante da consulta (associação pendente no recebimento da Omie: produto a
// criar na conclusão, ou ainda não associado), pulado em silêncio por `if (!skuCodigoOmie) continue`:
// 2 SKUs perdidos em 63 recebimentos medidos, um deles o 1º recebimento de um produto novo.
//
// ── O contrato ───────────────────────────────────────────────────────────────────────────────────
// · A UNIDADE é o recebimento (nIdReceb), não o tracking. O estado do controle (tentativas, carimbo,
//   motivo, `itens_pendentes`) é gravado em TODAS as irmãs — linhas de purchase_orders_tracking que
//   dividem o recebimento —, para a dona não levar a pendência consigo ao sair da janela e para as
//   irmãs dividirem o mesmo backoff (achado do Codex no desenho).
// · `itens_pendentes` conta ITENS da última lista observada sem linha gravada: aguardando associação
//   + sem rota de pedido (lookup falhou) + retidos por contaminação + itens de grupos cujo upsert
//   falhou. NULL = não medido (legado, ou resposta sem lista). Ignorado (`cIgnorarItem`="S" sem
//   produto) é terminal e não conta. A garantia é a completude da ÚLTIMA lista observada — não a
//   definitiva do recebimento: um item ignorado que depois for associado não é visto.
// · WRITE-AHEAD: antes do 1º upsert, o controle recebe a pendência conservadora (como se nada
//   gravasse); se essa escrita falhar, nada é gravado. O fechamento reduz a pendência com CAS no
//   carimbo (`ultima_tentativa`): uma resposta antiga que termine depois de uma nova não a sobrescreve.
//   Fechamento que falha deixa a pendência conservadora — volta à fila, nunca some.
// · DONO ESTÁVEL: o item sem pedido casado cai na irmã de menor (t2, id) entre TODAS as irmãs, e as
//   datas da linha (t2/t3/t4, t1 do fallback) são as dela. Antes caía na ELEITA do run, que muda
//   entre runs: a reconsulta gravava o mesmo item sob outra chave, e a view efetiva (colapso
//   "concorda-ou-NULL" por NF-e/SKU) zerava a observação.
// · PROVENIÊNCIA: lt_bruto/lt_faturamento só com t1 de PEDIDO. O t1 do fallback é o faturamento, e o
//   recompute (`leadtime_t1_e_data_de_pedido`) o anula — mas roda ANTES dos upserts, então cada
//   regravação republicava o valor fabricado até o run seguinte (achado do Codex). O caso legítimo
//   de pedido faturado no mesmo dia o recompute preenche depois.

import { motivoDaTentativa } from "./adiamento.ts";
import type { OmieRecebimentoItem } from "./consulta.ts";

// ── Classificação do item ────────────────────────────────────────────────────────────────────────

export type ClasseItem =
  | { tipo: "ignorado" }
  | { tipo: "aguardando_associacao" }
  | { tipo: "resolvido"; sku: number; pedido: string | null };

/**
 * O que um item da resposta é para o leadtime. A ordem das regras preserva o que a edge já gravava:
 *   1. `nIdProduto` válido (a MESMA regra de antes: `toNum` verdadeiro) → resolvido, mesmo que o item
 *      esteja marcado para ignorar — deixar de gravar o que se gravava não é objeto desta correção;
 *   2. sem produto e `cIgnorarItem` = "S" → ignorado: nunca vira SKU, é terminal;
 *   3. sem produto e não ignorado → aguardando associação: vira SKU quando o recebimento o associar
 *      (medido: 19 itens `cAdicionarNovo`="S" sem produto, todos na etapa 40 — em andamento).
 */
export function classificarItem(item: OmieRecebimentoItem): ClasseItem {
  const cab = item?.itensCabec ?? {};
  const sku = toNum(cab?.nIdProduto);
  if (sku) {
    const pedido = toStr(item?.itensInfoAdic?.nNumPedCompra);
    return { tipo: "resolvido", sku, pedido: pedido && pedido !== "0" ? pedido : null };
  }
  if (cab?.cIgnorarItem === "S") return { tipo: "ignorado" };
  return { tipo: "aguardando_associacao" };
}

// ── A fila ───────────────────────────────────────────────────────────────────────────────────────

export interface ControleFila {
  tentativas: number;
  ultima_tentativa: string | null;
  /** NULL = não medido pela regra por item (legado ou resposta sem lista). */
  itens_pendentes: number | null;
}

/**
 * O tracking está pendente (entra na fila, sujeito ao backoff)?
 *   · MEDIDO (`itens_pendentes` não nulo): decide SÓ a pendência — k>0 volta à fila mesmo com linha
 *     gravada (o defeito); k=0 sai mesmo sem linha (irmã a quem nenhum item foi roteado, recebimento
 *     só de ignorados). Sem a 2ª metade, com o dono estável a irmã sem linha viraria poison eterno:
 *     reconsultar por ela nunca grava nada nela.
 *   · LEGADO (nunca medido): a regra antiga, "sem linha". Tratar legado como pendente reconsultaria
 *     toda a janela de uma vez — rajada que o guard de 50s não absorve e o sensor leria como fila parada.
 */
export function pendenteNaFila(controle: ControleFila | undefined, temLinha: boolean): boolean {
  const k = controle?.itens_pendentes;
  if (typeof k === "number" && Number.isFinite(k)) return k > 0;
  return !temLinha;
}

// ── As irmãs e o dono ────────────────────────────────────────────────────────────────────────────

/** Uma linha de purchase_orders_tracking do recebimento (mesma `nid_receb`), dentro ou fora da janela. */
export interface Irma {
  id: string;
  t1_data_pedido: string | null;
  t2_data_faturamento: string | null;
  t3_data_cte: string | null;
  t4_data_recebimento: string | null;
  fornecedor_codigo_omie: number | null;
  fornecedor_nome: string | null;
}

/**
 * A irmã que recebe os itens sem pedido casado e dá as datas das linhas: a de menor t2 (nulo por
 * último), desempate por id. Independe de quem foi ELEITA no run e da janela de `dias` — a eleita
 * muda entre runs (outra irmã sem linha, a dona antiga fora da janela) e com ela mudava a chave da
 * linha. Para o recebimento novo coincide com a eleita de antes (todas com 0 tentativas, t2 ASC).
 */
export function donoDoRecebimento(irmas: readonly Irma[]): Irma {
  if (irmas.length === 0) throw new Error("donoDoRecebimento: recebimento sem nenhuma linha de tracking");
  let dono = irmas[0];
  for (const irma of irmas.slice(1)) {
    if (antes(irma, dono)) dono = irma;
  }
  return dono;
}

function antes(a: Irma, b: Irma): boolean {
  const ta = a.t2_data_faturamento ? Date.parse(a.t2_data_faturamento) : NaN;
  const tb = b.t2_data_faturamento ? Date.parse(b.t2_data_faturamento) : NaN;
  const aTem = Number.isFinite(ta);
  const bTem = Number.isFinite(tb);
  if (aTem !== bTem) return aTem;
  if (aTem && bTem && ta !== tb) return ta < tb;
  return a.id < b.id;
}

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

// ── A gravação ───────────────────────────────────────────────────────────────────────────────────

/** O pedido de compra casado por `nNumPedCompra` → `numero_contrato_fornecedor`. */
export interface PedidoCasado {
  id: string;
  t1_data_pedido: string;
  grupo_leadtime: string | null;
  fornecedor_nome: string | null;
}

/** A linha de sku_leadtime_history, como a edge a upserta (onConflict tracking_id,sku_codigo_omie). */
export interface LinhaLeadtime {
  tracking_id: string;
  empresa: string;
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
  t2_data_faturamento: string;
  t3_data_cte: string | null;
  t4_data_recebimento: string | null;
  lt_bruto_dias_uteis: number | null;
  lt_faturamento_dias_uteis: number | null;
  lt_logistica_dias_uteis: number | null;
  updated_at: string;
}

/** O que se grava no controle de cada irmã. Sem `itens_pendentes` = não toca a pendência medida. */
export interface EstadoControle {
  tentativas: number;
  ultima_tentativa: string;
  motivo: string;
  itens_pendentes?: number;
}

type BuscaPedido = { ok: true; pedido: PedidoCasado | null } | { ok: false; erro: string };
type Fechamento = { ok: true; atualizadas: number } | { ok: false; erro: string };

/** O banco, injetado. Nenhum método lança: falha volta no retorno (o contrato que a edge implementa). */
export interface DepsGravacao {
  /** Pedido por (fornecedor, número), com ordem TOTAL (o mesmo número pode casar mais de uma linha). */
  buscarPedido(fornecedor: number | null, numero: string): Promise<BuscaPedido>;
  /** Upsert de UMA linha; `null` = gravou, string = a mensagem do erro. */
  gravarLinha(linha: LinhaLeadtime): Promise<string | null>;
  /** Upsert do controle nas irmãs (um statement); só as colunas do payload são atualizadas. */
  marcarControle(ids: readonly string[], estado: EstadoControle): Promise<boolean>;
  /** UPDATE da pendência e do motivo SÓ onde `ultima_tentativa` = carimbo (CAS). */
  fecharControle(
    ids: readonly string[],
    carimbo: string,
    final: { itens_pendentes: number; motivo: string },
  ): Promise<Fechamento>;
  /** Relógio de parede, ISO — é também o carimbo do CAS. */
  agora(): string;
}

export interface ContextoRecebimento {
  empresa: string;
  /** Todas as linhas do recebimento (≥1, a eleita inclusa). */
  irmas: readonly Irma[];
  /** A tentativa DESTE run (já incrementada). */
  tentativas: number;
}

export interface DesfechoGravacao {
  /** A marcação do controle (write-ahead, ou a marca única) persistiu? Sem ela, nada foi gravado. */
  controle: "persistiu" | "falhou";
  /** O fechamento com CAS: `preterido` = outro run gravou o controle depois do nosso carimbo. */
  fechamento: "persistiu" | "preterido" | "falhou" | "nao_se_aplica";
  /** A pendência medida ao fim; `null` = não medida (resposta sem lista). */
  itensPendentes: number | null;
  itensRecebidos: number;
  itensIgnorados: number;
  itensAguardando: number;
  itensSemRota: number;
  itensContaminados: number;
  itensComPedido: number;
  itensSemPedido: number;
  itensFundidos: number;
  gruposT1Ambiguo: number;
  gruposGravados: number;
  gruposFalhos: number;
  skusGravados: number[];
  motivo: string;
  ultimoErro: string | null;
}

/**
 * Grava UM recebimento já respondido pela Omie. Falha de banco não lança: vira pendência ou desfecho.
 *
 *   1. Sem lista (fault, chave ausente, lista vazia): marca a tentativa nas irmãs SEM tocar a
 *      pendência medida antes — ausência de evidência não resolve pendência.
 *   2. Classifica cada item; resolve o pedido de cada CHAVE uma vez (cache). Lookup que falha deixa
 *      o item sem rota e CONTAMINA o SKU: nenhum grupo desse SKU é gravado no run, senão o grupo
 *      gravado seria um subtotal sobrescrevendo o total de antes (achado do Codex).
 *   3. Write-ahead da pendência conservadora; falhou → não grava nada.
 *   4. Upsert por grupo (tracking, sku); grupo que falha conta os SEUS itens na pendência.
 *   5. Fechamento com CAS no carimbo.
 */
export async function gravarRecebimento(
  deps: DepsGravacao,
  ctx: ContextoRecebimento,
  resposta: { itensRecebimento?: unknown; faultstring?: unknown },
): Promise<DesfechoGravacao> {
  const dono = donoDoRecebimento(ctx.irmas);
  const t2Dono = dono.t2_data_faturamento;
  if (!t2Dono) {
    // A eleita veio da fila, que exige t2; o dono é a de menor t2 com nulo por último ⇒ inalcançável.
    throw new Error(`gravarRecebimento: nenhuma irmã do recebimento tem t2 (dono ${dono.id})`);
  }
  const ids = ctx.irmas.map((i) => i.id);
  const faultstring = typeof resposta.faultstring === "string" && resposta.faultstring
    ? resposta.faultstring
    : null;
  const itensEhLista = Array.isArray(resposta.itensRecebimento);
  const itens = itensEhLista ? resposta.itensRecebimento as OmieRecebimentoItem[] : [];

  const d: DesfechoGravacao = {
    controle: "falhou",
    fechamento: "nao_se_aplica",
    itensPendentes: null,
    itensRecebidos: itens.length,
    itensIgnorados: 0,
    itensAguardando: 0,
    itensSemRota: 0,
    itensContaminados: 0,
    itensComPedido: 0,
    itensSemPedido: 0,
    itensFundidos: 0,
    gruposT1Ambiguo: 0,
    gruposGravados: 0,
    gruposFalhos: 0,
    skusGravados: [],
    motivo: "",
    ultimoErro: null,
  };
  const motivo = (gruposAGravar: number) =>
    motivoDaTentativa({
      faultstring,
      itensEhLista,
      itensRecebidos: itens.length,
      itensPendentes: d.itensPendentes,
      itensAguardando: d.itensAguardando,
      itensSemRota: d.itensSemRota + d.itensContaminados,
      gruposAGravar,
      gruposGravados: d.gruposGravados,
      ultimoErro: d.ultimoErro,
    });

  // ── 1. Sem lista: nada a medir.
  if (faultstring || itens.length === 0) {
    d.motivo = motivo(0);
    const marcou = await deps.marcarControle(ids, {
      tentativas: ctx.tentativas,
      ultima_tentativa: deps.agora(),
      motivo: d.motivo,
    });
    d.controle = marcou ? "persistiu" : "falhou";
    return d;
  }

  // ── 2. Classificar e rotear.
  const buscas = new Map<string, BuscaPedido>();
  const skusSemRota = new Set<number>();
  const resolvidos: ItemRecebimentoResolvido[] = [];
  for (const it of itens) {
    const classe = classificarItem(it);
    if (classe.tipo === "ignorado") {
      d.itensIgnorados++;
      continue;
    }
    if (classe.tipo === "aguardando_associacao") {
      d.itensAguardando++;
      continue;
    }
    let pedido: PedidoCasado | null = null;
    if (classe.pedido) {
      let busca = buscas.get(classe.pedido);
      if (!busca) {
        busca = await deps.buscarPedido(dono.fornecedor_codigo_omie, classe.pedido);
        buscas.set(classe.pedido, busca);
      }
      if (!busca.ok) {
        // Erro de banco NÃO é "pedido não casado": cair no fallback gravava o item no tracking errado.
        d.itensSemRota++;
        skusSemRota.add(classe.sku);
        d.ultimoErro = busca.erro;
        continue;
      }
      pedido = busca.pedido;
    }
    if (pedido) d.itensComPedido++;
    else d.itensSemPedido++;
    const cab = it?.itensCabec ?? {};
    resolvidos.push({
      // O item vai pro tracking do SEU pedido; sem pedido casado, pro DONO do recebimento.
      tracking_id: pedido?.id ?? dono.id,
      sku_codigo_omie: classe.sku,
      sku_codigo: toStr(cab?.cCodigoProduto),
      sku_descricao: toStr(cab?.cDescricaoProduto),
      sku_unidade: toStr(cab?.cUnidadeNfe),
      sku_ncm: toStr(cab?.cNCM),
      fornecedor_codigo_omie: dono.fornecedor_codigo_omie,
      fornecedor_nome: pedido?.fornecedor_nome ?? dono.fornecedor_nome,
      grupo_leadtime: pedido?.grupo_leadtime ?? "OUTRO",
      quantidade_pedida: toNum(cab?.nQtdeNFe),
      quantidade_recebida: toNum(it?.itensAjustes?.nQtdeRecebida),
      valor_unitario: toNum(cab?.nPrecoUnit),
      valor_total: toNum(cab?.vTotalItem),
      t1_data_pedido: pedido?.t1_data_pedido ?? t2Dono,
      t1_de_pedido: pedido !== null,
      t2_data_faturamento: t2Dono,
      t3_data_cte: dono.t3_data_cte,
      t4_data_recebimento: dono.t4_data_recebimento,
    });
  }
  const roteaveis = resolvidos.filter((r) => !skusSemRota.has(r.sku_codigo_omie));
  d.itensContaminados = resolvidos.length - roteaveis.length;
  const agregados = agregarItensRecebimento(roteaveis);
  d.itensFundidos = roteaveis.length - agregados.length;
  const pendenciaFixa = d.itensAguardando + d.itensSemRota + d.itensContaminados;

  // Sem grupo a gravar: não há o que proteger entre duas escritas — uma marcação, com o k final.
  if (agregados.length === 0) {
    d.itensPendentes = pendenciaFixa;
    d.motivo = motivo(0);
    const marcou = await deps.marcarControle(ids, {
      tentativas: ctx.tentativas,
      ultima_tentativa: deps.agora(),
      motivo: d.motivo,
      itens_pendentes: pendenciaFixa,
    });
    d.controle = marcou ? "persistiu" : "falhou";
    return d;
  }

  // ── 3. Write-ahead: a pendência como se NADA gravasse.
  const kConservador = pendenciaFixa + agregados.reduce((s, ag) => s + ag.n_itens_agregados, 0);
  const carimbo = deps.agora();
  const marcou = await deps.marcarControle(ids, {
    tentativas: ctx.tentativas,
    ultima_tentativa: carimbo,
    motivo: `em_gravacao: ${agregados.length} grupos; pendência se nada gravar: ${kConservador} itens`,
    itens_pendentes: kConservador,
  });
  if (!marcou) {
    d.motivo = "controle_nao_persistiu: nada gravado";
    return d;
  }
  d.controle = "persistiu";

  // ── 4. Gravar.
  let itensFalhos = 0;
  for (const ag of agregados) {
    // t1 só é data de PEDIDO se veio do pedido casado E não é ambíguo no grupo; no fallback ele é o
    // faturamento, e lt_bruto/lt_faturamento derivados dele seriam a logística disfarçada de compra.
    const t1Confiavel = !ag.t1_ambiguo && ag.t1_de_pedido;
    if (ag.t1_ambiguo) d.gruposT1Ambiguo++;
    const erro = await deps.gravarLinha({
      tracking_id: ag.tracking_id,
      empresa: ctx.empresa,
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
      lt_bruto_dias_uteis: t1Confiavel ? diasUteisEntre(ag.t1_data_pedido, ag.t4_data_recebimento) : null,
      lt_faturamento_dias_uteis: t1Confiavel ? diasUteisEntre(ag.t1_data_pedido, ag.t2_data_faturamento) : null,
      lt_logistica_dias_uteis: diasUteisEntre(ag.t2_data_faturamento, ag.t4_data_recebimento),
      updated_at: deps.agora(),
    });
    if (erro) {
      d.gruposFalhos++;
      itensFalhos += ag.n_itens_agregados;
      d.ultimoErro = erro;
      continue;
    }
    d.gruposGravados++;
    d.skusGravados.push(ag.sku_codigo_omie);
  }

  // ── 5. Fechamento com CAS.
  d.itensPendentes = pendenciaFixa + itensFalhos;
  d.motivo = motivo(agregados.length);
  const fechou = await deps.fecharControle(ids, carimbo, { itens_pendentes: d.itensPendentes, motivo: d.motivo });
  if (!fechou.ok) {
    d.fechamento = "falhou";
    d.ultimoErro = fechou.erro;
  } else {
    d.fechamento = fechou.atualizadas > 0 ? "persistiu" : "preterido";
  }
  return d;
}
