# Financeiro — Fundação para Controle "Ponta do Lápis"

**Data:** 2026-05-17
**Status:** Design aprovado, pronto pra `writing-plans`
**Escopo:** Tier 1 da auditoria de gaps do módulo Financeiro (5 itens fundacionais, 100% internos)

---

## 1. Contexto e Objetivo

O módulo Financeiro do Afiação hoje espelha bem o Omie em coisas planas (saldos, CR, CP, aging), mas tem buracos que impedem o founder de confiar nos números agregados — DRE pode estar errada por heurística de classificação, lançamento retroativo em período fechado corrompe relatórios silenciosamente, intercompany é eliminado de forma genérica sem reconciliação real, e não há rastro de quem mudou o quê.

Este spec cobre as **5 fundações internas** que destravam a confiança dos números antes de qualquer integração externa (banco real, SPED, boleto, adquirente).

### Audiência

- **Agora:** founder (single user — você)
- **Futuro:** equipe interna (gestores, futuros controller/CFO) — design preparado, não implementado nesta entrega

### Premissas adotadas

- Não há intenção (agora) de alimentar SPED/ECD/ECF nem fiscalização externa direta — DRE competência é "para você confiar no número", não "para entregar à RFB"
- Permission model será simples (`master` pode override e aprovar; `employee` opera; já existente no `AuthContext`)
- Não há integração externa nova nesta entrega — tudo opera sobre dados já sincronizados do Omie

---

## 2. Arquitetura

**Padrão híbrido**: cada peça vai pra camada onde faz mais sentido.

| Peça | Camada | Razão |
|---|---|---|
| Audit trail | Trigger DB | Tamper-evident, não burlável via service_role do app |
| Travamento de período | Trigger DB | Garantia rígida, não pode ser contornada |
| Gate de categoria não-mapeada | Trigger DB | Garantia rígida no momento de aprovar fechamento |
| DRE competência | Edge Function (TS) | Lógica complexa, melhor em código tipado |
| IC reconciliação | Edge Function (TS) + Cron | Matching probabilístico, evolui com regras novas |

**Componentes novos:**

```
supabase/
├── migrations/
│   └── 2026XXXXXXXXXX_financeiro_fundacao.sql
│       ├─ Tabela fin_audit_log
│       ├─ Tabela fin_period_overrides
│       ├─ Tabela fin_ic_matches
│       ├─ Função fin_audit_trigger() + 6 triggers
│       ├─ Função fin_period_lock_trigger() + 5 triggers
│       ├─ Função fin_check_mapping_complete_trigger() + 1 trigger
│       ├─ ALTER fin_dre_snapshots: unique (empresa_id, periodo, regime)
│       ├─ ALTER fin_fechamentos: ADD dre_snapshot_caixa_id, dre_snapshot_competencia_id (FK)
│       └─ cron.schedule('fin-ic-reconcile-diario', '0 6 * * *', ...)
├── functions/
│   ├── fin-period-override/        (POST: abre janela 15min)
│   ├── fin-ic-reconcile/           (cron diário + endpoint sob demanda)
│   ├── fin-suggest-mapping/        (GET: retorna sugestões)
│   └── omie-financeiro/            (modificada: branch novo de competência)

src/
├── pages/
│   ├── FinanceiroCockpit.tsx       (modificada: toggle de regime)
│   ├── FinanceiroDashboard.tsx     (modificada: toggle de regime)
│   ├── FinanceiroFechamento.tsx    (modificada: tratamento de erros do gate)
│   ├── FinanceiroMapping.tsx       (modificada: banner + sugestões)
│   ├── FinanceiroIntercompany.tsx  (modificada: link pra fila)
│   └── FinanceiroIntercompanyFila.tsx  (NOVA: fila de divergências)
├── components/financeiro/
│   ├── AuditTrailDrawer.tsx        (NOVO: timeline de mudanças por row)
│   ├── PeriodOverrideModal.tsx     (NOVO: justificativa de override)
│   ├── PeriodOverrideHistory.tsx   (NOVO: log visível no cockpit)
│   └── RegimeToggle.tsx            (NOVO: pill caixa/competência)
├── hooks/
│   ├── useAuditTrail.ts            (NOVO)
│   ├── usePeriodOverride.ts        (NOVO)
│   ├── useIcReconciliation.ts      (NOVO)
│   └── useFinanceiroRegime.ts      (NOVO: state global do toggle)
└── lib/financeiro/
    ├── audit.ts                    (NOVO: helpers de formatação de diff)
    └── error-handler.ts            (NOVO: parser de P0001/P0002 + dispatch de modais)
```

