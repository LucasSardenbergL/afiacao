# Decisão de Embalagem Econômica (QT/GL) — Plano de Implementação (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No cockpit de pedidos de compra, recomendar qual embalagem (QT ou GL) comprar pelo menor custo por unidade-base, com preço informado manualmente.

**Architecture:** Uma migration cria 2 tabelas (pares de equivalência + preços) + kill-switch em `company_config`. Um helper puro (`embalagem-helpers.ts`, TDD) decide a embalagem por custo total ajustado (preço + capital de carrego do excedente). Um hook + painel no `DetalhesModal` mostram a recomendação e permitem digitar o preço. Sem scraping (Fase 2).

**Tech Stack:** React + TypeScript, @tanstack/react-query, Supabase (Postgres + RLS), vitest. Migration aplicada manualmente via Lovable (skill `lovable-db-operator`).

**Spec:** `docs/superpowers/specs/2026-06-04-embalagem-economica-design.md`

---

## File Structure

- **Create** `supabase/migrations/20260604HHMMSS_embalagem_economica.sql` — 2 tabelas + RLS staff + seed do kill-switch. Aplicada manual via Lovable.
- **Create** `src/lib/reposicao/embalagem-helpers.ts` — helper puro de decisão (espelha o estilo de `compras-otimizador-helpers.ts`).
- **Create** `src/lib/reposicao/embalagem-helpers.test.ts` — testes vitest (TDD).
- **Create** `src/components/reposicao/pedidos/useEmbalagemPedido.ts` — hook que carrega grupos + preços + custo de capital + demanda e roda o helper por SKU do pedido.
- **Create** `src/components/reposicao/pedidos/EmbalagemPanel.tsx` — painel "Embalagem" no modal + dialog de preço manual.
- **Modify** `src/components/reposicao/pedidos/DetalhesModal.tsx:125` — inserir `<EmbalagemPanel>` após o `ItensTable`.

**Convenções confirmadas no codebase:**
- Tabela nova fora dos tipos gerados → `.from('nome' as never)` + retorno `as unknown as T[]` (ver `useAplicacaoFila.ts:45-82`).
- RLS staff em reposição → `public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)` (ver policies de `pedido_compra_item`).
- Teste de helper puro fica em `src/lib/reposicao/<nome>.test.ts` (mesmo dir), igual a `compras-otimizador-helpers.test.ts`.
- Comando de teste canônico: `bun run test`. Typecheck: `bun run typecheck`.

---

## Task 1: Migration — tabelas + kill-switch

**Files:**
- Create: `supabase/migrations/20260604HHMMSS_embalagem_economica.sql` (substituir `HHMMSS` por hora real, ex.: `20260604180000`)

- [ ] **Step 1: Criar o arquivo de migration com o SQL completo**

