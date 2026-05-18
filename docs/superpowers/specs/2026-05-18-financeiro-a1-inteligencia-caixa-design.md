# Financeiro A1 — Inteligência de Caixa (CFO mode)

**Data:** 2026-05-18
**Status:** Design aprovado (4 seções), pronto pra `writing-plans`
**Escopo:** Sub-tema A1 do Tema A (Inteligência Financeira Corporativa). Sequel direto da Fundação Tier 1.

---

## 1. Contexto e Objetivo

Founder hoje gerencia o fluxo de caixa **manualmente, fora do sistema** ("administro no tempo"). Quer trazer pra dentro com **rigor de livro de finanças corporativas** — fluxo 13 semanas real com cenários, NCG calculada e projetada, alertas pra decisões antecipadas. É a base operacional pra depois evoluir pra WACC/EVA/DuPont (A2/A3 em ciclos próprios).

### Sub-temas adiados (não escopo deste spec)

- **A2** — WACC, ROIC, EVA, spread sobre WACC (ciclo próprio depois de A1 estar rodando 2-4 semanas)
- **A3** — DuPont, Altman Z-score, Beneish M-score, cobertura de juros, métricas de risco (ciclo próprio)

### Premissas adotadas

- 100% interno — usa dados que já vêm do Omie (CR/CP/movimentações/estoque) + eventos cadastrados pelo usuário. Sem integração externa nova.
- Audiência primária: founder. Equipe interna depois (permission model já preparado pela Fundação).
- Sequel da Fundação Tier 1 — reutiliza audit trail genérico, period locking, DRE competência.

---

## 2. Arquitetura

**Padrão híbrido** (consistente com Fundação):

| Peça | Camada | Razão |
|---|---|---|
| Eventos recorrentes + eventuais | Tabelas DB | Persistência, audit, RLS — patterns existentes |
| Snapshot semanal de projeção | Tabela DB + cron | Histórico de trend, comparar realizado vs projetado |
| Cálculo de projeção + NCG + alertas | Edge Function (TS) | Lógica complexa, melhor em código tipado |
| UI de exploração + CRUD eventos | React + shadcn | Padrão do projeto |

**Componentes novos:**

```
supabase/
├── migrations/
│   └── 2026XXXXXXXXXX_financeiro_a1_cashflow.sql
│       ├─ Tabela fin_eventos_recorrentes (+ trigger audit + period lock)
│       ├─ Tabela fin_eventos_eventuais (+ trigger audit + period lock)
│       ├─ Tabela fin_projecao_snapshots (sem trigger period lock — write-only do cron)
│       ├─ Tabela fin_alertas (write/dismiss pelo user)
│       ├─ Tabela fin_config_cashflow (overrides cenário + thresholds por empresa)
│       └─ cron.schedule('fin-cashflow-snapshot-diario', '0 7 * * *', ...)
├── functions/
│   └── fin-cashflow-engine/        (POST: projeta 13s + NCG + alertas)
src/
├── pages/
│   └── FinanceiroCapitalGiro.tsx   (REFATORADA: 4 tabs)
├── components/financeiro/
│   ├── cashflow/
│   │   ├── PosicaoAgora.tsx        (NOVA: tab existente extraída)
│   │   ├── Fluxo13Semanas.tsx      (NOVA: gráfico + tabela + toggle cenário)
│   │   ├── NcgDecomposicao.tsx     (NOVA: ACO/PCO + projeção 12m)
│   │   ├── EventosManager.tsx      (NOVA: CRUD recorrentes + eventuais)
│   │   ├── CenarioToggle.tsx       (NOVA: pill realista/otimista/pessimista)
│   │   └── AlertasStack.tsx        (NOVA: cards de alertas no topo)
├── hooks/
│   ├── useCashflowProjection.ts    (NOVA: invoca edge fn)
│   ├── useEventosRecorrentes.ts    (NOVA: CRUD + lista)
│   ├── useEventosEventuais.ts      (NOVA: CRUD + lista)
│   ├── useCashflowAlertas.ts       (NOVA: ler + dismiss)
│   └── useCashflowConfig.ts        (NOVA: ler/setar thresholds + overrides cenário)
└── lib/financeiro/
    ├── cashflow-format.ts          (helpers: format semana, projetar evento recorrente em datas)
    └── ncg-helpers.ts              (helpers: classificar CR/CP em ACO/PCO)
```

