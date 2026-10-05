// Registro do gate do universo de pedidos no TypeScript (`src/__tests__/universo-pedidos-ts-gate.test.ts`;
// o detector e a regra estão em `./universo-pedidos-ts.ts`).
//
// Aqui moram as leituras de `sales_orders` que NÃO aplicam o universo de VENDA — de propósito
// (lookup, sincronização, feed) ou por DÍVIDA medida (a correção está num PR por domínio). Toda
// leitura fora destas duas listas, e fora do par canônico, reprova o gate.
//
// Identidade = arquivo + forma (`SitioPedidos.forma`: os métodos da cadeia com a coluna de cada
// filtro, sem valores) + n (quantas vezes a forma aparece no arquivo). O registro só ENCOLHE:
// entrada cujo sítio sumiu, virou canônico ou mudou de forma reprova — a forma muda quando a
// PERGUNTA muda (um lookup que perde o `.eq('id')` vira outra pergunta e tem de ser reclassificado).
//
// Medido em 2026-10-01 (docs/historico/universo-pedidos-classe-ts.md): 61 sítios — 4 canônicos,
// 17 escritas, 1 complemento e 39 fora; destes, 22 de propósito (lookup, sincronização, feed) e 18
// de dívida. A dívida dos operacionais (10) foi quitada no PR seguinte ao do gate.

type Categoria =
  /** Lê UM pedido (ou os de uma chave) pela identidade: a pergunta é "qual é este pedido?", não "foi venda?". */
  | 'lookup'
  /** O importador/sincronização lê pela chave do Omie para reconciliar — cancelado inclusive. */
  | 'sincronizacao'
  /** Mostra ou conta TODO status por desenho (feed, sensor, lista de orçamentos). Esconde o apagado. */
  | 'proposito'
  /** Divergente medido; a correção está no PR do domínio indicado. Só encolhe. */
  | 'divida';

type Dominio = 'dashboard' | 'customer360' | 'ligacao' | 'proposta' | 'auditoria' | 'operacionais';

interface EntradaRegistro {
  arquivo: string;
  forma: string;
  /** Quantas vezes a forma aparece no arquivo (default 1). */
  n?: number;
  categoria: Categoria;
  motivo: string;
  /** Só em `divida`: o domínio cujo PR quita a entrada. */
  dominio?: Dominio;
  /**
   * Só em `proposito`: por que a leitura inclui o pedido APAGADO. Sem este campo, feed de propósito
   * exige `.is('deleted_at', null)` — o soft-delete some de toda tela (decisão do founder, 2026-10-01).
   */
  incluiApagado?: string;
}

