# Watchdog da Fase 5 v4 — o sensor passa a medir a fonte (2026-10-13)

**Entrega:** `supabase/migrations/20261013210000_tint_watchdog_fase5_v4_fonte_viva.sql` + `db/test-tint-fase5-watchdog-v4.sh`
(no núcleo do CI). Traz junto a v3 (`20261013120000_tint_watchdog_fase5_s2_persistente.sql`) como histórico: ela
foi aplicada em prod (recibo #401, sha `d26ca586edb1`, commit c2ebcfd02) mas vivia só no branch do PR #3032, fechado.

## O incidente que a v3 não via
- Em 13/10 12:15 UTC: 26.180 fórmulas ATIVAS ausentes do último snapshot de chaves (6.545 chaves-fonte), todas
  canônicas com receita válida, 9.164 com preço final. Causa: o promote reexpandia o staging antigo (#3051).
- A v3 media S2 por `max(desativada_em)`; o ciclo apply→promote zerava esse relógio todo dia. A hipótese "a cor
  retirada volta antes de 30 dias" era FALSA (3.052 das 3.099 chaves-fonte fora de todo snapshot desde 14/09).
- Às ~19h, já com o #3051 aplicado: 25.476 fantasmas ativas (6.369 chaves-fonte). O conserto impede a ressurreição
  nova; as ativas saem no apply do próximo snapshot. O re-apply do #3054 é no-op: o mesmo snapshot sai
  `skipped: fora de ordem` (medido 18:30), embora marque `aplicado` e regrave `aplicado_em`.

## Decisões
- S2 = retirada NOVA (snapshot aplicado dos últimos 7 dias, ausente do último); o total sem ativa vira métrica.
- S5 fantasma × cor nova pelo critério temporal do #3051 (`created_at` dos dois lados).
- Helper v2: fator 1.0 compara com o ciclo anterior; subida de severidade notifica sempre; 2.0 intacto. Efeito
  medido no outro chamador (`tint_promocao_watchdog`, */10): 1 alerta em toda a história, aberto 10 min.
- Encerramento por mudança de critério anotado no alerta, inclusive o v2→v3 retroativo (alerta de 28/09).

## Colisão de timestamp `20261013120000`
A v3 e o `20261013120000_watchdog_diario_so_problema.sql` (#3049) têm a mesma versão. Mantido o nome: o ledger do
`db:aplicar` (`public.db_aplicacoes`) identifica por **sha256** (+ caminho do arquivo); `supabase_migrations.schema_migrations`
não registra as custom (as `20261013*` não estão lá); o `audit-custom-migrations` lista por arquivo; e já há
precedente aplicado em prod (`20261011120000` ×2, `20261010150000` ×2). Renomear quebraria o vínculo do recibo #401.

## Challenge Codex (gpt-6-astra · max, 426s): REPROVADO 2 P1 + 5 P2, sem P0 — todos integrados menos o P2-3
- P1-1: referência por `aplicado_em` deixava um snapshot ANTIGO re-aplicado e pulado virar o "último". Agora:
  o aplicado de maior `generated_at` (a ordem do próprio apply). ⚠️ O #3051 (promote) escolhe por `aplicado_em`
  e herda o furo — o S5 é quem o acusaria.
- P1-2: staging e fórmulas eram lidos em statements diferentes (READ COMMITTED = fotografias diferentes, com
  minutos entre elas): cor nova promovida no meio virava fantasma. Agora tudo num statement só.
- P2-4 encerramento por critério só com referência; P2-5 retroativo pelo ID do alerta (data não prova causa);
  P2-6 janela por snapshot inteiro, não por chunk; P2-7 erro SQL na suíte vira o vermelho `ERRO_SQL` e a
  falsificação exige todos os asserts executados.
- P2-3 (o helper v2 amplia e-mail do `tint_promocao_watchdog` numa oscilação 10→9→10): mantido por decisão, com o
  histórico medido (1 alerta em toda a história) — fica para o founder.

## Prova
41 asserts; `--falsificar` roda o controle verde e 21 sabotagens de conjunto exato (3 de pós-condição que exigem o
apply abortar), nos locales C e pt_BR.UTF-8. ~8s normal, ~54s falsificando (laptop). Os conjuntos foram MEDIDOS:
4 divergiram da previsão e ensinaram — o filtro de status do snapshot é redundante quando `aplicado_em` é NULL
(NULLS LAST já descarta); o relógio `aplicado_em` derruba também a igualdade; a pós-condição da tabela nova só morde
no 1º apply (tabela fresca, default privilege do Supabase).
