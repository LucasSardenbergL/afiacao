# GestorBuddy — Console de Exceções (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um card "Exceções — o que está fora do lugar" no MasterDashboard que mostra só o que está OFF (saúde de dados degradada, clientes em risco do time freshness-first, confirmações pendentes), agrupado por dependência, com recibos (fonte+frescor) e degradação honesta — determinístico, zero LLM/push/backend novo.

**Architecture:** Motor PURO (`src/lib/gestor/excecoes/`) que recebe 3 fontes normalizadas + "agora" (SP) e produz um `ConsoleExcecoes` (escada de frescor + predicados + caps + grupos + merge visual). O hook `useExcecoesGestor` busca/normaliza (ai_decisions freshness-first, useDataHealth, v_tarefas_estado team-wide) e chama o motor; a UI estende o MasterDashboard. Reusa o predicado de risco do `useAiOps`, `spBusinessDate`, `useRunAgent` e `resolverSugestao`.

**Tech Stack:** React 18 + TS (strict) + Vite, @tanstack/react-query, Supabase client, vitest, shadcn/ui, `@/lib/analytics` (PostHog).

**Spec:** `docs/superpowers/specs/2026-06-04-gestorbuddy-excecoes-design.md`

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/gestor/excecoes/types.ts` (criar) | Tipos: `LinhaExcecao`, `GrupoExcecao`, `ConsoleExcecoes`, entradas normalizadas (`DecisaoRiscoInput`/`SaudeCheckInput`/`TarefaGapInput`/`ExcecoesInput`), `ExcecoesCfg`, `EXCECOES_CFG_DEFAULT`, `FrescorCarteira`. |
| `src/lib/gestor/excecoes/montar.ts` (criar) | Motor PURO: helpers de frescor + 3 detectores (`detectarDadosQuebrados`, `detectarClientesRisco`, `detectarConfirmacoesPendentes`) + composer `montarExcecoes` (merge visual + teto total). |
| `src/lib/gestor/excecoes/__tests__/montar.test.ts` (criar) | Testes dos detectores + composer. |
| `src/hooks/useExcecoesGestor.ts` (criar) | Hook: 3 queries (ai_decisions freshness-first; useDataHealth; v_tarefas_estado team-wide + candidatos) + resolve nomes (profiles) + chama o motor. |
| `src/components/dashboard/GestorExcecoes.tsx` (criar) | Card UI: grupos, recibos, ações, botão "Atualizar análise da carteira", empty-state, telemetria. |
| `src/components/dashboard/MasterDashboard.tsx` (modificar) | Substitui o placeholder "Em construção — Alertas estratégicos" por `<GestorExcecoes />`. |

---

## Task 1: Tipos do motor

**Files:**
- Create: `src/lib/gestor/excecoes/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
// src/lib/gestor/excecoes/types.ts
// GestorBuddy — console de exceções (v1 determinístico). Tipos puros.

export type FrescorCarteira = 'fresh' | 'stale' | 'desatualizada';
export type GrupoKey = 'dados_quebrados' | 'clientes_risco' | 'confirmacoes_pendentes';
export type Severidade = 'critico' | 'aviso' | 'info';

export type AcaoExcecao =
  | { tipo: 'abrir_cliente'; clienteUserId: string }
  | { tipo: 'tarefa'; tarefaId: string; clienteUserId: string | null; candidatoId: string | null }
  | { tipo: 'rodar_agente' }
  | { tipo: 'nenhum' };

export interface LinhaExcecao {
  id: string;            // chave estável de render
  grupo: GrupoKey;
  titulo: string;
  detalhe: string | null;
  donoNome: string | null;       // vendedor dono (quando aplicável)
  severidade: Severidade;
  reciboFonte: string;           // 'ai_decisions' | 'data_health' | 'v_tarefas_estado'
  reciboFrescor: string | null;  // "calculada há 30h" | "há 2d" | null (fresco)
  acao: AcaoExcecao;
  badges: string[];              // ex.: ["também há tarefa pendente"]
}

export interface GrupoExcecao {
  key: GrupoKey;
  titulo: string;
  linhas: LinhaExcecao[];
}

export interface ConsoleExcecoes {
  grupos: GrupoExcecao[];   // só grupos não-vazios, em ordem de dependência
  totalLinhas: number;
  excedente: number;        // "+N exceções" cortadas pelo teto total
  vazio: boolean;           // true → empty-state honesto
}

// ── entradas normalizadas (vêm do hook, já com nomes resolvidos) ──────
export interface DecisaoRiscoInput {
  id: string;
  clienteUserId: string;
  clienteNome: string | null;
  donoNome: string | null;
  primaryReason: string;
  confidence: string;            // 'alta' | 'media' | 'baixa' (string crua da tabela)
  atrasoRelativo: number | null;
  faturamento90d: number | null;
  faturamentoPrev90d: number | null;
}
export interface SaudeCheckInput {
  source: string;
  domain: string;
  status: 'ok' | 'stale' | 'broken' | 'unknown';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  ageSeconds: number | null;
}
export interface TarefaGapInput {
  tarefaId: string;
  descricao: string;
  clienteUserId: string | null;
  donoNome: string | null;
  effectiveDue: string;          // 'yyyy-mm-dd'
  candidatoId: string | null;    // p/ ação Confirmar/Rejeitar (null se não houver)
}
export interface ExcecoesInput {
  decisoes: DecisaoRiscoInput[];
  decisoesMaxCreatedAtIso: string | null; // max(created_at) das pending → frescor
  saude: SaudeCheckInput[];
  tarefas: TarefaGapInput[];
  hojeSp: string;                // spBusinessDate(now) — 'yyyy-mm-dd'
  agoraIso: string;              // now ISO (idade do ai_decisions)
}

