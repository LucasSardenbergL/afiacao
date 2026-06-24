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

- **288** custom migrations totais
- **1015** objetos esperados (criados por estas migrations)
- Quebra por tipo:
  - `function`: 290
  - `rls_policy`: 219
  - `index`: 187
  - `table`: 108
  - `cron_job`: 108
  - `trigger`: 51
  - `view`: 48
  - `enum_value`: 4

## Inventário por migration

Lista canônica do que cada migration *deveria* criar (extraído via regex de `CREATE TABLE`/`CREATE INDEX`/etc — não é parser SQL completo). Use junto com Section 2 do SQL pra cruzar com a realidade.

### `20260328200000_financial_module.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.fin_aging_receber` | — |
| `view` | `public.fin_aging_pagar` | — |
| `view` | `public.fin_fluxo_caixa_diario` | — |
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

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.fin_fluxo_caixa_diario` | — |

### `20260328200400_fix_cron_sync.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_sync_log` | — |
| `index` | `public.idx_fin_sync_log_started` | `fin_sync_log` |

### `20260328200500_financeiro_v2.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_refresh_analise_dimensoes` | — |
| `function` | `public.fin_user_can_access` | — |
| `view` | `public.fin_analise_cr_dimensoes` | — |
| `view` | `public.fin_analise_cp_dimensoes` | — |
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
| `function` | `public.fin_calcular_confiabilidade` | — |
| `function` | `public.fin_projecao_13_semanas` | — |
| `function` | `public.fin_consolidado_intercompany` | — |
| `view` | `public.fin_dre_competencia_base` | — |
| `table` | `public.fin_sync_checkpoint` | — |
| `table` | `public.fin_confiabilidade` | — |
| `index` | `public.idx_fin_conf_periodo` | `fin_confiabilidade` |
| `rls_policy` | `public.fin_sync_ckpt_service` | `fin_sync_checkpoint` |
| `rls_policy` | `public.fin_sync_ckpt_user` | `fin_sync_checkpoint` |
| `rls_policy` | `public.fin_conf_service` | `fin_confiabilidade` |
| `rls_policy` | `public.fin_conf_user` | `fin_confiabilidade` |

### `20260516120000_vendor_sip_credentials.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.update_vendor_sip_credentials_updated_at` | — |
| `table` | `public.vendor_sip_credentials` | — |
| `index` | `public.idx_vendor_sip_credentials_user_id` | `vendor_sip_credentials` |
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
| `function` | `public.kb_documents_set_updated_at` | — |
| `table` | `public.kb_documents` | — |
| `table` | `public.kb_chunks` | — |
| `index` | `public.idx_kb_chunks_embedding` | `kb_chunks` |
| `index` | `public.idx_kb_documents_status_type` | `kb_documents` |
| `index` | `public.idx_kb_chunks_document` | `kb_chunks` |
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
| `function` | `public.kb_documents_set_updated_at` | — |
| `table` | `public.kb_product_specs` | — |
| `table` | `public.kb_competitors` | — |
| `table` | `public.kb_competitor_products` | — |
| `index` | `public.idx_kb_product_specs_product_code` | `kb_product_specs` |
| `index` | `public.idx_kb_product_specs_supplier_line` | `kb_product_specs` |
| `index` | `public.idx_kb_competitor_products_competitor` | `kb_competitor_products` |
| `index` | `public.idx_kb_competitor_products_equivalent` | `kb_competitor_products` |
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
| `function` | `public.enqueue_score_recalc_from_call` | — |
| `view` | `public.score_recalc_pending` | — |
| `table` | `public.score_recalc_queue` | — |
| `index` | `public.idx_score_recalc_queue_pending` | `score_recalc_queue` |
| `index` | `public.uniq_score_recalc_queue_pending` | `score_recalc_queue` |
| `trigger` | `public.trg_farmer_calls_enqueue_recalc` | `farmer_calls` |

### `20260518120000_visit_intelligence_v1.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enqueue_visit_score_recalc_from_visit` | — |
| `function` | `public.enqueue_visit_score_recalc_from_client_score` | — |
| `view` | `public.visit_score_recalc_pending` | — |
| `table` | `public.customer_visit_scores` | — |
| `table` | `public.visit_score_recalc_queue` | — |
| `index` | `public.idx_visit_scores_farmer_priority` | `customer_visit_scores` |
| `index` | `public.idx_visit_scores_farmer_city` | `customer_visit_scores` |
| `index` | `public.idx_visit_score_queue_pending` | `visit_score_recalc_queue` |
| `index` | `public.uniq_visit_score_queue_pending` | `visit_score_recalc_queue` |
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
| `function` | `public.fin_period_lock_trigger` | — |
| `function` | `public.fin_estimar_estoque_omie` | — |
| `table` | `public.fin_estoque_valor` | — |
| `index` | `public.fin_estoque_valor_company_data_idx` | `fin_estoque_valor` |
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

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_fornecedor_lt_logistica_total` | — |
| `view` | `public.v_sku_lt_teorico` | — |
| `view` | `public.v_sku_sla_compliance` | — |
| `view` | `public.v_fornecedor_sla_compliance` | — |

### `20260523233000_restaura_guardas_sla_view_stack.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_sku_lt_teorico` | — |
| `view` | `public.v_sku_sla_compliance` | — |
| `view` | `public.v_fornecedor_sla_compliance` | — |

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
| `function` | `public.carteira_visivel_para` | — |
| `function` | `public.minha_carteira` | — |
| `table` | `public.omie_vendedor_map` | — |
| `table` | `public.carteira_assignments` | — |
| `table` | `public.carteira_coverage` | — |
| `index` | `public.idx_omie_vendedor_map_codigo` | `omie_vendedor_map` |
| `index` | `public.idx_carteira_owner` | `carteira_assignments` |
| `index` | `public.idx_carteira_owner_eligible` | `carteira_assignments` |
| `index` | `public.idx_coverage_covering_active` | `carteira_coverage` |

### `20260524120000_fin_regime_inputs.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_regime_inputs` | — |
| `rls_policy` | `public.fin_regime_inputs_select_master` | `fin_regime_inputs` |
| `rls_policy` | `public.fin_regime_inputs_write_master` | `fin_regime_inputs` |

### `20260524121531_restore_sla_guards.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_sku_lt_teorico` | — |
| `view` | `public.v_sku_sla_compliance` | — |

### `20260524170000_scores_unique_por_cliente.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_fcs_customer` | `farmer_client_scores` |
| `index` | `public.idx_cvs_customer` | `customer_visit_scores` |

### `20260524180000_carteira_scores_owner_e_filas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enqueue_score_recalc_from_call` | — |
| `function` | `public.enqueue_visit_score_recalc_from_visit` | — |
| `function` | `public.enqueue_visit_score_recalc_from_client_score` | — |
| `index` | `public.uniq_score_recalc_queue_pending` | `score_recalc_queue` |
| `index` | `public.uniq_visit_score_queue_pending` | `visit_score_recalc_queue` |

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
| `function` | `public.get_minha_positivacao` | — |
| `table` | `public.carteira_positivacao_snapshot` | — |
| `index` | `public.idx_sales_orders_kpi_date` | `sales_orders` |

### `20260525130000_fin_analise_dimensoes_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_analise_cr_dimensoes_rpc` | — |
| `function` | `public.fin_analise_cp_dimensoes_rpc` | — |

### `20260525140000_fin_refresh_analise_dimensoes_cron.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.fin-refresh-analise-dimensoes` | — |

### `20260525140000_v_otimizador_compras_insumos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_otimizador_compras_insumos` | — |

