# Tipologia de Fleuriet / cobertura estrutural do giro no Cockpit — design

> Spec. Origem: artigo de gestão de capital de giro (modelo Fleuriet/Braga) trazido pelo founder → "isso existe no app?". O app tem NCG real, mas não a tipologia. Este doc desenha como entregá-la **honestamente**, dado que o app não tem balanço estrutural. Metodologia validada por Codex (consult, 2026-07-01) — ver §Decisões.

## Problema

O artigo propõe classificar a saúde estrutural pela **tipologia de Fleuriet/Braga**: os sinais de três grandezas — Capital de Giro (CDG), Necessidade de Capital de Giro (NCG) e Saldo de Tesouraria (T = CDG − NCG) — mapeiam a empresa em 6 tipos (Excelente → Alto risco). O app já calcula **NCG real** (engine A1, `ACO − PCO`, por empresa, diária), mas:

- **Não tem CDG estrutural.** O `capital_giro` da A2 é o próprio NCG reaproveitado (`resolverCapitalGiro` em `src/lib/financeiro/valor-helpers.ts:109`). Não há balanço patrimonial.
- **Não tem o T de Fleuriet.** O `saldo_tesouraria` da engine é `saldo_cc − folha_30d` (`supabase/functions/fin-cashflow-engine/index.ts:1051`) — liquidez imediata, não `ACF − PCF`.

Logo, cravar um "Tipo I–VI" diário exigiria fabricar CDG/T — proibido pela regra-mãe do módulo (`ausente ≠ 0`, nunca fabricar número).

## Decisões (Claude + Codex)

O Codex (challenge da metodologia, sessão `019f1fe7`) confirmou as premissas no código e furou duas coisas. Decisões finais:

1. **Classificação as-of o balancete, nunca diária.** A identidade `T = CDG − NCG` só vale se CDG e NCG forem da **mesma data**. CDG vem de balanço trimestral (data `X`); usar `CDG_X − NCG_hoje` embute o erro `CDG_X − CDG_hoje` (lucro/aporte/AFAC/capex/reclassificação de dívida entre X e hoje) e **troca o Tipo com ruído perto de zero**. → Classificamos na data do balancete, casando com o **NCG do snapshot mais próximo de `X` (janela ±7 dias)**; fora da janela → `indisponível`.
2. **O selo primário é COBERTURA, não o rótulo de 6 tipos.** A pergunta de decisão real é "a NCG operacional está coberta por capital permanente?". O selo mostra `CDG`, `NCG` (mesma data), `Gap = CDG − NCG`, `Cobertura = CDG/NCG` e um **status** (coberta / descoberta / operação financia o giro / indisponível). A **tipologia de Braga** aparece como **etiqueta secundária** (tooltip / subtítulo) — dá o "rating" do artigo sem ser o número que decide.
3. **Banda de materialidade para o zero.** `CDG≈0`, `NCG≈0` ou `T≈0` não são forçados a um sinal. Abaixo de um limiar (max(1% da receita líquida mensal média, R$ 500 absoluto)) o sinal é `~0` (fronteira/indeterminado), refletido no rótulo.
4. **Honestidade no rótulo:** a NCG do app é gerencial/ERP, não a NCG contábil do mesmo balanço; o `Gap` é rotulado como **gap estrutural** com esse caveat. Selo **por empresa** (caixa/estrutura não-fungível entre os 3 CNPJs); consolidado é visão secundária.
5. **Fora da v1:** o proxy diário `CDG_último − NCG_hoje` (superfície de confusão); medição independente do T via `ACF/PCF`; eliminação intercompany no consolidado.

## Modelo de sinais e matriz

`T = CDG − NCG` (identidade). Sinais estritos com banda de materialidade `m`: `sig(x) = + se x > m; − se x < −m; ~0 caso |x| ≤ m`.

