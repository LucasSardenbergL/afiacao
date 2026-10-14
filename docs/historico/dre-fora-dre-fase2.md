# DRE fase 2 — `fora_dre` com composição pendente + impostos em linha própria — 2026-10-13

> Migration `20261013230000_fin_dre_fora_dre_fase2.sql` (gêmeo `db/2026-10-13-fin-dre-fora-dre-fase2.sql`) ·
> mapa `db/2026-10-13-fin-dre-mapa-colacor-fase2.sql` · edge `omie-financeiro` v1.5 · prova
> `db/test-fin-dre-fora-dre.sh` (56 asserts, 8 sabotagens) · lição curta em `docs/agent/financeiro.md`.

## A pergunta

O DRE caixa colacor 2026 (10 meses) mostrava resultado de **−R$ 221.770,83** sobre receita de
R$ 567.670,77. Medido em prod (psql-ro): R$ 260.988,78 desse "prejuízo" eram saídas que **não são
despesa do período** — pagamento de empréstimos 2.05.03 (191.421,87), compra de imobilizado 2.01.99
(51.210,64), parcelamento federal 2.06.90 (18.356,27) — caindo em `despesas_operacionais` por
fallback (código sem descrição não casa keyword). ICMS/PIS/COFINS (≈ R$ 51k) idem.

## O desenho (Claude + Codex consult)

- **Excluir limpo fabricaria lucro**: a parcela mistura principal (financiamento) e juros/Selic
  (despesa financeira do período) que o Omie não separa. Por isso `fora_dre` sai de todo subtotal
  **com composição pendente** ⇒ `resultado_provisorio=true`, confiança baixa, selo em toda superfície.
- Colunas dedicadas `fora_dre`/`resultado_provisorio` (1 writer, NULL = pré-fase 2, sem default —
  ausente ≠ zero) + JSONB de rastreio (`composicao_despesas`, `fora_dre`, `mapeamentos_invalidos`, `contrato`).
- O Codex achou no consult, antes de codar: herança por prefixo levaria filho novo de 2.07 para fora
  do DRE; IRPJ/CSLL mapeado no Simples sumiria do resultado; pendência por soma líquida falha com
  estorno; o PE contava juros como fixo (a premissa "juros não afetam o PE" era falsa); o consolidado
  do regime tributário apresentava subtotal como total.

## Falsificação que mordeu

- Mutcheck do PE: 3 mutações sobreviveram na 1ª rodada (chave a mais na composição, gate 0 coberto
  só por redundância do gate 2, `null` vs `undefined` do hook). Viraram 3 casos novos; 8/8.
- PG17: a postcondição da migration aceitava `CHECK (true)` com o nome certo. Passou a provar o CHECK
  por COMPORTAMENTO (INSERT proibido num sub-bloco que exige `check_violation`).

## Deploy (2026-10-14)

Migration recibo #438 (validação por fora `t|t|2|0`, gatilho ativo) → 4 edges numa mensagem do
conector (15/15 hashes, Active, sensor `SEM_EDICAO`) → sonda `omie-financeiro` **DEPLOY CONFIRMADO**
(`v1.5-dre-fora-dre-composicao`, fonte = hash do script) recibo #439 → mapa colacor recibo #441
(24 pares) → recálculo caixa #442 e competência #443 (jan–out, 2 levas cada).
Decisões do founder: 2.03.78/2.08.01/2.05.99/2.06.06/2.06.94/2.06.95 sem mapa; 2.03.76 fora_dre;
fechamento com resultado provisório **só avisa** (aviso na tela de fechamento: pendente).

## Antes × depois (colacor 2026, psql-ro)

| caixa jan–out | antes | depois |
|---|---|---|
| receita bruta | 567.670,77 | 567.670,77 (igual) |
| deduções | 0,00 | 54.853,49 |
| Σ 5 linhas (CMV+op+adm+com+fin) | 789.441,60 | 473.599,33 |
| fora do DRE | — | 260.988,78 (coluna = JSON) |
| resultado líquido | −221.770,83 | **+39.217,95 provisório** |
| meses provisórios | — | 8 de 10 (set/out sem fora_dre) |

Bateu centavo a centavo com o previsto no contrato. Competência: antes 5 meses (receita 331.662,01,
resultado −245.468,64); depois jan–out, receita 598.252,12, deduções 211.909,38, fora do DRE
273.380,83, IRPJ+CSLL 13.255,61, resultado −129.529,18 provisório (10/10). Nenhum mapa inválido.
