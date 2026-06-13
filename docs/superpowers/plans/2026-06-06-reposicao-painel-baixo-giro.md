# Painel "Baixo giro & estoque parado" — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma tela na Reposição (Oben) que mostra a cauda de baixo giro com capital parado, dias sem vender e a "situação" (por que não repõe), e deixa o founder resolver bloqueio, manter 1/2 (com preview do que será comprado) ou descontinuar — resolvendo os ~164 SKUs sem parâmetro.

**Architecture:** 100% frontend (sem migration money-path). Helpers puros testáveis em `src/lib/reposicao/baixo-giro-helpers.ts` (capital parado, situação, dias sem vender, preview de compra reusando `impactoSimulado` existente). Hook `useBaixoGiro` carrega o universo de baixo giro de `sku_parametros` e enriquece (1 chamada `.in()` por fonte) com `inventory_position` (saldo/cmc), `v_sku_demanda_estatisticas` (última venda) e `v_sku_parametros_sugeridos` (status). Página fina compõe hook + componentes presentacionais. Manter 1/2 e descontinuar são `update` simples em `sku_parametros` (a core do cron já **preserva** valores manuais via COALESCE — ver spec §7, nada a travar).

**Tech Stack:** React 18 + TS, react-query, supabase-js, shadcn/ui, Tailwind, vitest. Reusa: `impactoSimulado` (`param-auto-helpers.ts`), `fmt`/`fmtBRL`/`classBadge` (`sku-param.ts`), `useReposicaoEmpresa` (contexto Oben).

**Spec:** `docs/superpowers/specs/2026-06-06-reposicao-painel-baixo-giro-design.md`

---

## File Structure

**Criar:**
- `src/lib/reposicao/baixo-giro-helpers.ts` — helpers puros (capital, situação, dias, preview-lote)
- `src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts` — testes vitest
- `src/components/reposicao/baixoGiro/types.ts` — `RowBaixoGiro`, `FiltrosBaixoGiro`
- `src/components/reposicao/baixoGiro/useBaixoGiro.ts` — hook (queries + mutations)
- `src/components/reposicao/baixoGiro/BaixoGiroKpis.tsx` — KPIs do topo
- `src/components/reposicao/baixoGiro/BaixoGiroFiltros.tsx` — facetas (situação/estoque/busca)
- `src/components/reposicao/baixoGiro/BaixoGiroTable.tsx` — tabela + ações por linha/lote
- `src/components/reposicao/baixoGiro/ManterEmEstoqueDialog.tsx` — dialog "manter 1/2" com motivo + preview
- `src/pages/AdminReposicaoBaixoGiro.tsx` — página fina

**Modificar:**
- `src/App.tsx` — lazy import + `<Route>`
- `src/components/AppShell.tsx` — NavItem no menu "Reposição"

---

## Task 1: Helpers puros (capital parado, situação, dias sem vender, preview)

