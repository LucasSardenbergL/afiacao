// Camada de LEITURA do motor de recomendação (`recommend/index.ts`).
//
// Por que existe um módulo só para ler seis tabelas: a edge importa
// `npm:@supabase/supabase-js@2`, e `test:edges` roda com `--no-remote`. Enquanto as leituras
// moravam dentro do `index.ts`, nenhuma afirmação sobre elas era EXECUTÁVEL — "o catálogo
// volta inteiro" e "erro de leitura não vira catálogo parcial" só podiam ser lidas, nunca
// provadas. Aqui elas rodam contra um double que satisfaz `BancoPostgrest`
// (`recommend-leituras_test.ts`), no runtime real.
//
// O DEFEITO QUE ESTE MÓDULO FECHA (achado por challenge Codex, confirmado por leitura de
// código + medição psql-ro em prod, 2026-08-20). O `Promise.all` original desestruturava
// apenas `{ data }` nas SEIS leituras — todo `error` descartado — e NENHUMA paginava. O
// PostgREST capa cada resposta em 1000 linhas EM SILÊNCIO, então em prod:
//
//   omie_products WHERE ativo               3.140 linhas → a edge via 1.000 (32%)
//   product_costs                           3.676 linhas → a edge via 1.000 (27%)
//   order_items do cliente          até 2.849 por cliente → 8 clientes truncados
//   farmer_association_rules (lift/support)     4 linhas → íntegro HOJE, e só hoje
//   recommendation_config                      15 linhas → íntegro
//   farmer_client_scores (maybeSingle)          1 linha  → íntegro
//
// E os três efeitos, que não são o mesmo efeito:
//   · catálogo truncado ⇒ 68% dos SKUs recomendáveis invisíveis, e QUAIS 1.000 sobram é
//     não-determinístico (sem ORDER BY o Postgres não promete sequência) — a recomendação
//     variava sem causa;
//   · custo truncado ⇒ o número que importa NÃO é 1.000/3.676 (cobertura das linhas de
//     `product_costs`), é a cobertura dos CANDIDATOS — derivação corrigida no challenge
//     Codex. Medida: dos 3.140 produtos ativos, só 833 (26,5%) têm custo na primeira página
//     `ORDER BY id`; 73,5% caem em `custoConfiavel = null`. O consumidor JÁ degrada honesto
//     (margem exibida vira null, `margemRank` vira 0 = "EIP neutro"), então aqui NÃO se infla
//     margem — mas o componente de LUCRO tem o MAIOR peso (`w_eip` 0.35) e passava a ser
//     decidido sobre um quarto dos custos, com o corte arbitrário. Perda por omissão;
//     (`product_costs.product_id` é ÚNICO — 3.676 linhas, 3.676 distintos, medido —, então
//     ordenar por `id` não escolhe "qual custo vale": não há dois para o mesmo produto.)
//   · histórico truncado ⇒ `hasPurchased`/`recommendation_type`/`ctx_score`/`recorrência`
//     errados exatamente nos 8 clientes MAIORES.
//
// Regra desta camada, uniforme de propósito: TODA leitura de LISTA pagina por `fetchAll`
// (que lança em `error` e em `data:null` sem erro), mesmo a que hoje cabe em uma página —
// deixar duas exceções obrigaria todo leitor futuro a re-derivar quais são. O que sobra é a
// leitura de UMA linha, que passa por `exigirLeitura`. Falha de leitura vira exceção: a
// edge devolve 500 em vez de uma recomendação calculada sobre catálogo parcial.
//
// O 500 carrega mensagem em DOMÍNIO FECHADO nas duas cardinalidades e nos dois modos de
// paginação — `fetchAll`, `fetchAllKeyset` e `exigirLeitura` lançam a MESMA
// `FalhaLeituraCritica`. Aqui existiram DOIS wrappers locais (`paginarFonte` e
// `paginarFonteKeyset`) que envelopavam o erro antes de o helper vê-lo, porque os helpers
// ainda reconstruíam ``new Error(`${label}: ${error.message}`)`` e mandavam o MESSAGE do
// Postgres para o corpo da resposta HTTP. Os helpers foram fechados; os wrappers saíram
// junto — inclusive o `falha.cause = e` deles, que criava a propriedade ENUMERÁVEL que
// `JSON.stringify(err)` serializa. O guarda não mudou: `recommend-leituras_test.ts` segue
// afirmando as DUAS metades JUNTAS — o `code` 57014 preservado E o texto do servidor
// ausente da mensagem pública.
import { fetchAll, fetchAllKeyset } from "./paginate.ts";
import type { BancoPostgrest } from "./paginate.ts";
import { exigirLeitura, FalhaLeituraCritica } from "./leitura-critica.ts";