| Tipo | CDG | NCG | T | Rótulo | Leitura |
|---|:---:|:---:|:---:|---|---|
| I | + | − | + | Excelente | Fornecedor financia o ciclo e sobra tesouraria |
| II | + | + | + | Sólida | CDG cobre a NCG e sobra folga |
| III | + | + | − | Insatisfatória | CDG positivo, não cobre a NCG → depende de curto prazo |
| IV | − | + | − | Péssima | Efeito tesoura: CDG negativo + NCG positiva |
| V | − | − | − | Muito ruim | NCG− ajuda, mas CDG negativo derruba a tesouraria |
| VI | − | − | + | Alto risco | Vive da folga do ciclo; aperto de fornecedor vira crise |

Combinações `(+,−,−)` e `(−,+,+)` são **impossíveis** por identidade → se ocorrerem (erro de input), status `inconsistente`, não classifica. Qualquer sinal `~0` → status `fronteira` (mostra os números, não crava Tipo).

## Status de cobertura (selo primário)

Derivado de CDG e NCG (não precisa do Tipo):

- **`coberta`** — `NCG > m` e `CDG ≥ NCG` (Gap ≥ 0): giro coberto por capital permanente.
- **`descoberta`** — `NCG > m` e `CDG < NCG` (Gap < 0): parte do giro depende de curto prazo.
- **`operacao_financia_giro`** — `NCG < −m`: fornecedores/ciclo financiam a operação (folga).
- **`fronteira`** — algum componente `~0`.
- **`indisponivel`** — falta input de balanço, ou NCG fora da janela ±7d, ou inconsistência.

## Arquitetura

Padrão do módulo: **helper TS puro (vitest) + tabela `fin_*` com RLS + query no service**. Sem edge nova (é leitura client-side com RLS; a classificação é pura). Sem escrita de sinal money-path em jsonb multi-writer.

### 1. Dados — tabela `fin_balanco_inputs` (migration, money-path)

Dedicada e **versionada por data** (a classificação é as-of; `fin_valor_inputs` é single-row sem histórico, não serve).

```sql
CREATE TABLE public.fin_balanco_inputs (
  company text NOT NULL,
  data_ref date NOT NULL,                         -- data do balancete
  ativo_nao_circulante numeric(15,2) NOT NULL,    -- ANC
  passivo_nao_circulante numeric(15,2) NOT NULL,  -- PNC (exigível LP)
  patrimonio_liquido numeric(15,2) NOT NULL,      -- PL
  observacao text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT fin_balanco_inputs_pkey PRIMARY KEY (company, data_ref),
  CONSTRAINT fin_balanco_inputs_company_check
    CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc']))
);
ALTER TABLE public.fin_balanco_inputs ENABLE ROW LEVEL SECURITY;
-- RLS master-only (mesmo padrão sensível de fin_valor_inputs): SELECT/INSERT/UPDATE
-- só para master. Grant explícito revogado de authenticated/anon; policy por is_master().
```

Writer único: a UI de balanço (§3). CDG derivado, nunca persistido (evita staleness de sinal money-path).

### 2. Helper puro — `src/lib/financeiro/fleuriet-helpers.ts`

```ts
export type SinalFleurietInput = { cdg: number | null; ncg: number | null; materialidade: number };
export type StatusCobertura = 'coberta' | 'descoberta' | 'operacao_financia_giro'
  | 'fronteira' | 'inconsistente' | 'indisponivel';
export type TipoFleuriet = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | null;

export type ClassificacaoFleuriet = {
  status: StatusCobertura;
  tipo: TipoFleuriet;            // null quando fronteira/inconsistente/indisponivel
  rotulo: string | null;        // 'Sólida' etc.
  cdg: number | null;
  ncg: number | null;
  gap: number | null;           // CDG − NCG (o "T" residual; caveat: NCG gerencial)
  cobertura: number | null;     // CDG/NCG quando NCG > m; senão null
  sinais: { cdg: Sinal; ncg: Sinal; t: Sinal };   // Sinal = '+' | '-' | '~0' | null
  motivos: string[];            // degradação honesta
};

export function calcularCDG(i: { anc: number|null; pnc: number|null; pl: number|null }): number | null;
//   null se qualquer componente ausente (ausente ≠ 0). Senão (pl + pnc) − anc.

export function materialidade(i: { receita_liquida_mensal: number | null }): number;
//   max(0.01 * receita, 500). receita ausente → fallback R$ 500 absoluto.

export function classificarFleuriet(i: SinalFleurietInput): ClassificacaoFleuriet;
//   Aplica sinais com banda, resolve status + tipo. Combinação impossível → 'inconsistente'.
//   cdg ou ncg null → 'indisponivel'.
```

