# Migrations Audit — Custom (não-UUID)

> Gerado por `scripts/audit-custom-migrations.ts`. Re-rodar quando custom migrations forem adicionadas: `bun scripts/audit-custom-migrations.ts`.

## Contexto

Per CLAUDE.md §5, **Lovable Cloud NÃO aplica automaticamente** migrations com nome custom (não-UUID) em `supabase/migrations/`. UUID-format (ex: `_868822bb-e38c-4fcf-8879-c64e48bd7630.sql`) são geradas pelo builder visual do Lovable e auto-rodam. Custom (ex: `_user_departments.sql`) ficam no repo mas precisam apply manual via Supabase SQL Editor.

Este audit valida **quais custom migrations estão de fato aplicadas no banco**.

## Como rodar

1. Abra **Supabase Dashboard** (via Lovable Cloud → Backend → Open Supabase, ou direto via `https://supabase.com/dashboard/project/fzvklzpomgnyikkfkzai`)
2. **SQL Editor** → **New query**
3. Cole TODO o conteúdo de `scripts/audit-custom-migrations.sql`
4. **Run** (read-only, não altera nada)
5. Você verá DUAS tabelas:
   - **Section 1** — timestamps em `supabase_migrations.schema_migrations` (source of truth do Supabase)
   - **Section 2** — existência objeto-a-objeto via `pg_catalog`/`information_schema`
6. Filtre linhas com `❌` → essas são as migrations que precisam apply manual

## Resumo

- **62** custom migrations totais
- **338** objetos esperados (criados por estas migrations)
- Quebra por tipo:
  - `rls_policy`: 104
  - `index`: 95
  - `table`: 51
  - `function`: 38
  - `trigger`: 31
  - `cron_job`: 15
  - `enum_value`: 4

## Inventário por migration

Lista canônica do que cada migration *deveria* criar (extraído via regex de `CREATE TABLE`/`CREATE INDEX`/etc — não é parser SQL completo). Use junto com Section 2 do SQL pra cruzar com a realidade.

### `20260328200000_financial_module.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_categorias` | — |
| `table` | `public.fin_contas_correntes` | — |
| `table` | `public.fin_contas_pagar` | — |
| `table` | `public.fin_contas_receber` | — |
| `table` | `public.fin_movimentacoes` | — |
| `table` | `public.fin_dre_snapshots` | — |
| `index` | `public.idx_fin_categorias_company` | `fin_categorias` |
| `index` | `public.idx_fin_categorias_tipo` | `fin_categorias` |
| `index` | `public.idx_fin_cc_company` | `fin_contas_correntes` |
| `index` | `public.idx_fin_cp_company` | `fin_contas_pagar` |
| `index` | `public.idx_fin_cp_status` | `fin_contas_pagar` |
| `index` | `public.idx_fin_cp_vencimento` | `fin_contas_pagar` |
| `index` | `public.idx_fin_cp_fornecedor` | `fin_contas_pagar` |
| `index` | `public.idx_fin_cp_categoria` | `fin_contas_pagar` |
| `index` | `public.idx_fin_cr_company` | `fin_contas_receber` |
| `index` | `public.idx_fin_cr_status` | `fin_contas_receber` |
| `index` | `public.idx_fin_cr_vencimento` | `fin_contas_receber` |
| `index` | `public.idx_fin_cr_cliente` | `fin_contas_receber` |
| `index` | `public.idx_fin_cr_categoria` | `fin_contas_receber` |
| `index` | `public.idx_fin_mov_company` | `fin_movimentacoes` |
| `index` | `public.idx_fin_mov_data` | `fin_movimentacoes` |
| `index` | `public.idx_fin_mov_cc` | `fin_movimentacoes` |
| `index` | `public.idx_fin_dre_company_periodo` | `fin_dre_snapshots` |
| `rls_policy` | `public.fin_categorias_select` | `fin_categorias` |
| `rls_policy` | `public.fin_cc_select` | `fin_contas_correntes` |
| `rls_policy` | `public.fin_cp_select` | `fin_contas_pagar` |
| `rls_policy` | `public.fin_cr_select` | `fin_contas_receber` |
| `rls_policy` | `public.fin_mov_select` | `fin_movimentacoes` |
| `rls_policy` | `public.fin_dre_select` | `fin_dre_snapshots` |
| `rls_policy` | `public.fin_categorias_service` | `fin_categorias` |
| `rls_policy` | `public.fin_cc_service` | `fin_contas_correntes` |
| `rls_policy` | `public.fin_cp_service` | `fin_contas_pagar` |
| `rls_policy` | `public.fin_cr_service` | `fin_contas_receber` |
| `rls_policy` | `public.fin_mov_service` | `fin_movimentacoes` |
| `rls_policy` | `public.fin_dre_service` | `fin_dre_snapshots` |

