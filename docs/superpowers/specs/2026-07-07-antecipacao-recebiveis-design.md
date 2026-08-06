# F4 — Antecipação de recebíveis (custo + comparação de funding)

> Frente 4 do pacote **PEGN — "9 erros que estrangulam a margem"** (erro: pagar caro para antecipar recebível sem medir o custo). **Reativada 2026-07-07**: o founder confirmou que antecipa no Itaú com frequência. **Registro MANUAL** — o dado bancário não traz o sinal (§0). Overlay analítico; nada reescreve sync/DRE. Decisão Claude+Codex. **Revisada pós-Codex (§11): 5 P1 corrigidos.**

## 0. Achados de banco (por que é manual, aterrado via `psql-ro`)
| # | Fato | Consequência |
|---|---|---|
| 0.1 | Antecipação **NÃO tem footprint** em `fin_movimentacoes`: 0 linhas p/ `antecip/desconto/duplicata/itaú` em 12m; 0 em categorias de custo financeiro (juros/taxa/IOF). | A operação ocorre no Itaú e não volta ao Omie como lançamento reconhecível. **Auto-detecção fabricaria sinal** (viola ausente≠zero). |
| 0.2 | `fin_contas_receber` não distingue título **antecipado** de normal (grounding F5). | Não dá pra derivar antecipação da carteira. |
| 0.3 | Codex já adjudicou "**não auto-detectar**" (sessão anterior). O founder confirma a dor → construir no molde **manual** do F1 (`fin_dividas`). | F4 = entrada manual + medidor + calculadora. |

## 1. Objetivo
Medir o **custo real** da antecipação (custo em R$ + taxa efetiva) e oferecer uma **comparação de custo de funding** (antecipar vs a alternativa de crédito), a partir de operações registradas manualmente. Precisão > recall: **sem operação registrada = sem custo** (nunca fabricar economia/custo). **Não** promete um veredito "vale a pena" — isso depende do uso do caixa (§4).

## 2. Modelo — a operação de antecipação
Tabela nova `fin_antecipacoes` (uma linha por operação; **unifica** desconto-de-duplicata e linha-rotativa):
```
company text NOT NULL
banco text                          -- 'Itaú' etc (livre)
tipo text CHECK IN ('duplicata','linha')
valor_bruto numeric   NOT NULL      -- FACE ANTECIPADA (não a face total do título — suporta parcial)
custos_avulsos numeric NOT NULL DEFAULT 0   -- IOF/tarifa debitados FORA do líquido (P1-4 Codex)
valor_liquido numeric NOT NULL      -- o que efetivamente caiu na conta
data_operacao date    NOT NULL      -- quando o dinheiro entrou
data_vencimento date  NOT NULL      -- UM vencimento por operação (lote multi-venc → split, §7)
operacao_origem_id uuid             -- rollover/renovação: aponta a origem (registra só o caixa NOVO; §7)
referencia text                     -- contrato/banco (dedup manual)
observacao text
created_by uuid, created_at timestamptz, updated_by uuid, updated_at timestamptz  -- auditoria (trigger)
deleted_at timestamptz              -- soft delete (trilha; não apaga histórico de custo)
CHECK (valor_bruto > 0 AND valor_liquido > 0 AND custos_avulsos >= 0)
CHECK (valor_liquido <= valor_bruto + custos_avulsos)  -- P1-1: '=' é custo zero, VÁLIDO; inválido só se líquido > (bruto+avulsos)
CHECK (data_vencimento > data_operacao)                -- prazo positivo
-- dedup: UNIQUE parcial (company, banco, referencia) WHERE referencia IS NOT NULL AND deleted_at IS NULL
```
**Derivados no helper puro (NUNCA gravados):**
- `custo = valor_bruto + custos_avulsos − valor_liquido`  (P1-4: custos fora do líquido entram)
- `dias = data_vencimento − data_operacao`
- `taxa_periodo = (valor_bruto + custos_avulsos) / valor_liquido − 1`   (custo sobre o que recebeu)
- `taxa_efetiva_aa = (1 + taxa_periodo)^(365/dias) − 1`   (só como NORMALIZAÇÃO — nunca a métrica única; §3)

