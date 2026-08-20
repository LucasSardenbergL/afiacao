/**
 * Sensor: a oferta que o farmer recebe sai da conta em que aquele cliente COMPRA?
 *
 * Por que existe — e por que é SENSOR, não filtro. O `productList` dos motores Farmer é o
 * catálogo GLOBAL (`omie_products` filtrado só por `ativo`), sem recorte de `account`. O
 * #1807 fechou a identidade account-aware do item do HISTÓRICO, e deixou declarado que o
 * candidato da OFERTA seguia global. A pergunta aberta era se isso é vazamento — e a resposta
 * é NÃO, medida antes de decidir (psql-ro, 20/08/2026, 1.361 recomendações vivas):
 *
 *   - DENOMINADOR: dos 293 clientes com recomendação viva, 139 (47,4%) compram pelas DUAS
 *     empresas (`colacor` e `oben` são CNPJs do MESMO grupo, separados por vantagem fiscal —
 *     database.md §5). Vender cross-empresa não é anomalia: é quase metade da carteira.
 *   - NUMERADOR: 415 das 1.361 (30,5%) ofertam SKU de conta em que o cliente não tem
 *     histórico — e 100% delas são de clientes mono-conta, por construção.
 *
 * Filtrar o `productList` pela conta do cliente apagaria 30,5% da oferta viva e 342 das 349
 * ofertas dos 106 clientes que só compram `colacor` — destruindo recall LEGÍTIMO em nome de
 * uma precisão que a medição não pediu. `precisão > recall` resolve AMBIGUIDADE; aqui não há
 * ambiguidade, há um fato comercial. O filtro está descartado pelo dado, não por omissão.
 *
 * ⚠️ O que a medição encontrou no lugar, e o motivo REAL deste contador existir: 934 dos 939
 * cross-sell vivos são SKU `oben`, e os 106 clientes 100% `colacor` recebem 342 ofertas `oben`
 * e ZERO `colacor` — tendo, em média, 495 candidatos `colacor` que passam todos os gates
 * (vendável, não comprado, acima do limiar de cluster) contra 332 `oben`. Não é falta de
 * custo (o catálogo vendável é 71% `colacor`: 1.756 × 707) nem o gate de popularidade (498
 * SKUs `colacor` passam o limiar contra 332 `oben`). ⚠️ Estes quatro últimos números foram
 * REMEDIDOS sobre o universo do #1819 (denylist `STATUS_NAO_VENDA`): a allowlist antiga
 * citava dois status que nunca existiram em `sales_orders`, e media 349/299/234/233 sobre um
 * universo parcial. A conclusão não mudou — ficou MAIS forte: a disponibilidade favorece
 * `colacor` por 1,5×, não por empate. O que elimina `colacor` é o RANKING: o
 * `assocBoost` pesa 0.6 contra 0.4 do `clusterAdherence`, e as 24 regras de associação vivas
 * têm consequente 100% `oben`. A oferta inteira cabe em 30 SKUs distintos (1,2% dos 2.463
 * vendáveis), e nada na tela diz isso.
 *
 * Este contador não corrige o ranking — corrigi-lo é decisão de produto com dono e evidência
 * própria. Ele torna VISÍVEL o sintoma que hoje é invisível, no único lugar onde a evidência
 * sobrevive à execução: o head da geração. Sem piso e fora dos `INSUMOS_OBRIGATORIOS_*`: não
 * muda veredicto de completude, porque ofertar cross-empresa é legítimo e degradar por isso
 * seria transformar um fato comercial em defeito.
 */

/** Chave de conta. `undefined` e `null` colapsam em `null` — ausência é UM estado, não coringa. */
type ChaveConta = string | null;

/** A oferta EMITIDA (o que chega ao farmer), não o candidato considerado. */
export interface OfertaClassificavel {
  readonly customerId: string;
  readonly productId: string;
}

/** Formato de `InsumoLido` (`completude-snapshot.ts`): `n` é a fatia útil de `esperado`. */
export interface CoberturaContaOferta {
  /** Ofertas cuja conta o cliente JÁ compra. */
  readonly n: number;
  /** Ofertas EMITIDAS. */
  readonly esperado: number;
}

/**
 * Acumula, por cliente, as contas em que ele efetivamente comprou.
 *
 * A conta vem de `sales_orders.account` — a mesma que o #1807 usa para qualificar o item, e
 * pelo mesmo motivo: é a conta do PEDIDO que diz por qual empresa aquele cliente foi
 * faturado. Deduzi-la do SKU seria circular (é justamente o SKU que este sensor julga).
 */
export function acumularContaDeCompra(
  destino: Map<string, Set<ChaveConta>>,
  customerId: string,
  account: string | null | undefined,
): void {
  const conta: ChaveConta = account == null ? null : account;
  const atual = destino.get(customerId);
  if (atual) atual.add(conta);
  else destino.set(customerId, new Set([conta]));
}

