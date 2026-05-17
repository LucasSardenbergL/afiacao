# PR6c — Calculadora de Rendimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Calculadora standalone que vendedor abre antes/durante chamada pra calcular consumo (L) + estimativa de ticket baseado em `kb_product_specs` (extraídos no PR6b). Vendedor seleciona produto + informa área em m² → vê cálculo passo-a-passo. Página `/admin/calculadora` + botão no sidebar. **Integração ao vivo no painel de chamada fica pra PR6c.5** (precisa hook que escuta entitiesExtracted da transcrição — mais complexo, pode ir depois).

**Architecture:**
- Helper puro `calculate-rendimento.ts` (TDD): recebe specs + área + demãos override → retorna `{ litros, demãos, gramaturaMedia, calculoPasso }`
- Hook `useKbProductSpecsList` — lista de specs aprovados pra select
- Componente `RendimentoCalculator` — UI standalone
- Página `/admin/calculadora` + rota + menu

**Não-objetivos:**
- Auto-detect de volume na transcrição da chamada (PR6c.5)
- Preço real do produto (precisa de Omie sync — PR10). Por enquanto, placeholder de "ticket bruto" só com volume L
- Comparativo com concorrente (PR8)
- Histórico de cálculos salvos

---

## Tasks

### Task 1: Helper `calculate-rendimento` (TDD)

**Files:**
- `src/lib/knowledge-base/calculate-rendimento.ts`
- `src/lib/knowledge-base/calculate-rendimento.test.ts`

```ts
// calculate-rendimento.ts
import type { KbProductSpec } from './specs-types';

export interface RendimentoCalculation {
  /** Área total a ser pintada (m²) */
  areaM2: number;
  /** Demãos aplicadas (override ou default do spec) */
  demaos: number;
  /** Rendimento usado (m²/L do spec ou recalculado pela gramatura) */
  rendimentoM2PorLitro: number;
  /** Litros necessários */
  litrosNecessarios: number;
  /** Memória de cálculo pra UI */
  calculo: string;
  /** Avisos se faltam dados pro cálculo */
  warnings: string[];
}

export interface CalculateInput {
  spec: Pick<KbProductSpec, 'rendimento_m2_por_litro' | 'densidade_g_cm3' | 'gramatura_g_m2_min' | 'gramatura_g_m2_max' | 'demaos_recomendadas' | 'product_name'>;
  areaM2: number;
  demaosOverride?: number;
}

/**
 * Calcula litros necessários considerando rendimento + demãos.
 * Se spec não tem rendimento explícito mas tem densidade + gramatura, deriva.
 * Retorna warnings quando faltam dados ou cálculo é aproximação.
 */
export function calculateRendimento(input: CalculateInput): RendimentoCalculation {
  const warnings: string[] = [];
  const demaos = input.demaosOverride ?? input.spec.demaos_recomendadas ?? 1;

  if (input.demaosOverride === undefined && !input.spec.demaos_recomendadas) {
    warnings.push('Demãos não informadas no boletim — assumindo 1.');
  }

  let rendimento = input.spec.rendimento_m2_por_litro;
  let calculo = '';

  if (rendimento != null && rendimento > 0) {
    calculo = `Rendimento do boletim: ${rendimento} m²/L`;
  } else if (input.spec.densidade_g_cm3 && (input.spec.gramatura_g_m2_min || input.spec.gramatura_g_m2_max)) {
    const min = input.spec.gramatura_g_m2_min ?? input.spec.gramatura_g_m2_max ?? 0;
    const max = input.spec.gramatura_g_m2_max ?? input.spec.gramatura_g_m2_min ?? 0;
    const gramaturaMedia = (min + max) / 2;
    const densidadeGPorL = input.spec.densidade_g_cm3 * 1000;
    rendimento = gramaturaMedia > 0 ? densidadeGPorL / gramaturaMedia : 0;
    calculo = `Derivado: densidade ${input.spec.densidade_g_cm3} g/cm³ × 1000 ÷ gramatura média ${gramaturaMedia} g/m² = ${rendimento.toFixed(1)} m²/L`;
    warnings.push('Rendimento derivado da densidade + gramatura (boletim não informa explicitamente).');
  } else {
    warnings.push('Spec sem rendimento, densidade ou gramatura — cálculo impossível.');
    return {
      areaM2: input.areaM2,
      demaos,
      rendimentoM2PorLitro: 0,
      litrosNecessarios: 0,
      calculo: 'Dados insuficientes',
      warnings,
    };
  }

  if (rendimento <= 0) {
    warnings.push('Rendimento calculado é zero ou negativo.');
    return {
      areaM2: input.areaM2,
      demaos,
      rendimentoM2PorLitro: 0,
      litrosNecessarios: 0,
      calculo,
      warnings,
    };
  }

  const litros = (input.areaM2 / rendimento) * demaos;

  return {
    areaM2: input.areaM2,
    demaos,
    rendimentoM2PorLitro: rendimento,
    litrosNecessarios: litros,
    calculo,
    warnings,
  };
}
```

