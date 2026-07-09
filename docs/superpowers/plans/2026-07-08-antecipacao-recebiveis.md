# F4 — Antecipação de recebíveis — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Medir o custo real de antecipar recebíveis (R$ + taxa período + taxa a.a. money-weighted) e comparar o custo de funding da oferta vs um hurdle, a partir de operações registradas manualmente — money-path com degradação honesta, nunca fabricando número.

**Architecture:** Overlay analítico manual, molde do F1 (endividamento). Tabela `fin_antecipacoes` (master-only, RLS, trigger de autor, CHECKs, soft delete) só ARMAZENA os fatos brutos; TODO derivado (custo, taxa, agregação, comparação) vive num helper PURO `antecipacao-helpers.ts` (vitest, falsificável). Hook `useAntecipacoes` faz o I/O (cast-through-unknown, tabela fora dos tipos gerados) e deriva o hurdle-sugestão do F1 (`fin_dividas.cet_aa`). Página dedicada `/financeiro/antecipacao` (não aba — F4 é CRUD-pesado idêntico ao F1) monta lista/CRUD + card medidor (Job A) + calculadora de funding (Job B). Nada reescreve sync/DRE/edge.

**Tech Stack:** React 18 + TS strict + Vite + react-router 6 (lazy) + @tanstack/react-query v5 + shadcn/ui + Tailwind (tokens v3 `text-status-*`) + Supabase (PostgREST via cast-through-unknown) + sonner (toast) + vitest (helper) + PG17 local (prove-sql-money-path).

## Global Constraints

- **Idioma pt-BR** em tudo: código, rotas (`/financeiro/antecipacao`), comentários, commits, PR. (CLAUDE.md)
- **Money-path: ausente ≠ zero.** `Number(null)===0` é fabricação → degradar para `null` + `motivo`, nunca um R$0 travestido de "custo zero". (CLAUDE.md, spec §3/§5)
- **Precisão > recall.** Sem operação registrada = sem custo. Linha inválida → excluída + `dados_parciais`, nunca agregado "ok" com operação ignorada em silêncio. (spec §1/§3/§5)
- **Datas ISO `YYYY-MM-DD`** puras (sem TZ), comparadas lexicograficamente — molde `endividamento-types.ts`. `dias` = diferença de datas por UTC-midnight (sem drift de fuso).
- **Tabela master-only** fora dos tipos gerados do Supabase → `supabase as unknown as <ShapeMínimo>` (molde `useEndividamento.ts` — ESLint barra `any`). RLS: `EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')` + `service_role` bypass. (spec §8, `database.md`)
- **Trigger de autor SECURITY DEFINER `SET search_path = ''`** (INVOKER quebra `auth.uid()` — "permission denied for schema auth", pego pela prova PG17). Molde `fin_dre_custo_tipo`. (migration F3)
- **Nunca tocar `supabase/migrations/` já existentes** nem aplicar migration (escrita = SQL Editor do founder). O plano ENTREGA o arquivo + handoff. (CLAUDE.md, `deploy.md`)
- **Status colors** `text-status-*`; **toast** só `sonner`; **skeleton** `<PageSkeleton>`; **empty** `<EmptyState tone="operational">`. (CLAUDE.md Design System)
- **Os 5 P1 do Codex (spec §11) são lei** — reproduzidos nas tasks que os implementam.

---

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `src/lib/financeiro/antecipacao-types.ts` | tipos puros (`Antecipacao`, `HurdleUnidade`, resultados, motivos) | 1 |
| `src/lib/financeiro/antecipacao-helpers.ts` | derivados puros: custo/taxa por op, Job A (money-weighted), Job B (funding + unidade), hurdle-sugestão, guard de fluxo | 1–4 |
| `src/lib/financeiro/__tests__/antecipacao-helpers.test.ts` | vitest: fórmula, todos os motivos §5, money-weighted reconcilia, unidade do hurdle, igualdade válida, falsificável | 1–4 |
| `supabase/migrations/20260708120000_fin_antecipacoes.sql` | tabela + CHECKs + trigger autor + RLS master + unique dedup + soft delete | 5 |
| `db/test-fin-antecipacoes.sh` | prove-sql PG17: RLS nega authenticated, CHECKs (igualdade VÁLIDA), trigger, unique, **falsificação** | 5 |
| `src/hooks/useAntecipacoes.ts` | react-query: lista (exclui soft-deleted), upsert, soft-delete, hurdle-sugestão do F1 | 6 |
| `src/pages/FinanceiroAntecipacao.tsx` | página master-only: header + seletor empresa + lista/CRUD + Job A + Job B | 7 |
| `src/components/financeiro/antecipacao/AntecipacaoFormDialog.tsx` | dialog cadastro/edição (com guard `fluxo_nao_suportado`) | 7 |
| `src/components/financeiro/antecipacao/MedidorCustoCard.tsx` | card Job A (R$ + taxa período + a.a. + tendência + motivo honesto) | 7 |
| `src/components/financeiro/antecipacao/CalculadoraFunding.tsx` | Job B (oferta → custo + comparação com hurdle editável, F1 sugere) | 7 |
| `src/App.tsx` | registrar `<Route path="financeiro/antecipacao" …>` (lazy) | 7 |

---

## Interfaces canônicas (contrato entre tasks — copie exato)

```typescript
// antecipacao-types.ts
export type Company = 'oben' | 'colacor' | 'colacor_sc';
export type TipoAntecipacao = 'duplicata' | 'linha';
/** Unidade EXPLÍCITA do hurdle/oferta (P1-3: sem unidade a comparação é lixo). */
export type HurdleUnidade = 'efetiva_aa' | 'nominal_aa' | 'efetiva_am';

export interface Antecipacao {
  id: string;
  company: Company;
  banco: string | null;
  tipo: TipoAntecipacao;
  valor_bruto: number;          // FACE ANTECIPADA (não a face total do título)
  custos_avulsos: number;       // >= 0 — IOF/tarifa FORA do líquido (P1-4)
  valor_liquido: number;        // > 0 — o que caiu na conta
  data_operacao: string;        // ISO
  data_vencimento: string;      // ISO
  operacao_origem_id: string | null;
  referencia: string | null;
  observacao: string | null;
  deleted_at: string | null;
}

export type MotivoOperacao = 'ok' | 'dados_invalidos';
export interface CustoOperacao {
  motivo: MotivoOperacao;
  custo: number | null;         // bruto + avulsos − liquido
  dias: number | null;
  taxa_periodo: number | null;  // (bruto+avulsos)/liquido − 1
  taxa_efetiva_aa: number | null;
}

export type MotivoMedidor = 'ok' | 'sem_operacoes' | 'dados_parciais';
export interface MesAntecipacao { ano: number; mes: number; custo: number; volume: number; }
export interface MedidorResult {
  motivo: MotivoMedidor;
  custo_total: number | null;
  volume_antecipado: number | null;
  taxa_realizada_aa: number | null;   // money-weighted (P1-2)
  num_operacoes: number;              // válidas incluídas
  num_excluidas: number;              // inválidas excluídas (dados_parciais)
  tendencia: MesAntecipacao[];        // por data_operacao (base declarada, P1)
}

export interface Hurdle { valor: number; unidade: HurdleUnidade; }
export type MotivoFunding =
  | 'ok' | 'dados_invalidos' | 'inputs_conflitantes'
  | 'hurdle_unidade_invalida' | 'hurdle_indisponivel' | 'fluxo_nao_suportado';
export interface FundingInput {
  valor_titulo: number;         // face antecipada da oferta
  dias: number;
  custos_avulsos?: number;      // default 0
  liquido_ofertado?: number | null;   // oferta como líquido
  taxa_ofertada?: Hurdle | null;       // OU oferta como taxa (com unidade)
  hurdle?: Hurdle | null;              // editável PRIMÁRIO; ausente → hurdle_indisponivel
  lote?: boolean;               // true = lote multi-venc num prazo só → fluxo_nao_suportado
}
export interface FundingResult {
  motivo: MotivoFunding;
  custo: number | null;
  taxa_periodo: number | null;
  taxa_efetiva_aa: number | null;
  hurdle_taxa_periodo: number | null;  // hurdle convertido p/ os mesmos `dias`
  veredito: 'mais_caro' | 'dentro' | null;  // SÓ de funding (P1-3), nunca "vale a pena"
}

export type MotivoHurdleSugerido = 'ok' | 'sem_dados';
export interface HurdleSugerido { valor: number | null; unidade: HurdleUnidade | null; motivo: MotivoHurdleSugerido; }
```

