# Spec — F1 Módulo de Endividamento (cadastro + serviço da dívida no A1 + DSCR-caixa)

> Frente 1 do pacote "PEGN — 9 erros que estrangulam a margem". Fecha os erros **1**
> (descasamento geração de caixa × serviço da dívida), **8** (decidir sem indicador de
> endividamento) e **9** (renegociar sem ver a geração real). Money-path: precisão >
> recall, ausente ≠ zero, gate humano na escrita, helper TS puro testado (money-path.md).
> Design aprovado pelo founder 2026-07-04 (foco no serviço da dívida + DSCR-caixa;
> DSCR-EBITDA degrada quando falta D&A; simulador de renegociação fica v2).

## 0. Achado que fixa o desenho (verificado em prod via psql-ro, 2026-07-04)

Não existe dado de dívida estruturado aproveitável no Omie:

- `fin_contas_pagar` (15.854 títulos): `categoria_descricao`, `tipo_documento` e
  `nome_fornecedor` estão **100% vazios** — o sync só traz o esqueleto financeiro
  (company, datas, valor, saldo, status). Zero fornecedores com cara de banco/BNDES.
- Existem parcelas com vencimento até **2031** (provável financiamento de longo prazo),
  mas **indistinguíveis** de qualquer outro pagamento — sem categoria, sem credor.
- `fin_dividas` não existe. `fin_balanco_inputs` tem 0 linhas (input manual do Fleuriet
  ainda não alimentado).

**Consequência 1:** o cadastro de dívida é **manual master-only** (padrão
`fin_balanco_inputs`). Não há ingest do Omie na v1.

**Consequência 2 (a armadilha-mãe, §4):** as parcelas de financiamento que o founder
cadastrar **provavelmente já estão dentro de `fin_contas_pagar`** como linhas genéricas.
O motor A1 (`fin-cashflow-engine`) puxa saídas de `fin_contas_pagar`. Somar as parcelas
cadastradas ao fluxo de saídas do A1 **conta a dívida duas vezes**.

## 1. O que entra (escopo v1 aprovado)

| Entrega | Fecha |
|---|---|
| Cadastro `fin_dividas` + `fin_divida_parcelas` (manual, master-only) | base de tudo |
| **Serviço da dívida por período** (parcelas a vencer numa janela) | erro 1 |
| **DSCR-caixa** = geração operacional projetada ÷ serviço da dívida no horizonte | erros 1, 9 |
| **% curto prazo** = amortização ≤12m ÷ principal em aberto | erro 8 |
| DSCR-EBITDA e Dívida líquida/EBITDA — **secundários, degradam sem D&A** | erro 8 (triagem) |

Fora da v1 (corte do Codex, viram v2): simulador de renegociação completo; dívida/EBITDA
como headline/covenant; conciliação automática parcela ↔ contas-a-pagar; ingest do Omie.

## 2. Modelo de dados

Duas tabelas, RLS **master-only** (mesmo padrão exato de `fin_balanco_inputs` §RLS).

### `fin_dividas` (contrato)
- `id uuid PK default gen_random_uuid()`
- `company text NOT NULL CHECK (oben|colacor|colacor_sc)` — dívida é por-CNPJ
- `credor text NOT NULL` (banco/instituição)
- `tipo text NOT NULL CHECK` ∈ {`capital_giro`, `financiamento`, `antecipacao_recorrente`, `outro`}
- `principal numeric(15,2) NOT NULL CHECK (principal > 0)` — valor contratado
- `data_contratacao date NOT NULL`
- `cet_aa numeric(7,4)` — CET all-in a.a. (fração; nullable — nem todo contrato tem)
- `indexador text` — livre (`CDI+3.5%`, `prefixado 18%`, `IPCA+6%`)
- `coobrigada_por text CHECK (oben|colacor|colacor_sc)` **nullable** — empresa que
  avaliza. Só com este campo preenchido a consolidação cruza CNPJ (caixa não-fungível).
- `garantias text`, `observacao text`, `ativo boolean NOT NULL DEFAULT true`
- `updated_at`, `updated_by uuid` (forçado por trigger, ver §6)

### `fin_divida_parcelas` (cronograma)
- `id uuid PK`
- `divida_id uuid NOT NULL REFERENCES fin_dividas(id) ON DELETE CASCADE`
- `numero_parcela int NOT NULL CHECK (>0)`
- `data_vencimento date NOT NULL`
- `valor_amortizacao numeric(15,2) NOT NULL CHECK (>=0)` — principal da parcela
- `valor_juros numeric(15,2) NOT NULL DEFAULT 0 CHECK (>=0)`
- `valor_total numeric(15,2) NOT NULL CHECK (>0)` — o que sai do caixa (amortização+juros+encargos)
- `pago boolean NOT NULL DEFAULT false`
- `UNIQUE (divida_id, numero_parcela)`
- índice `(divida_id, data_vencimento)` e parcial `WHERE pago = false` (serviço futuro)

