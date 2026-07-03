# Tipologia Fleuriet / cobertura estrutural do giro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Cockpit financeiro um selo de cobertura estrutural do giro (modelo Fleuriet/Braga), classificado as-of o balancete, sem fabricar número.

**Architecture:** Helper TS puro (`fleuriet-helpers.ts`, coberto por vitest) faz toda a lógica: `CDG = (PL+PNC)−ANC`, NCG casado ao snapshot da engine na data do balancete (±7d), classificação por sinais com banda de materialidade, status de cobertura + tipo de Braga. Inputs de balanço numa tabela dedicada `fin_balanco_inputs` (RLS master-only, versionada por `data_ref`). Selo por empresa no Cockpit; input master-only num dialog.

**Tech Stack:** React 18 + TS strict, vitest, Supabase (Postgres + RLS), Tailwind + tokens `status-*`. Spec: `docs/superpowers/specs/2026-07-01-fleuriet-cobertura-giro-cockpit-design.md`.

---

## File Structure

- **Create** `src/lib/financeiro/fleuriet-helpers.ts` — toda a lógica pura (cálculo, sinais, matriz, casamento temporal, montagem por empresa).
- **Create** `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts` — testes vitest.
- **Create (via skills)** migration `fin_balanco_inputs` — provada em PG17, aplicada pelo Lovable.
- **Modify** `src/services/financeiroV2Service.ts` — `getBalancoInputs`, `getNcgHistorico`.
- **Create** `src/components/financeiro/cockpit/FleurietBadge.tsx` — selo.
- **Create** `src/components/financeiro/cockpit/BalancoInputDialog.tsx` — input master-only.
- **Modify** `src/components/financeiro/cockpit/useFinanceiroCockpit.ts` — carregar balanço + NCG histórico + montar classificação.
- **Modify** `src/pages/FinanceiroCockpit.tsx` — renderizar o selo.

Convenção do módulo: `round2` local, `ausente ≠ 0` (null propaga), helper puro testado antes de fiar na UI.

---

## Task 1: Tipos base + `calcularCDG`

**Files:**
- Create: `src/lib/financeiro/fleuriet-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { calcularCDG } from '../fleuriet-helpers';

describe('calcularCDG', () => {
  it('CDG = (PL + PNC) − ANC', () => {
    expect(calcularCDG({ anc: 100, pnc: 40, pl: 90 })).toBe(30);
  });
  it('negativo é real (não vira 0)', () => {
    expect(calcularCDG({ anc: 200, pnc: 10, pl: 50 })).toBe(-140);
  });
  it('qualquer componente ausente → null (ausente ≠ 0)', () => {
    expect(calcularCDG({ anc: null, pnc: 40, pl: 90 })).toBeNull();
    expect(calcularCDG({ anc: 100, pnc: null, pl: 90 })).toBeNull();
    expect(calcularCDG({ anc: 100, pnc: 40, pl: null })).toBeNull();
  });
  it('não-finito → null', () => {
    expect(calcularCDG({ anc: Infinity, pnc: 40, pl: 90 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: FAIL ("calcularCDG is not a function" / módulo inexistente).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/financeiro/fleuriet-helpers.ts
// Modelo de Fleuriet/Braga (cobertura estrutural do giro). Puro, espelhável no edge.
// Regra-mãe: nunca fabrica número — ausente = null + motivo. Ver spec 2026-07-01.

export type Sinal = '+' | '-' | '~0' | null;
export type StatusCobertura =
  | 'coberta' | 'descoberta' | 'operacao_financia_giro'
  | 'fronteira' | 'inconsistente' | 'indisponivel';
export type TipoFleuriet = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | null;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// CDG estrutural = (PL + PNC) − ANC. Qualquer componente ausente/não-finito → null.
export function calcularCDG(i: { anc: number | null; pnc: number | null; pl: number | null }): number | null {
  const { anc, pnc, pl } = i;
  if (anc == null || pnc == null || pl == null) return null;
  if (!Number.isFinite(anc) || !Number.isFinite(pnc) || !Number.isFinite(pl)) return null;
  return round2((pl + pnc) - anc);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fleuriet-helpers.ts src/lib/financeiro/__tests__/fleuriet-helpers.test.ts
git commit -m "feat(financeiro): calcularCDG do modelo Fleuriet (helper puro)"
```

---

## Task 2: `materialidade` + `sinalComBanda`