**Funções puras produzidas** (todas em `antecipacao-helpers.ts`):
- `diasEntre(operISO: string, vencISO: string): number`
- `custoOperacao(op: Pick<Antecipacao,'valor_bruto'|'custos_avulsos'|'valor_liquido'|'data_operacao'|'data_vencimento'>): CustoOperacao`
- `taxaParaPeriodo(valor: number, unidade: HurdleUnidade, dias: number): number` (converte qualquer unidade → taxa do período de `dias`)
- `medirCusto(ops: Antecipacao[]): MedidorResult` (Job A)
- `compararFunding(input: FundingInput): FundingResult` (Job B)
- `motivoFluxoRegistro(input: { lote?: boolean }): 'ok' | 'fluxo_nao_suportado'`
- `sugerirHurdle(dividas: Array<{ saldo: number; cet_aa: number | null }>): HurdleSugerido`

---

### Task 1: Tipos + custo por operação (`custoOperacao` + `diasEntre`)

**Files:**
- Create: `src/lib/financeiro/antecipacao-types.ts`
- Create: `src/lib/financeiro/antecipacao-helpers.ts`
- Test: `src/lib/financeiro/__tests__/antecipacao-helpers.test.ts`

**Interfaces:**
- Produces: `diasEntre`, `custoOperacao`, todos os tipos do contrato acima.
- Consumes: nada (raiz da cadeia).

- [ ] **Step 1: Escrever `antecipacao-types.ts`** — cole o bloco "Interfaces canônicas" inteiro (tipos, sem funções). Cabeçalho:

```typescript
// F4 — Antecipação de recebíveis. Tipos PUROS (helper testado em vitest).
// Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md
// Money-path: ausente ≠ zero; sem operação = sem custo (degrada por motivo, nunca fabrica).
// Datas ISO YYYY-MM-DD puras (sem TZ). Os 5 P1 do Codex (spec §11) são lei.
```

- [ ] **Step 2: Escrever o teste que falha** (`__tests__/antecipacao-helpers.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { diasEntre, custoOperacao } from '../antecipacao-helpers';

const op = (over: Partial<Parameters<typeof custoOperacao>[0]> = {}) => ({
  valor_bruto: 100_000, custos_avulsos: 0, valor_liquido: 97_000,
  data_operacao: '2026-01-01', data_vencimento: '2026-01-31', ...over,
});

describe('diasEntre', () => {
  it('conta dias corridos entre datas ISO (sem drift de TZ)', () => {
    expect(diasEntre('2026-01-01', '2026-01-31')).toBe(30);
    expect(diasEntre('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('custoOperacao — caminho feliz', () => {
  it('custo = bruto+avulsos−liquido; taxa período e a.a. de caso conhecido', () => {
    const r = custoOperacao(op());
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.dias).toBe(30);
    expect(r.taxa_periodo).toBeCloseTo(100_000 / 97_000 - 1, 6); // ~0,030928
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(100_000 / 97_000, 365 / 30) - 1, 6); // ~0,4486
  });

  it('custos_avulsos (IOF/tarifa FORA do líquido) entram no custo (P1-4)', () => {
    const r = custoOperacao(op({ custos_avulsos: 500 }));
    expect(r.custo).toBeCloseTo(3_500, 2); // 100000+500−97000
    expect(r.taxa_periodo).toBeCloseTo(100_500 / 97_000 - 1, 6);
  });

  it('líquido == bruto+avulsos → custo 0 / taxa 0, VÁLIDO (P1-1: igualdade não é inválida)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_000, custos_avulsos: 0 }));
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(0, 6);
    expect(r.taxa_periodo).toBeCloseTo(0, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(0, 6);
  });
});

describe('custoOperacao — dados_invalidos (helper blinda além do CHECK)', () => {
  it('líquido > bruto+avulsos → dados_invalidos (P1-1: inválido só quando MAIOR)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_001 }));
    expect(r.motivo).toBe('dados_invalidos');
    expect(r.custo).toBeNull();
  });
  it('dias ≤ 0 (venc ≤ operação) → dados_invalidos', () => {
    const r = custoOperacao(op({ data_vencimento: '2026-01-01' }));
    expect(r.motivo).toBe('dados_invalidos');
  });
  it('valores ≤ 0 ou custos_avulsos < 0 → dados_invalidos', () => {
    expect(custoOperacao(op({ valor_bruto: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ valor_liquido: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ custos_avulsos: -1 })).motivo).toBe('dados_invalidos');
  });
});
```

- [ ] **Step 3: Rodar o teste — deve FALHAR** (`Cannot find module` / função indefinida):

Run: `heavy bun run test antecipacao`
Expected: FAIL (módulo/funções não existem)

- [ ] **Step 4: Implementar em `antecipacao-helpers.ts`**:

```typescript
// F4 — Antecipação de recebíveis. Helper PURO (vitest). Sem I/O.
// Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md
// Precisão > recall: degrada por motivo (nunca fabrica R$). Datas ISO puras (UTC-midnight).
import type {
  Antecipacao, CustoOperacao, HurdleUnidade,
  MedidorResult, MesAntecipacao, FundingInput, FundingResult, HurdleSugerido,
} from './antecipacao-types';

const MS_DIA = 86_400_000;
/** Dias corridos entre duas datas ISO puras, ancoradas em UTC-midnight (sem drift de fuso). */
export function diasEntre(operISO: string, vencISO: string): number {
  const a = Date.parse(operISO + 'T00:00:00Z');
  const b = Date.parse(vencISO + 'T00:00:00Z');
  return Math.round((b - a) / MS_DIA);
}

type OpCusto = Pick<Antecipacao,
  'valor_bruto' | 'custos_avulsos' | 'valor_liquido' | 'data_operacao' | 'data_vencimento'>;

const INVALIDO: CustoOperacao = {
  motivo: 'dados_invalidos', custo: null, dias: null, taxa_periodo: null, taxa_efetiva_aa: null,
};

/** Custo e taxas de UMA operação. Blinda os invariantes (o CHECK barra no banco; aqui defende o agregado). */
export function custoOperacao(op: OpCusto): CustoOperacao {
  const bruto = Number(op.valor_bruto);
  const avulsos = Number(op.custos_avulsos);
  const liquido = Number(op.valor_liquido);
  if (![bruto, avulsos, liquido].every(Number.isFinite)) return INVALIDO;
  if (!(bruto > 0) || !(liquido > 0) || avulsos < 0) return INVALIDO;   // P1-1: valores positivos
  const base = bruto + avulsos;
  if (liquido > base) return INVALIDO;                                   // P1-1: inválido SÓ se líquido > base
  const dias = diasEntre(op.data_operacao, op.data_vencimento);
  if (!(dias > 0)) return INVALIDO;                                      // prazo positivo
  const custo = base - liquido;                                         // P1-4: avulsos entram
  const taxa_periodo = base / liquido - 1;
  const taxa_efetiva_aa = Math.pow(1 + taxa_periodo, 365 / dias) - 1;    // normalização (nunca métrica única, §3)
  return { motivo: 'ok', custo, dias, taxa_periodo, taxa_efetiva_aa };
}
```

- [ ] **Step 5: Rodar o teste — deve PASSAR:**

Run: `heavy bun run test antecipacao`
Expected: PASS (todos os `it` de Task 1)

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/antecipacao-types.ts src/lib/financeiro/antecipacao-helpers.ts src/lib/financeiro/__tests__/antecipacao-helpers.test.ts
git commit -m "feat(financeiro): F4 custo por operação de antecipação (helper puro, P1-1/P1-4)"
```

---

### Task 2: Job A — medidor money-weighted (`medirCusto`)

**Files:**
- Modify: `src/lib/financeiro/antecipacao-helpers.ts`
- Test: `src/lib/financeiro/__tests__/antecipacao-helpers.test.ts`

**Interfaces:**
- Consumes: `custoOperacao`, `Antecipacao`, `MedidorResult`, `MesAntecipacao` (Task 1).
- Produces: `medirCusto(ops: Antecipacao[]): MedidorResult`.

- [ ] **Step 1: Escrever o teste que falha** (adicionar ao mesmo arquivo):

```typescript
import { medirCusto } from '../antecipacao-helpers';
import type { Antecipacao } from '../antecipacao-types';

const full = (over: Partial<Antecipacao>): Antecipacao => ({
  id: crypto.randomUUID(), company: 'oben', banco: 'Itaú', tipo: 'duplicata',
  valor_bruto: 100_000, custos_avulsos: 0, valor_liquido: 97_000,
  data_operacao: '2026-01-05', data_vencimento: '2026-02-04',
  operacao_origem_id: null, referencia: null, observacao: null, deleted_at: null, ...over,
});

describe('medirCusto — Job A money-weighted (P1-2)', () => {
  it('taxa realizada reconcilia com R$: custo_total / (Σ líquido×dias / 365)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // custo 3000, 30d
      full({ valor_bruto: 52_000, valor_liquido: 50_000, data_operacao: '2026-02-01', data_vencimento: '2026-04-02' }), // custo 2000, 60d
    ];
    const r = medirCusto(ops);
    expect(r.motivo).toBe('ok');
    expect(r.custo_total).toBeCloseTo(5_000, 2);
    expect(r.volume_antecipado).toBeCloseTo(147_000, 2);
    const capitalTempo = (97_000 * 30 + 50_000 * 60) / 365; // 16191,78 R$·ano
    expect(r.taxa_realizada_aa).toBeCloseTo(5_000 / capitalTempo, 6); // ~0,3088
    expect(r.num_operacoes).toBe(2);
  });

  it('uma op curtíssima com EAR absurda NÃO infla a taxa (money-weighted, não média de EAR)', () => {
    // Op curta (1 dia, EAR gigante) + op grande longa. A média de EAR explodiria; a money-weighted não.
    const ops = [
      full({ valor_bruto: 1_000, valor_liquido: 990, data_operacao: '2026-01-01', data_vencimento: '2026-01-02' }), // 1d, EAR enorme
      full({ valor_bruto: 100_000, valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // 30d
    ];
    const r = medirCusto(ops);
    const capitalTempo = (990 * 1 + 97_000 * 30) / 365;
    expect(r.taxa_realizada_aa).toBeCloseTo((10 + 3_000) / capitalTempo, 6); // dominada pela op grande
    expect(r.taxa_realizada_aa!).toBeLessThan(1); // < 100% a.a. — não explodiu
  });

  it('tendência mensal por data_operacao (base declarada)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-10', data_vencimento: '2026-02-09' }), // jan custo 3000
      full({ valor_bruto: 52_000, valor_liquido: 50_000, data_operacao: '2026-02-10', data_vencimento: '2026-03-12' }), // fev custo 2000
    ];
    const r = medirCusto(ops);
    expect(r.tendencia).toEqual([
      { ano: 2026, mes: 1, custo: 3_000, volume: 97_000 },
      { ano: 2026, mes: 2, custo: 2_000, volume: 50_000 },
    ]);
  });
});