```sql
-- Decisão de embalagem econômica (QT/GL) — v1.
-- Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
-- Pares de equivalência (cadastro manual) + preços (manual na v1; campos de captura prontos p/ Fase 2).

-- 1) Pares de equivalência de embalagem
CREATE TABLE IF NOT EXISTS public.sku_embalagem_equivalencia (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa          text NOT NULL,
  grupo_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  sku_codigo_omie  text NOT NULL,
  unidade_base     text NOT NULL,           -- ex.: 'QT'
  fator_para_base  numeric NOT NULL CHECK (fator_para_base > 0),  -- QT=1, GL=4
  fornecedor_nome  text,
  ativo            boolean NOT NULL DEFAULT true,
  vigente_desde    date NOT NULL DEFAULT CURRENT_DATE,
  vigente_ate      date,
  criado_por       text,
  criado_em        timestamptz NOT NULL DEFAULT now()
);

-- Cada SKU ativo pertence a no máximo um grupo (por empresa).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sku_emb_equiv_ativo
  ON public.sku_embalagem_equivalencia (empresa, sku_codigo_omie)
  WHERE ativo;

CREATE INDEX IF NOT EXISTS idx_sku_emb_equiv_grupo
  ON public.sku_embalagem_equivalencia (empresa, grupo_id) WHERE ativo;

ALTER TABLE public.sku_embalagem_equivalencia ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_sku_emb_equiv_select ON public.sku_embalagem_equivalencia
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_insert ON public.sku_embalagem_equivalencia
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_update ON public.sku_embalagem_equivalencia
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_emb_equiv_delete ON public.sku_embalagem_equivalencia
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));

-- 2) Preços por embalagem (v1: fonte='manual_usuario'; demais campos prontos p/ Fase 2)
CREATE TABLE IF NOT EXISTS public.sku_preco_fornecedor_capturado (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa                  text NOT NULL,
  sku_codigo_omie          text NOT NULL,
  fornecedor_nome          text,
  preco                    numeric NOT NULL CHECK (preco > 0),
  moeda                    text NOT NULL DEFAULT 'BRL',
  preco_tipo               text NOT NULL DEFAULT 'liquido' CHECK (preco_tipo IN ('liquido','bruto')),
  capturado_em             timestamptz NOT NULL DEFAULT now(),
  fonte                    text NOT NULL CHECK (fonte IN ('manual_usuario','portal_capturado_ok','portal_capturado_parcial')),
  status                   text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','stale','falhou')),
  run_id                   text,
  validade_operacional_ate timestamptz,
  observacao               text,
  criado_por               text,
  criado_em                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_preco_cap_lookup
  ON public.sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, capturado_em DESC);

ALTER TABLE public.sku_preco_fornecedor_capturado ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_sku_preco_cap_select ON public.sku_preco_fornecedor_capturado
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_insert ON public.sku_preco_fornecedor_capturado
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_update ON public.sku_preco_fornecedor_capturado
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY staff_sku_preco_cap_delete ON public.sku_preco_fornecedor_capturado
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));

-- 3) Kill-switch + parâmetros em company_config (key/value text)
INSERT INTO public.company_config (key, value)
VALUES
  ('embalagem_captura_automatica_habilitada', 'false'),
  ('embalagem_preco_stale_horas', '24'),
  ('embalagem_limiar_economia_rs', '5')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Validar o SQL com a query de checagem (entregar junto da migration)**

```sql
SELECT 'BLOCO embalagem OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
     AND table_name IN ('sku_embalagem_equivalencia','sku_preco_fornecedor_capturado')) AS tabelas,    -- esperado 2
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
     AND tablename IN ('sku_embalagem_equivalencia','sku_preco_fornecedor_capturado')) AS policies,     -- esperado 8
  (SELECT count(*) FROM public.company_config
     WHERE key IN ('embalagem_captura_automatica_habilitada','embalagem_preco_stale_horas','embalagem_limiar_economia_rs')) AS configs;  -- esperado 3
```

- [ ] **Step 3: Commit (só o arquivo de migration; a APLICAÇÃO é manual via Lovable)**

```bash
git add supabase/migrations/20260604HHMMSS_embalagem_economica.sql
git commit -m "feat(reposicao): migration de embalagem econômica (equivalência + preço + kill-switch)"
```

> **ATENÇÃO (entrega):** ao shippar, usar a skill `lovable-db-operator` — colar o SQL do Step 1 no SQL Editor do Lovable, rodar, depois colar o Step 2 e confirmar `tabelas=2, policies=8, configs=3`. O PR description deve marcar "**migration manual necessária**".

---

## Task 2: Helper — tipos + `avaliarOpcao`

**Files:**
- Create: `src/lib/reposicao/embalagem-helpers.ts`
- Test: `src/lib/reposicao/embalagem-helpers.test.ts`

- [ ] **Step 1: Escrever os testes de `avaliarOpcao`**

```ts
// src/lib/reposicao/embalagem-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { avaliarOpcao, type OpcaoEmbalagem, type ParamsEmbalagem } from './embalagem-helpers';

const QT: OpcaoEmbalagem = { sku_codigo_omie: 'QT1', fator_para_base: 1, preco: 10, preco_status: 'ok' };
const GL: OpcaoEmbalagem = { sku_codigo_omie: 'GL1', fator_para_base: 4, preco: 30, preco_status: 'ok' };
const semDemanda: ParamsEmbalagem = { custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: null };