**Testes** (6 mínimos):
1. Spec com rendimento explícito → usa direto
2. Spec sem rendimento mas com densidade + gramatura → deriva
3. Spec sem nada → warning + litros=0
4. Demãos override sobrescreve default
5. Sem demãos no spec nem override → assume 1 + warning
6. Cálculo final: 80m² × 2 demãos ÷ 8 m²/L = 20L

Commit: `feat(kb): calculateRendimento — pure helper com derivação automática de densidade+gramatura`

---

### Task 2: Hook `useKbProductSpecsList`

**File:** `src/hooks/useKbProductSpecsList.ts`

Lista de todos os specs aprovados (status filtro: approved_by IS NOT NULL).

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

export function useKbProductSpecsList() {
  return useQuery({
    queryKey: ['kb-product-specs-list'],
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_product_specs') as any)
        .select('*')
        .not('approved_at', 'is', null)
        .order('product_name', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as KbProductSpec[];
    },
  });
}
```

Commit: `feat(kb): useKbProductSpecsList hook (specs aprovados pra select)`

---

### Task 3: Componente `RendimentoCalculator`

**File:** `src/components/knowledge-base/RendimentoCalculator.tsx`

Form simples:
- Select produto (specs aprovados)
- Input área (m²) com validação > 0
- Input demãos (override, opcional — pré-preenchido com spec.demaos_recomendadas)
- Output card com cálculo + memória + warnings

```tsx
import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calculator, AlertTriangle, Loader2 } from 'lucide-react';
import { useKbProductSpecsList } from '@/hooks/useKbProductSpecsList';
import { calculateRendimento } from '@/lib/knowledge-base/calculate-rendimento';