export interface ExcecoesCfg {
  capClientes: number;        // 5
  capTarefas: number;         // 3
  capWarnSaude: number;       // 3 (critical é ilimitado)
  totalMax: number;           // 10
  staleHoras: number;         // 24  (fresh < 24h)
  desatualizadaHoras: number; // 48  (stale 24-48h; > 48h = desatualizada)
}
export const EXCECOES_CFG_DEFAULT: ExcecoesCfg = {
  capClientes: 5, capTarefas: 3, capWarnSaude: 3, totalMax: 10, staleHoras: 24, desatualizadaHoras: 48,
};
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/gestor/excecoes/types.ts
git commit -m "feat(gestor): tipos do console de exceções"
```

---

## Task 2: Helpers de frescor

**Files:**
- Create: `src/lib/gestor/excecoes/montar.ts`
- Test: `src/lib/gestor/excecoes/__tests__/montar.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/gestor/excecoes/__tests__/montar.test.ts
import { describe, it, expect } from 'vitest';
import { idadeHoras, frescorCarteira, frescorTexto } from '../montar';
import { EXCECOES_CFG_DEFAULT } from '../types';

const cfg = EXCECOES_CFG_DEFAULT;
const AGORA = '2026-06-04T12:00:00.000Z';

describe('idadeHoras', () => {
  it('calcula horas inteiras entre dois ISO', () => {
    expect(idadeHoras('2026-06-04T06:00:00.000Z', AGORA)).toBe(6);
    expect(idadeHoras(null, AGORA)).toBeNull();
    expect(idadeHoras('lixo', AGORA)).toBeNull();
  });
});

describe('frescorCarteira', () => {
  it('classifica por idade do max(created_at)', () => {
    expect(frescorCarteira('2026-06-04T00:00:00.000Z', AGORA, cfg)).toBe('fresh'); // 12h
    expect(frescorCarteira('2026-06-03T06:00:00.000Z', AGORA, cfg)).toBe('stale'); // 30h
    expect(frescorCarteira('2026-06-01T12:00:00.000Z', AGORA, cfg)).toBe('desatualizada'); // 72h
    expect(frescorCarteira(null, AGORA, cfg)).toBe('desatualizada'); // sem dado = desatualizada
  });
});