### `20260525160000_carteira_saude_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_carteira_saude` | — |

### `20260525190000_mixgap_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_meu_mixgap` | — |

### `20260525200000_fin_sync_watchdog.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_sync_watchdog_check` | — |
| `function` | `public.fin_sync_heartbeat` | — |
| `cron_job` | `cron.fin-sync-watchdog` | — |
| `cron_job` | `cron.fin-sync-heartbeat` | — |

### `20260525210000_viewas_rpcs_for.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._carteira_mixgap_for_owner` | — |
| `function` | `public.get_meu_mixgap` | — |
| `function` | `public.get_meu_mixgap_for` | — |
| `function` | `public._carteira_positivacao_for_owner` | — |
| `function` | `public.get_minha_positivacao` | — |
| `function` | `public.get_minha_positivacao_for` | — |

### `20260525220000_viewas_access_targets.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_user_access_profile_for` | — |
| `function` | `public.list_impersonation_targets` | — |

### `20260525230000_impersonation_audit.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.log_impersonation_start` | — |
| `function` | `public.end_impersonation` | — |
| `table` | `public.impersonation_audit` | — |

### `20260526020000_rls_score_carteira_hardening.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.pode_ver_carteira_completa` | — |
| `rls_policy` | `public.fcs_select_carteira` | `farmer_client_scores` |
| `rls_policy` | `public.fcs_insert_own_or_gestor` | `farmer_client_scores` |
| `rls_policy` | `public.fcs_update_own_or_gestor` | `farmer_client_scores` |
| `rls_policy` | `public.fcs_delete_own_or_gestor` | `farmer_client_scores` |
| `rls_policy` | `public.cvs_select_carteira` | `customer_visit_scores` |
| `rls_policy` | `public.cvs_insert_own_or_gestor` | `customer_visit_scores` |
| `rls_policy` | `public.cvs_update_own_or_gestor` | `customer_visit_scores` |
| `rls_policy` | `public.cvs_delete_own_or_gestor` | `customer_visit_scores` |

### `20260526030000_fin_sync_watchdog_sweep_orphans.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_sync_watchdog_check` | — |

### `20260526040000_rls_carteira_relacionamento_hardening.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.pode_ver_carteira_completa` | — |
| `rls_policy` | `public.frec_select_carteira` | `farmer_recommendations` |
| `rls_policy` | `public.frec_insert_own_or_gestor` | `farmer_recommendations` |
| `rls_policy` | `public.frec_update_own_or_gestor` | `farmer_recommendations` |
| `rls_policy` | `public.frec_delete_own_or_gestor` | `farmer_recommendations` |
| `rls_policy` | `public.fbrec_select_carteira` | `farmer_bundle_recommendations` |
| `rls_policy` | `public.fbrec_insert_own_or_gestor` | `farmer_bundle_recommendations` |
| `rls_policy` | `public.fbrec_update_own_or_gestor` | `farmer_bundle_recommendations` |
| `rls_policy` | `public.fbrec_delete_own_or_gestor` | `farmer_bundle_recommendations` |
| `rls_policy` | `public.fcall_select_carteira` | `farmer_calls` |
| `rls_policy` | `public.fcall_insert_own_or_gestor` | `farmer_calls` |
| `rls_policy` | `public.fcall_update_own_or_gestor` | `farmer_calls` |
| `rls_policy` | `public.fcall_delete_own_or_gestor` | `farmer_calls` |
| `rls_policy` | `public.rvis_select_carteira` | `route_visits` |
| `rls_policy` | `public.rvis_insert_own_or_gestor` | `route_visits` |
| `rls_policy` | `public.rvis_update_own_or_gestor` | `route_visits` |
| `rls_policy` | `public.rvis_delete_own_or_gestor` | `route_visits` |
| `rls_policy` | `public.fcop_select_carteira` | `farmer_copilot_sessions` |
| `rls_policy` | `public.fcop_insert_own_or_gestor` | `farmer_copilot_sessions` |
| `rls_policy` | `public.fcop_update_own_or_gestor` | `farmer_copilot_sessions` |
| `rls_policy` | `public.fcop_delete_own_or_gestor` | `farmer_copilot_sessions` |

### `20260526060000_views_security_invoker_hardening.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260526080000_fix_sayerlack_cron_vault.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.sayerlack-portal-watchdog` | — |

### `20260526100000_fin_funding_inputs.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.fin_funding_inputs` | — |
| `rls_policy` | `public.fin_funding_inputs_select_master` | `fin_funding_inputs` |
| `rls_policy` | `public.fin_funding_inputs_write_master` | `fin_funding_inputs` |

### `20260526160000_data_health_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_data_health` | — |

### `20260526230000_mixgap_feedback.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.mark_mixgap_feedback` | — |
| `function` | `public._carteira_mixgap_for_owner` | — |
| `table` | `public.farmer_mixgap_feedback` | — |

### `20260527010000_rls_copilot_sessions_select_own_only.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `rls_policy` | `public.fcop_select_carteira` | `farmer_copilot_sessions` |

### `20260527120000_clientes_nao_vinculados.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.finalize_nao_vinculados_snapshot` | — |
| `view` | `public.v_clientes_nao_vinculados_atual` | — |
| `table` | `public.omie_clientes_nao_vinculados` | — |
| `table` | `public.omie_nao_vinculados_state` | — |
| `index` | `public.idx_nv_empresa_synced` | `omie_clientes_nao_vinculados` |
| `rls_policy` | `public.nv_select` | `omie_clientes_nao_vinculados` |
| `rls_policy` | `public.nv_state_select` | `omie_nao_vinculados_state` |

### `20260527120000_data_health_rpc_fix.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_data_health` | — |

### `20260527140000_revoke_carteira_internals_anon.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260527160000_cron_vendas_sync_pedidos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.vendas-sync-pedidos-oben-2h` | — |
| `cron_job` | `cron.vendas-sync-pedidos-colacor-2h` | — |

### `20260527160000_matview_ranking_negociacao_private.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.refresh_sku_ranking_negociacao` | — |
| `function` | `public.get_sku_ranking_negociacao_paralela` | — |

### `20260527170000_crons_timeout_fix.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.carteira-positivacao-snapshot-mensal` | — |
| `cron_job` | `cron.carteira-rebuild-nightly` | — |
| `cron_job` | `cron.compute-association-rules-daily` | — |
| `cron_job` | `cron.compute-costs-daily` | — |
| `cron_job` | `cron.monthly-tool-report` | — |
| `cron_job` | `cron.omie-sync-metadados-daily` | — |
| `cron_job` | `cron.omie-sync-status-produtos-diario` | — |
| `cron_job` | `cron.process-recurring-orders-daily` | — |
| `cron_job` | `cron.sayerlack-portal-watchdog` | — |
| `cron_job` | `cron.sync-colacor-vendas-products` | — |
| `cron_job` | `cron.sync-reprocess-operational` | — |
| `cron_job` | `cron.sync-reprocess-strategic` | — |
| `cron_job` | `cron.weekly-algorithm-a-audit` | — |

### `20260527180000_data_health_add_vendas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_data_health` | — |

### `20260527180000_get_tint_price_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_tint_price` | — |

### `20260527190000_drop_redundant_sync_orders_cron.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260527190000_drop_tint_formula_itens_public_select.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260527200000_data_health_add_estoque_reposicao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_data_health` | — |

### `20260527210000_data_health_compute_internal.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.get_data_health` | — |

### `20260527220000_data_health_watchdog.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |
| `cron_job` | `cron.data-health-watchdog` | — |

