/**
 * Identidade do item de pedido contra o catálogo — a fronteira account-aware dos motores Farmer.
 *
 * Por que existe: `useBundleEngine` e `useCrossSellEngine` montam o basket que alimenta o
 * Apriori a partir de `sales_orders.items` (jsonb), e resolviam o item de duas formas
 * FROUXAS — ambas com a mesma raiz: tratar a identidade do produto como global num domínio
 * que é account-aware (o grupo tem 3 empresas: colacor, oben, colacor_sc).
 *
 *   1. `omie_codigo_produto` era resolvido num `Map<number, string>` GLOBAL, montado sobre o
 *      catálogo ativo das DUAS contas. Mas a identidade no banco é o PAR: `omie_products` tem
 *      `UNIQUE (omie_codigo_produto, account)` — o código sozinho NÃO é único por construção.
 *      Um mesmo código vivendo em duas contas fazia o `Map.set` sobrescrever, e o vencedor era
 *      a ordem de paginação (`.order('id')`): arbitrária, silenciosa, e capaz de associar o
 *      item da empresa A ao SKU da empresa B — sinal de venda money-path com o tenant errado.
 *   2. `product_id` entrava DIRETO no basket, sem confronto nenhum: nem com o catálogo ativo
 *      (que o caminho do código já respeitava, porque o Map só continha ativos), nem com a
 *      conta. Duas portas para a mesma casa, uma trancada e a outra escancarada.
 *
 * ⚠️ Isto é hardening de risco LATENTE, não correção de dano vivo — e a distinção é
 * declarada de propósito. Medição em produção (psql-ro, 20/08/2026, 47.798 itens dos 20.645
 * pedidos que o motor lê): ZERO itens resolvem cross-account (medido contra o catálogo ativo
 * E contra o catálogo inteiro), ZERO itens carregam `product_id`, e as faixas de código são
 * disjuntas por conta (colacor 394.035.817–5.180.460.271; oben 8.689.717.555–12.163.673.823).
 * O guard é INERTE no dado de hoje — de propósito. O que ele fecha é o estado que o SCHEMA
 * autoriza e nada no código impedia: primeiro código ativo compartilhado entre contas, ou
 * primeiro item de status lido com identidade divergente. Reabrir a discussão quando um dos
 * dois aparecer — o contador `conta_divergente` abaixo existe justamente para avisar.
 *
 * Precisão > recall: item que não resolve com CONFIANÇA sai do basket, não entra com palpite.
 */

/** Linha do catálogo ativo (`omie_products` com `ativo = true`) que o índice consome. */
export interface ProdutoCatalogoAtivo {
  id: string;
  /** `omie_products.account`. Metade da chave de identidade — sem ela não há qualificação. */
  account?: string | null;
  omie_codigo_produto: number | string | null;
}

/** Item de `sales_orders.items` — em prod traz só `omie_codigo_produto` (pt-BR do Omie). */
export interface ItemPedidoIdentificavel {
  product_id?: string;
  omie_codigo_produto?: number | string;
}

/**
 * Por que o item SAIU do basket. Separar `conta_divergente` de `fora_do_catalogo_ativo` é o
 * ponto do sensor: o segundo é o regime NORMAL e farto (39,9% dos itens em prod são SKU
 * inativo da própria conta — descarte legítimo e já conhecido), enquanto o primeiro é o
 * estado que este arquivo existe para impedir, e hoje vale ZERO. Um contador só, somando os
 * dois, seria cego para a divergência exatamente como o "rótulo com DEFAULT constante" que o
 * money-path §5 proíbe: farto o bastante para nunca chamar atenção.
 */
// Não exportado: os consumidores comparam contra o literal e falam em `ResolucaoItem`.
// Exportar sem consumidor faz o gate de dead-code (knip) reprovar no CI — e o
// `bun run test` local NÃO cobre esse gate (o health stack sim).
type MotivoDescarteItem = 'sem_identificador' | 'conta_divergente' | 'fora_do_catalogo_ativo';

export type ResolucaoItem =
  | { readonly ok: true; readonly productId: string }
  | { readonly ok: false; readonly motivo: MotivoDescarteItem };

/** Chave de conta. `undefined` e `null` colapsam em `null` — ausência é UM estado, não coringa. */
type ChaveConta = string | null;

