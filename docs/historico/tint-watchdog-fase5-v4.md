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

## Prova
36 asserts; `--falsificar` roda o controle verde e 16 sabotagens de conjunto exato (3 de pós-condição que exigem o
apply abortar), nos locales C e pt_BR.UTF-8. ~7s normal, ~36s falsificando (laptop). Os conjuntos foram MEDIDOS:
4 divergiram da previsão e ensinaram — o filtro de status do snapshot é redundante quando `aplicado_em` é NULL
(NULLS LAST já descarta); o relógio `aplicado_em` derruba também a igualdade; a pós-condição da tabela nova só morde
no 1º apply (tabela fresca, default privilege do Supabase).