### `20260328200100_fin_categoria_dre_mapping.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_categoria_dre_mapping` | — |
| `index` | `public.idx_fin_cat_dre_company` | `fin_categoria_dre_mapping` |
| `rls_policy` | `public.fin_cat_dre_select` | `fin_categoria_dre_mapping` |
| `rls_policy` | `public.fin_cat_dre_all_service` | `fin_categoria_dre_mapping` |
| `rls_policy` | `public.fin_cat_dre_admin_modify` | `fin_categoria_dre_mapping` |

### `20260328200300_fix_fluxo_caixa_dre_regime.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260328200400_fix_cron_sync.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_sync_log` | — |
| `index` | `public.idx_fin_sync_log_started` | `fin_sync_log` |

### `20260328200500_financeiro_v2.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_fechamentos` | — |
| `table` | `public.fin_fechamento_log` | — |
| `table` | `public.fin_conciliacao` | — |
| `table` | `public.fin_eliminacoes_intercompany` | — |
| `table` | `public.fin_eliminacoes_log` | — |
| `table` | `public.fin_orcamento` | — |
| `table` | `public.fin_forecast` | — |
| `table` | `public.fin_permissoes` | — |
| `table` | `public.fin_kpi_tributario` | — |
| `index` | `public.idx_fin_fech_company_periodo` | `fin_fechamentos` |
| `index` | `public.idx_fin_fech_status` | `fin_fechamentos` |
| `index` | `public.idx_fin_fech_log_fech` | `fin_fechamento_log` |
| `index` | `public.idx_fin_conc_company` | `fin_conciliacao` |
| `index` | `public.idx_fin_conc_status` | `fin_conciliacao` |
| `index` | `public.idx_fin_conc_mov` | `fin_conciliacao` |
| `index` | `public.idx_fin_elim_log_periodo` | `fin_eliminacoes_log` |
| `index` | `public.idx_fin_orc_periodo` | `fin_orcamento` |
| `index` | `public.idx_fin_analise_cr_unique` | `fin_analise_cr_dimensoes` |
| `index` | `public.idx_fin_analise_cp_unique` | `fin_analise_cp_dimensoes` |
| `index` | `public.idx_fin_kpi_trib_periodo` | `fin_kpi_tributario` |
| `function` | `public.fin_refresh_analise_dimensoes` | — |
| `function` | `public.fin_user_can_access` | — |
| `rls_policy` | `public.fin_fechamentos_service` | `fin_fechamentos` |
| `rls_policy` | `public.fin_fechamento_log_service` | `fin_fechamento_log` |
| `rls_policy` | `public.fin_conciliacao_service` | `fin_conciliacao` |
| `rls_policy` | `public.fin_elim_service` | `fin_eliminacoes_intercompany` |
| `rls_policy` | `public.fin_elim_log_service` | `fin_eliminacoes_log` |
| `rls_policy` | `public.fin_orc_service` | `fin_orcamento` |
| `rls_policy` | `public.fin_forecast_service` | `fin_forecast` |
| `rls_policy` | `public.fin_perm_service` | `fin_permissoes` |
| `rls_policy` | `public.fin_kpi_trib_service` | `fin_kpi_tributario` |
| `rls_policy` | `public.fin_fechamentos_user` | `fin_fechamentos` |
| `rls_policy` | `public.fin_fechamento_log_user` | `fin_fechamento_log` |
| `rls_policy` | `public.fin_conciliacao_user` | `fin_conciliacao` |
| `rls_policy` | `public.fin_elim_user` | `fin_eliminacoes_intercompany` |
| `rls_policy` | `public.fin_elim_log_user` | `fin_eliminacoes_log` |
| `rls_policy` | `public.fin_orc_user` | `fin_orcamento` |
| `rls_policy` | `public.fin_forecast_user` | `fin_forecast` |
| `rls_policy` | `public.fin_perm_user` | `fin_permissoes` |
| `rls_policy` | `public.fin_kpi_trib_user` | `fin_kpi_tributario` |
| `rls_policy` | `public.fin_orc_write` | `fin_orcamento` |
| `rls_policy` | `public.fin_conc_write` | `fin_conciliacao` |
| `rls_policy` | `public.fin_elim_write` | `fin_eliminacoes_intercompany` |
| `rls_policy` | `public.fin_fech_write` | `fin_fechamentos` |

