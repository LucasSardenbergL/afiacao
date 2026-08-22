// Apriori do motor farmer — LÓGICA PURA, extraída de `omie-analytics-sync/index.ts`.
//
// POR QUE ESTE ARQUIVO EXISTE (2026-08-21, Fatia 2 do cap de 1.000). A Fatia 1 (#1840) corrigiu
// a LEITURA das cestas — o universo saiu de 479 pedidos (cap silencioso do PostgREST) para os
// 30.257 reais. Mas `support` é RAZÃO, e o denominador 63× maior levou o piso `s_min = 0.01` a
// exigir ~303 coocorrências: das 24 regras vigentes sobraram **2**. As que morreram não são
// ruído — o lift VERDADEIRO delas no universo completo vai de 2,42 a 143, e são pares óbvios do
// domínio de tintas (CATALISADOR FC.6975LT + FUNDO PU FL.6298.00LT, 225 cestas; WASH PRIMER
// VINILICO + CATALISADOR VINILICO, 207; DISCO DE LIXA P320 + P220, 182).
//
// A correção NÃO é baixar o piso. Baixar `s_min` até a contagem voltar a agradar é recalibrar
// pela contagem desejada — o critério deixaria de significar qualquer coisa. A correção é o
// DENOMINADOR: as duas contas do grupo (`sales_orders.account`) têm catálogos DISJUNTOS, e o
// denominador global afoga o sinal da conta menor. Medido em prod (psql-ro, 2026-08-21), com o
// MESMO `s_min = 0.01` e o MESMO `l_min = 1.2`:
//
//   GLOBAL (as duas contas misturadas, 30.257 cestas) →  2 regras
//   colacor                        (19.030 cestas)    →  2 regras
//   oben                           (11.227 cestas)    → 12 regras
//                                                       ── 14 no total, 7× o global
//
// A evidência de que `account` é o eixo NATURAL, e não a partição que dava o número que se
// queria: dos 3.287 produtos que aparecem em pedidos, **100% aparecem em exatamente UMA conta**
// (zero cross-account). E 0 das regras geradas — nem no cenário segmentado, nem nas 24 vigentes
// — tem antecedente numa conta e consequente na outra. A coocorrência é intra-conta por
// construção: uma cesta é um pedido, e um pedido tem uma conta só.
//
// POR QUE PURO E AQUI, e não inline no `index.ts`: `test:edges` roda com `--no-remote` e o
// `index.ts` importa `serve`/`createClient` de URL remota — importá-lo num teste poria o
// jsr.io/npm no caminho de entrega de TODO PR (CLAUDE.md). Com a lógica isolada, a prova do
// COMPORTAMENTO (o que este arquivo faz com um universo de brinquedo) sai de graça em
// `apriori_test.ts`, e o `index.ts` fica só com I/O.

/** Uma cesta: o pedido e os produtos DISTINTOS dele. */
export interface Cesta {
  /** Chave da transação — `sales_order_id`. Só serve para não contar o mesmo pedido 2×. */
  readonly tx: string;
  readonly produtos: ReadonlySet<string>;
}

export interface ParametrosApriori {
  /** Piso de suporte, RAZÃO sobre o total de cestas DO SEGMENTO. */
  readonly sMin: number;
  readonly lMin: number;
  /** Teto de regras. Aplicado POR SEGMENTO — ver `RegrasDoSegmento` abaixo. */
  readonly maxRegras: number;
}

export interface RegraAssoc {
  antecedent_product_ids: string[];
  consequent_product_ids: string[];
  support: number;
  confidence: number;
  lift: number;
  rule_type: "association";
  sample_size: number;
  /** O `account` que gerou a regra. É a PROVENIÊNCIA do `support`/`sample_size` acima. */
  cluster_segment: string;
}

export interface RegrasDoSegmento {
  readonly segmento: string;
  readonly regras: RegraAssoc[];
  readonly totalCestas: number;
  readonly itensFrequentes: number;
  /** Quantas regras o `maxRegras` cortou. 0 quando nada foi truncado. */
  readonly truncadas: number;
}

/**
 * Roda o Apriori de pares sobre UM segmento. `support` e `sample_size` saem relativos ao
 * total de cestas DESTE segmento — é essa relatividade que é o ponto da fatia.
 *
 * O algoritmo é o mesmo de antes (itens frequentes → pares → duas regras direcionais por par,
 * corte por lift, ordenação por `lift × confidence`). O que mudou é só QUEM é o denominador.
 */
