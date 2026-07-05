# Spec — F1 Módulo de Endividamento (cadastro + serviço da dívida no A1 + DSCR-caixa)

> Frente 1 do pacote "PEGN — 9 erros que estrangulam a margem". Fecha os erros **1**
> (descasamento geração de caixa × serviço da dívida), **8** (decidir sem indicador de
> endividamento) e **9** (renegociar sem ver a geração real). Money-path: precisão >
> recall, ausente ≠ zero, gate humano na escrita, helper TS puro testado (money-path.md).
> Design aprovado pelo founder 2026-07-04. **Endurecida pelo challenge do Codex (§10):
> o DSCR só é publicável com flag de inclusão-no-CP + gate de completude — sem isso, o
> índice nasce contaminado.**

## 0. Achado que fixa o desenho (verificado em prod via psql-ro, 2026-07-04)

Não existe dado de dívida estruturado aproveitável no Omie:

- `fin_contas_pagar` (15.854 títulos): `categoria_descricao`, `tipo_documento` e
  `nome_fornecedor` estão **100% vazios** — o sync só traz o esqueleto financeiro
  (company, datas, valor, saldo, status). Zero fornecedores com cara de banco/BNDES.
- Existem parcelas com vencimento até **2031** (provável financiamento de longo prazo),
  mas **indistinguíveis** de qualquer outro pagamento — sem categoria, sem credor.
- `fin_dividas` não existe. `fin_balanco_inputs` tem 0 linhas.

**Consequência 1:** cadastro de dívida **manual master-only** (padrão `fin_balanco_inputs`).

**Consequência 2 (a armadilha-mãe, §4):** as parcelas que o founder cadastrar
**provavelmente já estão em `fin_contas_pagar`** como linhas genéricas. O A1
(`fin-cashflow-engine`) deduz as saídas de `fin_contas_pagar` do saldo projetado. Sem
saber, por dívida, se ela já está no CP, **qualquer** DSCR nasce torto — pode subestimar
*ou superestimar* (achado Codex, §10).

## 1. O que entra (escopo v1)

| Entrega | Fecha |
|---|---|
| Cadastro `fin_dividas` + `fin_divida_parcelas` (manual, master-only) | base |
| **Serviço da dívida por período** (vencidas-não-pagas + a-vencer, buckets separados) | erro 1 |
| **Alertas de concentração** (% curto prazo, vencido acumulado) | erro 8 |
| **Overlay de caixa ajustado** (desconta serviço quando a dívida NÃO está no CP) | erros 1, 9 |
| **DSCR-caixa** — **só quando** `cp_inclusion_status` resolvido + gate de completude | erros 1, 9 |
| DSCR-EBITDA / Dívida líquida/EBITDA — helper pronto, **renderiza só se EBITDA existe** | erro 8 |

Fora da v1: simulador de renegociação; conciliação automática parcela↔CP; ingest Omie;
modelagem de indexador (CDI/IPCA) — parcela futura variável entra como valor `estimado`.

## 2. Modelo de dados

Três tabelas, RLS **master-only** (padrão exato de `fin_balanco_inputs`).

### `fin_dividas` (contrato)
- `id uuid PK`, `company text NOT NULL CHECK (oben|colacor|colacor_sc)`
- `credor text NOT NULL`, `tipo text NOT NULL CHECK` ∈ {`capital_giro`, `financiamento`,
  `antecipacao_recorrente`, `outro`}
- `principal_contratado numeric(15,2) NOT NULL CHECK (>0)` — valor histórico contratado
  (**não** é a dívida atual; renomeado de `principal` p/ eliminar a ambiguidade — Codex P1)
- `saldo_devedor_informado numeric(15,2)` + `saldo_devedor_data_base date` — dívida em
  aberto na data-base (nullable; se ausente, o saldo é derivado de `Σ valor_amortizacao`
  das parcelas não pagas). É a base do % curto prazo e da dívida bruta.
- **`cp_inclusion_status text NOT NULL DEFAULT 'nao_sei' CHECK` ∈ {`sim`, `nao`,
  `parcial`, `nao_sei`}** — "as parcelas desta dívida já aparecem no seu contas-a-pagar
  do Omie?". Um clique do founder que decide overlay vs add-back (Codex P1). `parcial` usa
  `cp_inclusion_ate date`.
