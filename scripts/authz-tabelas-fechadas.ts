/**
 * authz-tabelas-fechadas.ts — allowlist CURADA de tabelas fechadas por PRIVILÉGIO.
 * ============================================================================================
 *
 * Fonte de verdade única do gate estático (scripts/lib/authz-grants.ts → Parte C do authz:check)
 * e do audit de prod (db/audit-grants-tabelas-fechadas.ts). Vigia SÓ as tabelas listadas aqui.
 *
 * NÃO é varredura em massa: o grant DML amplo do Supabase (arwdDxtm a anon/authenticated em toda
 * relação nova) é o MODELO da plataforma — inócuo sob RLS + security_invoker (database.md §7).
 * Só entra aqui a tabela que foi DELIBERADAMENTE fechada por REVOKE + GRANT SELECT + policy.
 *
 * Como adicionar uma tabela: (1) confirme que ela foi fechada por privilégio; (2) declare o
 * `permitido` por role — o que NÃO estiver na lista é proibido (allowlist, fail-closed); (3)
 * quando a migration de fecho estiver no repo, aponte `fechadaPor` para o arquivo dela. Enquanto
 * o fecho não mergeou, deixe `fechadaPor: null` (o gate avisa; ver GrantCodigo FECHO_PENDENTE).
 *
 * ⚠️ `permitido` é TABLE-LEVEL — é o que as duas guardas medem (`has_table_privilege` no audit de
 * prod, statement `GRANT` no gate estático). GRANT de COLUNA é invisível para ambas. Não se
 * declara aqui "o que a role consegue ler", e sim "que privilégio de TABELA ela pode ter". Em
 * sales_orders os dois divergem por desenho: `has_table_privilege(authenticated,…,'SELECT')` é
 * FALSE e mesmo assim o front lê 25 colunas. Declarar a partir da leitura efetiva inverteria a
 * entrada — permitiria o SELECT table-level (que é justamente o vetor proibido) e proibiria o
 * INSERT/DELETE que as policies exigem.
 *
 * Estado medido em prod via psql-ro (2026-08-13, 20:51 e 22:36 UTC; pg 17.6) — as três DIFEREM:
 *   omie_products → anon AUSENTE do relacl, authenticated=r, 1 policy staff  ⇒ FECHADA (âncora ok)
 *   product_costs → anon=arwdDxtm, authenticated=arwdDxtm                    ⇒ ainda ABERTA
 *   sales_orders  → anon=ad, authenticated=ad + SELECT/UPDATE por COLUNA     ⇒ FECHADA por coluna
 *                   (o `ad` de anon é sobra do default — ver o motivo da entrada)
 *
 * A medição original desta allowlist (2026-07-22) viu as DUAS abertas e nasceu com fechadaPor=null
 * nas duas. No dia seguinte o fecho de omie_products mergeou (PR #1558) e foi aplicado — e a âncora
 * nunca foi declarada, porque este arquivo ficou 3 semanas numa branch órfã. É literalmente o
 * ANCORA_NAO_DECLARADA que o §5.2 do design existe para impedir: tabela fechada em prod, gate
 * inerte, silêncio indistinguível de tudo-em-ordem. A entrada abaixo já entra corrigida.
 */

export type Priv =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN'; // MAINTAIN: Postgres 17+

export interface TabelaFechada {
  /** Migration que FECHOU a tabela (âncora, nome do arquivo em supabase/migrations/).
   *  null = fecho declarado PENDENTE (ainda não mergeado). */
  fechadaPor: string | null;
  /** Privilégios PERMITIDOS por role. Ausente da lista = proibido (allowlist de privilégio). */
  permitido: { anon: Priv[]; authenticated: Priv[] };
  /** Só para a tabela fechada POR COLUNA: as colunas em que um GRANT de COLUNA é permitido, por role e
   *  privilégio. O GRANT por coluna passa só se TODA coluna estiver aqui; sem esta lista, ele conta como
   *  privilégio de TABELA (o estrito de sempre). Ausente da lista = proibido. */
  colunasPermitidas?: Partial<Record<'anon' | 'authenticated', Partial<Record<Priv, string[]>>>>;
  motivo: string;
}