Nota: `valor_total` é o campo que dirige o serviço da dívida (o que sai do caixa).
`valor_amortizacao`/`valor_juros` são para decompor (juros vira despesa financeira na DRE;
amortização abate o principal). Não derivamos `valor_total` da soma — encargos/seguro/TAC
podem não bater; o founder informa o total real da parcela (fonte de verdade do caixa).

## 3. Indicadores (helper TS puro `endividamento-helpers.ts`, vitest)

Todos **por-empresa** (caixa não-fungível). Consolidação de grupo só quando
`coobrigada_por` explícito — nunca soma cega de CNPJs.

- **`servicoDividaHorizonte(parcelas, dataInicio, dataFim)`** → soma de `valor_total`
  das parcelas **não pagas** com `data_vencimento ∈ [início, fim]`. É o denominador do
  DSCR e o número que a UI mostra na projeção. Também exposto em janelas: próximos 13
  semanas (casar com o A1), 12 meses, total em aberto.
- **`dscrCaixa(geracaoOperacional, servicoDivida)`** → `geracaoOperacional / servicoDivida`.
  `servicoDivida <= 0` → `null` (sem dívida no horizonte, DSCR não faz sentido).
  `geracaoOperacional` ausente → `null`. Faixas de leitura: `<1` aperta (não cobre),
  `1–1.2` folga fina, `>1.2` confortável. **É indicador direcional, não covenant.**
- **`pctCurtoPrazo(parcelas, hoje)`** → amortização vencendo em ≤12m ÷ principal em
  aberto total. Alto = concentração de curto prazo (o erro 2 da matéria).
- **`dscrEbitda(ebitda, servicoDividaLTM)`** e **`dividaLiquidaEbitda(dividaBruta,
  caixa, ebitda)`** → **secundários**. `ebitda == null` (falta D&A) → retornam `null`
  + motivo `'falta_ebitda'`. **Nunca fabricam EBITDA** (Number(null)===0 é fabricação).
  A UI mostra "falta D&A" em vez do número.

EBITDA na v1: derivável da DRE gerencial (`fin_dre_snapshots`) **se** houver linha de
D&A classificada; senão `null`. Não inventamos D&A. (Input manual de D&A fica p/ quando
o founder pedir — hoje ele optou por não alimentar.)

## 4. A armadilha do double-count — decisão de método (a mais importante)

**Problema:** as parcelas de dívida provavelmente já vivem em `fin_contas_pagar` (§0). O
A1 já deduz essas saídas do saldo projetado. Se somarmos as parcelas cadastradas ao
fluxo, o saldo do A1 despenca duas vezes.