describe('medirCusto — degradação honesta', () => {
  it('sem operações → sem_operacoes (≠ economia/custo zero; P1-6)', () => {
    const r = medirCusto([]);
    expect(r.motivo).toBe('sem_operacoes');
    expect(r.custo_total).toBeNull();
    expect(r.num_operacoes).toBe(0);
  });

  it('soft-deleted é ignorado (não conta no custo)', () => {
    const r = medirCusto([full({ deleted_at: '2026-03-01T00:00:00Z' })]);
    expect(r.motivo).toBe('sem_operacoes');
  });

  it('linha inválida excluída → dados_parciais, agregado só das válidas (nunca "ok" com op ignorada)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // válida, custo 3000
      full({ valor_bruto: 100_000, valor_liquido: 100_001 }), // inválida (líquido > bruto)
    ];
    const r = medirCusto(ops);
    expect(r.motivo).toBe('dados_parciais');
    expect(r.num_operacoes).toBe(1);
    expect(r.num_excluidas).toBe(1);
    expect(r.custo_total).toBeCloseTo(3_000, 2);
  });

  it('todas inválidas → dados_parciais com agregados null (temos ops, nenhuma custeável)', () => {
    const r = medirCusto([full({ valor_bruto: 100_000, valor_liquido: 100_050 })]);
    expect(r.motivo).toBe('dados_parciais');
    expect(r.num_operacoes).toBe(0);
    expect(r.num_excluidas).toBe(1);
    expect(r.custo_total).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (`medirCusto` não existe). Run: `heavy bun run test antecipacao` → FAIL.

- [ ] **Step 3: Implementar `medirCusto`** (append em `antecipacao-helpers.ts`):

```typescript
/** Job A — medidor de custo do período. Métrica primária = caixa (R$), taxa money-weighted (P1-2).
 *  Exclui soft-deleted; linhas inválidas são excluídas e sinalizadas (dados_parciais). */
export function medirCusto(ops: Antecipacao[]): MedidorResult {
  const vivos = ops.filter((o) => o.deleted_at == null);
  if (vivos.length === 0) {
    return { motivo: 'sem_operacoes', custo_total: null, volume_antecipado: null,
      taxa_realizada_aa: null, num_operacoes: 0, num_excluidas: 0, tendencia: [] };
  }
  let custoTotal = 0, volume = 0, capitalTempo = 0, excluidas = 0;
  const porMes = new Map<string, MesAntecipacao>();
  for (const o of vivos) {
    const c = custoOperacao(o);
    if (c.motivo !== 'ok' || c.custo == null || c.dias == null) { excluidas++; continue; }
    custoTotal += c.custo;
    volume += o.valor_liquido;
    capitalTempo += (o.valor_liquido * c.dias) / 365;
    const [ano, mes] = [Number(o.data_operacao.slice(0, 4)), Number(o.data_operacao.slice(5, 7))];
    const k = `${ano}-${mes}`;
    const m = porMes.get(k) ?? { ano, mes, custo: 0, volume: 0 };
    m.custo += c.custo; m.volume += o.valor_liquido; porMes.set(k, m);
  }
  const validas = vivos.length - excluidas;
  const tendencia = [...porMes.values()].sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes));
  if (validas === 0) {
    return { motivo: 'dados_parciais', custo_total: null, volume_antecipado: null,
      taxa_realizada_aa: null, num_operacoes: 0, num_excluidas: excluidas, tendencia: [] };
  }
  const taxa = capitalTempo > 0 ? custoTotal / capitalTempo : null; // money-weighted anualizada
  return {
    motivo: excluidas > 0 ? 'dados_parciais' : 'ok',
    custo_total: custoTotal, volume_antecipado: volume, taxa_realizada_aa: taxa,
    num_operacoes: validas, num_excluidas: excluidas, tendencia,
  };
}
```

- [ ] **Step 4: Rodar — deve PASSAR.** Run: `heavy bun run test antecipacao` → PASS (Task 1 + Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/antecipacao-helpers.ts src/lib/financeiro/__tests__/antecipacao-helpers.test.ts
git commit -m "feat(financeiro): F4 Job A medidor money-weighted (P1-2, dados_parciais honesto)"
```

---

### Task 3: Job B — funding + conversão de unidade + guard de fluxo

**Files:**
- Modify: `src/lib/financeiro/antecipacao-helpers.ts`
- Test: `src/lib/financeiro/__tests__/antecipacao-helpers.test.ts`

**Interfaces:**
- Consumes: `FundingInput`, `FundingResult`, `HurdleUnidade` (Task 1).
- Produces: `taxaParaPeriodo`, `compararFunding`, `motivoFluxoRegistro`.

**Convenções de unidade (documentadas — Codex vetará):** conversão de qualquer unidade → taxa efetiva do período de `dias`:
- `efetiva_aa` (efetiva a.a., composta): `(1+v)^(dias/365) − 1`
- `efetiva_am` (efetiva a.m., composta): `(1+v)^(dias/30) − 1`
- `nominal_aa` (nominal a.a., **linear/proporcional** — juros simples): `v × dias/365`

- [ ] **Step 1: Escrever o teste que falha:**

```typescript
import { taxaParaPeriodo, compararFunding, motivoFluxoRegistro } from '../antecipacao-helpers';

describe('taxaParaPeriodo — converte unidade → taxa do período de `dias` (P1-3)', () => {
  it('efetiva_aa composta', () => {
    expect(taxaParaPeriodo(0.30, 'efetiva_aa', 30)).toBeCloseTo(Math.pow(1.30, 30 / 365) - 1, 8);
  });
  it('efetiva_am composta: 2% a.m. em 30 dias ≈ 2%', () => {
    expect(taxaParaPeriodo(0.02, 'efetiva_am', 30)).toBeCloseTo(0.02, 8);
  });
  it('nominal_aa linear: 36,5% a.a. em 30 dias = 3%', () => {
    expect(taxaParaPeriodo(0.365, 'nominal_aa', 30)).toBeCloseTo(0.03, 8);
  });
});

describe('compararFunding — Job B (comparação de FUNDING, nunca "vale a pena")', () => {
  const base = { valor_titulo: 100_000, dias: 30 };

  it('oferta como líquido: custo + taxas; hurdle efetiva_aa convertido p/ 30d → veredito só de funding', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000, hurdle: { valor: 0.30, unidade: 'efetiva_aa' } });
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.taxa_periodo).toBeCloseTo(100_000 / 97_000 - 1, 6); // ~3,09%
    expect(r.hurdle_taxa_periodo).toBeCloseTo(Math.pow(1.30, 30 / 365) - 1, 6); // ~2,18%
    expect(r.veredito).toBe('mais_caro'); // 3,09% > 2,18%
  });

  it('oferta dentro do hurdle → "dentro" (não "vale a pena")', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 99_000, hurdle: { valor: 0.60, unidade: 'efetiva_aa' } });
    expect(r.veredito).toBe('dentro');
  });

  it('oferta como taxa (com unidade) reconstrói o líquido e custa igual', () => {
    const r = compararFunding({ ...base, taxa_ofertada: { valor: 0.02, unidade: 'efetiva_am' }, hurdle: { valor: 0.30, unidade: 'efetiva_aa' } });
    expect(r.motivo).toBe('ok');
    expect(r.taxa_periodo).toBeCloseTo(0.02, 6); // 2% a.m. em 30d
    expect(r.custo).toBeCloseTo(100_000 - 100_000 / 1.02, 2);
  });

  it('custos_avulsos entram no custo da oferta (P1-4)', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000, custos_avulsos: 500, hurdle: { valor: 0.30, unidade: 'efetiva_aa' } });
    expect(r.custo).toBeCloseTo(3_500, 2); // 100000+500−97000
  });

  it('hurdle ausente → hurdle_indisponivel: mostra custo, sem veredito', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000 });
    expect(r.motivo).toBe('hurdle_indisponivel');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.veredito).toBeNull();
  });

  it('hurdle sem unidade válida → hurdle_unidade_invalida', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000, hurdle: { valor: 0.30, unidade: 'xpto' as HurdleUnidade } });
    expect(r.motivo).toBe('hurdle_unidade_invalida');
    expect(r.veredito).toBeNull();
  });

  it('taxa E líquido informados que não reconciliam → inputs_conflitantes', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 90_000, taxa_ofertada: { valor: 0.02, unidade: 'efetiva_am' }, hurdle: { valor: 0.30, unidade: 'efetiva_aa' } });
    expect(r.motivo).toBe('inputs_conflitantes');
  });

  it('lote multi-venc num prazo só → fluxo_nao_suportado (inventa prazo, P1-5)', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000, lote: true, hurdle: { valor: 0.30, unidade: 'efetiva_aa' } });
    expect(r.motivo).toBe('fluxo_nao_suportado');
  });

  it('dados inválidos (dias ≤ 0, valores ≤ 0, líquido > face+avulsos) → dados_invalidos', () => {
    expect(compararFunding({ valor_titulo: 100_000, dias: 0, liquido_ofertado: 97_000 }).motivo).toBe('dados_invalidos');
    expect(compararFunding({ valor_titulo: 100_000, dias: 30, liquido_ofertado: 100_001 }).motivo).toBe('dados_invalidos');
  });
});