### `20260328200600_financeiro_v3_backend.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_sync_checkpoint` | — |
| `table` | `public.fin_confiabilidade` | — |
| `index` | `public.idx_fin_conf_periodo` | `fin_confiabilidade` |
| `function` | `public.fin_calcular_confiabilidade` | — |
| `function` | `public.fin_projecao_13_semanas` | — |
| `function` | `public.fin_consolidado_intercompany` | — |
| `rls_policy` | `public.fin_sync_ckpt_service` | `fin_sync_checkpoint` |
| `rls_policy` | `public.fin_sync_ckpt_user` | `fin_sync_checkpoint` |
| `rls_policy` | `public.fin_conf_service` | `fin_confiabilidade` |
| `rls_policy` | `public.fin_conf_user` | `fin_confiabilidade` |

### `20260516120000_vendor_sip_credentials.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.vendor_sip_credentials` | — |
| `index` | `public.idx_vendor_sip_credentials_user_id` | `vendor_sip_credentials` |
| `function` | `public.update_vendor_sip_credentials_updated_at` | — |
| `trigger` | `public.vendor_sip_credentials_updated_at_trigger` | `vendor_sip_credentials` |

### `20260517100000_enable_realtime_dashboard_v3.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260517120000_user_departments.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.user_departments` | — |
| `index` | `public.idx_user_departments_user` | `user_departments` |
| `index` | `public.idx_user_departments_dept` | `user_departments` |
| `rls_policy` | `public.user_departments_read_own` | `user_departments` |
| `rls_policy` | `public.user_departments_master_all` | `user_departments` |
| `rls_policy` | `public.user_departments_service_all` | `user_departments` |

### `20260517140000_dashboard_visits.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.dashboard_visits` | — |
| `index` | `public.idx_dashboard_visits_user_recent` | `dashboard_visits` |
| `rls_policy` | `public.dashboard_visits_user_insert` | `dashboard_visits` |
| `rls_policy` | `public.dashboard_visits_user_read` | `dashboard_visits` |
| `rls_policy` | `public.dashboard_visits_master_read` | `dashboard_visits` |
| `rls_policy` | `public.dashboard_visits_service_all` | `dashboard_visits` |

### `20260517160000_farmer_calls_persist_session.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_farmer_calls_has_transcript` | `farmer_calls` |

