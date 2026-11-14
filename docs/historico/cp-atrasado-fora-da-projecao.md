# CP atrasado some da projeção de caixa (diagnóstico de 2026-10-28 a 2026-10-31)

**Estado (14/11/2026):** o founder decidiu **só tornar visível** (seção "Visibilidade entregue", no fim). O saldo projetado **não** muda e esses títulos seguem fora de todas as semanas até a conferência título a título decidir entre as opções abaixo. Achado durante a rodada oficial do orçamento de compra (LucasSardenbergL/afiacao#3327).

## O defeito

Em `supabase/functions/fin-cashflow-engine/index.ts` (laço de semanas, ~linha 1004), uma saída do contas a pagar só entra na semana se `data_vencimento` estiver entre o início e o fim dela. O título **vencido antes da segunda-feira da semana corrente**, ainda aberto, não cai em semana nenhuma: **some da projeção de 13 semanas e do `fin_cashflow.snapshot_diario`**. O contas a receber vencido é reagendado para a frente pela curva de aging (~linha 960, "Vencido reagenda pra frente (não some)"). O contas a pagar vencido não tem tratamento equivalente.

**Assinatura:** no `snapshot_diario`, o número de saídas com data anterior ao dia do snapshot **zera toda segunda-feira** (medido: 07/09, 14/09, 21/09, 28/09, 05/10, 12/10 e 26/10).

**Efeito:** a projeção fica **otimista e calada** sempre que há atraso. No orçamento de compra, a conciliação da Sayerlack pega o buraco e marca o ciclo como indeterminado: foram 81 ciclos na rodada de 28/10, todos do fail-closed funcionando. Para os outros fornecedores, nada pega.

## Tamanho (Oben, 2026-10-31, `psql-ro`)

- **138 títulos ATRASADOS** de semanas anteriores, **R$ 584.815** em saldo. Nenhum tem `valor_pago` nem baixa em `v_titulo_baixas`, e quase todos foram sincronizados com o Omie nos últimos 3 dias. Para o Omie, estão em aberto.
- Por idade: até 30 dias, R$ 75 mil; 30 a 60, R$ 47 mil; 60 a 180, R$ 281 mil; **mais de 180, R$ 182 mil** (o mais antigo vence em 19/11/2025).
- Quase tudo é **parcelamento**, com documentos no formato `x/y`, `PARC…`, `PA.…`, `PARC.EMP/…` e `EMPR.…`:

| Fornecedor Omie | Categorias | Saldo | Série |
|---|---|---|---|
| 8703899645 | `2.06.01`, `2.06.94`, `2.06.96` | R$ 232 mil | PAGO até mar–abr/2026; ATRASADO desde dez/2025 |
| 8709759440 | `2.06.03`, `2.06.04`, `2.06.05`, `2.06.94`, `2.06.98` | R$ 164 mil | atrasados desde dez/2025 **intercalados** com parcelas mais novas PAGAS (`2.06.04`: último pago com vencimento em 25/09) |
| 8689708057 | `2.05.03` (`PARC.EMP/01/48`) | R$ 94 mil | parcela de empréstimo; PAGO até mai/2026 |
| 8689681266 (Sayerlack) | `2.01.01` | R$ 66 mil | NFs de compra |

- `nome_fornecedor` e `categoria_descricao` vêm **vazios** nesses títulos, e nenhuma tabela do banco tem os nomes. `data_pagamento` também vem vazio, até nos títulos PAGO.

## Leitura (não é prova)

Parcela de empréstimo e de tributo costuma ser **debitada direto na conta, sem baixa no Omie**. Nesse caso o dinheiro já saiu do saldo bancário, e o ATRASADO é status velho; incluí-lo na projeção contaria a saída duas vezes. A série intercalada da 8709759440 aponta para renegociação ou para baixa que não foi lançada. Mas uma dívida que parou de ser paga em mai/2026 tem exatamente a mesma cara no banco. **Só o extrato ou o Omie decidem.**

## Decisão pendente do founder

1. **Status velho:** limpar as baixas no Omie (é na fonte, e o motor não muda). O motor ganha só um alarme de "CP atrasado há mais de N dias", para que a próxima série esquecida não fique muda.
2. **Dívida real:** o motor passa a lançar o CP vencido e aberto no dia 0 da semana corrente (pior caso, simétrico ao CR). O saldo inicial projetado cai em cerca de R$ 585 mil, e isso muda o painel de caixa, `caixa_negativo_semanas` e a guarda do orçamento de compra.
3. **Misto:** conferir título a título. A lista com fornecedor, categoria, documento, lançamento Omie, vencimento e saldo foi gerada pela consulta da próxima seção, em `docs/superpowers/orcamento-compra/saida/cp-atrasados-oben.csv`, que fica fora do git.

## Para re-medir

```sql
select count(*), round(sum(saldo)) from fin_contas_pagar
where company = 'oben' and status_titulo = 'ATRASADO'
  and data_vencimento < date_trunc('week', current_date)::date;
```

## Visibilidade entregue (engine v2.4, 14/11/2026)

O founder decidiu, em 14/11, **só tornar visível** até a conferência título a título. Nenhum saldo ou saída projetada muda.

- **Motor (`fin-cashflow-engine` v2.4):** `cp-vencido.ts` mede, dentro de `gerarSemanas` e com o mesmo `semanaInicio`, o CP aberto (`isOpenTitleStatus`, saldo > 0) com vencimento antes da segunda corrente. Devolve contagem, total, vencimento mais antigo e R$ por faixa de atraso (até 30, 31 a 60, 61 a 180, mais de 180 dias), somando em centavos inteiros para Σ faixas = total.
- **Onde aparece:** `cp_vencido_fora_projecao` na resposta (o painel de 13 semanas avisa quando o total é maior que 0) e 7 colunas `cp_vencido_fora_*` no `fin_projecao_snapshots` (`db/2026-11-14-fin-projecao-snapshots-cp-vencido.sql`, um único escritor, que é o cron). NULL quer dizer não medido (snapshot anterior). Os 3 cenários repetem a mesma exposição, então a série lê o `realista`.
- **Prova:** com e sem os CP vencidos, as semanas são idênticas (`cp-vencido-fora_test.ts`, falsificado). Main e branch dão respostas e as 15 escritas idênticas fora do campo novo. A migration foi provada em PG17 com 3 sabotagens.
- **Medido em 14/11 (mesmo predicado):** oben 164 títulos e R$ 687.207,50; colacor 184 e R$ 337.742,94; colacor_sc 91 e R$ 125.026,33. A colacor e a colacor_sc também têm o buraco.
- **Re-medir pelo snapshot:** `select company, cp_vencido_fora_qtd, cp_vencido_fora_total, cp_vencido_fora_mais_antigo from fin_projecao_snapshots where cenario = 'realista' and cp_vencido_fora_qtd is not null order by snapshot_at desc limit 3;`