// ── Formas das linhas (o que o `.select()` de cada leitura promete) ────────────────────
// NÃO exportadas de propósito: ninguém fora daqui as nomeia, e `export` sem consumidor
// reprova no gate de dead code (`bunx knip`, passo "Dead code gate" do CI — que roda
// DEPOIS do typecheck e do teste, então uma suíte inteiramente verde não diz nada sobre
// ele). Elas seguem visíveis onde importa: `InsumosRecommend`/`ClusterRecommend`, que são
// exportados, as referenciam. Reexportar só quando alguém de fato importar.

interface LinhaConfig {
  key: string;
  value: number;
}

interface LinhaOrderItem {
  /** Chave do keyset. Não entra em nenhum cálculo — está no `.select()` porque o cursor
   *  precisa dela; sob `.range()` ela não era pedida. */
  id: string;
  product_id: string | null;
  quantity: number | null;
  unit_price: number | null;
}

interface LinhaProduto {
  id: string;
  omie_codigo_produto: number;
  descricao: string;
  codigo: string;
  valor_unitario: number | null;
  estoque: number | null;
  familia: string | null;
  subfamilia: string | null;
}

interface LinhaCusto {
  product_id: string;
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
}

interface LinhaRegra {
  id?: string;
  antecedent_product_ids: string[] | null;
  consequent_product_ids: string[] | null;
  lift: number;
  confidence: number;
  support: number;
}

interface LinhaClientScore {
  health_class: string | null;
  category_count: number | null;
}


export interface InsumosRecommend {
  configs: LinhaConfig[];
  orderItems: LinhaOrderItem[];
  products: LinhaProduto[];
  costs: LinhaCusto[];
  rules: LinhaRegra[];
  /** `null` = cliente sem score cadastrado. Estado LEGÍTIMO — distinto de falha, que lança. */
  clientScore: LinhaClientScore | null;
}

// ── O teto do cluster: agora DISJUNTOR de custo, não amostra ──────────────────────────
// Os três tetos de antes (100 clientes lidos / 50 amostrados / 1.000 linhas de compra) saíram
// junto com a amostragem: `recommend_cluster_agregado` agrega no BANCO, e a população elegível
// é PEQUENA — 779 / 348 / 100 clientes nos três clusters (medido em prod 2026-08-22). Não há
// cauda longa a amostrar; o cluster inteiro custa 51,9 ms (EXPLAIN ANALYZE no pior caso).
//
// Some junto a auto-inclusão que o #1852 deixou nomeada: com n=50 o cliente-alvo valia 2% do
// próprio denominador; com o cluster inteiro vale 0,13% / 0,29% / 1,00%. Diluída, não consertada
// — leave-one-out segue não implementado, e agora custa menos deixá-lo assim.

/**
 * Acima disto a RPC NÃO mede: devolve `truncado` e os campos medidos em NULL.
 *
 * É disjuntor de CUSTO, e o número vem de folga medida: o maior cluster tem 779 elegíveis, então
 * 5.000 é ~6,4× o pior caso de hoje. O outro eixo — quantos PRODUTOS o agregado tem — não precisa
 * de teto porque é limitado ESTRUTURALMENTE pelo catálogo ativo (3.140 SKUs), e o `jsonb` de uma
 * linha não passa pelo cap de 1.000 do PostgREST.
 *
 * ⚠️ Este teto não é o teto antigo com outro nome. O de 1.000 LINHAS cortava no meio e seguia
 * ranqueando sobre o pedaço; este RECUSA medir. A diferença é o contrato de `truncado`.
 */
export const TETO_CLUSTER_CLIENTES = 5000;

export const CLUSTER_STATUS_COM_HISTORICO = ["ativo", "stale"] as const;