describe('motivoFluxoRegistro — guard de entrada (form)', () => {
  it('lote=true → fluxo_nao_suportado; senão ok', () => {
    expect(motivoFluxoRegistro({ lote: true })).toBe('fluxo_nao_suportado');
    expect(motivoFluxoRegistro({})).toBe('ok');
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR.** Run: `heavy bun run test antecipacao` → FAIL.

- [ ] **Step 3: Implementar** (append em `antecipacao-helpers.ts`):

```typescript
const UNIDADES: readonly HurdleUnidade[] = ['efetiva_aa', 'nominal_aa', 'efetiva_am'];

/** Converte uma taxa na sua unidade → taxa EFETIVA do período de `dias` (comparação no MESMO período, P1-3). */
export function taxaParaPeriodo(valor: number, unidade: HurdleUnidade, dias: number): number {
  switch (unidade) {
    case 'efetiva_aa': return Math.pow(1 + valor, dias / 365) - 1;   // composta anual
    case 'efetiva_am': return Math.pow(1 + valor, dias / 30) - 1;    // composta mensal
    case 'nominal_aa': return valor * (dias / 365);                  // linear/proporcional (juros simples)
  }
}

const FUNDING_INVALIDO = (m: FundingResult['motivo']): FundingResult => ({
  motivo: m, custo: null, taxa_periodo: null, taxa_efetiva_aa: null,
  hurdle_taxa_periodo: null, veredito: null,
});

/** Job B — comparação de custo de FUNDING (nunca "vale a pena"; isso depende do uso do caixa, §4). */
export function compararFunding(input: FundingInput): FundingResult {
  if (input.lote === true) return FUNDING_INVALIDO('fluxo_nao_suportado');   // P1-5: prazo inventado
  const face = Number(input.valor_titulo);
  const dias = Number(input.dias);
  const avulsos = Number(input.custos_avulsos ?? 0);
  if (![face, dias, avulsos].every(Number.isFinite) || !(face > 0) || !(dias > 0) || avulsos < 0) {
    return FUNDING_INVALIDO('dados_invalidos');
  }
  const base = face + avulsos;

  // Resolve o líquido da oferta: pode vir como líquido, como taxa (c/ unidade), ou ambos (reconciliar).
  let liquido: number | null = null;
  const temLiquido = input.liquido_ofertado != null;
  const temTaxa = input.taxa_ofertada != null;
  if (!temLiquido && !temTaxa) return FUNDING_INVALIDO('dados_invalidos');

  let liquidoDeTaxa: number | null = null;
  if (temTaxa) {
    const u = input.taxa_ofertada!.unidade;
    if (!UNIDADES.includes(u)) return FUNDING_INVALIDO('hurdle_unidade_invalida');
    const tp = taxaParaPeriodo(input.taxa_ofertada!.valor, u, dias);
    if (!(tp > -1)) return FUNDING_INVALIDO('dados_invalidos');
    liquidoDeTaxa = base / (1 + tp);
  }
  if (temLiquido) {
    liquido = Number(input.liquido_ofertado);
    if (!Number.isFinite(liquido) || !(liquido > 0) || liquido > base) return FUNDING_INVALIDO('dados_invalidos');
    // taxa E líquido: reconciliar (tolerância relativa 0,5% sobre a face)
    if (liquidoDeTaxa != null && Math.abs(liquido - liquidoDeTaxa) > 0.005 * base) {
      return FUNDING_INVALIDO('inputs_conflitantes');
    }
  } else {
    liquido = liquidoDeTaxa;
  }
  if (liquido == null || !(liquido > 0) || liquido > base) return FUNDING_INVALIDO('dados_invalidos');

  const custo = base - liquido;
  const taxa_periodo = base / liquido - 1;
  const taxa_efetiva_aa = Math.pow(1 + taxa_periodo, 365 / dias) - 1;

  // Hurdle editável PRIMÁRIO (P1-3): ausente → só custo; unidade inválida → sem veredito.
  if (input.hurdle == null) {
    return { motivo: 'hurdle_indisponivel', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo: null, veredito: null };
  }
  if (!UNIDADES.includes(input.hurdle.unidade)) {
    return { motivo: 'hurdle_unidade_invalida', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo: null, veredito: null };
  }
  const hurdle_taxa_periodo = taxaParaPeriodo(input.hurdle.valor, input.hurdle.unidade, dias);
  const veredito = taxa_periodo > hurdle_taxa_periodo ? 'mais_caro' : 'dentro';
  return { motivo: 'ok', custo, taxa_periodo, taxa_efetiva_aa, hurdle_taxa_periodo, veredito };
}

/** Guard de entrada: lote multi-venc num prazo só inventa prazo → não suportado em v1 (registrar 1 por título). */
export function motivoFluxoRegistro(input: { lote?: boolean }): 'ok' | 'fluxo_nao_suportado' {
  return input.lote === true ? 'fluxo_nao_suportado' : 'ok';
}
```

- [ ] **Step 4: Rodar — deve PASSAR.** Run: `heavy bun run test antecipacao` → PASS (Tasks 1–3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/antecipacao-helpers.ts src/lib/financeiro/__tests__/antecipacao-helpers.test.ts
git commit -m "feat(financeiro): F4 Job B funding + conversão de unidade do hurdle (P1-3/P1-4/P1-5)"
```

---

### Task 4: Hurdle-sugestão do F1 (`sugerirHurdle`)

**Files:**
- Modify: `src/lib/financeiro/antecipacao-helpers.ts`
- Test: `src/lib/financeiro/__tests__/antecipacao-helpers.test.ts`

**Interfaces:**
- Consumes: `HurdleSugerido` (Task 1).
- Produces: `sugerirHurdle(dividas: Array<{ saldo: number; cet_aa: number | null }>): HurdleSugerido`.

**Nota (P1-3):** F1 é SUGESTÃO/fallback, não o primário. `cet_aa` do `fin_dividas` é CET (Custo Efetivo Total) → unidade `efetiva_aa`. Média ponderada pelo saldo devedor em aberto.

- [ ] **Step 1: Escrever o teste que falha:**

```typescript
import { sugerirHurdle } from '../antecipacao-helpers';

describe('sugerirHurdle — média ponderada do CET do F1 (fallback, unidade explícita)', () => {
  it('pondera cet_aa pelo saldo; unidade efetiva_aa', () => {
    const r = sugerirHurdle([{ saldo: 100_000, cet_aa: 0.20 }, { saldo: 300_000, cet_aa: 0.30 }]);
    expect(r.motivo).toBe('ok');
    expect(r.valor).toBeCloseTo(0.275, 6); // (100k*0,20 + 300k*0,30)/400k
    expect(r.unidade).toBe('efetiva_aa');
  });
  it('ignora dívidas sem cet_aa ou sem saldo (ausente ≠ zero)', () => {
    const r = sugerirHurdle([{ saldo: 100_000, cet_aa: null }, { saldo: 0, cet_aa: 0.5 }, { saldo: 200_000, cet_aa: 0.25 }]);
    expect(r.valor).toBeCloseTo(0.25, 6); // só a 3ª entra
  });
  it('nenhuma dívida com CET → sem_dados (não fabrica 0)', () => {
    const r = sugerirHurdle([{ saldo: 100_000, cet_aa: null }]);
    expect(r.motivo).toBe('sem_dados');
    expect(r.valor).toBeNull();
    expect(r.unidade).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR.** Run: `heavy bun run test antecipacao` → FAIL.

- [ ] **Step 3: Implementar** (append):

```typescript
/** Sugere um hurdle a partir do custo médio ponderado (por saldo) do CET das dívidas do F1.
 *  FALLBACK (P1-3): custo médio de dívida ativa ≠ custo marginal de hoje — o editável é primário.
 *  CET = efetiva a.a. → unidade 'efetiva_aa'. Ausente ≠ zero: ignora sem cet/saldo; nenhuma → sem_dados. */
export function sugerirHurdle(dividas: Array<{ saldo: number; cet_aa: number | null }>): HurdleSugerido {
  let pesoTotal = 0, somaPond = 0;
  for (const d of dividas) {
    const saldo = Number(d.saldo);
    const cet = d.cet_aa;
    if (cet == null || !Number.isFinite(cet) || !Number.isFinite(saldo) || saldo <= 0) continue;
    pesoTotal += saldo;
    somaPond += saldo * cet;
  }
  if (pesoTotal <= 0) return { valor: null, unidade: null, motivo: 'sem_dados' };
  return { valor: somaPond / pesoTotal, unidade: 'efetiva_aa', motivo: 'ok' };
}
```

- [ ] **Step 4: Rodar TODA a suíte do helper + typecheck:**

Run: `heavy bun run test antecipacao` → PASS (Tasks 1–4)
Run: `heavy bun run typecheck` → 0 erros

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/antecipacao-helpers.ts src/lib/financeiro/__tests__/antecipacao-helpers.test.ts
git commit -m "feat(financeiro): F4 hurdle-sugestão ponderada do CET (F1 fallback, unidade explícita)"
```

---

### Task 5: Migration `fin_antecipacoes` + prova PG17

**Files:**
- Create: `supabase/migrations/20260708120000_fin_antecipacoes.sql`
- Create: `db/test-fin-antecipacoes.sh`

**Interfaces:**
- Consumes: nada (SQL puro). Deve casar 1:1 com o tipo `Antecipacao` (Task 1) — colunas = campos.
- Produces: tabela `public.fin_antecipacoes` (o hook da Task 6 lê/escreve).

- [ ] **Step 1: Escrever a migration** (molde `fin_dre_custo_tipo`):

```sql
-- supabase/migrations/20260708120000_fin_antecipacoes.sql
-- F4 — Antecipação de recebíveis: registro MANUAL da operação (desconto de duplicata / linha rotativa).
-- Overlay analítico; NADA reescreve sync/DRE. Derivados (custo/taxa) moram no helper puro — a tabela
-- só guarda os fatos brutos. master-only (molde fin_dre_custo_tipo/fin_dividas). Idempotente (re-colável).
-- Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md (§2, §7, §8). Os 5 P1 no CHECK.

CREATE TABLE IF NOT EXISTS public.fin_antecipacoes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company            text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  banco              text,
  tipo               text NOT NULL CHECK (tipo IN ('duplicata','linha')),
  valor_bruto        numeric(15,2) NOT NULL,   -- FACE ANTECIPADA (suporta parcial — não a face total)
  custos_avulsos     numeric(15,2) NOT NULL DEFAULT 0,  -- IOF/tarifa FORA do líquido (P1-4)
  valor_liquido      numeric(15,2) NOT NULL,   -- o que efetivamente caiu na conta
  data_operacao      date NOT NULL,
  data_vencimento    date NOT NULL,
  operacao_origem_id uuid REFERENCES public.fin_antecipacoes(id) ON DELETE SET NULL, -- rollover (§7)
  referencia         text,                     -- contrato/banco (dedup manual)
  observacao         text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,              -- soft delete (preserva histórico de custo)
  CONSTRAINT fin_antecipacoes_valores_chk
    CHECK (valor_bruto > 0 AND valor_liquido > 0 AND custos_avulsos >= 0),
  -- P1-1: '=' é custo zero, VÁLIDO; inválido SÓ quando líquido > (bruto+avulsos).
  CONSTRAINT fin_antecipacoes_liquido_chk
    CHECK (valor_liquido <= valor_bruto + custos_avulsos),
  CONSTRAINT fin_antecipacoes_prazo_chk
    CHECK (data_vencimento > data_operacao)
);

COMMENT ON TABLE public.fin_antecipacoes IS
  'F4: operações de antecipação de recebíveis (registro manual master-only). Uma linha = uma operação = um vencimento (lote multi-venc → split). Derivados (custo/taxa) no helper puro; a tabela só guarda os fatos.';

-- Dedup: mesma referência não duplica (coalesce banco p/ deduplicar mesmo com banco nulo). Ignora soft-deleted.
CREATE UNIQUE INDEX IF NOT EXISTS fin_antecipacoes_ref_uq
  ON public.fin_antecipacoes (company, coalesce(banco, ''), referencia)
  WHERE referencia IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_antecipacoes_company_viva
  ON public.fin_antecipacoes (company, data_operacao) WHERE deleted_at IS NULL;

-- Trigger de autor/carimbo no servidor (SECURITY DEFINER + search_path='' — INVOKER quebra auth.uid(),
-- "permission denied for schema auth", pego pela prova PG17; molde fin_dre_custo_tipo).
CREATE OR REPLACE FUNCTION public.fin_antecipacoes_set_autor()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.created_at := now();
  END IF;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fin_antecipacoes_autor ON public.fin_antecipacoes;
CREATE TRIGGER trg_fin_antecipacoes_autor
  BEFORE INSERT OR UPDATE ON public.fin_antecipacoes
  FOR EACH ROW EXECUTE FUNCTION public.fin_antecipacoes_set_autor();

-- RLS master-only (verbatim ao padrão proven de fin_dre_custo_tipo).
ALTER TABLE public.fin_antecipacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_antecipacoes_select_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_select_master ON public.fin_antecipacoes
  FOR SELECT USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_antecipacoes_write_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_write_master ON public.fin_antecipacoes
  FOR ALL USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

DROP POLICY IF EXISTS fin_antecipacoes_service_all ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_service_all ON public.fin_antecipacoes
  FOR ALL USING (auth.role() = 'service_role');

SELECT 'fin_antecipacoes OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'fin_antecipacoes') AS policies;
```

- [ ] **Step 2: Escrever o harness prove-sql** (`db/test-fin-antecipacoes.sh`) — copie `db/test-fin-dre-custo-tipo.sh` verbatim das linhas 1–56 (setup PG17, stubs, `auth.uid()`/`auth.role()`, `user_roles`) trocando `SLUG="fin-antecipacoes"` e `MIG=".../20260708120000_fin_antecipacoes.sql"`. Depois os asserts:

```bash
# ── ZONA 3 — seed + grants ──────────────────────────────────────────────────────────────────────
MASTER='33333333-3333-3333-3333-333333333333'
NAOMASTER='22222222-2222-2222-2222-222222222222'
OUTRO='99999999-9999-9999-9999-999999999999'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$NAOMASTER') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master') ON CONFLICT DO NOTHING;
INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento,referencia) VALUES
  ('oben','Itaú','duplicata',100000,0,97000,'2026-01-01','2026-01-31','DUP-1'),
  ('oben','Itaú','linha',     50000,0,50000,'2026-02-01','2026-04-02','LINHA-1'); -- líquido==bruto: custo 0 VÁLIDO
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_antecipacoes TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

echo "── asserts ──"

# A1 POSITIVO: tabela existe, 2 linhas (inclui a de custo zero — P1-1 igualdade VÁLIDA)
V=$(Pq -c "SELECT count(*) FROM public.fin_antecipacoes;")
eq "A1 tabela existe, 2 linhas (uma com líquido==bruto, custo 0)" "$V" "2"

# A2 NEGATIVO: líquido > bruto+avulsos → check_violation (P1-1: inválido SÓ quando MAIOR)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',100000,0,100001,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'LIQ_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'LIQ_CHK_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *LIQ_CHK_OK*) ok "A2 CHECK rejeita líquido > bruto+avulsos" ;; *) bad "A2 liq — veio: $R" ;; esac

# A3 POSITIVO: líquido == bruto+avulsos é ACEITO (custo zero é válido, não inválido)
Pq -c "INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento) VALUES ('colacor','duplicata',10000,100,10100,'2026-03-01','2026-04-01');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_antecipacoes WHERE company='colacor';")
eq "A3 líquido == bruto+avulsos aceito (P1-1)" "$V" "1"

# A4 NEGATIVO: prazo não-positivo (venc <= operação) → check_violation
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,990,'2026-01-10','2026-01-10');
  RAISE EXCEPTION 'PRAZO_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PRAZO_CHK_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *PRAZO_CHK_OK*) ok "A4 CHECK exige prazo positivo" ;; *) bad "A4 prazo — veio: $R" ;; esac

# A5 NEGATIVO: dedup — mesma (company,banco,referencia) viva → unique_violation
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia)
    VALUES ('oben','Itaú','duplicata',100000,97000,'2026-05-01','2026-06-01','DUP-1');
  RAISE EXCEPTION 'DEDUP_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'DEDUP_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *DEDUP_OK*) ok "A5 unique parcial dedup por referência" ;; *) bad "A5 dedup — veio: $R" ;; esac

# A6 RLS: master vê; A7 não-master 0; A8 anon 0
MASTERV=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
NMV=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
ANONV=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
eq "A6 master vê"           "$MASTERV" "3"
eq "A7 não-master NÃO vê"   "$NMV"     "0"
eq "A8 anon NÃO vê"         "$ANONV"   "0"

# A9 RLS: não-master NÃO escreve → insufficient_privilege
R=$(P -tA 2>&1 <<SQL
SET test.uid='$NAOMASTER'; SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,990,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'RLS_WRITE_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_WRITE_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *RLS_WRITE_OK*) ok "A9 RLS nega escrita de não-master" ;; *) bad "A9 rls-write — veio: $R" ;; esac

# A10 TRIGGER: master insere passando created_by/updated_by falsos → trigger sobrescreve p/ auth.uid()
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,created_by,updated_by) VALUES ('oben','duplicata',2000,1900,'2026-07-01','2026-08-01','$OUTRO','$OUTRO');" >/dev/null
V=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT updated_by||'/'||created_by FROM public.fin_antecipacoes WHERE company='oben' AND valor_bruto=2000;" | tail -1)
eq "A10 trigger força created_by/updated_by=auth.uid()" "$V" "$MASTER/$MASTER"

# ══ FALSIFICAÇÃO (Lei #3) — sabota → exige VERMELHO → restaura ══
echo "── falsificação ──"

# F1: policy SELECT furada (USING true) → não-master passa a VER → A7 perde o dente
P -q <<'SQL'
DROP POLICY IF EXISTS fin_antecipacoes_select_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_select_master ON public.fin_antecipacoes FOR SELECT USING (true);
SQL
NMV2=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
if [ "$NMV2" != "0" ]; then ok "F1 policy furada deixou não-master ver ($NMV2) → A7 tem dente"; else bad "F1 sabotei e não-master AINDA não vê → A7 fraco"; fi
P -q -f "$MIG" >/dev/null
NMV3=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
eq "F1' restaurada: não-master volta a NÃO ver" "$NMV3" "0"

# F2: dropa o CHECK do líquido → líquido > bruto+avulsos passa → A2 perde o dente
P -q -c "ALTER TABLE public.fin_antecipacoes DROP CONSTRAINT fin_antecipacoes_liquido_chk;"
if P -q -c "INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento) VALUES ('colacor_sc','duplicata',100,200,'2026-01-01','2026-02-01');" >/dev/null 2>&1; then
  ok "F2 sem o CHECK, líquido > bruto passou → A2 tinha dente"
else
  bad "F2 droppei o CHECK e o INSERT AINDA falhou → A2 não provava o CHECK"
fi
P -q -c "DELETE FROM public.fin_antecipacoes WHERE company='colacor_sc';"
P -q -c "ALTER TABLE public.fin_antecipacoes ADD CONSTRAINT fin_antecipacoes_liquido_chk CHECK (valor_liquido <= valor_bruto + custos_avulsos);"

# F3: dropa o trigger → created_by do cliente NÃO é sobrescrito → A10 perde o dente
P -q -c "DROP TRIGGER IF EXISTS trg_fin_antecipacoes_autor ON public.fin_antecipacoes;"
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,created_by) VALUES ('colacor','linha',3000,2900,'2026-09-01','2026-10-01','$OUTRO');" >/dev/null
V=$(Pq -c "SELECT created_by FROM public.fin_antecipacoes WHERE company='colacor' AND valor_bruto=3000;")
if [ "$V" = "$OUTRO" ]; then ok "F3 sem o trigger, created_by do cliente persistiu → A10 tinha dente"; else bad "F3 droppei o trigger e created_by AINDA foi sobrescrito → A10 fraco"; fi
P -q -f "$MIG" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
```

- [ ] **Step 3: Rodar a prova PG17 — deve dar VERDE (asserts + falsificação):**

Run: `bash db/test-fin-antecipacoes.sh > /tmp/f4-prove.log 2>&1; echo "exit=$?"`
Expected: `exit=0` e `✅ HARNESS VERDE` (todos os A1–A10 ok, F1/F2/F3 com dente)

- [ ] **Step 4: Falsificar a falsificação** — sabotar a migration DE PROPÓSITO e exigir VERMELHO. Troque no arquivo o CHECK do líquido para `>=` (o bug que o Codex pegou), rode o harness, confirme que A2/A3 ficam VERMELHOS, depois **reverta**:

Run: (editar `<=`→`>=` no `fin_antecipacoes_liquido_chk`) `bash db/test-fin-antecipacoes.sh; echo exit=$?`
Expected: `exit=1` / `❌ HARNESS VERMELHO` — prova que o harness tem dente. **Reverter para `<=`** e rodar de novo → VERDE.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260708120000_fin_antecipacoes.sql db/test-fin-antecipacoes.sh
git commit -m "feat(financeiro): F4 migration fin_antecipacoes + prova PG17 (RLS/CHECKs/trigger/dedup, falsificada)"
```