**Files:**
- Create: `src/lib/reposicao/baixo-giro-helpers.ts`
- Test: `src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts
import { describe, it, expect } from "vitest";
import {
  somarCapitalParado,
  classificarSituacao,
  diasSemVender,
  previewManterLote,
} from "../baixo-giro-helpers";

describe("somarCapitalParado", () => {
  it("soma saldo×cmc só onde saldo>0 e cmc>0; conta os sem custo", () => {
    const r = somarCapitalParado([
      { saldo: 10, cmc: 5 },     // 50
      { saldo: 2, cmc: null },   // sem custo
      { saldo: 0, cmc: 9 },      // sem estoque → ignora
      { saldo: 3, cmc: 0 },      // cmc 0 = sem custo
    ]);
    expect(r.totalRs).toBe(50);
    expect(r.semCustoN).toBe(2);
    expect(r.comEstoqueN).toBe(3);
  });
  it("lida com lista vazia", () => {
    expect(somarCapitalParado([])).toEqual({ totalRs: 0, semCustoN: 0, comEstoqueN: 0 });
  });
});

describe("classificarSituacao", () => {
  it("mapeia bloqueios para resolver_bloqueio", () => {
    expect(classificarSituacao("SEM_PRECO", 1).cta).toBe("resolver_bloqueio");
    expect(classificarSituacao("SEM_LEADTIME_DEFINIDO", 1).tipo).toBe("sem_leadtime");
    expect(classificarSituacao("AGUARDANDO_HABILITACAO_FORNECEDOR", 1).tipo).toBe("sem_fornecedor");
    expect(classificarSituacao("AGUARDANDO_CLASSIFICACAO_GRUPO", 1).tipo).toBe("sem_grupo");
  });
  it("2ª ordem vira cold_start", () => {
    const r = classificarSituacao("AGUARDANDO_SEGUNDA_ORDEM", null);
    expect(r.tipo).toBe("aguardando_2a_ordem");
    expect(r.cta).toBe("cold_start");
  });
  it("OK fica em dia", () => {
    expect(classificarSituacao("OK", 1).cta).toBe("em_dia");
  });
  it("sem status + sem parâmetro = sem_parametro / manter_ou_descontinuar", () => {
    const r = classificarSituacao(null, null);
    expect(r.tipo).toBe("sem_parametro");
    expect(r.cta).toBe("manter_ou_descontinuar");
  });
});

describe("diasSemVender", () => {
  it("conta dias entre última venda e hoje", () => {
    expect(diasSemVender("2026-06-01", "2026-06-06")).toBe(5);
  });
  it("null sem venda", () => {
    expect(diasSemVender(null, "2026-06-06")).toBeNull();
  });
});

describe("previewManterLote", () => {
  it("soma qtde e R$ que o ciclo compraria com pp/max novos; só itens em posição<=pp", () => {
    const r = previewManterLote(
      [
        { ppAtual: null, maxAtual: null, posicao: 0, custo: 10 }, // pos 0 <= 1 → compra 2 → R$20
        { ppAtual: null, maxAtual: null, posicao: 1, custo: 5 },  // pos 1 <= 1 → compra 1 → R$5
        { ppAtual: null, maxAtual: null, posicao: 5, custo: 4 },  // pos 5 > 1 → 0
        { ppAtual: null, maxAtual: null, posicao: 0, custo: null },// compra 2, sem custo
      ],
      1, 2,
    );
    expect(r.qtdeTotal).toBe(5);         // 2+1+0+2
    expect(r.valorTotalRs).toBe(25);     // 20+5+0
    expect(r.semCustoN).toBe(1);         // o item com custo null que compraria
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun run test src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts`
Expected: FAIL ("Cannot find module '../baixo-giro-helpers'").

- [ ] **Step 3: Implement the helpers**

```typescript
// src/lib/reposicao/baixo-giro-helpers.ts
import { impactoSimulado } from "./param-auto-helpers";

export function somarCapitalParado(
  itens: Array<{ saldo: number | null; cmc: number | null }>,
): { totalRs: number; semCustoN: number; comEstoqueN: number } {
  let totalRs = 0, semCustoN = 0, comEstoqueN = 0;
  for (const it of itens) {
    const saldo = it.saldo ?? 0;
    if (saldo <= 0) continue;
    comEstoqueN++;
    const cmc = it.cmc ?? 0;
    if (cmc > 0) totalRs += saldo * cmc;
    else semCustoN++;
  }
  return { totalRs, semCustoN, comEstoqueN };
}

export type SituacaoTipo =
  | "ok" | "sem_preco" | "sem_leadtime" | "sem_fornecedor"
  | "sem_grupo" | "aguardando_2a_ordem" | "sem_parametro" | "outro";
export type SituacaoCta = "resolver_bloqueio" | "cold_start" | "manter_ou_descontinuar" | "em_dia";

export function classificarSituacao(
  statusSugestao: string | null,
  estoqueMinimo: number | null,
): { tipo: SituacaoTipo; label: string; cta: SituacaoCta } {
  switch (statusSugestao) {
    case "OK": return { tipo: "ok", label: "Em dia", cta: "em_dia" };
    case "SEM_PRECO": return { tipo: "sem_preco", label: "Sem preço de custo", cta: "resolver_bloqueio" };
    case "SEM_LEADTIME_DEFINIDO": return { tipo: "sem_leadtime", label: "Sem lead time", cta: "resolver_bloqueio" };
    case "AGUARDANDO_HABILITACAO_FORNECEDOR": return { tipo: "sem_fornecedor", label: "Fornecedor não habilitado", cta: "resolver_bloqueio" };
    case "SEM_FORNECEDOR_IDENTIFICADO": return { tipo: "sem_fornecedor", label: "Sem fornecedor", cta: "resolver_bloqueio" };
    case "AGUARDANDO_CLASSIFICACAO_GRUPO": return { tipo: "sem_grupo", label: "Aguardando grupo", cta: "resolver_bloqueio" };
    case "AGUARDANDO_SEGUNDA_ORDEM": return { tipo: "aguardando_2a_ordem", label: "Aguardando 2ª compra", cta: "cold_start" };
    default:
      if (estoqueMinimo == null) return { tipo: "sem_parametro", label: "Sem parâmetro", cta: "manter_ou_descontinuar" };
      return { tipo: "outro", label: statusSugestao ?? "—", cta: "manter_ou_descontinuar" };
  }
}

export function diasSemVender(ultimaVendaISO: string | null, hojeISO: string): number | null {
  if (!ultimaVendaISO) return null;
  const ms = Date.parse(hojeISO) - Date.parse(ultimaVendaISO);
  return Math.floor(ms / 86_400_000);
}

export function previewManterLote(
  itens: Array<{ ppAtual: number | null; maxAtual: number | null; posicao: number; custo: number | null }>,
  ppNovo: number,
  maxNovo: number,
): { qtdeTotal: number; valorTotalRs: number; semCustoN: number } {
  let qtdeTotal = 0, valorTotalRs = 0, semCustoN = 0;
  for (const it of itens) {
    const { qtdeDepois } = impactoSimulado({
      ppAntes: it.ppAtual, maxAntes: it.maxAtual,
      ppDepois: ppNovo, maxDepois: maxNovo,
      posicao: it.posicao, custo: it.custo,
    });
    if (qtdeDepois <= 0) continue;
    qtdeTotal += qtdeDepois;
    if (it.custo != null && it.custo > 0) valorTotalRs += qtdeDepois * it.custo;
    else semCustoN++;
  }
  return { qtdeTotal, valorTotalRs, semCustoN };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun run test src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/baixo-giro-helpers.ts src/lib/reposicao/__tests__/baixo-giro-helpers.test.ts
git commit -m "feat(reposicao): helpers puros do painel de baixo giro (capital, situacao, preview)"
```