## 3. Job A — medidor de custo (período) — P1-2 corrigido
**Métrica primária = caixa, não média de taxas.** A média aritmética de EAR individual não reconcilia com R$ pagos (uma operação curtíssima com EAR absurda inflaria a média). Então:
- **`custo_total`** = Σ`custo` (R$) — a headline.
- **`volume_antecipado`** = Σ`valor_liquido`.
- **`taxa_realizada_aa`** = `custo_total / (Σ (valor_liquido × dias) / 365)` — custo anualizado **money-weighted** sobre capital-tempo (reconcilia com caixa). É a taxa "de verdade" do período.
- **tendência mensal por `data_operacao`** (visão contratação/caixa) — **v1 declara essa base explicitamente**; rateio por competência (custo espalhado pelos dias do mês) é v2 (§10). Sem declarar a base, a tendência mente.
- Sempre exibir **R$ + taxa do período + taxa a.a.** (P2 Codex) — nunca só a a.a. (que explode em prazo curto).
- **Degrada honesto:** período sem registro → **"sem antecipações registradas no período"** (P1-6: "registradas", dado é manual) — não um R$0 travestido de "custo zero". Linhas inválidas excluídas → `dados_parciais` (não mostra "ok" com operação ignorada em silêncio).

## 4. Job B — comparação de custo de funding — P1-3/P1-4 corrigidos
**Não** é um veredito "vale a pena" (isso depende do uso do caixa — cobrir buraco, evitar inadimplência, comprar insumo com margem, aproveitar desconto de fornecedor, reinvestir acima do custo). É uma **comparação de custo de funding**:
- Input: valor do título, dias até vencer, e a taxa **ou** o líquido ofertado pelo Itaú (+ custos avulsos).
- Mostra **custo em R$ + taxa do período + taxa efetiva a.a.** da oferta.
- **Comparação no MESMO período** (P1-3): `taxa_periodo_oferta` vs `hurdle` convertido para os mesmos `dias`. O hurdle é armazenado **com sua unidade explícita** (efetiva a.a. / nominal a.a. / a.m.); a conversão respeita a unidade.
- **Hurdle editável é PRIMÁRIO** (P1-3 Codex: custo médio de dívida ativa ≠ custo marginal disponível hoje — dívida velha barata engana). F1 (custo médio ponderado das dívidas) entra como **sugestão/fallback**, sempre com a unidade rotulada.
- **Veredito só de funding:** `taxa_oferta > hurdle` → "mais caro que sua alternativa de crédito"; senão "dentro do seu custo de funding". Nunca "vale a pena" sem um benefício/necessidade explícito do caixa (v2, §10).
- **Honesto:** hurdle ausente → só o custo (sem comparação); hurdle sem unidade → `hurdle_unidade_invalida`; taxa e líquido informados que não batem → `inputs_conflitantes`.

## 5. Degradação honesta (motivo, sem número) — P1-6 expandido
| motivo | quando |
|---|---|
| `dados_invalidos` | `líquido > bruto+avulsos`, `dias ≤ 0`, ou valores < 0 (barra no CHECK; helper blinda) |
| `dados_parciais` | linhas inválidas excluídas do agregado — agregado nunca sai "ok" com operação ignorada em silêncio |
| `sem_operacoes` | período sem registro → sem custo (≠ "economia zero"); msg "sem antecipações **registradas**" |
| `fluxo_nao_suportado` | lote multi-vencimento sem split, rollover sem `operacao_origem_id`, ou prazo médio manual (§7) |
| `hurdle_unidade_invalida` | Job B com hurdle sem base temporal/tipo |
| `inputs_conflitantes` | Job B recebe taxa **e** líquido que não reconciliam |
| `hurdle_indisponivel` | Job B sem F1 nem hurdle editável → só custo, sem comparação |
| `erro_consulta` / `permissao_negada` | falha de leitura / RLS — **não** confundir com "sem operações" |
| `ok` | calcula |

## 6. Conexões (money-path)
- **F4↔F1:** o hurdle **sugere** a partir do custo de dívida do F1 (com unidade); e a antecipação **É dívida de curto prazo** (aumenta alavancagem) → alimentar o DSCR/endividamento do F1 com o saldo antecipado é **v2** (nota — fora do escopo aqui).
- **F4↔F5:** títulos antecipados saem do risco de concentração — só com link a títulos reais (v2).

## 7. Escopo v1 (YAGNI + honestidade Codex P1-5)
- **Uma operação = um vencimento.** Lote de duplicatas com vencimentos diferentes → **registrar uma operação por título/vencimento** (a UI orienta). Um único `data_vencimento` para um lote multi-venc **inventa prazo** → se detectado, `fluxo_nao_suportado`.
- **Rollover/renovação de linha:** registrar **só o caixa novo líquido + custo incremental**, apontando `operacao_origem_id` (não re-registra o principal rolado → não conta 2×). Cadeia de rollover completa = v2.
- **Antecipação parcial:** `valor_bruto` = face **antecipada**, não a face total do título.
- **Custos fora do líquido** (IOF/tarifa): via `custos_avulsos`.
- **Sem** link a títulos reais de `fin_contas_receber` e **sem** tabela `fin_antecipacao_itens` (multi-título por operação) — v2. **Sem** reconciliação de liquidação real vs prevista — v2.
- Multi-empresa (tag por operação).

