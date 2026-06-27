# Reposição fase 2 — cobertura proporcional ao giro (recalibração do motor)

> **Data:** 2026-06-27 · **Status:** design aprovado em brainstorming com o founder (decisões abaixo) · **Origem:** o piloto de auto-aprovação Sayerlack v2 ficou dormente (0 auto-aprovações em 12 dias) e o diagnóstico revelou que o **motor de reposição superdimensiona** — a "fase 2 do dente de serra" que estava registrada, agora com evidência concreta.

## 1. Contexto e motivação

O piloto N3 (auto-aprovação Sayerlack v2, `docs/agent/reposicao.md`) recusa todo pedido porque o motor sugere **2–5× o que o founder de fato compra**. A investigação em prod (psql-ro, 2026-06-27) provou a causa raiz: a `cobertura_alvo_dias` em `sku_parametros` está calibrada **alta demais vs o lead time real (~10 dias)**.

Cobertura em DIAS por classe ABC/XYZ (SKUs Sayerlack OBEN):

| classe | nº SKUs | gira a cada | motor enche até | estoque hoje |
|---|---|---|---|---|
| AX (giro alto) | 21 | ~10 d/un | 64 dias | 47 dias |
| AY | 23 | ~3 d/un | 40 dias | 31 dias |
| BX | 32 | ~14 d/un | 107 dias | 110 dias |
| CX | 30 | ~32 d/un | 154 dias | 117 dias |
| **CZ (giro lento)** | **144** | **~71 d/un** | **286 dias** | **128 dias** |

A maior classe de longe é a CZ — 144 SKUs que vendem ~1 a cada 71 dias (76 quase parados), e o motor quer manter **9 meses** de estoque deles. Decompondo um pedido normal: dos R$5.276 sugeridos, só R$393 (7%) é reposição de SKU **abaixo do ponto**; 93% é "encher até o `estoque_maximo`" de SKUs que já estão no ponto. O founder compra ~R$1.142 (seletivo, os SKUs A urgentes) e preserva capital — **ele está certo; o motor exagera.**

O piloto, ao travar, virou um detector de superdimensionamento. Esta fase corrige o motor; o piloto destrava de graça.

## 2. Decisões do founder (2026-06-27)

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Escopo | **Só Sayerlack/Oben primeiro** — onde o piloto vive; menor raio de dano; espalha depois de provar. |
| 2 | Abordagem | **Cobertura proporcional ao giro** — reduzir `cobertura_alvo_dias` de fixa-alta pra lead time + margem por classe. Classe C de giro lento para de ser reposta sozinha (efeito automático, sem regra especial). Via esteira `param_auto` (fusível/pin/revisão). |
| 3 | Validação | **Backtest de ruptura ANTES de aplicar** (decisão da casa: money-path não se aplica no escuro). |

## 3. Desenho

### 3.1 A alavanca: a fórmula de cobertura na view de sugestão

Os parâmetros (`cobertura_alvo_dias`, `ponto_pedido`, `estoque_maximo`, `estoque_seguranca`) são derivados pela view `v_sku_parametros_sugeridos` (usa classe ABC/XYZ, z-score por classe de `empresa_configuracao_custos`, lead time real `lt_*`). A esteira `param_auto` aplica os parâmetros sugeridos aos SKUs com fusível/pin/log/período de revisão.

**A mudança:** a `cobertura_alvo_dias` deixa de ser fixa-alta e passa a ser **lead time + margem de segurança proporcional à classe/giro**:
- Classe A (gira, não pode romper): mais buffer (ex.: lead + ~1 ciclo de revisão + z·σ).
- Classe C de giro lento: margem mínima (≈ lead time) — o estoque mínimo inteiro (1 unidade) já cobre muitos dias.

**Os coeficientes exatos NÃO são chutados aqui** — saem calibrados no backtest (§3.3). O design fixa a DIREÇÃO (proporcional ao lead, não fixa-alta) e o método de calibração (provar no histórico).

### 3.2 O efeito automático (por que não precisa de regra pra classe C)