---

## 3. Design por Peça

### 3.1 Audit Trail Genérico

**Por quê:** sem rastro de mudança, nenhum número agregado é defensável. Hoje você vê "valor mudou de R$100 para R$150" sem saber quem/quando/por quê.

**Schema:**

```sql
CREATE TABLE fin_audit_log (
  id          bigserial PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      text NOT NULL,                    -- coerced to text pra suportar uuid/int/composite
  op          text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  changed_fields jsonb NOT NULL,                -- { campo: { before, after } } apenas dos modificados
  changed_by  uuid REFERENCES auth.users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  empresa_id  text,                             -- coluna populada pelo trigger se a tabela tiver
  origem      text NOT NULL DEFAULT 'manual',   -- manual|omie_sync|edge_fn|override_emergencia|cron
  period_ref  date,                             -- data-chave do lançamento, pra index por período
  override_justificativa text                   -- preenchido quando origem='override_emergencia'
);

CREATE INDEX ON fin_audit_log (table_name, row_id, changed_at DESC);
CREATE INDEX ON fin_audit_log (empresa_id, period_ref, changed_at DESC);
CREATE INDEX ON fin_audit_log (changed_by, changed_at DESC);
-- Partitioning by month deferred until volume justifies it
```

**Trigger genérico:**

```sql
CREATE OR REPLACE FUNCTION fin_audit_trigger() RETURNS trigger AS $$
DECLARE
  v_changed jsonb := '{}';
  v_origem text := COALESCE(current_setting('fin.origem', true), 'manual');
  v_justif text := current_setting('fin.override_justificativa', true);
  v_period date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- monta diff apenas dos campos que mudaram
    SELECT jsonb_object_agg(key, jsonb_build_object('before', o.value, 'after', n.value))
    INTO v_changed
    FROM jsonb_each(to_jsonb(OLD)) o
    JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
    WHERE o.value IS DISTINCT FROM n.value;
  ELSIF TG_OP = 'INSERT' THEN
    v_changed := to_jsonb(NEW);
  ELSE  -- DELETE
    v_changed := to_jsonb(OLD);
  END IF;

  -- period_ref vem de campo padronizado por tabela (deriva no trigger via TG_TABLE_NAME)
  v_period := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber' THEN COALESCE(NEW.data_emissao, OLD.data_emissao)
    WHEN 'fin_contas_pagar' THEN COALESCE(NEW.data_emissao, OLD.data_emissao)
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento' THEN COALESCE(NEW.competencia, OLD.competencia)
    WHEN 'fin_fechamentos' THEN COALESCE(NEW.periodo, OLD.periodo)
    WHEN 'fin_eliminacoes_intercompany' THEN current_date
    ELSE current_date
  END;

  INSERT INTO fin_audit_log(
    table_name, row_id, op, changed_fields,
    changed_by, empresa_id, origem, period_ref, override_justificativa
  ) VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id::text, OLD.id::text),
    TG_OP,
    v_changed,
    auth.uid(),
    COALESCE(NEW.empresa_id::text, OLD.empresa_id::text),
    v_origem,
    v_period,
    v_justif
  );

  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql SECURITY DEFINER;
```

Trigger aplicado em: `fin_contas_receber`, `fin_contas_pagar`, `fin_categoria_dre_mapping`, `fin_orcamento`, `fin_fechamentos`, `fin_eliminacoes_intercompany`.

**Origem por contexto:**
- Mutação via UI sem override → `manual` (default)
- Edge function `omie-financeiro` syncando do Omie → `SET LOCAL fin.origem = 'omie_sync'`
- Outras edge functions → `SET LOCAL fin.origem = 'edge_fn:nome'`
- Sessão de override de período → `SET LOCAL fin.origem = 'override_emergencia'; SET LOCAL fin.override_justificativa = '<texto>'`

**RLS na `fin_audit_log`:** SELECT permitido pra `isStaff` (alinhado com módulo financeiro); INSERT/UPDATE/DELETE proibidos (só o trigger escreve, via SECURITY DEFINER).

