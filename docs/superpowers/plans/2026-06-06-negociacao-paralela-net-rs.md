# Negociação Paralela v2 — fila por R$ líquido — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescrever `/admin/reposicao/negociacao-paralela` para uma fila Top 3 priorizada por R$ líquido (economia do desconto − custo do capital parado), substituindo o ranking por percentil que faz "tudo virar prioritário".

**Architecture:** Client-side sobre a view `v_sku_parametros_sugeridos` (que já entrega CMC, preço de compra, giro e custo de capital — padrão do Otimizador de Compras) + helper puro TDD com o modelo financeiro. Mantém o fluxo de registrar negociação → campanha flat. Migration mínima desliga o cron diário e limpa as sugestões empilhadas (sem dropar a matview, que ainda alimenta a view de sugestões).

**Tech Stack:** React 18 + TS, @tanstack/react-query, shadcn/ui, Supabase (PostgREST + SQL via Lovable), vitest. Base: spec `docs/superpowers/specs/2026-06-06-negociacao-paralela-net-rs-design.md`.

**Decisão de implementação (refina o spec):** detecção automática de promoção fica para v2. Na v1, o desconto é 100% controlado pelo usuário no card (default 8%); uma nota orienta "em promoção, o máximo costuma ser ~3%". Remove dependência de query incerta de promoção.

---

## Estrutura de arquivos

- **Criar** `src/lib/reposicao/negociacao-valor-helpers.ts` — modelo financeiro puro (fórmulas net/teto/prêmio). Oráculo testável.
- **Criar** `src/lib/reposicao/__tests__/negociacao-valor-helpers.test.ts` — testes vitest.
- **Modificar** `src/components/reposicao/negociacaoParalela/types.ts` — adiciona tipos `LinhaViewSugeridos`, `CandidatoNegociacao`.
- **Criar** `src/components/reposicao/negociacaoParalela/OportunidadeCard.tsx` — card da fila com controle de desconto + net/teto.
- **Reescrever** `src/components/reposicao/negociacaoParalela/useNegociacaoParalela.ts` — hook v2 (fila Top 3 + em andamento + handlers).
- **Reescrever** `src/pages/AdminReposicaoNegociacaoParalela.tsx` — Top 3 + Em andamento; remove ranking/sugestões diárias.
- **Criar** `supabase/migrations/20260606180000_negociacao_paralela_v2_cleanup.sql` — desliga cron diário + ignora as sugestões empilhadas.
- **Reusar sem alterar:** `dialogs.tsx` (`ConverterDialog`, `FecharSemAcordoDialog`), `SugestaoCard.tsx` (seção "Em andamento"), `helpers.ts` (`formatBRL`).
- **Deixar dormente (não remover):** `RankingTable.tsx`, `RankingToolbar.tsx`, `RankingPaginacao.tsx`, `DistribuicaoCards.tsx`, `SugestoesToolbar.tsx` (deixam de ser importados; remoção física = limpeza posterior).

---

## Task 1: Helper de valor (núcleo financeiro, TDD)

**Files:**
- Create: `src/lib/reposicao/negociacao-valor-helpers.ts`
- Test: `src/lib/reposicao/__tests__/negociacao-valor-helpers.test.ts`

- [ ] **Step 1: Escrever os testes (falham primeiro)**