### `20260517170000_kb_foundation.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.kb_documents` | — |
| `table` | `public.kb_chunks` | — |
| `index` | `public.idx_kb_chunks_embedding` | `kb_chunks` |
| `index` | `public.idx_kb_documents_status_type` | `kb_documents` |
| `index` | `public.idx_kb_chunks_document` | `kb_chunks` |
| `function` | `public.kb_documents_set_updated_at` | — |
| `trigger` | `public.trg_kb_documents_updated_at` | `kb_documents` |
| `rls_policy` | `public.kb_documents_select_staff` | `kb_documents` |
| `rls_policy` | `public.kb_documents_insert_staff` | `kb_documents` |
| `rls_policy` | `public.kb_documents_update_master` | `kb_documents` |
| `rls_policy` | `public.kb_documents_delete_master` | `kb_documents` |
| `rls_policy` | `public.kb_chunks_select_staff` | `kb_chunks` |
| `rls_policy` | `storage.kb_bucket_select_staff` | `objects` |
| `rls_policy` | `storage.kb_bucket_insert_staff` | `objects` |
| `rls_policy` | `storage.kb_bucket_delete_master` | `objects` |

### `20260517180000_kb_specs_and_competitors.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.kb_product_specs` | — |
| `table` | `public.kb_competitors` | — |
| `table` | `public.kb_competitor_products` | — |
| `index` | `public.idx_kb_product_specs_product_code` | `kb_product_specs` |
| `index` | `public.idx_kb_product_specs_supplier_line` | `kb_product_specs` |
| `index` | `public.idx_kb_competitor_products_competitor` | `kb_competitor_products` |
| `index` | `public.idx_kb_competitor_products_equivalent` | `kb_competitor_products` |
| `function` | `public.kb_documents_set_updated_at` | — |
| `trigger` | `public.trg_kb_product_specs_updated_at` | `kb_product_specs` |
| `trigger` | `public.trg_kb_competitors_updated_at` | `kb_competitors` |
| `trigger` | `public.trg_kb_competitor_products_updated_at` | `kb_competitor_products` |
| `rls_policy` | `public.kb_product_specs_select_staff` | `kb_product_specs` |
| `rls_policy` | `public.kb_product_specs_insert_staff` | `kb_product_specs` |
| `rls_policy` | `public.kb_product_specs_update_master` | `kb_product_specs` |
| `rls_policy` | `public.kb_product_specs_delete_master` | `kb_product_specs` |
| `rls_policy` | `public.kb_competitors_select_staff` | `kb_competitors` |
| `rls_policy` | `public.kb_competitors_insert_staff` | `kb_competitors` |
| `rls_policy` | `public.kb_competitors_update_staff` | `kb_competitors` |
| `rls_policy` | `public.kb_competitors_delete_master` | `kb_competitors` |
| `rls_policy` | `public.kb_competitor_products_select_staff` | `kb_competitor_products` |
| `rls_policy` | `public.kb_competitor_products_insert_staff` | `kb_competitor_products` |
| `rls_policy` | `public.kb_competitor_products_update_staff` | `kb_competitor_products` |
| `rls_policy` | `public.kb_competitor_products_delete_master` | `kb_competitor_products` |

### `20260517190000_customer_processes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.customer_processes` | — |
| `index` | `public.idx_customer_processes_one_current` | `customer_processes` |
| `index` | `public.idx_customer_processes_customer` | `customer_processes` |
| `index` | `public.idx_customer_processes_segmento` | `customer_processes` |
| `trigger` | `public.trg_customer_processes_updated_at` | `customer_processes` |
| `rls_policy` | `public.customer_processes_select_staff` | `customer_processes` |
| `rls_policy` | `public.customer_processes_insert_staff` | `customer_processes` |
| `rls_policy` | `public.customer_processes_update_staff` | `customer_processes` |
| `rls_policy` | `public.customer_processes_delete_master` | `customer_processes` |