---

### Task 6: Hook `useAntecipacoes` (CRUD + soft delete + hurdle do F1)

**Files:**
- Create: `src/hooks/useAntecipacoes.ts`

**Interfaces:**
- Consumes: `Antecipacao`, `Company`, `HurdleSugerido`, `sugerirHurdle` (Tasks 1/4); `useDividas` de `@/hooks/useEndividamento`; `saldoDevedorEmAberto` de `@/lib/financeiro/endividamento-helpers`.
- Produces: `useAntecipacoes(company)`, `useUpsertAntecipacao()`, `useSoftDeleteAntecipacao()`, `useHurdleSugerido(company)`.

Molde: `useEndividamento.ts` (cast-through-unknown, react-query, invalidate). Escrita passa `deleted_at: null` no insert; soft delete = UPDATE `deleted_at = now()` (não DELETE). Lista filtra `deleted_at IS NULL` no cliente (a RLS não filtra soft-delete).

- [ ] **Step 1: Implementar o hook** (sem teste unitário — molde sem teste de hook; a prova é typecheck+lint+build+Codex):

```typescript
// src/hooks/useAntecipacoes.ts
// F4 — camada de dados (react-query). fin_antecipacoes é master-only (RLS) e NÃO está nos tipos
// gerados → cast through unknown (molde verbatim de useEndividamento.ts; ESLint barra `any`).
// Soft delete: UPDATE deleted_at (nunca DELETE — preserva histórico de custo). Hurdle-sugestão
// derivada do F1 (fin_dividas.cet_aa ponderado pelo saldo devedor em aberto — fallback, P1-3).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { sugerirHurdle } from '@/lib/financeiro/antecipacao-helpers';
import { saldoDevedorEmAberto } from '@/lib/financeiro/endividamento-helpers';
import { useDividas, useParcelas } from '@/hooks/useEndividamento';
import type { Antecipacao, Company, HurdleSugerido } from '@/lib/financeiro/antecipacao-types';
import { useMemo } from 'react';

const STALE = 60_000;

type SelectClient = { from: (t: string) => { select: (c: string) => {
  eq: (col: string, val: string) => { order: (col: string, o?: { ascending?: boolean }) =>
    Promise<{ data: unknown[] | null; error: { message: string } | null }> } } } };
type UpsertClient = { from: (t: string) => { upsert: (
  v: Record<string, unknown>, o?: { onConflict: string }) => Promise<{ error: { message: string } | null }> } };
type UpdateClient = { from: (t: string) => { update: (v: Record<string, unknown>) => {
  eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> } } };

/** Operações vivas (deleted_at IS NULL) de uma empresa, mais recentes primeiro. */
export function useAntecipacoes(company: Company | string) {
  return useQuery({
    queryKey: ['antecipacoes', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Antecipacao[]> => {
      const client = supabase as unknown as SelectClient;
      const { data, error } = await client
        .from('fin_antecipacoes').select('*')
        .eq('company', company).order('data_operacao', { ascending: false });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Antecipacao[]).filter((a) => a.deleted_at == null);
    },
  });
}

/** Insert (sem id) ou update (com id). Trigger cuida de created_by/updated_by/at. */
export function useUpsertAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: Partial<Antecipacao> & { company: Company }) => {
      const client = supabase as unknown as UpsertClient;
      const { error } = await client.from('fin_antecipacoes').upsert({ ...op }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] }); toast.success('Operação salva.'); },
    onError: (e) => toast.error('Falha ao salvar operação', { description: e instanceof Error ? e.message : String(e) }),
  });
}

/** Soft delete: marca deleted_at (não apaga — preserva histórico de custo). */
export function useSoftDeleteAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; company: Company }) => {
      const client = supabase as unknown as UpdateClient;
      const { error } = await client.from('fin_antecipacoes')
        .update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] }); toast.success('Operação removida.'); },
    onError: (e) => toast.error('Falha ao remover operação', { description: e instanceof Error ? e.message : String(e) }),
  });
}

/** Hurdle-sugestão a partir do custo médio ponderado do CET das dívidas do F1 (fallback com unidade). */
export function useHurdleSugerido(company: Company | string): HurdleSugerido {
  const { data: dividas } = useDividas(company);
  const dividaIds = useMemo(() => (dividas ?? []).map((d) => d.id), [dividas]);
  const { data: parcelas } = useParcelas(dividaIds);
  return useMemo<HurdleSugerido>(() => {
    if (!dividas) return { valor: null, unidade: null, motivo: 'sem_dados' };
    return sugerirHurdle(
      dividas.filter((d) => d.ativo).map((d) => ({ saldo: saldoDevedorEmAberto(d, parcelas ?? []), cet_aa: d.cet_aa })),
    );
  }, [dividas, parcelas]);
}
```