Quando a cobertura cai pra perto do lead time, os SKUs de giro lento — que já têm ~128 dias de estoque — ficam **acima do novo `estoque_maximo`** → o motor simplesmente não os sugere mais (`skus_necessitando` não os pega). Viram **sob demanda naturalmente**, sem precisar de uma regra explícita de exclusão por classe (que mudaria a lógica da RPC). A classe A, que gira, continua reposta — porém enxuta.

### 3.3 Validação — backtest de ruptura (o coração, ANTES de qualquer escrita)

Antes de tocar um único parâmetro em prod, **simular a cobertura nova contra os últimos 90 dias de demanda real** de cada SKU Sayerlack/Oben. Para cada SKU, reproduzir o consumo diário (de `v_sku_demanda_estatisticas` / histórico de vendas) sobre os parâmetros novos e contar **dias-SKU em que o estoque iria a zero (ruptura)**.

**Critério de sucesso (relativo, não "zero ruptura"):** a ruptura simulada com os parâmetros NOVOS deve ser **≤ a ruptura do comportamento de compra ATUAL do founder** (o que ele de fato compra hoje já tolera algum nível de ruptura, e o negócio opera). Comparar três cenários no backtest:
1. Parâmetros ATUAIS do motor (baseline inflado).
2. Parâmetros NOVOS (cobertura proporcional).
3. Comportamento REAL do founder (o que ele comprou).

Se (2) ≤ (3) em ruptura **e** (2) « (1) em capital empatado → a recalibração mantém o serviço e libera caixa. Se (2) rompe mais que (3), os coeficientes estão apertados → recalibrar e re-simular. Ancorar em `simulacao_estoque_resultados` se a infra servir; senão, query de backtest dedicada.

### 3.3.1 RESULTADO do backtest (executado 2026-06-27, prod read-only) + DECISÃO

**Backtest analítico** (ponto atual vs teórico `mu·LT + z·σ·√LT`): o ponto de pedido está **4–14× acima** do teórico de nível de serviço (AX 44→11d, BX 63→11d, CX 71→10d, CZ 144→~10d). Toda a gordura é capital empatado sem ganho de serviço (o z-score do serviço já está no teórico).

**Backtest dia-a-dia** (Poisson, min-max, 1 ano em regime descartando transiente, 150 réplicas, 195 SKUs):

| cenário | serviço | capital (cobertura média) |
|---|---|---|
| ATUAL (motor) | 99,93% | 104 dias (baseline) |
| PURO (ponto teórico) | 99,63% | 66 d (**−36%**) |
| **bufY (PURO + z+0,8 nas classes Y)** | **99,75%** | **70 d (−33%)** |

**DECISÃO (founder delegou a Claude+Codex, 2026-06-27): bufY.** Trocar 3pp de capital (36→33%) por subir o serviço a 99,75% e cortar a ruptura das classes intermitentes (Y) de ~0,6% pra ~0,2% — onde a aproximação Poisson é mais fraca. O `z+0,8` é **calibração empírica por simulação** (não verdade teórica): "Y recebe nível de serviço efetivo maior porque o modelo base subestima a variância/rajada". A classe AZ não reduz capital (já calibrada — deixar). A classe CZ melhora nos dois eixos.

**Guardrails que o Codex challenge exigiu ANTES do apply (entram no plano como gates):**
- **Ruptura ponderada por FATURAMENTO/margem**, não só por unidade-SKU — a média por classe esconde um SKU **classe A de alto giro/margem** quebrando curto mas caro.
- **Top-10 SKUs por perda simulada** + **pior réplica por SKU A** + **dias CONSECUTIVOS em ruptura** (não só % de dias).
- **Stress test de rajada** com `v_sku_demanda_rajada` (demanda real tem autocorrelação; Poisson independente subestima a cauda).
- **Pin** dos SKUs A críticos na esteira `param_auto` (proteção individual).
- Croston/TSB/SBA p/ intermitente = experimento POSTERIOR, não bloqueio.

### 3.4 Rollout — gradual e reversível, via `param_auto`

Aplicar os parâmetros novos **só nos SKUs Sayerlack/Oben** pela esteira `param_auto` existente (fusível pra reverter na hora; `pin` pra travar SKUs sensíveis; `log` de auditoria; período de revisão pra não despejar tudo de uma vez). Monitorar ruptura real nas primeiras 2–3 semanas (cron de health + a query de ruptura).

