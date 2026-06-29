# Auto-aprovação segmentada (Sayerlack) — Fase 1: o Ensaio

> **Data:** 2026-06-29 · **Status:** ⛔ **CONCLUÍDO — ENSAIO RODOU E REPROVOU.** A análise retroativa (90d) mostrou que **nenhum sinal** (composição por preço, por urgência, tamanho total, recência) separa o que o founder aprova do que descarta — o split não tem como classificar. Investigação seguinte: o superdimensionamento é **sistêmico** (17% de aprovação global em OBEN, todos os fornecedores) e a compra é **decisão humana contextual**. **Veredito: a auto-aprovação de compra é inviável; Sayerlack/compras fica humano; a automação vai para um processo de decisão regular.** Fechamento completo em `docs/agent/reposicao.md` (entrada 2026-06-29). · **Origem:** painel tri-modelo (Claude + Codex; Gemini indisponível por 503) sobre como destravar a auto-aprovação N3 Sayerlack, dormente. Decisão do founder: **split núcleo/cauda**, começando pelo **ensaio** (medir sem comprar). A fase 2 de recalibrar a fórmula (lote+buffer Y) foi reprovada — ver `docs/agent/reposicao.md` + `2026-06-27-reposicao-fase2-cobertura-proporcional-design.md` (§ Status).

## 1. Contexto e objetivo

O piloto de auto-aprovação está **dormente** (0 aprovações): o motor de reposição sugere **2–3× a mediana** que o founder de fato compra, e o gate (delta assimétrico, veta acima de mediana×1,30 das compras reais do grupo) **recusa corretamente**. A fonte do superdimensionamento é o **estoque de segurança dos itens intermitentes caros** (classe Y/Z de alto valor) — proteção estatística legítima de uma demanda errática que o founder conscientemente opta por **não bancar** (preferência: capital > proteger venda cara rara). Não é bug.

A direção escolhida: em vez de aprovar/recusar o pedido **inteiro**, **separar cada pedido em duas cestas** — **núcleo** (rotina previsível, candidata a auto-aprovação) e **cauda** (itens caros/erráticos, julgamento de capital do founder).

**Objetivo desta fase (o ensaio):** provar, **sem comprar nada e sem tocar produção**, que essa separação classifica bem — que a "cesta-núcleo" se parece com o que o founder de fato aprova, e a "cesta-cauda" concentra o que ele descarta. É o **gate empírico** que decide se vale construir a auto-aprovação real (Fase 2).

## 2. O gabarito (ground truth medido em prod, 90 dias)

O comportamento real do founder já está nos dados — não precisamos esperar para ter o primeiro sinal:

| Decisão real | nº pedidos | valor médio | interpretação |
|---|---|---|---|
| **disparado** (comprou) | 39 | R$ 4.824 | **aprovável** |
| expirado_sem_aprovacao | 83 | R$ 8.390 | descartado |
| cancelado_humano | 38 | R$ 8.005 | descartado |
| cancelado | 12 | R$ 8.835 | descartado |

O founder decide no **pedido inteiro** (aprova os menores ~R$4,8k, descarta os maiores ~R$8k) e **quase não edita item-a-item** (só 50 itens com `ajustado_humano` em 90 dias). 

**Hipótese central do split (o que o ensaio testa):** o founder descarta os pedidos grandes **por causa da cauda cara**; se a cesta-núcleo fosse separada, ela se pareceria com os pedidos que ele aprovou. Se verdadeira, o split destrava a auto-aprovação. Se falsa (o núcleo dos descartados também é grande/anômalo), o split não resolve e **não seguimos**.

## 3. Componentes do ensaio (tudo read-only, nenhuma migration)

A Fase 1 é uma **análise** rodada via `psql-ro` sobre o histórico. Nenhum objeto novo em produção, nenhuma escrita, nenhum deploy.

### 3.1 Classificador de linha (núcleo vs cauda)
Regra por item, expressa em SQL na própria query de análise (na Fase 2 vira função). Um item é **CAUDA** se QUALQUER:
- **Dominância:** `valor_linha` > `LIMIAR_DOMINANTE` (proposto R$ 1.500) **ou** > `PCT_DOMINANTE` do valor do pedido (proposto 30%).
- **Intermitente caro:** `classe_xyz_proposta ∈ {Y,Z}` **e** `valor_linha` > `LIMIAR_INTERMITENTE` (proposto R$ 500).
- **Dado degradado:** `fonte_lt` é fallback estatístico, **ou** preço da linha stale/ausente (`preco_unitario` NULL — ver fix `20260629140000`).
Senão é **NÚCLEO**. Os três limiares são **parâmetros varridos** na análise (§4), não chutes fixos.

### 3.2 Split simulado
Para cada pedido histórico: `núcleo` = soma dos itens núcleo; `cauda` = soma dos itens cauda. Sem criar pedidos (`split_parent_id` é da Fase 2).

