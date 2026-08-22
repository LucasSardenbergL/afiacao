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
import { exigirLeitura, exigirLista } from "./leitura-critica.ts";

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

interface LinhaCompraCluster {
  product_id: string | null;
  customer_user_id: string;
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

// ── Tetos do cluster: amostra DELIBERADA, e por isso nomeada ───────────────────────────
// Estes três números são teto de custo, não cap acidental do transporte. Ficam como
// constantes exportadas para o teste afirmar sobre eles em vez de repeti-los.

/** Quantos clientes do mesmo `health_class` entram na amostra de similaridade. */
export const TETO_CLUSTER_CLIENTES = 100;
/** Destes, de quantos se buscam as compras (o `.in()` cresce a URL do PostgREST). */
export const TETO_CLUSTER_USUARIOS_AMOSTRA = 50;
/** Teto de linhas de compra da amostra. */
export const TETO_CLUSTER_COMPRAS = 1000;

/**
 * Os `sales_history_status` que ENTRAM na amostra de similaridade — whitelist POSITIVA.
 *
 * Espelha `SalesHistoryStatus` de `src/lib/scoring/salesHistoryStatus.ts` menos
 * `'sem_historico'` (Deno não importa de `src/`); lá a união é FECHADA em três valores, e o
 * gate de paridade que pega a divergência está em
 * `src/__tests__/edge-money-path-invariants.test.ts`.
 *
 * Por que whitelist e não `.neq('sem_historico')`, que seria mais curto: a coluna é NULLABLE
 * (zero nulos hoje, mas o schema permite) e negação no PostgREST é NULL-blind — o `.neq`
 * excluiria NULL por efeito colateral invisível. E um status NOVO que signifique "sem venda"
 * entraria SOZINHO na amostra sob `.neq`, reabrindo este defeito em silêncio. Whitelist falha
 * FECHADA: status desconhecido fica de fora até alguém decidir.
 *
 * `sem_historico` é mais estrito que "não tem linha em `order_items`": significa "sem venda
 * VÁLIDA monetizada", e a RPC que alimenta a coluna já aplica blocklist de status e
 * `deleted_at IS NULL`. Medido em prod hoje bate EXATAMENTE com os 5.406 `critico` sem nenhuma
 * compra (0 falso-positivo, 0 falso-negativo), e a divergência futura é na direção desejada:
 * cliente cujos únicos pedidos foram cancelados sai da amostra.
 */
export const CLUSTER_STATUS_COM_HISTORICO = ["ativo", "stale"] as const;

export interface ClusterRecommend {
  /** Os até `TETO_CLUSTER_CLIENTES` clientes do mesmo `health_class` COM histórico de venda. */
  clusterUserIds: string[];
  /** O recorte de `clusterUserIds` de quem as compras foram efetivamente buscadas. */
  usuariosAmostrados: string[];
  clusterPurchases: LinhaCompraCluster[];
  /**
   * `true` quando a amostra bateu em `TETO_CLUSTER_COMPRAS`. Chama-se "no teto" e não
   * "saturada" porque é exatamente isso que o código SABE: com 1.000 compras existentes e
   * 1.000 lidas nada foi cortado, e o campo ainda assim é `true`. Afirmar "há mais compras"
   * exigiria `count:'exact'`, que não se pede aqui. (2ª rodada do Codex — o nome anterior
   * prometia mais do que a medição sustenta, que é a própria classe que esta entrega combate.)
   *
   * O que ele compra: o cap DELIBERADO deixa de ser cap SILENCIOSO — quem consome pode dizer
   * que o `sim_score` pode ter saído de amostra parcial em vez de afirmá-lo como total.
   */
  amostraNoTeto: boolean;
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
 * Amostra de similaridade: clientes do mesmo `health_class` e o que compraram.
 *
 * Aqui o teto é de NEGÓCIO (custo da chamada), não o cap do transporte — por isso `.limit()`
 * e não `fetchAll`. O que muda em relação ao código anterior é o resto do contrato: a amostra
 * é pedida com `.order("id")` (antes o Postgres escolhia 100 quaisquer, e escolhia outros 100
 * na execução seguinte — o `sim_score` do mesmo cliente mudava sem nada ter mudado), o `error`
 * passa a LANÇAR, e a saturação vira campo em vez de silêncio.
 *
 * ⚠️ O QUE ESTA ENTREGA CONSERTA — e o que segue aberto (medido em prod 2026-08-21, psql-ro).
 *
 * `.order("id").limit(100)` NÃO é prefixo temporal: `farmer_client_scores.id` é UUID
 * `gen_random_uuid()`, então os 100 menores são amostra pseudoaleatória DETERMINÍSTICA, e a
 * reprodutibilidade é o ganho real do #1836. (A versão anterior deste comentário dizia
 * "provavelmente os mais antigos" — estava factualmente errado.)
 *
 * O defeito dominante era OUTRO: o cluster `critico` tem 6.185 linhas, das quais 5.406 (87%)
 * são `sales_history_status = 'sem_historico'` — cliente sem venda válida monetizada. A
 * amostra pegava ~42 dessas linhas vazias, que entravam no DENOMINADOR de `sim` e nunca no
 * numerador. Medido: dos 50 amostrados, 8 tinham qualquer compra; 321 linhas de compra; máximo
 * de 4 clientes por produto ⇒ `sim` máximo 0,04. Com o filtro: 749 linhas, 299 produtos,
 * máximo 9 ⇒ `sim` máximo 0,18. O conserto do denominador vive no consumidor
 * (`recommend/index.ts`) e só vale junto com este filtro: sozinhos, nenhum dos dois faz `sim`
 * cruzar 0,10 em `critico` (0,08 e 0,09 respectivamente).
 *
 * ⚠️ SEGUE ABERTO, nomeado para não passar por consertado (challenge Codex gpt-5.6-sol/xhigh):
 *   · AUTO-INCLUSÃO: o cliente que recebe a recomendação pode estar entre os 50 e contar no
 *     próprio denominador — falta leave-one-out com reposição da vaga;
 *   · o TETO PLANO de 1.000 compras MORDE hoje em `atencao` e `estavel` (1.000 exatas, medido).
 *     Como `order_items.id` também é UUID, o corte é amostra de LINHAS e não janela temporal:
 *     comprador pesado ocupa mais linhas e pode deixar outro cliente do cluster sem nenhuma
 *     linha observada — que o denominador então trata como "não comprou". O certo é agregar no
 *     banco (últimos K PEDIDOS por cliente, dedup `(cliente, produto)`) via RPC;
 *   · o cluster é global por `health_class` e ignora `farmer_id`, embora a coluna exista;
 *   · `TETO_CLUSTER_CLIENTES` (100) segue maior que a amostra de fato (50): lemos 100 e medimos
 *     sobre 50;
 *   · os cortes 0,10/0,15/0,20 de `recommend/index.ts` NÃO foram recalibrados. Com n=50 e
 *     comparação estrita eles exigem 6, 8 e 11 clientes distintos; o máximo medido depois do
 *     conserto é 9, então a explicação percentual (>0,20) segue inalcançável em `critico`.
 */
export async function carregarCluster(
  db: BancoPostgrest,
  healthClass: string,
): Promise<ClusterRecommend> {
  const clusterCustomers = exigirLista(
    await db.from<{ customer_user_id: string }>("farmer_client_scores")
      .select("customer_user_id")
      .eq("health_class", healthClass)
      .in("sales_history_status", CLUSTER_STATUS_COM_HISTORICO)
      .order("id", { ascending: true })
      .limit(TETO_CLUSTER_CLIENTES),
    "farmer_client_scores (cluster)",
  );

  const clusterUserIds = clusterCustomers.map((c) => c.customer_user_id);
  const usuariosAmostrados = clusterUserIds.slice(0, TETO_CLUSTER_USUARIOS_AMOSTRA);

  // `.in()` com lista vazia é round-trip inútil e, no PostgREST, a forma degenerada `in.()`.
  // Cluster vazio é estado legítimo (nenhum cliente naquele `health_class`).
  if (usuariosAmostrados.length === 0) {
    return { clusterUserIds, usuariosAmostrados, clusterPurchases: [], amostraNoTeto: false };
  }

  const clusterPurchases = exigirLista(
    await db.from<LinhaCompraCluster>("order_items")
      .select("product_id, customer_user_id")
      .in("customer_user_id", usuariosAmostrados)
      .order("id", { ascending: true })
      .limit(TETO_CLUSTER_COMPRAS),
    "order_items (cluster)",
  );

  return {
    clusterUserIds,
    usuariosAmostrados,
    clusterPurchases,
    amostraNoTeto: clusterPurchases.length >= TETO_CLUSTER_COMPRAS,
  };
}
