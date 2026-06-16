# Baseline/squash do schema (Supabase-aware) — design

**Data:** 2026-05-24
**Status:** ⚠️ RECONCILIADO 2026-05-24 — em paralelo, os PRs #244/#247 entregaram o **snapshot** (`supabase/schema-snapshot.sql`) na main. Esta branch virou o **complemento funcional** (entregue): `supabase/schema-infra-outside-public.sql` + `schema-rebuild-runbook.md` + `schema-security-report.md`. **A parte de SQUASH/ARCHIVE das migrations foi DESCARTADA** (codex consult: não mexer em `supabase/migrations/` enquanto o Lovable é dono operacional do backend). Este doc é o registro do design/raciocínio; a abordagem final está no `README-schema.md` + runbook.
**Branch:** `feat/baseline-squash-schema`

## Problema

O schema de produção da Afiação (Supabase gerenciado pelo Lovable Cloud, projeto `fzvklzpomgnyikkfkzai`) divergiu sistemicamente das 222 migrations incrementais commitadas em `supabase/migrations/`. Muitos objetos foram criados **direto em produção pelo Lovable** e nunca ganharam um `CREATE` commitado.

Evidência concreta (2026-05-24): das **34 views** ALTERadas em `20260510235956_a5ace125-...sql` (`ALTER VIEW ... SET (security_invoker=on)`), **25 não têm `CREATE` commitado**. Tabelas (ex: `fornecedor_cadeia_logistica`) e funções têm o mesmo padrão. Consequência: um **clean-rebuild** (`db reset` a partir só dos arquivos de migration) **quebra** — a `20260510235956` ALTERa views que nenhuma migration anterior cria.

As 25 views sem `CREATE` commitado: `v_cron_jobs_falhas`, `v_cron_jobs_status`, `v_des_checkin_atual`, `v_des_desconto_por_checkin`, `v_des_pedidos_em_transito`, `v_des_posicao_trimestre_ao_vivo`, `v_des_snapshot_mais_recente`, `v_desconto_flat_condicional_ativo`, `v_leadtime_por_grupo`, `v_notificacoes_status`, `v_oportunidade_economica_hoje`, `v_pedidos_em_aberto`, `v_promocao_avaliacao_hoje`, `v_promocao_item_efetivo`, `v_simulacao_comparativa`, `v_simulacao_ranking_global`, `v_sku_aumento_vigente`, `v_sku_classificacao_abc_xyz`, `v_sku_demanda_estatisticas`, `v_sku_demanda_rajada`, `v_sku_leadtime_estatisticas`, `v_sku_leadtime_history_normal`, `v_sku_parametros_sugeridos`, `v_sku_sigma_demanda`, `v_sugestao_negociacao_ativa`.
(As 4 views da stack SLA já foram sincronizadas nas migrations `20260523230835` + `20260524121531`.)

## Objetivo / critério de sucesso

**Clean-rebuild replayável e FUNCIONAL:** um ambiente Supabase vazio + rodar o baseline reproduz um ambiente equivalente ao de produção — não só DDL de `public`, mas também o que faz o app funcionar (crons, buckets, realtime, extensions). Destrava: staging real, recuperação de desastre, onboarding de ambiente novo.

Não-objetivos: mexer em produção (já está correta); reescrever lógica de negócio; resolver drift de dados (só schema/DDL + contratos de infra); copiar secrets reais do vault (só nomes/contratos).

## Restrições

- **Founder só acessa o banco via Lovable** — SQL Editor + chat do Lovable (que tem acesso ao backend). Sem CLI/`psql`/`pg_dump`/`supabase` na máquina dele (CLAUDE.md §5).
- Migrations custom **não são auto-aplicadas** pelo Lovable.
- O agente (Claude) **pode** rodar ferramentas locais (docker / supabase CLI / postgres) pra verificação — sujeito a disponibilidade (a confirmar no plano).

## Abordagem escolhida: squash baseline **Supabase-aware**

Substituir o histórico incremental por um **baseline reprodutível** = `public` como núcleo (DDL completa) **+ um manifesto/runbook** para tudo que vive fora de `public` e é necessário pra um ambiente funcional. Arquivar as 222 migrations antigas **fora da árvore ativa** de migrations. Produção não é tocada.