- `cp_inclusion_ate date` (só p/ `parcial`)
- `data_contratacao date NOT NULL`, `cet_aa numeric(7,4)`, `indexador text`
- `coobrigada_por text CHECK (oben|colacor|colacor_sc)` **nullable** — elo único de
  consolidação cross-CNPJ (caixa não-fungível)
- `garantias text`, `observacao text`, `ativo boolean NOT NULL DEFAULT true`
- `updated_at`, `updated_by uuid` (trigger, §6)

### `fin_divida_parcelas` (cronograma)
- `id uuid PK`, `divida_id uuid NOT NULL REFERENCES fin_dividas(id) ON DELETE CASCADE`
- `numero_parcela int NOT NULL CHECK (>0)`, `data_vencimento date NOT NULL`
- `valor_amortizacao numeric(15,2) NOT NULL CHECK (>=0)` — principal da parcela
- `valor_juros numeric(15,2) NOT NULL DEFAULT 0 CHECK (>=0)`
- `valor_total numeric(15,2) NOT NULL CHECK (>0)` — o que sai do caixa (fonte de verdade)
- `estimado boolean NOT NULL DEFAULT false` — parcela futura pós-fixada (indexador
  flutuante): valor é estimativa, não fato (Codex P1). A UI marca como tal.
- `pago boolean NOT NULL DEFAULT false`
- `UNIQUE (divida_id, numero_parcela)`; índices `(divida_id, data_vencimento)` e parcial
  `WHERE pago = false`

### `fin_divida_completude` (gate de completude — Codex P1)
- `company text NOT NULL CHECK (…)`, `completo` boolean, `validado_em timestamptz`,
  `validado_por uuid` — o founder declara "o cadastro de dívidas desta empresa está
  completo". **Sem esta declaração, o DSCR não é publicado** (denominador incompleto vira
  índice falso). PK `(company)`; trigger força autor/timestamp.

Nota: `valor_total` é informado, não derivado (encargos/seguro/TAC não somam limpo). Alerta
suave quando `valor_total < valor_amortizacao + valor_juros` (digitação implausível).

## 3. Indicadores (helper TS puro `endividamento-helpers.ts`, vitest)

Todos **por-empresa**. Consolidação só com `coobrigada_por`.

- **`servicoDividaHorizonte(parcelas, inicio, fim, hoje)`** → **dois buckets** (Codex P1):
  - `vencido` = Σ `valor_total` de parcelas `pago=false AND vencimento < hoje` (pressão
    represada — nunca some do cálculo)
  - `aVencer` = Σ `valor_total` de parcelas `pago=false AND vencimento ∈ [max(hoje,inicio), fim]`
  Excluir `antecipacao_recorrente` (natureza rolling, entra à parte).