export function RendimentoCalculator() {
  const { data: specs, isLoading } = useKbProductSpecsList();
  const [productCode, setProductCode] = useState<string>('');
  const [areaM2, setAreaM2] = useState<string>('');
  const [demaosOverride, setDemaosOverride] = useState<string>('');

  const selectedSpec = specs?.find((s) => s.product_code === productCode);
  const area = parseFloat(areaM2) || 0;
  const demaos = demaosOverride ? parseInt(demaosOverride, 10) : undefined;

  const result = useMemo(() => {
    if (!selectedSpec || area <= 0) return null;
    return calculateRendimento({ spec: selectedSpec, areaM2: area, demaosOverride: demaos });
  }, [selectedSpec, area, demaos]);

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Calculator className="w-4 h-4 text-status-warning" />
        <h2 className="text-sm font-semibold">Calculadora de rendimento</h2>
      </div>

      <div className="space-y-3">
        <div>
          <Label htmlFor="product" className="text-xs">Produto</Label>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Carregando produtos…
            </div>
          ) : !specs || specs.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">
              Nenhum spec aprovado ainda. Suba boletins em /admin/knowledge-base e extraia os specs primeiro.
            </div>
          ) : (
            <Select value={productCode} onValueChange={setProductCode}>
              <SelectTrigger><SelectValue placeholder="Escolha o produto" /></SelectTrigger>
              <SelectContent>
                {specs.map((s) => (
                  <SelectItem key={s.product_code} value={s.product_code}>
                    {s.product_name} <span className="text-muted-foreground">({s.product_code})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="area" className="text-xs">Área a pintar (m²)</Label>
            <Input id="area" type="number" min="0" step="any" value={areaM2} onChange={(e) => setAreaM2(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="demaos" className="text-xs">
              Demãos {selectedSpec?.demaos_recomendadas && <span className="text-muted-foreground">(default: {selectedSpec.demaos_recomendadas})</span>}
            </Label>
            <Input id="demaos" type="number" min="1" placeholder={String(selectedSpec?.demaos_recomendadas ?? 1)} value={demaosOverride} onChange={(e) => setDemaosOverride(e.target.value)} />
          </div>
        </div>
      </div>

      {result && (
        <Card className="p-3 border-status-success bg-status-success-bg/30 space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Consumo estimado</span>
            <span className="text-2xl font-semibold tabular-nums text-status-success">{result.litrosNecessarios.toFixed(1)} L</span>
          </div>
          <div className="text-2xs text-muted-foreground space-y-0.5">
            <div>Área: {result.areaM2} m² · Demãos: {result.demaos} · Rendimento: {result.rendimentoM2PorLitro.toFixed(1)} m²/L</div>
            <div className="font-mono text-[10px]">{result.calculo}</div>
            <div className="font-mono text-[10px]">{result.areaM2} ÷ {result.rendimentoM2PorLitro.toFixed(1)} × {result.demaos} = {result.litrosNecessarios.toFixed(1)} L</div>
          </div>
          {result.warnings.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-status-success/20">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-2xs text-status-warning">
                  <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
                  {w}
                </div>
              ))}
            </div>
          )}
          {selectedSpec && (
            <div className="flex flex-wrap gap-1 pt-2 border-t border-status-success/20">
              {selectedSpec.catalisador_codigo && <Badge variant="outline" className="text-[10px]">+ catalisador {selectedSpec.catalisador_codigo}{selectedSpec.catalisador_proporcao_pct && ` (${selectedSpec.catalisador_proporcao_pct}%)`}</Badge>}
              {selectedSpec.diluente_codigo && <Badge variant="outline" className="text-[10px]">+ diluente {selectedSpec.diluente_codigo}</Badge>}
              {selectedSpec.pot_life_horas && <Badge variant="outline" className="text-[10px]">pot life {selectedSpec.pot_life_horas}h</Badge>}
            </div>
          )}
        </Card>
      )}
    </Card>
  );
}
```

Commit: `feat(kb): RendimentoCalculator component standalone`

---

### Task 4: Página + rota + menu

**Files:**
- `src/pages/AdminCalculadora.tsx` (default export)
- `src/App.tsx` — lazy + rota `/admin/calculadora`
- `src/components/AppShell.tsx` — item de menu na seção Gestão (icon `Calculator`)

```tsx
// AdminCalculadora.tsx
import { RendimentoCalculator } from '@/components/knowledge-base/RendimentoCalculator';

export default function AdminCalculadora() {
  return (
    <div className="container mx-auto p-4 space-y-3 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Calculadora de rendimento</h1>
        <p className="text-xs text-muted-foreground">
          Calcula consumo de tinta baseado em área a pintar + boletim técnico aprovado.
        </p>
      </div>
      <RendimentoCalculator />
    </div>
  );
}
```

Commit: `feat(kb): AdminCalculadora page + route + menu item`

---

### Task 5: QA + PR

- tsc clean
- tests passing (+6 do calculate-rendimento)
- build passes
- Push + PR stacked sobre PR6a (base = `claude/pr6a-knowledge-base-foundation`) OU stacked sobre PR6b (`claude/pr6b-kb-extract-specs` — mais correto porque depende dos types KbProductSpec)

---

## Self-Review

**Spec coverage:**
- Cálculo automático com fallback de densidade+gramatura → Task 1
- Select de produtos aprovados → Task 2
- UI standalone → Task 3
- Acessível via menu → Task 4

**Riscos:**
- Specs aprovados ainda zero — empty state vai aparecer sempre até user aprovar specs via PR6b. Documentado.
- Sem preço (sem Omie sync) — não mostra ticket R$. Mostra só litros. PR10 traz preço.
