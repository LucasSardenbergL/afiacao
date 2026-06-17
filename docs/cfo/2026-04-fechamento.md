# Fechamento gerencial — Grupo Colacor — Abril/2026

> Diagnóstico gerencial, READ-ONLY, gerado pela skill `cfo-colacor` (1ª execução real).
> **Não é apuração contábil/fiscal.** Números marcados com ⚠️ dependem de configuração
> (mapeamento de categorias, estoque valorado) ou são estimativa observada — confirmar com
> contador onde indicado. Dados extraídos do Supabase via SQL no Lovable em **2026-06-16**.
> Último sync Omie: ~2026-06-15 (título mais recente da Colacor).

## 0. Como ler este fechamento

A 1ª rodada revelou que **a camada gerencial do financeiro está parcialmente configurada**:
o caixa, a inadimplência e o capital de giro têm dado utilizável; o **resultado (DRE) e o
tributário NÃO são confiáveis** porque as categorias de imposto e várias despesas estão sem
mapeamento. A **ação nº1** que destrava o mês é mapear os impostos `2.06.*` em
`/financeiro/mapping` e recalcular o DRE. Tudo aqui é leitura — o mapeamento é ação do dono.

## 1. Resumo executivo

- **Caixa**: grupo sustentado pela **Oben** (gera ~**+R$ 104 mil/mês**); **Colacor** (~−R$ 65 mil/mês)
  e **Colacor SC** (~−R$ 32 mil/mês) queimam caixa e operam com o **Itaú estourado** (provável
  cheque especial). Risco de liquidez concentrado nas duas que queimam.
- **Resultado**: ⚠️ **não confiável neste fechamento** — DRE incompleto (impostos não mapeados =
  R$ 0 no relatório; receita da Colacor ≈ metade do caixa). Não reportar resultado do mês até
  remapear.
- **Atenção nº1**: **mapeamento de categorias** — ~R$ 69 mil (Oben) e ~R$ 27 mil (Colacor) de
  impostos pagos em abril estão **invisíveis no DRE**. Isso trava resultado e carga tributária.

## 2. Caixa

| Empresa | Saldo hoje (Itaú) | Tendência | Ponto baixo projetado | Bandeira |
|---|--:|--:|--:|:--:|
| Colacor | −R$ 395.718,97 | ~−R$ 65 mil/mês | ~−R$ 370 mil (alerta crítico) | 🔴 |
| Oben | +R$ 123.015,20 | ~+R$ 104 mil/mês | folga | 🟢 |
| Colacor SC | −R$ 152.377,35 | ~−R$ 32 mil/mês | aprofundando | 🔴 |

**Movimentação líquida 90 dias** (cross-check via `fin_movimentacoes`): Colacor −R$ 195.200,47 ·
Colacor SC −R$ 95.184,87 · Oben +R$ 311.873,09 — confirma a direção acima.

**Alertas ativos do engine** (Colacor): `caixa_negativo` **crítico** (~−370k) · inadimplência
**29,6%** · cobertura **0 dias** · concentração de recebíveis **1649%** (índice do engine).

> ⚠️ O cross-check SQL não desconta inadimplência nem inclui folha/eventos. O Itaú profundamente
> negativo das duas empresas sugere **uso de cheque especial / conta garantida** — os **juros**
> dessa linha precisam aparecer no DRE (hoje não aparecem). Confronte com `/financeiro/capital-giro`.

## 3. NCG / capital de giro

| Empresa | NCG | Leitura |
|---|--:|---|
| Colacor | ~−R$ 627 mil | NCG **negativa** — fornecedor financia o ciclo (validado vs alerta do engine −618k) |
| Oben | negativa ⚠️ | mesma leitura; valor isolado não recalculado nesta rodada |
| Colacor SC | negativa ⚠️ | idem |

- CR em aberto real da Colacor ≈ **R$ 129 mil** (status `A VENCER`/`ATRASADO`/`VENCE HOJE`).
- ⚠️ **Estoque = R$ 0** em `fin_estoque_valor` (não valorado) → ACO subestimado → NCG **menos
  negativa** do que parece. Valorar estoque é pré-requisito pra NCG fiel.