export const REGISTRO: readonly EntradaRegistro[] = [
  // ── lookup ──────────────────────────────────────────────────────────────────────────────────
  { arquivo: 'src/components/salesOrders/useSalesOrderDetail.ts', forma: 'select·eq(id)·maybeSingle', categoria: 'lookup', motivo: 'detalhe de UM pedido por id (abre cancelado e orçamento também)' },
  { arquivo: 'src/components/salesOrderEdit/useSalesOrderEdit.ts', forma: 'select·eq(id)·single', categoria: 'lookup', motivo: 'edição de UM pedido por id' },
  { arquivo: 'src/pages/UnifiedOrder.tsx', forma: 'select·eq(id)·maybeSingle', categoria: 'lookup', motivo: 'retoma/edita UM pedido por id' },
  { arquivo: 'src/services/orderSubmission/idempotency.ts', forma: 'select·eq(checkout_id)·eq(account)·maybeSingle', categoria: 'lookup', motivo: 'idempotência do checkout: acha o pedido desta tentativa em qualquer status' },
  { arquivo: 'src/services/whatsappProposta/enviarProposta.ts', forma: 'select·eq(whatsapp_proposta_dedupe)·maybeSingle', categoria: 'lookup', motivo: 'dedupe da proposta: acha o orçamento já criado por ela' },
  { arquivo: 'src/hooks/usePedidosProgramados.ts', forma: 'select·eq(pedido_programado_envio_id)·not(omie_pedido_id)', categoria: 'lookup', motivo: 'o pedido gerado por UM envio programado' },
  { arquivo: 'src/hooks/usePedidosProgramados.ts', forma: 'select·in(id)·not(omie_pedido_id)', categoria: 'lookup', motivo: 'pedidos por ids' },
  { arquivo: 'src/hooks/useGlobalSearch.ts', forma: 'select·ilike(omie_numero_pedido)·limit', categoria: 'lookup', motivo: 'busca pelo NÚMERO do pedido: achar é a pergunta, o status aparece no resultado' },
  { arquivo: 'supabase/functions/pedido-programado-enviar/index.ts', forma: 'select·eq(pedido_programado_envio_id)·eq(account)·maybeSingle', n: 2, categoria: 'lookup', motivo: 'idempotência do envio programado (acha o pedido já criado)' },
  { arquivo: 'supabase/functions/pedido-programado-enviar/index.ts', forma: 'select·eq(id)·maybeSingle', categoria: 'lookup', motivo: 'UM pedido por id' },
  // ── sincronização ───────────────────────────────────────────────────────────────────────────
  { arquivo: 'supabase/functions/omie-vendas-sync/index.ts', forma: 'select·in(hash_payload)', categoria: 'sincronizacao', motivo: 'dedup do importador por hash do payload' },
  { arquivo: 'supabase/functions/omie-vendas-sync/index.ts', forma: 'select·eq(account)·eq(omie_pedido_id)', categoria: 'sincronizacao', motivo: 'reconcilia pela chave do Omie' },
  { arquivo: 'supabase/functions/omie-vendas-sync/index.ts', forma: 'select·eq(id)·maybeSingle', categoria: 'sincronizacao', motivo: 'UM pedido por id (criar/alterar no Omie)' },
  { arquivo: 'supabase/functions/omie-vendas-sync/index.ts', forma: 'select·eq(id)·single', n: 2, categoria: 'sincronizacao', motivo: 'UM pedido por id (criar/alterar no Omie)' },
  { arquivo: 'supabase/functions/omie-desconto-backfill/index.ts', forma: 'select·eq(account)·in(hash_payload)', categoria: 'sincronizacao', motivo: 'backfill de desconto casa o pedido pelo hash' },
  { arquivo: 'supabase/functions/omie-desconto-backfill/index.ts', forma: 'select·is(desconto_valor)·eq(sales_orders.account)·gte(sales_orders.order_date_kpi)', categoria: 'sincronizacao', motivo: 'alvo do backfill de desconto (denominador da cobertura): apura TODO item da janela, cancelado inclusive — o dado é do item, não da venda' },
  // ── propósito ───────────────────────────────────────────────────────────────────────────────
  { arquivo: 'src/hooks/dashboard/useSistemaZone.ts', forma: 'select·order(created_at)·limit·maybeSingle', categoria: 'proposito', motivo: 'sinal de vida do sistema: a linha mais recente, de qualquer status', incluiApagado: 'mede INSERÇÃO de linha, e o pedido apagado depois também foi inserido' },
  { arquivo: 'src/hooks/useTeamKpis.ts', forma: 'select·is(deleted_at)·gte(created_at)·eq(account)', categoria: 'proposito', motivo: 'atividade de vendedor (quem CRIOU pedido em 7d): orçamento é atividade; a receita do mesmo hook vem de fetchPedidosMTD' },
  { arquivo: 'supabase/functions/omie-analytics-sync/index.ts', forma: 'select·is(status)·is(deleted_at)', categoria: 'proposito', motivo: 'sensor de qualidade, pré-condição do Apriori: conta pedido com status NULO' },
  { arquivo: 'supabase/functions/omie-analytics-sync/index.ts', forma: 'select·is(account)·is(deleted_at)', categoria: 'proposito', motivo: 'sensor de qualidade, pré-condição do Apriori: conta pedido com conta NULA' },
  { arquivo: 'src/hooks/dashboard/useBriefDeltas.ts', forma: 'select·gte(created_at)·is(deleted_at)', categoria: 'proposito', motivo: 'conta os pedidos novos que o feed (/sales) mostra: todo status, sem o apagado' },
  { arquivo: 'src/components/adminCustomers/useAdminCustomers.ts', forma: 'select·eq(customer_user_id)·is(deleted_at)·order(created_at)·limit', categoria: 'proposito', motivo: 'feed de pedidos do cliente no admin, com badge de status' },
  { arquivo: 'src/pages/SalesQuotes.tsx', forma: 'select·eq(status)·is(deleted_at)·order(created_at)', categoria: 'proposito', motivo: 'a lista de ORÇAMENTOS (`eq(status,orcamento)`): o complemento do universo, de propósito' },
  // ── dívida (2026-10-01) — cada PR de domínio quita as suas ──────────────────────────────────
  { arquivo: 'src/lib/dashboard/fetch-pedidos-mtd.ts', forma: 'select·is(deleted_at)·gte(order_date_kpi)·lt(order_date_kpi)·order(id)·range·eq(account)', categoria: 'divida', dominio: 'dashboard', motivo: 'receita MTD e ranking: universo de team-kpis (NOT IN cancelado,rascunho) aplicado em memória' },
  { arquivo: 'src/hooks/dashboard/useVendasZone.ts', forma: 'select·is(deleted_at)·gte(order_date_kpi)·lt(order_date_kpi)', categoria: 'divida', dominio: 'dashboard', motivo: 'faturado hoje/ontem: mesmo isPedidoValido; erro engolido vira R$ 0' },
  { arquivo: 'src/components/customer360/hooks.ts', forma: 'select·eq(customer_user_id)·order(created_at)·limit', categoria: 'divida', dominio: 'customer360', motivo: 'faturamento 12m sem status nem deleted_at, e o limit(200) esconde 55–72% nos 3 maiores clientes' },
  { arquivo: 'src/hooks/useHistoricoCompras.ts', forma: 'select·eq(customer_user_id)·is(deleted_at)·order(order_date_kpi)·limit', categoria: 'divida', dominio: 'ligacao', motivo: 'preço praticado: filtra status DEPOIS do limit(50) — 11 clientes perdem pedido válido' },
  { arquivo: 'src/hooks/useMunicaoLigacao.ts', forma: 'select·eq(customer_user_id)·is(deleted_at)·order(created_at)·limit', categoria: 'divida', dominio: 'ligacao', motivo: 'munição: filtra status DEPOIS do limit(16)' },
  { arquivo: 'supabase/functions/algorithm-a-audit/index.ts', forma: 'select·not(deleted_at)·order(id)·range', categoria: 'divida', dominio: 'auditoria', motivo: 'complemento sem o par: a leitura de status é literal (cancelado,orcamento)' },
  { arquivo: 'supabase/functions/algorithm-a-audit/index.ts', forma: 'select·in(status)·order(id)·range', categoria: 'divida', dominio: 'auditoria', motivo: 'exclui só cancelado/orcamento: rascunho e pendente contam como praticado' },
];

