// Detector da classe "single-shot que espera a tabela INTEIRA" — a metade TRUNCAGEM da
// irmã não-paginada da classe dos laços (money-path §6–§9).
//
// `supabase.from('fin_contas_pagar').select('*')` sem `.range()`/`.limit()` devolve as
// 1.000 primeiras linhas — a capa do PostgREST — SEM erro e SEM aviso. O laço artesanal ao
// menos declara a intenção de paginar; este nunca aparece num grep de `.range(`. A metade
// FALHA desta mesma irmã (a leitura que falha vira zero/vazio) já tem fiscal próprio
// (`leitura-single-shot-gate`, `erro-colapsado-em-vazio-gate`); a forma set-returning de
// `.rpc()` também (`rpc-set-returning-paginacao-gate`). Faltava a forma `.from()`.
//
// Puro (string → sítios): o gate em `src/__tests__/single-shot-truncado-gate.test.ts` faz
// o walk e a baseline; os testes deste arquivo calibram o predicado contra o fix real do
// #1471. Recebe fonte JÁ SEM COMENTÁRIOS (`removerComentarios`) — prosa que descreve o bug
// não pode disparar o fiscal (#1472/#1488).

/**
 * Tabelas com massa para a capa de 1.000 ser ALCANÇÁVEL — `pg_class.reltuples` medido via
 * psql-ro em 2026-10-10 (>500 linhas), mais algumas menores de crescimento ESTRUTURAL
 * (log, histórico, pedidos, catálogo sincronizado do Omie).
 *
 * Por NOME, de propósito: `.select()` sem paginar numa tabela de 12 linhas de config não é
 * defeito, e um gate que acusa isso ensina a ser ignorado (#1490). Tabela que cruzar o
 * limiar depois ENTRA aqui — e o gate passa a acusar os sítios que já existiam, que é o
 * alarme certo: o bug nasce quando o DADO cresce, não quando o código muda.
 */
export const TABELAS_RISCO: ReadonlySet<string> = new Set([
  // > 10k
  'tint_formula_itens', 'health_score_history', 'priority_score_log', 'tint_formulas',
  'radar_empresas', 'tint_staging_formula_itens', 'tint_staging_skus', 'tint_staging_formulas',
  'tint_sync_runs', 'tint_importacoes', 'fin_audit_log', 'tint_sync_errors', 'tint_staging_bases',
  'sales_price_history', 'fin_movimentacoes', 'order_items', 'visit_score_recalc_queue',
  'fin_contas_receber', 'carteira_positivacao_snapshot', 'cmc_snapshot', 'sales_orders',
  'tint_staging_produtos', 'fin_sync_log', 'tint_staging_corantes', 'farmer_recommendations',
  'deploy_atestacoes', 'fin_contas_pagar', 'omie_customer_account_map', 'margin_audit_log',
  'acoes_execucoes', 'omie_clientes_nao_vinculados',
  // 1k – 10k
  'omie_products', 'carteira_assignments', 'cliente_classificacao', 'gmail_webhook_log',
  'carteira_membership_ledger', 'venda_items_history', 'farmer_client_scores',
  'customer_visit_scores', 'addresses', 'deploy_sonda_resultados', 'deploy_sonda_disparos',
  'sync_reprocess_log', 'radar_municipios', 'municipio_geo', 'reposicao_teto_cobertura_log',
  'profiles', 'user_roles', 'tint_staging_embalagens', 'sku_leadtime_history', 'pcp_itens',
  'sku_parametros_historico', 'product_costs', 'inventory_position', 'pedido_compra_item',
  'reposicao_po_observado_item', 'pcp_malha_staging', 'pcp_custo_padrao_resultados',
  'cmc_ledger', 'customer_canonical_alias', 'reposicao_param_auto_log',
  'customer_preferred_items', 'ai_decisions', 'fin_projecao_snapshots',
  // 500 – 1k (a meia capa — o próximo trimestre de crescimento as leva para cima dela)
  'farmer_tactical_plans', 'purchase_orders_tracking', 'kb_chunks', 'reposicao_motor_run',
  'recommendation_log', 'pedido_compra_sugerido', 'reposicao_po_last_seen',
  'pcp_custo_excecoes', 'sku_parametros', 'pedido_total_liquido_conversoes', 'fin_categorias',
  // < 500 hoje, crescimento estrutural
  'omie_clientes', 'farmer_calls', 'tint_corantes', 'omie_servicos', 'fin_dre_snapshots',
  'fin_categoria_dre_mapping', 'fin_conciliacao', 'farmer_association_rules', 'nfe_recebimentos',
]);