### `20260517200000_standard_processes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.standard_processes` | — |
| `index` | `public.idx_standard_processes_status_segmento` | `standard_processes` |
| `index` | `public.idx_standard_processes_published_segmento` | `standard_processes` |
| `index` | `public.idx_standard_processes_slug` | `standard_processes` |
| `trigger` | `public.trg_standard_processes_updated_at` | `standard_processes` |
| `rls_policy` | `public.standard_processes_select_visible` | `standard_processes` |
| `rls_policy` | `public.standard_processes_insert_staff` | `standard_processes` |
| `rls_policy` | `public.standard_processes_update_owner_or_master` | `standard_processes` |
| `rls_policy` | `public.standard_processes_delete_master` | `standard_processes` |

### `20260517210000_rag_chunks.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.rag_chunks` | — |
| `index` | `public.idx_rag_chunks_embedding` | `rag_chunks` |
| `index` | `public.idx_rag_chunks_source` | `rag_chunks` |
| `index` | `public.idx_rag_chunks_metadata_segmento` | `rag_chunks` |
| `rls_policy` | `public.rag_chunks_select_staff` | `rag_chunks` |

### `20260517220000_customer_contacts.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.customer_contacts` | — |
| `index` | `public.idx_customer_contacts_customer` | `customer_contacts` |
| `index` | `public.idx_customer_contacts_phone` | `customer_contacts` |
| `index` | `public.idx_customer_contacts_one_primary` | `customer_contacts` |
| `index` | `public.idx_customer_contacts_birthday` | `customer_contacts` |
| `trigger` | `public.trg_customer_contacts_updated_at` | `customer_contacts` |
| `rls_policy` | `public.customer_contacts_select_staff` | `customer_contacts` |
| `rls_policy` | `public.customer_contacts_insert_staff` | `customer_contacts` |
| `rls_policy` | `public.customer_contacts_update_staff` | `customer_contacts` |
| `rls_policy` | `public.customer_contacts_delete_master` | `customer_contacts` |

### `20260518000000_fin_audit_log.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_audit_log` | — |
| `index` | `public.fin_audit_log_table_row_idx` | `fin_audit_log` |
| `index` | `public.fin_audit_log_company_period_idx` | `fin_audit_log` |
| `index` | `public.fin_audit_log_user_idx` | `fin_audit_log` |
| `rls_policy` | `public.fin_audit_log_select_staff` | `fin_audit_log` |

### `20260518000100_fin_audit_trigger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_audit_trigger` | — |

### `20260518000200_fin_audit_attach.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `trigger` | `public.trg_audit` | `fin_contas_receber` |
| `trigger` | `public.trg_audit` | `fin_contas_pagar` |
| `trigger` | `public.trg_audit` | `fin_categoria_dre_mapping` |
| `trigger` | `public.trg_audit` | `fin_orcamento` |
| `trigger` | `public.trg_audit` | `fin_fechamentos` |
| `trigger` | `public.trg_audit` | `fin_eliminacoes_intercompany` |

### `20260518000300_set_config_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.set_config` | — |

### `20260518001000_fin_period_overrides.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_period_overrides` | — |
| `index` | `public.fin_period_overrides_active_idx` | `fin_period_overrides` |
| `rls_policy` | `public.fin_period_overrides_select_staff` | `fin_period_overrides` |
| `rls_policy` | `public.fin_period_overrides_insert_master` | `fin_period_overrides` |
| `rls_policy` | `public.fin_period_overrides_update_self` | `fin_period_overrides` |

### `20260518001100_fin_period_lock_trigger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_period_lock_trigger` | — |

### `20260518001200_fin_period_lock_attach.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `trigger` | `public.trg_period_lock` | `fin_contas_receber` |
| `trigger` | `public.trg_period_lock` | `fin_contas_pagar` |
| `trigger` | `public.trg_period_lock` | `fin_movimentacoes` |
| `trigger` | `public.trg_period_lock` | `fin_categoria_dre_mapping` |
| `trigger` | `public.trg_period_lock` | `fin_orcamento` |

### `20260518002000_dre_unique_with_regime.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260518002100_fechamento_dual_snapshots.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260518003000_fin_mapping_gate_trigger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_check_mapping_complete_trigger` | — |
| `trigger` | `public.trg_mapping_gate` | `fin_fechamentos` |