### `20260527220001_fin_sync_cursor_backfill_desde.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260527230000_cron_baseline.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.afiacao_ciclo_oportunidade_diario` | — |
| `cron_job` | `cron.afiacao_dispatch_notificacoes_diario` | — |
| `cron_job` | `cron.afiacao_estados_eventos_diarios` | — |
| `cron_job` | `cron.afiacao_limpeza_sugestoes_mensal` | — |
| `cron_job` | `cron.afiacao_omie_oben_sku_items_history_daily` | — |
| `cron_job` | `cron.afiacao_omie_oben_sync_incremental_2h` | — |
| `cron_job` | `cron.afiacao_ranking_refresh_semanal` | — |
| `cron_job` | `cron.afiacao_sugestoes_diarias` | — |
| `cron_job` | `cron.call-log-missed-backstop` | — |
| `cron_job` | `cron.carteira-positivacao-snapshot-mensal` | — |
| `cron_job` | `cron.carteira-rebuild-nightly` | — |
| `cron_job` | `cron.compute-association-rules-daily` | — |
| `cron_job` | `cron.compute-costs-daily` | — |
| `cron_job` | `cron.daily-calculate-scores` | — |
| `cron_job` | `cron.data-health-watchdog` | — |
| `cron_job` | `cron.detectar-outliers-diario` | — |
| `cron_job` | `cron.disparar-pedidos-aprovados-oben` | — |
| `cron_job` | `cron.fin-cashflow-snapshot-diario` | — |
| `cron_job` | `cron.fin-ic-reconcile-daily` | — |
| `cron_job` | `cron.fin-refresh-analise-dimensoes` | — |
| `cron_job` | `cron.fin-sync-base-diario` | — |
| `cron_job` | `cron.fin-sync-continuacao-10min` | — |
| `cron_job` | `cron.fin-sync-cp-2x` | — |
| `cron_job` | `cron.fin-sync-cr-2x` | — |
| `cron_job` | `cron.fin-sync-heartbeat` | — |
| `cron_job` | `cron.fin-sync-mov-2x` | — |
| `cron_job` | `cron.fin-sync-watchdog` | — |
| `cron_job` | `cron.gerar-pedidos-diario-oben` | — |
| `cron_job` | `cron.monthly-tool-report` | — |
| `cron_job` | `cron.omie-sync-estoque-diario` | — |
| `cron_job` | `cron.omie-sync-metadados-daily` | — |
| `cron_job` | `cron.omie-sync-status-produtos-diario` | — |
| `cron_job` | `cron.process-recurring-orders-daily` | — |
| `cron_job` | `cron.sayerlack-portal-watchdog` | — |
| `cron_job` | `cron.scoring-recalc-batch-nightly` | — |
| `cron_job` | `cron.sync-colacor-vendas-products` | — |
| `cron_job` | `cron.sync-inventory-vendas-30m` | — |
| `cron_job` | `cron.sync-omie-services-hourly` | — |
| `cron_job` | `cron.sync-products-customers-daily` | — |
| `cron_job` | `cron.sync-reprocess-operational` | — |
| `cron_job` | `cron.sync-reprocess-strategic` | — |
| `cron_job` | `cron.vendas-sync-pedidos-colacor-2h` | — |
| `cron_job` | `cron.vendas-sync-pedidos-oben-2h` | — |
| `cron_job` | `cron.visit-score-recalc-batch-nightly` | — |
| `cron_job` | `cron.weekly-algorithm-a-audit` | — |

### `20260527235000_dispatch_notifications_frequente.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.afiacao_dispatch_notificacoes_30min` | — |

### `20260527240000_data_health_alert_channel.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260527250000_data_health_checks_high.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260527250000_nao_vinculados_cron.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.nao-vinculados-refresh-diario` | — |

### `20260527260000_data_health_vendas_cadastros_dado.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |

### `20260528000000_fin_sync_watchdog_tail_failing.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_sync_watchdog_check` | — |

### `20260528010000_cron_sync_customers_dedicated.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.sync-customers-vendas-daily` | — |

### `20260528020000_data_health_reposicao_acoes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260528030000_cron_sayerlack_lote_retry.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.sayerlack-portal-lote-retry` | — |

### `20260528040000_sayerlack_retry_motor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.sayerlack_retry_orfaos` | — |
| `table` | `public.sayerlack_retry_motor_log` | — |
| `cron_job` | `cron.sayerlack-retry-orfaos` | — |

### `20260528120000_reposicao_custo_cmc_em_transito.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260528120001_v_titulo_baixas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_titulo_baixas` | — |

### `20260528120002_v_capital_giro_prazos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_capital_giro_prazos` | — |

### `20260528130000_fin_sync_heartbeat_tz_fix.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260528130000_tarefas_bloco_a.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.tarefas` | — |
| `index` | `public.idx_tarefas_assigned_aberta` | `tarefas` |
| `index` | `public.idx_tarefas_created_by` | `tarefas` |
| `index` | `public.idx_tarefas_customer_aberta` | `tarefas` |
| `index` | `public.idx_tarefas_aberta_auto` | `tarefas` |

### `20260528131000_tarefas_bloco_b.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.tarefa_satisfacao_candidatos` | — |
| `table` | `public.tarefa_eventos` | — |
| `index` | `public.idx_candidato_tarefa_pending` | `tarefa_satisfacao_candidatos` |
| `index` | `public.idx_evento_tarefa` | `tarefa_eventos` |

### `20260528132000_tarefas_bloco_c.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_tarefas_estado` | — |
| `rls_policy` | `public.tarefas_select` | `tarefas` |
| `rls_policy` | `public.tarefas_insert` | `tarefas` |
| `rls_policy` | `public.tarefas_update` | `tarefas` |
| `rls_policy` | `public.tcand_select` | `tarefa_satisfacao_candidatos` |
| `rls_policy` | `public.tcand_update` | `tarefa_satisfacao_candidatos` |
| `rls_policy` | `public.tevt_select` | `tarefa_eventos` |
| `rls_policy` | `public.tevt_insert` | `tarefa_eventos` |

### `20260528133000_tarefas_bloco_d.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_matcher_tick` | — |
| `function` | `public.tarefas_escalonamento_tick` | — |
| `cron_job` | `cron.tarefas-matcher-15min` | — |
| `cron_job` | `cron.tarefas-escalonamento-diario` | — |

### `20260528134000_tarefas_bloco_e.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260528135000_tarefas_matcher_created_at_floor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_matcher_tick` | — |

### `20260528140000_data_health_compute_msg_tz.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |

### `20260528140000_whatsapp_fundacao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.whatsapp_webhook_events` | — |
| `table` | `public.whatsapp_conversations` | — |
| `table` | `public.whatsapp_messages` | — |
| `index` | `public.idx_wa_conv_customer` | `whatsapp_conversations` |
| `index` | `public.idx_wa_conv_operator` | `whatsapp_conversations` |
| `index` | `public.idx_wa_conv_last_msg` | `whatsapp_conversations` |
| `index` | `public.idx_wa_msg_conv` | `whatsapp_messages` |
| `rls_policy` | `public.wa_events_staff_select` | `whatsapp_webhook_events` |
| `rls_policy` | `public.wa_conv_staff_all` | `whatsapp_conversations` |
| `rls_policy` | `public.wa_msg_staff_all` | `whatsapp_messages` |

### `20260528150000_fin_estoque_omie_feed.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_estimar_estoque_omie` | — |
| `cron_job` | `cron.sync-inventory-colacor-vendas-1h` | — |
| `cron_job` | `cron.sync-inventory-servicos-1h` | — |