---

## 3. Modelo de Dados

### `fin_eventos_recorrentes`

Eventos que se repetem mensalmente (folha, aluguel se não estiver em CP, pró-labore, dividendo trimestral, etc.).

```sql
CREATE TABLE fin_eventos_recorrentes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  -- Mesma enum de dre_linha usada em fin_categoria_dre_mapping (text, sem FK)
  categoria_dre   text CHECK (categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  -- Flag específica pra PCO computar "folha próx 30d" sem ambiguidade
  is_folha        boolean NOT NULL DEFAULT false,
  dia_do_mes      integer NOT NULL CHECK (dia_do_mes BETWEEN 1 AND 31),
  inicio          date NOT NULL,                         -- primeira ocorrência
  fim             date,                                  -- NULL = indefinido
  ativo           boolean NOT NULL DEFAULT true,
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON fin_eventos_recorrentes (company, ativo);
CREATE INDEX ON fin_eventos_recorrentes (categoria_dre);
```

> Edge cases: dia 31 em fevereiro vira último dia do mês (helper de expansão garante).

### `fin_eventos_eventuais`

Pontuais (compra de máquina, aporte, empréstimo a contratar, etc.).

```sql
CREATE TABLE fin_eventos_eventuais (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria_dre   text CHECK (categoria_dre IS NULL OR categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  data_prevista   date NOT NULL,
  data_realizada  date,
  status          text NOT NULL CHECK (status IN ('previsto','confirmado','cancelado','realizado'))
                  DEFAULT 'previsto',
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON fin_eventos_eventuais (company, data_prevista);
CREATE INDEX ON fin_eventos_eventuais (status, company);
```

### `fin_projecao_snapshots`

Snapshot semanal pra histórico (comparar realizado vs projetado, trend).

```sql
CREATE TABLE fin_projecao_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL,
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  cenario         text NOT NULL CHECK (cenario IN ('realista','otimista','pessimista')),
  horizon_weeks   integer NOT NULL DEFAULT 13,
  dados           jsonb NOT NULL,        -- array semana → {entradas, saidas, saldo_inicial, saldo_final}
  ncg             numeric(15,2),
  capital_giro_proprio numeric(15,2),
  saldo_tesouraria numeric(15,2),
  dias_cobertura  numeric(10,2),
  premissas       jsonb NOT NULL         -- {atraso_medio_pct, inadimplencia_pct, overrides}
);

CREATE INDEX ON fin_projecao_snapshots (company, snapshot_at DESC);
CREATE INDEX ON fin_projecao_snapshots (cenario, snapshot_at DESC);
```

### `fin_alertas`

Avaliados a cada cálculo da engine. Persistidos pra histórico + dismiss por usuário.

```sql
CREATE TABLE fin_alertas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL,
  tipo            text NOT NULL,         -- 'caixa_negativo', 'ncg_deficit', 'cobertura_baixa', etc.
  severidade      text NOT NULL CHECK (severidade IN ('info','aviso','critico')),
  mensagem        text NOT NULL,
  valor           numeric(15,2),         -- valor que disparou (opcional)
  threshold       numeric(15,2),         -- threshold vigente (opcional)
  contexto        jsonb,                 -- dados extras pro drilldown
  criado_em       timestamptz NOT NULL DEFAULT now(),
  dismissed_at    timestamptz,
  dismissed_by    uuid REFERENCES auth.users(id),
  dismissed_until timestamptz            -- snooze
);

CREATE INDEX ON fin_alertas (company, criado_em DESC) WHERE dismissed_at IS NULL;
CREATE UNIQUE INDEX ON fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
-- garante 1 alerta ativo por tipo+empresa (evita spam diário)
```

### `fin_config_cashflow`

Overrides de cenário e thresholds de alerta por empresa.