/**
 * Teto da dívida: IGUAL ao número de entradas `divida` (o G4 exige a igualdade). Só desce — quem
 * quita uma entrada baixa o teto no mesmo diff; subir é reabrir a classe, e o diff é a conversa.
 */
export const TETO_DIVIDA = 7;

interface ConstanteDivida {
  arquivo: string;
  /**
   * Os membros da autoridade que a cópia contém, normalizados, em ordem e separados por vírgula
   * (`ConstanteParalela.membros.join(",")`). STRING e não array de propósito: um array de status
   * aqui seria, ele mesmo, a cópia que o G5 procura.
   */
  membros: string;
  dominio: Dominio;
  motivo: string;
}

/** Constantes paralelas à autoridade ainda vivas — cada PR de domínio apaga a sua. Só encolhe. */
export const CONSTANTES_DIVIDA: readonly ConstanteDivida[] = [
  { arquivo: 'src/lib/dashboard/team-kpis.ts', membros: 'cancelado,rascunho', dominio: 'dashboard', motivo: 'ORDER_STATUS_INVALIDOS' },
  { arquivo: 'src/lib/financeiro/valor-cockpit-helpers.ts', membros: 'cancelado,rascunho', dominio: 'dashboard', motivo: 'STATUS_NAO_FATURAVEL (dizia espelhar o v_caca, que o #2726 tornou canônico)' },
  { arquivo: 'supabase/functions/fin-valor-cockpit/index.ts', membros: 'cancelado,rascunho', dominio: 'dashboard', motivo: 'STATUS_NAO_FATURAVEL, espelho do helper' },
  { arquivo: 'src/hooks/useHistoricoCompras.ts', membros: 'cancelado,orcamento,rascunho', dominio: 'ligacao', motivo: 'STATUS_INVALIDOS (sem pendente; cancelado_humano é vocabulário da reposição)' },
  { arquivo: 'src/hooks/useMunicaoLigacao.ts', membros: 'cancelado,orcamento,rascunho', dominio: 'ligacao', motivo: 'STATUS_INVALIDOS, cópia do anterior' },
  { arquivo: 'supabase/functions/algorithm-a-audit/index.ts', membros: 'cancelado,orcamento', dominio: 'auditoria', motivo: 'literal do .in(status) do conjunto de exclusão' },
];

export const TETO_CONSTANTES_DIVIDA = 6;