export interface IndiceCatalogoAtivo {
  /** conta → (código Omie → product UUID). Espelha `UNIQUE (omie_codigo_produto, account)`. */
  readonly porContaECodigo: Map<ChaveConta, Map<number, string>>;
  /** product UUID → conta do produto. Só contém SKU ATIVO: ausência aqui já é descarte. */
  readonly contaDoProduto: Map<string, ChaveConta>;
  /** Todo código ativo, de qualquer conta — discrimina "conta errada" de "fora do catálogo". */
  readonly codigosAtivos: Set<number>;
}

/**
 * Normaliza só a AUSÊNCIA (`undefined` → `null`), nunca a caixa.
 *
 * Baixar `OBEN` para `oben` aqui fundiria no browser dois estados que o banco considera
 * distintos (`account` é `text` e o UNIQUE é case-sensitive) — seria o leitor inventando uma
 * regra de domínio que o writer não garante. Se a normalização for regra, o lugar dela é um
 * CHECK/normalização na escrita, não uma tolerância no consumidor.
 */
const chaveConta = (account: string | null | undefined): ChaveConta => (account == null ? null : account);

/** Código Omie utilizável: `Number` de `null`/`''` é `0`, e `0` não é código — ausente ≠ zero. */
function codigoUtilizavel(codigo: number | string | null | undefined): number | null {
  if (codigo == null || codigo === '') return null;
  const n = Number(codigo);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Indexa o catálogo ATIVO pelo par (conta, código) — a mesma chave que o banco declara única. */
export function indexarCatalogoAtivo(produtos: readonly ProdutoCatalogoAtivo[]): IndiceCatalogoAtivo {
  const porContaECodigo = new Map<ChaveConta, Map<number, string>>();
  const contaDoProduto = new Map<string, ChaveConta>();
  const codigosAtivos = new Set<number>();

  for (const p of produtos) {
    const conta = chaveConta(p.account);
    contaDoProduto.set(p.id, conta);
    const cod = codigoUtilizavel(p.omie_codigo_produto);
    if (cod == null) continue;
    codigosAtivos.add(cod);
    let daConta = porContaECodigo.get(conta);
    if (!daConta) {
      daConta = new Map<number, string>();
      porContaECodigo.set(conta, daConta);
    }
    daConta.set(cod, p.id);
  }

  return { porContaECodigo, contaDoProduto, codigosAtivos };
}

/**
 * Resolve UM item para o product UUID do catálogo ativo DA CONTA DO PEDIDO.
 *
 * `product_id` presente é a identidade DECLARADA do item: se ela não confere, o item sai —
 * NÃO há fallback para o `omie_codigo_produto`. Dois identificadores discordando é ambiguidade,
 * e ambiguidade em money-path resolve-se descartando, não escolhendo o que der certo.
 */
export function resolverItemNoCatalogo(
  item: ItemPedidoIdentificavel,
  contaDoPedido: string | null | undefined,
  indice: IndiceCatalogoAtivo,
): ResolucaoItem {
  const conta = chaveConta(contaDoPedido);

  if (item.product_id) {
    const contaDoSku = indice.contaDoProduto.get(item.product_id);
    // Ausente do índice = inexistente OU inativo. O índice só conhece o catálogo ativo, e a
    // garantia do writer (grava `product_id` do catálogo da conta, ativo) é do INSTANTE da
    // gravação: nada impede o SKU de ser desativado depois que o pedido já existe.
    if (contaDoSku === undefined) return { ok: false, motivo: 'fora_do_catalogo_ativo' };
    if (contaDoSku !== conta) return { ok: false, motivo: 'conta_divergente' };
    return { ok: true, productId: item.product_id };
  }

  const cod = codigoUtilizavel(item.omie_codigo_produto);
  if (cod == null) return { ok: false, motivo: 'sem_identificador' };

  const productId = indice.porContaECodigo.get(conta)?.get(cod);
  if (productId) return { ok: true, productId };
  // O código existe no catálogo ativo, mas de OUTRA conta: é exatamente o casamento errado
  // que o Map global fazia em silêncio. Sai, e sai CONTADO.
  if (indice.codigosAtivos.has(cod)) return { ok: false, motivo: 'conta_divergente' };
  return { ok: false, motivo: 'fora_do_catalogo_ativo' };
}