export const AUTHZ_TABELAS_FECHADAS: Record<string, TabelaFechada> = {
  'public.product_costs': {
    fechadaPor: '20260725130000_authz_custo_fu4f_fase3_fecha_product_costs.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'custo unitário — fechada pelo PR #1520 (FU4-F fase 3). A âncora entra JUNTO com a migration de ' +
      'fecho: enquanto ela não for aplicada, prod segue ABERTA (anon=arwdDxtm, medido por psql-ro em ' +
      '2026-08-13) e quem protege é só a RLS (2 policies staff) — a divergência que o audit de grants ' +
      'acusar contra prod até o apply é REAL, não ruído do gate. Leitura por private.cap_custo_ler; ' +
      'escrita exclusiva de service_role (sync-reprocess, omie-analytics-sync). ORDEM DE APPLY: o ' +
      'PR #1543 (get_carteira_margem_faixa) vai a produção ANTES — as precondições fail-closed no topo ' +
      'de 20260725130000 abortam sem ele, porque useFarmerScoring ainda leria product_costs direto.',
  },
  'public.omie_products': {
    fechadaPor: '20260727140000_authz_preco_fecha_omie_products.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'preço de tabela (valor_unitario) — fechada pelo PR #1558, APLICADA em prod (conferido por ' +
      'psql-ro 2026-08-13: anon fora do relacl, authenticated=r). Leitura por staff (policy ' +
      'omie_products_select_staff, master OR employee); escrita exclusiva de service_role (edges de sync do Omie). ' +
      'SEM policy de escrita, por desenho — nem employee nem master escrevem via API.',
  },
  'public.sales_orders': {
    fechadaPor: '20260724120000_authz_sales_orders_split_escrita_fu4.sql',
    permitido: { anon: [], authenticated: ['INSERT', 'DELETE'] },
    // O attacl de prod (psql-ro, 2026-09-30) + as 2 colunas do canal que a 20261001100000 abriu: coluna
    // nova não herda GRANT por coluna, e o funil (get_whatsapp_funil, INVOKER) e a releitura do orçamento
    // da proposta davam "permission denied" para o staff (docs/historico/provas-canal-revividas.md).
    // omie_payload/omie_response NUNCA entram no SELECT — eram o motivo do fecho. omie_reconciliado_em entrou pela
    // 20261010210000: o motor de compras (INVOKER) a lê, e o botão "Recalcular" roda como o staff.
    colunasPermitidas: {
      authenticated: {
        SELECT: [
          'account', 'atendimento_id', 'checkout_id', 'created_at', 'created_by', 'customer_address',
          'customer_document', 'customer_phone', 'customer_user_id', 'deleted_at', 'discount',
          'hash_payload', 'id', 'items', 'notes', 'omie_numero_pedido', 'omie_pedido_id', 'omie_reconciliado_em',
          'order_date_kpi', 'origem', 'pedido_programado_envio_id', 'ready_by_date', 'status',
          'subtotal', 'total', 'updated_at', 'whatsapp_conversation_id', 'whatsapp_proposta_dedupe',
        ],
        UPDATE: [
          'customer_address', 'customer_document', 'customer_phone', 'deleted_at', 'items', 'notes',
          'omie_payload', 'ready_by_date', 'status', 'subtotal', 'total',
        ],
      },
    },
    motivo:
      'pedido de venda (money-path) — fechada por privilégio de COLUNA, modelo distinto das outras duas ' +
      'entradas, em DUAS etapas: (1) 20260709163500 (PR0.0-bis) trocou o SELECT table-level pelo SELECT ' +
      'de 25 colunas, deixando omie_payload/omie_response de fora; (2) 20260724120000 (FU4, a âncora — é ' +
      'ela que estabelece o contrato declarado aqui) trocou o UPDATE table-level pelo UPDATE de 11 colunas ' +
      'e revogou TRUNCATE,REFERENCES,TRIGGER,MAINTAIN. A FU4 usa REVOKE UPDATE e JAMAIS REVOKE ALL, de ' +
      'propósito: REVOKE table-level derruba junto os grants de coluna do PR0.0-bis. ' +
      'INSERT e DELETE table-level são LEGÍTIMOS e exercidos pelo front como authenticated, sob policy ' +
      '(cap_pedido_escrever): insert em orderSubmission/{submitQuote,idempotency} e whatsappProposta/' +
      'enviarProposta; delete de orçamento em SalesQuotes.tsx (a policy exige omie_pedido_id IS NULL). ' +
      'SELECT e UPDATE table-level ficam FORA do permitido por serem o vetor de reabertura, não por ' +
      'ausência de uso: reemitir GRANT SELECT ON public.sales_orders TO authenticated reabre payload/' +
      'response, e GRANT UPDATE table-level contorna a allowlist de coluna (RLS filtra LINHA, não coluna). ' +
      'Medido por psql-ro 2026-08-13 22:36 UTC: relacl anon=ad, authenticated=ad; has_table_privilege ' +
      'confirma SELECT/UPDATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN=NAO nas duas roles; authenticated com ' +
      'SELECT em 25 colunas e UPDATE em 11 (attacl). ' +
      '⚠️ anon=ad DIVERGE deste contrato e authz:grants:prod acusa DRIFT_PROD por isso — é achado real, ' +
      'não ruído: os REVOKE de anon cobriram SELECT (jul/09) e UPDATE+higiene (jul/24) e nunca alcançaram ' +
      'INSERT/DELETE, que seguem do default arwdDxtm do Supabase. Inócuo HOJE (as 5 policies são TO ' +
      'authenticated ⇒ anon casa 0 linhas), mas é o mesmo hazard F1 que motivou o REVOKE SELECT FROM anon: ' +
      'uma policy anon futura o converte em escrita real. Fecha com REVOKE INSERT, DELETE ON ' +
      'public.sales_orders FROM anon; até lá o alarme fica de pé, por desenho.',
  },
  'public.deploy_atestacoes': {
    // Registrada DEPOIS do apply, de propósito. O #2199 tentou registrar JUNTO com a migration e o
    // CI ficou vermelho sem remédio: o contrato mudou (CARIMBO_CONTRATO_MUDOU), mas re-medir prod
    // era impossível — a tabela não existia lá ainda e o audit crashava em `relation does not
    // exist` (exit 2, carimbo não grava). Ordem que funciona: migration mergeia → founder cola →
    // psql-ro confirma o objeto → allowlist + carimbo no MESMO commit.
    fechadaPor: '20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'ledger de atestação de deploy de edge (qual bundle (versao, fonte) prod respondeu, copiado de ' +
      'net._http_response pelo cron deploy-atestacoes-colher). NÃO é money-path: é o instrumento que ' +
      'DECIDE deploy (`bun run pendencias:deploy`) — escrita aberta deixaria qualquer usuário FABRICAR ' +
      'atestação. Só o cron (postgres, dono) escreve; authenticated lê por policy de staff. Nasce ' +
      'fechada na própria migration (REVOKE ALL por NOME de anon/authenticated + GRANT SELECT a ' +
      'authenticated). Medido por psql-ro 2026-09-05 22:41 UTC, após o apply: relacl anon AUSENTE, ' +
      'authenticated=r, rls=on, 2 policies; has_table_privilege = SIM só em authenticated/SELECT nos ' +
      '8 privilégios × 2 roles.',
  },
  // Tintométrico — catálogo de fórmulas fechado à escrita de staff pela API (PR #2941). Registradas
  // DEPOIS do apply (tentativa #344 do db:aplicar, 2026-10-11 12:09 UTC), na ordem que o #2199
  // ensinou: com prod já fechada, o carimbo mede o contrato novo em vez de acusar a véspera.
  'public.tint_formulas': {
    fechadaPor: '20261011120000_tint_grants_escrita_staff.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'catálogo de fórmulas (money-path: o preco_final_sayersystem dos tombstones da Fase 5 é o piso do ' +
      'tint_gate_revalida e o rótulo do balcão). Challenge Codex sobre o #2915: com escrita de staff, um INSERT ' +
      'de linha ATIVA na subcoleção \'1\' numa chave sem legado "fabricava tabela" e derrubava o piso do calculado ' +
      'para ela (o trigger do #2915 só olha o carimbo). O app só LÊ; os writers são RPCs SECURITY DEFINER do ' +
      'postgres (tint_promote_sync_run, tint_apply_keys_snapshot). Medido por psql-ro após o apply: anon nada, ' +
      'authenticated só SELECT nos 8 privilégios.',
  },
  'public.tint_formula_itens': {
    fechadaPor: '20261011120000_tint_grants_escrita_staff.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'receita das fórmulas — qtd_ml entra no v_calc, e o piso do gate é LEAST(v_calc, …): staff que baixa a dose ' +
      'baixa o piso (P1-a do Codex). Nenhuma FK a referencia, então o TRUNCATE do grant default (que não passa por ' +
      'RLS) apagaria TODA receita. Só o promote (SECURITY DEFINER) escreve.',
  },
  'public.tint_subcolecoes': {
    fechadaPor: '20261011120000_tint_grants_escrita_staff.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'a view canônica só lê o tombstone na subcoleção id_subcolecao_sayersystem=\'1\' — escrever aqui move o ' +
      'conjunto do max() do preco_csv_legado (o #2915 barra o rename da \'1\' por trigger; isto fecha o resto). ' +
      'O único writer é o promote (SECURITY DEFINER, ON CONFLICT DO NOTHING). Leitura por "Authenticated can view".',
  },
  'public.tint_corantes': {
    fechadaPor: '20261011120000_tint_grants_escrita_staff.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    // TintMapping.tsx:411 remapeia o corante para outro produto Omie — a ÚNICA escrita de staff aqui.
    // volume_total_ml fica de fora de propósito: entra no custo por ml do corante (v_calc).
    colunasPermitidas: { authenticated: { UPDATE: ['omie_product_id'] } },
    motivo:
      'cadastro de corante — volume_total_ml e omie_product_id entram no custo do corante (v_calc), e o piso ' +
      'do gate é LEAST(v_calc, …). Fecha o volume; o remapeamento (omie_product_id) segue aberto por ser a ' +
      'função legítima do TintMapping — RESIDUAL declarado no PR #2941: um remapeamento para Omie mais barato ' +
      'ainda move v_calc, e o que cabe ali é trilha de auditoria (decisão de produto), não revogação.',
  },
  // Margem por cliente e do plano tático — FU4-F (#3072, #3084). Registradas DEPOIS do apply das duas B
  // (db:aplicar, recibos #505 e #506, 2026-10-18), na ordem do #2199: com prod já fechada, o carimbo mede o
  // contrato novo. Fechadas por COLUNA: o SELECT table-level saiu e voltou só nas colunas que não são margem.
  'public.farmer_client_scores': {
    fechadaPor: '20261014120100_fcs_margem_fecha_coluna.sql',
    permitido: { anon: [], authenticated: [] },
    colunasPermitidas: {
      authenticated: {
        SELECT: [
          'answer_rate_60d', 'avg_monthly_spend_180d', 'avg_repurchase_interval', 'calculated_at',
          'category_count', 'churn_risk', 'created_at', 'customer_user_id', 'days_since_last_purchase',
          'eff_score', 'expansion_score', 'farmer_id', 'g_score', 'health_class', 'health_score', 'id',
          'itens_com_custo', 'itens_sem_custo', 'last_signal_recalc_at', 'm_score', 'priority_score',
          'recover_score', 'revenue_potential', 'rf_score', 's_score', 'sales_history_status',
          'signal_modifiers', 'updated_at', 'whatsapp_reply_rate_60d', 'x_score',
        ],
      },
    },
    motivo:
      'margem bruta por cliente (gross_margin_pct, money-path) — fechada por privilégio de COLUNA pela B do ' +
      '#3072: REVOKE SELECT de tabela + GRANT SELECT das 30 colunas restantes; a margem só sai pela RPC ' +
      'get_scores_margem, sob private.cap_custo_ler. NUNCA reemitir GRANT SELECT ON public.farmer_client_scores ' +
      'TO authenticated (table) — reabre a margem. Coluna nova nasce sem SELECT: conceder na migration que a cria. ' +
      'Writers são service_role (calculate-scores, scoring-recalc-client); o front não escreve. ' +
      '⚠️ Medido por psql-ro após o apply (2026-10-18): authenticated=awdDxtm e anon=awdDxtm (sobra do default ' +
      'do Supabase) DIVERGEM deste contrato. authz:grants:prod rotula isso NAO_APLICADA (a heurística vê ' +
      'INSERT/UPDATE/DELETE sobrando e supõe o default intacto), mas a B ESTÁ aplicada (recibo #505; SELECT de ' +
      'tabela fora, margem fora) — o que sobra é a escrita que a B não tocou, e o achado é real, não ruído: ' +
      'a policy fcs_update_own_or_gestor deixa a dona fazer UPDATE da própria linha, inclusive da margem ' +
      '(escrita cega), e TRUNCATE não passa por RLS. Fecha com REVOKE INSERT, UPDATE, DELETE, TRUNCATE, ' +
      'REFERENCES, TRIGGER, MAINTAIN das duas roles; até lá o alarme fica de pé, por desenho.',
  },
  'public.farmer_tactical_plans': {
    fechadaPor: '20261015120100_tactical_plans_margem_fecha_coluna.sql',
    permitido: { anon: [], authenticated: [] },
    colunasPermitidas: {
      authenticated: {
        SELECT: [
          'actual_margin', 'approach_strategy', 'approach_strategy_b', 'best_individual_lie',
          'bundle_incremental_margin', 'bundle_lie', 'bundle_probability', 'bundle_recommendation_id',
          'call_duration_seconds', 'call_result', 'churn_risk', 'completed_at', 'created_at',
          'customer_profile', 'customer_user_id', 'diagnostic_questions', 'effectiveness_score',
          'expansion_potential', 'farmer_id', 'generated_at', 'health_score', 'id', 'implication_question',
          'ltv_projection', 'mix_gap', 'notes', 'objection_type', 'offer_transition', 'operational_risks',
          'plan_followed', 'plan_type', 'probable_objections', 'second_bundle', 'status',
          'strategic_objective', 'top_bundle', 'updated_at', 'used_at',
        ],
      },
    },
    motivo:
      'margem do plano tático (current_margin_pct, cluster_avg_margin_pct, expected_result) — fechada por ' +
      'privilégio de COLUNA pela B do #3084: REVOKE SELECT de tabela + GRANT SELECT das 38 colunas restantes; ' +
      'a margem só sai pela RPC get_planos_margem, sob private.cap_custo_ler. NUNCA reemitir GRANT SELECT ON ' +
      'public.farmer_tactical_plans TO authenticated (table). Writers são RPCs SECURITY DEFINER (criar_plano_tatico, ' +
      'registrar_resultado_plano, expirar_planos_taticos) e as edges com service_role. ' +
      '⚠️ Medido por psql-ro após o apply (2026-10-18): authenticated=Dxtm e anon=Dxtm (sobra do default) DIVERGEM ' +
      'deste contrato e authz:grants:prod acusa DRIFT_PROD — achado real: TRUNCATE não passa por RLS. Fecha com ' +
      'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN das duas roles; até lá o alarme fica de pé.',
  },
};
