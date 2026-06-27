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
| O motor enche menos mas pede MAIS vezes | Custo de transação ~zero no Sayerlack (mínimo faturável R$3k frequente é o ótimo do dente de serra). Aceitável. |
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