---

## Task 2: Tipos + hook de leitura `useBaixoGiro`

**Files:**
- Create: `src/components/reposicao/baixoGiro/types.ts`
- Create: `src/components/reposicao/baixoGiro/useBaixoGiro.ts`

**Contexto de dados (confirmado):**
- Universo: `sku_parametros` (`empresa='OBEN'`, `ativo=true`) com baixo giro canônico OU sem parâmetro. Filtro PostgREST (valores constantes, sem interpolação — não viola a regra anti-`.or()`):
  `.or('and(classe_abc.in.(B,C),classe_xyz.in.(Y,Z)),demanda_media_diaria.lt.0.05,estoque_minimo.is.null')`
- Enriquecimento por `.in('...', codes)`:
  - `inventory_position` (`account='oben'`): `omie_codigo_produto, saldo, cmc`
  - `v_sku_demanda_estatisticas` (`empresa`): `sku_codigo_omie, ultima_venda_data`
  - `v_sku_parametros_sugeridos` (`empresa`): `sku_codigo_omie, status_sugestao`
- Posição p/ preview (v1): usa `inventory_position.saldo` como aproximação da posição (item de cauda costuma ter pendente/trânsito 0). Documentar como aproximação; o gatilho real do ciclo usa `sku_estoque_atual`.
- Empresa: `useReposicaoEmpresa()` → `'OBEN'`.

- [ ] **Step 1: Definir os tipos**

```typescript
// src/components/reposicao/baixoGiro/types.ts
import type { SituacaoTipo, SituacaoCta } from "@/lib/reposicao/baixo-giro-helpers";

export interface RowBaixoGiro {
  id: string;                       // `${sku_codigo_omie}`
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  saldo: number | null;             // inventory_position
  cmc: number | null;               // inventory_position
  capital_parado: number | null;    // saldo*cmc (null se cmc null/0)
  dias_sem_vender: number | null;
  demanda_media_diaria: number | null;
  valor_vendido_90d: number | null;
  status_sugestao: string | null;
  situacao_tipo: SituacaoTipo;
  situacao_label: string;
  situacao_cta: SituacaoCta;
  estoque_minimo: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  habilitado_reposicao_automatica: boolean | null;
  tipo_reposicao: string | null;
}

export interface FiltrosBaixoGiro {
  situacao: SituacaoTipo | "todos";
  estoque: "todos" | "com_estoque" | "sem_estoque";
  busca: string;
}
```

- [ ] **Step 2: Implementar o hook (query + montagem das rows)**