```typescript
import { describe, it, expect } from 'vitest';
import {
  clampDesconto, premioAnual, loteOtimo, netNoLote, netNoOtimo, avaliarNegociacao,
  DESCONTO_PADRAO,
} from '../negociacao-valor-helpers';
import type { InsumoNegociacao } from '../negociacao-valor-helpers';

describe('clampDesconto', () => {
  it('mantém desconto válido', () => {
    expect(clampDesconto(0.07)).toBe(0.07);
    expect(clampDesconto(0.10)).toBe(0.10);
  });
  it('inválido/≤0/NaN → default 8%', () => {
    expect(clampDesconto(0)).toBe(DESCONTO_PADRAO);
    expect(clampDesconto(-0.05)).toBe(DESCONTO_PADRAO);
    expect(clampDesconto(NaN)).toBe(DESCONTO_PADRAO);
  });
  it('clampeia acima de 50%', () => {
    expect(clampDesconto(0.9)).toBe(0.5);
  });
});

describe('premioAnual = δ·p·A', () => {
  it('caso simples', () => {
    expect(premioAnual(0.10, 10, 100)).toBeCloseTo(100, 4);
  });
  it('falta preço de compra → null', () => {
    expect(premioAnual(0.10, null, 100)).toBeNull();
    expect(premioAnual(0.10, 0, 100)).toBeNull();
  });
  it('sem giro (A≤0) → null', () => {
    expect(premioAnual(0.10, 10, 0)).toBeNull();
  });
});

describe('loteOtimo = δ·p·A/(c·k) e netNoOtimo = (δp)²·A/(2ck)', () => {
  it('caso simples (A=100,p=10,c=10,k=0.2,δ=0.1)', () => {
    expect(loteOtimo(0.10, 10, 10, 100, 0.20)).toBeCloseTo(50, 4);
    expect(netNoOtimo(0.10, 10, 10, 100, 0.20)).toBeCloseTo(25, 4);
  });
  it('p<c reduz o lote ótimo e o net (A=100,p=9,c=10,k=0.2,δ=0.1)', () => {
    expect(loteOtimo(0.10, 9, 10, 100, 0.20)).toBeCloseTo(45, 4);
    expect(netNoOtimo(0.10, 9, 10, 100, 0.20)).toBeCloseTo(20.25, 4);
  });
  it('falta c → null (sem CMC)', () => {
    expect(loteOtimo(0.10, 9, null, 100, 0.20)).toBeNull();
    expect(netNoOtimo(0.10, 9, null, 100, 0.20)).toBeNull();
  });
});

describe('netNoLote = δ·p·Q − c·k·Q²/(2A)', () => {
  it('no lote ótimo bate com netNoOtimo', () => {
    // Q*=50; net=0.1·10·50 − 10·0.2·2500/(200) = 50 − 25 = 25
    expect(netNoLote(0.10, 10, 10, 100, 0.20, 50)).toBeCloseTo(25, 4);
  });
  it('acima do teto (Q=2·Q*) o net zera', () => {
    expect(netNoLote(0.10, 10, 10, 100, 0.20, 100)).toBeCloseTo(0, 4);
  });
});

describe('avaliarNegociacao — caso real CATALISADOR (base separada)', () => {
  const ins: InsumoNegociacao = {
    sku_codigo_omie: '8689743956',
    sku_descricao: 'CATALISADOR FC.6975LT',
    consumo_anual: 287.9,
    preco_compra: 436.84,
    cmc: 536.48,
    custo_capital_anual: 0.258,
  };
  it('δ=8%: prêmio ~10.061, lote ~72,7, net ~1.270, ~3 meses', () => {
    const r = avaliarNegociacao(ins, 0.08);
    expect(r.elegivel).toBe(true);
    expect(r.premio_anual).toBeCloseTo(10061.30, 0);
    expect(r.lote_otimo).toBeCloseTo(72.69, 1);
    expect(r.teto_volume).toBeCloseTo(145.38, 1);
    expect(r.net_negociacao).toBeCloseTo(1270.17, 0);
    expect(r.meses_otimo).toBeCloseTo(3.03, 1);
    expect(r.meses_teto).toBeCloseTo(6.06, 1);
  });
  it('δ=7% (gerente devolveu menos): prêmio ~8.804, net ~972', () => {
    const r = avaliarNegociacao(ins, 0.07);
    expect(r.premio_anual).toBeCloseTo(8803.64, 0);
    expect(r.net_negociacao).toBeCloseTo(972.48, 0);
  });
});

describe('avaliarNegociacao — degradação honesta', () => {
  const base: InsumoNegociacao = {
    sku_codigo_omie: 'x', sku_descricao: 'x', consumo_anual: 100,
    preco_compra: 10, cmc: 10, custo_capital_anual: 0.2,
  };
  it('sem giro → inelegível motivo sem_giro', () => {
    const r = avaliarNegociacao({ ...base, consumo_anual: 0 }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_giro');
    expect(r.net_negociacao).toBeNull();
  });
  it('sem preço de compra → inelegível sem_preco_compra', () => {
    const r = avaliarNegociacao({ ...base, preco_compra: null }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_preco_compra');
  });
  it('sem CMC → inelegível sem_cmc, mas ainda mostra prêmio (custo a confirmar)', () => {
    const r = avaliarNegociacao({ ...base, cmc: null }, 0.08);
    expect(r.elegivel).toBe(false);
    expect(r.motivo_inelegivel).toBe('sem_cmc');
    expect(r.premio_anual).toBeCloseTo(80, 4); // δ(0.08) · p(10) · A(100) = 80 — prêmio sobrevive sem CMC
    expect(r.net_negociacao).toBeNull();
    expect(r.lote_otimo).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test src/lib/reposicao/__tests__/negociacao-valor-helpers.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar o helper**

```typescript
// src/lib/reposicao/negociacao-valor-helpers.ts
// Modelo de valor da Negociação Paralela (desconto flat condicional Sayerlack).
// Base de custo SEPARADA: economia sobre o preço de compra (p); capital parado sobre o CMC (c).
// Módulo puro (TDD). Espelha o spec docs/superpowers/specs/2026-06-06-negociacao-paralela-net-rs-design.md.
//
//   economia(Q)       = δ·p·Q
//   custo_carregar(Q) = c·k·Q²/(2A)        (estoque médio Q/2 pelo tempo Q/d; base-estoque ~0, conservador)
//   net(Q)            = economia − custo_carregar
//   lote ótimo  Q*    = δ·p·A/(c·k)
//   teto        Qmax  = 2·Q*               (net = 0)
//   net no ótimo      = (δ·p)²·A/(2·c·k)
//   prêmio anual      = δ·p·A              (ordena a fila)