### 3. Casamento temporal + serviço

`resolverNcgNaData(company, data_ref, janela_dias = 7)`: busca em `fin_projecao_snapshots` (cenário `realista`) o registro com `snapshot_at::date` mais próximo de `data_ref`; se `|Δdias| > 7` → `{ ncg: null, fora_janela: true }`. Snapshots são append-only diários, então há histórico. Serviço `getBalancoInputs(company)` pega o balanço de maior `data_ref`.

### 4. UI

- **Selo** no topo de `src/pages/FinanceiroCockpit.tsx`, ao lado do `TransparencyBadge`, **por empresa**. Cores dessaturadas (`status-success/warning/error`), tabular-nums. Mostra status + `Cobertura`/`Gap`; tooltip com Tipo de Braga, os 3 componentes, e a **data do balancete + data do NCG casado**. Consolidado como visão secundária (só com as 3 presentes).
- **Input master-only**: dialog/aba de balanço (ANC, PNC, PL, `data_ref`) com **microcopy de classificação** para as armadilhas do Codex (empréstimo de sócio: PL só se capitalizado; parcelamento fiscal: separar CP/LP; ANC só operacional; PL fechado).

## Degradação honesta

| Situação | Resultado |
|---|---|
| Falta ANC/PNC/PL | `indisponivel` + motivo ("balanço não informado") |
| NCG do snapshot fora de ±7d de `data_ref` | `indisponivel` + motivo ("sem NCG na data do balanço") |
| Sinal `~0` (banda) | `fronteira` (mostra números, sem Tipo) |
| Combinação impossível | `inconsistente` (erro de input de balanço) |
| Balanço com `data_ref` antigo (> 6 meses) | classifica, mas **confiança rebaixada** + idade visível |

Nunca fabrica CDG/T/Tipo. `null` propaga.

## Testes (vitest, helper puro)

1. As **6 combinações** de sinais → Tipo I–VI corretos.
2. As **2 impossíveis** → `inconsistente`.
3. **Banda de materialidade**: `CDG`/`NCG`/`T` dentro de `±m` → `fronteira`; `materialidade()` = max(1%·receita, 500); receita null → 500.
4. **Degradação**: `cdg=null` → `indisponivel`; `ncg=null` → `indisponivel`; ANC/PNC/PL ausente em `calcularCDG` → null.
5. **Cobertura/gap**: `gap = cdg − ncg`; `cobertura = cdg/ncg` só com `ncg > m` (senão null); status coberta/descoberta/operacao_financia_giro corretos nas fronteiras.
6. **Casamento temporal** (`resolverNcgNaData`): dentro de ±7d resolve; em 8d → `fora_janela`; empata pelo mais próximo.
7. **Sinal zero exato** e valores negativos reais (não confundir 0 real com ausência).

## Money-path / prove-sql

- Migration de `fin_balanco_inputs` provada em **PG17 local** (skill `prove-sql-money-path`): cria a tabela real, semeia, e prova a **RLS sob `SET ROLE authenticated` + GUC** (master vê/escreve; não-master é negado — falsificar sabotando a policy e exigindo vermelho). Handoff via `lovable-db-operator` (SQL Editor do Lovable; migration custom não auto-aplica).
- Helper puro coberto por vitest antes de fiar na UI (PL/pgSQL não entra aqui — classificação é TS).

## Fora de escopo (v1)

Proxy de pressão diária (`CDG_último − NCG_hoje`); T medido independente via `ACF/PCF`; reconciliação/eliminação intercompany no consolidado; import automático de balancete (hoje é input manual master-only).