```typescript
// src/components/reposicao/baixoGiro/useBaixoGiro.ts
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { classificarSituacao, diasSemVender, somarCapitalParado } from "@/lib/reposicao/baixo-giro-helpers";
import type { RowBaixoGiro } from "./types";

const HOJE_ISO = () => new Date().toISOString().slice(0, 10);

export function useBaixoGiro() {
  const { empresa } = useReposicaoEmpresa();

  const query = useQuery({
    queryKey: ["reposicao-baixo-giro", empresa],
    staleTime: 60_000,
    queryFn: async (): Promise<RowBaixoGiro[]> => {
      // 1) universo de baixo giro (cap defensivo 1000; baixo giro real < 1000)
      const { data: base, error } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie, sku_descricao, fornecedor_nome, classe_consolidada, demanda_media_diaria, valor_vendido_90d, estoque_minimo, ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao")
        .eq("empresa", empresa)
        .eq("ativo", true)
        .or("and(classe_abc.in.(B,C),classe_xyz.in.(Y,Z)),demanda_media_diaria.lt.0.05,estoque_minimo.is.null")
        .range(0, 999);
      if (error) throw error;
      const rowsBase = base ?? [];
      const codes = rowsBase.map((r) => Number(r.sku_codigo_omie));
      if (codes.length === 0) return [];

      // 2) enriquecimentos (.in)
      const [{ data: inv }, { data: dem }, { data: sug }] = await Promise.all([
        supabase.from("inventory_position").select("omie_codigo_produto, saldo, cmc").eq("account", empresa.toLowerCase()).in("omie_codigo_produto", codes),
        supabase.from("v_sku_demanda_estatisticas").select("sku_codigo_omie, ultima_venda_data").eq("empresa", empresa).in("sku_codigo_omie", codes),
        supabase.from("v_sku_parametros_sugeridos").select("sku_codigo_omie, status_sugestao").eq("empresa", empresa).in("sku_codigo_omie", codes),
      ]);
      const invMap = new Map((inv ?? []).map((r) => [Number(r.omie_codigo_produto), r]));
      const demMap = new Map((dem ?? []).map((r) => [Number(r.sku_codigo_omie), r]));
      const sugMap = new Map((sug ?? []).map((r) => [Number(r.sku_codigo_omie), r]));
      const hoje = HOJE_ISO();

      // 3) montar rows
      return rowsBase.map((r) => {
        const code = Number(r.sku_codigo_omie);
        const iv = invMap.get(code);
        const saldo = iv?.saldo ?? null;
        const cmc = iv?.cmc ?? null;
        const capital = saldo != null && saldo > 0 && cmc != null && cmc > 0 ? saldo * cmc : null;
        const status = sugMap.get(code)?.status_sugestao ?? null;
        const sit = classificarSituacao(status, r.estoque_minimo);
        return {
          id: String(code),
          sku_codigo_omie: code,
          sku_descricao: r.sku_descricao,
          fornecedor_nome: r.fornecedor_nome,
          classe_consolidada: r.classe_consolidada,
          saldo, cmc, capital_parado: capital,
          dias_sem_vender: diasSemVender(demMap.get(code)?.ultima_venda_data ?? null, hoje),
          demanda_media_diaria: r.demanda_media_diaria,
          valor_vendido_90d: r.valor_vendido_90d,
          status_sugestao: status,
          situacao_tipo: sit.tipo, situacao_label: sit.label, situacao_cta: sit.cta,
          estoque_minimo: r.estoque_minimo, ponto_pedido: r.ponto_pedido, estoque_maximo: r.estoque_maximo,
          habilitado_reposicao_automatica: r.habilitado_reposicao_automatica,
          tipo_reposicao: r.tipo_reposicao,
        };
      });
    },
  });

  const kpis = useMemo(() => {
    const rows = query.data ?? [];
    const cap = somarCapitalParado(rows.map((r) => ({ saldo: r.saldo, cmc: r.cmc })));
    return { ...cap, totalItens: rows.length };
  }, [query.data]);

  return { rows: query.data ?? [], kpis, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (sem erros novos). Se o supabase-js reclamar de colunas tipadas, alinhar ao padrão de `AdminReposicaoRevisao.tsx` (casts `as` pontuais já usados lá).

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/baixoGiro/types.ts src/components/reposicao/baixoGiro/useBaixoGiro.ts
git commit -m "feat(reposicao): hook useBaixoGiro (universo de cauda + enriquecimento)"
```

---

## Task 3: Mutations no hook (manter 1/2, descontinuar)

**Files:**
- Modify: `src/components/reposicao/baixoGiro/useBaixoGiro.ts`