### 3.5 Efeito no piloto de auto-aprovação (vem de graça)

Com as sugestões enxutas, os pedidos passam a ficar no tamanho que o founder de fato aprova. A mediana dos disparos do grupo (referência do delta assimétrico da v2) se realinha aos pedidos enxutos, e os novos pedidos ficam ≤ mediana×1,30 → **o piloto destrava sozinho**, sem tocar no piloto. (Validar no check-in seg/qui.)

## 4. Não-objetivos

- Outras empresas (Colacor, Colacor SC) e outros fornecedores — fase futura, mesma esteira após Sayerlack provar.
- Mudar a LÓGICA da RPC `gerar_pedidos_sugeridos_ciclo` (regra de exclusão por classe) — a recalibração de cobertura já produz o efeito sem isso.
- Tocar o piloto de auto-aprovação (ele está correto).
- Reescrever o motor de reposição.

## 5. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| **Ruptura** (cobertura apertada demais) | Backtest ANTES de aplicar (§3.3), critério ruptura-nova ≤ comportamento-atual; rollout gradual; fusível `param_auto` pra reverter; monitor de ruptura 2–3 semanas. |
| Recalibração errada num SKU específico | `pin` da esteira `param_auto` trava SKUs sensíveis; o backtest é por-SKU (pega outliers). |
| O motor enche menos mas pede MAIS vezes | Custo de transação ~zero no Sayerlack (mínimo faturável R$3k frequente é o ótimo do dente de serra). **Codex:** validar o custo OPERACIONAL (scraping/disparo do portal) — lote de ~1 LT pode ser pequeno demais p/ a operação mesmo se ótimo matematicamente. |
| **Lead time variável** (Codex) | A fórmula usa LT médio; se a Sayerlack atrasa ou entrega parcial, o risco real sobe. Usar `lt_p95_dias` (não só média) no estoque de segurança; monitorar LT real no rollout. |
| **Cauda escondida na média** (Codex) | Serviço médio 99,75% pode esconder poucos SKUs A caros quebrando → validação ponderada por faturamento + top-10 perdas + dias consecutivos (§3.3.1). |
| **Rajada/autocorrelação** (Codex) | Poisson independente subestima a cauda → stress test com `v_sku_demanda_rajada` antes do apply (§3.3.1). |
| Divergência repo↔banco da fórmula | A fórmula vive numa view (`CREATE OR REPLACE`); pré-flight `pg_get_viewdef` da prod antes de recriar (lição da casa). |

## 6. Validação / prova

- **Backtest de ruptura** (§3.3) — o gate de aplicação. Roda em prod read-only (psql-ro) + simulação local se precisar.
- **PG17** da fórmula nova da view (se a recalibração for via mudança de view/RPC): provar que os parâmetros calculados batem o esperado num conjunto semeado (classe A enxuta, classe C ~lead).
- **Codex challenge** adversarial antes do apply (money-path; foco: a fórmula não zera estoque de classe A; o backtest não tem viés de sobrevivência; interação com `param_auto`/cold-start).

## 7. Critério de sucesso

1. Pedidos Sayerlack sugeridos caem pra perto do que o founder historicamente compra (mediana ~R$1.142 normal / ~R$4.811 rápido, ±margem).
2. Backtest: ruptura com parâmetros novos ≤ ruptura do comportamento atual do founder.
3. Capital empatado em estoque Sayerlack cai (estoque_maximo de classe C deixa de inflar).
4. O piloto de auto-aprovação passa a registrar auto-aprovações (medido no check-in seg/qui).

## 8. Rollout (resumo)

1. PR: mudança da fórmula de cobertura (view/RPC) + a query/rotina de backtest + esta spec.
2. Backtest em prod (read-only) → calibrar coeficientes → provar (2)≤(3).
3. Codex challenge → incorporar P1.
4. Apply manual (SQL Editor) da fórmula; recompute dos parâmetros sugeridos; aplicação via `param_auto` só Sayerlack/Oben.
5. Monitorar ruptura 2–3 semanas; espalhar pros outros fornecedores/empresas se provar.