### `20260518003100_rpc_categorias_sem_mapping.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_categorias_sem_mapping` | — |

### `20260518004000_fin_ic_matches.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_ic_matches` | — |
| `index` | `public.fin_ic_matches_status_idx` | `fin_ic_matches` |
| `index` | `public.fin_ic_matches_cr_idx` | `fin_ic_matches` |
| `index` | `public.fin_ic_matches_cp_idx` | `fin_ic_matches` |
| `index` | `public.fin_ic_matches_cr_unique` | `fin_ic_matches` |
| `index` | `public.fin_ic_matches_cp_unique` | `fin_ic_matches` |
| `rls_policy` | `public.fin_ic_matches_select_staff` | `fin_ic_matches` |
| `rls_policy` | `public.fin_ic_matches_update_staff` | `fin_ic_matches` |

### `20260518004100_company_cnpjs.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.company_cnpjs` | — |
| `index` | `public.company_cnpjs_normalized_idx` | `company_cnpjs` |
| `rls_policy` | `public.company_cnpjs_select_authenticated` | `company_cnpjs` |
| `rls_policy` | `public.company_cnpjs_master_write` | `company_cnpjs` |

### `20260518004200_fin_ic_cron.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260518004300_fin_consolidado_v2.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_consolidado_intercompany` | — |

### `20260518100000_commercial_role_add_values.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `enum_value` | `public.farmer` | `commercial_role` |
| `enum_value` | `public.hunter` | `commercial_role` |
| `enum_value` | `public.closer` | `commercial_role` |
| `enum_value` | `public.master` | `commercial_role` |

### `20260518110000_scoring_v2_signal_modifiers.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.score_recalc_queue` | — |
| `index` | `public.idx_score_recalc_queue_pending` | `score_recalc_queue` |
| `index` | `public.uniq_score_recalc_queue_pending` | `score_recalc_queue` |
| `function` | `public.enqueue_score_recalc_from_call` | — |
| `trigger` | `public.trg_farmer_calls_enqueue_recalc` | `farmer_calls` |

### `20260518120000_visit_intelligence_v1.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.customer_visit_scores` | — |
| `table` | `public.visit_score_recalc_queue` | — |
| `index` | `public.idx_visit_scores_farmer_priority` | `customer_visit_scores` |
| `index` | `public.idx_visit_scores_farmer_city` | `customer_visit_scores` |
| `index` | `public.idx_visit_score_queue_pending` | `visit_score_recalc_queue` |
| `index` | `public.uniq_visit_score_queue_pending` | `visit_score_recalc_queue` |
| `function` | `public.enqueue_visit_score_recalc_from_visit` | — |
| `function` | `public.enqueue_visit_score_recalc_from_client_score` | — |
| `trigger` | `public.trg_route_visits_enqueue_visit_recalc` | `route_visits` |
| `trigger` | `public.trg_farmer_client_scores_enqueue_visit_recalc` | `farmer_client_scores` |

### `20260519000000_fin_a1_eventos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_eventos_recorrentes` | — |
| `table` | `public.fin_eventos_eventuais` | — |
| `index` | `public.fin_eventos_rec_company_ativo_idx` | `fin_eventos_recorrentes` |
| `index` | `public.fin_eventos_rec_categoria_idx` | `fin_eventos_recorrentes` |
| `index` | `public.fin_eventos_ev_company_data_idx` | `fin_eventos_eventuais` |
| `index` | `public.fin_eventos_ev_status_idx` | `fin_eventos_eventuais` |
| `rls_policy` | `public.fin_eventos_rec_select_staff` | `fin_eventos_recorrentes` |
| `rls_policy` | `public.fin_eventos_rec_write_staff` | `fin_eventos_recorrentes` |
| `rls_policy` | `public.fin_eventos_ev_select_staff` | `fin_eventos_eventuais` |
| `rls_policy` | `public.fin_eventos_ev_write_staff` | `fin_eventos_eventuais` |