Adicionar ao hook duas mutations (padrão verbatim de `AdminReposicaoRevisao.tsx:254` updateMutation e `useDetalhesModal.ts:258` descontinuar). Manter 1/2 NÃO mexe em pedido pendente (item de baixo giro não estava comprando). Descontinuar reusa o update de `tipo_reposicao` (sem remoção de pedido aqui — item de cauda raramente tem pedido aberto; se tiver, o cron de geração não o re-inclui após `habilitado=false`).

- [ ] **Step 1: Adicionar imports e mutations**

```typescript
// no topo: adicionar
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// dentro de useBaixoGiro(), antes do return:
const qc = useQueryClient();

const manterEmEstoque = useMutation({
  mutationFn: async (args: { codes: number[]; min: number; ponto: number; max: number }) => {
    const { error } = await supabase
      .from("sku_parametros")
      .update({
        estoque_minimo: args.min,
        ponto_pedido: args.ponto,
        estoque_maximo: args.max,
        habilitado_reposicao_automatica: true,
        tipo_reposicao: "automatica",
      })
      .eq("empresa", empresa)
      .in("sku_codigo_omie", args.codes);
    if (error) throw error;
  },
  onSuccess: (_d, vars) => {
    toast.success(`${vars.codes.length} item(ns) com estoque mínimo definido`);
    qc.invalidateQueries({ queryKey: ["reposicao-baixo-giro"] });
  },
  onError: (e: Error) => toast.error("Falha ao salvar: " + e.message),
});

const descontinuar = useMutation({
  mutationFn: async (code: number) => {
    const { error } = await supabase
      .from("sku_parametros")
      .update({ tipo_reposicao: "descontinuado", habilitado_reposicao_automatica: false })
      .eq("empresa", empresa)
      .eq("sku_codigo_omie", code);
    if (error) throw error;
  },
  onSuccess: () => {
    toast.success("SKU descontinuado — fora dos próximos ciclos");
    qc.invalidateQueries({ queryKey: ["reposicao-baixo-giro"] });
  },
  onError: (e: Error) => toast.error("Falha ao descontinuar: " + e.message),
});

// no return, adicionar: manterEmEstoque, descontinuar
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck` → PASS.
```bash
git add src/components/reposicao/baixoGiro/useBaixoGiro.ts
git commit -m "feat(reposicao): mutations manter-1/2 e descontinuar no useBaixoGiro"
```

---

## Task 4: Componentes presentacionais (KPIs, filtros, tabela)

**Files:**
- Create: `src/components/reposicao/baixoGiro/BaixoGiroKpis.tsx`
- Create: `src/components/reposicao/baixoGiro/BaixoGiroFiltros.tsx`
- Create: `src/components/reposicao/baixoGiro/BaixoGiroTable.tsx`

Componentes **presentacionais controlados** (recebem dados/handlers por props; sem queries). Reusam `fmt`/`fmtBRL`/`classBadge` de `@/lib/reposicao/sku-param` e os primitivos shadcn (`Table`, `Button`, `Badge`, `Input`, `Select`, `Checkbox`) — seguir o uso exato de `src/pages/AdminReposicaoRevisao.tsx` e `src/components/reposicao/revisao/` como referência de estilo/import.

- [ ] **Step 1: `BaixoGiroKpis.tsx`** — props `{ totalRs: number; semCustoN: number; comEstoqueN: number; totalItens: number }`. Renderiza cards: "Capital parado" = `fmtBRL(totalRs)` + subtexto "+ N SKUs sem custo conhecido" quando `semCustoN>0` (nunca exibir R$0 como se fosse tudo); "Itens na cauda" = `totalItens`; "Com estoque parado" = `comEstoqueN`. Card grande estilo cockpit (ver `.kpi-value` no index.css).

