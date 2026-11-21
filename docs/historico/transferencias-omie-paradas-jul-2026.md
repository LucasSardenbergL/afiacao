# Transferências entre contas (TRAR/TRAP) somem do espelho a partir de jul/2026: é operação, não sync

**Data:** 2026-11-21 · **Origem:** achado lateral da F1 (extrato Itaú, PR #4052) · **Veredito:** (a) mudança de operação. O financeiro parou de lançar transferência no Omie. Nenhum código mudou.

## Sintoma

Em `public.fin_movimentacoes`, as linhas `natureza IN ('TRAR','TRAP')` (`cOrigem` do `ListarMovimentos`) caem a zero a partir de jul/2026. Última data efetiva: colacor 2026-06-15, oben 2026-08-21 (4 linhas em ago), colacor_sc 2026-09-11. Antes disso eram 22 a 158 por mês.

## Por que não é o sync (`omie-financeiro`)

1. **Re-backfill completo não as trouxe.** A colacor foi reescrita por inteiro em 2026-10-13 (85.501 linhas, 6.739 delas TRA). Mesmo assim a última TRA é de 15/jun. O laço lê o `ListarMovimentos` todo, sem filtro de origem (`natureza = detalhes.cOrigem`).
2. **Não migraram para outro código.** Não apareceu `cOrigem` novo. MANP/MANR não subiram para compensar, e nada com categoria `0.01.01/0.01.02` (CONTA_CORRENTE_REC/PAG) existe depois de jun.
3. **Contraprova por outro endpoint do Omie** (`financas/extrato/ ListarExtrato`, chamado direto da API, só leitura, as 20 contas que já tiveram TRA na oben e na colacor):
   - **mai/2026, controle positivo:** há "Crédito de Transferência" em 12 contas. Itaú-oben tem 58, e o espelho tem 56 TRAR para essa conta.
   - **jul, set e nov/2026:** **0 transferências em todas as 20 contas**, com extrato não vazio (35 a 459 lançamentos por conta e mês). Nenhum fault da API nessa varredura.
4. **O saldo do próprio Omie confirma.** O extrato da conta "Cheque" da oben (8713019941) de 16/06 a 21/11 sai de −R$ 18,6 mil e chega a **+R$ 213 mil**. Tem 183 "Conta Recebida" e **nenhuma saída**. Os cheques e os recebíveis de cartão continuam caindo nas contas intermediárias (CX/AC), e o depósito no Itaú não é mais lançado como transferência.

## Consequências (para quem consome o espelho)

- **F1 (calibração extrato × Omie):** a regra "movimento Omie realizado por dia" vai divergir no Itaú. O banco recebe o depósito de cheque e de cartão, e o Omie não registra o crédito correspondente desde jul/2026. Não é erro de sync, e "corrigir" o espelho não resolve. Ausente ≠ zero: o lado Omie desses dias não está completo.
- **Saldos de caixa do Omie:** Cheque e contas de cartão inflam, e o Itaú fica sub-registrado no Omie. Qualquer relatório de caixa por conta herda esse viés.
- **Decisão de produto, fora do código:** voltar a lançar a transferência no Omie é decisão do financeiro. A outra saída é tratar CX/AC → banco como uma conta só na conciliação.

## Achado colateral (não investigado aqui)

Na mesma conta Cheque e na mesma janela, o espelho soma R$ 727 mil "realizados" (`data_pagamento_omie` preenchida), contra R$ 231,6 mil de "Conta Recebida" no extrato do Omie. O espelho carrega a **baixa (BAXR, R$ 340 mil) e o título liquidado (MANR/RPTR/VENR com `resumo_liquidado`, R$ 345 mil)** do mesmo dinheiro. Uma regra que some as duas famílias conta o mesmo recebimento duas vezes. Isso vale para a regra v1 da F1.

## Como re-medir

```sql
-- espelho: TRA por mês e empresa (data efetiva)
select company, date_trunc('month', coalesce(data_credito_omie, data_pagamento_omie, data_movimento)) m, count(*)
from fin_movimentacoes where natureza in ('TRAR','TRAP') and data_movimento >= '2026-03-01' group by 1,2 order by 1,2;
```

No lado Omie: `ListarExtrato {nCodCC, dPeriodoInicial, dPeriodoFinal}` e contar `cOrigem ~ 'Transf'`. O controle positivo é qualquer mês até jun/2026. Lição de shell: a 1ª varredura deu "0 em tudo" porque `set -- $p` não divide no zsh. As datas foram mal enviadas, a API bloqueou por consumo indevido e cada resposta virou "0 transferências". Um zero só vale com o mês de controle não-zero na **mesma** varredura (cf. [evidencia-positiva-shell.md](evidencia-positiva-shell.md)).