**UI:**
- `AuditTrailDrawer.tsx` — botão "Histórico" em CR/CP/categoria/orçamento/fechamento → drawer lateral com timeline (estilo Linear)
- Cada entrada: timestamp + autor + origem (badge colorido) + diff visual (campo, valor antes → depois)
- Filtros: por campo, por período, por origem
- Hook `useAuditTrail({ table, rowId })` faz query paginada

---

### 3.2 Travamento de Período Fechado

**Por quê:** o workflow de fechamento já existe ([FinanceiroFechamento.tsx](../../src/pages/FinanceiroFechamento.tsx)), mas nenhum trigger impede edits retroativos. Lançamento perdido em mês fechado corrompe o DRE.

**Schema novo:**

```sql
CREATE TABLE fin_period_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    text NOT NULL,
  periodo       date NOT NULL,                    -- mês de competência alvo
  opened_by     uuid NOT NULL REFERENCES auth.users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,             -- opened_at + 15 min
  justificativa text NOT NULL,
  acao_planejada text NOT NULL,
  closed_at     timestamptz,
  closed_by     uuid REFERENCES auth.users(id)
);

CREATE INDEX ON fin_period_overrides (empresa_id, periodo, expires_at);
```

**Trigger de bloqueio:**

```sql
CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger AS $$
DECLARE
  v_target_date date;
  v_target_empresa text;
  v_last_closed date;
  v_has_override boolean;
BEGIN
  v_target_empresa := COALESCE(NEW.empresa_id, OLD.empresa_id)::text;
  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber' THEN COALESCE(NEW.data_emissao, OLD.data_emissao)
    WHEN 'fin_contas_pagar' THEN COALESCE(NEW.data_emissao, OLD.data_emissao)
    WHEN 'fin_movimentacoes' THEN COALESCE(NEW.data_movimentacao, OLD.data_movimentacao)
    WHEN 'fin_categoria_dre_mapping' THEN current_date  -- mapping novo afeta períodos futuros, ok
    WHEN 'fin_orcamento' THEN COALESCE(NEW.competencia, OLD.competencia)
  END;

  -- mapping novo (INSERT) não trava nada
  IF TG_TABLE_NAME = 'fin_categoria_dre_mapping' AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT MAX(periodo) INTO v_last_closed
  FROM fin_fechamentos
  WHERE empresa_id = v_target_empresa AND status = 'aprovado';

  IF v_last_closed IS NULL OR v_target_date > v_last_closed THEN
    RETURN COALESCE(NEW, OLD);  -- período não fechado, libera
  END IF;

  -- período fechado → checa override ativo
  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
    WHERE empresa_id = v_target_empresa
      AND periodo = date_trunc('month', v_target_date)
      AND expires_at > now()
      AND closed_at IS NULL
      AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período % da empresa % está fechado em %. Use override de emergência.',
    to_char(v_target_date, 'MM/YYYY'), v_target_empresa, v_last_closed
    USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql SECURITY DEFINER;
```

Trigger aplicado em: `fin_contas_receber`, `fin_contas_pagar`, `fin_movimentacoes`, `fin_categoria_dre_mapping` (só UPDATE/DELETE), `fin_orcamento`.

**Edge function `fin-period-override`:**

```ts
// POST { empresa_id, periodo (YYYY-MM-01), justificativa, acao_planejada }
// Verifica role master via authorizeStaff (existente)
// Insere em fin_period_overrides com expires_at = now() + interval '15 min'
// Retorna { override_id, expires_at }
// Frontend usa override_id no header de chamadas subsequentes,
// edge function ativa SET LOCAL fin.origem = 'override_emergencia'
// + SET LOCAL fin.override_justificativa = '<texto>' no contexto da sessão
```

**UI:**
- Tentativa de salvar edit em período fechado → erro Postgres `P0001` capturado em `lib/financeiro/error-handler.ts` → toast vermelho + botão "Abrir Override de Emergência"
- `PeriodOverrideModal.tsx` — modal de master (gate por `useAuth().isMaster`) pedindo justificativa + ação planejada
- Após confirmação: timer regressivo no header (15 min) + badge "Override ativo: <empresa> <período>"
- `PeriodOverrideHistory.tsx` no cockpit — drawer com todos overrides recentes (quem, quando, por quê, o que mexeu)