```tsx
// src/components/reposicao/baixoGiro/BaixoGiroKpis.tsx
import { fmtBRL } from "@/lib/reposicao/sku-param";

export function BaixoGiroKpis({ totalRs, semCustoN, comEstoqueN, totalItens }: {
  totalRs: number; semCustoN: number; comEstoqueN: number; totalItens: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Capital parado na cauda</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(totalRs)}</div>
        {semCustoN > 0 && (
          <div className="text-xs text-status-warning">+ {semCustoN} SKU(s) sem custo conhecido</div>
        )}
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Itens na cauda</div>
        <div className="kpi-value text-2xl font-semibold tnum">{totalItens}</div>
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Com estoque parado</div>
        <div className="kpi-value text-2xl font-semibold tnum">{comEstoqueN}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `BaixoGiroFiltros.tsx`** — props `{ filtros: FiltrosBaixoGiro; onChange: (f: FiltrosBaixoGiro) => void }`. Um `Select` de situação (opções: Todos, Sem preço, Sem fornecedor, Aguardando grupo, Sem lead time, Aguardando 2ª compra, Sem parâmetro, Em dia — values = `SituacaoTipo|'todos'`), um `Select` de estoque (Todos / Com estoque / Sem estoque), e um `Input` de busca (código ou descrição). Apenas chama `onChange` com o objeto novo. Seguir o estilo dos filtros de `AdminReposicaoRevisao.tsx`.

- [ ] **Step 3: `BaixoGiroTable.tsx`** — props:
```typescript
{
  rows: RowBaixoGiro[];
  selected: Set<number>;
  onToggle: (code: number) => void;
  onToggleAll: (codes: number[]) => void;
  onResolverBloqueio: (row: RowBaixoGiro) => void;  // navega/abre conforme situacao_tipo
  onManter: (row: RowBaixoGiro) => void;            // abre ManterEmEstoqueDialog (1 item)
  onDescontinuar: (row: RowBaixoGiro) => void;
}
```
Colunas: checkbox · SKU+descrição · fornecedor · classe (`classBadge`) · **Capital parado** (`fmtBRL(row.capital_parado)` ou "sem custo" se null e saldo>0; "—" se saldo 0) · Estoque (saldo) · Dias sem vender · Giro (`fmt(demanda_media_diaria,3)`/dia) · **Situação** (badge `situacao_label`; cor: `resolver_bloqueio`→warning, `em_dia`→success, resto→muted) · Ações. Coluna Ações por linha: botão primário conforme `situacao_cta` (`resolver_bloqueio`→"Resolver", `cold_start`→"Promover/Manter", `manter_ou_descontinuar`/`em_dia`→"Manter 1/2") + menu com "Descontinuar". Ordenar por `capital_parado` desc (nulls por último) por padrão. Usar `Table` shadcn como em `AdminReposicaoRevisao`.

- [ ] **Step 4: Typecheck + commit**

Run: `bun run typecheck` → PASS.
```bash
git add src/components/reposicao/baixoGiro/BaixoGiroKpis.tsx src/components/reposicao/baixoGiro/BaixoGiroFiltros.tsx src/components/reposicao/baixoGiro/BaixoGiroTable.tsx
git commit -m "feat(reposicao): KPIs, filtros e tabela do painel de baixo giro"
```

---

## Task 5: Dialog "Manter em estoque" com preview

**Files:**
- Create: `src/components/reposicao/baixoGiro/ManterEmEstoqueDialog.tsx`

Dialog controlado para 1 item OU lote. Campos: mín (default 1), ponto de pedido (default 1), máx (default 2), **motivo** (textarea, obrigatório). Mostra **preview** (via `previewManterLote` sobre os itens-alvo, usando `saldo` como `posicao` e `cmc` como `custo`): "Isto vai gerar compra de ~X un = R$ Y no próximo ciclo" + aviso "(N sem custo)" se houver. Botão confirmar desabilitado sem motivo. Ao confirmar, chama `onConfirm({ codes, min, ponto, max })` (o motivo é registrado no toast/log local — não há coluna de motivo em `sku_parametros`; documentar como não persistido na v1).

```tsx
// src/components/reposicao/baixoGiro/ManterEmEstoqueDialog.tsx
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { previewManterLote } from "@/lib/reposicao/baixo-giro-helpers";
import { fmtBRL } from "@/lib/reposicao/sku-param";
import type { RowBaixoGiro } from "./types";

