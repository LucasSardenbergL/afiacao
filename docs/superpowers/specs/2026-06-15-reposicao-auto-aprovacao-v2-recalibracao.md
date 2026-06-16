# Reposição N3 — auto-aprovação Sayerlack v2 (recalibração pós-piloto)

> **Data:** 2026-06-15 · **Status:** spec em design (decisões do founder fechadas; implementação pendente de Codex+PG17) · **Origem:** o check-in seg/qui do piloto (2026-06-15, 1º da série) flagrou que a v1 ficou **inerte** — 0 auto-aprovações em 4 dias com o fusível ligado. Continuação de `2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md`.

## 1. O que o check-in encontrou (diagnóstico via psql-ro)

A v1 ([PR #730](https://github.com/LucasSardenbergL/afiacao/pull/730)) entrou no ar 2026-06-11 com o fusível ligado. Em 4 dias: **zero** linhas em `reposicao_auto_aprovacao_log`. Não por falta de candidato — houve pedido Sayerlack OBEN ≥R$3k todo dia (12,13,14,15/06); todos **expiraram sem aprovação** (nem humana nem automática). Três barreiras, cada uma suficiente sozinha:

| Barreira (guard-rail v1) | Por que dispara sistematicamente |
|---|---|
| **Delta simétrico ≤30% vs último disparo** | A referência (último disparo) é ruidosa: `sayerlack_normal` teve R$1.031 (06-09) e R$7.377 (06-04); `sayerlack_rapido` teve R$16.852 (06-10, inchado). Qualquer pedido normal-tamanho fica >30% diferente. |
| **Janela 00:00–12:15 UTC** | Os pedidos só cruzam R$3k às **20:15 UTC (17h BRT)** — o estoque baixa ao longo do dia. Nunca estão ≥R$3k na janela da madrugada. |
| **Promoção: `modo_promocao IS NOT NULL` veta** | O grupo `rápido` quase sempre tem 1 item `flat`. Mas `flat` = só desconto de preço (qtde inalterada) — benigno. |

**Por que isso é grave:** sem o check-in, a v1 rodaria 3 semanas com "veto 0%" e eu concluiria "promove pra fase 2" — promovendo algo que **nunca agiu**. Falso positivo perfeito. É exatamente o modo de falha que o Codex previu no consult de 2026-06-14 ("dados saudáveis, regra de negócio sistematicamente ruim") e o motivo do check-in seg+qui. Piloto **pausado** em prod (`reposicao_auto_aprovacao_ativa='false'`, 2026-06-15) enquanto recalibra.

## 2. Decisões do founder (2026-06-15, via AskUserQuestion)

| # | Eixo | Decisão |
|---|------|---------|
| 1 | **Delta** | **Assimétrico + mediana.** Referência = mediana dos últimos N eventos de compra reais do grupo (não o último solto). Libera quando compra ≤ referência (comprar MENOS é conservador, seguro); trava só quando compra > referência×(1+delta_max). Alinha o guard com a direção do risco money-path (comprar DEMAIS = capital/sobrestoque). |
| 2 | **Janela** | **Dia todo, dispara no próximo corte.** Auto-aprova assim que cruzar R$3k a qualquer hora; a compra dispara no corte das 10h BRT (13 UTC) seguinte. Janela de veto = tempo até esse corte. |
| 3 | **Promoção** | **Vetar só `forward_buying`** (infla qtde = aposta de estoque, decisão humana). **Liberar `flat`** (só desconto de preço, qtde inalterada — benigno). É o ajuste exato do fold P1.3 do Codex, que foi grosso demais. |

## 3. Desenho

### 3.1 Elegibilidade v2 (`reposicao_pedido_auto_aprovavel`)

Recria a função da v1 mudando **dois** dos critérios; todos os outros 9 guard-rails seguem **verbatim** (OBEN-only, pendente, ciclo normal, sem split, num_skus>0, soma dos itens ≥régua, itens sãos NaN/Inf, sem ajuste humano, cooldown disparo/portal, máx 1 auto-aprovado não-disparado por grupo).

**(a) Delta assimétrico + mediana (substitui o §4.2.7 da v1):**
- **Referência** = `percentile_cont(0.5) WITHIN GROUP (ORDER BY ev.valor)` sobre os últimos **N=5** eventos de compra do grupo, onde cada *evento* = `SUM(valor_total)` por `data_ciclo` (disparados/concluídos, <90d, colapsa o pré-split — mantém a lógica de agregação por data_ciclo da v1, agora como sub-evento da mediana). Mínimo 2 eventos; <2 → inelegível ("sem base de referência").
- **Check assimétrico:** `IF v_valor > v_ref * (1 + p_delta_max) THEN inelegível`. **Comprar ≤ referência sempre passa** (não há piso). Só trava comprar muito MAIS que o típico.
- **Validação contra os dados reais (2026-06-15):**
  - `rápido`: candidato R$7.452 vs mediana ~típica → comprou ≤ típico → **APROVA** (frequente, tamanho normal — o comportamento desejado).
  - `normal`: candidato R$8.835 vs mediana ~R$1.800 (de [1031,7377,1252,1809,1793]) → R$8.835 > R$1.800×1,30 → **BARRA** (5× o típico = anomalia genuína p/ olho humano).

**(b) Promoção (substitui o P1.3 da v1):** o EXISTS de veto muda de `i.modo_promocao IS NOT NULL` para `i.modo_promocao = 'forward_buying'`. Itens `flat` deixam de vetar.

### 3.2 Tick (`reposicao_alerta_pedido_minimo_tick`)

Remove a checagem de janela de horário: o bloco `[AUTO 1/4]` que computa `v_dentro_janela` (linhas com `v_min_corte`, `v_corte`, `v_dentro_janela`) sai, e o gate `IF v_auto_on AND NOT v_suspenso AND v_dentro_janela AND r.qtd_pendentes = 1` perde o `v_dentro_janela`. **Consequência de config:** `reposicao_auto_aprovacao_corte_utc` deixa de ser lido pelo tick (vira config morta — manter pra não quebrar a v1 ou remover do parsing; decidir no plano). Tudo o mais do tick (advisory lock, fusível, auto-suspensão, claim condicional, log, os dois ramos de e-mail) segue **verbatim da v1**.

### 3.3 Disparo cross-day (PROBLEMA ABERTO — decidir com Codex no plano)

Com a janela dia-todo, o pedido auto-aprovado às 20 UTC tem `data_ciclo=hoje`, mas o cron de disparo (`disparar-pedidos-aprovados-oben`, `0 13 * * *`) usa `dataCiclo = new Date()...` (hoje UTC) com `.eq("data_ciclo", dataCiclo)` ([edge:1363]/[edge:1298]). Amanhã às 13 UTC ele procura `data_ciclo=amanhã` → o pedido de hoje **nunca dispara (órfão)**. Duas soluções candidatas:

- **Opção A — edge pega backlog:** mudar a query do lote de `.eq("data_ciclo", hoje)` para `data_ciclo <= hoje` **com guard de idade** (ex.: `>= hoje-2`) e **escopo limitado a auto-aprovados** (`aprovado_por LIKE 'auto:%'`) pra não alterar o comportamento dos pedidos humanos. **Custo:** deploy de edge manual (money-path).
- **Opção B — cron-gêmeo só-migration:** um cron adicional que chama o edge EXISTENTE com `body.data_ciclo = ontem` (o edge já aceita `body.data_ciclo`, linha 1306). Dispara os auto-aprovados de ontem no corte da manhã. **Custo:** `net.http_post` (armadilha do timeout 5s — exige `timeout_milliseconds` explícito + verdade em `net._http_response`); dispara também humanos órfãos de ontem (aceitável/desejável).

Recomendação preliminar: **B** evita tocar o edge money-path, mas herda a fragilidade do `net.http_post`; **A** é mais limpo mas é deploy de edge. **Decisão no plano, com o Codex** — é o ponto de maior risco da v2.

### 3.4 Trade-off do veto variável (aceito pelo founder na opção "a")

Sem a janela, a janela de veto = tempo entre a auto-aprovação e o próximo corte. Pedido aprovado às 20 UTC → ~17h de veto (ótimo). Pedido aprovado pouco antes do corte → veto curto. O founder escolheu "dispara no próximo corte" (sobre "veto mínimo garantido") ciente disso; na prática os pedidos cruzam R$3k à tarde, então o veto real é longo. O plano pode opcionalmente empurrar pro corte seguinte se faltar <45min (proteção barata) — decidir no plano.

## 4. Não-objetivos

- Mudar a régua R$3k (segue = mínimo de faturamento Sayerlack).
- Fase 2 (janela ~2h) — só depois de a v2 provar veto <10%.
- Tocar a RPC de geração, o pré-split, o claim do portal, o classificador morto do Cockpit.
- Outros fornecedores.

## 5. Validação

- **PG17** (`db/test-auto-aprovacao-piloto.sh` estendido OU `-v2`): os 24 cenários da v1 que seguem válidos + novos: **comprar MENOS que a referência APROVA**; comprar >ref×1.30 BARRA; mediana robusta (último-pedido-outlier não engana); `flat` APROVA; `forward_buying` BARRA; sem-janela aprova fora da madrugada; cross-day dispara (conforme a opção escolhida). Falsificação obrigatória.
- **Codex challenge** adversarial ANTES do apply (money-path; `xhigh`). Foco: a opção de disparo cross-day (A vs B), a mediana com poucos eventos, o assimétrico não abrir buraco (comprar-menos infinito é OK? sim, mas conferir interação com a régua mínima), e o blast radius do edge/cron.

## 6. Rollout

1. **PR único:** migration `v2` (recria função de elegibilidade + tick sem janela) + [edge OU cron, conforme §3.3] + teste PG17 + esta spec.
2. **Codex challenge** → incorporar P1.
3. **Apply manual:** BLOCO A (migration) + [deploy de edge OU o cron já está na migration] + validação prosrc (mediana/assimétrico/forward_buying presentes).
4. **Religar o fusível:** `UPDATE company_config SET value='true' WHERE key='reposicao_auto_aprovacao_ativa'` — o piloto recomeça, agora calibrado.
5. **Check-in seg/qui** (a scheduled task `revisar-piloto-auto-aprovacao-sayerlack` segue valendo) — desta vez esperamos VER auto-aprovações e medir veto de verdade.

## 7. Lição (pro CLAUDE.md, ao concluir)

Guard-rails money-path adicionados por um adversário (Codex) são individualmente corretos mas podem ser **coletivamente estéreis** contra os dados reais. O delta simétrico vs último-pedido pune a transição de regime (inchado→frequente) que o próprio piloto quer implementar; a direção do risco (comprar demais) pede guard **assimétrico**. Só um piloto com check-in de agregado pega isso — visibilidade por-evento (e-mail por aprovação) não revela "nunca aprovou nada".
