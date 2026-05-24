# Baseline/squash do schema — design

**Data:** 2026-05-24
**Status:** aprovado (brainstorming) — aguardando review do spec
**Branch:** `feat/baseline-squash-schema`

## Problema

O schema de produção da Afiação (Supabase gerenciado pelo Lovable Cloud, projeto `fzvklzpomgnyikkfkzai`) divergiu sistemicamente das 222 migrations incrementais commitadas em `supabase/migrations/`. Muitos objetos foram criados **direto em produção pelo Lovable** e nunca ganharam um `CREATE` commitado.

Evidência concreta (2026-05-24): das **34 views** ALTERadas em `20260510235956_a5ace125-...sql` (`ALTER VIEW ... SET (security_invoker=on)`), **25 não têm `CREATE` commitado**. Tabelas (ex: `fornecedor_cadeia_logistica`) e funções têm o mesmo padrão (extensão total ainda não enumerada). Consequência: um **clean-rebuild** (`db reset` a partir só dos arquivos de migration) **quebra** — a `20260510235956` ALTERa views que nenhuma migration anterior cria.

As 25 views sem `CREATE` commitado: `v_cron_jobs_falhas`, `v_cron_jobs_status`, `v_des_checkin_atual`, `v_des_desconto_por_checkin`, `v_des_pedidos_em_transito`, `v_des_posicao_trimestre_ao_vivo`, `v_des_snapshot_mais_recente`, `v_desconto_flat_condicional_ativo`, `v_leadtime_por_grupo`, `v_notificacoes_status`, `v_oportunidade_economica_hoje`, `v_pedidos_em_aberto`, `v_promocao_avaliacao_hoje`, `v_promocao_item_efetivo`, `v_simulacao_comparativa`, `v_simulacao_ranking_global`, `v_sku_aumento_vigente`, `v_sku_classificacao_abc_xyz`, `v_sku_demanda_estatisticas`, `v_sku_demanda_rajada`, `v_sku_leadtime_estatisticas`, `v_sku_leadtime_history_normal`, `v_sku_parametros_sugeridos`, `v_sku_sigma_demanda`, `v_sugestao_negociacao_ativa`.
(As 4 views da stack SLA — `v_fornecedor_lt_logistica_total`, `v_sku_lt_teorico`, `v_sku_sla_compliance`, `v_fornecedor_sla_compliance` — já foram sincronizadas nas migrations `20260523230835` + `20260524121531`.)

## Objetivo / critério de sucesso

**Clean-rebuild replayável:** um banco vazio (Supabase-compatível) + rodar as migrations do repo reproduz o schema `public` de produção, sem erro. Isso destrava: staging real construído do repo, recuperação de desastre, e onboarding de ambiente novo.

Não-objetivos: mexer em produção (já está correta); reescrever a lógica de negócio de qualquer objeto; resolver drift de dados (só schema/DDL).

## Restrições

- **Founder só acessa o banco via Lovable SQL Editor** — sem CLI/`psql`/`supabase`/`pg_dump` na máquina dele (CLAUDE.md §5). Toda extração de DDL e qualquer apply passa pelo Lovable (SQL Editor ou chat).
- Migrations custom **não são auto-aplicadas** pelo Lovable.
- O agente (Claude) **pode** rodar ferramentas locais (docker/postgres/supabase CLI) na máquina, pra verificação — sujeito a disponibilidade.

## Abordagem escolhida: squash baseline

Substituir o histórico incremental por **uma migration-baseline única** = retrato completo do schema `public` de produção *hoje*; arquivar as 222 migrations antigas; migrations futuras empilham por cima.

Por que squash e não gap-fill: o baseline é, por construção, o schema **completo e atual** (inclui efeito das 222 migrations + todo o drift uncommitted). Replay = rodar o baseline → schema idêntico. Sem "objeto esquecido", sem ordenação manual frágil, sem datar-no-passado. Gap-fill exigiria caçar/extrair/ordenar/datar cada objeto uncommitted e ainda assim arriscar omissão.

### Fases de execução

**Fase 1 — Extrair o schema (gated no Lovable).**
- **Primário:** prompt pro chat do Lovable gerar um dump schema-only do schema `public`. Comando-alvo:
  `pg_dump --schema-only --schema=public --no-owner` (manter GRANTs/RLS/policies; `--no-owner` porque roles diferem entre ambientes).
