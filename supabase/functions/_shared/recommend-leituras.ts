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
import { fetchAll } from "./paginate.ts";
import type { BancoPostgrest } from "./paginate.ts";
import { exigirLeitura, exigirLista, FalhaLeituraCritica } from "./leitura-critica.ts";

/**
 * `fetchAll` com o erro em DOMÍNIO FECHADO.
 *
 * O helper canônico lança ``new Error(`${label}: ${error.message}`)`` — e `error.message` do
 * PostgREST encaminha o MESSAGE do Postgres, que pode interpolar valor de linha (`RAISE
 * EXCEPTION` com ID/CPF, erro de cast reproduzindo o valor inválido). O `catch` do
 * `Deno.serve` de `recommend/index.ts` devolve `error.message` no CORPO da resposta, então
 * esse texto SAI DA EDGE — é o "garantia de privacidade afirmada sem verificar o SINK" que
 * `leitura-critica.ts` documenta. (Achado pelo teste desta entrega, não pela leitura.)
 *
 * O texto original não some: vai para `cause`, que a resposta HTTP não serializa e que
 * sobrevive nos logs da edge. Envelopar aqui, e não em `paginate.ts`, é deliberado — mudar o
 * tipo lançado pelo helper mexeria nos 21 call-sites de `fetchAll`, e um deles
 * (`visit-score-recalc-client`) já RAMIFICA em `instanceof FalhaLeituraCritica`. Fechar a
 * classe no helper é entrega própria, não carona nesta.
 */
async function paginarFonte<T>(
  build: (
    de: number,
    ate: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string | null } | null }>,
  fonte: string,
): Promise<T[]> {
  // O erro é interceptado AQUI, antes de `fetchAll` vê-lo: o helper reduz a resposta a
  // ``new Error(`${label}: ${message}`)`` e o `code` do PostgREST (57014 timeout, 42501 RLS)
  // se perde no caminho. Interceptando na origem, o código sobrevive para a classificação
  // operacional e a mensagem PÚBLICA continua fechada (achado da 2ª rodada do Codex, que
  // corrigiu minha afirmação anterior de que "o original fica em `cause`" — não ficava).
  const comErroFechado = async (de: number, ate: number) => {
    const res = await build(de, ate);
    if (res.error) throw new FalhaLeituraCritica(fonte, res.error);
    return res;
  };
  try {
    return await fetchAll<T>(comErroFechado, fonte);
  } catch (e) {
    if (e instanceof FalhaLeituraCritica) throw e;
    // O que resta é o `data:null` sem erro, que `fetchAll` rejeita por conta própria — mesma
    // resposta malformada que `exigirLista` nomeia, então mesmo código.
    const falha = new FalhaLeituraCritica(fonte, { code: "MALFORMADA" });
    falha.cause = e;
    throw falha;
  }
}

// ── Formas das linhas (o que o `.select()` de cada leitura promete) ────────────────────

export interface LinhaConfig {
  key: string;
  value: number;
}

export interface LinhaOrderItem {
  product_id: string | null;
  quantity: number | null;
  unit_price: number | null;
}

export interface LinhaProduto {
  id: string;
  omie_codigo_produto: number;
  descricao: string;
  codigo: string;
  valor_unitario: number | null;
  estoque: number | null;
  familia: string | null;
  subfamilia: string | null;
}

export interface LinhaCusto {
  product_id: string;
  cost_price: number | null;
  cost_final: number | null;
  cost_source: string | null;
  cost_confidence: number | null;
}

export interface LinhaRegra {
  id?: string;
  antecedent_product_ids: string[] | null;
  consequent_product_ids: string[] | null;
  lift: number;
  confidence: number;
  support: number;
}

export interface LinhaClientScore {
  health_class: string | null;
  category_count: number | null;
}

export interface LinhaCompraCluster {
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

export interface ClusterRecommend {
  /** Os até `TETO_CLUSTER_CLIENTES` clientes do mesmo `health_class`. */
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
    paginarFonte<LinhaConfig>(
      (de, ate) =>
        db.from<LinhaConfig>("recommendation_config")
          .select("key, value")
          .order("id", { ascending: true })
          .range(de, ate),
      "recommendation_config",
    ),
    paginarFonte<LinhaOrderItem>(
      (de, ate) =>
        db.from<LinhaOrderItem>("order_items")
          .select("product_id, quantity, unit_price")
          .eq("customer_user_id", customerId)
          .order("id", { ascending: true })
          .range(de, ate),
      "order_items",
    ),
    paginarFonte<LinhaProduto>(
      (de, ate) =>
        db.from<LinhaProduto>("omie_products")
          .select("id, omie_codigo_produto, descricao, codigo, valor_unitario, estoque, familia, subfamilia")
          .eq("ativo", true)
          .order("id", { ascending: true })
          .range(de, ate),
      "omie_products",
    ),
    paginarFonte<LinhaCusto>(
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
    paginarFonte<LinhaRegra>(
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
 * ⚠️ O QUE ISTO **NÃO** CONSERTA, dito por extenso para não passar por consertado (challenge
 * Codex): `.order("id").limit(100)` não é AMOSTRAGEM — é o PREFIXO por PK. Dos 6.185 clientes
 * `critico` medidos em prod, saem sempre os mesmos 100, e provavelmente os mais antigos. O
 * ganho aqui é reprodutibilidade (o mesmo cliente recebe a mesma recomendação), não
 * representatividade; a regra de amostra continua indefinida e o viés, agora, é ESTÁVEL em vez
 * de aleatório. Trocar por amostra por hash/seed ou estratificada é decisão de produto sobre o
 * ranking — outro eixo que o desta entrega, que é truncagem de transporte.
 */
export async function carregarCluster(
  db: BancoPostgrest,
  healthClass: string,
): Promise<ClusterRecommend> {
  const clusterCustomers = exigirLista(
    await db.from<{ customer_user_id: string }>("farmer_client_scores")
      .select("customer_user_id")
      .eq("health_class", healthClass)
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