## 8. Wiring
- **Migration** `fin_antecipacoes` (RLS master-only, trigger de autor `updated_by/at`, CHECKs, unique parcial de `referencia`, soft delete) — molde `fin_dividas`/`fin_dre_custo_tipo`. **prove-sql-money-path**: RLS nega `authenticated`; os CHECKs (incl. `líquido = bruto+avulsos` VÁLIDO, `líquido > bruto+avulsos` barrado); trigger; unique de dedup; **falsificação** (sabota cada um → vermelho).
- **Helper puro** `antecipacao-helpers.ts` (custo, taxa período/a.a., agregação money-weighted, normalização de unidade do hurdle, comparação de funding) — sem I/O, vitest.
- **Hook** `useAntecipacoes(company)` + mutations (CRUD master, soft delete, RLS-safe).
- **UI:** aba **"Antecipação"** no `/financeiro` (master-only) — lista/CRUD + card medidor (Job A) + calculadora de funding (Job B).

## 9. Provas
- **vitest** (helper puro): custo com `custos_avulsos`; taxa período/a.a. de caso conhecido; **`líquido == bruto+avulsos` → custo 0/taxa 0 VÁLIDO** (P1-1); agregação money-weighted reconcilia com R$ (P1-2); normalização de unidade do hurdle + comparação no mesmo período (P1-3); **todos** os motivos (`dados_invalidos`, `dados_parciais`, `sem_operacoes`, `fluxo_nao_suportado`, `hurdle_unidade_invalida`, `inputs_conflitantes`, `hurdle_indisponivel`, `erro`/`permissao`); prazo curtíssimo mostra R$+período+a.a. (não só a.a. explodida).
- **prove-sql-money-path** (`fin_antecipacoes`): RLS master-only; CHECKs (igualdade válida, custos_avulsos≥0, datas); unique de dedup; trigger autor; **falsificação**.
- **Codex adversarial**: design (§11, feito) + código (sessão de implementação).

## 10. Não-objetivos / backlog
- **`fin_antecipacao_itens`** (multi-título por operação, vencimentos diferentes num lote) — v2.
- **Cadeia de rollover** completa (hoje: `operacao_origem_id` + registrar só incremental) — v2.
- **Reconciliação** de liquidação real (cliente pagou o Itaú na data?) — v2.
- **Tendência por competência** (rateio do custo pelos dias do mês) — v1 usa `data_operacao` declarado — v2.
- **XIRR agregada** como taxa efetiva composta do período (v1: money-weighted simples sobre exposição) — v2.
- **Veredito "vale a pena"** com benefício/retorno esperado do uso do caixa (ROIC/margem, necessidade de liquidez) — v1 só compara funding — v2.
- **Alimentar DSCR/F1** com a antecipação como dívida CP — v2.
- **Detecção assistida** se o Itaú/Omie um dia trouxer o lançamento — v2.

## 11. Revisão independente Codex (challenge xhigh, 2026-07-07) — 5 P1, todos corrigidos
| Item | Sev | Veredito | Onde |
|---|---|---|---|
| Base `líquido` + composta | ✓ | correto (funding, comparável a efetiva a.a.) | §2 |
| `líquido ≥ bruto` contradizia `≤`; `=` é custo zero | **P1** | inválido só `líquido > bruto+avulsos`; `=` válido | §2, §5, §9 |
| Média de EAR individual não fecha com caixa | **P1** | money-weighted `custo/(Σlíquido×dias/365)`; tendência por base declarada | §3 |
| Hurdle sem casar unidade = lixo | **P1** | normalizar/comparar no mesmo período; sem unidade → sem veredito | §4, §5 |
| "vale a pena" forte demais; média≠marginal | **P1** | "comparação de funding"; hurdle editável primário, F1 sugestão | §4 |
| Modelo fabrica em lote/rollover/parcial/IOF | **P1** | `custos_avulsos`, face antecipada, 1 venc/op (split), `operacao_origem_id`, `fluxo_nao_suportado` | §2, §7 |
| Motivos incompletos | P2→**feito** | +`dados_parciais`/`fluxo_nao_suportado`/`hurdle_unidade_invalida`/`inputs_conflitantes`/`erro`/`permissao` | §5 |
| Referência única, updated_by/at, soft delete | P2→**feito** | no modelo | §2 |
| Sempre R$ + taxa período + a.a.; avisar prazo curto | P2→**feito** | §3, §4 |

**Veredito final:** com os 5 P1 acima corrigidos nesta revisão, o Codex declarou o desenho **construível**. Falta: Codex adversarial **no código** (sessão de implementação) + prove-sql.

- **Implementação em sessão nova** (handoff): esta sessão está longa; a spec fecha com contexto quente, o build começa limpo.