export function ManterEmEstoqueDialog({ open, onOpenChange, alvos, onConfirm, saving }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  alvos: RowBaixoGiro[];
  onConfirm: (args: { codes: number[]; min: number; ponto: number; max: number; motivo: string }) => void;
  saving: boolean;
}) {
  const [min, setMin] = useState("1");
  const [ponto, setPonto] = useState("1");
  const [max, setMax] = useState("2");
  const [motivo, setMotivo] = useState("");

  const preview = useMemo(() => previewManterLote(
    alvos.map((a) => ({ ppAtual: a.ponto_pedido, maxAtual: a.estoque_maximo, posicao: a.saldo ?? 0, custo: a.cmc })),
    Number(ponto) || 0, Number(max) || 0,
  ), [alvos, ponto, max]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Manter em estoque — {alvos.length} item(ns)</DialogTitle></DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Mínimo</Label><Input type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div><Label>Ponto de pedido</Label><Input type="number" value={ponto} onChange={(e) => setPonto(e.target.value)} /></div>
          <div><Label>Máximo</Label><Input type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
        <div className="rounded-md border bg-accent/30 p-3 text-sm">
          Vai gerar compra de <strong>~{preview.qtdeTotal} un</strong> = <strong>{fmtBRL(preview.valorTotalRs)}</strong> no próximo ciclo
          {preview.semCustoN > 0 && <span className="text-status-warning"> (+{preview.semCustoN} sem custo)</span>}.
        </div>
        <div><Label>Motivo (obrigatório)</Label><Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: sortimento — não perder venda" /></div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!motivo.trim() || saving} onClick={() => onConfirm({ codes: alvos.map((a) => a.sku_codigo_omie), min: Number(min), ponto: Number(ponto), max: Number(max), motivo })}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step: Typecheck + commit**

Run: `bun run typecheck` → PASS.
```bash
git add src/components/reposicao/baixoGiro/ManterEmEstoqueDialog.tsx
git commit -m "feat(reposicao): dialog manter-em-estoque com preview de compra"
```

---

## Task 6: Página fina + rota + menu

**Files:**
- Create: `src/pages/AdminReposicaoBaixoGiro.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Página** — compõe `useBaixoGiro` + os componentes. Estado local: `filtros` (default `{situacao:'todos', estoque:'todos', busca:''}`), `selected: Set<number>`, `dialogAlvos: RowBaixoGiro[] | null`. Filtra `rows` no front pelos `filtros` (situação por `situacao_tipo`; estoque por `saldo>0`/`saldo<=0`; busca por código ou `ilike` na descrição). `onResolverBloqueio` (v1) abre toast informativo com o caminho do cadastro (navegação fina vira follow-up). `onManter` seta `dialogAlvos=[row]`; ação em lote seta `dialogAlvos=rows selecionados`. `onConfirm` do dialog chama `manterEmEstoque.mutate(...)` e fecha. Header com `font-display` (padrão cockpit). Gate: a rota já é `managerOnly` no menu; a página assume staff (mesmo das telas vizinhas).

Esqueleto:
```tsx
// src/pages/AdminReposicaoBaixoGiro.tsx
import { useMemo, useState } from "react";
import { useBaixoGiro } from "@/components/reposicao/baixoGiro/useBaixoGiro";
import { BaixoGiroKpis } from "@/components/reposicao/baixoGiro/BaixoGiroKpis";
import { BaixoGiroFiltros } from "@/components/reposicao/baixoGiro/BaixoGiroFiltros";
import { BaixoGiroTable } from "@/components/reposicao/baixoGiro/BaixoGiroTable";
import { ManterEmEstoqueDialog } from "@/components/reposicao/baixoGiro/ManterEmEstoqueDialog";
import type { FiltrosBaixoGiro, RowBaixoGiro } from "@/components/reposicao/baixoGiro/types";
import { toast } from "sonner";

export default function AdminReposicaoBaixoGiro() {
  const { rows, kpis, isLoading, manterEmEstoque, descontinuar } = useBaixoGiro();
  const [filtros, setFiltros] = useState<FiltrosBaixoGiro>({ situacao: "todos", estoque: "todos", busca: "" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialogAlvos, setDialogAlvos] = useState<RowBaixoGiro[] | null>(null);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filtros.situacao !== "todos" && r.situacao_tipo !== filtros.situacao) return false;
      if (filtros.estoque === "com_estoque" && !(r.saldo && r.saldo > 0)) return false;
      if (filtros.estoque === "sem_estoque" && r.saldo && r.saldo > 0) return false;
      const s = filtros.busca.trim().toLowerCase();
      if (s) {
        const byCode = /^\d+$/.test(s) ? String(r.sku_codigo_omie).includes(s) : false;
        const byDesc = (r.sku_descricao ?? "").toLowerCase().includes(s);
        if (!byCode && !byDesc) return false;
      }
      return true;
    });
  }, [rows, filtros]);

  return (
    <div className="space-y-4 p-4">
      <header><h1 className="font-display text-3xl">Baixo giro & estoque parado</h1></header>
      <BaixoGiroKpis {...kpis} />
      <BaixoGiroFiltros filtros={filtros} onChange={setFiltros} />
      <BaixoGiroTable
        rows={filtered}
        selected={selected}
        onToggle={(c) => setSelected((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; })}
        onToggleAll={(codes) => setSelected((s) => s.size === codes.length ? new Set() : new Set(codes))}
        onResolverBloqueio={(r) => toast.info(`Resolver: ${r.situacao_label} — ${r.sku_descricao}`)}
        onManter={(r) => setDialogAlvos([r])}
        onDescontinuar={(r) => descontinuar.mutate(r.sku_codigo_omie)}
      />
      {selected.size > 0 && (
        <button className="..." onClick={() => setDialogAlvos(filtered.filter((r) => selected.has(r.sku_codigo_omie)))}>
          Manter 1/2 nos {selected.size} selecionados
        </button>
      )}
      <ManterEmEstoqueDialog
        open={!!dialogAlvos}
        onOpenChange={(v) => !v && setDialogAlvos(null)}
        alvos={dialogAlvos ?? []}
        saving={manterEmEstoque.isPending}
        onConfirm={(args) => { manterEmEstoque.mutate(args, { onSuccess: () => { setDialogAlvos(null); setSelected(new Set()); } }); }}
      />
      {isLoading && <div className="text-sm text-muted-foreground">Carregando…</div>}
    </div>
  );
}
```

- [ ] **Step 2: Rota em `App.tsx`** — adicionar lazy import junto aos outros `AdminReposicao*` (~linha 116-138) e a Route na seção non-session (~linha 293-309):

```typescript
const AdminReposicaoBaixoGiro = lazy(() => import("./pages/AdminReposicaoBaixoGiro"));
// ...
<Route path="admin/reposicao/baixo-giro" element={<AdminReposicaoBaixoGiro />} />
```

- [ ] **Step 3: Menu em `AppShell.tsx`** — adicionar item ao array da seção `'Reposição'` (~linha 93-101), reusando um ícone já importado (ex.: `AlertTriangle` ou `PackageX`; conferir os imports de ícones do arquivo e usar um existente, ou adicionar o import):

```typescript
{ icon: AlertTriangle, label: 'Baixo giro', path: '/admin/reposicao/baixo-giro', managerOnly: true },
```

- [ ] **Step 4: Verificação — build + typecheck + lint + test**

Run: `bun run typecheck && bun run test && bun lint && bun run build`
Expected: tudo PASS. (Build confirma que o lazy import resolve e a rota monta.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/AdminReposicaoBaixoGiro.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(reposicao): pagina, rota e menu do painel de baixo giro"
```