```sql
CREATE TABLE fin_config_cashflow (
  company         text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  overrides_cenario jsonb NOT NULL DEFAULT '{
    "otimista":   {"recebimento_no_prazo_pct_delta": 10, "inadimplencia_pct_delta": -50},
    "pessimista": {"recebimento_no_prazo_pct_delta": -15, "inadimplencia_pct_delta": 50}
  }'::jsonb,
  thresholds      jsonb NOT NULL DEFAULT '{
    "caixa_negativo_semanas": 4,
    "ncg_deficit_alerta": 0,
    "dias_cobertura_min": 30,
    "inadimplencia_max_pct": 10,
    "concentracao_top1_max_pct": 20,
    "pmr_crescimento_max_pct_90d": 15
  }'::jsonb,
  -- Códigos de categoria Omie que representam adiantamentos a fornecedores (ACO)
  adiantamento_categorias_codigos text[] NOT NULL DEFAULT '{}'::text[],
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id)
);
```

### Integração com Fundação

- Trigger `fin_audit_trigger` (Fundação Phase 1) anexado em `fin_eventos_recorrentes`, `fin_eventos_eventuais`, `fin_alertas`, `fin_config_cashflow`. Drawer "Histórico" deve ser plugado nas linhas dessas tabelas.
- Trigger `fin_period_lock_trigger` (Fundação Phase 2) anexado em `fin_eventos_recorrentes` e `fin_eventos_eventuais` (data-chave: `inicio`/`data_prevista`). Override emergência funciona normalmente.

---

## 4. Engine de Cálculo (`fin-cashflow-engine`)

Edge Function chamada via UI (on-demand) ou cron diário (snapshot automático).

### Contrato

```typescript
// POST /functions/v1/fin-cashflow-engine
// Auth: authorizeCronOrStaff (compartilhado)

INPUT:
{
  company: 'oben' | 'colacor' | 'colacor_sc',
  cenario?: 'realista' | 'otimista' | 'pessimista',  // default 'realista'
  horizon_weeks?: number,                              // default 13
  save_snapshot?: boolean,                             // default false
}

OUTPUT:
{
  semanas: [{
    inicio: '2026-05-19', fim: '2026-05-25',
    saldo_inicial: 12000.00,
    entradas: [
      { origem: 'cr_omie', desc: '...', data: '...', valor: 5000 },
      { origem: 'evento_recorrente', desc: 'Recebimento médio mensal', data: '...', valor: 0 },
      { origem: 'evento_eventual', desc: 'Aporte sócio', data: '...', valor: 50000 }
    ],
    saidas: [...],
    saldo_final: 67000.00
  }, ...],
  ncg: {
    aco: { cr_aberto: ..., estoque: ..., adiantamentos: ..., total: ... },
    pco: { cp_fornecedor: ..., folha_30d: ..., tributos_a_pagar: ..., total: ... },
    valor: 120000.00,
    projecao_12m: [{ mes: '2026-06', valor: ... }, ...]
  },
  indicadores: {
    dias_cobertura: 47.5,
    capital_giro_proprio: 380000.00,
    saldo_tesouraria: 25000.00,
    inadimplencia_pct: 3.2,
    concentracao_top5_clientes: [{ cliente: 'XYZ', pct: 18 }, ...],
    prazo_medio_recebimento: 42.5,
    prazo_medio_pagamento: 51.0,
    cash_conversion_cycle: 38.0  // PMR + dias_estoque - PMP
  },
  alertas: [{ tipo, severidade, mensagem, valor, threshold, contexto }],
  premissas_aplicadas: {
    atraso_medio_pct: 8.5,
    inadimplencia_observada_pct: 3.2,
    overrides_cenario: {...}
  }
}
```

### Pipeline interno