> ⚠️ **Armadilha-mãe confirmada em produção**: a coluna `saldo` **não zera na baixa** — usá-la
> inflava o CR aberto pra R$ 17,7 mi (real ≈ R$ 129 mil). O fechamento usa **`status_titulo`**,
> nunca `saldo`/`data_recebimento`.

## 4. Inadimplência (aging de recebíveis)

| Empresa | Total vencido | D+90+ (fóssil) | % vencido | Perfil |
|---|--:|--:|--:|---|
| Colacor | R$ 83.902 | **R$ 78.486 (94%)** | 29,6% | quase tudo **fóssil** (até ~12 anos, máx. 4.548 dias) |
| Oben | R$ 95.987 | ⚠️ a detalhar | — | perfil **mais novo** (recuperável) |
| Colacor SC | ⚠️ n/d | — | — | não destacado nesta rodada |

**Política de cobrança (definida pelo dono):**
- **D+1**: WhatsApp/e-mail automático (manter inadimplência o mais baixa possível desde o 1º dia).
- **D+7**: ligação.
- **Fósseis (Colacor, R$ 78 mil em D+90 antigo)**: **provisionar/avaliar baixa**, não gastar
  esforço de cobrança — são de até 12 anos atrás.

> ⚠️ `nome_cliente` vem vazio nos títulos — a lista de cobrança agrupa por `omie_codigo_cliente`;
> cruzar com o cadastro pra nome real antes de acionar.

## 5. DRE gerencial — ⚠️ NÃO CONFIÁVEL nesta rodada

| Linha | Colacor (competência) | Oben (caixa) | Colacor SC |
|---|--:|--:|--:|
| Receita bruta | R$ 68.194 ⚠️ | R$ 293.149 ⚠️ | n/d |
| Impostos | **R$ 0** ⚠️ (não mapeado) | **R$ 0** ⚠️ | **R$ 0** ⚠️ |
| Resultado líquido | −R$ 69.033 ⚠️ | n/d | n/d |

**Por que não confiar:**
1. **Impostos = R$ 0** porque as categorias de imposto não têm linha no DRE (ver bloco 6) — mas
   os impostos **foram pagos** (estão em contas a pagar).
2. Receita da Colacor no DRE (R$ 68 mil) ≈ **metade** do caixa do mês (~R$ 145 mil) → receita
   provavelmente **subestimada** (vendas à vista podem não estar entrando como receita).
3. Regimes diferentes por empresa (Colacor competência, Oben caixa) → **não somar "Grupo"**.

> **Grupo = não consolidável nesta rodada** (regimes mistos + DRE incompleto + sem eliminação
> intercompany).

## 6. Confiabilidade do DRE

| Empresa | Categorias sem mapeamento | Status |
|---|--:|---|
| Colacor | 22 | 🔴 baixa |
| Oben | 23 | 🔴 baixa |
| Colacor SC | ⚠️ a medir | 🔴 baixa |

> `fin_confiabilidade` está **vazia** (`fin_calcular_confiabilidade` nunca rodou) — a contagem
> acima vem da query direta de categorias sem mapeamento.

**Categorias a classificar em `/financeiro/mapping` — priorizadas (abril/2026):**

| Natureza | Códigos | → linha DRE | Valor abril | Prioridade |
|---|---|---|--:|:--:|
| **Impostos** | `2.06.*` (ICMS/IRPJ/CSLL/COFINS/PIS/DIFAL/DAS/parcelamento) | impostos / deduções | **Oben ~69k · Colacor ~27k · SC ~1,6k** | 🥇 destrava tudo |
| Folha/pessoal | `2.03.*` (salários/FGTS/INSS/benefícios) | desp. pessoal | SC salários R$ 23k | direto |
| Desp. operacionais | aluguel, manutenção, combustível, energia, contabilidade… | desp. operacionais/admin | — | direto |
| Devoluções | `2.09.01`, `2.01.98` | deduções de receita | Oben R$ 5,8k | direto |
| **Empréstimos** | `2.05.03` | — / desp. financeiras | **Oben R$ 81,6k · SC 20k · Colacor 20k** | ⚠️ contador |
| Compra material uso/consumo | `2.01.9x` | CMV ou despesa? | Colacor 3k · SC 7,7k · Oben 1,3k | ⚠️ contador |
| Categoria vazia | (sem código) | ? | Colacor **R$ 27.937** (5 títulos) | investigar |