---

## Self-Review (checklist)

**Spec coverage:**
- Capital parado (KPI, cmc-null honesto) → Task 1 (`somarCapitalParado`) + Task 4 (BaixoGiroKpis). ✓
- Tabela com situação/dias sem vender/giro → Task 2 (hook) + Task 4 (table). ✓
- Filtros por facetas independentes (situação/estoque/busca) → Task 2 (tipos) + Task 4/6. ✓
- Ação resolver bloqueio (CTA por situação) → Task 1 (`classificarSituacao.cta`) + Task 6 (`onResolverBloqueio` — v1 toast; navegação fina = follow-up). ✓
- Ação manter 1/2 com motivo + preview → Task 3 (mutation) + Task 5 (dialog + `previewManterLote`). ✓
- Ação descontinuar → Task 3. ✓
- Sem trava / sem migration money-path → nenhuma task de migration (correto, spec §7). ✓
- Persistência do 1/2 (cron preserva) → garantido pela core existente; **critério de pronto valida com 1 SKU** (smoke manual pelo founder após publish). ✓

**Sem promoção de venda na v1** (spec §3/§10) — nenhuma task. ✓

**Type consistency:** `RowBaixoGiro`/`FiltrosBaixoGiro`/`SituacaoTipo`/`SituacaoCta` definidos em Task 1-2 e usados consistentes em 4-6. `impactoSimulado` reusado com a assinatura real (Task 1/5). Mutations `manterEmEstoque`/`descontinuar` nomeadas igual em Task 3 e Task 6. ✓

**Limitações conhecidas (documentar no PR):**
- Posição do preview = `inventory_position.saldo` (aproximação; gatilho real usa `sku_estoque_atual` + em-trânsito). Item de cauda → desvio ~0.
- Motivo do "manter 1/2" não é persistido (sem coluna; fica no toast/uso). Coluna de auditoria = follow-up se necessário.
- `onResolverBloqueio` v1 = toast informativo; deep-link pra cada cadastro = follow-up.
- Universo capado em 1000 linhas (baixo giro real < 1000; se crescer, paginar ou criar view `v_reposicao_baixo_giro`).

**⚠️ Deploy:** feature 100% frontend → após merge, **Publish no Lovable** pro ar (sem migration, sem edge).