Por que squash e não gap-fill: o baseline é, por construção, o schema completo e atual; sem "objeto esquecido", sem ordenação manual frágil, sem datar-no-passado. **Mas** (correção pós-codex) um dump só de `public` dá falsa sensação de completude — daí o componente Supabase-aware.

### O que vive FORA de `public` e precisa ser capturado (manifesto + runbook, não só dump)

- **Extensions** (`pg_cron`, `pg_net`, `pgcrypto`, `pg_trgm`, etc.) — incluir `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA extensions` no topo. ⚠️ há migration que moveu `pg_trgm` pra `extensions`; preservar refs qualificadas `extensions.*`.
- **Crons** (`cron.job`) — recriar `cron.schedule(...)` com **placeholders** no lugar dos secrets (`CRON_SECRET`, `SERVICE_ROLE_KEY`, `project_url` vêm do vault). Sem isso, staging não roda jobs.
- **Storage buckets** (`INSERT INTO storage.buckets`) — DML em schema gerenciado; uploads quebram sem isso.
- **Realtime publications** (`supabase_realtime`) — há `enable_realtime_dashboard_v3`; verificar e incluir no runbook.
- **Vault** — só **nomes/contratos** dos secrets esperados (NUNCA valores).
- **Refs a `auth`/`storage`** em policies/functions — garantir que o ambiente alvo as tenha (Supabase provê).

## Fases de execução (vira plano detalhado)

**Fase 0 — Pré-dump (gates de qualidade).**
- **Inventário pré-dump:** rodar no Lovable SQL Editor contagens/listas de objetos de produção (tabelas, colunas, views, functions, policies, grants, RLS flags, extensions, crons, buckets) — vira a baseline de comparação da Fase 3.
- **Freeze window:** enquanto extrai, evitar mudanças do Lovable no DB (senão o baseline nasce defasado).

**Fase 1 — Extrair (gated no Lovable).**
- **Primário:** prompt pro chat do Lovable gerar dump schema-only de `public` (`pg_dump --schema-only --schema=public --no-owner`) **mantendo** GRANTs/RLS/policies/`security_invoker`/function EXECUTE grants. + capturar separadamente os objetos fora-de-`public` (crons sem secrets, buckets, publications, extensions).
- **Fallback:** reconstrução por introspecção via SQL Editor (`pg_get_viewdef`, `pg_get_functiondef`, `pg_get_constraintdef`, `pg_policies`, `cron.job`, `storage.buckets`, `pg_extension`), ordenada por dependência.
- **Decisão:** testar o primário primeiro; fallback só se falhar.

**Fase 2 — Revisar, escopar e sanitizar o dump.**
- **Manter:** tabelas, views (+`security_invoker`), matviews, sequences, tipos/enums, funções, triggers, índices, constraints, RLS (`ENABLE`/`FORCE`/policies/`WITH CHECK`), GRANTs pra `anon`/`authenticated`/`service_role` **incluindo os REVOKE/GRANT de hardening de EXECUTE** (não tratar como ruído).
- **Remover/ajustar:** `CREATE ROLE` de roles gerenciados; `ALTER ... OWNER TO` (`--no-owner` cobre); `SET row_security`; ACLs a roles internos indevidos; comentários com dados sensíveis; qualquer `vault.decrypted_secrets` materializado.
- **Security report (subproduto):** listar `SECURITY DEFINER` sem `SET search_path = public, pg_temp`, views sem `security_invoker`, policies permissivas, funções com EXECUTE pra `PUBLIC`. Não corrigir no squash, mas **saber** (vira follow-up).
- **`BASELINE_MANIFEST.md`:** documentar o que foi deliberadamente excluído e o que é capturado fora de `public`.