**Decomposição dos impostos não mapeados (abril/2026):**

| Empresa | Composição | Total | Sem parcelamento (corrente) |
|---|---|--:|--:|
| **Oben** | IRPJ 14.260,65 · CSLL 11.227,16 · ICMS 10.800,23 · COFINS 9.335,60 · DIFAL 6.949,69 · PIS 2.414,00 · parcelamento 14.301,53 | **~R$ 69.289** | ~R$ 54.988 |
| **Colacor** | ICMS 12.925,26 · IRPJ 4.658,10 · CSLL 4.095,14 · COFINS 1.577,30 · PIS 1.206,71 · parcelamento 2.942,34 | **~R$ 27.405** | ~R$ 24.463 |
| **Colacor SC** | Simples DAS 100,56 · taxas diversas 1.512,91 | ~R$ 1.613 | ~R$ 1.613 |

## 7. Carga tributária observada ⚠️ (NÃO é apuração)

| Empresa | Regime | Impostos pagos abril | Receita base | Alíq. observada | Faixa esperada |
|---|---|--:|--:|--:|---|
| Colacor | Presumido | ~R$ 27.405 | ⚠️ R$ 68k (DRE) a R$ 145k (caixa) | ~19–40% ⚠️ | ~11–16% |
| Oben | Presumido | ~R$ 69.289 | R$ 293.149 (caixa) | ~23,6% ⚠️ | ~11–16% |
| Colacor SC | Simples | ~R$ 1.613 | ⚠️ n/d | — | faixa RBT12 |

> ⚠️ **Não tirar conclusão fiscal disto.** A alíquota observada está distorcida por: (a) receita
> base incerta (Colacor), (b) **parcelamento de impostos antigos** embutido (Oben R$ 14k, Colacor
> R$ 3k — é dívida passada, não imposto do mês), (c) ICMS-ST/DIFAL/monofásico que só o contador
> fecha. **Confirmar com contador.** A carga real só aparece depois do mapeamento + recálculo.

## 8. Intercompany

**N/A — não rastreado pelo sistema.**
- `fin_ic_matches` = 0 linhas (motor de matching nunca rodou).
- Nenhuma transferência `natureza='TRF'` em abril/2026.
- Se há mútuo entre as empresas, está **embutido em "Pagamento de Empréstimos"** (Oben R$ 81,6k)
  e **não dá pra cravar a contraparte** em read-only (nomes vazios). → **pergunta pro contador**.

## 9. Orçado vs realizado + status de fechamento

**N/A — processo inexistente.**
- `fin_fechamentos` = 0 → **abril (e todo mês) nunca foi fechado formalmente**.
- `fin_orcamento` = 0 → **sem orçamento cadastrado** → orçado-vs-realizado impossível.
- `fin_forecast` = 0 → sem projeção formal salva.

> **Decisão de processo** (setup, fora do read-only): operacionalizar o fechamento formal mensal
> e cadastrar o orçamento 2026 pra ter régua de comparação.

## 10. Movimento desde o último fechamento

1ª execução do ritual — sem base anterior. A partir de maio, comparar caixa/inadimplência/DRE.

---

## Ações priorizadas (saída do fechamento)

1. 🥇 **Mapear impostos `2.06.*`** em `/financeiro/mapping` → **recalcular DRE de abril**
   (destrava blocos 5 e 7). *Ação do dono no Lovable — é escrita.*
2. Mapear as demais categorias (folha, opex, devoluções) — completar a confiabilidade.
3. Investigar a categoria vazia da Colacor (R$ 27.937, 5 títulos).
4. **Provisionar** os fósseis da Colacor (R$ 78 mil) e **acionar cobrança D+1** na Oben.
5. **Valorar o estoque** (`fin_estoque_valor`) pra NCG fiel.
6. Levar a lista de **perguntas pro contador** (arquivo ao lado).
7. *(processo)* operacionalizar fechamento formal + orçamento 2026.

---

## Perguntas pro contador

Ver [`perguntas-contador.md`](./perguntas-contador.md) nesta pasta.