**Files:**
- Modify: `src/lib/financeiro/fleuriet-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { materialidade, sinalComBanda } from '../fleuriet-helpers';

describe('materialidade', () => {
  it('max(1% da receita mensal, R$500)', () => {
    expect(materialidade({ receita_liquida_mensal: 100000 })).toBe(1000); // 1% = 1000 > 500
    expect(materialidade({ receita_liquida_mensal: 20000 })).toBe(500);   // 1% = 200 < 500
  });
  it('receita ausente/inválida → piso R$500', () => {
    expect(materialidade({ receita_liquida_mensal: null })).toBe(500);
    expect(materialidade({ receita_liquida_mensal: 0 })).toBe(500);
    expect(materialidade({ receita_liquida_mensal: -5 })).toBe(500);
  });
});

describe('sinalComBanda', () => {
  it('acima da banda → +, abaixo → −, dentro → ~0', () => {
    expect(sinalComBanda(1000, 500)).toBe('+');
    expect(sinalComBanda(-1000, 500)).toBe('-');
    expect(sinalComBanda(300, 500)).toBe('~0');
    expect(sinalComBanda(-500, 500)).toBe('~0'); // limite inclusivo na banda
    expect(sinalComBanda(500, 500)).toBe('~0');
  });
  it('null/não-finito → null', () => {
    expect(sinalComBanda(null, 500)).toBeNull();
    expect(sinalComBanda(Infinity, 500)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: FAIL ("materialidade is not a function").

- [ ] **Step 3: Write minimal implementation** (append ao helper)

```ts
// Banda de materialidade: max(1% da receita líquida mensal, R$500 absoluto). Evita
// que ruído perto de zero troque de Tipo. Receita ausente → piso R$500.
export function materialidade(i: { receita_liquida_mensal: number | null }): number {
  const R = i.receita_liquida_mensal;
  if (R == null || !Number.isFinite(R) || R <= 0) return 500;
  return Math.max(0.01 * R, 500);
}