### `20260528160000_route_fundacao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.route_schedule` | — |
| `table` | `public.route_calendar_override` | — |
| `table` | `public.route_disparo_config` | — |
| `table` | `public.route_contact_log` | — |
| `index` | `public.idx_route_schedule_weekday` | `route_schedule` |
| `index` | `public.idx_route_contact_log_customer` | `route_contact_log` |
| `index` | `public.idx_route_contact_log_data` | `route_contact_log` |
| `rls_policy` | `public.route_sched_staff_read` | `route_schedule` |
| `rls_policy` | `public.route_sched_master_write` | `route_schedule` |
| `rls_policy` | `public.route_override_staff_read` | `route_calendar_override` |
| `rls_policy` | `public.route_override_master_write` | `route_calendar_override` |
| `rls_policy` | `public.route_config_staff_read` | `route_disparo_config` |
| `rls_policy` | `public.route_config_master_write` | `route_disparo_config` |
| `rls_policy` | `public.route_log_staff_read` | `route_contact_log` |

### `20260528194751_data_health_consolida_last_error_e_reposicao_checks.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260530120000_visitas_agendadas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.set_updated_at_visitas_agendadas` | — |
| `function` | `public.reconcile_visita_agendada` | — |
| `table` | `public.visitas_agendadas` | — |
| `index` | `public.uq_vag_pendente_cliente_vendedor_data` | `visitas_agendadas` |
| `index` | `public.uq_vag_route_visit_id` | `visitas_agendadas` |
| `index` | `public.idx_vag_scheduled_by_date` | `visitas_agendadas` |
| `index` | `public.idx_vag_pending_by_seller` | `visitas_agendadas` |
| `trigger` | `public.trg_vag_updated_at` | `visitas_agendadas` |
| `trigger` | `public.trg_reconcile_visita_agendada` | `route_visits` |
| `rls_policy` | `public.vag_select_own` | `visitas_agendadas` |
| `rls_policy` | `public.vag_insert_own_carteira` | `visitas_agendadas` |
| `rls_policy` | `public.vag_update_own_pending` | `visitas_agendadas` |
| `rls_policy` | `public.vag_delete_gestor` | `visitas_agendadas` |

### `20260530140000_fin_watchdog_sync_stale_grace_email.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fin_sync_watchdog_check` | — |

### `20260530143818_reposicao_excluir_405ml.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `view` | `public.v_otimizador_compras_insumos` | — |

### `20260530160000_data_health_diagnostico_gate_status.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |

### `20260530170000_unschedule_sayerlack_lote_retry.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260530180000_fix_sku_fornecedor_externo_atualizado_em_trigger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.set_atualizado_em_column` | — |
| `trigger` | `public.sku_fornecedor_externo_set_atualizado_em` | `sku_fornecedor_externo` |

### `20260530190000_data_health_portal_push.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260530190000_reposicao_preencher_parametros_faltantes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.preencher_parametros_faltantes_skus` | — |
| `cron_job` | `cron.reposicao-preencher-parametros-faltantes` | — |

### `20260530200000_data_health_checks_acionaveis.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |

### `20260530200000_reposicao_classificar_sayerlack_grupo_default.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.classificar_sayerlack_grupo_default` | — |
| `cron_job` | `cron.reposicao-classificar-sayerlack-grupo` | — |

### `20260530210000_data_health_restaura_portal_split.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260530210000_reposicao_candidatos_primeira_compra.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.promover_candidato_primeira_compra` | — |
| `view` | `public.v_sku_candidatos_primeira_compra` | — |
| `index` | `public.idx_vih_recorrencia_180d` | `venda_items_history` |

### `20260530210001_cancelar_pedido_limpa_portal.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.cancelar_pedido_sugerido` | — |

### `20260530230000_fix_portal_lock_retry_blindspot.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.envio_portal_lock_candidatos` | — |

### `20260531120000_reposicao_candidatos_inclui_habilitados.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.promover_candidato_primeira_compra` | — |
| `view` | `public.v_sku_candidatos_primeira_compra` | — |

### `20260531130000_data_health_check_sayerlack_fabricado.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260531140000_reposicao_atualizar_params_nao_zera.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.atualizar_parametros_numericos_skus` | — |

### `20260531150000_reposicao_param_limbo_watchdog.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_param_limbo_watchdog` | — |
| `table` | `public.reposicao_param_limbo_log` | — |
| `index` | `public.uq_reposicao_param_limbo_log_dia` | `reposicao_param_limbo_log` |
| `cron_job` | `cron.reposicao-param-limbo-watchdog` | — |

### `20260531160000_reposicao_excluir_fabricado_04.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `view` | `public.v_sku_candidatos_primeira_compra` | — |

### `20260531170000_data_health_check_sayerlack_mapeamento_gap.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |
| `view` | `public.v_sayerlack_mapeamento_gap` | — |

### `20260531170000_route_contact_log_escrita.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.registrar_contato_rota` | — |
| `function` | `public.desfazer_contato_rota` | — |

### `20260601000000_tarefas_escalonamento_titulo_mensagem.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_escalonamento_tick` | — |

### `20260601100000_tarefas_fase2_bloco_a.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.tarefa_templates` | — |
| `index` | `public.idx_tt_ativo_assigned` | `tarefa_templates` |

### `20260601101000_tarefas_fase2_bloco_b.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.uq_tarefa_template_assignee_dia` | `tarefas` |

### `20260601102000_tarefas_fase2_bloco_c.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_tarefas_estado` | — |
| `rls_policy` | `public.tt_select` | `tarefa_templates` |
| `rls_policy` | `public.tt_insert` | `tarefa_templates` |
| `rls_policy` | `public.tt_update` | `tarefa_templates` |
| `rls_policy` | `public.tt_delete` | `tarefa_templates` |

### `20260601103000_tarefas_fase2_bloco_d.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_guard_comprovacao` | — |
| `function` | `public.concluir_com_comprovacao` | — |
| `function` | `public.auditar_tarefa` | — |
| `function` | `public.tarefas_materializar_recorrentes` | — |
| `trigger` | `public.trg_tarefas_guard_comprovacao` | `tarefas` |
| `cron_job` | `cron.tarefas-materializar-recorrentes` | — |

### `20260601104000_tarefas_fase2_bloco_e.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `rls_policy` | `storage.tarefa_comprov_insert_own` | `objects` |
| `rls_policy` | `storage.tarefa_comprov_select_own_ou_gestor` | `objects` |

### `20260602101856_reposicao_refresh_descricao_sku_parametros.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.atualizar_descricao_sku_parametros` | — |
| `cron_job` | `cron.reposicao-refresh-descricao-diario` | — |

### `20260604120000_loyalty_rls_hardening.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.resgatar_recompensa` | — |

### `20260604120000_picking_bridge.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.ensure_picking_task_for_sales_order` | — |
| `function` | `public.recalcular_picking_task` | — |
| `function` | `public.confirmar_item_picking` | — |
| `function` | `public.listar_pedidos_a_separar` | — |
| `index` | `public.uq_picking_tasks_sales_order` | `picking_tasks` |
| `index` | `public.idx_sales_orders_account_kpi` | `sales_orders` |

### `20260604120000_route_queue_snapshot.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.route_queue_snapshot` | — |
| `index` | `public.idx_rqs_data` | `route_queue_snapshot` |
| `index` | `public.idx_rqs_farmer_data` | `route_queue_snapshot` |
| `rls_policy` | `public.rqs_staff_read` | `route_queue_snapshot` |
| `rls_policy` | `public.rqs_self_write` | `route_queue_snapshot` |