**Decisão v1: o serviço da dívida é um OVERLAY ANALÍTICO, não um writer no fluxo de
caixa.** O helper e a UI de endividamento **não injetam** parcelas nas saídas do
`fin-cashflow-engine`. O A1 permanece intacto. O serviço da dívida é calculado do
cadastro e mostrado **ao lado** da projeção como uma faixa de leitura ("das saídas
projetadas, R$ X é serviço de dívida cadastrado; DSCR = Y").

**Numerador do DSCR-caixa:** geração de caixa operacional projetada que o A1 já produz.
Como não conseguimos separar cirurgicamente o serviço da dívida das outras saídas em
`fin_contas_pagar`, o DSCR-caixa v1 é **conservador por construção** — se uma parcela já
está no contas-a-pagar, ela reduz o numerador (geração) *e* aparece no denominador. Isso
**subestima** a cobertura, nunca superestima. No money-path, errar para o lado pessimista
é aceitável; o caveat fica fixo na UI. (v2 resolve com conciliação parcela↔CP.)

**Por que não somar e deduplicar agora:** exigiria casar parcela ↔ linha de CP por
valor+vencimento — frágil (valores raramente batem exato: juros variam, CP tem outras
saídas no mesmo valor) e é a "amortização automática" que o Codex mandou cortar da v1.

Esta é a decisão que o **Codex challenge** deve stressar (§9).

## 5. Degradação honesta (invariantes money-path)

- D&A ausente → EBITDA `null` → DSCR-EBITDA e dívida/EBITDA não calculam (mostram "falta
  D&A"), nunca 0.
- Sem parcelas no horizonte → serviço da dívida = 0 real (é 0, não ausência); DSCR-caixa
  = `null` (divisão sem sentido), UI mostra "sem dívida no período".
- Geração operacional do A1 indisponível (empresa sem projeção) → DSCR-caixa `null`.
- Caixa não-fungível: indicadores por CNPJ; `coobrigada_por` é o único elo de
  consolidação. Nunca somar caixa da Oben contra dívida da Colacor sem o campo.

## 6. Segurança / RLS

- Ambas as tabelas: `ENABLE ROW LEVEL SECURITY`; SELECT e WRITE **master-only**
  (EXISTS em `user_roles` role=master, exatamente como `fin_balanco_inputs`).
- `updated_by`/`updated_at` **forçados por trigger BEFORE INSERT/UPDATE** (default
  `auth.uid()` é forjável — lição da trava Fase 2 P1). Sob service_role (`auth.uid()`
  NULL) mantém o payload.
- Tabela nova sai com RLS (CLAUDE.md §11). `service_role`/`postgres` têm BYPASSRLS →
  engines leem sem afrouxar policy.
- Leitura pelo A1/Cockpit: as engines rodam sob `service_role`, então leem o cadastro
  para compor o overlay sem tocar a RLS master-only.

## 7. Arquitetura e superfície de UI

- **Helper:** `src/lib/financeiro/endividamento-helpers.ts` (puro, vitest). Se alguma
  engine edge precisar dos indicadores, espelho verbatim com guard MIRROR (Deno não
  importa de src/). Na v1 o cálculo pode viver só no client (master-only lê o cadastro
  sob RLS) — decidir no plano se o A1 precisa do overlay server-side.
- **Migration:** via `lovable-db-operator` (arquivo + bloco SQL Editor + validação
  pós-apply + nota PR). Timestamp após `20260703140000`.
- **UI:** página/aba master-only no Financeiro — formulário de cadastro (dívida +
  parcelas) + tabela de indicadores por empresa + a faixa "serviço da dívida / DSCR"
  ancorada na projeção 13 semanas existente. Toque mínimo no A1 (overlay, não reescrita).
- Tokens de status (`text-status-*`), `useUrlState` p/ filtros, `sonner` p/ toast — house
  style do CLAUDE.md.

## 8. Prova (prove-sql-money-path, PG17) + threat-model

Asserts mínimos (helper TS testado em vitest + SQL das constraints/RLS no PG17):
- Serviço da dívida soma só parcelas não-pagas no intervalo; parcela paga não conta;
  parcela fora da janela não conta.
- DSCR-caixa: `null` quando serviço ≤ 0; `null` quando geração ausente; valor correto
  no caso feliz; **não fabrica** (geração null nunca vira 0).
- DSCR-EBITDA / dívida-EBITDA: `null` + motivo quando EBITDA ausente.
- `% curto prazo`: parcela em 13 meses não conta como curto; em 11 meses conta.
- Constraints: `principal>0`, `valor_total>0`, company/coobrigada no enum, UNIQUE
  `(divida_id, numero_parcela)`, `ON DELETE CASCADE` apaga parcelas.
- RLS: não-master SELECT → 0 linhas; não-master INSERT → 42501; master passa (SET ROLE
  + GUC do JWT, psql é superuser e bypassaria).
- **Falsificação:** sabotar `servicoDividaHorizonte` (incluir parcela paga) → assert
  vermelho; restaurar → verde.

Threat-model (cada default com 1 assert):

| Situação | Default | Racional |
|---|---|---|
| EBITDA sem D&A | indicador = `null` + "falta D&A" | ausente ≠ zero |
| Serviço da dívida = 0 no horizonte | DSCR = `null`, "sem dívida no período" | 0 real ≠ divisão inválida |
| Parcela já no contas-a-pagar | DSCR conservador (subestima) + caveat | erro pró-pessimista é seguro no money-path |
| Não-master lê/escreve | 42501 / 0 linhas | dado financeiro sensível é master-only |
| Consolidar CNPJs sem coobrigação | não consolida | caixa não-fungível |

## 9. Decisões para o challenge do Codex (metodologia → antes do plano)

1. **Overlay vs. writer no fluxo (§4):** o serviço da dívida como faixa analítica ao
   lado do A1 (não somado às saídas) é o certo para evitar double-count na v1? Ou há um
   caminho honesto de somar-e-deduplicar que valha o custo?
2. **Numerador conservador do DSCR-caixa:** aceitar o viés pessimista + caveat, ou o
   DSCR-caixa v1 fica frágil demais para publicar (melhor só mostrar serviço da dívida
   em R$ e segurar o DSCR para v2 com conciliação)?
3. **`valor_total` informado vs. derivado** (amortização+juros): informado é a fonte de
   verdade do caixa (encargos não somam limpo). Concorda?
4. **% curto prazo sobre amortização (principal) vs. sobre `valor_total`:** curto prazo
   clássico é sobre principal; confirmar.
5. Algo que a matéria aponta (erros 1/8/9) que este escopo v1 não cobre?