### 3.3 Faixa viável (a régua × o delta)
O núcleo só seria auto-aprovável se cair na janela `[RÉGUA, mediana_do_grupo × 1,30]` (régua = mínimo faturável, hoje R$ 3.000). **Insight do Codex:** no grupo normal a mediana é baixa (~R$1.695) → `mediana×1,30 = R$2.204 < R$3.000` ⇒ **janela vazia**. O ensaio **quantifica** quantos núcleos caem nesse buraco (não resolve aqui; a reconciliação — completar o mínimo só com baixo risco, ou revisar a régua por grupo — é decisão da Fase 2).

## 4. As métricas (o veredito do ensaio)

A análise produz, varrendo os limiares de §3.1:

1. **Recall (captura o aprovável):** dos **39 disparados**, qual % teria um núcleo **dentro da faixa viável** (seria auto-aprovado)? Alto recall = o split não perde as compras boas.
2. **Encolhimento:** núcleo médio ÷ pedido cheio. Quanto da cauda foi escalado ao humano. Esperado: encolher o suficiente para entrar na faixa.
3. **Veto simulado (não compra errado):** dos **133 descartados**, quantos teriam o núcleo auto-aprovado — **e** esse núcleo se parece (tamanho/composição) com os disparados (provável aprovação) ou continua grande/anômalo (provável veto)? Baixo veto estimado = o split não compra o que o founder rejeitaria.
4. **Buraco da régua:** % de núcleos abaixo da régua R$3k, por grupo (normal vs rápido).
5. **Concentração da cauda:** confirma que a cauda escalada é dominada por Y/Z caros (valida a hipótese).

## 5. Critério de sucesso (o gate para a Fase 2)

Seguimos para a auto-aprovação real **somente se**, em algum conjunto sensato de limiares:
- **Recall alto** (proposto ≥ 60% dos disparados teriam núcleo auto-aprovável), **e**
- **Veto simulado baixo** (o núcleo dos descartados é majoritariamente parecido com os aprovados, **não** uma cópia do pedido inflado), **e**
- o **buraco da régua** é contornável (ou pequeno, ou resolvível por reconciliação na Fase 2).

Se o ensaio **falhar** (o split não encolhe o suficiente, ou o núcleo dos descartados continua grande ⇒ o founder os vetaria igual), **não construímos a auto-aprovação** — o problema não é a segmentação e voltamos ao painel. Esse "não" é o valor do ensaio.

## 6. Validação

- A análise é **read-only** (`psql-ro` / query sobre 90d) — risco zero, nada toca prod.
- **Codex challenge** dos critérios do classificador e da metodologia do gabarito **antes** de fechar o veredito (a análise é money-path-adjacente: a decisão dela autoriza ou barra a Fase 2). Foco: viés do gabarito (descartado ≠ "vetaria o núcleo"), limiares cherry-picked, faixa viável.
- Sem PG17 nesta fase (não há função nova em prod); o PG17 com falsificação entra na **Fase 2**, quando o classificador/split/gate viram código aplicável.

## 7. Faseação

- **Fase 1 (esta spec):** classificador + split simulado + análise retroativa sobre 90d → **relatório com o veredito**. Zero escrita em prod.
- **Fase 1b (opcional, se o retroativo for promissor mas limítrofe):** shadow ao vivo 2–3 semanas — grava o que o split faria nos novos pedidos, confirma o retroativo com decisões frescas do founder.
- **Fase 2 (só se a Fase 1 passar):** o classificador vira função SQL; o split real via `split_parent_id`; o gate `reposicao_pedido_auto_aprovavel` ganha o filho-núcleo; reconciliação da régua. PG17 + Codex + fusível, como todo money-path da casa.

## 8. Não-objetivos

- **Não** toca o motor de cálculo (`gerar_pedidos_sugeridos_ciclo`) — a fase 2 de recalibrar a fórmula já foi reprovada.
- **Não** liga auto-aprovação nesta fase (só mede).
- **Não** muda o gate atual `reposicao_pedido_auto_aprovavel`.
- **Não** abrange outros fornecedores/empresas — Sayerlack/OBEN, onde o piloto vive.

## 9. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| **Viés do gabarito** — "descartado" pode ter outro motivo além da cauda (preço, timing) | A análise é uma **hipótese forte**, não prova; a Fase 1b (shadow ao vivo) confirma com decisão fresca antes de ligar; Codex challenge do viés. |
| **Limiares cherry-picked** — achar um conjunto que "fecha" por acaso | Varrer uma grade de limiares e reportar a **sensibilidade**; o critério §5 exige robustez, não um ponto único. |
| **Buraco da régua** inviabiliza o grupo normal | Quantificado no ensaio; a reconciliação é decisão explícita da Fase 2 (não escondida). |
| Classe XYZ ausente/errada num SKU | A análise reporta cobertura da classe; SKU sem classe cai em cauda (conservador: humano decide). |
