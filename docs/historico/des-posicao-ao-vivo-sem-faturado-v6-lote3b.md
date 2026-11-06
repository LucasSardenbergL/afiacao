# DES — posição ao vivo sem faturado confirmado (plano v6, lote 3b)

**Data:** 2026-11-05 · **Camadas:** migration `20261105091216_des_posicao_ao_vivo_sem_faturado_e_nula.sql` + Publish (front ANTES da migration).

## Problema

A `v_des_posicao_trimestre_ao_vivo` somava `COALESCE(s.fat_bruto_valor, 0) + trânsito`. Sem snapshot do GoodData no trimestre (`fat_bruto_confirmado` NULL), a "posição" era só pedido em trânsito, e a faixa (`des_determinar_faixa`) e o gap saíam dela. Medido na prod (psql-ro, 2026-11-05): OBEN T4/26 com posição 297.966,59 só de trânsito e faixa de 3 estrelas; T1 e T3/26 (só meta) com posição 0,00 e gap 400.840,02, a meta inteira. O lote 3 (#3619) já tinha contornado isso no front do Histórico. Este lote corrige a fonte e os outros 4 consumidores.

## Decisão (founder, 2026-11-05)

Corrigir na **view e no front**. Só na view, a Posição Atual pioraria: o front fazia `Number(x ?? 0)`, e um gap NULL renderizava "Meta atingida! 🎯".

## O que mudou

- **View:** as 5 derivadas (posição conservadora/otimista, faixa conservadora/otimista e gap) viram NULL quando `fat_bruto_valor` é NULL. O gap também vira NULL com a meta NULL (`GREATEST(0, 0 − posição)` dava 0, lido como "atingida"). Faturado 0 continua fato: posição 0 conhecida. As 18 colunas de fato (trânsito, contagens, datas) ficam iguais.
- **Front:** o helper `src/components/des/posicao-ao-vivo.ts` gateia por `fat_bruto_confirmado`, o que vale também com a view antiga (a janela entre o Publish e a migration):
  - Posição Atual mostra "—", sem barra e sem "Meta atingida" por ausência.
  - Simulador bloqueia: não mostra o painel nem chama a RPC, que partiria de 0.
  - Check-in fica sem desconto projetado e mostra "Vale —" em vez de "Vale 0,00%".
  - Hub mostra "—", inclusive quando a leitura falha.
- **Dependente:** sem faixa, a linha do check-in sai da `v_des_desconto_por_checkin`, como já saía quando não havia faixa. As respostas do check-in continuam em `v_des_checkin_atual`.

## Provas

- PG17 `db/test-des-posicao-ao-vivo-sem-faturado.sh`: 32 asserts (C e pt_BR) e `--falsificar` com 14 sabotagens, controle verde na mesma invocação. Cada guarda falsifica sozinha. Inclui a dependente com o corpo da prod, a RLS sob `SET ROLE` e o envelope camada por camada. Está no núcleo do CI.
- Front: vitest dos 4 consumidores e do helper, com o payload da view antiga e o da nova. Mais 7 contratos `mutcheck` (`scripts/mutcheck.d/des-*.mut`, `performance-hub-posicao.mut`).

## Lições

- **Corrigir a fonte sem o consumidor pode piorar a tela.** Um `?? 0` no front transforma o NULL honesto da view em "R$ 0" e "Meta atingida". Antes de trocar número por NULL numa view, confira cada leitor.
- **`GREATEST(0, NULL)` é 0 no Postgres.** Tirar o `COALESCE` não basta: o gap precisa de `CASE` explícito.
- **Na falsificação, o esperado também erra.** Um assert de conjunto ("quais linhas mudaram") não fica vermelho com a sabotagem de uma coluna só se as outras colunas mantêm a linha no conjunto. A 1ª rodada reprovou 6 sabotagens por isso, com os asserts certos e as declarações erradas.

## Fora deste lote (follow-up)

- ✅ Resolvido no [lote 3c](des-simulador-sem-posicao-v6-lote3c.md). A RPC `simular_puxar_volume_trimestre` fazia `IF posição IS NULL THEN 0`, uma fabricação anterior a este lote. A tela não a chama mais sem posição, mas uma chamada direta continua desprotegida.
- ✅ Resolvido no [lote 3c](des-simulador-sem-posicao-v6-lote3c.md). O `PerformanceHub` fixava `empresa = 'OBEN'` nas leituras de posição e meta, apesar do seletor OBEN/COLACOR. Também é anterior a este lote.
- Aba aberta com build antigo + view nova mostra "R$ 0" e "Meta atingida" até o cliente atualizar (o SW só troca de build com o clique). Por isso a migration só vai depois do Publish **e** de uma janela de adoção.