export interface ClusterRecommend {
  /**
   * População ELEGÍVEL do cluster (whitelist de `sales_history_status` aplicada).
   *
   * ⚠️ NÃO é o denominador de `sim` — foi, e a mudança está medida. Ele é o eixo do DISJUNTOR
   * (o teto é sobre custo, e custo escala com população) e o sensor que mostra a distância
   * entre "quantos existem" e "sobre quantos dá para responder".
   */
  denominador: number;
  /**
   * Quantos dos elegíveis têm ≥1 par no recorte. **É o denominador de `sim`.** `null` quando
   * `truncado`.
   *
   * Os dois DIVERGEM em prod (780 vs 634 em `critico`, 347 vs 333 em `atencao`) e a escolha muda
   * comportamento observável. A versão anterior dividia pela população, argumentando que a
   * leitura é exaustiva e portanto cliente sem par é fato observado. MEDIDO, não era: os 146 de
   * `critico` que ficam de fora TÊM compra, os pedidos passam no filtro de universo, e quem os
   * elimina é só `omie_products.ativo` — um filtro de PRODUTO decidindo quem entra num
   * denominador de CLIENTES. São clientes sobre quem a pergunta não é respondível, e contá-los
   * como "não comprou" é o `Number(null)===0` mudado do numerador para o denominador.
   *
   * ⚠️ Não confundir com viés de seleção: `observados` não é "quem comprou o produto X" (aí o
   * denominador sairia filtrado pelo numerador) — é "quem tem ao menos um par mensurável", que
   * é condição sobre a legibilidade do CLIENTE, não sobre o produto sendo pontuado.
   */
  observados: number | null;
  /**
   * `product_id` → nº de clientes DISTINTOS do cluster que o compraram. Já deduplicado por
   * `(cliente, produto)` no banco, então recompra e pedido com muitos SKUs não pesam.
   *
   * `null` (e NÃO `{}`) quando `truncado`: `{}` diria "medi e ninguém comprou", que é o zero
   * fabricado que esta entrega existe para matar.
   */
  clientesPorProduto: Record<string, number> | null;
  /**
   * `true` = a população passou de `TETO_CLUSTER_CLIENTES` e a RPC RECUSOU medir. O consumidor
   * trata `sim` como INDISPONÍVEL — não como zero.
   *
   * Sucessor de `amostraNoTeto`, e a diferença é a que importa: aquele sinalizava um corte que
   * o código seguia usando (só um `console.warn` do outro lado), este desliga o componente.
   */
  truncado: boolean;
}

/** A forma da linha ÚNICA que `recommend_cluster_agregado` devolve. */
interface LinhaClusterAgregado {
  denominador: number | null;
  observados: number | null;
  produtos: Record<string, number> | null;
  truncado: boolean | null;
}

/**
 * As seis leituras do motor, em paralelo, paginadas e com falha EXPOSTA.
 *
 * ⚠️ `.order("id")` em toda leitura paginada: `id` é a PK das seis tabelas (conferido em
 * `pg_index` na prod). Sem ordem estável o `.range()` pula/duplica linhas entre páginas, e
 * o helper que lança no erro não protege disso (money-path §7).
 */
export async function carregarInsumos(
  db: BancoPostgrest,
  customerId: string,
): Promise<InsumosRecommend> {
  const [configs, orderItems, products, costs, rules, clientScore] = await Promise.all([
    fetchAll<LinhaConfig>(
      (de, ate) =>
        db.from<LinhaConfig>("recommendation_config")
          .select("key, value")
          .order("id", { ascending: true })
          .range(de, ate),
      "recommendation_config",
    ),
    fetchAllKeyset<LinhaOrderItem, string>(
      (cursor, limite) => {
        const q = db.from<LinhaOrderItem>("order_items")
          .select("id, product_id, quantity, unit_price")
          .eq("customer_user_id", customerId)
          .order("id", { ascending: true })
          .limit(limite);
        return cursor === null ? q : q.gt("id", cursor);
      },
      (l) => l.id,
      "order_items",
    ),
    fetchAllKeyset<LinhaProduto, string>(
      (cursor, limite) => {
        const q = db.from<LinhaProduto>("omie_products")
          .select("id, omie_codigo_produto, descricao, codigo, valor_unitario, estoque, familia, subfamilia")
          .eq("ativo", true)
          .order("id", { ascending: true })
          .limit(limite);
        return cursor === null ? q : q.gt("id", cursor);
      },
      (l) => l.id,
      "omie_products",
    ),
    fetchAll<LinhaCusto>(
      (de, ate) =>
        db.from<LinhaCusto>("product_costs")
          .select("product_id, cost_price, cost_final, cost_source, cost_confidence")
          .order("id", { ascending: true })
          .range(de, ate),
      "product_costs",
    ),
    // 4 linhas em prod hoje. Pagina mesmo assim: o volume desta tabela é função do PISO de
    // `lift`/`support` — baixar o piso é uma decisão de produto de uma linha, que não tem
    // como saber que existe um cap de 1000 esperando do outro lado.
    fetchAll<LinhaRegra>(
      (de, ate) =>
        db.from<LinhaRegra>("farmer_association_rules")
          .select("*")
          .gte("lift", 1.2)
          .gte("support", 0.01)
          .order("id", { ascending: true })
          .range(de, ate),
      "farmer_association_rules",
    ),
    // Única leitura de UMA linha. `exigirLeitura` lança no erro e devolve `data` como veio
    // quando não há erro — então "cliente sem score" (null) segue caindo no default do
    // consumidor, e só a FALHA deixa de se disfarçar de ausência.
    db.from<LinhaClientScore>("farmer_client_scores")
      .select("health_class, category_count")
      .eq("customer_user_id", customerId)
      .maybeSingle()
      .then((res) => exigirLeitura(res, "farmer_client_scores")),
  ]);

  return { configs, orderItems, products, costs, rules, clientScore };
}

