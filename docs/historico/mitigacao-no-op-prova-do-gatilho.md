# Mitigação no-op com prova verde — a prova testou o GATILHO, não o EFEITO (#3054, 2026-10-13)

**O que aconteceu.** Para tirar do balcão as fórmulas-fantasma (cor que a fonte retirou, reativada
pelo promote todo dia), o #3054 criou `tint_reaplicar_snapshot_tick()` + um cron de 6h que
re-marcava o snapshot de chaves como `pendente`, para o apply desativar as fantasmas de novo. Foi
mergeado com prova verde (16 asserts, 6 sabotagens no alvo) e aplicado em prod pelo `db:aplicar`
com pré-voo, ensaio e 2ª testemunha. **Era no-op:** `tint_apply_keys_snapshot` retorna
`{"ok": true, "skipped": "snapshot fora de ordem"}` quando `generated_at <=
tint_integration_settings.last_keys_snapshot_at`, e todo apply bem-sucedido grava esse campo —
re-aplicar o mesmo snapshot nunca desativa nada, e ainda sai `ok: true`, então o tick marca
`aplicado` e nada aparece como erro. A outra sessão mediu (`deletes=0`), desagendou o cron
(20261013200000) e o #3051 consertou a raiz. Dano em dado: zero — o cron foi removido antes do
primeiro horário dele. A função órfã sai em 20261015090000.

Três falhas de processo, cada uma com a forma reutilizável:

1. **Ler o `prosrc` com `grep` filtrado pelos termos que se espera achar só acha o que se espera.**
   O filtro foi `blast|teto|desativ|UPDATE|chunk|abort|RAISE|guard|pct|fracao`; o portão de ordem
   (`last_keys_snapshot_at`, `skipped`, `fora de ordem`) não casa nenhum, e estava 30 linhas ACIMA
   das guardas de blast radius que eu li. ⇒ da função que você supõe que fará o trabalho, leia
   **todo `RETURN` antecipado** — retorno cedo com `ok: true` é exatamente o que um filtro por
   "erro/guarda" nunca mostra.

2. **Quando a função só ENFILEIRA, a prova tem de executar o CONSUMIDOR.** Os 16 asserts provavam
   que o snapshot virava `pendente`; nenhum chamava `tint_apply_keys_snapshot`. As 6 sabotagens
   tinham dente — na metade que não importava. Um assert aplicando o mesmo snapshot duas vezes e
   exigindo `desativadas > 0` derrubava a premissa em 2 s. É o "PL/pgSQL é late-bound ⇒ teste
   EXECUTANDO" do CLAUDE.md aplicado um nível raso demais: executar o gatilho não executa o efeito.

3. **Estado do PR não é estado da prod.** Antes de aplicar, conferi que o #3051 seguia draft no
   GitHub e concluí que o conserto não estava em prod. Estava desde 19:15 UTC (ledger #427) — o
   founder o aplicou antes do merge. `pg_get_functiondef` no promote vivo teria parado o apply; é a
   regra "aviso/estado é PISTA, prova é o ARTEFATO" do §Multi-sessão, que vale para PR também.

**Fato lateral, para não virar folclore.** O cabeçalho de 20261013200000 atribui ao cron do #3054 a
re-marcação das 18:30 UTC de 13/10 (e o alarme "fila de promoção atrasada" das 15:30 BRT). A função
**não existia** em prod naquela hora — pré-voo das ~22:15 com `to_regprocedure(...) IS NULL`, apply
no ledger #430 às 22:17:47. Foi o único re-apply "fora de ordem" em 30 dias, e o conector não pode
tê-lo causado (`tint-sync-agent` só marca `pendente` onde `aplicacao_status IS NULL`). Causa não
identificada, **não recorrente** — não há fonte viva de alarme falso por esse caminho.