- [ ] **Step 2: Verificar typecheck + lint:**

Run: `heavy bun run typecheck` → 0 erros
Run: `bun run lint` → 0 erros (atenção ao `no-restricted-syntax`/`no-explicit-any` — o cast é através de `unknown`, sem `any`)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAntecipacoes.ts
git commit -m "feat(financeiro): F4 hook useAntecipacoes (CRUD, soft delete, hurdle do F1)"
```

---

### Task 7: UI — página `/financeiro/antecipacao` (lista/CRUD + Job A + Job B) + rota

**Files:**
- Create: `src/pages/FinanceiroAntecipacao.tsx`
- Create: `src/components/financeiro/antecipacao/AntecipacaoFormDialog.tsx`
- Create: `src/components/financeiro/antecipacao/MedidorCustoCard.tsx`
- Create: `src/components/financeiro/antecipacao/CalculadoraFunding.tsx`
- Modify: `src/App.tsx` (registrar rota lazy, ~linha 122 e ~281)

**Interfaces:**
- Consumes: hooks da Task 6; helpers `medirCusto`/`compararFunding`/`motivoFluxoRegistro` (Tasks 2/3); `fmt`/`fmtCompact`/`fmtDate` de `@/components/financeiro/dashboard/format`; `useAuth().isMaster`; `useCompany`/`COMPANIES`.
- Produces: rota `/financeiro/antecipacao`.

Molde estrutural: `src/pages/FinanceiroEndividamento.tsx` (header + `<select>` de empresa + `PageSkeleton` + lista `Table` + `AntecipacaoFormDialog` + `AlertDialog` de confirmação → mas soft delete). Dialog: molde `DividaFormDialog`/`ClassificacaoCustoDialog`. Card Job A: molde `PontoEquilibrioCard` (motivo honesto por `MOTIVO_MSG`, sempre R$ + taxa período + a.a.). Calculadora Job B: `Card` com inputs (valor, dias, líquido OU taxa+unidade, custos avulsos, hurdle editável com botão "usar sugestão do F1 {valor}% efetiva a.a.").

**Regras de UI (money-path honesto — spec §3/§4/§5):**
- `!isMaster` → `<EmptyState tone="operational">` "Acesso restrito" (molde F1).
- Job A: se `motivo !== 'ok'` mostrar mensagem honesta (`sem_operacoes` → "sem antecipações **registradas** no período"; `dados_parciais` → aviso "{n} operação(ões) inválida(s) excluída(s)"). SEMPRE exibir R$ + taxa do período + taxa a.a. juntos; nunca só a a.a.
- Job B: `veredito==='mais_caro'` → "mais caro que sua alternativa de crédito" (`text-status-warning`); `'dentro'` → "dentro do seu custo de funding" (`text-status-success`). NUNCA "vale a pena". Motivos `hurdle_indisponivel`/`hurdle_unidade_invalida`/`inputs_conflitantes`/`fluxo_nao_suportado` → mensagem honesta, sem veredito.
- Form: ao marcar "é um lote de vários vencimentos?", `motivoFluxoRegistro` bloqueia o submit com orientação "registre uma operação por título/vencimento".

- [ ] **Step 1: Escrever `AntecipacaoFormDialog.tsx`** (molde `DividaFormDialog`; campos = colunas de `fin_antecipacoes` exceto auditoria/id; `react-hook-form`+`zod`; guard de lote via `motivoFluxoRegistro`; chama `useUpsertAntecipacao`). Reproduzir o padrão de dialog de `ClassificacaoCustoDialog` (Dialog/DialogContent/Input/Select/Button).

- [ ] **Step 2: Escrever `MedidorCustoCard.tsx`** (molde `PontoEquilibrioCard`): recebe `ops: Antecipacao[]`, chama `medirCusto`, renderiza `MOTIVO_MSG` honesto ou os 3 números (custo_total R$, taxa do período implícita da média, taxa_realizada_aa) + mini-tendência mensal. Reusar `fmt`/`fmtCompact`.

- [ ] **Step 3: Escrever `CalculadoraFunding.tsx`**: form controlado (`useState`/`useUrlState` não necessário — é efêmero), chama `compararFunding` a cada mudança (`useMemo`), mostra custo R$ + taxa período + a.a. + comparação com hurdle. Botão "usar sugestão do F1" injeta `useHurdleSugerido(company)` (rotulando a unidade). Select de unidade do hurdle e da taxa ofertada (`efetiva_aa`/`nominal_aa`/`efetiva_am`) com rótulos pt-BR.

- [ ] **Step 4: Escrever `FinanceiroAntecipacao.tsx`** (molde `FinanceiroEndividamento`): header "Antecipação de recebíveis" + `<select>` empresa + botão "Nova operação"; `MedidorCustoCard` (Job A) no topo; `CalculadoraFunding` (Job B); lista `Table` das operações (banco, tipo, face antecipada, líquido, custo derivado, dias, venc, ações editar/remover); `AntecipacaoFormDialog`; `AlertDialog` de confirmação de soft delete. Gate `!isMaster` → EmptyState.

- [ ] **Step 5: Registrar a rota no `App.tsx`** — adicionar o lazy import junto aos demais (~linha 122) e a `<Route>` junto às de financeiro (~linha 281):

```typescript
// junto aos outros lazy imports de Financeiro (~linha 122):
const FinanceiroAntecipacao = lazy(() => import("./pages/FinanceiroAntecipacao"));
```
```typescript
// junto às <Route> de financeiro (~linha 281, depois de endividamento):
<Route path="financeiro/antecipacao" element={<FinanceiroAntecipacao />} />
```

- [ ] **Step 6: Verificar toda a stack:**

Run: `heavy bun run typecheck` → 0 erros
Run: `bun run lint` → 0 erros
Run: `heavy bun run test` → suíte cheia verde (helper F4 + regressões)
Run: `heavy bun run build` → build passa (rota lazy resolve)

- [ ] **Step 7: /verify** — subir o app, logar como master, abrir `/financeiro/antecipacao`, registrar 1 operação, ver o Job A recalcular, rodar a calculadora Job B com e sem hurdle, confirmar veredito de funding (não "vale a pena"), remover (soft delete) e confirmar que some da lista.

- [ ] **Step 8: Commit**

```bash
git add src/pages/FinanceiroAntecipacao.tsx src/components/financeiro/antecipacao/ src/App.tsx
git commit -m "feat(financeiro): F4 UI antecipação — página, medidor (Job A), calculadora funding (Job B)"
```

---

## Verificação final (antes do PR)

- [ ] `heavy bun run test antecipacao` — helper verde (fórmula, TODOS os motivos §5, money-weighted reconcilia com R$, unidade do hurdle, igualdade válida).
- [ ] `heavy bun run typecheck` + `bun run lint` — limpos.
- [ ] `bash db/test-fin-antecipacoes.sh; echo exit=$?` — `exit=0` VERDE (com a falsificação provada em T5S4).
- [ ] `heavy bun run test` (suíte cheia) — verde (sem regressão).
- [ ] `heavy bun run build` — passa.
- [ ] **Codex adversarial NO CÓDIGO** (`scripts/codex-async.sh -r xhigh -` em background) sobre o diff completo (helper money-math + migration + hook + UI) — endereçar P1/P2 antes do PR.
- [ ] Abrir PR (não-draft → auto-merge no verde) + `scripts/pr-watch.sh <nº>` em background.

## Handoff do founder (DEPOIS do merge) — spec §6, `deploy.md`

- 🟣 **SQL Editor:** aplicar `20260708120000_fin_antecipacoes.sql` (empacotar via `lovable-db-operator` + query de validação `SELECT count(*) FROM pg_policies WHERE tablename='fin_antecipacoes'` = 3).
- 🖱️ **Publish frontend** (Lovable) — nova rota/página. Sem edge (só frontend + banco).

## Self-review (feito na escrita do plano)

- **Cobertura da spec:** §2 modelo → T5 (migration) + T1 (tipos). §3 Job A money-weighted → T2. §4 Job B funding + hurdle unidade → T3. §5 TODOS os motivos → T1 (`dados_invalidos`), T2 (`sem_operacoes`/`dados_parciais`), T3 (`hurdle_unidade_invalida`/`inputs_conflitantes`/`hurdle_indisponivel`/`fluxo_nao_suportado`), T6 hook (`erro_consulta`/`permissao_negada` via throw→UI). §6 conexão F1→hurdle → T4+T6. §7 escopo v1 (1 venc/op, rollover incremental, parcial, avulsos) → T5 schema + T3 guard. §8 wiring → T5–T7. §9 provas → tests + prove-sql. §11 os 5 P1 → marcados inline (P1-1..P1-5).
- **Placeholders:** nenhum — todo step de código tem o código; migration e prove-sql completos; UI referencia molde exato + regras concretas.
- **Consistência de tipos:** `custoOperacao`/`medirCusto`/`compararFunding`/`sugerirHurdle`/`taxaParaPeriodo`/`motivoFluxoRegistro` e os tipos do contrato batem entre T1–T7 e o hook. `HurdleUnidade` usada igual em oferta e hurdle. `deleted_at` filtrado no helper (T2) e no hook (T6).
- **Decisões documentadas p/ Codex:** unidade `nominal_aa` = linear/proporcional; dedup com `coalesce(banco,'')`; `fluxo_nao_suportado` via sinal explícito `lote` (único lugar onde a info existe).