```
1. Carregar CR aberto + CP aberto + saldo CC atual + estoque + categorias mapeadas
2. Expandir eventos recorrentes ativos nas próximas N semanas
   - Pra cada mês na janela, gerar instância no dia_do_mes (clamp pra último dia se inválido)
3. Carregar eventos eventuais previstos/confirmados na janela
4. Calcular taxa histórica (últimos 12m):
   - atraso_medio = média de (data_recebimento - data_vencimento) em dias, pra títulos pagos
   - inadimplencia_observada = SUM(saldo vencido > 30d) / SUM(faturamento_12m)
5. Aplicar cenário:
   - realista: usa taxas observadas direto
   - otimista: aplica deltas de fin_config_cashflow.overrides_cenario.otimista
   - pessimista: idem
6. Para cada semana na janela:
   a. Entradas = CR vencendo nessa semana * (1 - inadimplencia) + recorrentes(entrada) + eventuais(entrada)
   b. Saídas = CP vencendo + recorrentes(saida) + eventuais(saida)
   c. saldo_final = saldo_inicial + entradas - saidas
   d. saldo_inicial da próxima = saldo_final desta
7. NCG:
   - ACO = SUM(CR aberto) + SUM(estoque valor) + adiantamentos (CP categoria mapeada como 'adiantamento' em fin_config_cashflow.adiantamento_categorias_codigos)
   - PCO = SUM(CP aberto fornecedor exceto adiantamentos) + folha próx 30d (eventos recorrentes ativos com is_folha=true, somando 1 ocorrência por mês) + tributos a pagar (CP categoria_dre='impostos')
   - valor = ACO - PCO
   - projecao_12m: aplica taxa de crescimento observada de receita (do DRE competência) nos componentes proporcionais
8. Indicadores derivados (PMR, PMP, concentração, etc.)
9. Avaliar alertas vs thresholds
10. Se save_snapshot: insert em fin_projecao_snapshots
11. Atualizar fin_alertas (insert novos, manter dismissed se persistirem)
```

### Cenários (decisão histórico + manual)

| Cenário | Premissa de recebimento | Premissa de inadimplência |
|---|---|---|
| **Realista** | Taxa histórica direta (últimos 12m) | Inadimplência observada |
| **Otimista** | Realista × (1 + delta_otimista) — default +10% | Realista × (1 + delta_otimista) — default -50% |
| **Pessimista** | Realista × (1 + delta_pessimista) — default -15% | Realista × (1 + delta_pessimista) — default +50% |

Deltas configuráveis por empresa em `fin_config_cashflow.overrides_cenario`. Founder edita via UI (tab Configuração).

### Cron diário

`fin-cashflow-snapshot-diario` às 7h. Pra cada empresa × cada cenário → grava 1 snapshot. Permite gráfico de trend ("projeção mudou nas últimas 4 semanas?").

---

## 5. Alertas (default thresholds)

| Tipo | Threshold default | Severidade | Mensagem template |
|---|---|---|---|
| `caixa_negativo` | Projeção em até 4 semanas | crítico | "Caixa fica negativo em DD/MM (semana N): -R$X" |
| `ncg_deficit` | NCG > Capital Giro Próprio | aviso | "NCG R$X excede CGP R$Y em R$Z. Risco de liquidez." |
| `cobertura_baixa` | Dias cobertura < 30 | aviso | "Caixa cobre só N dias de operação (mín: 30)" |
| `inadimplencia_alta` | > 10% sobre CR vencido | aviso | "Inadimplência X% acima do limite de 10%" |
| `concentracao_top1` | 1 cliente > 20% CR aberto | informativo | "Cliente XYZ representa X% do CR aberto" |
| `pmr_subindo` | PMR cresceu > 15% em 90d | aviso | "PMR subiu de X pra Y dias nos últimos 90d" |
| `saida_spike` | Próx semana saída > entrada × 2 | informativo | "Próxima semana: saídas R$X vs entradas R$Y" |

Cada alerta dispensável (snooze 7d / dismiss permanente). Constraint UNIQUE em `(company, tipo) WHERE dismissed_at IS NULL` evita duplicação diária pelo cron.

UI: card stack no topo da tab "Fluxo 13s" + badge contagem na sidebar.

---

## 6. UI — Refatoração de `FinanceiroCapitalGiro`

Página existente vira hub com **4 tabs**:

### Tab 1 — Posição agora (preserva o atual)

Reusa todo o conteúdo atual da `FinanceiroCapitalGiro.tsx`:
- Cards de saldo bancário, CR aberto, CP aberto, Capital de Giro líquido
- Aging de recebíveis/pagáveis
- Concentração top inadimplentes

### Tab 2 — Fluxo 13 Semanas (nova)