export const DESCONTO_PADRAO = 0.08;

export interface InsumoNegociacao {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  consumo_anual: number;        // A (un/ano) = demanda_media_diaria × 365
  preco_compra: number | null;  // p (R$/un) = preco_compra_real
  cmc: number | null;           // c (R$/un) = CMC do Omie (só quando fonte_preco='cmc')
  custo_capital_anual: number;  // k (fração/ano) = custo_capital_efetivo_perc / 100
}

export type MotivoInelegivel = 'sem_giro' | 'sem_preco_compra' | 'sem_cmc';

export interface ValorNegociacao {
  elegivel: boolean;
  motivo_inelegivel: MotivoInelegivel | null;
  desconto_aplicado: number;
  premio_anual: number | null;
  net_negociacao: number | null;
  lote_otimo: number | null;
  teto_volume: number | null;
  meses_otimo: number | null;
  meses_teto: number | null;
}

function positivo(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

export function clampDesconto(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return DESCONTO_PADRAO;
  return Math.min(d, 0.5);
}

export function premioAnual(delta: number, p: number | null, A: number): number | null {
  if (!positivo(p) || !positivo(A)) return null;
  return delta * p * A;
}

export function loteOtimo(delta: number, p: number | null, c: number | null, A: number, k: number): number | null {
  if (!positivo(p) || !positivo(c) || !positivo(A) || !positivo(k)) return null;
  return (delta * p * A) / (c * k);
}

export function netNoLote(delta: number, p: number, c: number, A: number, k: number, Q: number): number {
  return delta * p * Q - (c * k * Q * Q) / (2 * A);
}

export function netNoOtimo(delta: number, p: number | null, c: number | null, A: number, k: number): number | null {
  if (!positivo(p) || !positivo(c) || !positivo(A) || !positivo(k)) return null;
  return ((delta * p) ** 2 * A) / (2 * c * k);
}

export function avaliarNegociacao(ins: InsumoNegociacao, descontoPedido: number): ValorNegociacao {
  const delta = clampDesconto(descontoPedido);
  const A = ins.consumo_anual;
  const vazio = {
    desconto_aplicado: delta, premio_anual: null, net_negociacao: null,
    lote_otimo: null, teto_volume: null, meses_otimo: null, meses_teto: null,
  };
  if (!positivo(A)) return { elegivel: false, motivo_inelegivel: 'sem_giro', ...vazio };
  if (!positivo(ins.preco_compra)) return { elegivel: false, motivo_inelegivel: 'sem_preco_compra', ...vazio };

  const premio = premioAnual(delta, ins.preco_compra, A);
  if (!positivo(ins.cmc)) {
    return { elegivel: false, motivo_inelegivel: 'sem_cmc', ...vazio, premio_anual: premio };
  }
  const Qstar = loteOtimo(delta, ins.preco_compra, ins.cmc, A, ins.custo_capital_anual)!;
  const Qmax = 2 * Qstar;
  const giroMes = A / 12;
  return {
    elegivel: true,
    motivo_inelegivel: null,
    desconto_aplicado: delta,
    premio_anual: premio,
    net_negociacao: netNoOtimo(delta, ins.preco_compra, ins.cmc, A, ins.custo_capital_anual),
    lote_otimo: Qstar,
    teto_volume: Qmax,
    meses_otimo: Qstar / giroMes,
    meses_teto: Qmax / giroMes,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test src/lib/reposicao/__tests__/negociacao-valor-helpers.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/negociacao-valor-helpers.ts src/lib/reposicao/__tests__/negociacao-valor-helpers.test.ts
git commit -m "feat(reposição): helper de valor da Negociação Paralela (net-R\$ marginal, TDD)"
```

---

## Task 2: Tipos da fila

**Files:**
- Modify: `src/components/reposicao/negociacaoParalela/types.ts` (append ao fim)

- [ ] **Step 1: Adicionar os tipos**

```typescript
// --- Negociação Paralela v2 (fila por R$ líquido) ---

// Linha crua da view v_sku_parametros_sugeridos (subset usado pela fila).
export interface LinhaViewSugeridos {
  sku_codigo_omie: number | string;
  sku_descricao: string | null;
  demanda_media_diaria: number | null;
  preco_compra_real: number | null;
  preco_item_eoq: number | null;     // = CMC quando fonte_preco='cmc'
  fonte_preco: string | null;        // 'cmc' | 'compra_real' | 'venda_estimado' | 'sem_preco'
  custo_capital_efetivo_perc: number | null; // %/ano
}

// Candidato pronto pra UI: identidade + insumos + avaliação corrente (recalculada com o desconto do card).
export interface CandidatoNegociacao {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  consumo_anual: number;
  preco_compra: number | null;
  cmc: number | null;            // só quando fonte_preco='cmc'
  custo_capital_anual: number;
  gasto_anual: number | null;    // preco_compra × consumo_anual (referência exibida)
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/negociacaoParalela/types.ts
git commit -m "feat(reposição): tipos da fila de negociação por R\$ líquido"
```

---

## Task 3: Hook v2 (reescrita)

**Files:**
- Modify (reescreve o corpo): `src/components/reposicao/negociacaoParalela/useNegociacaoParalela.ts`

Mantém o fluxo de conversão/sem-acordo (reusa `converter_sugestao_em_campanha_flat` e os states/handlers do dialog), troca a fonte de dados (ranking/percentil → fila por R$) e o gatilho (geração em massa → "vou negociar").

- [ ] **Step 1: Substituir o conteúdo inteiro do arquivo**

```typescript
// Camada de dados/lógica da Negociação Paralela v2 — fila por R$ líquido.
// Fonte: v_sku_parametros_sugeridos (CMC, preço de compra, giro, custo de capital).
// Mantém o ciclo de vida em sugestao_negociacao_paralela (status acao_tomada) e a conversão em campanha flat.
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { EMPRESA, type Sugestao, type ConvertForm, type LinhaViewSugeridos, type CandidatoNegociacao } from "./types";
import { lastDayOfNextMonth } from "./helpers";
import { avaliarNegociacao, clampDesconto, DESCONTO_PADRAO } from "@/lib/reposicao/negociacao-valor-helpers";

const TOP_N = 3;
const FORNECEDOR = "RENNER SAYERLACK S/A";

export function useNegociacaoParalela() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // desconto pedido por SKU (controle do card); default 8%.
  const [descontoPorSku, setDescontoPorSku] = useState<Record<string, number>>({});
  const [convertTarget, setConvertTarget] = useState<Sugestao | null>(null);
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    desconto_perc: 8, volume_minimo: 0, volume_unidade: "unidades",
    data_fim: lastDayOfNextMonth(), responsavel: "", canal: "ligacao", observacoes: "",
  });
  const [convertSubmitting, setConvertSubmitting] = useState(false);
  const [fecharSemAcordoTarget, setFecharSemAcordoTarget] = useState<Sugestao | null>(null);
  const [fecharObs, setFecharObs] = useState("");

  // Fonte da fila: candidatos Sayerlack com insumos de custo/giro.
  const { data: linhas = [], isLoading: loadingFila } = useQuery({
    queryKey: ["neg-paralela-fila", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sku_parametros_sugeridos" as never)
        .select(
          "sku_codigo_omie, sku_descricao, demanda_media_diaria, preco_compra_real, preco_item_eoq, fonte_preco, custo_capital_efetivo_perc, fornecedor_nome, empresa" as never,
        )
        .eq("empresa", EMPRESA)
        .ilike("fornecedor_nome", "%SAYERLACK%");
      if (error) throw error;
      return (data ?? []) as unknown as LinhaViewSugeridos[];
    },
    staleTime: 60_000,
  });

  // Negociações que o usuário decidiu perseguir (status acao_tomada).
  const { data: emAndamento = [], isLoading: loadingAndamento } = useQuery({
    queryKey: ["neg-paralela-andamento", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sugestao_negociacao_ativa" as never)
        .select("*")
        .eq("empresa", EMPRESA)
        .eq("status", "acao_tomada");
      if (error) throw error;
      return (data ?? []) as unknown as Sugestao[];
    },
    staleTime: 30_000,
  });

  // Monta candidatos (identidade + insumos), com gasto anual = preco_compra × consumo.
  const candidatos = useMemo<CandidatoNegociacao[]>(() => {
    return linhas.map((l) => {
      const sku = String(l.sku_codigo_omie);
      const A = Number(l.demanda_media_diaria ?? 0) * 365;
      const p = l.preco_compra_real != null ? Number(l.preco_compra_real) : null;
      const cmc = l.fonte_preco === "cmc" && l.preco_item_eoq != null ? Number(l.preco_item_eoq) : null;
      const k = Number(l.custo_capital_efetivo_perc ?? 0) / 100;
      return {
        sku_codigo_omie: sku,
        sku_descricao: l.sku_descricao,
        consumo_anual: A,
        preco_compra: p,
        cmc,
        custo_capital_anual: k,
        gasto_anual: p != null && A > 0 ? p * A : null,
      };
    });
  }, [linhas]);

  const descontoDe = (sku: string) => clampDesconto(descontoPorSku[sku] ?? DESCONTO_PADRAO);

  // Fila Top 3: só elegíveis (têm preço de compra E cmc E giro), ordenados por prêmio anual.
  const fila = useMemo(() => {
    const avaliados = candidatos.map((c) => ({
      candidato: c,
      // ordenação usa o desconto-base (8%); a ordem por gasto independe do δ.
      avaliacao: avaliarNegociacao(
        { sku_codigo_omie: c.sku_codigo_omie, sku_descricao: c.sku_descricao, consumo_anual: c.consumo_anual, preco_compra: c.preco_compra, cmc: c.cmc, custo_capital_anual: c.custo_capital_anual },
        DESCONTO_PADRAO,
      ),
    }));
    return avaliados
      .filter((a) => a.avaliacao.elegivel)
      .sort((a, b) => (b.avaliacao.premio_anual ?? 0) - (a.avaliacao.premio_anual ?? 0))
      .slice(0, TOP_N);
  }, [candidatos]);

  const setDesconto = (sku: string, perc: number) =>
    setDescontoPorSku((prev) => ({ ...prev, [sku]: perc }));

  // "Vou negociar este" → cria sugestão acao_tomada (puxa da fila pro acompanhamento).
  const handleVouNegociar = async (c: CandidatoNegociacao) => {
    try {
      const validoAte = new Date();
      validoAte.setDate(validoAte.getDate() + 30);
      const { error } = await supabase.from("sugestao_negociacao_paralela").insert({
        empresa: EMPRESA,
        sku_codigo_omie: c.sku_codigo_omie,
        sku_descricao: c.sku_descricao,
        motivo: "fila_net_rs",
        motivo_detalhes: { criado_via: "fila_v2", gasto_anual: c.gasto_anual },
        preco_medio_unitario: c.preco_compra,
        status: "acao_tomada",
        data_acao: new Date().toISOString(),
        data_geracao: new Date().toISOString().slice(0, 10),
        valido_ate: validoAte.toISOString().slice(0, 10),
      } as never);
      if (error) throw error;
      toast.success(`Negociação iniciada para ${c.sku_descricao ?? c.sku_codigo_omie}.`);
      queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
    } catch (err) {
      toast.error("Erro ao iniciar negociação: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const openConvertDialog = (s: Sugestao) => {
    setConvertTarget(s);
    setConvertForm({
      desconto_perc: 8, volume_minimo: 0, volume_unidade: "unidades",
      data_fim: lastDayOfNextMonth(), responsavel: "", canal: "ligacao", observacoes: "",
    });
  };

  const handleConverterConfirm = async () => {
    if (!convertTarget) return;
    if (convertForm.desconto_perc < 1 || convertForm.desconto_perc > 50) {
      toast.error("Desconto deve estar entre 1 e 50%."); return;
    }
    if (convertForm.volume_minimo <= 0) { toast.error("Volume mínimo deve ser maior que zero."); return; }
    setConvertSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("converter_sugestao_em_campanha_flat" as never, {
        p_sugestao_id: convertTarget.id,
        p_desconto_perc: convertForm.desconto_perc,
        p_volume_minimo: convertForm.volume_minimo,
        p_volume_unidade: convertForm.volume_unidade,
        p_data_fim: convertForm.data_fim,
        p_responsavel_nome: convertForm.responsavel || null,
        p_canal: convertForm.canal,
        p_observacoes: convertForm.observacoes || null,
      } as never);
      if (error) throw error;
      toast.success("Negociação convertida em campanha.");
      queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
      const campanhaId = typeof data === "number" || typeof data === "string" ? data : null;
      navigate(campanhaId ? `/admin/reposicao/promocoes/${campanhaId}` : `/admin/reposicao/promocoes`);
      setConvertTarget(null);
    } catch (err) {
      toast.error("Erro ao converter: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setConvertSubmitting(false);
    }
  };

  const handleFecharSemAcordoConfirm = async () => {
    if (!fecharSemAcordoTarget) return;
    const { error } = await supabase.from("sugestao_negociacao_paralela")
      .update({ status: "fechada_sem_acordo", observacoes: fecharObs || null, data_acao: new Date().toISOString() } as never)
      .eq("id", fecharSemAcordoTarget.id);
    if (error) { toast.error("Erro: " + error.message); return; }
    toast.success("Negociação encerrada sem acordo.");
    queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
    setFecharSemAcordoTarget(null);
    setFecharObs("");
  };

  return {
    loadingFila, loadingAndamento, fila, emAndamento,
    descontoDe, setDesconto, avaliarNegociacao, handleVouNegociar,
    convertTarget, setConvertTarget, convertForm, setConvertForm, convertSubmitting,
    openConvertDialog, handleConverterConfirm,
    fecharSemAcordoTarget, setFecharSemAcordoTarget, fecharObs, setFecharObs, handleFecharSemAcordoConfirm,
  };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS. (Se acusar campos faltando em `Sugestao`/insert, conferir que `data_acao` e `observacoes` existem na tabela — já usados no hook antigo.)

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/negociacaoParalela/useNegociacaoParalela.ts
git commit -m "feat(reposição): hook v2 da Negociação Paralela (fila Top 3 por R\$ + em andamento)"
```

---

## Task 4: Card de oportunidade

**Files:**
- Create: `src/components/reposicao/negociacaoParalela/OportunidadeCard.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
import { Handshake, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBRL } from "./helpers";
import type { CandidatoNegociacao } from "./types";
import { avaliarNegociacao } from "@/lib/reposicao/negociacao-valor-helpers";

interface Props {
  candidato: CandidatoNegociacao;
  descontoPerc: number; // ex.: 8
  onSetDesconto: (sku: string, perc: number) => void;
  onVouNegociar: (c: CandidatoNegociacao) => void;
}

function fmtUn(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)} un`;
}

export function OportunidadeCard({ candidato, descontoPerc, onSetDesconto, onVouNegociar }: Props) {
  const r = avaliarNegociacao(
    {
      sku_codigo_omie: candidato.sku_codigo_omie,
      sku_descricao: candidato.sku_descricao,
      consumo_anual: candidato.consumo_anual,
      preco_compra: candidato.preco_compra,
      cmc: candidato.cmc,
      custo_capital_anual: candidato.custo_capital_anual,
    },
    descontoPerc / 100,
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold leading-tight">{candidato.sku_descricao ?? candidato.sku_codigo_omie}</h3>
            <p className="text-xs text-muted-foreground font-tabular">{candidato.sku_codigo_omie}</p>
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Gasto/ano {formatBRL(candidato.gasto_anual)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controle de desconto */}
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={`desc-${candidato.sku_codigo_omie}`} className="text-xs">Desconto que você espera (%)</Label>
            <Input
              id={`desc-${candidato.sku_codigo_omie}`}
              type="number" min={1} max={50} step={1}
              value={descontoPerc}
              onChange={(e) => onSetDesconto(candidato.sku_codigo_omie, Number(e.target.value))}
              className="w-24 font-tabular"
            />
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug pb-1">
            Em promoção, o gerente costuma dar no máximo ~3%.
          </p>
        </div>

        {/* Números */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Economia/ano</p>
            <p className="kpi-value text-base">{formatBRL(r.premio_anual)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Sobra por negociação</p>
            <p className="kpi-value text-base">{formatBRL(r.net_negociacao)}</p>
          </div>
        </div>

        {/* Munição de negociação */}
        {r.elegivel ? (
          <div className="rounded-md bg-muted/50 border border-border p-3 text-sm">
            <div className="flex items-center gap-2 mb-1 text-status-success">
              <TrendingUp className="h-4 w-4" />
              <span className="font-medium">Quanto prometer</span>
            </div>
            <p className="text-foreground/90">
              Ideal <strong>{fmtUn(r.lote_otimo)}</strong> (~{r.meses_otimo?.toFixed(1)} meses de giro).
              Nunca acima de <strong>{fmtUn(r.teto_volume)}</strong> (~{r.meses_teto?.toFixed(1)} meses) —
              aí o capital parado come o desconto.
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-status-warning/10 border border-status-warning/30 p-3 text-sm text-status-warning">
            {r.motivo_inelegivel === "sem_cmc"
              ? "Custo a confirmar (sem CMC no Omie) — economia estimada, sem teto calculado."
              : "Dados insuficientes para calcular o teto."}
          </div>
        )}

        <Button onClick={() => onVouNegociar(candidato)} className="w-full" disabled={!r.elegivel}>
          <Handshake className="h-4 w-4 mr-2" />
          Vou negociar este
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/reposicao/negociacaoParalela/OportunidadeCard.tsx
git commit -m "feat(reposição): card de oportunidade da Negociação Paralela (controle de desconto + net/teto)"
```

---

## Task 5: Página v2 (reescrita)

**Files:**
- Modify (reescreve): `src/pages/AdminReposicaoNegociacaoParalela.tsx`

Remove os blocos de ranking (RankingTable/Toolbar/Paginacao/DistribuicaoCards) e o botão de gerar/atualizar; mostra Top 3 + Em andamento.

- [ ] **Step 1: Substituir o conteúdo inteiro**

```tsx
import { Handshake, Loader2, ClipboardList, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { HelpDrawer } from "@/components/help/HelpDrawer";
import { OportunidadeCard } from "@/components/reposicao/negociacaoParalela/OportunidadeCard";
import { SugestaoCard } from "@/components/reposicao/negociacaoParalela/SugestaoCard";
import { FecharSemAcordoDialog, ConverterDialog } from "@/components/reposicao/negociacaoParalela/dialogs";
import { useNegociacaoParalela } from "@/components/reposicao/negociacaoParalela/useNegociacaoParalela";
import { DESCONTO_PADRAO } from "@/lib/reposicao/negociacao-valor-helpers";

export default function AdminReposicaoNegociacaoParalela() {
  const {
    loadingFila, loadingAndamento, fila, emAndamento,
    descontoDe, setDesconto, handleVouNegociar,
    convertTarget, setConvertTarget, convertForm, setConvertForm, convertSubmitting,
    openConvertDialog, handleConverterConfirm,
    fecharSemAcordoTarget, setFecharSemAcordoTarget, fecharObs, setFecharObs, handleFecharSemAcordoConfirm,
  } = useNegociacaoParalela();

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-screen-2xl">
      <div className="space-y-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink href="/admin/reposicao/oportunidades">Reposição</BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>Negociação Paralela</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Handshake className="h-7 w-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Negociação Paralela</h1>
          </div>
          <HelpDrawer />
        </div>
      </div>

      <Card className="border-status-info/30 bg-status-info/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-status-info mt-0.5 shrink-0" />
          <p className="text-sm text-foreground/90 leading-relaxed">
            Os itens onde negociar um desconto com a Sayerlack rende mais dinheiro líquido — já descontando o
            custo do capital que fica parado em estoque. Ajuste o desconto que você espera e veja quanto prometer.
          </p>
        </CardContent>
      </Card>

      {/* Top 3 oportunidades */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Onde negociar este mês</h2>
          <p className="text-xs text-muted-foreground">Top 3 por dinheiro líquido (Sayerlack · OBEN).</p>
        </div>
        {loadingFila ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Calculando...
          </div>
        ) : fila.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nenhum candidato elegível (sem preço de compra/CMC).</p>
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {fila.map(({ candidato }) => (
              <OportunidadeCard
                key={candidato.sku_codigo_omie}
                candidato={candidato}
                descontoPerc={Math.round(descontoDe(candidato.sku_codigo_omie) * 100) || DESCONTO_PADRAO * 100}
                onSetDesconto={(sku, perc) => setDesconto(sku, perc / 100)}
                onVouNegociar={handleVouNegociar}
              />
            ))}
          </div>
        )}
      </section>

      {/* Em andamento */}
      <section className="space-y-4 pt-2">
        <div>
          <h2 className="text-lg font-semibold">Em andamento</h2>
          <p className="text-xs text-muted-foreground">Negociações que você decidiu perseguir.</p>
        </div>
        {loadingAndamento ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
          </div>
        ) : emAndamento.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma negociação em andamento.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {emAndamento.map((s) => (
              <SugestaoCard
                key={s.id}
                s={s}
                rankingExtra={undefined}
                onMarcarVisualizada={() => {}}
                onIrAoRanking={() => {}}
                onMarcarEmAndamento={() => {}}
                onIgnorar={() => {}}
                onFecharSemAcordo={(sug) => setFecharSemAcordoTarget(sug)}
                onConverter={openConvertDialog}
              />
            ))}
          </div>
        )}
      </section>

      <FecharSemAcordoDialog
        open={!!fecharSemAcordoTarget}
        onOpenChange={(o) => { if (!o) { setFecharSemAcordoTarget(null); setFecharObs(""); } }}
        obs={fecharObs}
        onObsChange={setFecharObs}
        onCancel={() => setFecharSemAcordoTarget(null)}
        onConfirm={handleFecharSemAcordoConfirm}
      />
      <ConverterDialog
        target={convertTarget}
        form={convertForm}
        setForm={setConvertForm}
        submitting={convertSubmitting}
        onOpenChange={(o) => !o && setConvertTarget(null)}
        onCancel={() => setConvertTarget(null)}
        onConfirm={handleConverterConfirm}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck + lint + build**

Run: `heavy bun run typecheck && heavy bun lint && heavy bun run build`
Expected: PASS. (`SugestaoCard` aceita os handlers no-op; se a prop `rankingExtra` for obrigatória, passar `undefined` é válido pelo tipo opcional — conferir a assinatura e ajustar para opcional se necessário.)

- [ ] **Step 3: Commit**

```bash
git add src/pages/AdminReposicaoNegociacaoParalela.tsx
git commit -m "feat(reposição): tela v2 da Negociação Paralela (Top 3 por R\$ + em andamento; remove ranking por percentil)"
```

---

## Task 6: Migration de limpeza (apply manual via Lovable)

**Files:**
- Create: `supabase/migrations/20260606180000_negociacao_paralela_v2_cleanup.sql`

Usa a skill `lovable-db-operator` para empacotar o apply manual. **NÃO dropa a matview** (`v_sugestao_negociacao_ativa` depende dela via LEFT JOIN; dropar quebra o badge da sidebar).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- Negociação Paralela v2: desliga a esteira diária que empilhava sugestões e limpa as pendentes.
-- A tela v2 calcula a fila Top 3 client-side sobre v_sku_parametros_sugeridos (não usa mais a matview de score).
-- A matview mv_sku_ranking_negociacao_paralela e a função de score ficam DORMENTES (não dropadas):
-- v_sugestao_negociacao_ativa faz LEFT JOIN com a matview (campo categoria) e o badge da sidebar a consome.
-- Limpeza física da matview/score = follow-up separado (mapear dependências antes).

-- 1) Desliga o cron de geração diária (10/dia, válido 14d → ~130 empilhadas).
SELECT cron.unschedule('afiacao_sugestoes_diarias');

-- 2) Limpa as sugestões empilhadas pela esteira (nova/visualizada), preservando as que viraram negociação real.
UPDATE public.sugestao_negociacao_paralela
SET status = 'ignorada'
WHERE empresa = 'OBEN'
  AND status IN ('nova', 'visualizada');

-- Validação:
SELECT 'NEG_V2_CLEANUP' AS bloco,
  (SELECT count(*) FROM cron.job WHERE jobname = 'afiacao_sugestoes_diarias') AS crons_geracao_restantes, -- esperado 0
  (SELECT count(*) FROM public.sugestao_negociacao_paralela
     WHERE empresa = 'OBEN' AND status IN ('nova','visualizada')) AS sugestoes_pendentes; -- esperado 0
```

- [ ] **Step 2: Entregar o bloco SQL na conversa (Lovable → SQL Editor)**

Apresentar o SQL acima rotulado "🟣 Lovable → SQL Editor → cola → Run" e aguardar o founder confirmar `crons_geracao_restantes=0` e `sugestoes_pendentes=0`.

- [ ] **Step 3: Regenerar o audit e commitar**

```bash
bun run audit:migrations
git add supabase/migrations/20260606180000_negociacao_paralela_v2_cleanup.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(reposição): migration de limpeza da Negociação Paralela v2 (desliga cron diário + limpa pendentes)"
```

---

## Task 7: Verificação final

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test > /tmp/neg_test.log 2>&1; echo "exit=$?"; tail -5 /tmp/neg_test.log`
Expected: exit=0, todos os testes passando (incluindo `negociacao-valor-helpers`).

- [ ] **Step 2: Gate de CI local**

Run: `heavy bun run typecheck && heavy bun lint && heavy bun run build`
Expected: PASS nos três.

- [ ] **Step 3: Smoke manual (founder, após Publish)**

Abrir `/admin/reposicao/negociacao-paralela`: a fila deve mostrar **3 cards** liderados por CATALISADOR FC.6975 / DILUENTE PU DFA.4128 / SELADORA NLO.9525 (os campeões por R$). Ajustar o desconto de 8% → 7% deve **reduzir** economia/net ao vivo. "Vou negociar este" deve criar um card em "Em andamento".

---

## Self-Review

**Cobertura do spec:**
- §3 modelo (base separada, economia sobre p, capital sobre c) → Task 1 (helper + testes). ✓
- §5 fila Top 3 + card com controle de desconto + net/teto → Tasks 3,4,5. ✓
- §5 registro → campanha flat (mantém) → Task 3 (`handleConverterConfirm`, reusa RPC) + Task 5 (ConverterDialog). ✓
- §6 mata cron diário + para o empilhamento → Task 6. ✓ (matview dormente, não dropada — decisão de segurança documentada).
- §8 degradação honesta (sem cmc/preço → "custo a confirmar") → Task 1 (motivo_inelegivel) + Task 4 (badge). ✓
- §10 decisões (desconto pelo usuário, Top 3, base separada) → Tasks 1,3,4. ✓

**Placeholders:** nenhum TODO/TBD; todo código presente.

**Consistência de tipos:** `InsumoNegociacao`/`ValorNegociacao` (Task 1) usados igual em `avaliarNegociacao` (Tasks 3,4); `CandidatoNegociacao`/`LinhaViewSugeridos` (Task 2) usados no hook (Task 3) e card (Task 4); `descontoDe` retorna fração e o card converte ×100/÷100 consistentemente.

**Riscos para o executor:**
- `SugestaoCard` foi feito para o fluxo antigo; confirmar que aceita handlers no-op e `rankingExtra?` opcional (Task 5 Step 2). Se exigir props, ajustar a assinatura para opcional.
- `v_sku_parametros_sugeridos` é pesada; o filtro `empresa=OBEN + ilike Sayerlack` reduz bem, mas se a query lentar, considerar uma RPC fina (fora do escopo v1).
- Coordenação multi-sessão: a view `v_sku_parametros_sugeridos` foi mexida pelo #666 (recém-mergeado) — rebasear sobre a main antes de implementar.