**Fase 3 — Verificar (3 níveis; agente).**
1. **Gate principal — `supabase start` local** (sobe Supabase completo via docker, com roles/auth/extensions): aplicar o baseline e confirmar que executa limpo. Se CLI+docker não disponíveis, isso vira **bloqueio de qualidade** (decidir alternativa, não pular).
2. **Diff por catálogo contra produção:** queries de inventário no banco reconstruído vs produção (via SQL Editor) — tabelas/colunas/tipos/defaults/nullability, constraints/índices/triggers, `pg_get_viewdef`+`reloptions`, function signature+`prosecdef`+`proconfig`, `pg_policies`, grants (`role_table_grants`/`routine_privileges`), `relrowsecurity`/`relforcerowsecurity`, `pg_extension`, `cron.job` (sem secrets), `storage.buckets`.
3. **Não aceitar "pg_dump é fiel por construção"** como verificação — ele pode ser fiel ao escopo errado.

**Fase 4 — Reestruturar o repo (PR).**
- `supabase/migrations/<ts>_baseline_schema_NAO_APLICAR_EM_PROD_EXISTENTE.sql` (núcleo `public`) — nome explícito de que é pra rebuild/staging, não pra prod já existente.
- Mover as 222 migrations antigas pra **fora de `supabase/migrations/`** — ex: `supabase/migrations_archive_pre_baseline/` ou `db/archive/migrations_pre_20260524/` (codex: NÃO deixar `_archive/` dentro de `supabase/migrations/`, senão runner/`find`/Lovable varrem recursivamente). Git preserva tudo.
- `BASELINE_MANIFEST.md` + runbook (Fase 6) no PR.

**Fase 5 — Produção: não toca.**
- Produção já tem tudo; o squash é só do *repo*. `supabase_migrations.schema_migrations` de produção fica como está.

**Fase 6 — Runbook pós-squash** (`docs/db/runbook-baseline.md`).
- Como criar staging limpo a partir do baseline.
- Como aplicar migration futura em produção (via SQL Editor).
- **O que NUNCA rodar contra produção** (ex: `supabase db push` com histórico squashado → divergência "remote migration versions not found"; exige `migration repair` ou marcar baseline como aplicada).
- Como atualizar o baseline se o Lovable criar drift de novo.

## Impacto no `audit:migrations`

O `scripts/audit-custom-migrations.ts` faz parsing por-migration. Com baseline gigante + archive fora da pasta, o parser muda de comportamento. Decidir no plano: adaptar (apontar pro baseline) ou aposentar (o baseline vira a fonte de verdade). Garantir que não vire **falso verde**.

## Riscos

- **🔴 Arquivar as 222 migrations** — aprovado; git preserva. Mitigação: arquivar FORA de `supabase/migrations/`.
- **🟡 Escopo incompleto (fora de `public`)** — mitigado pela abordagem Supabase-aware (manifesto + captura de crons/buckets/realtime/extensions/vault-names).
- **🟡 Interação com o Lovable builder** — **teste real obrigatório antes de mergear:** branch com baseline + archive fora da pasta ativa → pedir ao Lovable gerar uma migration trivial → observar se ele mexe no baseline / ignora o archive / não reintroduz caos.
- **🟡 Supabase CLI remoto / divergência de tracking** — runbook: nunca `db push` contra prod sem repair/baseline-marcada.
- **🟡 pg_dump falhar/parcial** — desarmado pela Fase 1 (testar primeiro) + fallback.
- **🟡 Verificação precisa de ambiente Supabase-compatível** — Fase 3 nível 1 (`supabase start`); se indisponível, é bloqueio a resolver, não detalhe.
- **🟡 Baseline nasce defasado** — Fase 0 freeze window + inventário pré-dump + diff Fase 3.
- **🟢 Rollback** — reverter o PR; produção intacta; archive restaurável.

## Rollback

Reverter o PR (git). Produção não é tocada em nenhuma fase. As 222 migrations arquivadas podem ser restauradas a qualquer momento.

## Questões em aberto (resolver no plano)

1. pg_dump via Lovable funciona? (Fase 1 decide.)
2. `supabase start` (CLI+docker) disponível na máquina pra verificação nível-1? Se não, qual alternativa.
3. Adaptar ou aposentar `audit:migrations`?
4. O Lovable builder lida bem com a nova estrutura (baseline + archive fora da pasta)? (teste real)
5. Caminho exato do archive (`supabase/migrations_archive_pre_baseline/` vs `db/archive/...`).