**Observação:** o trigger não trata o sync do Omie de forma especial. Se o Omie tentar atualizar uma CR antiga, a sync falha e fica visível em `fin_sync_log` (que já existe). Tratamento: sync pode opcionalmente abrir override automático (decisão futura — por enquanto, falha visível é OK).

---

### 3.3 DRE por Competência

**Por quê:** a coluna `regime` já existe em `fin_dre_snapshots` mas nunca é populada. Sem competência, "faturamento" e "recebimento" se confundem e qualquer análise séria fica enviesada.

**Schema:** sem mudança estrutural. Passa a usar `regime IN ('caixa', 'competencia')` com unique constraint em `(empresa_id, periodo, regime)`.

**Edge function `omie-financeiro` ganha branch novo:**

```ts
// Branch existente: calcular_dre → calcular_dre_caixa (agrupa por data_pagamento/data_recebimento)
// Branch novo: calcular_dre_competencia → agrupa por data_emissao
//
// Ambos compartilham:
// - mesmo mapeamento categoria→DRE via fin_categoria_dre_mapping
// - mesma heurística de fallback (que vai ser substituída pelo gate da seção 3.5)
// - mesma estrutura de output
//
// Diferenças:
// - GROUP BY data_emissao (competência) vs data_pagamento/recebimento (caixa)
// - Snapshot grava com regime correspondente
//
// Trigger de cálculo: rota 'calcular_dre' chama ambos sequencialmente e grava 2 snapshots
```

**`financeiroV2Service.ts::fecharPeriodo()`** modifica:
- Antes: chama `triggerFinanceiroSync('calcular_dre', ...)` (assíncrono)
- Depois: chama e **aguarda** os 2 cálculos, grava ambos snapshots no `fin_fechamentos.dre_snapshot_caixa_id` e `dre_snapshot_competencia_id` (novas colunas FK)

**Fluxo de Caixa permanece intocado** (sempre caixa). Faz sentido — fluxo de caixa por competência seria absurdo.

**UI:**
- `RegimeToggle.tsx` — pill `[ Caixa | Competência ]` no header do `FinanceiroCockpit` e `FinanceiroDashboard`
- Default: **Competência** (estabelece padrão de controller)
- Persiste em localStorage (`financeiroRegime`)
- Hook `useFinanceiroRegime()` expõe `{ regime, setRegime }` (Zustand ou context simples)
- Labels contextuais mudam: "Faturamento" (comp.) vs "Recebimentos" (caixa), "Despesas Incorridas" vs "Pagamentos"
- Badge "Regime: Competência" / "Regime: Caixa" visível em todos os cards de DRE pra evitar confusão

---

### 3.4 Reconciliação Intercompany Cruzada

**Por quê:** [FinanceiroIntercompany.tsx](../../src/pages/FinanceiroIntercompany.tsx) hoje aplica eliminação genérica via RPC. Não valida que A registrou venda de R$100 e B registrou compra de R$100. Pode ter divergência silenciosa de 5% no consolidado.

**Schema novo:**

```sql
CREATE TABLE fin_ic_matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem    text NOT NULL,
  empresa_destino   text NOT NULL,
  cr_id             text REFERENCES fin_contas_receber(id),
  cp_id             text REFERENCES fin_contas_pagar(id),
  valor_origem      numeric(14,2),
  valor_destino     numeric(14,2),
  diff_valor        numeric(14,2) GENERATED ALWAYS AS (COALESCE(valor_origem, 0) - COALESCE(valor_destino, 0)) STORED,
  diff_dias         integer,
  status            text NOT NULL CHECK (status IN (
    'auto_matched', 'manual_matched',
    'divergencia_valor', 'divergencia_data',
    'sem_contrapartida', 'duplicidade_possivel',
    'desconsiderado'
  )),
  matched_at        timestamptz DEFAULT now(),
  resolvido_por     uuid REFERENCES auth.users(id),
  resolvido_em      timestamptz,
  observacao        text
);

CREATE INDEX ON fin_ic_matches (status, matched_at DESC);
CREATE INDEX ON fin_ic_matches (cr_id);
CREATE INDEX ON fin_ic_matches (cp_id);
CREATE UNIQUE INDEX ON fin_ic_matches (cr_id) WHERE cr_id IS NOT NULL;
CREATE UNIQUE INDEX ON fin_ic_matches (cp_id) WHERE cp_id IS NOT NULL;
```