- `<CenarioToggle />` no header (Realista/Otimista/Pessimista)
- `<AlertasStack />` no topo (cards de alertas ativos)
- Gráfico de barras semanal (entradas verde, saídas vermelho) + linha de saldo acumulado
- Tabela detalhada semana a semana (expand pra ver origens de cada entrada/saída — drilldown CR/CP/evento)
- Footer: comparativo com snapshot da semana anterior ("projeção melhorou R$X")

### Tab 3 — NCG (nova)

- Decomposição visual ACO vs PCO (waterfall ou stacked bar)
- NCG atual + projetada 12m (linha)
- Comparação NCG × Capital de Giro Próprio (gap = déficit/surplus)
- Cash Conversion Cycle (CCC) com decomposição PMR/Estoque/PMP
- Sensitivity panel ("se PMR aumentar 10 dias, NCG vira R$X")

### Tab 4 — Eventos (nova)

- 2 sub-seções: Recorrentes + Eventuais
- CRUD inline (tabela editável estilo `FinanceiroOrcamento`)
- Recorrentes: descrição, valor, tipo, dia do mês, início, fim, ativo
- Eventuais: descrição, valor, tipo, data prevista, status (badge), data realizada
- Botão "Histórico" por linha (audit drawer da Fundação)
- Filtros: por empresa, por tipo (entrada/saída), por status

### Tab 5 (oculta) — Configuração

Acessível só via gear icon no header da página. Master only.

- Edita thresholds de alertas (form com sliders + número)
- Edita deltas de cenário (otimista/pessimista percentuais)
- Categoria DRE pra "adiantamentos a fornecedores" (mapping pra cálculo ACO)
- Categoria DRE pra "tributos a pagar" (mapping pra cálculo PCO)

---

## 7. Hooks (frontend)

| Hook | Responsabilidade |
|---|---|
| `useCashflowProjection(company, cenario, horizonWeeks)` | Invoca `fin-cashflow-engine`, retorna semanas + ncg + indicadores + alertas. Refetch ao trocar cenário ou empresa. |
| `useEventosRecorrentes(company)` | CRUD + lista de recorrentes ativos |
| `useEventosEventuais(company, periodo)` | CRUD + lista filtrada por período |
| `useCashflowAlertas(company)` | Lista alertas ativos + dismiss/snooze mutation |
| `useCashflowConfig(company)` | Ler/setar thresholds + overrides cenário (master only) |

Padrão: React Query com queryKey hierárquica. `useCashflowProjection` invalida ao mutar eventos.

---

## 8. Permissionamento

| Ação | Quem pode |
|---|---|
| Ver projeção, NCG, alertas | `isStaff` |
| Criar/editar/deletar eventos recorrentes e eventuais | `isStaff` |
| Dispensar alerta | `isStaff` |
| Editar `fin_config_cashflow` (thresholds + cenários) | `isMaster` |
| Reabrir período fechado pra editar evento retroativo | `isMaster` (via override emergência da Fundação) |

---

## 9. Testes

**DB:**
- Smoke SQL pra triggers attach (audit + period lock) em `fin_eventos_*`
- Validar UNIQUE de `fin_alertas` impede duplicação

**Edge function:**
- Teste isolado de `expandirRecorrentes(evento, janela)` — clamp dia 31 → 28/30
- Teste de aplicação de cenário — realista vs otimista vs pessimista produzem números diferentes
- Teste de cálculo NCG com dados sintéticos
- Teste de geração de alertas baseado em thresholds

**Frontend (vitest):**
- `useCashflowProjection` — query + refetch ao trocar cenário
- `cashflow-format.ts` — helpers de formatação de semana, BRL, etc.
- `ncg-helpers.ts` — classificação CR/CP em ACO/PCO

---

## 10. Migração de Dados / Pré-requisitos

**Pré-requisitos** (Fundação Tier 1 deve estar deployada):
- Migrations da Fundação aplicadas (audit log, period lock, DRE regime)
- Edge functions da Fundação deployadas

**One-time setup** pós-deploy A1:
- Founder cadastra eventos recorrentes existentes (folha, aluguel, pró-labore, etc.) via tab Eventos
- Founder revisa thresholds default em /financeiro/capital-giro → Configuração
- Cron `fin-cashflow-snapshot-diario` agendado via SQL Editor