describe('avaliarOpcao', () => {
  it('GL com necessidade 1: 1 embalagem, excedente 3, sem capital quando demanda ausente', () => {
    const a = avaliarOpcao(1, GL, semDemanda);
    expect(a).not.toBeNull();
    expect(a!.qtd_embalagens).toBe(1);
    expect(a!.unidades_base_compradas).toBe(4);
    expect(a!.excedente_base).toBe(3);
    expect(a!.custo_direto).toBe(30);
    expect(a!.capital_carrego).toBeNull();
    expect(a!.custo_total_ajustado).toBe(30);
  });

  it('QT casa exato quando necessidade = 4 (sem excedente)', () => {
    const a = avaliarOpcao(4, QT, { ...semDemanda, demanda_base_diaria: 2 });
    expect(a!.qtd_embalagens).toBe(4);
    expect(a!.excedente_base).toBe(0);
    expect(a!.custo_direto).toBe(40);
    expect(a!.capital_carrego).toBe(0);
  });

  it('capital de carrego do excedente é descontado quando há demanda', () => {
    // GL, necessidade 1, excedente 3 QT-equiv, custo_por_base = 30/4 = 7.5
    // demanda 0.02/dia → escoa 3/0.02 = 150 dias; capital = 3 * 7.5 * 0.5 * (150/365)
    const a = avaliarOpcao(1, { ...GL, preco: 30 }, { custo_capital_anual: 0.5, limiar_minimo_economia_rs: 5, demanda_base_diaria: 0.02 });
    expect(a!.capital_carrego).toBeCloseTo(3 * 7.5 * 0.5 * (150 / 365), 4);
    expect(a!.custo_total_ajustado).toBeCloseTo(30 + 3 * 7.5 * 0.5 * (150 / 365), 4);
  });

  it('retorna null quando preço ausente ou fator inválido', () => {
    expect(avaliarOpcao(1, { ...GL, preco: null }, semDemanda)).toBeNull();
    expect(avaliarOpcao(1, { ...GL, fator_para_base: 0 }, semDemanda)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar os testes e ver falhar**

Run: `bun run test src/lib/reposicao/embalagem-helpers.test.ts`
Expected: FAIL ("avaliarOpcao is not a function" / módulo não existe)

- [ ] **Step 3: Implementar tipos + `avaliarOpcao`**

```ts
// src/lib/reposicao/embalagem-helpers.ts
// Decisão de embalagem econômica (QT/GL) — módulo puro (TDD).
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
// Capital de carrego espelha compras-otimizador-helpers.ts (capitalExtra).

export type StatusPreco = 'ok' | 'stale' | 'falhou';

export interface OpcaoEmbalagem {
  sku_codigo_omie: string;
  fator_para_base: number;            // QT=1, GL=4
  preco: number | null;               // null = preço não informado
  preco_status: StatusPreco | null;
  lote_minimo?: number | null;        // v1: não usado na decisão (Fase 3)
}

export interface ParamsEmbalagem {
  custo_capital_anual: number;        // decimal, ex.: 0.30
  limiar_minimo_economia_rs: number;  // piso p/ valer o overbuy
  demanda_base_diaria?: number | null;// p/ estimar escoamento do excedente
}

export interface AvaliacaoOpcao {
  sku_codigo_omie: string;
  custo_por_base: number;             // preco / fator
  qtd_embalagens: number;
  unidades_base_compradas: number;
  excedente_base: number;
  custo_direto: number;
  capital_carrego: number | null;     // null quando demanda ausente
  custo_total_ajustado: number;
  preco_status: StatusPreco;
}

export function avaliarOpcao(
  necessidadeBase: number,
  opcao: OpcaoEmbalagem,
  params: ParamsEmbalagem,
): AvaliacaoOpcao | null {
  if (opcao.preco == null || opcao.fator_para_base <= 0) return null;
  const fator = opcao.fator_para_base;
  const custo_por_base = opcao.preco / fator;
  const qtd_embalagens = Math.ceil(necessidadeBase / fator);
  const unidades_base_compradas = qtd_embalagens * fator;
  const excedente_base = unidades_base_compradas - necessidadeBase;
  const custo_direto = qtd_embalagens * opcao.preco;

  const d = params.demanda_base_diaria ?? 0;
  let capital_carrego: number | null;
  if (params.demanda_base_diaria != null && d > 0) {
    const dias_escoa = excedente_base / d;
    capital_carrego = excedente_base * custo_por_base * params.custo_capital_anual * (dias_escoa / 365);
  } else {
    capital_carrego = null;
  }
  const custo_total_ajustado = custo_direto + (capital_carrego ?? 0);

  return {
    sku_codigo_omie: opcao.sku_codigo_omie,
    custo_por_base,
    qtd_embalagens,
    unidades_base_compradas,
    excedente_base,
    custo_direto,
    capital_carrego,
    custo_total_ajustado,
    preco_status: opcao.preco_status ?? 'ok',
  };
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `bun run test src/lib/reposicao/embalagem-helpers.test.ts`
Expected: PASS (4 testes de `avaliarOpcao`)

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/embalagem-helpers.ts src/lib/reposicao/embalagem-helpers.test.ts
git commit -m "feat(reposicao): embalagem-helpers — avaliarOpcao (custo ajustado + capital de carrego)"
```

---

## Task 3: Helper — `escolherEmbalagemEconomica` + guards

**Files:**
- Modify: `src/lib/reposicao/embalagem-helpers.ts`
- Modify: `src/lib/reposicao/embalagem-helpers.test.ts`

- [ ] **Step 1: Adicionar os testes de `escolherEmbalagemEconomica`**

```ts
// adicionar ao final de src/lib/reposicao/embalagem-helpers.test.ts
import { escolherEmbalagemEconomica } from './embalagem-helpers';

const params = (over: Partial<ParamsEmbalagem> = {}): ParamsEmbalagem =>
  ({ custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: 2, ...over });

describe('escolherEmbalagemEconomica', () => {
  it('QT vence quando GL é caro (necessidade pequena)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 50, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).toBe('ok');
    expect(r.recomendada).toBe('QT');
  });

  it('GL vence quando necessidade é grande e GL/4 < QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.recomendada).toBe('GL'); // 30 < 4*10
  });

  it('GL barato/unidade mas necessidade pequena: o capital come a economia → QT', () => {
    // necessidade 1; GL=9 (9/4=2.25), QT=10; demanda baixa → capital grande
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9, preco_status: 'ok' },
      ],
      params: params({ custo_capital_anual: 0.5, demanda_base_diaria: 0.02 }),
    });
    // GL: 9 + capital(3*2.25*0.5*150/365 ≈ 1.39) ≈ 10.39 > QT 10
    expect(r.recomendada).toBe('QT');
  });

  it('economia abaixo do limiar não empurra overbuy (marginal → recomenda a sem excedente)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9.9, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 1 }), // capital ~0
    });
    expect(r.status).toBe('marginal');
    expect(r.recomendada).toBe('QT'); // economia 0.1 < limiar 1 → não vale o overbuy
    expect(r.flags).toContain('overbuy_marginal');
  });

  it('menos de 2 preços informados → indisponivel', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: null, preco_status: null },
      ],
      params: params(),
    });
    expect(r.status).toBe('indisponivel');
    expect(r.recomendada).toBeNull();
  });

  it('preço stale não bloqueia, mas sinaliza', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'stale' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).not.toBe('indisponivel');
    expect(r.flags).toContain('preco_desatualizado');
  });

  it('demanda ausente: recomenda por custo direto + flag de escoamento', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: null }),
    });
    expect(r.recomendada).toBe('GL');
    expect(r.capital_estimado).toBeNull();
    expect(r.flags).toContain('escoamento_nao_estimado');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test src/lib/reposicao/embalagem-helpers.test.ts`
Expected: FAIL ("escolherEmbalagemEconomica is not a function")

- [ ] **Step 3: Implementar `escolherEmbalagemEconomica`**

```ts
// adicionar ao final de src/lib/reposicao/embalagem-helpers.ts

export type StatusDecisao = 'ok' | 'indisponivel' | 'marginal';

export interface DecisaoEmbalagem {
  status: StatusDecisao;
  recomendada: string | null;          // sku_codigo_omie ou null
  opcoes: AvaliacaoOpcao[];
  excedente_base: number;              // da opção recomendada
  capital_estimado: number | null;     // da opção recomendada
  economia_vs_alternativa: number;     // R$ entre a mais barata e a 2ª (>= 0)
  flags: string[];
}

export function escolherEmbalagemEconomica(input: {
  necessidade_base: number;
  opcoes: OpcaoEmbalagem[];
  params: ParamsEmbalagem;
}): DecisaoEmbalagem {
  const { necessidade_base, opcoes, params } = input;
  const flags: string[] = [];

  // Só preço informado + fator válido contam. < 2 → indisponível.
  const validas = opcoes.filter((o) => o.preco != null && o.fator_para_base > 0 && o.preco_status !== 'falhou');
  if (validas.length < 2) {
    return {
      status: 'indisponivel', recomendada: null, opcoes: [],
      excedente_base: 0, capital_estimado: null, economia_vs_alternativa: 0,
      flags: ['preco_indisponivel'],
    };
  }

  if (validas.some((o) => o.preco_status === 'stale')) flags.push('preco_desatualizado');
  if (params.demanda_base_diaria == null || params.demanda_base_diaria <= 0) flags.push('escoamento_nao_estimado');

  const avals = validas
    .map((o) => avaliarOpcao(necessidade_base, o, params))
    .filter((a): a is AvaliacaoOpcao => a !== null)
    .sort((a, b) => a.custo_total_ajustado - b.custo_total_ajustado);

  const melhor = avals[0];
  const economia_vs_alternativa = avals[1].custo_total_ajustado - melhor.custo_total_ajustado;

  let status: StatusDecisao = 'ok';
  let recomendada = melhor.sku_codigo_omie;

  // Guard de overbuy marginal: se a mais barata gera excedente e a economia
  // vs a melhor opção SEM excedente é < limiar, não vale o overbuy.
  if (melhor.excedente_base > 0) {
    const semExc = avals.find((a) => a.excedente_base === 0);
    if (semExc && (semExc.custo_total_ajustado - melhor.custo_total_ajustado) < params.limiar_minimo_economia_rs) {
      status = 'marginal';
      recomendada = semExc.sku_codigo_omie;
      flags.push('overbuy_marginal');
    } else {
      flags.push('overbuy_compensa');
    }
  }

  const recAval = avals.find((a) => a.sku_codigo_omie === recomendada) as AvaliacaoOpcao;
  return {
    status, recomendada, opcoes: avals,
    excedente_base: recAval.excedente_base,
    capital_estimado: recAval.capital_carrego,
    economia_vs_alternativa,
    flags,
  };
}
```

- [ ] **Step 4: Rodar e ver passar (todos os testes do arquivo)**

Run: `bun run test src/lib/reposicao/embalagem-helpers.test.ts`
Expected: PASS (11 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/embalagem-helpers.ts src/lib/reposicao/embalagem-helpers.test.ts
git commit -m "feat(reposicao): escolherEmbalagemEconomica + guards (indisponivel/stale/marginal/sem-demanda)"
```

---

## Task 4: Hook `useEmbalagemPedido`

Carrega, para os SKUs de um pedido, os grupos de equivalência + preços + custo de capital + demanda, e roda o helper por SKU. Retorna um mapa `sku_codigo_omie → DecisaoEmbalagem`.

**Files:**
- Create: `src/components/reposicao/pedidos/useEmbalagemPedido.ts`

- [ ] **Step 1: Implementar o hook**

```ts
// src/components/reposicao/pedidos/useEmbalagemPedido.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  escolherEmbalagemEconomica,
  type DecisaoEmbalagem,
  type OpcaoEmbalagem,
  type StatusPreco,
} from '@/lib/reposicao/embalagem-helpers';
import type { PedidoItem } from './types';

interface EquivRow { empresa: string; grupo_id: string; sku_codigo_omie: string; unidade_base: string; fator_para_base: number; }
interface PrecoRow { sku_codigo_omie: string; preco: number; capturado_em: string; status: StatusPreco; }
interface ParamRow { sku_codigo_omie: number; custo_capital_efetivo_perc: number | null; }

export interface EmbalagemPedidoResult {
  /** sku_codigo_omie (do item do pedido) -> decisão de embalagem do grupo dele */
  porSku: Record<string, DecisaoEmbalagem>;
  isLoading: boolean;
}

export function useEmbalagemPedido(empresa: string | undefined, itens: PedidoItem[] | undefined): EmbalagemPedidoResult {
  const skus = (itens ?? []).map((i) => String(i.sku_codigo_omie));

  const { data, isLoading } = useQuery({
    queryKey: ['embalagem-pedido', empresa, skus.join(',')],
    enabled: !!empresa && skus.length > 0,
    queryFn: async (): Promise<Record<string, DecisaoEmbalagem>> => {
      if (!empresa) return {};

      // 1) Grupos a que os SKUs do pedido pertencem
      const equivResp = await supabase
        .from('sku_embalagem_equivalencia' as never)
        .select('empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base')
        .eq('empresa', empresa)
        .eq('ativo', true)
        .in('sku_codigo_omie', skus);
      const equivDoPedido = ((equivResp.data ?? []) as unknown as EquivRow[]);
      const gruposEnvolvidos = [...new Set(equivDoPedido.map((e) => e.grupo_id))];
      if (gruposEnvolvidos.length === 0) return {};

      // 2) TODOS os membros desses grupos (inclui a embalagem-irmã que não está no pedido)
      const membrosResp = await supabase
        .from('sku_embalagem_equivalencia' as never)
        .select('empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base')
        .eq('empresa', empresa)
        .eq('ativo', true)
        .in('grupo_id', gruposEnvolvidos);
      const membros = ((membrosResp.data ?? []) as unknown as EquivRow[]);
      const skusGrupo = [...new Set(membros.map((m) => m.sku_codigo_omie))];

      // 3) Preço mais recente por SKU do grupo
      const precoResp = await supabase
        .from('sku_preco_fornecedor_capturado' as never)
        .select('sku_codigo_omie, preco, capturado_em, status')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skusGrupo)
        .order('capturado_em', { ascending: false });
      const precoRows = ((precoResp.data ?? []) as unknown as PrecoRow[]);
      const precoMap = new Map<string, PrecoRow>();
      for (const p of precoRows) { if (!precoMap.has(String(p.sku_codigo_omie))) precoMap.set(String(p.sku_codigo_omie), p); }

      // 4) Demanda + custo de capital por SKU (sku_parametros + view de parâmetros sugeridos)
      const skuNums = skusGrupo.map(Number).filter((n) => !Number.isNaN(n));
      const paramResp = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, demanda_media_diaria')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skuNums);
      const demandaMap = new Map<string, number | null>();
      ((paramResp.data ?? []) as unknown as { sku_codigo_omie: number; demanda_media_diaria: number | null }[])
        .forEach((p) => demandaMap.set(String(p.sku_codigo_omie), p.demanda_media_diaria));
      const cmResp = await supabase
        .from('v_sku_parametros_sugeridos')
        .select('sku_codigo_omie, custo_capital_efetivo_perc')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skuNums);
      const cmMap = new Map<string, number | null>();
      ((cmResp.data ?? []) as unknown as ParamRow[])
        .forEach((p) => cmMap.set(String(p.sku_codigo_omie), p.custo_capital_efetivo_perc));

      // 5) Limiar de economia (company_config)
      const cfgResp = await supabase.from('company_config').select('value').eq('key', 'embalagem_limiar_economia_rs').maybeSingle();
      const limiar = Number((cfgResp.data?.value as string | undefined) ?? '5') || 5;

      // 6) Stale (company_config) → marca status do preço por idade
      const staleResp = await supabase.from('company_config').select('value').eq('key', 'embalagem_preco_stale_horas').maybeSingle();
      const staleHoras = Number((staleResp.data?.value as string | undefined) ?? '24') || 24;
      const agoraMs = Date.now();
      const statusComStale = (p: PrecoRow | undefined): StatusPreco | null => {
        if (!p) return null;
        if (p.status === 'falhou') return 'falhou';
        const idadeH = (agoraMs - Date.parse(p.capturado_em)) / 3_600_000;
        return idadeH > staleHoras ? 'stale' : (p.status ?? 'ok');
      };

      // 7) Monta as opções do grupo e roda o helper, por grupo
      const opcoesPorGrupo = new Map<string, { unidade: string; opcoes: OpcaoEmbalagem[] }>();
      for (const m of membros) {
        const entry = opcoesPorGrupo.get(m.grupo_id) ?? { unidade: m.unidade_base, opcoes: [] };
        const p = precoMap.get(m.sku_codigo_omie);
        entry.opcoes.push({
          sku_codigo_omie: m.sku_codigo_omie,
          fator_para_base: Number(m.fator_para_base),
          preco: p ? Number(p.preco) : null,
          preco_status: statusComStale(p),
        });
        opcoesPorGrupo.set(m.grupo_id, entry);
      }

      // 8) Resultado por SKU do pedido (necessidade vem da qtde_final ?? qtde_sugerida do item, em unidade-base)
      const result: Record<string, DecisaoEmbalagem> = {};
      for (const item of itens ?? []) {
        const sku = String(item.sku_codigo_omie);
        const membro = membros.find((m) => m.sku_codigo_omie === sku);
        if (!membro) continue;
        const grupo = opcoesPorGrupo.get(membro.grupo_id);
        if (!grupo) continue;
        const qtdItem = Number(item.qtde_final ?? item.qtde_sugerida ?? 0);
        const necessidade_base = qtdItem * Number(membro.fator_para_base); // converte a qtd do SKU p/ unidade-base
        const demanda = demandaMap.get(sku) ?? null;
        const demanda_base = demanda != null ? demanda * Number(membro.fator_para_base) : null;
        const cmPerc = cmMap.get(sku);
        const custo_capital_anual = cmPerc != null ? Number(cmPerc) / 100 : 0;
        result[sku] = escolherEmbalagemEconomica({
          necessidade_base,
          opcoes: grupo.opcoes,
          params: { custo_capital_anual, limiar_minimo_economia_rs: limiar, demanda_base_diaria: demanda_base },
        });
      }
      return result;
    },
  });

  return { porSku: data ?? {}, isLoading };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `bun run typecheck`
Expected: PASS (sem erros novos no arquivo)

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/pedidos/useEmbalagemPedido.ts
git commit -m "feat(reposicao): useEmbalagemPedido — carrega grupos/preços/demanda e roda o helper por SKU"
```

---

## Task 5: Painel `EmbalagemPanel` + integração no modal

**Files:**
- Create: `src/components/reposicao/pedidos/EmbalagemPanel.tsx`
- Modify: `src/components/reposicao/pedidos/DetalhesModal.tsx`

- [ ] **Step 1: Criar o componente (sem o dialog de preço ainda — vem na Task 6)**

```tsx
// src/components/reposicao/pedidos/EmbalagemPanel.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Package } from 'lucide-react';
import { formatBRL } from './shared';
import type { PedidoItem } from './types';
import { useEmbalagemPedido } from './useEmbalagemPedido';

export function EmbalagemPanel({ empresa, itens }: { empresa: string; itens: PedidoItem[] }) {
  const { porSku, isLoading } = useEmbalagemPedido(empresa, itens);
  const skusComGrupo = (itens ?? []).filter((i) => porSku[String(i.sku_codigo_omie)]);
  if (isLoading || skusComGrupo.length === 0) return null; // só aparece quando há item multi-embalagem

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Package className="h-4 w-4" /> Embalagem econômica
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {skusComGrupo.map((item) => {
          const d = porSku[String(item.sku_codigo_omie)];
          return (
            <div key={item.id} className="border rounded p-3 text-sm space-y-1">
              <div className="font-medium">{item.sku_descricao ?? item.sku_codigo_omie}</div>
              {d.status === 'indisponivel' ? (
                <div className="text-muted-foreground">Informe os preços de cada embalagem pra ver a recomendação.</div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {d.opcoes.map((o) => (
                      <Badge key={o.sku_codigo_omie} variant={o.sku_codigo_omie === d.recomendada ? 'default' : 'outline'}>
                        {o.sku_codigo_omie}: {formatBRL(o.custo_por_base)}/un-base
                        {o.preco_status === 'stale' ? ' ⚠' : ''}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-muted-foreground">
                    Recomendado: <span className="font-medium text-foreground">{d.recomendada}</span>
                    {d.economia_vs_alternativa > 0 && <> · economia {formatBRL(d.economia_vs_alternativa)}</>}
                    {d.excedente_base > 0 && <> · excedente {d.excedente_base} un-base</>}
                    {d.status === 'marginal' && <> · <span className="text-status-warning">ganho marginal — confira</span></>}
                  </div>
                  {d.flags.includes('preco_desatualizado') && (
                    <div className="text-status-warning text-xs">Preço pode estar desatualizado — confira/atualize.</div>
                  )}
                  {d.flags.includes('escoamento_nao_estimado') && (
                    <div className="text-muted-foreground text-xs">Escoamento do excedente não estimado (sem demanda).</div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Inserir o painel no `DetalhesModal` após o `ItensTable`**

Em `src/components/reposicao/pedidos/DetalhesModal.tsx`, adicionar o import (junto aos outros imports de painel, perto da linha 13):

```tsx
import { EmbalagemPanel } from './EmbalagemPanel';
```

E inserir o painel logo após o fechamento do bloco do `ItensTable` (depois da linha 125, antes do grid de `PortalStatusPanel`/`HistoricoAcoesPanel`):

```tsx
        )}

        {!isLoading && <EmbalagemPanel empresa={pedido.empresa} itens={linhas} />}

        {/* Status de envio ao portal + Histórico de ações */}
```

> Nota: `linhas` é `Linha[]` (= `PedidoItem & {...}`), compatível com o prop `itens: PedidoItem[]`.

- [ ] **Step 3: Verificar typecheck + build**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/pedidos/EmbalagemPanel.tsx src/components/reposicao/pedidos/DetalhesModal.tsx
git commit -m "feat(reposicao): painel de embalagem econômica no modal de pedido"
```

---

## Task 6: Dialog "Atualizar preços" (entrada manual)

**Files:**
- Modify: `src/components/reposicao/pedidos/EmbalagemPanel.tsx`

- [ ] **Step 1: Adicionar o dialog de preço manual + mutation de insert**

No topo de `EmbalagemPanel.tsx`, ampliar os imports:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
```

Dentro de `EmbalagemPanel`, antes do `return`, adicionar estado, mutation e o handler:

```tsx
  const { user } = useAuth();
  const qc = useQueryClient();
  const [precoDialog, setPrecoDialog] = useState<null | { skus: string[] }>(null);
  const [precos, setPrecos] = useState<Record<string, string>>({});

  const salvarPrecos = useMutation({
    mutationFn: async (entries: { sku: string; preco: number }[]) => {
      const rows = entries.map((e) => ({
        empresa, sku_codigo_omie: e.sku, fornecedor_nome: 'Sayerlack',
        preco: e.preco, moeda: 'BRL', preco_tipo: 'liquido',
        fonte: 'manual_usuario', status: 'ok', criado_por: user?.email ?? 'sistema',
      }));
      const { error } = await supabase.from('sku_preco_fornecedor_capturado' as never).insert(rows as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Preços atualizados');
      qc.invalidateQueries({ queryKey: ['embalagem-pedido'] });
      setPrecoDialog(null); setPrecos({});
    },
    onError: (e: Error) => toast.error(`Erro ao salvar preços: ${e.message}`),
  });
```

Adicionar, dentro do `<div>` de cada item (após o bloco de recomendação), um botão que abre o dialog com os SKUs do grupo:

```tsx
                  <Button size="sm" variant="outline" className="mt-1"
                    onClick={() => setPrecoDialog({ skus: d.opcoes.map((o) => o.sku_codigo_omie) })}>
                    Atualizar preços
                  </Button>
```

E, antes do fechamento do componente (depois do `</Card>`), renderizar o dialog:

```tsx
      <Dialog open={!!precoDialog} onOpenChange={(o) => !o && setPrecoDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Atualizar preços (do portal)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {precoDialog?.skus.map((sku) => (
              <div key={sku}>
                <Label>{sku}</Label>
                <Input type="number" inputMode="decimal" placeholder="Preço atual"
                  value={precos[sku] ?? ''} onChange={(e) => setPrecos((p) => ({ ...p, [sku]: e.target.value }))} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrecoDialog(null)}>Cancelar</Button>
            <Button disabled={salvarPrecos.isPending}
              onClick={() => {
                const entries = (precoDialog?.skus ?? [])
                  .map((sku) => ({ sku, preco: Number(precos[sku]) }))
                  .filter((e) => e.preco > 0);
                if (entries.length === 0) { toast.error('Informe ao menos um preço > 0'); return; }
                salvarPrecos.mutate(entries);
              }}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

> O componente precisa virar um wrapper com `<>...</>` envolvendo `<Card>` + `<Dialog>`. Ajustar o `return (` para `return (<>` e fechar com `</>)`.

- [ ] **Step 2: Verificar typecheck + lint + build**

Run: `bun run typecheck && bun lint && bun run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/pedidos/EmbalagemPanel.tsx
git commit -m "feat(reposicao): dialog de preço manual no painel de embalagem"
```

---

## Validação final (antes de shippar)

- [ ] `bun run test` — toda a suíte verde (inclui os 11 testes do helper).
- [ ] `bun run typecheck` — sem erros.
- [ ] `bun lint` — sem erros.
- [ ] `bun run build` — build limpo.
- [ ] Migration aplicada no Lovable (skill `lovable-db-operator`): SQL do Step 1 da Task 1 + validação (`tabelas=2, policies=8, configs=3`).
- [ ] PR description marca "**migration manual necessária**" e cola o SQL.
- [ ] Pós-merge: cadastrar 1 par QT/GL de teste em `sku_embalagem_equivalencia`, abrir um pedido que contenha esse SKU no cockpit, conferir o painel e o fluxo "Atualizar preços".