### `20260604130000_omie_products_tipo_produto_coluna.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.preserve_tipo_produto` | — |
| `index` | `public.idx_omie_products_account_tipo_produto` | `omie_products` |
| `trigger` | `public.trg_preserve_tipo_produto` | `omie_products` |

### `20260604130000_whatsapp_sla.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.wa_is_stop_keyword` | — |
| `function` | `public.whatsapp_minutos_uteis` | — |
| `function` | `public.wa_owner_efetivo` | — |
| `view` | `public.v_whatsapp_sla` | — |

### `20260604140000_recebimento_efetivacao_ledger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.nfe_efetivacao_tentativas` | — |
| `index` | `public.idx_nfe_efetivacao_tentativas_receb` | `nfe_efetivacao_tentativas` |
| `rls_policy` | `public.staff_select_nfe_efetivacao_tentativas` | `nfe_efetivacao_tentativas` |

### `20260604140000_tipo_produto_consumidores.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `view` | `public.v_sku_candidatos_primeira_compra` | — |

### `20260604140000_whatsapp_sla_digest.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.whatsapp_sla_digest_tick` | — |
| `table` | `public.whatsapp_sla_digest_log` | — |
| `cron_job` | `cron.whatsapp-sla-digest-diario` | — |

### `20260604150000_envio_portal_claim_ids.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.envio_portal_claim_ids` | — |

### `20260604150000_tipo_produto_vigia_cobertura.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260604160000_route_queue_snapshot_nome.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260604170000_posthog_error_webhook.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enfileirar_erro_app` | — |
| `table` | `public.posthog_error_webhook_log` | — |

### `20260604170000_reposicao_blindar_sku_sem_fornecedor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `view` | `public.v_reposicao_sku_sem_fornecedor` | — |

### `20260604170000_tint_catalog_rls_hardening.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260604180000_envio_portal_claim_ids_lista_positiva.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.envio_portal_claim_ids` | — |

### `20260604180000_public_tool_history_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_public_tool_history` | — |

### `20260604182408_embalagem_economica.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.sku_embalagem_equivalencia` | — |
| `table` | `public.sku_preco_fornecedor_capturado` | — |
| `index` | `public.uniq_sku_emb_equiv_ativo` | `sku_embalagem_equivalencia` |
| `index` | `public.idx_sku_emb_equiv_grupo` | `sku_embalagem_equivalencia` |
| `index` | `public.idx_sku_preco_cap_lookup` | `sku_preco_fornecedor_capturado` |
| `rls_policy` | `public.staff_sku_emb_equiv_select` | `sku_embalagem_equivalencia` |
| `rls_policy` | `public.staff_sku_emb_equiv_insert` | `sku_embalagem_equivalencia` |
| `rls_policy` | `public.staff_sku_emb_equiv_update` | `sku_embalagem_equivalencia` |
| `rls_policy` | `public.staff_sku_emb_equiv_delete` | `sku_embalagem_equivalencia` |
| `rls_policy` | `public.staff_sku_preco_cap_select` | `sku_preco_fornecedor_capturado` |
| `rls_policy` | `public.staff_sku_preco_cap_insert` | `sku_preco_fornecedor_capturado` |
| `rls_policy` | `public.staff_sku_preco_cap_update` | `sku_preco_fornecedor_capturado` |
| `rls_policy` | `public.staff_sku_preco_cap_delete` | `sku_preco_fornecedor_capturado` |

### `20260604190000_reposicao_minimo_forcado.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `view` | `public.v_otimizador_compras_insumos` | — |

### `20260605120000_param_auto_tabelas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.reposicao_param_auto_run` | — |
| `table` | `public.reposicao_param_auto_log` | — |
| `table` | `public.reposicao_param_pin` | — |
| `index` | `public.uq_param_auto_run_dia` | `reposicao_param_auto_run` |
| `index` | `public.idx_param_auto_log_run` | `reposicao_param_auto_log` |
| `index` | `public.idx_param_auto_log_sku` | `reposicao_param_auto_log` |
| `rls_policy` | `public.param_auto_run_sel` | `reposicao_param_auto_run` |
| `rls_policy` | `public.param_auto_log_sel` | `reposicao_param_auto_log` |
| `rls_policy` | `public.param_auto_pin_sel` | `reposicao_param_pin` |

### `20260605120000_tarefas_guard_old_requer.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_guard_comprovacao` | — |

### `20260605130000_param_auto_core.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.atualizar_parametros_numericos_skus` | — |

### `20260605130000_tarefas_leitura_na_instancia.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_materializar_recorrentes` | — |
| `view` | `public.v_tarefas_estado` | — |

### `20260605140000_afiacao_os_status_sync.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.mapear_status_etapa` | — |
| `function` | `public.afiacao_os_enqueue` | — |
| `function` | `public.afiacao_os_sync_kick` | — |
| `table` | `public.afiacao_os_sync_fila` | — |
| `index` | `public.idx_afiacao_os_sync_fila_retry` | `afiacao_os_sync_fila` |
| `trigger` | `public.trg_afiacao_os_enqueue` | `orders` |
| `cron_job` | `cron.afiacao-os-sync` | — |
| `rls_policy` | `public.staff_le_afiacao_os_sync_fila` | `afiacao_os_sync_fila` |

### `20260605140000_iniciar_envio_portal_pre_claim.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.iniciar_envio_portal_pre_claim` | — |

### `20260605140000_param_auto_wrapper_revert_cron.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aplicar_parametros_automatico_diario` | — |
| `function` | `public.reverter_parametro_auto` | — |
| `function` | `public.reverter_run_auto` | — |
| `function` | `public.despinar_parametro` | — |
| `function` | `public.reposicao_param_auto_resumo_tick` | — |
| `cron_job` | `cron.reposicao-param-auto-resumo` | — |

### `20260605150000_param_auto_fusivel_calibracao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.atualizar_parametros_numericos_skus` | — |

### `20260605152437_caca_views.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_caca_compradores` | — |
| `view` | `public.v_caca_candidatos` | — |

### `20260606120000_reposicao_rpc_account_aware.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260606130000_detectar_skus_sem_grupo_exclui_04.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.detectar_skus_sem_grupo` | — |

### `20260606140000_detectar_skus_sem_grupo_self_heal.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.detectar_skus_sem_grupo` | — |

### `20260606150000_a2_cmc_base_custo_view.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_sku_parametros_sugeridos` | — |

### `20260606150000_reposicao_qtde_inteira.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260606170000_fornecedores_classificacao_schema.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.cliente_classificacao` | — |
| `table` | `public.fornecedor_excecao` | — |

### `20260606170000_reposicao_fix_aplicar_promocoes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aplicar_promocoes_no_ciclo` | — |

### `20260606170100_fornecedores_classificacao_rpcs.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.classificar_clientes_fornecedores` | — |
| `function` | `public.aplicar_exclusao_fornecedores` | — |
| `function` | `public.reverter_exclusao_fornecedor` | — |
| `function` | `public.cliente_classificacao_derive` | — |
| `trigger` | `public.trg_cliente_classificacao_derive` | `cliente_classificacao` |

### `20260606180000_reposicao_aplicar_promocoes_hardening.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aplicar_promocoes_no_ciclo` | — |

### `20260606180000_reposicao_preco_pedido_cmc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260606190000_reposicao_preco_pedido_cmc_account.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260606190000_reposicao_qtde_inteira_persist.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_persistir_qtde_inteira` | — |

### `20260606200000_reposicao_promo_forward_buying_min.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aplicar_promocoes_no_ciclo` | — |

### `20260606210000_order_feed_view.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.order_feed` | — |

### `20260606230000_negociacao_paralela_v2_cleanup.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260606240000_cron_sync_inventory_full.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.sync-inventory-full-vendas-daily` | — |