- **Fallback** (se o Lovable não conseguir rodar pg_dump): reconstrução por introspecção — eu gero queries pra colar no SQL Editor usando `pg_get_viewdef`, `pg_get_functiondef`, `pg_get_constraintdef`, `information_schema`, `pg_catalog` e ordeno a DDL por dependência. Mais trabalho/round-trips, mais risco de ordem/omissão.
- **Decisão de qual caminho:** testar o primário **primeiro**; só cair no fallback se falhar.

**Fase 2 — Revisar e escopar o dump.**
- Manter (do schema `public`): tabelas, views, matviews, sequences, tipos/enums, funções, triggers, índices, constraints, RLS policies, GRANTs pra `anon`/`authenticated`/`service_role`.
- Remover/ajustar (gerenciado pelo Supabase, não recriar): `CREATE ROLE` de anon/authenticated/service_role/postgres; schemas `auth`/`storage`/`realtime`/`vault`/`graphql`/`extensions`/`net`/`cron`; statements `ALTER ... OWNER TO` (já coberto por `--no-owner`).
- Extensions (`pg_cron`, `pg_net`, `pgcrypto`, etc.): incluir como `CREATE EXTENSION IF NOT EXISTS ...` no topo do baseline (são pré-requisito de funções/crons).
- Header com comentário explicando que é baseline gerado de produção em <data>, e que o histórico pré-baseline vive em `_archive/`.

**Fase 3 — Verificar replay (agente, local).**
- Subir um ambiente Postgres **Supabase-compatível** descartável e rodar o baseline pra provar que executa limpo (sem erro de sintaxe/ordem/dependência). É a prova real da replayabilidade.
- Complexidade conhecida: um Postgres vanilla **não** tem os roles `anon`/`authenticated`/`service_role` nem o schema `auth` (com `auth.uid()` etc.) que RLS/GRANTs referenciam. Opções, em ordem de preferência:
  1. `supabase start` local (sobe Supabase completo via docker) — se CLI+docker disponíveis na máquina.
  2. Postgres descartável + **stub** dos roles e do schema `auth` (criar roles + `auth.uid()`/`auth.role()` stub) antes de rodar o baseline.
  3. Se nenhum viável: aceitar o pg_dump como fiel-por-construção + verificação de sintaxe mais leve (ex: `psql --single-transaction` num Postgres com stubs mínimos), e documentar o limite.

**Fase 4 — Reestruturar o repo (PR).**
- Criar `supabase/migrations/<timestamp>_baseline_schema.sql` (o dump revisado).
- Mover as 222 migrations antigas pra `supabase/migrations/_archive/` (git preserva tudo; subpasta fica fora do replay do runner, que lê só `supabase/migrations/*.sql`).
- O baseline passa a ser a migration ativa mais antiga; futuras empilham por cima.
- PR com aviso de que NÃO requer apply em produção (é só do repo).

**Fase 5 — Produção: não toca.**
- Produção já tem o schema; o squash é só do *repo*. O tracking `supabase_migrations.schema_migrations` de produção fica como está.

### Impacto no `audit:migrations`

O `scripts/audit-custom-migrations.ts` faz parsing por-migration pra montar o manifesto de objetos esperados. Com um baseline gigante, o parser pode descontar/mis-contar. Avaliar na implementação: adaptar o parser pra tratar o baseline, ou aposentar o audit custom (o baseline vira a fonte de verdade do schema). Decisão fica pro plano de implementação.

## Riscos

- **🔴 Arquivar as 222 migrations** — aprovado pelo founder (git preserva o histórico em `_archive/`).
- **🟡 Interação com o Lovable** — o Lovable gera/aplica migrations no fluxo dele. Verificar (doc + teste em branch) que arquivar+baseline não confunde o builder do Lovable antes de mergear. Se confundir, reavaliar (ex: manter as antigas no lugar mas como no-ops, ou outra estrutura de pasta).
- **🟡 pg_dump pode falhar/ser parcial** — desarmado cedo pela Fase 1 (testar primeiro); fallback de introspecção existe.
- **🟡 Verificação de replay precisa de ambiente Supabase-compatível** — tratada na Fase 3 com opções degradadas.
- **🟢 Rollback** — é mudança de repo; reverter o PR. Produção intacta.

## Rollback

Reverter o PR (git). Produção não é tocada em nenhuma fase. As 222 migrations em `_archive/` podem ser restauradas a qualquer momento.

## Questões em aberto (resolver no plano)

1. pg_dump via Lovable funciona? (Fase 1 decide o caminho.)
2. Qual ambiente de verificação de replay está disponível na máquina (supabase CLI? docker?).
3. Adaptar ou aposentar `audit:migrations`?
4. O Lovable builder lida bem com a nova estrutura de pasta?
