# F2 — Custo do prazo de recebimento no PISO da régua de preço

> Frente 2 do pacote **"PEGN — 9 erros que estrangulam a margem"** (erro 6: vender a prazo sem precificar o custo do prazo). Segue o padrão money-path: helper puro (vitest) + RPC isolada (prove-sql) + Codex adversarial. Decisão conduzida por Claude+Codex (mandato do founder). **Escrita gate humano**: nada muda preço automaticamente — a régua só EXIBE o piso; o vendedor decide.

## 0. Achados de banco (aterrados via `psql-ro`, não suposições)

| # | Fato | Consequência de design |
|---|---|---|
| 0.1 | `omie_condicao_pagamento_catalogo.dias_parcelas` **VAZIO em 100%** (145 linhas ativas). O prazo mora em `descricao` texto livre (143/145 com número): `30/60/90`, `28/56/84`, `A Vista/30/60`, `Para 30 dias`. `num_parcelas` bate com a contagem de tokens; há outliers `36`/`999` (lixo). | Parser de texto livre com gate de sanidade. **Nunca** confiar em `dias_parcelas` (parser leria vazio→0→custo 0 = no-op silencioso). |
| 0.2 | Prazo **real** OBEN (`fin_contas_receber`, 365d, 5353 títulos): média **26d**, p50 **28**, p95 **60**, só **4** acima de 180d, 115 vencimentos negativos (sujeira). | Cap de **180 dias** é seguro (perde 0,07%). Validação empírica do parser filtra vencimentos negativos/antigos. |
| 0.3 | Parcelas **materialmente iguais**: 879 pedidos multi-parcela OBEN (365d), **99,8% com parcelas dentro de 10%** entre si (2 desiguais). Amostra: pedido 10066 → 779,90/779,90/779,90 nos dias 30/60/90. | **Pesos iguais (wᵢ=1/n) validado empiricamente** (satisfaz o P1-D2 do Codex). `venc − emissão` bate com os números da descrição → interpretação "cada número = dias da emissão ao vencimento daquela parcela" CONFIRMADA. |
| 0.4 | Taxa de custo de capital: `empresa_configuracao_custos` (OBEN, única linha): `selic_anual=14.75`, `spread_oportunidade=3.00`, `armazenagem_fisica=8.00` (em %). A view da reposição faz `cm_anual=(selic+spread+armazenagem)/100=0.2575`. | Taxa do PRAZO = `(selic+spread)/100 = **0.1775** (17,75% a.a.)`, **excluindo armazenagem** (custo de estocar, não de financiar duplicata). |
| 0.5 | Módulo de funding (`fin_funding_inputs`) **100% vazio** (nenhum CET em nenhuma empresa). | Não dá pra usar CET de captação — degrada para a taxa canônica (selic+spread). |
| 0.6 | `empresa_configuracao_custos` tem **RLS staff-only e SEM grant a `authenticated`**. Régua é **OBEN-only** (o carrinho só roda régua em itens Oben); a config também só tem OBEN. | Taxa entregue via **RPC SECURITY DEFINER isolada** (não via leitura direta da tabela). Escopo OBEN casa. |

## 1. Objetivo

Quando o pedido tem uma condição de pagamento a prazo, **levantar o PISO** da régua para cobrir o custo de carregar a duplicata (o dinheiro chega depois), e trocar o disclaimer "não controlado por prazo" por um recibo honesto. Quando o prazo/​taxa não é conhecido com segurança → **degrada** (piso à vista + disclaimer atual). Precisão > recall: preferimos **não** ajustar a fabricar um ajuste errado.

## 2. Fórmula — Candidato A (confirmado por Codex + legislação)

**Piso hoje** (`calcPisoMC`): `pisoAVista = cmc / (1 − a)`, `a = aliquotaVenda` (icms+pis+cofins/receita) — margem de contribuição ≥ 0 à vista.

**Piso ajustado ao prazo** — parcelas iguais (`wᵢ = 1/n`), fator de desconto por parcela `vᵢ = (1+r)^(−diasᵢ/365)`:

```
r  = (selic_anual + spread_oportunidade) / 100          // fração ∈ (0,1)
S  = (1/n) · Σ vᵢ                                        // fator presente médio das parcelas
pisoPrazo = cmc / (S − a)                                // Candidato A
custoRs   = pisoPrazo − pisoAVista                       // quanto o prazo somou
```

