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

## Deploy (2026-11-22, pela sessão)

- **Migration** `20261122140000` aplicada pelo conector (envelope: idempotente + transacional + postcondição; pré-voo psql-ro 🟢; `wt:preflight` 🟢). 2ª testemunha psql-ro: CHECK com `nao_resultado`, `_default` recusa, 0 linha de prova.
- **Edges** `omie-financeiro` v1.13 e `fin-suggest-mapping` v1.2 pelo MCP (colagem do `pendencias:prompt`, 22/22 hashes contra `fa9c2647d`, "No files were edited."). Sonda `db/2026-11-22-sonda-dre-v1.13-2edges.sql` (recibo #1321): **DEPLOY CONFIRMADO** nas duas. O `lovable-sensor-edicao` saiu 1 por SINAL na resposta (`edit_id`/`commit_sha`), mas o único commit do bot (`b72833eee`) só regenerou `types.ts` (colunas de NCG de outra entrega) — tolerado, nada a reverter.
- **Mapa** `db/2026-11-22-fin-dre-mapa-proprio.sql` (recibo #1323): psql-ro confere 232/232 pares, mapa 157 → 268 linhas, 121 notas com descrição.
- **Recálculo** em 3 passos (recibos #1324–#1327): competência de todos os anos com snapshot; competência de novo + caixa 2026 (o teórico lê o trimestre persistido); o caixa 2026 de colacor (57014) e oben (`WORKER_RESOURCE_LIMIT`) falhou FECHADO por carga com 13 requisições simultâneas e foi refeito um por vez — 200 nos dois. 139/139 snapshots regravados, todos com `detalhamento.nao_resultado`.
- **Publish SEGURADO:** `pendencias:deploy` sai 1 por `fin-cashflow-engine` v2.5 e `omie-sync` v1.16 (entregas de OUTRAS sessões, sem deploy) — publicar agora subiria o front delas sem o backend. O front desta entrega (rótulo no mapeamento, card do PE) só é cosmético sobre dados já corretos.

### Antes → depois (competência, 12m nov/25–out/26, R$ mil)

| Empresa | Resultado | Deduções | Despesa operacional | fora_dre | Provisório | Confiança alta |
|---|---|---|---|---|---|---|
| oben | 237 → **996** | 0 → 361 | 1.296 → 0 (adm 104, com 6, IRPJ/CSLL 59) | 0 → 766 | 0 → 12 meses | 1 → 0 |
| colacor_sc | −304 → **−277** | 0 → 2 | 463 → 0 (adm 434) | 0 → 26 | 0 → 2 meses | 0 → 10 |
| colacor | −141 → −141 | 238 → 238 | 54 → 54 | 382 → 372 | 12 → 12 | 0 → 0 |

⚠️ O salto da oben é o **principal + juros** de empréstimo (R$ 612k) e de parcelamento (R$ 154k) saindo da despesa: o lucro operacional agora está certo, mas os 12 meses ficam **provisórios** porque os juros dentro da parcela são despesa financeira que o Omie não separa. A captação registrada é quase nula (R$ 18,9k em 1.04.03) contra R$ 612k pagos — vale conciliar a dívida da oben (mútuo? antecipação não lançada?).