### `20260608120000_tool_spec_custom_option.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.adicionar_opcao_tool_spec` | — |

### `20260609085244_data_health_check_familia_ausente.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260609150000_reposicao_alerta_pedido_minimo.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_alerta_pedido_minimo_tick` | — |
| `table` | `public.reposicao_alerta_pedido_minimo` | — |
| `index` | `public.reposicao_alerta_pedido_minimo_ativo` | `reposicao_alerta_pedido_minimo` |
| `cron_job` | `cron.reposicao-alerta-pedido-minimo` | — |

### `20260609150000_tint_sync_promote.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |
| `function` | `public.tint_ensure_corante_stub` | — |
| `function` | `public.tint_calc_preco_final` | — |
| `function` | `public.tint_recalc_preco_oficial` | — |
| `function` | `public.tint_apply_keys_snapshot` | — |
| `table` | `public.tint_staging_precos_base` | — |
| `table` | `public.tint_keys_snapshots` | — |
| `index` | `public.idx_tsp_precos_chave` | `tint_staging_precos_base` |
| `index` | `public.idx_tint_formulas_ativas` | `tint_formulas` |

### `20260609160000_reposicao_ciclo_intraday.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |
| `cron_job` | `cron.gerar-pedidos-intraday-oben` | — |
| `cron_job` | `cron.omie-sync-estoque-intraday-oben` | — |
| `cron_job` | `cron.omie-sync-estoque-diario` | — |

### `20260610130000_melhorias_canal.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.melhoria_itens_touch_updated_at` | — |
| `function` | `public.melhoria_clientes_por_produto` | — |
| `function` | `public.melhoria_produtos_relacionados` | — |
| `table` | `public.melhoria_itens` | — |
| `table` | `public.melhoria_mensagens` | — |
| `index` | `public.idx_melhoria_itens_status` | `melhoria_itens` |
| `index` | `public.idx_melhoria_itens_autor` | `melhoria_itens` |
| `index` | `public.idx_melhoria_mensagens_item` | `melhoria_mensagens` |
| `trigger` | `public.trg_melhoria_itens_touch` | `melhoria_itens` |
| `rls_policy` | `public.melhoria_itens_select` | `melhoria_itens` |
| `rls_policy` | `public.melhoria_itens_insert` | `melhoria_itens` |
| `rls_policy` | `public.melhoria_itens_update` | `melhoria_itens` |
| `rls_policy` | `public.melhoria_mensagens_select` | `melhoria_mensagens` |
| `rls_policy` | `public.melhoria_mensagens_insert` | `melhoria_mensagens` |

### `20260610150000_reposicao_auto_aprovacao_piloto.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_pedido_auto_aprovavel` | — |
| `function` | `public.reposicao_alerta_pedido_minimo_tick` | — |
| `table` | `public.reposicao_auto_aprovacao_log` | — |
| `index` | `public.reposicao_auto_aprovacao_log_criado_em` | `reposicao_auto_aprovacao_log` |

### `20260610200000_push_vendedora.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.upsert_push_subscription` | — |
| `function` | `public.delete_push_subscription` | — |
| `function` | `public._push_enviar` | — |
| `function` | `public.push_whatsapp_inbound` | — |
| `function` | `public.push_tarefa_nova` | — |
| `function` | `public.push_sla_tick` | — |
| `table` | `public.push_subscriptions` | — |
| `index` | `public.idx_push_subscriptions_user` | `push_subscriptions` |
| `trigger` | `public.trg_push_whatsapp_inbound` | `whatsapp_messages` |
| `trigger` | `public.trg_push_tarefa_nova` | `tarefas` |
| `cron_job` | `cron.push-sla-tick` | — |
| `rls_policy` | `public.push_subscriptions_own` | `push_subscriptions` |
| `rls_policy` | `public.push_subscriptions_service` | `push_subscriptions` |

### `20260610200000_radar_fundacao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.radar_recruzar_ja_cliente` | — |
| `table` | `public.radar_empresas` | — |
| `table` | `public.radar_contatos` | — |
| `table` | `public.radar_municipios` | — |
| `table` | `public.radar_ingest_state` | — |
| `index` | `public.idx_radar_empresas_fila` | `radar_empresas` |
| `index` | `public.idx_radar_empresas_local` | `radar_empresas` |
| `index` | `public.idx_radar_empresas_cnae` | `radar_empresas` |
| `index` | `public.idx_radar_contatos_cnpj` | `radar_contatos` |
| `rls_policy` | `public.radar_empresas_select_gestor` | `radar_empresas` |
| `rls_policy` | `public.radar_contatos_select_gestor` | `radar_contatos` |
| `rls_policy` | `public.radar_municipios_select_gestor` | `radar_municipios` |
| `rls_policy` | `public.radar_ingest_state_select_gestor` | `radar_ingest_state` |

### `20260611120000_reposicao_fixes_codex_711.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_oportunidade_ciclo` | — |
| `function` | `public.reposicao_alerta_pedido_minimo_tick` | — |

### `20260611140000_data_health_check_estoque_frescor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260611140000_kb_fundacao_casamento.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.kb_specs_normalize` | — |
| `function` | `public.buscar_skus_candidatos` | — |
| `function` | `public.confirmar_vinculo_boletim` | — |
| `function` | `public.rejeitar_sugestao` | — |
| `view` | `public.v_omie_product_current_spec` | — |
| `table` | `public.omie_product_spec_links` | — |
| `index` | `public.omie_product_spec_links_one_confirmed` | `omie_product_spec_links` |
| `index` | `public.omie_product_spec_links_unique_triple` | `omie_product_spec_links` |
| `trigger` | `public.trg_kb_specs_normalize` | `kb_product_specs` |
| `rls_policy` | `public.omie_product_spec_links_select_staff` | `omie_product_spec_links` |

### `20260611150000_route_city_norm.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.route_city_norm` | — |
| `index` | `public.idx_cvs_city_norm` | `customer_visit_scores` |

### `20260611180000_familia_ausente_lista_email.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._vendas_familia_ausente_lista_email` | — |
| `function` | `public.data_health_watchdog` | — |

### `20260611190000_tint_sync_codex_fixes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |
| `function` | `public.tint_calc_preco_final` | — |
| `function` | `public.tint_recalc_preco_oficial` | — |
| `function` | `public.tint_apply_keys_snapshot` | — |

### `20260611195000_reposicao_aplicar_snapshot_pendente.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aplicar_snapshot_pendente` | — |

### `20260611200000_reposicao_motor_fonte_unica.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.gerar_pedidos_sugeridos_ciclo` | — |

### `20260611210000_data_health_estoque_via_marcador.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260611220000_reposicao_claim_full_sync.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.claim_estoque_full_sync` | — |
| `function` | `public.finalizar_estoque_full_sync` | — |

### `20260612120000_auto_assign_role_omie_import_guard.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.auto_assign_user_role` | — |

### `20260612130000_radar_rpcs_contato.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.registrar_contato_radar` | — |
| `function` | `public.desfazer_contato_radar` | — |
| `function` | `public.radar_kpis` | — |

### `20260613120000_customer_canonical_alias.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `table` | `public.customer_canonical_alias` | — |
| `index` | `public.idx_cca_canonical` | `customer_canonical_alias` |
| `index` | `public.idx_cca_status_active` | `customer_canonical_alias` |
| `rls_policy` | `public.cca_select_gestor_master` | `customer_canonical_alias` |

