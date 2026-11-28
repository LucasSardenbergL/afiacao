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

## Andamento das pendências técnicas (2026-11-28)

| # | Pendência | PR | Deploy | Evidência |
|---|---|---|---|---|
| 2 | Linha redutora de CMV + sinal por natureza + `composicao_cmv` versionada (`cmv-v1`) | #4302 | edge `omie-financeiro` **v1.17** · mapa `db/2026-11-27-fin-dre-cmv-redutora.sql` (recibo #1554) · recálculo `db/2026-11-28-dre-v1.17-recalculo-*.sql` · Publish | sonda `DEPLOY CONFIRMADO` (fonte `a18c0d00…`); 1.03.01 = `cmv` em colacor e oben; antes→depois abaixo |
| 3 | `fin-suggest-mapping` só sugere entre empresas com a mesma descrição | #4299 | edge **v1.3** | sonda `DEPLOY CONFIRMADO` (fonte `3bab9de0…`) |
| 4 | `fin-valor-engine`: carga do Simples = DAS + ICMS/ISS/IPI/PIS/COFINS pagos fora | #4298 | edge **v1.2** | sonda `DEPLOY CONFIRMADO` (fonte `a683b68b…`) |
| 5 | DRETab, CSV e comparativo mostram outras receitas/despesas e o resultado antes dos impostos | #4295 | Publish (só front) | Lovable publish `success` em `248ab2418` |
| 1 | Extrato sem título na DRE (Onda B) | — | — | **sessão nova** (com os itens 6, 7 e 8) — medição em `onda-b-extrato-medicao` da pasta de notas: sem mapa, a heurística manda EXTR para `receita_bruta` (ex.: oben 1.02.02 Rendimentos R$ 338k) ⇒ precisa de mapa + fail-closed |

Registradas, **sem decisão** (founder): rateio da folha OBEN↔SC · colacor_sc 1.04.04 mútuo × empréstimo · oben R$ 612k de amortização sem captação · principal × juros.

Codex fechado até 02/12 (exit 75) ⇒ os PRs #4298, #4299 e #4302 levam `sem-codex:` e revisão adversarial por subagente (Caminho B). **Revisão Codex independente segue pendente** nos três.

### Item 2 — antes → depois do recálculo (soma anual, R$)

Anos fechados: o CMV cai e as outras receitas caem o mesmo valor (= `composicao_cmv.devolucoes_compra`), o lucro bruto e o resultado operacional sobem esse valor, e o **resultado antes dos impostos não muda**.

| empresa · regime · ano | Δ CMV | Δ outras receitas | Δ lucro bruto = Δ res. operacional | Δ res. antes dos impostos |
|---|---:|---:|---:|---:|
| colacor · competência · 2023 | −101.619,34 | −101.619,34 | +101.619,34 | 0,00 |
| colacor · competência · 2024 | −59.058,35 | −59.058,35 | +59.058,35 | 0,00 |
| colacor · competência · 2025 | −4.296,00 | −4.296,00 | +4.296,00 | 0,00 |
| colacor · competência · 2026 | −533,51 | −533,51 | +1.375,01 | +841,50 ¹ |
| colacor · caixa · 2026 | 0,00 | 0,00 | +1.397,83 | +1.397,83 ¹ |
| oben · competência · 2024 | −2.729,16 | −2.729,16 | +2.729,16 | 0,00 |
| oben · competência · 2025 | −7.861,70 | −7.861,70 | +7.861,70 | 0,00 |
| oben · competência · 2026 | −9.951,82 | −9.951,82 | +10.150,72 | +198,90 ¹ |
| oben · caixa · 2026 | −548,83 | −548,83 | +31.326,64 | +30.777,81 ¹ |

¹ Em 2026 o "antes" era o snapshot do cron de 27/11 15:30; até o recálculo o sync atualizou 1.040 CR e 2.274 CP de 2026 nas duas empresas. A diferença além do mapa é **dado novo**, não efeito da v1.17 — a prova do efeito está nos anos fechados. Caixa só tem snapshot em 2026 (série não estendida). colacor_sc não foi recalculada (mapa inalterado; o sinal não muda número publicado — medido no #4302).

### Achado para a DFC (vindo da sessão-mãe)

BAXP caiu de 195 (jun/26) para 96 (out) e 1 (nov), e TRAP está ~0 desde jul: a DFC recente **subestima as saídas**. Não é efeito desta leva — registrar e medir antes de usar a DFC de jul/26 em diante.