/**
 * Mede que fatia das ofertas emitidas cai numa conta em que o cliente compra.
 *
 * Oferta INDETERMINADA (SKU fora do índice, cliente sem nenhuma conta conhecida, ou `account`
 * NULL de qualquer um dos lados) conta como NÃO-conforme — fail-closed. Ela NÃO é diluída num
 * terceiro balde, como o #1807 fez com `fora_do_catalogo_ativo`, e a diferença é medida, não
 * estilística: lá o descarte era o regime normal e farto (39,9% dos itens), então somá-lo ao
 * denominador afogaria a divergência num número que nunca chamaria atenção. Aqui o
 * indeterminado é ZERO em produção — 0 de 30.961 pedidos e 0 SKU ativo com `account` NULL
 * (psql-ro, 20/08/2026) —, logo não há o que afogar.
 *
 * ⚠️ `null` NÃO casa com `null` (achado do challenge Codex xhigh desta entrega). `account`
 * ausente é "não sei de que empresa é", dos dois lados; tratar dois desconhecidos como
 * correspondência é fabricar conformidade — a mesma falha que `Number(null) === 0` comete com
 * dinheiro. E como o NULL vale zero em prod, o fail-closed é inerte hoje: ele não pode gerar
 * alarme falso, só pegar o dia em que a coluna começar a chegar vazia.
 */
export function medirCoberturaContaDaOferta(
  ofertas: readonly OfertaClassificavel[],
  contasDeCompra: ReadonlyMap<string, ReadonlySet<ChaveConta>>,
  contaDoProduto: ReadonlyMap<string, ChaveConta>,
): CoberturaContaOferta {
  let n = 0;
  for (const oferta of ofertas) {
    if (ofertaNaContaDoCliente(oferta.productId, contasDeCompra.get(oferta.customerId), contaDoProduto)) n++;
  }
  return { n, esperado: ofertas.length };
}

/**
 * A regra de conformidade, isolada para ter UM dono.
 *
 * Existe porque o cross-sell precisa aplicá-la em dois momentos com denominadores diferentes
 * — sobre as ofertas EMITIDAS e sobre os CANDIDATOS elegíveis — e duas cópias da mesma regra
 * divergiriam na primeira manutenção, deixando os dois números incomparáveis justamente
 * quando compará-los é o ponto (`emitidas/candidatos` é o que separa composição da carteira
 * de preferência do ranking; achado do challenge Codex).
 */
export function ofertaNaContaDoCliente(
  productId: string,
  contasDoCliente: ReadonlySet<ChaveConta> | undefined,
  contaDoProduto: ReadonlyMap<string, ChaveConta>,
): boolean {
  if (!contasDoCliente || contasDoCliente.size === 0) return false;
  const conta = contaDoProduto.get(productId);
  // `undefined` = SKU fora do índice; `null` = SKU sem conta declarada. Os dois são "não sei",
  // e nenhum dos dois conta como conforme.
  if (conta == null) return false;
  return contasDoCliente.has(conta);
}

/**
 * Todo SKU do bundle é da MESMA conta?
 *
 * Sensor PRÓPRIO do `useBundleEngine`, e não o mesmo do cross-sell — porque lá a pergunta
 * ("a oferta saiu da conta do cliente?") tem resposta legítima nas duas direções, enquanto
 * aqui há uma que é INEXEQUÍVEL: um bundle é "compre estes SKUs JUNTOS", e SKUs de empresas
 * diferentes não cabem no mesmo pedido — são dois CNPJs, dois pedidos Omie, duas identidades
 * de cliente (`submitOrder` exige a identidade PRÓPRIA de cada conta). O farmer receberia uma
 * oferta que o fluxo de venda não consegue executar como está escrita.
 *
 * Por isso este sensor tem o gatilho que o de conta não tem: o esperado é 100%, e QUALQUER
 * `n < esperado` é defeito, não operação normal.
 *
 * Hoje é inerte, e a razão é estrutural: toda regra nasce de um par co-ocorrente no MESMO
 * pedido, e um pedido tem uma conta só — depois do #1807, itens de contas diferentes nem
 * entram na mesma cesta. Medido: as 24 regras vivas são 24/24 `oben → oben`, ZERO cruzando
 * conta, e os 12 bundles vivos somam 24 SKUs todos `oben` (psql-ro, 20/08/2026). O caminho
 * que quebraria a invariante existe e não depende de dado novo: `bundles` de 2-3 SKUs
 * combinam consequentes de regras DIFERENTES (`relatedRules`), e duas regras aplicáveis ao
 * mesmo cliente podem ser de contas distintas assim que houver uma regra `colacor` — hoje não
 * há nenhuma, e é só isso que segura.
 */
export function medirBundlesDeContaUnica(
  bundles: ReadonlyArray<{ readonly products: ReadonlyArray<{ readonly id: string }> }>,
  contaDoProduto: ReadonlyMap<string, ChaveConta>,
): CoberturaContaOferta {
  let n = 0;
  for (const bundle of bundles) {
    const contas = new Set<ChaveConta | undefined>();
    for (const produto of bundle.products) contas.add(contaDoProduto.get(produto.id));
    // Conta desconhecida (`undefined`/`null`) não pode atestar unicidade: fail-closed, igual
    // ao `medirCoberturaContaDaOferta`. Bundle vazio também não atesta nada.
    if (contas.size === 1 && !contas.has(undefined) && !contas.has(null)) n++;
  }
  return { n, esperado: bundles.length };
}