/** Delimitadores de cardinalidade: presentes na expressão, a query NÃO pede "tudo". */
const DELIMITADORES = ['.range(', '.single(', '.maybeSingle('];
/** `{ head: true }` em qualquer formatação (o prettier quebra linha dentro do objeto). */
const HEAD_TRUE = /\bhead\s*:\s*true\b/;
/** `count: 'exact'` — com ele um `.limit(N)` vira truncagem HONESTA (o caller recebe o total). */
const COUNT_EXACT = /count\s*:\s*['"]exact['"]/;

/** Verbos de escrita — o `.select()` de retorno de write herda a cardinalidade do write. */
const ESCRITA = ['.insert(', '.update(', '.upsert(', '.delete('];

/**
 * `.eq()`/`.in()` sobre coluna de IDENTIDADE delimita semanticamente (uma linha, ou o
 * tamanho do chunk que o caller controla). Coluna CATEGÓRICA (`company`, `status`,
 * `empresa`, `ativo`, `role`) NÃO delimita — é justamente o filtro que dá a falsa
 * sensação de recorte enquanto devolve dezenas de milhares de linhas. Coluna de
 * RELACIONAMENTO também não: `.eq('omie_codigo_cliente', c)` sobre recebíveis pode passar
 * de 1.000 títulos, por isso cliente/CNPJ/documento ficam FORA (achado Codex).
 * Limite conhecido: `.in('id', lista)` é aceito supondo chunk ≤ 1.000 — o predicado não
 * enxerga o tamanho da lista.
 */
const EQ_IN_IDENTIDADE =
  /\.(?:eq|in)\(\s*['"](?:[a-z_]*_)?(?:id|ids|uuid|codigo_produto|codigo_servico|codigo_pedido|sku_codigo_omie|sku_omie|chave_acesso|hash[a-z_]*|numero_pedido|endpoint|key|slug)['"]/;

/** `ano` + `mes` juntos recortam UMA competência (um DRE de mês = unidades de linhas). */
const EQ_ANO = /\.eq\(\s*['"]ano['"]/;
const EQ_MES = /\.eq\(\s*['"]mes['"]/;

/**
 * O `.from(` dentro do callback de um helper canônico JÁ está delegado. Olha-se para trás
 * porque o `.range(de, ate)` costuma morar numa INSTRUÇÃO SEPARADA do callback
 * (`let q = supabase.from(...)…; return q.range(de, ate)`), fora da expressão isolada —
 * sem isto o gate marcaria como dívida o próprio código corrigido. Custo assumido: um
 * falso-NEGATIVO possível (sítio cru até 500 chars depois de uma chamada legítima ao
 * helper); falso-negativo é o erro barato aqui, falso-vermelho é o caro.
 */
const DELEGADO =
  /\b(?:fetchAllPages|fetchAll|buscarTodasPaginas|coletarPaginado|carregarRpcPaginada|paginateAll)\s*[<(]/g;

/** O `.from(` está DENTRO de uma chamada de helper ainda ABERTA (parênteses não fechados)?
 * Só assim é callback do helper — uma leitura crua logo DEPOIS de um `fetchAllPages(...)`
 * já encerrado não herda a delegação (achado Codex: a janela cega de 500 chars a escondia). */
function dentroDeHelperAberto(janela: string): boolean {
  let m: RegExpExecArray | null;
  DELEGADO.lastIndex = 0;
  let ultimo = -1;
  while ((m = DELEGADO.exec(janela)) !== null) ultimo = m.index;
  if (ultimo === -1) return false;
  let saldo = 0;
  for (const ch of janela.slice(ultimo)) {
    if (ch === '(') saldo++;
    else if (ch === ')') saldo--;
  }
  return saldo > 0;
}

export interface SitioSingleShot {
  linha: number;
  tabela: string;
  /** `.limit(N)` literal com N ≥ 1.000: truncagem NA capa, disfarçada de delimitador. */
  limitNaCapa: boolean;
}

/**
 * Posicional, não regex única: a expressão do supabase-js é multi-linha e encadeada, e um
 * `[^;]{0,600}` atravessa fronteiras erradas (o `}` de `{ ascending: true }` já quebrou o
 * isolamento por delimitador na varredura do #1580). Para cada `.from('<tabela de risco>')`:
 * expande até o `;` e recua até o `await` que inicia a instrução; classifica pelo que a
 * expressão CONTÉM.
 *
 * FORA do predicado, deliberadamente: builder montado em variável sem `await` na mesma
 * instrução (`let q = supabase.from(...)` — o `.range()` pode vir depois e o predicado não
 * tem como saber) e `.from(variavel)` (tabela desconhecida). Esses ficam como detecção
 * manual documentada no money-path.md.
 */
export function acharSingleShots(fonteSemComentarios: string): SitioSingleShot[] {
  const fonte = fonteSemComentarios;
  const achados: SitioSingleShot[] = [];
  let i = -1;
  while ((i = fonte.indexOf('.from(', i + 1)) !== -1) {
    const mTab = /^\.from\(\s*['"]([^'"]+)['"]/.exec(fonte.slice(i, i + 120));
    if (!mTab || !TABELAS_RISCO.has(mTab[1])) continue;
    if (dentroDeHelperAberto(fonte.slice(Math.max(0, i - 500), i))) continue;

    const janela = fonte.slice(Math.max(0, i - 400), i);
    if (!/await\s+[^;]*$/.test(janela)) continue;

    // A expressão classificada é SÓ a cadeia desta query: do `.from(` até o `;` ou o próximo
    // `.from(`/`.rpc(`. Sem o corte, num `Promise.all([q1, q2])` o `.in(...)` de q1 imunizava
    // q2 — remover o recorte de uma leitura não acusava nada (achado Codex, reproduzido no
    // useBaixoGiro).
    const fim = fonte.indexOf(';', i);
    let corte = fim === -1 ? Math.min(fonte.length, i + 1200) : fim;
    for (const prox of ['.from(', '.rpc(']) {
      const k = fonte.indexOf(prox, i + 6);
      if (k !== -1 && k < corte) corte = k;
    }
    const expr = fonte.slice(i, corte);

    if (!expr.includes('.select(')) continue;
    if (ESCRITA.some((v) => expr.includes(v))) continue;
    if (DELIMITADORES.some((d) => expr.includes(d))) continue;
    if (HEAD_TRUE.test(expr)) continue;

    // `.limit(N)` literal ≥ 1.000 é a capa disfarçada; qualquer outro `.limit(…)` —
    // inclusive `.limit(variavel)` — é janela que o caller controla.
    const mLimitLiteral = /\.limit\(\s*(\d+)\s*\)/.exec(expr);
    const limitNaCapa = mLimitLiteral != null && Number(mLimitLiteral[1]) >= 1000;
    if (/\.limit\(/.test(expr) && !limitNaCapa) continue;
    if (limitNaCapa && COUNT_EXACT.test(expr)) continue; // janela + total: truncagem honesta
    if (EQ_IN_IDENTIDADE.test(expr)) continue;
    if (EQ_ANO.test(expr) && EQ_MES.test(expr)) continue;

    achados.push({ linha: fonte.slice(0, i).split('\n').length, tabela: mTab[1], limitNaCapa });
  }
  return achados;
}