describe('frescorTexto', () => {
  it('horas até 48h, dias acima', () => {
    expect(frescorTexto(6)).toBe('há 6h');
    expect(frescorTexto(30)).toBe('há 30h');
    expect(frescorTexto(72)).toBe('há 3d');
    expect(frescorTexto(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: FAIL — `montar.ts` não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/gestor/excecoes/montar.ts
import type {
  ExcecoesInput, ExcecoesCfg, ConsoleExcecoes, LinhaExcecao, GrupoExcecao,
  DecisaoRiscoInput, SaudeCheckInput, TarefaGapInput, FrescorCarteira,
} from './types';
import { EXCECOES_CFG_DEFAULT } from './types';

const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;

/** Horas inteiras entre dois ISO (agora − ref). null/inválido → null. */
export function idadeHoras(refIso: string | null, agoraIso: string): number | null {
  if (!refIso) return null;
  const t = Date.parse(refIso), a = Date.parse(agoraIso);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return null;
  return Math.floor((a - t) / 3_600_000);
}

/** Escada de frescor da carteira (ai_decisions). Sem dado → desatualizada. */
export function frescorCarteira(maxCreatedAtIso: string | null, agoraIso: string, cfg: ExcecoesCfg): FrescorCarteira {
  const h = idadeHoras(maxCreatedAtIso, agoraIso);
  if (h == null) return 'desatualizada';
  if (h < cfg.staleHoras) return 'fresh';
  if (h < cfg.desatualizadaHoras) return 'stale';
  return 'desatualizada';
}

/** "há Xh" até 48h; "há Nd" acima. null → null. */
export function frescorTexto(horas: number | null): string | null {
  if (horas == null) return null;
  if (horas < 48) return `há ${horas}h`;
  return `há ${Math.floor(horas / 24)}d`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gestor/excecoes/montar.ts src/lib/gestor/excecoes/__tests__/montar.test.ts
git commit -m "feat(gestor): helpers de frescor da carteira"
```

---

## Task 3: Detector `detectarDadosQuebrados`

**Files:**
- Modify: `src/lib/gestor/excecoes/montar.ts`
- Test: `src/lib/gestor/excecoes/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { detectarDadosQuebrados } from '../montar';
import type { SaudeCheckInput } from '../types';

const saude = (over: Partial<SaudeCheckInput>): SaudeCheckInput => ({
  source: 'vendas_pedidos', domain: 'vendas', status: 'broken', severity: 'critical',
  message: 'Sync de vendas parado', ageSeconds: 3600, ...over,
});

describe('detectarDadosQuebrados', () => {
  it('inclui todos os critical e capWarnSaude warnings; ignora ok', () => {
    const linhas = detectarDadosQuebrados([
      saude({ source: 'a', severity: 'critical', status: 'broken' }),
      saude({ source: 'b', severity: 'critical', status: 'broken' }),
      saude({ source: 'w1', severity: 'warning', status: 'stale' }),
      saude({ source: 'w2', severity: 'warning', status: 'stale' }),
      saude({ source: 'w3', severity: 'warning', status: 'stale' }),
      saude({ source: 'w4', severity: 'warning', status: 'stale' }),
      saude({ source: 'ok1', severity: 'info', status: 'ok' }),
    ], EXCECOES_CFG_DEFAULT);
    const crit = linhas.filter(l => l.severidade === 'critico');
    const warn = linhas.filter(l => l.severidade === 'aviso');
    expect(crit).toHaveLength(2);     // todos os critical
    expect(warn).toHaveLength(3);     // cap de 3 warnings
    expect(linhas.every(l => l.grupo === 'dados_quebrados')).toBe(true);
    expect(linhas[0].reciboFonte).toBe('data_health');
  });

  it('lista vazia quando tudo ok', () => {
    expect(detectarDadosQuebrados([saude({ status: 'ok', severity: 'info' })], EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: FAIL — `detectarDadosQuebrados` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── grupo 1: dados quebrados (Sentinela) ─────────────────────────────
export function detectarDadosQuebrados(saude: SaudeCheckInput[], cfg: ExcecoesCfg): LinhaExcecao[] {
  const naoOk = saude.filter(s => s.status !== 'ok');
  const criticos = naoOk.filter(s => s.severity === 'critical');
  const avisos = naoOk.filter(s => s.severity === 'warning').slice(0, cfg.capWarnSaude);
  const escolhidos = [...criticos, ...avisos];
  return escolhidos.map((s): LinhaExcecao => ({
    id: `saude:${s.source}`,
    grupo: 'dados_quebrados',
    titulo: s.message,
    detalhe: s.domain,
    donoNome: null,
    severidade: s.severity === 'critical' ? 'critico' : 'aviso',
    reciboFonte: 'data_health',
    reciboFrescor: frescorTexto(s.ageSeconds != null ? Math.floor(s.ageSeconds / 3600) : null),
    acao: { tipo: 'nenhum' },
    badges: [],
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gestor/excecoes/montar.ts src/lib/gestor/excecoes/__tests__/montar.test.ts
git commit -m "feat(gestor): detector dados_quebrados (Sentinela)"
```

---

## Task 4: Detector `detectarClientesRisco` (com escada de frescor)

**Files:**
- Modify: `src/lib/gestor/excecoes/montar.ts`
- Test: `src/lib/gestor/excecoes/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { detectarClientesRisco } from '../montar';
import type { DecisaoRiscoInput } from '../types';

const dec = (over: Partial<DecisaoRiscoInput>): DecisaoRiscoInput => ({
  id: 'd1', clienteUserId: 'c1', clienteNome: 'Cliente 1', donoNome: 'Regina',
  primaryReason: 'Esfriou', confidence: 'alta', atrasoRelativo: 2.5,
  faturamento90d: 1000, faturamentoPrev90d: 1000, ...over,
});

describe('detectarClientesRisco', () => {
  it('FRESH: filtra pelo predicado de risco + confidence!=baixa, cap 5', () => {
    const decs = [
      dec({ id: 'd1', clienteUserId: 'c1', atrasoRelativo: 2.5 }),        // dispara (atraso)
      dec({ id: 'd2', clienteUserId: 'c2', atrasoRelativo: 1.0, faturamento90d: 100, faturamentoPrev90d: 1000 }), // dispara (queda >50%)
      dec({ id: 'd3', clienteUserId: 'c3', atrasoRelativo: 1.0, faturamento90d: 900, faturamentoPrev90d: 1000 }), // NÃO (sem risco)
      dec({ id: 'd4', clienteUserId: 'c4', atrasoRelativo: 5, confidence: 'baixa' }),  // NÃO (confidence baixa)
    ];
    const r = detectarClientesRisco(decs, '2026-06-04T11:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r.map(l => l.id).sort()).toEqual(['risco:c1', 'risco:c2']);
    expect(r[0].donoNome).toBe('Regina');
    expect(r[0].grupo).toBe('clientes_risco');
  });

  it('STALE (24-48h): mesmas linhas, com selo de frescor', () => {
    const r = detectarClientesRisco([dec({})], '2026-06-03T06:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r).toHaveLength(1);
    expect(r[0].reciboFrescor).toBe('há 30h');
  });

  it('DESATUALIZADA (>48h): UMA meta-exceção, sem linhas de cliente', () => {
    const r = detectarClientesRisco([dec({})], '2026-06-01T00:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('risco:meta_desatualizada');
    expect(r[0].acao).toEqual({ tipo: 'rodar_agente' });
    expect(r[0].titulo.toLowerCase()).toContain('desatualizada');
  });

  it('sem decisões → vazio (não fabrica)', () => {
    expect(detectarClientesRisco([], '2026-06-04T11:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: FAIL — `detectarClientesRisco` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── grupo 2: clientes em risco (ai_decisions, freshness-first) ────────
// Predicado de risco reusa o useAiOps (atraso>=2 OU queda de faturamento >50%),
// apertado com confidence != 'baixa'.
function ehRisco(d: DecisaoRiscoInput): boolean {
  if (d.confidence === 'baixa') return false;
  const atraso = num(d.atrasoRelativo) ?? 0;
  const fat = num(d.faturamento90d) ?? 0;
  const prev = num(d.faturamentoPrev90d) ?? 0;
  return atraso >= 2.0 || (prev > 0 && fat < prev * 0.5);
}

export function detectarClientesRisco(
  decisoes: DecisaoRiscoInput[], maxCreatedAtIso: string | null, agoraIso: string, cfg: ExcecoesCfg,
): LinhaExcecao[] {
  if (decisoes.length === 0) return [];
  const frescor = frescorCarteira(maxCreatedAtIso, agoraIso, cfg);

  if (frescor === 'desatualizada') {
    return [{
      id: 'risco:meta_desatualizada',
      grupo: 'clientes_risco',
      titulo: 'Análise de carteira desatualizada',
      detalhe: 'Rode a análise para ver os clientes em risco do time.',
      donoNome: null,
      severidade: 'aviso',
      reciboFonte: 'ai_decisions',
      reciboFrescor: frescorTexto(idadeHoras(maxCreatedAtIso, agoraIso)),
      acao: { tipo: 'rodar_agente' },
      badges: [],
    }];
  }

  const selo = frescor === 'stale' ? frescorTexto(idadeHoras(maxCreatedAtIso, agoraIso)) : null;
  return decisoes.filter(ehRisco).slice(0, cfg.capClientes).map((d): LinhaExcecao => ({
    id: `risco:${d.clienteUserId}`,
    grupo: 'clientes_risco',
    titulo: d.clienteNome ?? 'Cliente sem nome',
    detalhe: d.primaryReason,
    donoNome: d.donoNome,
    severidade: 'critico',
    reciboFonte: 'ai_decisions',
    reciboFrescor: selo,
    acao: { tipo: 'abrir_cliente', clienteUserId: d.clienteUserId },
    badges: [],
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gestor/excecoes/montar.ts src/lib/gestor/excecoes/__tests__/montar.test.ts
git commit -m "feat(gestor): detector clientes_risco com escada de frescor"
```

---

## Task 5: Detector `detectarConfirmacoesPendentes`

**Files:**
- Modify: `src/lib/gestor/excecoes/montar.ts`
- Test: `src/lib/gestor/excecoes/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { detectarConfirmacoesPendentes } from '../montar';
import type { TarefaGapInput } from '../types';

const gap = (over: Partial<TarefaGapInput>): TarefaGapInput => ({
  tarefaId: 't1', descricao: 'Ligar p/ oferecer linha nova', clienteUserId: 'c1',
  donoNome: 'Regina', effectiveDue: '2026-06-02', candidatoId: 'cand1', ...over,
});

describe('detectarConfirmacoesPendentes', () => {
  it('só vencidas em dia anterior a hoje (>=1 dia); mais antiga primeiro; cap 3', () => {
    const hoje = '2026-06-04';
    const r = detectarConfirmacoesPendentes([
      gap({ tarefaId: 't1', effectiveDue: '2026-06-01' }),
      gap({ tarefaId: 't2', effectiveDue: '2026-06-03' }),
      gap({ tarefaId: 't3', effectiveDue: '2026-06-04' }), // vence HOJE → excluída (não é >=1 dia)
      gap({ tarefaId: 't4', effectiveDue: '2026-05-30' }),
      gap({ tarefaId: 't5', effectiveDue: '2026-05-31' }),
    ], hoje, EXCECOES_CFG_DEFAULT);
    expect(r.map(l => l.id)).toEqual(['conf:t4', 'conf:t5', 'conf:t1']); // 3 mais antigas, ordenadas
    expect(r[0].grupo).toBe('confirmacoes_pendentes');
    expect(r[0].acao).toEqual({ tipo: 'tarefa', tarefaId: 't4', clienteUserId: 'c1', candidatoId: 'cand1' });
    expect(r[0].titulo.toLowerCase()).not.toContain('engan'); // copy NUNCA acusatória
  });

  it('vazio quando nada vencido há >=1 dia', () => {
    expect(detectarConfirmacoesPendentes([gap({ effectiveDue: '2026-06-04' })], '2026-06-04', EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: FAIL — `detectarConfirmacoesPendentes` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── grupo 3: confirmações pendentes (proof-gap; NUNCA "enganando") ────
export function detectarConfirmacoesPendentes(
  tarefas: TarefaGapInput[], hojeSp: string, cfg: ExcecoesCfg,
): LinhaExcecao[] {
  // vencida em dia ANTERIOR a hoje (>=1 dia de atraso); mais antiga primeiro.
  const vencidas = tarefas
    .filter(t => t.effectiveDue < hojeSp)
    .sort((a, b) => a.effectiveDue.localeCompare(b.effectiveDue))
    .slice(0, cfg.capTarefas);
  return vencidas.map((t): LinhaExcecao => ({
    id: `conf:${t.tarefaId}`,
    grupo: 'confirmacoes_pendentes',
    titulo: `Tarefa atrasada com indício não resolvido: "${t.descricao}"`,
    detalhe: 'Vale confirmar ou rejeitar.',
    donoNome: t.donoNome,
    severidade: 'aviso',
    reciboFonte: 'v_tarefas_estado',
    reciboFrescor: null,
    acao: { tipo: 'tarefa', tarefaId: t.tarefaId, clienteUserId: t.clienteUserId, candidatoId: t.candidatoId },
    badges: [],
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gestor/excecoes/montar.ts src/lib/gestor/excecoes/__tests__/montar.test.ts
git commit -m "feat(gestor): detector confirmacoes_pendentes (proof-gap, copy não-acusatória)"
```

---

## Task 6: Composer `montarExcecoes` (merge visual + teto total)

**Files:**
- Modify: `src/lib/gestor/excecoes/montar.ts`
- Test: `src/lib/gestor/excecoes/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { montarExcecoes } from '../montar';
import type { ExcecoesInput } from '../types';

const baseInput = (over: Partial<ExcecoesInput>): ExcecoesInput => ({
  decisoes: [], decisoesMaxCreatedAtIso: '2026-06-04T11:00:00.000Z',
  saude: [], tarefas: [], hojeSp: '2026-06-04', agoraIso: '2026-06-04T12:00:00.000Z', ...over,
});

describe('montarExcecoes (composer)', () => {
  it('grupos só não-vazios, em ordem de dependência', () => {
    const c = montarExcecoes(baseInput({
      decisoes: [dec({ clienteUserId: 'c1' })],
      saude: [saude({ source: 'a', severity: 'critical', status: 'broken' })],
      tarefas: [gap({ tarefaId: 't1', clienteUserId: 'c9', effectiveDue: '2026-06-01' })],
    }));
    expect(c.grupos.map(g => g.key)).toEqual(['dados_quebrados', 'clientes_risco', 'confirmacoes_pendentes']);
    expect(c.vazio).toBe(false);
  });

  it('merge visual: cliente em risco E em tarefa → badge, sem duplicar na seção de tarefas', () => {
    const c = montarExcecoes(baseInput({
      decisoes: [dec({ clienteUserId: 'c1', donoNome: 'Regina' })],
      tarefas: [gap({ tarefaId: 't1', clienteUserId: 'c1', effectiveDue: '2026-06-01' })],
    }));
    const risco = c.grupos.find(g => g.key === 'clientes_risco')!.linhas;
    const conf = c.grupos.find(g => g.key === 'confirmacoes_pendentes');
    expect(risco[0].badges).toContain('também há tarefa pendente');
    expect(conf).toBeUndefined(); // a única tarefa era do mesmo cliente → seção some
  });

  it('teto total: críticos de dados sempre entram; excedente vira contagem', () => {
    const c = montarExcecoes(baseInput({
      saude: Array.from({ length: 6 }, (_, i) => saude({ source: `crit${i}`, severity: 'critical', status: 'broken' })),
      decisoes: Array.from({ length: 5 }, (_, i) => dec({ id: `d${i}`, clienteUserId: `c${i}` })),
      tarefas: Array.from({ length: 3 }, (_, i) => gap({ tarefaId: `t${i}`, clienteUserId: `z${i}`, effectiveDue: '2026-06-01' })),
    }), { ...EXCECOES_CFG_DEFAULT, totalMax: 10 });
    const total = c.grupos.reduce((n, g) => n + g.linhas.length, 0);
    expect(total).toBeLessThanOrEqual(10);
    expect(c.grupos.find(g => g.key === 'dados_quebrados')!.linhas).toHaveLength(6); // críticos nunca cortados
    expect(c.excedente).toBeGreaterThan(0);
  });

  it('tudo limpo → vazio=true, sem grupos', () => {
    const c = montarExcecoes(baseInput({}));
    expect(c.vazio).toBe(true);
    expect(c.grupos).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: FAIL — `montarExcecoes` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── composer ─────────────────────────────────────────────────────────
const TITULO_GRUPO: Record<GrupoExcecao['key'], string> = {
  dados_quebrados: 'Dados quebrados',
  clientes_risco: 'Clientes em risco',
  confirmacoes_pendentes: 'Confirmações pendentes',
};

export function montarExcecoes(input: ExcecoesInput, cfg: ExcecoesCfg = EXCECOES_CFG_DEFAULT): ConsoleExcecoes {
  const dados = detectarDadosQuebrados(input.saude, cfg);
  const risco = detectarClientesRisco(input.decisoes, input.decisoesMaxCreatedAtIso, input.agoraIso, cfg);
  let conf = detectarConfirmacoesPendentes(input.tarefas, input.hojeSp, cfg);

  // merge visual: cliente em risco E em tarefa → badge na linha de risco, remove da seção de tarefas.
  const clientesEmRisco = new Set(
    risco.filter(l => l.acao.tipo === 'abrir_cliente').map(l => (l.acao as { clienteUserId: string }).clienteUserId),
  );
  if (clientesEmRisco.size > 0) {
    for (const l of risco) {
      if (l.acao.tipo === 'abrir_cliente') {
        const cid = (l.acao as { clienteUserId: string }).clienteUserId;
        const temTarefa = conf.some(t => t.acao.tipo === 'tarefa' && (t.acao as { clienteUserId: string | null }).clienteUserId === cid);
        if (temTarefa && !l.badges.includes('também há tarefa pendente')) l.badges.push('também há tarefa pendente');
      }
    }
    conf = conf.filter(t => !(t.acao.tipo === 'tarefa' && (t.acao as { clienteUserId: string | null }).clienteUserId != null
      && clientesEmRisco.has((t.acao as { clienteUserId: string }).clienteUserId)));
  }

  // teto total: críticos de dados SEMPRE entram; depois risco; depois confirmações.
  const criticosDados = dados.filter(l => l.severidade === 'critico');
  const avisosDados = dados.filter(l => l.severidade !== 'critico');
  const orcamento = Math.max(cfg.totalMax - criticosDados.length, 0);

  const restoPriorizado: LinhaExcecao[] = [...avisosDados, ...risco, ...conf];
  const restoIncluido = restoPriorizado.slice(0, orcamento);
  const excedente = restoPriorizado.length - restoIncluido.length;

  const incluidas = [...criticosDados, ...restoIncluido];

  // reagrupar preservando a ordem de dependência
  const ordem: GrupoExcecao['key'][] = ['dados_quebrados', 'clientes_risco', 'confirmacoes_pendentes'];
  const grupos: GrupoExcecao[] = ordem
    .map(key => ({ key, titulo: TITULO_GRUPO[key], linhas: incluidas.filter(l => l.grupo === key) }))
    .filter(g => g.linhas.length > 0);

  const totalLinhas = incluidas.length;
  return { grupos, totalLinhas, excedente, vazio: totalLinhas === 0 };
}
```

> Nota: estender o `import type { ... } from './types'` no topo de `montar.ts` (Task 2) para incluir `ConsoleExcecoes`, `LinhaExcecao`, `GrupoExcecao`, `DecisaoRiscoInput`, `SaudeCheckInput`, `TarefaGapInput`, `ExcecoesInput`, `FrescorCarteira` (já listados no plano da Task 2 — confirmar que todos estão na linha de import). Não duplicar a linha.

- [ ] **Step 4: Rodar e ver passar (suite inteira)**

Run: `bunx vitest run src/lib/gestor/excecoes/__tests__/montar.test.ts`
Expected: PASS (helpers + 3 detectores + composer).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gestor/excecoes/montar.ts src/lib/gestor/excecoes/__tests__/montar.test.ts
git commit -m "feat(gestor): composer montarExcecoes (merge visual + teto total + grupos)"
```

---

## Task 7: Hook `useExcecoesGestor`

**Files:**
- Create: `src/hooks/useExcecoesGestor.ts`

> Sem teste unitário próprio (hook de fetch/composição; a lógica pura está em `montarExcecoes`, testada). Master-only por construção (só montado no MasterDashboard).

- [ ] **Step 1: Implementar o hook**

```ts
// src/hooks/useExcecoesGestor.ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useDataHealth } from '@/hooks/useDataHealth';
import { spBusinessDate } from '@/lib/time/sp-day';
import { montarExcecoes } from '@/lib/gestor/excecoes/montar';
import type {
  ConsoleExcecoes, DecisaoRiscoInput, SaudeCheckInput, TarefaGapInput,
} from '@/lib/gestor/excecoes/types';

interface AiDecisionRow {
  id: string; customer_user_id: string; farmer_id: string | null;
  primary_reason: string | null; confidence: string | null;
  customer_metrics: Record<string, number | null> | null; created_at: string;
}
interface TarefaRow {
  id: string; descricao: string; customer_user_id: string | null;
  assigned_to: string | null; responsavel_efetivo: string | null; effective_due: string;
  status: string; atrasada: boolean; tem_sugestao_pendente: boolean;
}
interface CandidatoRow { id: string; tarefa_id: string; status: string; }
interface ProfileRow { user_id: string; name: string | null; razao_social: string | null; }

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Console de exceções do founder (3 fontes determinísticas). */
export function useExcecoesGestor(): { data: ConsoleExcecoes | null; isLoading: boolean; refetchAll: () => void } {
  const saudeQ = useDataHealth();

  const decisoesQ = useQuery({
    queryKey: ['gestor-excecoes', 'ai-decisions'],
    staleTime: 60_000,
    queryFn: async (): Promise<AiDecisionRow[]> => {
      const { data, error } = await supabase
        .from('ai_decisions')
        .select('id, customer_user_id, farmer_id, primary_reason, confidence, customer_metrics, created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AiDecisionRow[];
    },
  });

  const tarefasQ = useQuery({
    queryKey: ['gestor-excecoes', 'tarefas-gap'],
    staleTime: 60_000,
    queryFn: async (): Promise<{ tarefas: TarefaRow[]; candByTarefa: Map<string, string> }> => {
      // v_tarefas_estado: master lê team-wide (RLS reusa pode_ver_carteira_completa).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sel = (supabase.from('v_tarefas_estado' as never) as any)
        .select('id, descricao, customer_user_id, assigned_to, responsavel_efetivo, effective_due, status, atrasada, tem_sugestao_pendente')
        .eq('status', 'aberta').eq('atrasada', true).eq('tem_sugestao_pendente', true);
      const { data, error } = await sel;
      if (error) throw error;
      const tarefas = (data ?? []) as TarefaRow[];
      const ids = tarefas.map(t => t.id);
      const candByTarefa = new Map<string, string>();
      if (ids.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candSel = (supabase.from('tarefa_satisfacao_candidatos' as never) as any)
          .select('id, tarefa_id, status').in('tarefa_id', ids).eq('status', 'pending');
        const { data: cand, error: cErr } = await candSel;
        if (cErr) throw cErr;
        for (const c of (cand ?? []) as CandidatoRow[]) {
          if (!candByTarefa.has(c.tarefa_id)) candByTarefa.set(c.tarefa_id, c.id);
        }
      }
      return { tarefas, candByTarefa };
    },
  });

  const profilesQ = useQuery({
    queryKey: ['gestor-excecoes', 'profiles', (decisoesQ.data ?? []).length, (tarefasQ.data?.tarefas ?? []).length],
    enabled: decisoesQ.isSuccess && tarefasQ.isSuccess,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const ids = new Set<string>();
      for (const d of decisoesQ.data ?? []) { if (d.customer_user_id) ids.add(d.customer_user_id); if (d.farmer_id) ids.add(d.farmer_id); }
      for (const t of tarefasQ.data?.tarefas ?? []) { if (t.responsavel_efetivo) ids.add(t.responsavel_efetivo); }
      const arr = [...ids];
      const nameByUser = new Map<string, string>();
      for (let i = 0; i < arr.length; i += 200) {
        const { data, error } = await supabase.from('profiles').select('user_id, name, razao_social').in('user_id', arr.slice(i, i + 200));
        if (error) throw error;
        for (const p of (data ?? []) as ProfileRow[]) nameByUser.set(p.user_id, p.razao_social ?? p.name ?? '');
      }
      return nameByUser;
    },
  });

  const isLoading = saudeQ.isLoading || decisoesQ.isLoading || tarefasQ.isLoading;

  const data = useMemo<ConsoleExcecoes | null>(() => {
    if (isLoading) return null;
    const nameBy = profilesQ.data ?? new Map<string, string>();
    const nome = (id: string | null): string | null => (id ? (nameBy.get(id) || null) : null);

    const decisoesRows = decisoesQ.data ?? [];
    const decisoes: DecisaoRiscoInput[] = decisoesRows.map(d => ({
      id: d.id,
      clienteUserId: d.customer_user_id,
      clienteNome: nome(d.customer_user_id),
      donoNome: nome(d.farmer_id),
      primaryReason: d.primary_reason ?? '',
      confidence: d.confidence ?? '',
      atrasoRelativo: num(d.customer_metrics?.atraso_relativo),
      faturamento90d: num(d.customer_metrics?.faturamento_90d),
      faturamentoPrev90d: num(d.customer_metrics?.faturamento_prev_90d),
    }));
    const decisoesMaxCreatedAtIso = decisoesRows.length > 0 ? decisoesRows[0].created_at : null;

    const saude: SaudeCheckInput[] = (saudeQ.data ?? []).map(s => ({
      source: s.source, domain: s.domain, status: s.status, severity: s.severity, message: s.message, ageSeconds: s.age_seconds,
    }));

    const candBy = tarefasQ.data?.candByTarefa ?? new Map<string, string>();
    const tarefas: TarefaGapInput[] = (tarefasQ.data?.tarefas ?? []).map(t => ({
      tarefaId: t.id,
      descricao: t.descricao,
      clienteUserId: t.customer_user_id,
      donoNome: nome(t.responsavel_efetivo),
      effectiveDue: t.effective_due,
      candidatoId: candBy.get(t.id) ?? null,
    }));

    return montarExcecoes({
      decisoes, decisoesMaxCreatedAtIso, saude, tarefas,
      hojeSp: spBusinessDate(new Date()),
      agoraIso: new Date().toISOString(),
    });
  }, [isLoading, saudeQ.data, decisoesQ.data, tarefasQ.data, profilesQ.data]);

  const refetchAll = () => { saudeQ.refetch(); decisoesQ.refetch(); tarefasQ.refetch(); };
  return { data, isLoading, refetchAll };
}
```

> ⚠️ `new Date().toISOString()` / `spBusinessDate(new Date())` no `useMemo` recomputam por render mas só impactam o frescor (estável dentro do minuto); aceitável. Se o lint reclamar de deps, manter as deps de dados listadas (o "agora" é intencionalmente recalculado).

- [ ] **Step 2: Type-check + lint**

Run: `bun run typecheck && bun lint`
Expected: PASS (0 errors). Os casts `as any` em `v_tarefas_estado`/`tarefa_satisfacao_candidatos` seguem o padrão do `useTarefas.ts` (tabelas fora dos tipos gerados).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useExcecoesGestor.ts
git commit -m "feat(gestor): hook useExcecoesGestor (3 fontes + nomes + motor)"
```

---

## Task 8: UI `GestorExcecoes` + wire no MasterDashboard + telemetria

**Files:**
- Create: `src/components/dashboard/GestorExcecoes.tsx`
- Modify: `src/components/dashboard/MasterDashboard.tsx`

- [ ] **Step 1: Criar o componente `GestorExcecoes`**

```tsx
// src/components/dashboard/GestorExcecoes.tsx
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { useExcecoesGestor } from '@/hooks/useExcecoesGestor';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { LinhaExcecao, Severidade } from '@/lib/gestor/excecoes/types';

const SEV_CLS: Record<Severidade, string> = {
  critico: 'text-status-error', aviso: 'text-status-warning', info: 'text-status-info',
};

function LinhaItem({ linha, onRodarAgente }: { linha: LinhaExcecao; onRodarAgente: () => void }) {
  const { resolverSugestao } = useTarefaMutations();
  const a = linha.acao;
  return (
    <div className="p-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className={`text-sm font-medium ${SEV_CLS[linha.severidade]}`}>{linha.titulo}</div>
        <div className="text-2xs text-muted-foreground flex flex-wrap gap-2 items-center mt-0.5">
          {linha.detalhe && <span className="truncate">{linha.detalhe}</span>}
          {linha.donoNome && <span className="font-tabular">{linha.donoNome}</span>}
          <span className="opacity-70">{linha.reciboFonte}{linha.reciboFrescor ? ` · ${linha.reciboFrescor}` : ''}</span>
          {linha.badges.map(b => <Badge key={b} variant="outline" className="text-2xs">{b}</Badge>)}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {a.tipo === 'abrir_cliente' && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/admin/customers/${a.clienteUserId}/360`} onClick={() => track('gestor.excecoes_acted', { tipo: 'abrir_cliente' })}>Abrir</Link>
          </Button>
        )}
        {a.tipo === 'tarefa' && (
          <>
            {a.candidatoId && (
              <Button size="sm" variant="outline" onClick={() => { track('gestor.excecoes_acted', { tipo: 'confirmar_tarefa' }); resolverSugestao(a.candidatoId!, a.tarefaId, true); }}>Confirmar</Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link to="/tarefas" onClick={() => track('gestor.excecoes_acted', { tipo: 'abrir_tarefa' })}>Abrir</Link>
            </Button>
          </>
        )}
        {a.tipo === 'rodar_agente' && (
          <Button size="sm" variant="outline" onClick={onRodarAgente}>Atualizar análise da carteira</Button>
        )}
      </div>
    </div>
  );
}

/** Console de exceções do founder (Buddy v2). Determinístico, master-only. */
export function GestorExcecoes() {
  const { data, isLoading, refetchAll } = useExcecoesGestor();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!data || shownRef.current) return;
    shownRef.current = true;
    track('gestor.excecoes_shown', {
      total: data.totalLinhas,
      grupos: data.grupos.map(g => g.key),
      excedente: data.excedente,
    });
  }, [data]);

  const onRodarAgente = async () => {
    track('gestor.excecoes_run_agent', {});
    const { error } = await supabase.functions.invoke('ai-ops-agent');
    if (error) { toast.error('Erro ao atualizar análise'); return; }
    toast.success('Análise atualizada');
    refetchAll();
  };

  if (isLoading) {
    return <Card className="p-3 space-y-2"><Skeleton className="h-4 w-40" />{[0, 1].map(i => <Skeleton key={i} className="h-10 w-full" />)}</Card>;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Exceções — o que está fora do lugar</h2>
        <p className="text-2xs text-muted-foreground">Só o que precisa de atenção hoje. Cada linha mostra a fonte e o frescor.</p>
      </CardHeader>
      {!data || data.vazio ? (
        <div className="p-6 text-2xs text-muted-foreground">Tudo no lugar hoje 🎯</div>
      ) : (
        <div className="divide-y divide-border">
          {data.grupos.map(g => (
            <div key={g.key}>
              <div className="px-2.5 pt-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground">{g.titulo}</div>
              <div className="divide-y divide-border/50">
                {g.linhas.map(l => <LinhaItem key={l.id} linha={l} onRodarAgente={onRodarAgente} />)}
              </div>
            </div>
          ))}
          {data.excedente > 0 && (
            <div className="px-2.5 py-2 text-2xs text-muted-foreground">+{data.excedente} exceções não exibidas (teto do resumo).</div>
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Wire no `MasterDashboard.tsx` — substituir o placeholder**

Substituir o import `Construction` e o `Card` placeholder. Trocar a linha de import:

```tsx
import { Card } from '@/components/ui/card';
import { KpisToday } from './KpisToday';
import { TeamKpiTiles } from './TeamKpiTiles';
import { RankingVendedoresCard } from './RankingVendedoresCard';
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
import { ViewAsPicker } from '@/components/impersonation/ViewAsPicker';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { GestorExcecoes } from './GestorExcecoes';
```

Substituir o bloco `<Card className="p-4 border-dashed ...">...</Card>` (o placeholder "Em construção — PR-MULTIVENDOR-V2" inteiro, incluindo o `<Construction />` e a `<ul>`) por:

```tsx
      {/* GestorBuddy — console de exceções (Buddy v2) */}
      <GestorExcecoes />
```

> O `Card` continua importado (usado por outros blocos? conferir — se não, remover o import não-usado p/ não quebrar o lint `no-unused-vars`/strict). O ícone `Construction` deixa de ser usado → **remover** o `import { Construction } from 'lucide-react';`.

- [ ] **Step 3: Type-check + lint + testes**

Run: `bun run typecheck && bun lint && bunx vitest run src/lib/gestor/excecoes`
Expected: PASS nos três (0 lint errors; se `Card` ficou sem uso no MasterDashboard, remover o import).

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/GestorExcecoes.tsx src/components/dashboard/MasterDashboard.tsx
git commit -m "feat(gestor): card de Exceções no MasterDashboard + telemetria"
```

---

## Task 9: Health gate final

**Files:** nenhum (verificação).

- [ ] **Step 1: Suite canônica completa**

Run: `heavy bun run typecheck`
Expected: PASS (strict).

Run: `heavy bun run test`
Expected: PASS (todos, incl. `gestor/excecoes`).

Run: `bun lint`
Expected: 0 errors.

Run: `heavy bun run build`
Expected: build OK.

- [ ] **Step 2: Nota de entrega**

Sem migration / edge / cron. **Deploy = Publish do frontend no Lovable.** Confirmar em runtime (preview do founder): (a) o master lê `ai_decisions` + `v_tarefas_estado` team-wide; (b) frescor do `ai_decisions` (se sempre >48h, a meta-exceção + "Atualizar análise" é o caminho — avaliar um cron do `ai-ops-agent` como follow-up). v2: concentração de caixa/cliente.

---

## Self-Review

**1. Spec coverage:**
- §4 arquitetura (helper puro + hook 3-fontes + card + telemetria, near-zero backend) → Tasks 1-8. ✅
- §5.1 clientes risco freshness-first (escada <24h/24-48h/>48h meta-exceção + predicado confidence!=baixa + risco) → Task 4. ✅
- §5.2 dados quebrados (não-ok, todos critical + 3 warn) → Task 3. ✅
- §5.3 confirmações pendentes (proof-gap, ≥1 dia, copy não-acusatória, cap 3) → Task 5. ✅
- §6 grupos ordenados por dependência + teto 8-10 (críticos sempre) + merge visual → Task 6. ✅
- §7 recibos (fonte+frescor por linha) + empty-state honesto → Tasks 3-8. ✅
- §8 telemetria `gestor.excecoes_shown/acted/run_agent` + "Atualizar análise" → Task 8. ✅
- Não-objetivos (sem LLM/push/backend/cash) → respeitado. ✅

**2. Placeholder scan:** nenhum "TBD/TODO"; código completo em cada passo. ✅

**3. Type consistency:** `LinhaExcecao`/`GrupoExcecao`/`ConsoleExcecoes`/`DecisaoRiscoInput`/`SaudeCheckInput`/`TarefaGapInput`/`ExcecoesInput`/`EXCECOES_CFG_DEFAULT`/`Severidade` definidos na Task 1; detectores retornam `LinhaExcecao[]`; `montarExcecoes` retorna `ConsoleExcecoes`; `useExcecoesGestor` retorna `{data,isLoading,refetchAll}`. Campos reais conferidos: `AIDecision` (customer_user_id/farmer_id/primary_reason/confidence/customer_metrics/created_at/status), `DataHealthCheck` (source/domain/status/severity/message/age_seconds), `TarefaEstado` (id/descricao/customer_user_id/responsavel_efetivo/effective_due/status/atrasada/tem_sugestao_pendente), `resolverSugestao(candidatoId,tarefaId,aceitar)`, `spBusinessDate`. ✅

**Decisão registrada (ação de tarefa):** v1 expõe **Confirmar** (quando há `candidatoId`) + **Abrir**; **Rejeitar** fica de fora do card do founder no v1 (rejeitar a sugestão de outra pessoa pelo brief é mais delicado que confirmar; o founder Abre e resolve no contexto). Reduz superfície sem perder o valor (o nudge + a confirmação rápida quando ele sabe que foi feito).
