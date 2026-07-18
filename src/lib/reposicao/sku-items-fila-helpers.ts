// Helpers puros da fila do sync de leadtime por item de NFe (omie-sync-sku-items).
//
// Por que existem: a fila de NFes pendentes era "tudo que não tem linha em
// sku_leadtime_history", em ordem fixa t2 DESC. NFe cuja consulta Omie retorna
// 0 itens nunca upserta → nunca sai da fila → re-consultada a cada run (poison),
// consumindo o guard de 50s e deixando as antigas inalcançáveis (starvation) —
// incidente OBEN 2026-07-14. O controle de tentativas (sku_items_sync_controle)
// + backoff + ordenação nunca-tentadas-primeiro drenam a fila.
//
// ESPELHADOS verbatim na edge supabase/functions/omie-sync-sku-items/index.ts
// (bloco // MIRROR-START sku-items-fila) — o Deno da edge não importa de src/;
// a paridade é provada em src/__tests__/edge-money-path-invariants.test.ts.

// MIRROR-START sku-items-fila
export interface SkuItemsFilaControle {
  tentativas: number;
  ultima_tentativa: string | null;
}

/** Backoff entre re-tentativas de consulta por NFe: 1ª falha re-tenta em 6h,
 *  2ª em 24h, da 3ª em diante 72h. Tentativas <=0 = virgem (sempre elegível). */
export function skuItemsBackoffMs(tentativas: number): number {
  if (tentativas <= 0) return 0;
  if (tentativas === 1) return 6 * 3_600_000;
  if (tentativas === 2) return 24 * 3_600_000;
  return 72 * 3_600_000;
}

/** Elegível para consultar se nunca tentada, controle ilegível ou backoff vencido. */
export function skuItemsElegivel(
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
export function skuItemsCompararFila(
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
export function skuItemsDedupPorRecebimento<T extends { id: string; nIdReceb: string | null }>(
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

// ─── Agregação de itens de NFe por (tracking, sku) antes do upsert ───
// ESPELHADO verbatim na edge omie-sync-sku-items (bloco sku-items-agregacao abaixo);
// paridade provada em src/__tests__/edge-money-path-invariants.test.ts.
// MIRROR-START sku-items-agregacao
export interface ItemRecebimentoResolvido {
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

export interface ItemRecebimentoAgregado extends ItemRecebimentoResolvido {
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
export function agregarItensRecebimento(
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
