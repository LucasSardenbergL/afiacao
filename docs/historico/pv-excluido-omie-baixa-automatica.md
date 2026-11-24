# PV excluído no Omie — baixa automática (2026-11-21)

**Incidente.** O app só espelhava o CANCELAMENTO de PV (etapa 80 → `cancelado`). PV EXCLUÍDO direto no Omie ficava no
app contando nas vendas, e a reserva de estoque ficava `ativa` para sempre (`private.atp_reconciliar_job` só libera com
a canônica `cancelado`). PV 13693 (Oben, PID 12215613527, limpeza manual #4082) e mais 10 da Oben (recibo #1295). A
listagem completa de 2026-11-21 achou 18 PVs da Oben e 11 da Colacor ausentes do Omie.

**Entrega.** Edge `omie-pv-exclusao-reconciliar` (cron `17 * * * *`) + migration `20261124120000` + prova
`db/test-omie-pv-exclusao.sh` (53 asserts, 12 sabotagens, 2 sessões).

## Régua
- **Triagem nomeia, nunca decide.** Conjunto de PIDs do Omie numa janela de inclusão COMPLETA × banco na mesma janela
  (`order_date_kpi` = dInc). Presença vale por página, mesmo em janela incompleta. Linha `faturado`/`cancelado` no PV =
  contradição (revisão humana), nunca consultada. Disjuntor (> 15 suspeitos; Omie vazio com banco > 3; maioria ausente;
  identidade não confirmada) recusa a janela, com o motivo no `omie_pv_triagem_log`.
- **Confirmação** por `ConsultarPedido`, com a vez concedida pelo BANCO: ≤ 1/h por conta, ≤ 4 tentativas cobradas em
  24h (tudo que não seja `existe` ou `nao_enviada`). Só o fault integral `ERROR: Pedido não cadastrado para o Código
  [PID] !` com HTTP 500 é ausência.
- **Baixa**: 2 ausências (2 `log_id`), a 2ª iniciada ≥ 1h depois da RESPOSTA da 1ª, ambas posteriores à última presença
  (triagem, consulta ou `omie_reconciliado_em`). Na mesma transação: lock por conta (tetos) → locks do ATP → gêmeo →
  todas as linhas do par; revalida; libera reservas (par próprio; divergência nos dois sentidos = revisão) com trilha
  `liberado_por_exclusao_omie` e impacto em `omie_pv_baixa_reserva`; `deleted_at` em todas as linhas vivas.
- **Tetos** por conta em 24h (Codex rodada 2): Oben 2 PVs · R$ 2.000/PV · R$ 2.700 · reserva ≤ 1 un/SKU/PV, ≤ 3 SKUs,
  ≤ 2 un/SKU/24h; Colacor 2 PVs · R$ 750/PV · R$ 1.000 · reserva = revisão. Acima do teto por PV = revisão; acima do
  teto do dia = adiado (tenta de novo na próxima ausência).
- **Durável**: trigger `trg_sales_orders_pv_excluido_omie` — rollback do front e importação tardia não ressuscitam;
  PID atribuído depois vira contradição `pid_atribuido_apos_baixa`. Os 11 históricos entram como aplicados
  (`prova.origem_historica`). **Desfazer** = limpar `aplicado_em` no SQL Editor ANTES de mexer no `deleted_at`.

## Risco residual aceito (decisão desta entrega)
O `omie-vendas-sync` chama `ConsultarPedido` sem a trava compartilhada: um bloqueio que esta edge registra para o
método não é lido por ele, e os erros dele somam no mesmo contador do Omie (IP + app_key + método). Integrar exigiria
mexer em `_shared/omie-cota.ts`, que entra no fingerprint de quase toda edge do Omie (redeploy em massa). Compensação:
orçamento próprio de ≤ 4 tentativas cobradas/24h por conta (o bloqueio é na 10ª incorreta) e 1/h. Follow-up natural:
coordenar `ConsultarPedido` na trava numa leva de deploy própria.

## Onde olhar
- Revisão humana: `SELECT * FROM omie_pv_conferencia WHERE contradicao IS NOT NULL` (inclui as pós-baixa: `reapareceu_apos_baixa`, `pid_atribuido_apos_baixa`, `terminal_apos_baixa`, que nascem com `aplicado_em`).
- Cobertura: `omie_pv_triagem_log` (semanas registradas × recusadas) e `omie_pv_execucao.resumo`.
