# Cockpit de Valor (Oben) — proveniência do custo do EVP (v2 do #953): `custo_proxy` como eixo de incerteza

> Spec/design. Money-path (EVP → recomendação comercial). Codex P2 `cost-final-ignorado`.
> 2ª opinião: Codex (consult adversário 2026-06-18 + challenge no diff da reconciliação).

## Reviravolta (por que isto é uma v2, não a correção principal)

Enquanto este PR (#959) estava em voo, **sessões paralelas mergearam o núcleo na `main`**:

- **#953** — `custo do EVP por cost_final (motor) com fallback cost_price`. Trocou `cost_price` (legado, sticky) por `cost_final` (vivo) com fallback. +R$72,6k de cm corrigida. **Resolveu o núcleo do P2.** Mas o próprio commit deixou explícito: *"cost_source/cost_confidence (degradar confiança por custo-proxy: 102 DEFAULT_PROXY + 63 FAMILY_MARGIN_PROXY) ficam p/ v2 (helper espelhado + UI)"*.
- **#958** — `cobertura bidirecional (ar_por_app + app_por_ar)`.
- **#961** — `EVP-teto marcado` (capital ausente ≠ R$0): introduziu `evp_parcial` (EVP é teto), `cm_incompleto` (grupo com custo ausente) e `evp_teto_receita_pct` (ponderado por receita). O "Crescer / proteger" passou a sair **com ressalva** (não suprime) quando incerto.

**Este PR é a v2 que o #953 prometeu** — e encaixa no padrão que o #961 estabeleceu.

## Problema que sobra após #953

O #953 usa `cost_final` como custo MESMO quando a proveniência é PROXY (FAMILY_MARGIN_PROXY/0.5, DEFAULT_PROXY/0.25 — custo **inventado**). Logo, ~165 SKUs do cockpit Oben entram na margem/EVP com custo-chute tratado como se fosse real: o "Crescer / proteger" pode sair limpo sobre margem fabricada, e a confiança não reflete isso.

## Evidência de produção (psql-ro, 2026-06-18/19; role claude_ro)

`product_costs` (universo): **1181 SKUs proxy** (905 FAMILY + 276 DEFAULT), todos com `cost_final>0`; 622 PRODUCT_COST; 1523 CMC (350 com `cost_final>0` + **1173** no fallback `cost_price`, todos CMC). Recorte cockpit/oben (do #953): 102 DEFAULT + 63 FAMILY = **~165 SKUs proxy**; **16,4% da receita** sob custo proxy; **87 de 433 clientes (20%)** com a maioria da receita sob custo não-real.

→ Duas opções de v2: **(i) proxy → null** (remove → regride a cobertura que o #953 estabeleceu, esconde a margem de 20% dos clientes) ou **(ii) proxy mantém custo + marca incerto**. Escolhida **(ii)** (decisão do founder + Codex): preserva cobertura, honra money-path (chute alimenta a margem mas não vira certeza).

## Decisão — `custo_proxy` como terceiro eixo de incerteza (irmão de `cm_incompleto`/`evp_teto`)

### 1. `resolverCustoCockpit(row) → { custo, real }` (helper puro, espelhado verbatim no edge)

```
REAL = {PRODUCT_COST, CMC}            (cost_source normalizado: trim + upper)
custo = finitePositive(cost_final) ? cost_final
      : finitePositive(cost_price)  ? cost_price   (fallback legado — paridade #953, preserva cobertura)
      : null                                        (ausente ≠ R$0)
real  = cost_source ∈ REAL                          (proxy/UNKNOWN/sem-source → false, fail-closed)
```

O custo entra na margem **independente da proveniência** (sem regressão vs #953); `real` é a flag de qualidade. `finitePositive` rejeita ≤0/NaN/Infinity.

### 2. `custo_proxy` por célula → rollup → empresa

- Célula: `custo_proxy = cm != null && custo_real === false` (tem margem, mas o custo é chute). Omitir a flag ⇒ real (retrocompat).
- Rollup (cliente/SKU/empresa): `custo_proxy` booleano se QUALQUER célula é proxy — igual ao `cm_incompleto` do #961.
- `custo_proxy_receita_pct` = Σreceita(proxy) / Σreceita(com-cm), **ponderado por receita** (irmão do `evp_teto_receita_pct`). Célula sem custo fica fora do denominador (é `cm_incompleto`, eixo distinto).

### 3. Recomendação — "Crescer / proteger" só limpo se NÃO houver proxy

`recomendarAcaoComercial` ganha `custo_proxy?`. Integra à lógica de ressalva do #961: `evp>0` com proxy → "Crescer / proteger, **a confirmar**: custo estimado (proxy) em parte da carteira". **Não suprime** (preserva o sinal), **não afirma** (marca incerto). As demais regras seguem.

### 4. Confiança — rebaixa por custo proxy material

`scoreConfiancaCockpit` ganha `custo_proxy_receita_pct?`. `>0,15` da margem (por receita) sob proxy → rebaixa para **média**; `>0` → motivo de transparência (nunca verde mudo). Threshold alinhado ao `custo_ausente_pct`. Oben (~16%) → média, refletindo a realidade do cadastro de custo.

## Riscos residuais aceitos (registrados)

- **[CRÍTICO — dívida da FONTE] Proveniência lavada: proxy promovido a `PRODUCT_COST` (Codex P1).** O motor (`omie-analytics-sync` `computeCosts`) grava `cost_price` STICKY (`existing?.cost_price || costFinal`, index.ts:1067): um proxy grava seu valor em `cost_price` na 1ª run; na 2ª run esse valor passa o `sanityCheck` (index.ts:1021 — foi construído com margem plausível, então cai dentro da faixa) e é promovido a `PRODUCT_COST`/conf 0.95. Um custo inventado vira "real" → a flag `real` mente p/ esses SKUs → "Crescer" pode sair "sem alertas" sobre custo-proxy. **Pré-existente e fora do escopo:** afeta TODOS os consumidores de `cost_source` (#953, recommend, esta v2), NÃO é introduzido aqui, e a correção pertence à FONTE (money-path próprio). Esta v2 ainda melhora o consumidor (distingue os ~1181 SKUs HOJE rotulados proxy; fica robusta quando a fonte parar de lavar). → tarefa separada.
- **Fallback amplo (paridade #953):** PRODUCT_COST com `cost_final` inválido cairia em `cost_price`. Medição: 0 casos (PRODUCT_COST sempre tem `cost_final>0`); todos os 1173 do fallback são CMC. Mantido o fallback amplo do #953 (mínima divergência); `real` é pela source, então um PRODUCT_COST-via-fallback continuaria real.
- **P1 da v1 (margem% sobre receita-com-cm) NÃO reintroduzido:** o #961 usa `cm / receita_liquida`. Com proxy mantendo custo, a receita-sem-cm cai para ~5,4% (só sem-custo), e o `cm_incompleto` já a sinaliza. Débito menor, registrado.
- **Threshold de proxy (0,15) e de teto (0,05) divergem:** proxy tem um número (chute), teto não tem o encargo — escolha deliberada. Codex sinalizou; defensável.

## Fora de escopo (dívida colateral → tarefa separada)

- **[FONTE, do Codex P1] `omie-analytics-sync` promove proxy a `PRODUCT_COST`** via `cost_price` sticky + `sanityCheck`. Lava a proveniência de TODA a escada → mina `cost_source` para todos os consumidores. Correção na fonte (parar de reusar `cost_price`-proxy como custo de produto, ou marcar a origem sticky). Money-path próprio.
- `recommend/index.ts` e `algorithm-a-audit/index.ts` fazem `cost_final || 0` (ausência → margem cheia). Mesma régua, PR próprio.
- O #961 mergeou **sem cobertura de mutcheck** para `evp_parcial`/`cm_incompleto`/`evp_teto`, e seu `evp_teto_receita_pct` não tem clamp [0,1] (mesma classe do P2 que clampei aqui) — oportunidade de fortalecer (não-regressão minha).

## Prova & entrega

- **vitest** no helper puro: `resolverCustoCockpit` (todos os branches + falsificação ≤0/NaN/Inf + normalização de source); `custo_proxy` na célula/rollup/empresa + ponderação; ressalva no "Crescer"; rebaixamento da confiança.
- **mutcheck.d/valor-cockpit-helpers.mut**: 12 invariantes da v2 (proxy-vira-real, finitePositive, inversão real↔proxy, proxy-sem-margem, acumuladores numerador/denominador, gate, ressalva, threshold, `?? 0`-não-fabrica, clamp [0,1]). Cada mutação dá VERMELHO. Total **22/22 pegas** (com as pré-existentes).
- **Codex challenge** (adversarial money-path): **1 P1** = proveniência lavada na FONTE (registrado como risco crítico + tarefa, fora de escopo); **2 P2 CORRIGIDOS** = clamp [0,1] do `custo_proxy_receita_pct` (receita negativa de devolução) + normalização (`trim/upper`) do warn `sourcesDesconhecidas`, coerente com o resolver.
- Espelhar verbatim no edge. **Deploy MANUAL da edge no chat do Lovable após merge** (merge ≠ produção). Frontend não muda; o efeito propaga pelo payload (`custo_proxy_receita_pct` novo + confiança/recomendação ajustadas).