---

## 11. Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Taxa histórica de atraso/inadimplência vira biased se base de dados pequena | Validar mínimo de 30 títulos pra taxa ser usada; abaixo disso, fallback pra default conservador + alerta "amostra pequena" |
| Estoque sem valoração (ou desatualizada) infla ACO falsamente | Ler de tabela de estoque com `valor_total` consistente; alerta na UI se valor for 0 ou stale |
| Eventos recorrentes esquecidos pelo user (folha não cadastrada) → projeção otimista demais | Onboarding wizard sugere eventos comuns (folha, aluguel, impostos) na primeira visita. Card "Adicione eventos típicos" enquanto count < 5. |
| Alerta spam diário irritante | UNIQUE constraint em alertas ativos + snooze 7d default. Cron agrupa: dispara mesmo tipo só se valor cresceu >10% desde último |
| Performance: engine pode demorar com 12 meses de histórico × 3 cenários × 3 empresas | Cron salva snapshots em background. UI lê snapshot mais recente; on-demand só pra "recalcular agora". Engine usa índices em fin_contas_*.data_emissao. |
| NCG calculada estoura quando categoria "Adiantamentos" não está mapeada | Tab Configuração obriga mapeamento (ou default explícito = 0). Banner alerta enquanto não mapeado. |

---

## 12. Não-Escopo (deliberadamente fora)

- **A2** (WACC, ROIC, EVA, spread) — entra próximo ciclo após A1 estar rodando 2-4 semanas
- **A3** (DuPont, Z-score, M-score, cobertura juros) — ciclo próprio
- **Integração banco real** (Pluggy/Belvo direto) — Tier 2 separado
- **Boleto/cobrança** — Tier 2 separado (Tema C)
- **Margem por SKU/cliente/vendedor** — Tema B, próximo após A
- **Tributário audit** — Tema D, baixa prioridade
- **Notificações por email/Slack** — entra quando tiver equipe interna
- **Mobile-first UI** — desktop-first (cockpit analítico, persona = founder/CFO)
- **API pública pra exportar projeção** — fora de escopo
- **Multi-currency / hedge** — fora de escopo

---

## 13. Plano de Entrega (preview)

Detalhamento em `writing-plans` próxima fase. Visão geral em fatias:

1. **Schema base + audit/lock attach** — migrations das 5 tabelas + triggers
2. **Engine de cálculo** — edge function com pipeline completo
3. **Tab Eventos** (recorrentes + eventuais CRUD) — primeiro UI value
4. **Tab Fluxo 13s** — gráfico + tabela + cenário toggle + alertas
5. **Tab NCG** — decomposição + projeção + sensitivity
6. **Tab Configuração** — thresholds + overrides cenário (master)
7. **Cron snapshot diário + onboarding wizard de eventos comuns**
8. **Docs FINANCEIRO_CONFIABILIDADE.md atualizada**

Cada fatia = 1 PR (mesmo padrão da Fundação).

---

## 14. Definição de Pronto

- Todas as 5 tabelas criadas com triggers de audit e period lock anexados
- Edge function `fin-cashflow-engine` cobrindo pipeline completo + testes
- UI refatorada com as 4 tabs visíveis + tab oculta de Config
- Founder consegue:
  - Ver fluxo 13 semanas projetado em 3 cenários, alternando ao vivo
  - Adicionar evento recorrente (folha) e vê impacto na projeção em <2s
  - Adicionar evento eventual (aporte futuro) e vê semana específica mudar
  - Ver NCG decomposta em ACO/PCO + projeção 12m + comparação com Capital Giro Próprio
  - Receber alerta quando caixa projetado negativo, NCG vira deficitária, etc.
  - Dispensar alertas (snooze 7d) e voltar a vê-los depois
  - Master ajusta thresholds e deltas de cenário sem mexer em código
- Cron diário rodando, gerando snapshot histórico
- Doc `FINANCEIRO_CONFIABILIDADE.md` atualizada — Fluxo 13s + NCG migrados de "❌ Não implementado" pra "✅ MVP operacional"
- `bun lint && bun build && bun test` verdes