**Edge function `fin-ic-reconcile`:**

Modos: `cron` (diário às 6h via `pg_cron`, extensão já habilitada no projeto — ver `20260221210049...sql`) e `on_demand` (chamado pela UI ou pelo botão "Recalcular" na fila).

Algoritmo:
1. Carrega CNPJs das 3 empresas do `CompanyContext` (config server-side)
2. Pra cada empresa A, lista CR onde `cliente_cnpj` ∈ CNPJs das outras 2
3. Pra cada empresa B, lista CP onde `fornecedor_cnpj` ∈ CNPJs das outras 2
4. Pra cada CR de A, busca CP de B (a empresa correspondente) com:
   - mesmo CNPJ contrapartida
   - `|valor_origem - valor_destino| <= 0.01`
   - `|data_emissao_cr - data_emissao_cp| <= 5 dias`
5. Resultado do match:
   - 1 candidato exato → `auto_matched`
   - 1 candidato com diff de valor < 5% mas > 0.01 → `divergencia_valor`
   - 1 candidato com diff de dias 6-30 → `divergencia_data`
   - 0 candidatos → `sem_contrapartida`
   - 2+ candidatos → `duplicidade_possivel`
6. Upsert em `fin_ic_matches` (idempotente — re-rodar não duplica)

**RPC `fin_consolidado_intercompany` refatorada:**

```sql
-- antes: eliminação genérica baseada em fin_eliminacoes_intercompany (regras manuais)
-- depois: eliminação derivada de fin_ic_matches com status IN ('auto_matched','manual_matched')
--         para o período solicitado
-- benefício: cada eliminação é rastreável até o par CR/CP que originou
```

**`fin_eliminacoes_intercompany`** permanece pra casos manuais especiais (ex: reclassificação histórica), mas o caminho principal vira `fin_ic_matches`.

**UI nova `/financeiro/intercompany/fila`** (`FinanceiroIntercompanyFila.tsx`):
- Layout estilo `FinanceiroConciliacao` — tabela com filtro de status
- Por linha: empresa origem → empresa destino, valor, diff, status com badge colorido
- Ações por linha (varia por status):
  - `divergencia_valor` → aprovar mesmo assim (vira `manual_matched`) / abrir CR e CP lado a lado
  - `sem_contrapartida` → marcar como `desconsiderado` (CR/CP que não é IC de fato) / forçar match com candidato alternativo
  - `duplicidade_possivel` → escolher qual par é o correto
- Filtro por período (default: mês corrente + mês anterior)

**`FinanceiroIntercompany.tsx` ganha:**
- Badge "N divergências pendentes" linkando pra fila
- Aviso visível no `FinanceiroFechamento`: "N divergências IC pendentes neste período" — não bloqueia o fechamento por si só (founder pode aprovar mesmo com IC aberto, se julgar que diferença é imaterial), mas vira parte do checklist de revisão visual

---

### 3.5 Gate de Categoria Não-Mapeada

**Por quê:** a heurística atual classifica categoria desconhecida com palpite por keyword. "Honorários Advocatícios" pode virar receita financeira por acidente. O próprio doc avisa: *"Se você não sabe o que é, não use como número de controller"*.

**Trigger DB:**