### `20260613120000_kb_0c_aprovacao_master_only.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.confirmar_vinculo_boletim` | — |
| `function` | `public.desvincular_boletim` | — |
| `rls_policy` | `public.kb_product_specs_insert_master` | `kb_product_specs` |
| `rls_policy` | `public.kb_product_specs_update_master` | `kb_product_specs` |

### `20260613120000_onda1_fase0_sales_orders_identidade.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.sales_orders_checkout_account_uq` | `sales_orders` |
| `index` | `public.idx_sales_orders_origem` | `sales_orders` |

### `20260613130000_radar_rls_initplan_perf.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `rls_policy` | `public.radar_empresas_select_gestor` | `radar_empresas` |
| `rls_policy` | `public.radar_contatos_select_gestor` | `radar_contatos` |
| `rls_policy` | `public.radar_municipios_select_gestor` | `radar_municipios` |
| `rls_policy` | `public.radar_ingest_state_select_gestor` | `radar_ingest_state` |

### `20260613150000_kb_spec_versions_faseA.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.kbv_block_mutation` | — |
| `function` | `public.aprovar_versao_boletim` | — |
| `table` | `public.kb_product_spec_versions` | — |
| `index` | `public.idx_kbv_identidade` | `kb_product_spec_versions` |
| `index` | `public.idx_kbv_source_doc` | `kb_product_spec_versions` |
| `trigger` | `public.trg_kbv_immutable` | `kb_product_spec_versions` |
| `rls_policy` | `public.kbv_select_staff` | `kb_product_spec_versions` |

### `20260613160000_kb_extraction_drafts.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.kb_extraction_draft_claim` | — |
| `table` | `public.kb_extraction_drafts` | — |
| `trigger` | `public.trg_kb_extraction_drafts_updated_at` | `kb_extraction_drafts` |
| `rls_policy` | `public.kb_extraction_drafts_select_master` | `kb_extraction_drafts` |
| `rls_policy` | `public.kb_extraction_drafts_delete_master` | `kb_extraction_drafts` |

### `20260613170000_fix_auto_assign_master_escalation.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.auto_assign_user_role` | — |

### `20260613180000_kb_hardening_codex.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.aprovar_versao_boletim` | — |
| `function` | `public.kbv_block_mutation` | — |
| `index` | `public.kbv_uma_viva` | `kb_product_spec_versions` |
| `trigger` | `public.trg_kbv_immutable` | `kb_product_spec_versions` |

### `20260613190000_radar_fatia3.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.radar_contagem_por_municipio` | — |
| `function` | `public.radar_atribuir_tarefa` | — |
| `function` | `public.radar_registrar_cadastro_omie` | — |

### `20260613210000_radar_perf_indices.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_radar_lista_novas` | `radar_empresas` |
| `index` | `public.idx_radar_lista_estab` | `radar_empresas` |
| `index` | `public.idx_radar_muni` | `radar_empresas` |

### `20260613230000_roteirizador_prospects.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.radar_salvar_geocode` | — |
| `function` | `public.radar_prospects_para_rota` | — |

### `20260614103251_onda1_fase1_farmer_calls_atendimento.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_farmer_calls_atendimento_id` | `farmer_calls` |

### `20260614140000_radar_contagem_perf.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.radar_contagem_por_municipio` | — |
| `index` | `public.idx_radar_muni_cover` | `radar_empresas` |

### `20260614160000_roteirizador_campo_banco.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.norm_cidade` | — |
| `function` | `public.carteira_por_municipio` | — |
| `function` | `public.radar_prospects_para_rota` | — |

### `20260614170000_cmc_ledger.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.cmc_ledger_capture` | — |
| `table` | `public.cmc_ledger` | — |
| `index` | `public.idx_cmc_ledger_lookup` | `cmc_ledger` |
| `trigger` | `public.trg_cmc_ledger_capture` | `inventory_position` |
| `rls_policy` | `public.cmc_ledger_select_staff` | `cmc_ledger` |

### `20260614170000_roteirizador_campo_carteira_sufixo_uf.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.carteira_por_municipio` | — |

### `20260614180000_markup_policy.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.resolve_markup_policy` | — |
| `table` | `public.markup_policy` | — |
| `index` | `public.uq_markup_policy_conta` | `markup_policy` |
| `index` | `public.uq_markup_policy_fam` | `markup_policy` |
| `index` | `public.uq_markup_policy_sku` | `markup_policy` |
| `rls_policy` | `public.markup_policy_select_staff` | `markup_policy` |
| `rls_policy` | `public.markup_policy_write_master` | `markup_policy` |

### `20260614190000_get_preco_cockpit.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_preco_cockpit` | — |

### `20260614231801_reposicao_timeout_sync_inventory.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.sync-inventory-vendas-30m` | — |
| `cron_job` | `cron.sync-inventory-colacor-vendas-1h` | — |

### `20260615091839_retencao_cron_job_run_details.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.purge-cron-job-run-details` | — |

### `20260615095710_idx_data_health_freshness_cols.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_inventory_position_synced_at` | `inventory_position` |
| `index` | `public.idx_omie_products_updated_at` | `omie_products` |
| `index` | `public.idx_product_costs_updated_at` | `product_costs` |
| `index` | `public.idx_fin_contas_receber_updated_at` | `fin_contas_receber` |
| `index` | `public.idx_fin_contas_pagar_updated_at` | `fin_contas_pagar` |
| `index` | `public.idx_farmer_client_scores_calculated_at` | `farmer_client_scores` |
| `index` | `public.idx_pedido_compra_sugerido_data_ciclo` | `pedido_compra_sugerido` |

### `20260615103111_idx_omie_products_codigo_text_account.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_omie_products_codigo_text_account` | `omie_products` |

### `20260615120000_cliente_grupos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.cliente_grupos_set_updated_at` | — |
| `table` | `public.cliente_grupos` | — |
| `table` | `public.cliente_grupo_membros` | — |
| `index` | `public.idx_cgm_grupo` | `cliente_grupo_membros` |
| `index` | `public.idx_cgm_documento` | `cliente_grupo_membros` |
| `trigger` | `public.trg_cliente_grupos_updated_at` | `cliente_grupos` |
| `rls_policy` | `public.cliente_grupos_service` | `cliente_grupos` |
| `rls_policy` | `public.cliente_grupos_fin_access` | `cliente_grupos` |
| `rls_policy` | `public.cgm_service` | `cliente_grupo_membros` |
| `rls_policy` | `public.cgm_fin_access` | `cliente_grupo_membros` |

### `20260615130000_tint_vigia_cobertura_sentinela.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260615133000_tint_remapeia_skus_omie_desalinhadas.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260615140000_tint_promote_indices_timeout.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_tsfi_staging_formula_id` | `tint_staging_formula_itens` |
| `index` | `public.idx_tsc_acct_corante` | `tint_staging_corantes` |
| `index` | `public.idx_tsf_acct_par` | `tint_staging_formulas` |
| `index` | `public.idx_tsf_run` | `tint_staging_formulas` |
| `index` | `public.idx_tss_run` | `tint_staging_skus` |
| `index` | `public.idx_tsprod_run` | `tint_staging_produtos` |
| `index` | `public.idx_tsbase_run` | `tint_staging_bases` |
| `index` | `public.idx_tsemb_run` | `tint_staging_embalagens` |

### `20260615150000_cockpit_preco_fixes.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_preco_cockpit` | — |
| `rls_policy` | `public.cmc_ledger_select_gestor` | `cmc_ledger` |