export function calcularRegrasDoSegmento(
  segmento: string,
  cestas: readonly Cesta[],
  p: ParametrosApriori,
): RegrasDoSegmento {
  const totalCestas = cestas.length;
  const vazio: RegrasDoSegmento = {
    segmento,
    regras: [],
    totalCestas,
    itensFrequentes: 0,
    truncadas: 0,
  };
  // Mesmo piso de antes. Um segmento raso não vira regra — e, principalmente, não empresta
  // o denominador do outro para parecer que virou.
  if (totalCestas < 5) return vazio;

  const contagemItem = new Map<string, number>();
  for (const cesta of cestas) {
    for (const pid of cesta.produtos) contagemItem.set(pid, (contagemItem.get(pid) || 0) + 1);
  }

  const frequentes = new Map<string, number>();
  for (const [pid, n] of contagemItem) {
    if (n / totalCestas >= p.sMin) frequentes.set(pid, n);
  }
  if (frequentes.size === 0) return vazio;

  const contagemPar = new Map<string, number>();
  for (const cesta of cestas) {
    const itens = Array.from(cesta.produtos).filter((pid) => frequentes.has(pid));
    for (let i = 0; i < itens.length; i++) {
      for (let j = i + 1; j < itens.length; j++) {
        const chave = [itens[i], itens[j]].sort().join("|");
        contagemPar.set(chave, (contagemPar.get(chave) || 0) + 1);
      }
    }
  }

  const regras: RegraAssoc[] = [];
  const emitir = (ant: string, cons: string, support: number, confidence: number, lift: number) => {
    regras.push({
      antecedent_product_ids: [ant],
      consequent_product_ids: [cons],
      support,
      confidence,
      lift,
      rule_type: "association",
      sample_size: totalCestas,
      cluster_segment: segmento,
    });
  };

  for (const [chave, nPar] of contagemPar) {
    const [a, b] = chave.split("|");
    const supAB = nPar / totalCestas;
    if (supAB < p.sMin) continue;

    const supA = (frequentes.get(a) || 0) / totalCestas;
    const supB = (frequentes.get(b) || 0) / totalCestas;

    const confAB = supAB / supA;
    const liftAB = confAB / supB;
    if (liftAB >= p.lMin) emitir(a, b, supAB, confAB, liftAB);

    const confBA = supAB / supB;
    const liftBA = confBA / supA;
    if (liftBA >= p.lMin) emitir(b, a, supAB, confBA, liftBA);
  }

  regras.sort((x, y) => (y.lift * y.confidence) - (x.lift * x.confidence));

  // ⚠️ O teto é aplicado POR SEGMENTO, de propósito. Um teto GLOBAL sobre a lista concatenada
  // reintroduziria, no eixo do CORTE, exatamente o defeito que esta fatia corrige no eixo do
  // DENOMINADOR: a conta com mais cestas domina o ranking e a menor cai fora do top-N — e
  // aumentar o teto só adiaria (CLAUDE.md, "corte por ranking: o teto é o EIXO, não o tamanho").
  // `truncadas` sobe junto porque teto que trunca em SILÊNCIO fabrica completude (money-path §8).
  const truncadas = Math.max(0, regras.length - p.maxRegras);
  return {
    segmento,
    regras: regras.slice(0, p.maxRegras),
    totalCestas,
    itensFrequentes: frequentes.size,
    truncadas,
  };
}

/**
 * Agrupa as linhas lidas de `order_items` em cestas, POR SEGMENTO.
 *
 * `sales_order_id` é a chave da cesta e `account` vem do PEDIDO — a mesma coluna que o
 * `useCrossSellEngine` usa para qualificar a conta da oferta. Linha sem produto, sem pedido ou
 * sem conta é DESCARTADA aqui e CONTADA em `descartadas`: quem chama decide o que fazer com o
 * número, mas não pode deixar de vê-lo (money-path §2 — ausente ≠ zero; um descarte silencioso
 * encolheria o denominador e o `sample_size` publicado teria cara de universo completo).
 */
export function agruparCestasPorSegmento(
  linhas: readonly { sales_order_id: string | null; product_id: string | null; account: string | null }[],
): { porSegmento: Map<string, Cesta[]>; descartadas: number } {
  const acumulador = new Map<string, Map<string, Set<string>>>();
  let descartadas = 0;

  for (const linha of linhas) {
    if (!linha.product_id || !linha.sales_order_id || !linha.account) {
      descartadas++;
      continue;
    }
    let doSegmento = acumulador.get(linha.account);
    if (!doSegmento) {
      doSegmento = new Map<string, Set<string>>();
      acumulador.set(linha.account, doSegmento);
    }
    let cesta = doSegmento.get(linha.sales_order_id);
    if (!cesta) {
      cesta = new Set<string>();
      doSegmento.set(linha.sales_order_id, cesta);
    }
    cesta.add(linha.product_id);
  }

  const porSegmento = new Map<string, Cesta[]>();
  for (const [segmento, cestas] of acumulador) {
    porSegmento.set(
      segmento,
      Array.from(cestas, ([tx, produtos]) => ({ tx, produtos })),
    );
  }
  // Ordem estável do NOME do segmento: o lote enviado à RPC fica determinístico entre
  // execuções, o que é o que torna dois recomputes comparáveis numa auditoria.
  return {
    porSegmento: new Map(Array.from(porSegmento).sort(([a], [b]) => a.localeCompare(b))),
    descartadas,
  };
}