- **`dscrCaixa(geracaoOperacionalA1, servico, cpStatus, completude)`** — publica **só**
  quando `completude.completo === true` E todas as dívidas da empresa têm `cpStatus ≠
  'nao_sei'`. Senão retorna `{ valor: null, motivo: 'inconclusivo' }` e a UI mostra R$
  lado a lado (serviço vs geração), **sem semáforo**. Quando publica:
  - numerador = `geracaoOperacionalA1` **+ add-back** do serviço das dívidas com
    `cp_inclusion_status='sim'` (desfaz o desconto que o A1 já fez → "cash available for
    debt service" limpo). Dívidas `'nao'` não entram no add-back (o A1 não as descontou).
  - denominador = serviço total (vencido + a-vencer) no horizonte.
  - `null` se denominador ≤ 0 (sem dívida no período).
- **Overlay de caixa ajustado:** para dívidas `cp_inclusion_status='nao'`, o saldo
  projetado mostrado desconta o serviço (o A1 base não sabe delas). Dívidas `'sim'` já
  estão no A1 base — não descontar de novo.
- **`pctCurtoPrazo(dividas, parcelas, hoje)`** → (vencido + amortização a vencer em ≤12m)
  ÷ saldo devedor em aberto. Alto = concentração de curto prazo (erro 2).
- **`dscrEbitda` / `dividaLiquidaEbitda`** → helper existe, mas UI **só renderiza quando
  EBITDA ≠ null** (sem tile "falta D&A" — teatro, Codex P1). EBITDA null → componente
  não aparece.

## 4. A armadilha do double-count — decisão de método (revisada pós-Codex)

**Problema:** parcelas de dívida provavelmente já vivem em `fin_contas_pagar` (§0); o A1
já as deduz. **Tese antiga (furada):** "não somar → DSCR conservador, nunca superestima".
**Por que fura (Codex P1):** só vale se o cadastro cobrir 100% da dívida. Se cobrir só
parte, o numerador (geração do A1) já caiu por saídas do CP que **não** entraram no
denominador manual → DSCR **superestima**. O viés não é garantidamente pessimista.

**Decisão v1 (3 camadas):**
1. **Flag `cp_inclusion_status` por dívida** — troca matching frágil (valor+vencimento)
   por um input humano de 1 clique. Decide, por dívida, se o A1 já a contém.
2. **Add-back analítico** no numerador do DSCR para as dívidas `'sim'`; **overlay** que
   desconta as `'nao'`. O A1 base nunca é reescrito (overlay, não writer — confirmado).
3. **Gate de completude** (`fin_divida_completude`): sem "cadastro completo" declarado, ou
   com qualquer dívida `'nao_sei'`, **não publica o índice** — mostra R$ lado a lado.

Isso mata os dois vieses: sem cobertura declarada, não há índice; com cobertura +
inclusão-CP conhecida, o add-back dá um DSCR semanticamente limpo.

## 5. Degradação honesta (invariantes money-path)

- Cadastro incompleto / `nao_sei` → DSCR não publica (R$ lado a lado). Nunca índice falso.
- EBITDA sem D&A → DSCR-EBITDA e dívida/EBITDA não renderizam (nunca 0).
- Sem parcelas no horizonte → serviço = 0 real; DSCR = `null` ("sem dívida no período").
- Parcela `estimado=true` → contabiliza, mas a UI marca "estimativa" (não fato).
- Caixa não-fungível: por CNPJ; `coobrigada_por` é o único elo. Nunca soma cega de CNPJs.

## 6. Segurança / RLS

- 3 tabelas: `ENABLE ROW LEVEL SECURITY`; SELECT + WRITE **master-only** (EXISTS em
  `user_roles` role=master, como `fin_balanco_inputs`).
- `updated_by`/`validado_por`/timestamps **forçados por trigger BEFORE INSERT/UPDATE**
  (default `auth.uid()` é forjável — trava Fase 2 P1). Service_role (uid NULL) mantém payload.
- Engines leem sob `service_role` (BYPASSRLS) para compor overlay sem afrouxar policy.

## 7. Arquitetura e superfície de UI

- **Helper:** `src/lib/financeiro/endividamento-helpers.ts` (puro, vitest). Espelho edge
  só se o A1 precisar do overlay server-side (decidir no plano; v1 pode calcular client,
  master lê cadastro sob RLS).
- **Migration:** via `lovable-db-operator` (arquivo + bloco SQL Editor + validação
  pós-apply + nota PR). Timestamp após `20260703140000`.
- **UI:** página/aba master-only no Financeiro — cadastro (dívida + parcelas + flag CP +
  botão "marcar cadastro completo") + tabela de indicadores por empresa + faixa "serviço
  da dívida (vencido | a-vencer) / DSCR ou 'inconclusivo'" ancorada na projeção 13 semanas.
- House style: `text-status-*`, `useUrlState`, `sonner`, `<PageSkeleton>`, `<EmptyState>`.

## 8. Prova (prove-sql-money-path, PG17) + threat-model

Asserts (helper vitest + constraints/RLS no PG17):
- Serviço: parcela paga não conta; parcela vencida-não-paga entra no bucket `vencido`;
  fora da janela não conta; `antecipacao_recorrente` fora do serviço.
- DSCR: **não publica** sem completude / com `nao_sei`; add-back só para `'sim'`; `null`
  quando denominador ≤ 0; **não fabrica** (geração null nunca vira 0).
- `pctCurtoPrazo`: parcela em 13 meses não é curto; em 11 meses é; vencido conta.
- DSCR-EBITDA/dívida-EBITDA: `null`+motivo quando EBITDA ausente.
- Constraints: `principal_contratado>0`, `valor_total>0`, enums, UNIQUE, CASCADE.
- RLS: não-master SELECT→0; INSERT→42501; master passa (SET ROLE + GUC).
- **Falsificação:** (a) sabotar `servicoDividaHorizonte` (incluir parcela paga)→vermelho;
  (b) publicar DSCR sem gate de completude→vermelho; restaurar→verde.

Threat-model (1 assert cada):

| Situação | Default | Racional |
|---|---|---|
| Cadastro sem completude declarada | DSCR não publica, R$ lado a lado | denominador incompleto = índice falso |
| Qualquer dívida `cp_inclusion='nao_sei'` | DSCR não publica | inclusão-CP desconhecida contamina |
| EBITDA sem D&A | indicador não renderiza | ausente ≠ zero, sem teatro |
| Parcela vencida não paga | entra no bucket `vencido` | pressão represada nunca some |
| Não-master lê/escreve | 42501 / 0 linhas | dado financeiro é master-only |
| Consolidar CNPJs sem coobrigação | não consolida | caixa não-fungível |

## 9. Decisões (resolvidas com o Codex, §10)

1. Overlay vs writer: **overlay** (A1 base intacto) + overlay ajustado quando `cp='nao'`. ✅
2. DSCR conservador: **rejeitado** — publica só com flag CP + gate de completude; senão R$
   lado a lado sem semáforo. ✅
3. `valor_total` informado: **sim** + alerta quando `< amortização+juros`. ✅
4. % curto prazo sobre amortização (principal): **sim**, incluindo vencido + 12m. ✅
5. `antecipacao_recorrente`: **fora do DSCR**, mostrada como exposição recorrente à parte. ✅
6. EBITDA-based: helper pronto, **renderiza só quando EBITDA existe**. ✅

## 10. Veredito do challenge Codex (2026-07-04, 8 P1 — todos acatados)

1. **Tese "conservador nunca superestima" FURA** — só vale com cadastro 100%; cobertura
   parcial superestima. → flag `cp_inclusion_status` + gate de completude.
2. **DSCR híbrido semanticamente torto** (numerador pós-parte-da-dívida) → add-back
   analítico para dívidas no CP; sem flag/completude não publica.
3. **Flag humano é o caminho barato e honesto** (1 clique > matching frágil).
4. **Gate de completude** por empresa (`validado_em/por`) antes de exibir DSCR.
5. **Parcelas vencidas não-pagas** não podem sumir → bucket `vencido` separado.
6. **`principal` ambíguo** → `principal_contratado` (histórico) + `saldo_devedor_informado`
   (dívida atual, base do % curto prazo).
7. **Dívida pós-fixada** → parcela futura marca `estimado=true`.
8. **`antecipacao_recorrente` é outra natureza** (líquida nos recebíveis, rolling) →
   fora do DSCR; DSCR-EBITDA/dívida-EBITDA cortados da UI até haver EBITDA.

## 11. Challenge Codex no CÓDIGO (2026-07-04, 3 P1 — todos acatados)

Após implementar (helper + migration + UI), o Codex adversarial no código achou 3 P1:

1. **`cp_inclusion_status='parcial'` publicava DSCR enganoso** — passava no gate mas não
   entrava no add-back (o A1 deduziu parte, o add-back não devolve). Fix: `parcial`
   bloqueia como `nao_sei` (→ inconclusivo). Teste P1-1.
2. **Dívida ativa sem agenda virava "sem dívida"** (fabricação de ausência) — dívida
   relevante sem nenhuma parcela → serviço subcontado → DSCR superestimaria. Fix: dívida
   relevante (não antecipação) sem parcela → inconclusivo. Teste P1-2.
3. **`useReplaceParcelas` delete+insert não-atômico** podia apagar as parcelas se o insert
   falhasse (com `completo=true`, derrubaria o denominador silenciosamente). Fix: RPC
   transacional `fin_divida_replace_parcelas` (migration `20260704160500`, SECURITY DEFINER
   + gate master), provada no PG17 (atomicidade A17b + gate A18 + falsificação F4).

Prova total: 20 testes vitest + 24 asserts PG17 (`db/test-endividamento-money-path.sh`).