### `20260615160000_tint_promote_set_based.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260615182814_vincular_tint_skus_omie_orfaos.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260615190000_geocoding_cep_geo.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.normalizar_cep` | — |
| `function` | `public.rank_precisao` | — |
| `function` | `public.cep_geo_upsert` | — |
| `function` | `public.carteira_por_municipio` | — |
| `function` | `public.radar_prospects_para_rota` | — |
| `table` | `public.cep_geo` | — |
| `table` | `public.municipio_geo` | — |
| `rls_policy` | `public.cep_geo_sel` | `cep_geo` |
| `rls_policy` | `public.municipio_geo_sel` | `municipio_geo` |

### `20260615194500_fix_tarefas_matcher_enum.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tarefas_matcher_tick` | — |

### `20260615200000_tint_get_price_base.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_tint_price` | — |

### `20260615210000_reposicao_auto_aprovacao_v2.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_pedido_auto_aprovavel` | — |
| `function` | `public.reposicao_alerta_pedido_minimo_tick` | — |
| `table` | `public.reposicao_auto_aprovacao_log` | — |
| `index` | `public.reposicao_auto_aprovacao_log_criado_em` | `reposicao_auto_aprovacao_log` |

### `20260615210000_tint_get_prices_batch.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_tint_prices` | — |

### `20260616020000_fix_aging_views_status_vocab.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.fin_aging_receber` | — |
| `view` | `public.fin_aging_pagar` | — |

### `20260616120000_regua_preco.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_regua_preco` | — |
| `table` | `public.regua_preco_log` | — |
| `index` | `public.idx_regua_preco_log_cliente_sku` | `regua_preco_log` |
| `rls_policy` | `public.regua_preco_log_staff_all` | `regua_preco_log` |

### `20260616120000_tint_price_gate_ativo.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_tint_price` | — |
| `function` | `public.get_tint_prices` | — |

### `20260616120000_v_grupo_contas_receber.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_grupo_contas_receber` | — |
| `view` | `public.v_grupo_contas_receber_por_doc` | — |

### `20260616120001_idx_tactical_plans_lookup.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.idx_tactical_plans_lookup` | `farmer_tactical_plans` |

### `20260616120001_regua_preco_customer360.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_regua_preco_customer360` | — |

### `20260616130000_v_grupo_contatos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_grupo_contatos` | — |

### `20260616140000_v_grupo_comercial.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_grupo_comercial` | — |

### `20260616140941_fatia2_sinais_ligacao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enqueue_score_recalc_from_sinais` | — |
| `table` | `public.sinal_classe_config` | — |
| `index` | `public.idx_farmer_calls_sinais_pendentes` | `farmer_calls` |
| `trigger` | `public.trg_farmer_calls_enqueue_recalc_sinais` | `farmer_calls` |
| `rls_policy` | `public.sinal_classe_config_select_staff` | `sinal_classe_config` |
| `rls_policy` | `public.sinal_classe_config_master_all` | `sinal_classe_config` |
| `rls_policy` | `public.sinal_classe_config_service_all` | `sinal_classe_config` |

### `20260617091500_sinal_classe_config_check_classe.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260617130000_tint_promote_preserva_preco.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260617133633_vendas_sync_cursor.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.vendas_sync_lease_acquire` | — |
| `function` | `public.vendas_sync_heartbeat` | — |
| `function` | `public.vendas_sync_release` | — |
| `function` | `public.vendas_sync_finish` | — |
| `table` | `public.vendas_sync_cursor` | — |
| `index` | `public.idx_vendas_sync_cursor_pendentes` | `vendas_sync_cursor` |
| `cron_job` | `cron.vendas-sync-continuacao-6min` | — |
| `rls_policy` | `public.vendas_sync_cursor_select_staff` | `vendas_sync_cursor` |
| `rls_policy` | `public.vendas_sync_cursor_service_all` | `vendas_sync_cursor` |

### `20260617133634_sales_orders_omie_hash_unique.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.uniq_sales_orders_omie_hash` | `sales_orders` |

### `20260617150000_tint_promote_reexpand_skus_novos.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260617160000_criar_pedidos_com_itens.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.criar_pedidos_com_itens` | — |

### `20260618130000_recencia_colacor_created_at.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260618130000_tint_promote_e4_so_com_custo.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260618180000_get_customer_sales_summary.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_customer_sales_summary` | — |

### `20260618190000_b_cleanup_dups_oben.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `index` | `public.uniq_sales_orders_omie_pedido_id` | `sales_orders` |

### `20260618190000_get_customer_sales_summary_blocklist.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_customer_sales_summary` | — |

### `20260618200000_apply_score_updates_anti_ressurreicao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.apply_score_updates` | — |

### `20260618210000_b_renamespace_orfaos.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260618230000_fix_enqueue_sinais_owner_e_reconcile_fila.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.enqueue_score_recalc_from_sinais` | — |

### `20260619120000_param_auto_resumo_descricao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reposicao_param_auto_resumo_tick` | — |

### `20260619120000_trigger_reconcile_score_owner_carteira.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.reconcile_score_owner_from_carteira` | — |
| `trigger` | `public.trg_carteira_reconcile_score_owner` | `carteira_assignments` |

### `20260620130000_cost_price_nullable.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260621120000_seed_targets_faltantes_rpc.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.seed_targets_faltantes` | — |

### `20260621130000_fcs_guard_flagged_insert.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.fcs_block_flagged_insert` | — |
| `trigger` | `public.trg_fcs_block_flagged_insert` | `farmer_client_scores` |

### `20260622120000_trigger_cleanup_orphan_score_on_carteira_delete.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.cleanup_orphan_score_on_carteira_delete` | — |
| `trigger` | `public.trg_carteira_cleanup_orphan_score` | `carteira_assignments` |

### `20260622130000_tint_promote_nome_cor_fallback.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260622140000_apply_score_updates_persiste_base_vendas.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.apply_score_updates` | — |

### `20260622160000_apply_score_updates_guard_full_update.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.apply_score_updates` | — |

### `20260622163000_compute_costs_recompute_2h.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260622165000_sales_history_status_coluna.sql`

> _Nenhum objeto extraído via regex._ Migration provavelmente é `ALTER TABLE` / `UPDATE` / `INSERT` / RLS-only. Validar manualmente.

### `20260622170000_apply_score_updates_sales_history_status.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.apply_score_updates` | — |

### `20260622210000_tint_promote_dedup_itens_corante.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.tint_promote_sync_run` | — |

### `20260623120000_caca_custo_producao.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_caca_compradores` | — |

### `20260623130000_caca_custo_producao_cron.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `cron_job` | `cron.caca-custo-producao-colacor-daily` | — |

### `20260623140000_recencia_mv_order_date_kpi.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.customer_metrics_mv` | — |
| `index` | `public.idx_customer_metrics_mv_uid` | `customer_metrics_mv` |

### `20260623150000_get_customer_sales_summary_tz_fallback.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public.get_customer_sales_summary` | — |

### `20260623160000_data_health_custos_proveniencia.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `function` | `public._data_health_compute` | — |
| `function` | `public.data_health_watchdog` | — |
| `function` | `public.fin_sync_heartbeat` | — |

### `20260624010000_caca_custo_efetivo_fallback.sql`

| Tipo | Objeto | Parent |
| --- | --- | --- |
| `view` | `public.v_caca_compradores` | — |

## Próximos passos quando algo der `❌`

1. Abra a migration correspondente em `supabase/migrations/<arquivo>.sql`
2. Copie o SQL inteiro
3. Supabase SQL Editor → cole → Run
4. Re-rode `scripts/audit-custom-migrations.sql` pra confirmar que virou `✅`
5. (Opcional) `INSERT INTO supabase_migrations.schema_migrations (version, statements) VALUES ('<timestamp>', ARRAY['<sql>']);` pra registrar como aplicada (evita re-apply futura)
