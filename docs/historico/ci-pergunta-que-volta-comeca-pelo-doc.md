# CI: pergunta que volta começa pelo doc de decisão, não pela API (2026-11-24)

**Substrato:** resposta do suporte do GitHub sobre concorrência + API do Actions · **Sem mudança de CI, banco ou Publish.**

## O que aconteceu

O suporte do GitHub respondeu que a conta pessoal Pro fica em **40 jobs simultâneos** e que 60 só existem
numa organização no plano Team (transferência do repo). A sessão mediu a API do Actions (860 runs, 21–24/11)
e concluiu "não migrar". Depois propôs recortar o `provas-sql` no pós-merge, estimou ~7 mil runner-min de
economia **sem ler `scripts/provas-sql-escopo.ts`**, e o founder aprovou com esse número. Ao implementar, três
coisas apareceram, e todas já estavam escritas:

- O escopo do PR é **tudo-ou-nada** (pula as 16 partes só com diff 100% inerte), então os 7 mil não existiam.
- O pós-merge **não** usa a allowlist do PR de propósito: a main é a rede contra erro no mapa de leitura
  ([ci-e14-escopo-main-docs.md](ci-e14-escopo-main-docs.md)).
- A "versão segura" (pular quando a árvore da main é idêntica à que o PR provou) é a **alavanca A** de
  [ci-fila-actions-decisao-nao-mexer.md](ci-fila-actions-decisao-nao-mexer.md), já vetada como "caro e
  arriscado". O doc também já tinha a ocupação do regime de 40 (média ~12 slots, teto em 9,1% do tempo), a
  simulação de "+8 slots" e os critérios de reabertura.

Nada foi implementado. A resposta certa estava disponível antes da primeira chamada de API.

## Números desta rodada (para quem reabrir)

Os critérios de reabertura do doc de 11/11 **não** foram checados: a sessão mediu espera **por job** em 3 dias,
e o critério é a **maior espera por run de PR** em ≥7 dias.

- Espera por job: p50 3 s · p90 99 s · p99 343 s. Run de CI de PR: ~9,6 min de parede, ~39 jobs.
- Runner-min: CI de PR 88 min por run, pós-merge 119 min por merge (16 partes do `provas-sql` em 86 de 93).
- Árvore da main idêntica à provada verde pelo PR: 29 de 107 merges (~7% do CI total). O repo é **público**:
  runner-min não custa dinheiro, só a fila importa.
- ⚠️ A varredura deu **pico de 66 jobs simultâneos com teto de 40**. Isso invalida o instrumento até ser
  explicado. Hipótese não verificada: entraram jobs cancelados ou superados que nunca ocuparam runner. Para
  conferir, reconte só os jobs com `runner_name` não vazio e `conclusion != skipped`, de `started_at` a
  `completed_at`; o resultado deve ficar em ≤40, como ficou em 20 na medição de
  [ci-fila-de-runners.md](ci-fila-de-runners.md).

## A lição

1. **Pergunta de CI que volta** ("mais slots?", "cortar o pós-merge?") começa pelo doc de decisão e pelos
   **critérios de reabertura** dele (índice em `docs/historico/README.md`, busque `ci-`). Meça só a métrica
   pré-registrada, no recorte pré-registrado.
2. **Nenhuma estimativa de economia vai para o founder antes de ler o código que decide o escopo.** Um número
   aprovado vira mandato, e um número fabricado vira mandato errado.
3. **Medição que contradiz um limite físico** (66 > 40) é defeito do instrumento até prova em contrário.
   Não se conclui nada com ele, nem a conclusão que coincide com a certa.
4. **Dado bruto de medição sai do scratchpad** (ele é limpo no meio da sessão) quando ele vai fundamentar
   uma decisão.