### `20260519000100_fin_a1_snapshots_alertas_config.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_projecao_snapshots` | — |
| `table` | `public.fin_alertas` | — |
| `table` | `public.fin_config_cashflow` | — |
| `index` | `public.fin_proj_company_snap_idx` | `fin_projecao_snapshots` |
| `index` | `public.fin_proj_cenario_idx` | `fin_projecao_snapshots` |
| `index` | `public.fin_alertas_company_criado_idx` | `fin_alertas` |
| `index` | `public.fin_alertas_unique_ativo` | `fin_alertas` |
| `rls_policy` | `public.fin_proj_select_staff` | `fin_projecao_snapshots` |
| `rls_policy` | `public.fin_alertas_select_staff` | `fin_alertas` |
| `rls_policy` | `public.fin_alertas_update_staff` | `fin_alertas` |
| `rls_policy` | `public.fin_config_select_staff` | `fin_config_cashflow` |
| `rls_policy` | `public.fin_config_write_master` | `fin_config_cashflow` |

### `20260519000200_fin_a1_audit_lock_attach.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_period_lock_trigger` | — |
| `trigger` | `public.trg_audit` | `fin_eventos_recorrentes` |
| `trigger` | `public.trg_audit` | `fin_eventos_eventuais` |
| `trigger` | `public.trg_audit` | `fin_alertas` |
| `trigger` | `public.trg_audit` | `fin_config_cashflow` |
| `trigger` | `public.trg_period_lock` | `fin_eventos_recorrentes` |
| `trigger` | `public.trg_period_lock` | `fin_eventos_eventuais` |

### `20260519010000_fin_a1_cron.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260519020000_fin_onda1_ncg.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_estoque_valor` | — |
| `index` | `public.fin_estoque_valor_company_data_idx` | `fin_estoque_valor` |
| `function` | `public.fin_period_lock_trigger` | — |
| `function` | `public.fin_estimar_estoque_omie` | — |
| `trigger` | `public.trg_audit` | `fin_estoque_valor` |
| `trigger` | `public.trg_period_lock` | `fin_estoque_valor` |
| `rls_policy` | `public.fin_estoque_valor_select_staff` | `fin_estoque_valor` |
| `rls_policy` | `public.fin_estoque_valor_write_master` | `fin_estoque_valor` |

### `20260520010000_scoring_visit_p1_fixes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enqueue_visit_score_recalc_from_visit` | — |
| `function` | `public.enqueue_visit_score_recalc_from_client_score` | — |

### `20260523120000_call_log.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.call_log` | — |
| `index` | `public.uq_call_log_provider_call_id` | `call_log` |
| `index` | `public.uq_call_log_sip_call_id` | `call_log` |
| `index` | `public.idx_call_log_farmer_started` | `call_log` |
| `index` | `public.idx_call_log_missed_unack` | `call_log` |
| `cron_job` | `cron.call-log-missed-backstop` | — |

### `20260523210000_drop_audit_trigger_fin_config_cashflow.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260523230000_fin_a2_valor_inputs.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_valor_inputs` | — |
| `rls_policy` | `public.fin_valor_inputs_select_master` | `fin_valor_inputs` |
| `rls_policy` | `public.fin_valor_inputs_write_master` | `fin_valor_inputs` |

### `20260523230835_sync_sla_view_stack.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260523233000_restaura_guardas_sla_view_stack.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260524000000_fin_a3_cockpit_config.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260524095612_crons_scoring_visit_lendo_cron_secret_do_vault.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.scoring-recalc-batch-nightly` | — |
| `cron_job` | `cron.visit-score-recalc-batch-nightly` | — |

### `20260524100500_cron_financeiro_e_fix_sayerlack.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.fin-omie-sync-2x-diario` | — |
| `cron_job` | `cron.sayerlack-portal-watchdog` | — |

### `20260524102500_fix_fin_triggers_json_field_access.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_audit_trigger` | — |
| `function` | `public.fin_period_lock_trigger` | — |