**Por que A e não B/C** (Codex, com base em LC 87/96 art.12 e Leis 10.637/02 e 10.833/03): ICMS/PIS/COFINS têm fato gerador na **saída/faturamento** (imposto sai do caixa ~t0 sobre a face), não no recebimento.
- **B** (`cmc/((1−a)·S)`) só valeria se o imposto acompanhasse o caixa recebido — premissa tributária errada.
- **C** (aditivo `pisoAVista + custoEmReais(cmc, d̄, r)`) subprecifica: financia só o `cmc`, não a face tributada, e não faz gross-up do imposto sobre o custo financeiro.
- Números (cmc=100, a=18%, r=17,75%, 90 dias): **A=128,12**; B=126,96; C=126,06. B/C deixam margem na mesa.

**Degeneração à vista**: todos `diasᵢ=0` → `vᵢ=1` → `S=1` → `pisoPrazo = cmc/(1−a) = pisoAVista`. Lift = 0 legítimo (não é degradação).

**Magnitude real** (taxa 17,75%, prazos OBEN típicos): 30d → +1,65%; `30/60/90` → +3,3%; `A Vista/30/60/90/120` → +3,3%. Modesto — mas é exatamente a margem que hoje evapora silenciosa.

## 3. Parser puro `parsePrazoRecebimento(descricao, numParcelas): number[] | null`

- Normaliza (lowercase, trim), split em `/`.
- Token: `a vista`/`à vista`/`avista` → `0`; `para N dias` (regex `para\s+(\d+)\s*dias?`) → `N`; número puro (`^\d+$`) → `N`.
- **Retorna `null` (degrada, nunca adivinha)** se QUALQUER: token não reconhecido; `tokens.length !== numParcelas`; `numParcelas ∉ [1..12]`; algum `dia < 0` ou `dia > 180`; lista **não** monotônica não-decrescente.
- Ex.: `"A Vista/30/60"` (num=3) → `[0,30,60]`; `"Para 45 dias"` (num=1) → `[45]`; `"30/xx/90"` → `null`; `"Para 999 dias"` → `null` (>180).

## 4. Taxa — `custoCapitalPrazo(selic, spread): number | null` (unit gate — P1-D3/D6)

- Gate: `selic` e `spread` finitos e cada um `∈ [0,100]`; `r = (selic+spread)/100`; retorna `r` **só se** `r ∈ (0,1)`; senão `null`.
- Rejeita `r ≥ 1` (≥100% a.a. = provável erro de unidade: alguém passou `17.75` em vez de `0.1775`) e `r ≤ 0`. Loga fonte + valor final.
- **Exclui `armazenagem_fisica`** (§0.4). Entregue pela RPC `fin_regua_custo_capital` (SECURITY DEFINER, RLS-safe).

## 5. Piso — `pisoComPrazo(cmc, aliquota, dias[], taxaAnual): { piso, custoRs, prazoMedio, S } | null` (gates — P1-D1/D2)

- Guards (qualquer falha → `null`): `cmc>0` finito; `aliquota ∈ [0,1)`; `taxaAnual ∈ (0,1)`; `dias` não-vazio, cada `dia ∈ [0,180]`.
- `S = média (1+r)^(−dias/365)`.
- **Gate de denominador (P1-D1)**: se `S − aliquota ≤ ε` (ε=1e-6) → `null`. Evita piso explosivo/negativo (Codex: `Para 999 dias` → +78%; dia absurdo → denominador negativo → piso negativo).
- `piso = cmc/(S − aliquota)`; se `!Number.isFinite(piso)` ou `piso ≤ 0` → `null`.
- `custoRs = piso − cmc/(1−aliquota)`; `prazoMedio = média(dias)`.

## 6. Degradação honesta (matriz) + disclaimers (P1-D6)

**Aplica o ajuste** só quando TUDO presente e válido: `cmc` confiável + `parsePrazoRecebimento` ≠ null + `custoCapitalPrazo` ≠ null + `pisoComPrazo` ≠ null. Senão **mantém o piso à vista atual** (sem regressão).

**Disclaimers — separar as duas invariantes** (hoje coladas em `'Não controlado por prazo de pagamento/frete.'`):
- **Frete SEMPRE fora** → sempre inclui `'Frete não considerado.'` (F2 não resolve frete; removê-lo fabrica confiança — P1-D6, cenário CIF).
- Linha do prazo:
  - ajuste aplicado → recibo `'Piso inclui custo do prazo: 0/30/60 dias (17,75% a.a.).'`
  - degradou → disclaimer `'Prazo de recebimento não considerado.'`
- `'Não estimamos aceite do cliente.'` permanece sempre.

## 7. Wiring (mínima superfície SQL)