// Sinal com banda: |x| ≤ m → '~0' (fronteira). null/não-finito → null (ausência, não 0).
export function sinalComBanda(x: number | null, m: number): Sinal {
  if (x == null || !Number.isFinite(x)) return null;
  if (x > m) return '+';
  if (x < -m) return '-';
  return '~0';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fleuriet-helpers.ts src/lib/financeiro/__tests__/fleuriet-helpers.test.ts
git commit -m "feat(financeiro): materialidade + sinalComBanda"
```

---

## Task 3: `tipoPorSinais` (matriz de Braga, 6 tipos + 2 impossíveis)

**Files:**
- Modify: `src/lib/financeiro/fleuriet-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { tipoPorSinais } from '../fleuriet-helpers';

describe('tipoPorSinais (matriz de Braga)', () => {
  it('os 6 tipos válidos', () => {
    expect(tipoPorSinais({ cdg: '+', ncg: '-', t: '+' })).toEqual({ tipo: 'I', rotulo: 'Excelente', inconsistente: false });
    expect(tipoPorSinais({ cdg: '+', ncg: '+', t: '+' })).toEqual({ tipo: 'II', rotulo: 'Sólida', inconsistente: false });
    expect(tipoPorSinais({ cdg: '+', ncg: '+', t: '-' })).toEqual({ tipo: 'III', rotulo: 'Insatisfatória', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '+', t: '-' })).toEqual({ tipo: 'IV', rotulo: 'Péssima', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '-', t: '-' })).toEqual({ tipo: 'V', rotulo: 'Muito ruim', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '-', t: '+' })).toEqual({ tipo: 'VI', rotulo: 'Alto risco', inconsistente: false });
  });
  it('as 2 combinações impossíveis por identidade', () => {
    expect(tipoPorSinais({ cdg: '+', ncg: '-', t: '-' })).toEqual({ tipo: null, rotulo: null, inconsistente: true });
    expect(tipoPorSinais({ cdg: '-', ncg: '+', t: '+' })).toEqual({ tipo: null, rotulo: null, inconsistente: true });
  });
  it('sinal ~0/null → sem tipo, sem inconsistência (tratado como fronteira fora daqui)', () => {
    expect(tipoPorSinais({ cdg: '~0', ncg: '+', t: '-' })).toEqual({ tipo: null, rotulo: null, inconsistente: false });
    expect(tipoPorSinais({ cdg: null, ncg: null, t: null })).toEqual({ tipo: null, rotulo: null, inconsistente: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: FAIL ("tipoPorSinais is not a function").

- [ ] **Step 3: Write minimal implementation** (append)

```ts
// Matriz de Braga por sinais (CDG, NCG, T). As duas combinações '+--' e '-++' são
// impossíveis por identidade T=CDG−NCG (na v1, T é derivado, então nunca ocorrem via
// valores reais — a guarda existe para o dia em que T for medido independente).
export function tipoPorSinais(s: { cdg: Sinal; ncg: Sinal; t: Sinal }): {
  tipo: TipoFleuriet; rotulo: string | null; inconsistente: boolean;
} {
  const key = `${s.cdg ?? '?'}${s.ncg ?? '?'}${s.t ?? '?'}`;
  switch (key) {
    case '+-+': return { tipo: 'I', rotulo: 'Excelente', inconsistente: false };
    case '+++': return { tipo: 'II', rotulo: 'Sólida', inconsistente: false };
    case '++-': return { tipo: 'III', rotulo: 'Insatisfatória', inconsistente: false };
    case '-+-': return { tipo: 'IV', rotulo: 'Péssima', inconsistente: false };
    case '---': return { tipo: 'V', rotulo: 'Muito ruim', inconsistente: false };
    case '--+': return { tipo: 'VI', rotulo: 'Alto risco', inconsistente: false };
    case '+--': return { tipo: null, rotulo: null, inconsistente: true };
    case '-++': return { tipo: null, rotulo: null, inconsistente: true };
    default:    return { tipo: null, rotulo: null, inconsistente: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: PASS (8 casos cobertos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fleuriet-helpers.ts src/lib/financeiro/__tests__/fleuriet-helpers.test.ts
git commit -m "feat(financeiro): tipoPorSinais — matriz de Braga (6 tipos + impossiveis)"
```

---

## Task 4: `classificarFleuriet` (integra sinais → status + tipo + gap + cobertura + degradação)

**Files:**
- Modify: `src/lib/financeiro/fleuriet-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { classificarFleuriet } from '../fleuriet-helpers';

describe('classificarFleuriet', () => {
  const m = 500;
  it('Tipo II Sólida + coberta (CDG cobre NCG positiva)', () => {
    const r = classificarFleuriet({ cdg: 3000, ncg: 2000, materialidade: m });
    expect(r.status).toBe('coberta');
    expect(r.tipo).toBe('II'); expect(r.rotulo).toBe('Sólida');
    expect(r.gap).toBe(1000); expect(r.cobertura).toBe(1.5);
  });
  it('Tipo III Insatisfatória → descoberta (CDG < NCG positiva)', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: 3000, materialidade: m });
    expect(r.status).toBe('descoberta'); expect(r.tipo).toBe('III'); expect(r.gap).toBe(-1000);
  });
  it('NCG negativa → operacao_financia_giro (Tipo I)', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: -1000, materialidade: m });
    expect(r.status).toBe('operacao_financia_giro'); expect(r.tipo).toBe('I');
    expect(r.cobertura).toBeNull(); // cobertura só quando NCG > m
  });
  it('componente dentro da banda → fronteira, sem tipo', () => {
    const r = classificarFleuriet({ cdg: 300, ncg: 3000, materialidade: m });
    expect(r.status).toBe('fronteira'); expect(r.tipo).toBeNull();
    expect(r.sinais.cdg).toBe('~0');
  });
  it('cdg null → indisponivel com motivo', () => {
    const r = classificarFleuriet({ cdg: null, ncg: 2000, materialidade: m });
    expect(r.status).toBe('indisponivel'); expect(r.tipo).toBeNull();
    expect(r.motivos.some(x => /Balanço/.test(x))).toBe(true);
  });
  it('ncg null → indisponivel com motivo', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: null, materialidade: m });
    expect(r.status).toBe('indisponivel');
    expect(r.motivos.some(x => /NCG/.test(x))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: FAIL ("classificarFleuriet is not a function").

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export type ClassificacaoFleuriet = {
  status: StatusCobertura;
  tipo: TipoFleuriet;
  rotulo: string | null;
  cdg: number | null;
  ncg: number | null;
  gap: number | null;          // CDG − NCG (o "T"; caveat: NCG é gerencial, não contábil)
  cobertura: number | null;    // CDG/NCG quando NCG > materialidade; senão null
  sinais: { cdg: Sinal; ncg: Sinal; t: Sinal };
  motivos: string[];
};

export function classificarFleuriet(i: { cdg: number | null; ncg: number | null; materialidade: number }): ClassificacaoFleuriet {
  const { cdg, ncg, materialidade: m } = i;
  const vazio = { cdg, ncg, gap: null as number | null, cobertura: null as number | null,
    sinais: { cdg: null as Sinal, ncg: null as Sinal, t: null as Sinal }, tipo: null as TipoFleuriet, rotulo: null as string | null };

  if (cdg == null || ncg == null) {
    const motivos: string[] = [];
    if (cdg == null) motivos.push('Balanço não informado — CDG indisponível.');
    if (ncg == null) motivos.push('NCG indisponível na data do balanço.');
    return { ...vazio, status: 'indisponivel', motivos };
  }

  const gap = round2(cdg - ncg);
  const sinais = { cdg: sinalComBanda(cdg, m), ncg: sinalComBanda(ncg, m), t: sinalComBanda(gap, m) };
  const cobertura = ncg > m ? round2(cdg / ncg) : null;

  if (sinais.cdg === '~0' || sinais.ncg === '~0' || sinais.t === '~0') {
    return { ...vazio, gap, cobertura, sinais, status: 'fronteira',
      motivos: ['Componente próximo de zero (banda de materialidade) — sem classificação de Tipo.'] };
  }

  const { tipo, rotulo, inconsistente } = tipoPorSinais(sinais);
  if (inconsistente) {
    return { ...vazio, gap, cobertura, sinais, status: 'inconsistente',
      motivos: ['Combinação de sinais impossível por identidade — revisar inputs do balanço.'] };
  }

  const status: StatusCobertura = sinais.ncg === '-' ? 'operacao_financia_giro' : (gap >= 0 ? 'coberta' : 'descoberta');
  return { ...vazio, gap, cobertura, sinais, tipo, rotulo, status, motivos: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fleuriet-helpers.ts src/lib/financeiro/__tests__/fleuriet-helpers.test.ts
git commit -m "feat(financeiro): classificarFleuriet — status de cobertura + tipo + degradacao"
```

---

## Task 5: Casamento temporal `escolherSnapshotNaData` + montagem `classificarFleurietEmpresa`

**Files:**
- Modify: `src/lib/financeiro/fleuriet-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { escolherSnapshotNaData, classificarFleurietEmpresa } from '../fleuriet-helpers';

describe('escolherSnapshotNaData (±7d)', () => {
  const snaps = [
    { ncg: 2000, snapshot_at: '2026-03-28T03:00:00Z' }, // 3d antes de 31/03
    { ncg: 2500, snapshot_at: '2026-04-10T03:00:00Z' }, // 10d depois
  ];
  it('escolhe o mais próximo dentro da janela', () => {
    const r = escolherSnapshotNaData({ snapshots: snaps, dataRef: '2026-03-31' });
    expect(r.ncg).toBe(2000); expect(r.fora_janela).toBe(false); expect(r.dias_delta).toBe(-3);
  });
  it('fora de ±7d → ncg null + fora_janela', () => {
    const r = escolherSnapshotNaData({ snapshots: [{ ncg: 2500, snapshot_at: '2026-04-10T03:00:00Z' }], dataRef: '2026-03-31' });
    expect(r.ncg).toBeNull(); expect(r.fora_janela).toBe(true); expect(r.dias_delta).toBe(10);
  });
  it('sem snapshots com ncg → fora_janela', () => {
    const r = escolherSnapshotNaData({ snapshots: [{ ncg: null, snapshot_at: '2026-03-31T03:00:00Z' }], dataRef: '2026-03-31' });
    expect(r.ncg).toBeNull(); expect(r.fora_janela).toBe(true);
  });
});

describe('classificarFleurietEmpresa', () => {
  const hoje = Date.parse('2026-07-01T00:00:00Z');
  const snaps = [{ ncg: 2000, snapshot_at: '2026-03-31T03:00:00Z' }];
  it('balanço null → indisponivel + confianca null', () => {
    const r = classificarFleurietEmpresa({ balanco: null, snapshots: snaps, receita_liquida_mensal: 100000, hojeMs: hoje });
    expect(r.status).toBe('indisponivel'); expect(r.confianca).toBeNull(); expect(r.data_balanco).toBeNull();
  });
  it('balanço + NCG na data → classifica, expõe as duas datas', () => {
    const r = classificarFleurietEmpresa({
      balanco: { anc: 1000, pnc: 500, pl: 2500, data_ref: '2026-03-31' }, // CDG = 2000
      snapshots: snaps, receita_liquida_mensal: 100000, hojeMs: hoje,
    });
    expect(r.cdg).toBe(2000); expect(r.ncg).toBe(2000); expect(r.status).toBe('coberta');
    expect(r.data_balanco).toBe('2026-03-31'); expect(r.data_ncg).toBe('2026-03-31T03:00:00Z');
    expect(r.confianca).toBe('alta'); // ~92 dias < limiar 180
  });
  it('balanço antigo (> 180d) → confianca media', () => {
    const r = classificarFleurietEmpresa({
      balanco: { anc: 1000, pnc: 500, pl: 2500, data_ref: '2025-06-30' }, // > 1 ano
      snapshots: [{ ncg: 2000, snapshot_at: '2025-06-30T03:00:00Z' }], receita_liquida_mensal: 100000, hojeMs: hoje,
    });
    expect(r.confianca).toBe('media');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: FAIL ("escolherSnapshotNaData is not a function").

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export type SnapNcgData = { ncg: number | null; snapshot_at: string };

// Escolhe o snapshot com snapshot_at mais próximo de dataRef ('YYYY-MM-DD'). Fora de
// ±janelaDias → ncg null + fora_janela (não classifica com NCG de outra data). Ignora
// snapshots com ncg null. Mantém snapshot_at do mais próximo para exibir a defasagem.
export function escolherSnapshotNaData(i: { snapshots: SnapNcgData[]; dataRef: string; janelaDias?: number }): {
  ncg: number | null; snapshot_at: string | null; dias_delta: number | null; fora_janela: boolean;
} {
  const janela = i.janelaDias ?? 7;
  const refMs = Date.parse(i.dataRef + 'T00:00:00Z');
  let melhor: { ncg: number; snapshot_at: string; delta: number; abs: number } | null = null;
  for (const s of i.snapshots) {
    if (s.ncg == null || !Number.isFinite(s.ncg)) continue;
    const sMs = Date.parse(s.snapshot_at);
    if (!Number.isFinite(sMs)) continue;
    const delta = Math.round((sMs - refMs) / 86400000);
    const abs = Math.abs(delta);
    if (melhor == null || abs < melhor.abs) melhor = { ncg: s.ncg, snapshot_at: s.snapshot_at, delta, abs };
  }
  if (melhor == null) return { ncg: null, snapshot_at: null, dias_delta: null, fora_janela: true };
  const fora = melhor.abs > janela;
  return { ncg: fora ? null : melhor.ncg, snapshot_at: melhor.snapshot_at, dias_delta: melhor.delta, fora_janela: fora };
}

export type BalancoInput = { anc: number | null; pnc: number | null; pl: number | null; data_ref: string };
export type ClassificacaoFleurietEmpresa = ClassificacaoFleuriet & {
  data_balanco: string | null;
  data_ncg: string | null;
  idade_balanco_dias: number | null;
  confianca: 'alta' | 'media' | null;
};

// Monta a classificação por empresa: CDG do balanço + NCG casado por data + banda por receita.
// Balanço antigo (> limiar) rebaixa confiança. Puro: hojeMs injetado.
export function classificarFleurietEmpresa(i: {
  balanco: BalancoInput | null;
  snapshots: SnapNcgData[];
  receita_liquida_mensal: number | null;
  hojeMs: number;
  janelaDias?: number;
  limiarBalancoStaleDias?: number;
}): ClassificacaoFleurietEmpresa {
  const limiarStale = i.limiarBalancoStaleDias ?? 180;
  if (i.balanco == null) {
    const base = classificarFleuriet({ cdg: null, ncg: null, materialidade: 0 });
    return { ...base, motivos: ['Balanço não informado — classificação estrutural indisponível.'],
      data_balanco: null, data_ncg: null, idade_balanco_dias: null, confianca: null };
  }
  const cdg = calcularCDG(i.balanco);
  const snap = escolherSnapshotNaData({ snapshots: i.snapshots, dataRef: i.balanco.data_ref, janelaDias: i.janelaDias });
  const m = materialidade({ receita_liquida_mensal: i.receita_liquida_mensal });
  const base = classificarFleuriet({ cdg, ncg: snap.ncg, materialidade: m });

  const idade = Math.round((i.hojeMs - Date.parse(i.balanco.data_ref + 'T00:00:00Z')) / 86400000);
  const confianca: 'alta' | 'media' = idade > limiarStale ? 'media' : 'alta';
  const motivos = [...base.motivos];
  if (snap.fora_janela) motivos.push(`Sem NCG a ±${i.janelaDias ?? 7}d da data do balanço${snap.dias_delta != null ? ` (mais próximo: ${snap.dias_delta}d)` : ''}.`);
  if (confianca === 'media') motivos.push(`Balanço com ${idade} dias — confiança rebaixada.`);

  return { ...base, motivos, data_balanco: i.balanco.data_ref, data_ncg: snap.snapshot_at, idade_balanco_dias: idade, confianca };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/financeiro/__tests__/fleuriet-helpers.test.ts`
Expected: PASS. Confirme também `heavy bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fleuriet-helpers.ts src/lib/financeiro/__tests__/fleuriet-helpers.test.ts
git commit -m "feat(financeiro): casamento temporal NCG×balanco + classificarFleurietEmpresa"
```

---

## Task 6: Migration `fin_balanco_inputs` (money-path — prove-sql + Lovable)

**Files:**
- Create (via skills): arquivo de migration gerado pela skill `lovable-db-operator`.

SQL exato a provar e aplicar:

```sql
CREATE TABLE public.fin_balanco_inputs (
  company text NOT NULL,
  data_ref date NOT NULL,
  ativo_nao_circulante numeric(15,2) NOT NULL,
  passivo_nao_circulante numeric(15,2) NOT NULL,
  patrimonio_liquido numeric(15,2) NOT NULL,
  observacao text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT fin_balanco_inputs_pkey PRIMARY KEY (company, data_ref),
  CONSTRAINT fin_balanco_inputs_company_check
    CHECK (company = ANY (ARRAY['oben'::text, 'colacor'::text, 'colacor_sc'::text]))
);

ALTER TABLE public.fin_balanco_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs
  FOR SELECT USING ((EXISTS ( SELECT 1 FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))));

CREATE POLICY fin_balanco_inputs_write_master ON public.fin_balanco_inputs
  USING ((EXISTS ( SELECT 1 FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))));
```

- [ ] **Step 1: Provar em PG17 local**

Invoque a skill `prove-sql-money-path`. Aplique a migration REAL num PG17 descartável, semeie 1 linha por empresa e prove a RLS:
- sob `SET ROLE authenticated` + GUC de um usuário **master** → SELECT/INSERT/UPDATE funcionam;
- sob `SET ROLE authenticated` + GUC de um usuário **não-master** → SELECT retorna 0 linhas e INSERT é negado (capturar a SQLSTATE `42501`, re-raise do resto).
- **Falsificar:** remova a policy `_select_master` e exija que o teste de "não-master não vê" fique VERMELHO. Restaure e exija verde.

Expected: verde com as policies, vermelho ao sabotar.

- [ ] **Step 2: Gerar o handoff**

Invoque a skill `lovable-db-operator` com o SQL acima. Ela gera: o arquivo de migration versionado, o bloco pronto pro SQL Editor do Lovable, a query de validação pós-apply (`SELECT to_regclass('public.fin_balanco_inputs')` + checagem das policies em `pg_policies`) e a nota pro PR. Regenera o audit.

- [ ] **Step 3: Commit do arquivo de migration**

```bash
git add supabase/migrations/  # caminho exato definido pela skill lovable-db-operator
git commit -m "feat(db): fin_balanco_inputs (RLS master-only, versionada por data_ref)"
```

> **Deploy manual (founder):** a migration NÃO auto-aplica. O bloco vai no SQL Editor do Lovable. Registrar como pendência de handoff (ver Task 9 / fecho).

---

## Task 7: Serviço — `getBalancoInputs` + `getNcgHistorico`

**Files:**
- Modify: `src/services/financeiroV2Service.ts`

- [ ] **Step 1: Implementar as queries** (append ao service, perto de `getProjecaoSnapshotsCockpit`)

```ts
export type BalancoInputRow = { company: string; data_ref: string; anc: number | null; pnc: number | null; pl: number | null };

/** Balanço mais recente por empresa (maior data_ref) de fin_balanco_inputs (RLS master-only). */
export async function getBalancoInputs(companies: Company[]): Promise<Record<string, BalancoInputRow>> {
  const out: Record<string, BalancoInputRow> = {};
  await Promise.all(companies.map(async (company) => {
    const { data, error } = await supabase
      .from('fin_balanco_inputs')
      .select('company, data_ref, ativo_nao_circulante, passivo_nao_circulante, patrimonio_liquido')
      .eq('company', company)
      .order('data_ref', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) out[company] = {
      company: data.company as string,
      data_ref: data.data_ref as string,
      anc: (data.ativo_nao_circulante as number | null) ?? null,
      pnc: (data.passivo_nao_circulante as number | null) ?? null,
      pl: (data.patrimonio_liquido as number | null) ?? null,
    };
  }));
  return out;
}

/** Histórico de NCG (cenário realista) por empresa numa janela de dias ao redor de hoje,
 *  para casar com a data do balanço. Ordena desc por snapshot_at; cap de 400 linhas. */
export async function getNcgHistorico(company: Company, desdeISO: string): Promise<{ ncg: number | null; snapshot_at: string }[]> {
  const { data, error } = await supabase
    .from('fin_projecao_snapshots')
    .select('ncg, snapshot_at')
    .eq('company', company)
    .eq('cenario', 'realista')
    .gte('snapshot_at', desdeISO)
    .order('snapshot_at', { ascending: false })
    .limit(400);
  if (error) throw error;
  return (data ?? []).map(r => ({ ncg: (r.ncg as number | null) ?? null, snapshot_at: r.snapshot_at as string }));
}
```

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/financeiroV2Service.ts
git commit -m "feat(financeiro): getBalancoInputs + getNcgHistorico (fonte do selo Fleuriet)"
```

---

## Task 8: Selo no Cockpit — hook + `FleurietBadge`

**Files:**
- Create: `src/components/financeiro/cockpit/FleurietBadge.tsx`
- Modify: `src/components/financeiro/cockpit/useFinanceiroCockpit.ts`
- Modify: `src/pages/FinanceiroCockpit.tsx`

- [ ] **Step 1: Carregar dados no hook** (`useFinanceiroCockpit.ts`)

No `loadAll`, adicione ao `Promise.all` (com catch por fonte, como os demais):

```ts
import { getBalancoInputs, getNcgHistorico, type BalancoInputRow } from '@/services/financeiroV2Service';
import { classificarFleurietEmpresa, type ClassificacaoFleurietEmpresa } from '@/lib/financeiro/fleuriet-helpers';

// dentro do componente:
const [fleuriet, setFleuriet] = useState<Record<string, ClassificacaoFleurietEmpresa>>({});

// no loadAll, após ter `dre` e `snaps`:
const balancos = await getBalancoInputs(EMPRESAS_COCKPIT).catch((e) => {
  logger.warn('Balanço (Fleuriet) indisponível', { error: e instanceof Error ? e.message : String(e) });
  return {} as Record<string, BalancoInputRow>;
});
// Histórico de NCG dos últimos ~400 dias por empresa, para casar com a data do balanço.
const desde = new Date(Date.now() - 400 * 86400000).toISOString();
const fleurietMap: Record<string, ClassificacaoFleurietEmpresa> = {};
for (const co of EMPRESAS_COCKPIT) {
  const bal = balancos[co];
  const hist = await getNcgHistorico(co, desde).catch(() => [] as { ncg: number | null; snapshot_at: string }[]);
  const receitaMensal = (dreUltimoPorEmpresa(dr, co)?.receita_liquida ?? null);
  fleurietMap[co] = classificarFleurietEmpresa({
    balanco: bal ? { anc: bal.anc, pnc: bal.pnc, pl: bal.pl, data_ref: bal.data_ref } : null,
    snapshots: hist, receita_liquida_mensal: receitaMensal, hojeMs: Date.now(),
  });
}
if (loadId === loadIdRef.current) setFleuriet(fleurietMap);
```

Adicione o helper local `dreUltimoPorEmpresa(dre, company)` (retorna a última linha de DRE da empresa) e inclua `fleuriet` no return do hook.

> Nota de money-path: `Date.now()` só entra aqui (fronteira de I/O). O helper puro recebe `hojeMs` — mantém testabilidade.

- [ ] **Step 2: Componente `FleurietBadge.tsx`**

```tsx
import { ShieldCheck, ShieldAlert, Shield, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ClassificacaoFleurietEmpresa } from '@/lib/financeiro/fleuriet-helpers';

const STATUS_META: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'muted'; Icon: typeof Shield }> = {
  coberta:                { label: 'Giro coberto',        tone: 'success', Icon: ShieldCheck },
  operacao_financia_giro: { label: 'Operação financia o giro', tone: 'success', Icon: ShieldCheck },
  descoberta:             { label: 'Giro descoberto',     tone: 'warning', Icon: ShieldAlert },
  fronteira:              { label: 'Na fronteira',        tone: 'muted',   Icon: Shield },
  inconsistente:          { label: 'Inconsistente',       tone: 'error',   Icon: ShieldAlert },
  indisponivel:           { label: 'Estrutura indisponível', tone: 'muted', Icon: HelpCircle },
};
const fmt = (n: number | null) => n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

export function FleurietBadge({ c, empresaLabel }: { c: ClassificacaoFleurietEmpresa; empresaLabel: string }) {
  const meta = STATUS_META[c.status] ?? STATUS_META.indisponivel;
  const color = meta.tone === 'success' ? 'text-status-success' : meta.tone === 'warning' ? 'text-status-warning' : meta.tone === 'error' ? 'text-status-error' : 'text-muted-foreground';
  const bg = meta.tone === 'success' ? 'bg-status-success-bg border-status-success/20' : meta.tone === 'warning' ? 'bg-status-warning-bg border-status-warning/20' : meta.tone === 'error' ? 'bg-status-error-bg border-status-error/20' : 'bg-muted/40 border-border';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${bg}`}>
          <meta.Icon className={`w-3 h-3 ${color}`} />
          <span className={`font-semibold ${color}`}>{empresaLabel}: {meta.label}</span>
          {c.tipo && <span className="text-muted-foreground">· Tipo {c.tipo} {c.rotulo}</span>}
          {c.cobertura != null && <span className="tabular-nums text-muted-foreground">· {c.cobertura.toFixed(2)}×</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs space-y-1">
        <div className="font-semibold">Cobertura estrutural do giro (Fleuriet)</div>
        <div>CDG {fmt(c.cdg)} · NCG {fmt(c.ncg)} · Gap {fmt(c.gap)}</div>
        {c.data_balanco && <div className="text-muted-foreground">Balanço {c.data_balanco} · NCG {c.data_ncg?.slice(0,10) ?? '—'} · {c.confianca ?? '—'} confiança</div>}
        {c.motivos.length > 0 && <div className="text-muted-foreground">{c.motivos.join(' ')}</div>}
        <div className="text-muted-foreground italic">Direcional (NCG gerencial). Não substitui balanço auditado.</div>
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 3: Renderizar no Cockpit** (`FinanceiroCockpit.tsx`)

Perto do `TransparencyBadge`, renderize um `FleurietBadge` por empresa presente:

```tsx
{['oben','colacor','colacor_sc'].map((co) => fleuriet[co] && (
  <FleurietBadge key={co} c={fleuriet[co]} empresaLabel={rotuloEmpresa(co)} />
))}
```

(`rotuloEmpresa` = mapeador de nome curto já usado no Cockpit; se não existir, use um map local `{ oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' }`.)

- [ ] **Step 4: Verificar**

Run: `heavy bun run typecheck && heavy bun run lint`
Expected: PASS. Sanity visual: `bun dev`, abrir `/financeiro/cockpit`, sem balanço → selos "Estrutura indisponível".

- [ ] **Step 5: Commit**

```bash
git add src/components/financeiro/cockpit/FleurietBadge.tsx src/components/financeiro/cockpit/useFinanceiroCockpit.ts src/pages/FinanceiroCockpit.tsx
git commit -m "feat(financeiro): selo de cobertura estrutural (Fleuriet) no Cockpit"
```

---

## Task 9: Input master-only do balanço — `BalancoInputDialog`

**Files:**
- Create: `src/components/financeiro/cockpit/BalancoInputDialog.tsx`
- Modify: `src/pages/FinanceiroCockpit.tsx` (botão de abrir, gated master)

- [ ] **Step 1: Componente de input** (react-hook-form + zod, upsert em `fin_balanco_inputs`)

```tsx
// Form master-only: company, data_ref, ANC, PNC, PL, observacao. Upsert por (company, data_ref).
// Microcopy de classificação (armadilhas do Codex) ao lado dos campos.
```

Campos e microcopy (exibir como `<FormDescription>`):
- **Ativo Não Circulante (ANC):** "Realizável a LP + investimentos + imobilizado + intangível. Só o operacional; exclua imóvel/veículo não operacional e reavaliação."
- **Passivo Não Circulante (PNC):** "Exigível de longo prazo (>12m). Parcelamento fiscal: só a parcela de LP; a de curto prazo NÃO entra aqui."
- **Patrimônio Líquido (PL):** "Capital + reservas + lucros. Empréstimo de sócio só conta como PL se formalmente capitalizado/subordinado; senão é passivo. AFAC só se documentado."
- **Data de referência:** "Data do balancete. A classificação casa com o NCG do sistema a ±7 dias dessa data."

Persistência:

```ts
const { error } = await supabase.from('fin_balanco_inputs').upsert({
  company, data_ref: dataRef,
  ativo_nao_circulante: anc, passivo_nao_circulante: pnc, patrimonio_liquido: pl,
  observacao: observacao || null, updated_at: new Date().toISOString(),
  updated_by: (await supabase.auth.getUser()).data.user?.id ?? null,
}, { onConflict: 'company,data_ref' });
if (error) { toast.error('Falha ao salvar balanço'); return; }
toast.success('Balanço salvo'); onSaved?.();
```

`toast` de `sonner`. Após salvar, refetch do Cockpit (`loadAll`).

- [ ] **Step 2: Gate master + abertura**

No Cockpit, botão "Informar balanço (Fleuriet)" visível só para master (via `useAuth()` — `isMaster`). Abre o dialog.

- [ ] **Step 3: Verificar**

Run: `heavy bun run typecheck && heavy bun run lint`
Expected: PASS. Com a migration aplicada em dev: master informa um balanço, o selo sai de "indisponível" e mostra o Tipo. Não-master não vê o botão e (RLS) não lê a tabela.

- [ ] **Step 4: Commit**

```bash
git add src/components/financeiro/cockpit/BalancoInputDialog.tsx src/pages/FinanceiroCockpit.tsx
git commit -m "feat(financeiro): input master-only de balanco para o selo Fleuriet"
```

---

## Fecho — deploy e verificação

- [ ] Rodar a suíte completa: `heavy bun run test && heavy bun run typecheck && heavy bun run lint`.
- [ ] **Handoff de deploy (skill `lovable-deploy-verify`):** (1) migration `fin_balanco_inputs` no SQL Editor do Lovable; (2) Publish do frontend. Sem edge nova. Registrar a pendência da migration para o founder (não auto-aplica).
- [ ] Após aplicar a migration em produção: master informa o primeiro balanço de cada empresa e confere o selo.

## Self-review (coberto)

- **Spec §Decisões:** as-of balancete (Task 5 `escolherSnapshotNaData` + `classificarFleurietEmpresa`); selo cobertura primário + tipo secundário (Task 8); banda de materialidade (Task 2/4); honestidade do rótulo/caveat (Task 8 tooltip); por empresa (Task 7/8). ✅
- **Spec §Modelo/Matriz:** Task 3 (6 tipos + 2 impossíveis) + Task 4 (integração). ✅
- **Spec §Status de cobertura:** Task 4. ✅
- **Spec §Dados/RLS:** Task 6 (prove-sql + Lovable). ✅
- **Spec §Degradação:** Task 4 (indisponivel/fronteira/inconsistente) + Task 5 (fora_janela/confiança). ✅
- **Spec §Testes:** Tasks 1-5. ✅
- **Fora de escopo v1** (proxy diário, T independente, intercompany): não há task — correto. ✅
- **Consistência de tipos:** `ClassificacaoFleuriet` (Task 4) estendida por `ClassificacaoFleurietEmpresa` (Task 5), consumida em Task 8. `SnapNcgData`/`BalancoInput` consistentes entre Task 5 e 7. ✅