/**
 * Similaridade de cluster: quantos clientes do mesmo `health_class` compram cada produto.
 *
 * ⚠️ O QUE ESTA ENTREGA CONSERTA (medido em prod 2026-08-21/22, psql-ro).
 *
 * Antes, esta função lia `order_items` dos 50 clientes amostrados com
 * `.order("id").limit(1000)` e o TypeScript agregava. Como `order_items.id` é UUID
 * `gen_random_uuid()`, esse LIMIT era amostra de LINHAS, não janela temporal — e mordia:
 *
 *   cluster | linhas existentes | linhas VISTAS | clientes com compra REAL | clientes ZERADOS
 *   critico |               749 |           749 |                       50 |                0
 *   atencao |             2.413 |         1.000 |                       50 |                5
 *   estavel |            16.738 |         1.000 |                       50 |                2
 *
 * Os 5 e 2 ZERADOS são o defeito: o cliente TINHA compra, o teto comeu todas as linhas dele
 * (comprador pesado ocupa o orçamento desproporcionalmente; recompra e pedido grande gastam cap
 * sem mover o numerador, que conta clientes DISTINTOS), e o denominador o contava como "não
 * comprou". Fabricar zero é o que `money-path.md` §2 proíbe. Em `estavel` a edge via 6% das
 * linhas e 30% dos produtos.
 *
 * Agora a agregação inteira vive em `recommend_cluster_agregado` (migration
 * `20260822000358`), que também elimina o `.in()` com 50 UUIDs na URL do PostgREST. O porquê de
 * cada escolha do recorte — histórico inteiro, universo de pedidos canônico, SKU ativo,
 * denominador-população, retorno em jsonb de UMA linha — está no cabeçalho da migration, com as
 * medições que a sustentam. Aqui fica só o que o CHAMADOR precisa saber.
 *
 * ⚠️ SEGUE ABERTO, nomeado para não passar por consertado:
 *   · AUTO-INCLUSÃO: o cliente-alvo ainda pode contar no próprio denominador. Diluída de 2% para
 *     0,13%/0,29%/1,00% ao trocar a amostra pela população — não consertada;
 *   · o cluster é global por `health_class` e ignora `farmer_id`, embora a coluna exista;
 *   · os cortes 0,10/0,15/0,20 de `recommend/index.ts` NÃO foram recalibrados, e agora eles
 *     mordem de forma MUITO diferente por cluster: com o cluster inteiro o `sim` máximo é 0,096
 *     em `critico` (n=779, nada cruza 0,10), 0,210 em `atencao` e 0,430 em `estavel` (n=100, 34
 *     produtos cruzam 0,20). Não recalibrei de propósito: em `critico` o silêncio é o sistema
 *     dizendo a verdade — não HÁ produto que 10% do cluster compre. Baixar o corte para fazer o
 *     ramo acender seria fabricar disparo.
 */
export async function carregarCluster(
  db: BancoPostgrest,
  healthClass: string,
): Promise<ClusterRecommend> {
  const { data, error } = await db.rpc<LinhaClusterAgregado>("recommend_cluster_agregado", {
    p_health_class: healthClass,
    p_teto_clientes: TETO_CLUSTER_CLIENTES,
  });
  // Mesma redução a domínio FECHADO das outras leituras: o `error.message` do PostgREST
  // encaminha o MESSAGE do Postgres, e o `catch` do `Deno.serve` de `recommend/index.ts` devolve
  // esse texto no CORPO da resposta.
  if (error) throw new FalhaLeituraCritica("recommend_cluster_agregado", error);

  // `data: null` sem erro é resposta MALFORMADA — não é "cluster vazio". Cluster vazio é uma
  // linha com `denominador: 0`, que segue adiante. Tratar um pelo outro é o EOF falso que o
  // resto deste módulo existe para rejeitar.
  const linha = data?.[0];
  if (data == null || linha == null) {
    throw new FalhaLeituraCritica("recommend_cluster_agregado", { code: "MALFORMADA" });
  }

  const truncado = linha.truncado === true;
  return {
    // `denominador` é o único campo que a RPC devolve mesmo truncada (é o fato: a população
    // existe e foi contada). `?? 0` aqui NÃO fabrica — a coluna é `count(*)`, nunca nula; o
    // fallback só satisfaz o tipo.
    denominador: linha.denominador ?? 0,
    // Truncado ⇒ null, não 0. A distinção inteira da entrega: 0 é "medi e ninguém comprou".
    observados: truncado ? null : linha.observados,
    clientesPorProduto: truncado ? null : (linha.produtos ?? {}),
    truncado,
  };
}