### `20260524120000_carteira_omie_fase1.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.omie_vendedor_map` | — |
| `table` | `public.carteira_assignments` | — |
| `table` | `public.carteira_coverage` | — |
| `index` | `public.idx_omie_vendedor_map_codigo` | `omie_vendedor_map` |
| `index` | `public.idx_carteira_owner` | `carteira_assignments` |
| `index` | `public.idx_carteira_owner_eligible` | `carteira_assignments` |
| `index` | `public.idx_coverage_covering_active` | `carteira_coverage` |
| `function` | `public.carteira_visivel_para` | — |
| `function` | `public.minha_carteira` | — |

### `20260524121531_restore_sla_guards.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260524170000_scores_unique_por_cliente.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_fcs_customer` | `farmer_client_scores` |
| `index` | `public.idx_cvs_customer` | `customer_visit_scores` |

### `20260524180000_carteira_scores_owner_e_filas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.uniq_score_recalc_queue_pending` | `score_recalc_queue` |
| `index` | `public.uniq_visit_score_queue_pending` | `visit_score_recalc_queue` |
| `function` | `public.enqueue_score_recalc_from_call` | — |
| `function` | `public.enqueue_visit_score_recalc_from_visit` | — |
| `function` | `public.enqueue_visit_score_recalc_from_client_score` | — |

### `20260524202410_tuning_crons_estoque_freq_e_timeouts.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.omie-sync-estoque-diario` | — |
| `cron_job` | `cron.sync-orders-vendas-2h` | — |
| `cron_job` | `cron.sync-products-customers-daily` | — |
| `cron_job` | `cron.sync-inventory-vendas-30m` | — |
| `cron_job` | `cron.sync-omie-services-hourly` | — |

### `20260524203000_rpc_staff_guard_permite_cron_backend.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.sugerir_negociacao_paralela_hoje` | — |
| `function` | `public.refresh_sku_ranking_negociacao` | — |

### `20260525000000_fin_crons_por_entidade.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.fin-sync-base-diario` | — |
| `cron_job` | `cron.fin-sync-cp-2x` | — |
| `cron_job` | `cron.fin-sync-cr-2x` | — |
| `cron_job` | `cron.fin-sync-mov-2x` | — |

### `20260525010000_fin_audit_skip_service_role.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_audit_trigger` | — |

### `20260525020000_fin_sync_cursor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_sync_cursor` | — |
| `index` | `public.idx_fin_sync_cursor_pendentes` | `fin_sync_cursor` |
| `cron_job` | `cron.fin-sync-continuacao-10min` | — |
| `rls_policy` | `public.fin_sync_cursor_select_staff` | `fin_sync_cursor` |
| `rls_policy` | `public.fin_sync_cursor_service_all` | `fin_sync_cursor` |

### `20260525020001_fin_rpc_gate_auth_p1.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_calcular_confiabilidade` | — |
| `function` | `public.fin_categorias_sem_mapping` | — |
| `function` | `public.fin_consolidado_intercompany` | — |
| `function` | `public.fin_estimar_estoque_omie` | — |

### `20260525120000_positivacao_kpis.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.carteira_positivacao_snapshot` | — |
| `index` | `public.idx_sales_orders_kpi_date` | `sales_orders` |
| `function` | `public.get_minha_positivacao` | — |

### `20260525160000_carteira_saude_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_carteira_saude` | — |

## Próximos passos quando algo der `❌`

1. Abra a migration correspondente em `supabase/migrations/<arquivo>.sql`
2. Copie o SQL inteiro
3. Supabase SQL Editor → cole → Run
4. Re-rode `scripts/audit-custom-migrations.sql` pra confirmar que virou `✅`
5. (Opcional) `INSERT INTO supabase_migrations.schema_migrations (version, statements) VALUES ('<timestamp>', ARRAY['<sql>']);` pra registrar como aplicada (evita re-apply futura)