```sql
CREATE OR REPLACE FUNCTION fin_check_mapping_complete_trigger() RETURNS trigger AS $$
DECLARE
  v_pendentes jsonb;
BEGIN
  -- só verifica na transição para 'aprovado'
  IF NEW.status <> 'aprovado' OR OLD.status = 'aprovado' THEN
    RETURN NEW;
  END IF;

  WITH categorias_periodo AS (
    SELECT DISTINCT categoria_id, categoria_nome, 'receber' AS tipo
    FROM fin_contas_receber
    WHERE empresa_id = NEW.empresa_id
      AND data_emissao >= date_trunc('month', NEW.periodo)
      AND data_emissao < date_trunc('month', NEW.periodo) + interval '1 month'
      AND COALESCE(valor, 0) > 0
    UNION
    SELECT DISTINCT categoria_id, categoria_nome, 'pagar'
    FROM fin_contas_pagar
    WHERE empresa_id = NEW.empresa_id
      AND data_emissao >= date_trunc('month', NEW.periodo)
      AND data_emissao < date_trunc('month', NEW.periodo) + interval '1 month'
      AND COALESCE(valor, 0) > 0
  ),
  pendentes AS (
    SELECT cp.categoria_id, cp.categoria_nome
    FROM categorias_periodo cp
    LEFT JOIN fin_categoria_dre_mapping m
      ON m.empresa_id = NEW.empresa_id
     AND m.categoria_id = cp.categoria_id
    WHERE m.id IS NULL
  )
  SELECT jsonb_agg(jsonb_build_object('id', categoria_id, 'nome', categoria_nome))
  INTO v_pendentes FROM pendentes;

  IF v_pendentes IS NOT NULL AND jsonb_array_length(v_pendentes) > 0 THEN
    RAISE EXCEPTION 'MAPPING_INCOMPLETE: % categorias sem mapeamento DRE: %',
      jsonb_array_length(v_pendentes), v_pendentes::text
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Edge function `fin-suggest-mapping`:**

```ts
// GET ?empresa_id=&periodo=
// Retorna: [{ categoria_id, categoria_nome, sugestao: { linha_dre, confianca, razao }, valor_periodo }]
//
// Lógica de sugestão (em ordem de prioridade):
// 1. Outra empresa do grupo já mapeou essa categoria_id ou categoria_nome similar?
//    → confianca: 'alta', razao: 'Empresa <X> mapeou como <Y>'
// 2. Categoria semelhante (mesmo prefixo, mesma palavra-chave principal) na mesma empresa?
//    → confianca: 'media', razao: 'Categoria similar <Y> mapeada como <Z>'
// 3. Heurística de keyword (mantida do código atual)
//    → confianca: 'baixa', razao: 'Keyword <kw> sugere <Z>'
// 4. Sem palpite
//    → confianca: 'baixa', razao: 'sem sugestão automática'
```

**UI `FinanceiroMapping.tsx` modificada:**
- Banner amarelo no topo: "N categorias do período afetam R$ X mas não têm mapeamento DRE" (quando count > 0)
- Tabela ganha coluna "Sugestão" com pill colorido por confiança + razão em tooltip
- Ações em batch:
  - Botão "Aplicar todas as sugestões de alta confiança" (quando há ≥1)
  - Botão "Revisar baixa confiança"
- Linha-a-linha: dropdown DRE com sugestão pré-selecionada, badge da confiança, observação opcional

**UI `FinanceiroFechamento.tsx` modificada:**
- Tentativa de aprovar com erro `P0002` capturado pelo `error-handler.ts`
- Modal: "Não foi possível aprovar. Categorias pendentes: <lista>" + botão "Resolver no Mapeamento" (deep link com filtro pré-aplicado)

---

## 4. Permissionamento

| Ação | Quem pode (hoje) |
|---|---|
| Ver audit trail | `isStaff` |
| Editar lançamento em período aberto | `isStaff` |
| Abrir override de emergência | `isMaster` |
| Aprovar fechamento | `isMaster` |
| Resolver divergência IC | `isStaff` |
| Aprovar mapping de categoria | `isStaff` |

> Futuro (equipe interna): adicionar role `controller` que separa "operação" de "aprovação"; sem implementar agora, mas tabelas já modeladas pra suportar.

---

## 5. Migração e Dados Históricos

**Fechamentos pré-existentes:**
- Migration popula `fin_fechamentos.dre_snapshot_caixa_id` retroativo (snapshot existente vira "caixa")
- `dre_snapshot_competencia_id` fica NULL nos retroativos — UI mostra "Competência não calculada" e oferece botão "Calcular agora"

**CR/CP existentes:**
- Trigger de audit começa a logar a partir de agora — nada de retroativo
- Trigger de travamento aplica retroativamente: tentativa de editar lançamento de 2024-01 vai ser bloqueada se 2024-01 já foi fechado

**Categorias sem mapeamento:**
- Migration roda `fin-suggest-mapping` pra cada empresa e gera arquivo de sugestões em `docs/financeiro/mapping-sugestoes-<empresa>.json`
- Founder revisa fora de banda, sobe via UI

**IC matches retroativos:**
- Migration roda `fin-ic-reconcile` no modo "histórico" sobre últimos 12 meses
- Popula `fin_ic_matches` — divergências ficam visíveis na fila

---

## 6. Testes

**Triggers DB (testes em `supabase/tests/`):**
- `fin_audit_trigger` — INSERT/UPDATE/DELETE em cada tabela auditada, valida diff correto, origem correta, period_ref correto
- `fin_period_lock_trigger` — bloqueia edit em período fechado, libera em período aberto, libera com override ativo, bloqueia com override expirado
- `fin_check_mapping_complete_trigger` — bloqueia approval com pendência, libera sem pendência, ignora valor = 0

**Edge functions:**
- `fin-period-override` — só master abre, expira automaticamente, justificativa obrigatória
- `fin-ic-reconcile` — match exato, match com diff, sem contrapartida, duplicidade, idempotência
- `fin-suggest-mapping` — ranking de confiança correto, dedup de categoria

**Frontend (vitest):**
- `useAuditTrail` — query + paginação
- `useFinanceiroRegime` — toggle + persist
- `RegimeToggle` — render + interação
- `PeriodOverrideModal` — só master vê, justificativa obrigatória, timer
- error-handler — captura `P0001`/`P0002` e dispara modais corretos

---

## 7. Riscos e Mitigações

| Risco | Mitigação |
|---|---|
| Trigger de audit aumenta latência de INSERT/UPDATE | Índices em `fin_audit_log` minimizados; particionamento por mês quando volume justificar (~1M linhas) |
| Sync Omie passa a falhar em períodos fechados | Sync detecta `P0001` e marca em `fin_sync_log` como "bloqueado por fechamento"; tela de sync mostra contagem; founder revisa caso a caso |
| IC reconciliação falsamente flagga divergência | Tolerância configurável em `company_config.ic_match_tolerance` (default ±R$0,01 e ±5 dias); UI permite ampliar |
| Override de emergência vira hábito | Cockpit mostra "X overrides nos últimos 30d" com cor crescente; relatório mensal por email (futuro) |
| Gate de mapping bloqueia fechamento crítico | Botão "Mapear todas pendentes em 'A Classificar'" como escape hatch — fechamento passa, mas linha DRE "A Classificar" vira o pico do mês e cria pressão de resolver |

---

## 8. Não-Escopo (deliberadamente fora)

- DRE por competência alimentando SPED/ECD/ECF/DEFIS — fora; futuro spec próprio
- Permission model expandido (role `controller` separado de `master`) — fora; preparado, não implementado
- Integração com banco real (extrato direto) — fora; Tier 2
- Boleto, régua de cobrança, conciliação adquirente — fora; Tier 2
- Análise de margem por SKU/cliente/vendedor — fora; cruza com módulo de vendas
- Provisões contábeis (depreciação, amortização) — fora; entra com SPED
- Notificações de fechamento pra equipe — fora; entra quando equipe estiver presente

---

## 9. Plano de Entrega (preview)

Detalhamento em `writing-plans` na próxima fase. Visão geral em fatias entregáveis:

1. **Audit Trail** (DB + UI básica de drawer) — entrega independente, valor imediato
2. **Travamento + Override** (DB + edge fn + modal) — depende de audit pra logar overrides
3. **DRE Competência** (edge fn + toggle UI) — independente das anteriores
4. **Gate de Mapping** (DB + suggest fn + UI banner) — independente
5. **IC Reconciliação** (DB + edge fn + fila UI) — independente

Cada fatia pode virar PR separado. Ordem sugerida acima maximiza valor incremental e minimiza risco de retrabalho.

---

## 10. Definição de Pronto

- Todas as 5 peças implementadas e cobertas por testes (DB + edge fn + frontend)
- `bun lint && bun build && bun test` verdes
- Migration aplicada em ambiente de staging, com dados retroativos populados
- Founder consegue:
  - Ver histórico de mudança em qualquer CR/CP/categoria/orçamento
  - Tentar editar lançamento de período fechado e receber bloqueio claro
  - Abrir override de 15 min com justificativa
  - Alternar DRE entre caixa e competência no cockpit
  - Aprovar fechamento e ser bloqueado se houver categoria não-mapeada
  - Ver fila IC com divergências reais entre as 3 empresas
- Documentação `docs/FINANCEIRO_CONFIABILIDADE.md` atualizada — itens migrados de "❌ Não implementado" pra "✅ MVP operacional"