- **RPC nova isolada** `fin_regua_custo_capital(p_empresa text) returns numeric` — SECURITY DEFINER, gate staff (master OR employee), retorna `(selic+spread)/100` com unit gate, ou `null` se config ausente/inválida. REVOKE anon/PUBLIC, GRANT authenticated. **Não toca a `get_regua_preco` quente.**
- **Hook** `useCustoCapitalRegua(empresa)` (react-query) chama a RPC (staleTime longo — taxa muda raramente).
- **Prazo client-side**: o vendedor já seleciona a parcela (`selectedParcelaOben`); surfacear a `descricao` + `num_parcelas` da parcela selecionada (extensão pequena do load de parcelas) e parsear no cliente.
- **`ReguaPrecoInput`** ganha `prazoDias: number[] | null` + `custoCapitalAnual: number | null` (opcionais; ausentes = comportamento atual, retrocompatível).
- **Snapshot consistency (P1-D6)**: o `codigo` da parcela selecionada entra nas deps do cálculo da régua → trocar de parcela **recalcula** (nunca piso à vista velho sobre parcela nova).

## 8. Interação com o cap (P1-D5)

O piso é PISO — **não** sofre o cap de aumento (que só afeta teto/alvo). Em `avaliarReguaPreco`, o ramo `abaixoPiso` já é early-return no topo (linhas 98-120), **antes** de qualquer cap. Levantar `pisoMC` faz `abaixoPiso = precoAtual < pisoMC` recomputar naturalmente e cair no early-return `sinal:'piso'`. Teste explícito: preço 100, piso à vista 95, piso prazo 108, cap +5% → **deve** sinalizar `piso` (108), nunca "ok". Referência histórica abaixo do novo piso (cliente bom pagou 102 em 30/60/90) → mostra "abaixo do piso ajustado ao prazo" (decisão comercial), **não** puxa o piso pra baixo (o piso é custo-based, não referência-based — já é imune).

## 9. Escopo

**Só o carrinho** (`CartItemList` → parcela selecionada). Customer360 (readonly, sem parcela no ponto) fica como está. Só OBEN (régua e config são OBEN).

## 10. Provas

- **vitest** (helper puro): parser contra os ~35 formatos reais do §0.1 + os gates (null em token inválido, tokens≠num, >180, não-monotônico, denominador, unit gate da taxa); `pisoComPrazo` (Candidato A numérico: cmc=100,a=18%,r=17,75%,90d → 128,12); degeneração à vista (lift 0); degradação (qualquer ausência → piso à vista, disclaimer intacto); cap não mascara piso; disclaimer split (frete sempre presente).
- **prove-sql-money-path** (RPC `fin_regua_custo_capital`): retorna 0.1775 p/ OBEN (exclui armazenagem, ≠0.2575); `null` se config ausente/absurda (unit gate); gate staff nega `authenticated` sem role; REVOKE anon. Falsificação: sabotar o gate/unit e exigir vermelho.
- **Validação empírica do parser** (query documentada, offline — P2-D2): para condições ativas, o prazo médio parseado da `descricao` bate com `avg(venc − emissão)` real em `fin_contas_receber` (filtrar **documentos recentes** pós-sync do catálogo + excluir vencimentos negativos; catálogo pode ter mudado de `30/60`→`30/45/60`).

## 11. Veredito Codex (challenge xhigh) — 6 P1 + P2 + P3, todos endereçados

| Item | Severidade | Onde é resolvido |
|---|---|---|
| D1: escolher A (não B/C); álgebra correta | P1 | §2 |
| Gate de dia máximo / denominador (piso negativo) | P1 | §3 (≤180, monotônico) + §5 (denominador `S−a>ε`, `isFinite`) |
| Pesos iguais só com prova empírica | P1 | §0.3 (99,8% iguais — provado) |
| Unit gate da taxa (17.75 vs 0.1775) | P1 | §4 |
| Cap nunca mascara piso | P1 | §8 |
| Manter disclaimer de frete (não fabricar) | P1 | §6 |
| Condição usada = snapshot da régua (recalcula) | P1 | §7 (código nas deps) |
| Validação histórica pode mentir (catálogo mudou) | P2 | §10 (docs recentes) |
| Excluir armazenagem correto | P2 | §0.4 / §4 |
| "A Vista" 0d entra no n (sem dupla contagem) | P2 | §2 (S com v=1) |
| Referência histórica abaixo do piso não invalida | P2 | §8 |
| Observabilidade (log dias/S/taxa/fonte/motivo) | P3 | recibos/reasonCodes já no `ReguaPrecoResult` |

## 12. Não-objetivos / backlog

- **Frete no piso** (fica fora; disclaimer honesto). Próximo passo natural quando houver frete estruturado por item.
- **Pesos reais por parcela** (entrada grande + cauda) — hoje pesos iguais (validado 99,8%). Refina quando/se surgir condição com entrada desproporcional material.
- **Custo de captação marginal** (CET real) quando `fin_funding_inputs` acender — hoje degrada para (selic+spread), a fonte canônica.
- **Régua no 360** ganhar prazo típico do cliente (DSO por cliente) — v2.
