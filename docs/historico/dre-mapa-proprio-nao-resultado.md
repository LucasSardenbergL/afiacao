# DRE v1.13 — mapa próprio por empresa e a linha `nao_resultado` (2026-11-22)

Desenho: `docs/superpowers/specs/2026-11-22-dre-fluxo-caixa-mapa-proprio-design.md`. Prova: `db/test-fin-dre-nao-resultado.sh` (47 asserts, C e pt_BR). Script: `db/2026-11-22-fin-dre-mapa-proprio.sql`.

## O que estava errado (medido em prod, 12m 2025-11..2026-10, competência)

- Só a colacor tinha mapa próprio. oben (65,6% do CP explícito, só CMV via `_default`) e colacor_sc (0,2%) viviam de heurística — e a heurística está **morta**: `categoria_descricao` é NULL em 100% dos títulos de CP, então todo código sem mapa caía em `despesas_operacionais`.
- oben: R$ 612k de **pagamento de empréstimo** e R$ 154k de parcelamento como despesa operacional; R$ 348k de impostos sobre venda (ICMS, PIS, COFINS, DIFAL) fora das deduções; IRPJ/CSLL (R$ 59k) como despesa operacional; aumento de capital como receita bruta.
- colacor_sc: folha do grupo (R$ 382k) e empréstimo como despesa operacional genérica; INSS/IRRF retidos contados por cima do salário bruto.

## Decisões

- **`nao_resultado` ≠ `fora_dre`.** `fora_dre` = composição PENDENTE (parcela de empréstimo/parcelamento mistura principal e juros; venda de bem sem valor contábil) ⇒ resultado provisório. `nao_resultado` = patrimonial DEFINITIVO (aporte, distribuição, imobilizado, empréstimo tomado, adiantamento de cliente, retenção já no bruto) ⇒ sai de todo subtotal SEM provisório. Usar `fora_dre` para patrimonial deixava a DRE provisória para sempre por motivo falso (achado Codex no desenho).
- **Mapa só das contas COM USO** (232 pares), por (empresa, código) — código Omie NÃO é global (2.01.99, 1.04.04, CSLL). Grupo ambíguo, slot `<Disponível>` e conta nunca usada ficam sem decisão (Codex: cobrir o plano inteiro dá falsa confiança).
- **Duas classificações independentes** (Claude por regra+exceção; Fable às cegas, sem ver o mapa vigente): 26 divergências nas contas usadas, quase todas adm×operacional sem efeito no resultado.
- **Toda linha respeita a direção do dinheiro** — o motor soma sem sinal (`totais[linha] += val`). Inverter sinal por natureza quebraria PE/orçamento (Codex P0), então devolução de compra (CR) vai para `outras_receitas` (margem bruta ~0,4% subestimada na oben), e código de uso misto CR/CP fica sem decisão nova.
- **Descrição guardada na decisão** (`notas`) e conferida na postcondição: código renomeado/reaproveitado no Omie aborta o apply.
- Mantidos sem decisão, de propósito (ambíguos da fase 2, exigem conciliação): colacor 2.03.78, 2.06.93, 2.06.94.

## Pendências registradas (não fabricadas)

- **Regime por competência:** a colacor foi do Simples até 2022; o motor fixa Presumido para todos os anos (rótulo e imposto teórico errados em 2020–2022; o realizado com DAS em `das` já fica certo).
- **Linha redutora de CMV** (devolução de compra) e sinal por natureza com contrato versionado da composição.
- **Extrato sem título na DRE** (tarifa/juros: colacor_sc ~R$ 80k) — exige reconciliação por identidade para não dobrar.
- **Rateio da folha OBEN↔SC na DRE** (input humano, `fin_custo_rateio`).
- `fin-suggest-mapping` sugere por código puro (1.02.99 = "Estorno" na colacor, "Entrada de Aplicação" na oben) — exigir descrição igual.
- `fin-valor-engine`: carga do Simples ignora ICMS fora do DAS. DRETab/CSV não mostram `outras_receitas`/`outras_despesas`.
- colacor_sc 1.04.04 "Empréstimos/Financiamentos" (R$ 259k em 24m) pode ser mútuo intercompany — se confirmado, cruzar com `fin_ic_matches`.

## Ordem de deploy

migration `20261122140000` → edges `omie-financeiro` v1.13 **e** `fin-suggest-mapping` v1.2 atestadas → `db:aplicar` do script (precondição confere as duas) → recálculo: competência de todos os anos em ordem cronológica, **depois** os dois regimes de novo (o imposto teórico lê o trimestre já persistido — Codex) → Publish.
