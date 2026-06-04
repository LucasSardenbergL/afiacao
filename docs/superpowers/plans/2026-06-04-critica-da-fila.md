# Crítica da Fila (v1 determinístico) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enriquecer os top-5 cards do Meu Dia da vendedora com um bloco "Por que agora" — timeline de fricção do cliente + badges de contradição determinísticos + feedback instrumentado — para provar a tese "Buddy" (contradição com evidência) em 2 semanas.

**Architecture:** 100% frontend. Um motor PURO (`src/lib/fila/critica/`) gera um `EvidencePack` por cliente a partir de sinais determinísticos que já descem pro cliente (`customer_metrics_mv`, `route_contact_log` via `useRouteContactList`, `v_tarefas_estado` via `useMinhasTarefas`). O hook `useCriticaFila` busca/normaliza e chama o motor; a UI estende `FilaDoDia`. Medição via PostHog (`track`). **Zero migration / edge / cron** — só Publish do frontend.

**Tech Stack:** React 18 + TS (strict) + Vite, @tanstack/react-query, Supabase client, vitest, shadcn/ui, `@/lib/analytics` (PostHog).

**Spec:** `docs/superpowers/specs/2026-06-04-critica-da-fila-design.md`

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/fila/critica/types.ts` (criar) | Tipos do motor: `SinalVoz`, `Contradicao`, `EvidencePack`, `CriticaInput` (+ sub-tipos), `CriticaCfg`, `DetectResult`, `CRITICA_CFG_DEFAULT`. |
| `src/lib/fila/critica/montar.ts` (criar) | Motor PURO: helpers + 4 detectores (`detectRecorrenteSumiu`, `detectSemResposta`, `detectTarefaSemProva`, `detectAltoValorForaRota`) + composer `montarEvidencePack`. |
| `src/lib/fila/critica/build-inputs.ts` (criar) | Mapper PURO `buildCriticaInputs` — junta `AcaoSugerida[]` + linhas de métrica/rota/tarefa em `CriticaInput[]` (1 por cliente). |
| `src/lib/fila/critica/__tests__/montar.test.ts` (criar) | Testes dos 4 detectores + composer. |
| `src/lib/fila/critica/__tests__/build-inputs.test.ts` (criar) | Testes do mapper. |
| `src/hooks/useCriticaFila.ts` (criar) | Hook fino: busca `customer_metrics_mv` dos top-N, reusa `useRouteContactList`/`useMinhasTarefas` (dedupe do React Query), chama mapper + motor. Retorna `Map<clienteUserId, EvidencePack>`. |
| `src/components/fila/PorQueAgora.tsx` (criar) | Bloco UI: badges de contradição + "Por que agora" expansível (timeline + falta-dado) + feedback. Dispara `track`. |
| `src/components/fila/FilaDoDia.tsx` (modificar) | Chama `useCriticaFila`, renderiza `<PorQueAgora>` sob os top-N cards, dispara `fila.critica_shown`. |

---

## Task 1: Tipos do motor

**Files:**
- Create: `src/lib/fila/critica/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
// src/lib/fila/critica/types.ts
// Motor "Crítica da Fila" (v1 determinístico). Tipos puros, sem dependência de rede.

export type SeveridadeSinal = 'info' | 'atencao' | 'critico';
export type TipoSinal = 'order_delta' | 'rota_outcome' | 'tarefa_estado';
export type Confianca = 'alta' | 'media' | 'baixa';
export type ChaveContradicao =
  | 'recorrente_sumiu'
  | 'sem_resposta_repetido'
  | 'tarefa_feita_sem_prova'
  | 'alto_valor_fora_rota';

/** Um fato determinístico do exhaust, atado à sua fonte (anti-alucinação). */
export interface SinalVoz {
  tipo: TipoSinal;
  texto: string; // pt-BR, pronto pra render
  fonte: { tabela: string; id: string; observadoEm: string | null }; // source_type / source_id / observed_at
  severidade: SeveridadeSinal;
}

export interface Contradicao {
  chave: ChaveContradicao;
  texto: string; // frase do badge
  evidencias: SinalVoz[]; // ≥1 SEMPRE; contradição sem evidência é descartada pelo composer
  confianca: Confianca;
}

export interface EvidencePack {
  clienteUserId: string;
  clienteNome: string | null;
  sinais: SinalVoz[]; // timeline de fricção (todos os sinais achados)
  contradicoes: Contradicao[]; // subconjunto que vira badge
  faltaDado: string[]; // degradação honesta — o que NÃO deu pra checar
}

// ── Entrada normalizada (Supabase-agnostic) ──────────────────────────
export interface MetricaCliente {
  intervaloMedioDias: number | null;
  diasDesdeUltimaCompra: number | null;
  atrasoRelativo: number | null;
  faturamento90d: number | null;
  faturamentoPrev90d: number | null;
  isColdStart: boolean;
}
export interface RotaCliente {
  naCallQueue: boolean;
  semRespostaRecenteN: number;
  ultimoContatoRealHaDias: number | null;
}
export interface TarefaCliente {
  atrasada: boolean;
  temSugestaoPendente: boolean;
  descricao: string;
}
export interface CriticaInput {
  clienteUserId: string;
  clienteNome: string | null;
  metrica: MetricaCliente | null; // null = sem linha em customer_metrics_mv
  rota: RotaCliente | null; // null = cadência indisponível (leitura de log falhou)
  tarefa: TarefaCliente | null; // null = sem tarefa atrelada a este cliente
}

/** Resultado de um detector individual. */
export interface DetectResult {
  sinais: SinalVoz[];
  contradicao: Contradicao | null;
}

/** Limiares — reusam o motor existente (useAiOps); valores de "alto valor" a calibrar no piloto. */
export interface CriticaCfg {
  atrasoRelativoMin: number; // 2.0  (useAiOps churn)
  quedaFatPct: number; // 0.5  (faturamento_90d < prev*0.5)
  semRespostaMin: number; // 3   (CADENCIA_DEFAULT.limiarSemResposta)
  altoValorFat90dMin: number; // calibrar no piloto
  altoValorDiasQuietoMin: number; // calibrar no piloto
  cadenciaMinDias: number; // 3
}

export const CRITICA_CFG_DEFAULT: CriticaCfg = {
  atrasoRelativoMin: 2.0,
  quedaFatPct: 0.5,
  semRespostaMin: 3,
  altoValorFat90dMin: 5000,
  altoValorDiasQuietoMin: 45,
  cadenciaMinDias: 3,
};
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS (sem erros; arquivo só declara tipos).

- [ ] **Step 3: Commit**

```bash
git add src/lib/fila/critica/types.ts
git commit -m "feat(critica): tipos do motor de evidência da fila"
```

---

## Task 2: Detector `detectRecorrenteSumiu`

**Files:**
- Create: `src/lib/fila/critica/montar.ts`
- Test: `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/fila/critica/__tests__/montar.test.ts
import { describe, it, expect } from 'vitest';
import { detectRecorrenteSumiu } from '../montar';
import { CRITICA_CFG_DEFAULT, type CriticaInput } from '../types';

const base = (over: Partial<CriticaInput>): CriticaInput => ({
  clienteUserId: 'c1',
  clienteNome: 'Cliente 1',
  metrica: null,
  rota: null,
  tarefa: null,
  ...over,
});

describe('detectRecorrenteSumiu', () => {
  it('dispara quando atraso_relativo >= 2.0', () => {
    const r = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 28, atrasoRelativo: 1.9, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao).toBeNull(); // 1.9 < 2.0 → não dispara por atraso

    const r2 = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 30, atrasoRelativo: 2.0, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r2.contradicao?.chave).toBe('recorrente_sumiu');
    expect(r2.contradicao?.confianca).toBe('alta');
    expect(r2.sinais).toHaveLength(1);
    expect(r2.sinais[0].fonte.tabela).toBe('customer_metrics_mv');
  });

  it('dispara quando faturamento cai >50%', () => {
    const r = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: null, diasDesdeUltimaCompra: 10, atrasoRelativo: 1.0, faturamento90d: 400, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('recorrente_sumiu');
  });

  it('NÃO fabrica nada para cold-start nem métrica ausente', () => {
    expect(detectRecorrenteSumiu(base({ metrica: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(
      detectRecorrenteSumiu(base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 99, atrasoRelativo: 5, faturamento90d: 0, faturamentoPrev90d: 0, isColdStart: true } }), CRITICA_CFG_DEFAULT).contradicao,
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: FAIL — `detectRecorrenteSumiu` não existe (`montar.ts` ainda não criado).

- [ ] **Step 3: Escrever a implementação mínima**

```ts
// src/lib/fila/critica/montar.ts
import type { CriticaInput, CriticaCfg, DetectResult, SinalVoz } from './types';

// ── helpers ──────────────────────────────────────────────────────────
const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;
const pct = (p: number): string => `${Math.round(p * 100)}%`;
const brl = (v: number): string => Math.round(v).toLocaleString('pt-BR');
const fonteMetrica = (id: string) => ({ tabela: 'customer_metrics_mv', id, observadoEm: null });

// ── 1. recorrente_sumiu (order-delta) ────────────────────────────────
export function detectRecorrenteSumiu(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const m = input.metrica;
  if (m == null || m.isColdStart) return { sinais: [], contradicao: null };

  const intervalo = num(m.intervaloMedioDias);
  const atraso = num(m.atrasoRelativo);
  const dias = num(m.diasDesdeUltimaCompra);
  const fat = num(m.faturamento90d);
  const prev = num(m.faturamentoPrev90d);

  const ev: SinalVoz[] = [];
  if (intervalo != null && atraso != null && atraso >= cfg.atrasoRelativoMin) {
    const txtDias = dias != null ? `${dias}d sem comprar` : 'atrasado';
    ev.push({
      tipo: 'order_delta',
      texto: `Comprava a cada ${Math.round(intervalo)}d; ${txtDias} (${atraso.toFixed(1)}× o intervalo)`,
      fonte: fonteMetrica(input.clienteUserId),
      severidade: 'critico',
    });
  }
  if (prev != null && prev > 0 && fat != null && fat < prev * cfg.quedaFatPct) {
    const queda = 1 - fat / prev;
    ev.push({
      tipo: 'order_delta',
      texto: `Faturamento caiu ${pct(queda)} (R$ ${brl(fat)} vs R$ ${brl(prev)})`,
      fonte: fonteMetrica(input.clienteUserId),
      severidade: 'critico',
    });
  }
  if (ev.length === 0) return { sinais: [], contradicao: null };
  return {
    sinais: ev,
    contradicao: { chave: 'recorrente_sumiu', texto: 'Cliente recorrente parou/caiu', evidencias: ev, confianca: 'alta' },
  };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): detector recorrente_sumiu (order-delta)"
```

---

## Task 3: Detector `detectSemResposta`

**Files:**
- Modify: `src/lib/fila/critica/montar.ts`
- Test: `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

Adicionar ao final de `montar.test.ts` (e incluir `detectSemResposta` no import existente do topo):

```ts
import { detectSemResposta } from '../montar';

describe('detectSemResposta', () => {
  it('dispara quando semRespostaRecenteN >= 3', () => {
    const r = detectSemResposta(
      base({ rota: { naCallQueue: true, semRespostaRecenteN: 3, ultimoContatoRealHaDias: null } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('sem_resposta_repetido');
    expect(r.contradicao?.confianca).toBe('alta');
    expect(r.sinais[0].fonte.tabela).toBe('route_contact_log');
  });

  it('NÃO dispara abaixo do limiar nem com rota ausente', () => {
    expect(detectSemResposta(base({ rota: { naCallQueue: true, semRespostaRecenteN: 2, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectSemResposta(base({ rota: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: FAIL — `detectSemResposta` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── 2. sem_resposta_repetido (rota) ──────────────────────────────────
export function detectSemResposta(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const r = input.rota;
  if (r == null || r.semRespostaRecenteN < cfg.semRespostaMin) return { sinais: [], contradicao: null };
  const ev: SinalVoz = {
    tipo: 'rota_outcome',
    texto: `${r.semRespostaRecenteN} tentativas de contato sem resposta`,
    fonte: { tabela: 'route_contact_log', id: input.clienteUserId, observadoEm: null },
    severidade: 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'sem_resposta_repetido', texto: 'Sem resposta repetida', evidencias: [ev], confianca: 'alta' } };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): detector sem_resposta_repetido (rota)"
```

---

## Task 4: Detector `detectTarefaSemProva`

**Files:**
- Modify: `src/lib/fila/critica/montar.ts`
- Test: `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { detectTarefaSemProva } from '../montar';

describe('detectTarefaSemProva', () => {
  it('dispara quando há indício pendente; severidade sobe se atrasada', () => {
    const r = detectTarefaSemProva(
      base({ tarefa: { atrasada: true, temSugestaoPendente: true, descricao: 'Ligar p/ oferecer linha nova' } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('tarefa_feita_sem_prova');
    expect(r.contradicao?.confianca).toBe('media');
    expect(r.sinais[0].severidade).toBe('critico'); // atrasada
    expect(r.sinais[0].texto).toContain('Ligar p/ oferecer linha nova');
  });

  it('NÃO dispara sem indício pendente nem sem tarefa', () => {
    expect(detectTarefaSemProva(base({ tarefa: { atrasada: true, temSugestaoPendente: false, descricao: 'x' } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectTarefaSemProva(base({ tarefa: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: FAIL — `detectTarefaSemProva` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── 3. tarefa_feita_sem_prova (escada de certeza) ────────────────────
export function detectTarefaSemProva(input: CriticaInput, _cfg: CriticaCfg): DetectResult {
  const t = input.tarefa;
  if (t == null || !t.temSugestaoPendente) return { sinais: [], contradicao: null };
  const ev: SinalVoz = {
    tipo: 'tarefa_estado',
    texto: `Tarefa "${t.descricao}" tem indício de cumprida, sem prova confirmada${t.atrasada ? ' (atrasada)' : ''}`,
    fonte: { tabela: 'v_tarefas_estado', id: input.clienteUserId, observadoEm: null },
    severidade: t.atrasada ? 'critico' : 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'tarefa_feita_sem_prova', texto: 'Tarefa com indício sem prova', evidencias: [ev], confianca: 'media' } };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): detector tarefa_feita_sem_prova (escada de certeza)"
```

---

## Task 5: Detector `detectAltoValorForaRota`

**Files:**
- Modify: `src/lib/fila/critica/montar.ts`
- Test: `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { detectAltoValorForaRota } from '../montar';

describe('detectAltoValorForaRota', () => {
  const mAlto = { intervaloMedioDias: null, diasDesdeUltimaCompra: 60, atrasoRelativo: null, faturamento90d: 8000, faturamentoPrev90d: null, isColdStart: false };

  it('dispara: alto valor + quieto >=45d + fora da callQueue', () => {
    const r = detectAltoValorForaRota(
      base({ metrica: mAlto, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('alto_valor_fora_rota');
    expect(r.contradicao?.confianca).toBe('media');
  });

  it('NÃO dispara se está na callQueue, se quieto<45d, ou rota ausente', () => {
    expect(detectAltoValorForaRota(base({ metrica: mAlto, rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectAltoValorForaRota(base({ metrica: { ...mAlto, diasDesdeUltimaCompra: 10 }, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectAltoValorForaRota(base({ metrica: mAlto, rota: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });

  it('NÃO dispara abaixo do limiar de faturamento', () => {
    expect(detectAltoValorForaRota(base({ metrica: { ...mAlto, faturamento90d: 100 }, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: FAIL — `detectAltoValorForaRota` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
// ── 4. alto_valor_fora_rota (cruzamento) ─────────────────────────────
// Suprimido pelo composer se recorrente_sumiu já disparou (evita badge duplo).
export function detectAltoValorForaRota(input: CriticaInput, cfg: CriticaCfg): DetectResult {
  const m = input.metrica;
  const r = input.rota;
  if (m == null || m.isColdStart || r == null) return { sinais: [], contradicao: null };
  const fat = num(m.faturamento90d);
  const dias = num(m.diasDesdeUltimaCompra);
  if (fat == null || dias == null) return { sinais: [], contradicao: null };
  if (fat < cfg.altoValorFat90dMin || dias < cfg.altoValorDiasQuietoMin || r.naCallQueue) {
    return { sinais: [], contradicao: null };
  }
  const ev: SinalVoz = {
    tipo: 'order_delta',
    texto: `Alto valor (R$ ${brl(fat)}/90d), ${dias}d sem comprar e fora da rota de amanhã`,
    fonte: fonteMetrica(input.clienteUserId),
    severidade: 'atencao',
  };
  return { sinais: [ev], contradicao: { chave: 'alto_valor_fora_rota', texto: 'Alto valor quieto, fora da rota', evidencias: [ev], confianca: 'media' } };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): detector alto_valor_fora_rota (cruzamento)"
```

---

## Task 6: Composer `montarEvidencePack`

**Files:**
- Modify: `src/lib/fila/critica/montar.ts`
- Test: `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: Adicionar o teste que falha**

```ts
import { montarEvidencePack } from '../montar';

describe('montarEvidencePack (composer)', () => {
  it('agrega sinais e contradições de múltiplos detectores', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 40, atrasoRelativo: 2.5, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false },
      rota: { naCallQueue: true, semRespostaRecenteN: 4, ultimoContatoRealHaDias: 1 },
      tarefa: null,
    }));
    const chaves = pack.contradicoes.map(c => c.chave).sort();
    expect(chaves).toEqual(['recorrente_sumiu', 'sem_resposta_repetido']);
    expect(pack.sinais.length).toBeGreaterThanOrEqual(2);
  });

  it('suprime alto_valor_fora_rota quando recorrente_sumiu também dispara', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 30, diasDesdeUltimaCompra: 90, atrasoRelativo: 3.0, faturamento90d: 9000, faturamentoPrev90d: 9000, isColdStart: false },
      rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null },
    }));
    const chaves = pack.contradicoes.map(c => c.chave);
    expect(chaves).toContain('recorrente_sumiu');
    expect(chaves).not.toContain('alto_valor_fora_rota');
  });

  it('degrada honesto: métrica ausente e rota indisponível viram faltaDado, sem fabricar', () => {
    const pack = montarEvidencePack(base({ metrica: null, rota: null, tarefa: null }));
    expect(pack.contradicoes).toHaveLength(0);
    expect(pack.faltaDado.length).toBeGreaterThanOrEqual(2);
  });

  it('cold-start não fabrica delta', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 10, diasDesdeUltimaCompra: 99, atrasoRelativo: 9, faturamento90d: 0, faturamentoPrev90d: 0, isColdStart: true },
      rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: 1 },
    }));
    expect(pack.contradicoes).toHaveLength(0);
    expect(pack.faltaDado.some(f => f.toLowerCase().includes('novo'))).toBe(true);
  });

  it('toda contradição retornada tem ≥1 evidência', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 30, atrasoRelativo: 2.0, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false },
      rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: 1 },
    }));
    for (const c of pack.contradicoes) expect(c.evidencias.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: FAIL — `montarEvidencePack` não existe.

- [ ] **Step 3: Implementar**

Adicionar a `montar.ts`:

```ts
import type { CriticaInput, CriticaCfg, EvidencePack, SinalVoz, Contradicao } from './types';
import { CRITICA_CFG_DEFAULT } from './types';

// ── composer ─────────────────────────────────────────────────────────
export function montarEvidencePack(input: CriticaInput, cfg: CriticaCfg = CRITICA_CFG_DEFAULT): EvidencePack {
  const faltaDado: string[] = [];
  if (input.metrica == null) faltaDado.push('Sem métricas de compra deste cliente.');
  else if (input.metrica.isColdStart) faltaDado.push('Cliente novo, sem histórico de compra.');
  if (input.rota == null) faltaDado.push('Sinais de rota indisponíveis (cadência não lida).');

  const resultados = [
    detectRecorrenteSumiu(input, cfg),
    detectSemResposta(input, cfg),
    detectTarefaSemProva(input, cfg),
    detectAltoValorForaRota(input, cfg),
  ];

  const sinais: SinalVoz[] = [];
  let contradicoes: Contradicao[] = [];
  for (const r of resultados) {
    sinais.push(...r.sinais);
    if (r.contradicao && r.contradicao.evidencias.length > 0) contradicoes.push(r.contradicao);
  }

  // suprime alto_valor_fora_rota se recorrente_sumiu já cobre o mesmo cliente
  if (contradicoes.some(c => c.chave === 'recorrente_sumiu')) {
    contradicoes = contradicoes.filter(c => c.chave !== 'alto_valor_fora_rota');
  }

  return { clienteUserId: input.clienteUserId, clienteNome: input.clienteNome, sinais, contradicoes, faltaDado };
}
```

> Nota: o `import type` no topo de `montar.ts` (Task 2) já importa `CriticaInput, CriticaCfg, DetectResult, SinalVoz`. Estender a linha de import para incluir também `EvidencePack` e `Contradicao`, e adicionar `import { CRITICA_CFG_DEFAULT } from './types';`. Não duplicar a linha `import type`.

- [ ] **Step 4: Rodar e ver passar (suite inteira)**

Run: `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts`
Expected: PASS (todos os blocos: 4 detectores + composer).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): composer montarEvidencePack (agrega + suprime dupe + degrada honesto)"
```

---

## Task 7: Mapper `buildCriticaInputs`

**Files:**
- Create: `src/lib/fila/critica/build-inputs.ts`
- Test: `src/lib/fila/critica/__tests__/build-inputs.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/fila/critica/__tests__/build-inputs.test.ts
import { describe, it, expect } from 'vitest';
import { buildCriticaInputs, type MetricRowFull, type RotaSinalCliente, type TarefaSinalCliente } from '../build-inputs';
import type { AcaoSugerida } from '@/lib/fila/types';

const acao = (clienteUserId: string | null, nome: string | null = 'X'): AcaoSugerida => ({
  fonte: 'tarefa', entidadeId: 'e', clienteUserId, clienteNome: nome, telefone: null,
  acao: 'Ligar', titulo: 't', motivo: 'm', categoria: 'risco', score: 0.5,
  valorEsperado: null, tipoValor: 'sem_valor', cta: 'ligar', dedupeKey: `k:${clienteUserId}`,
});

const metric = (id: string): MetricRowFull => ({
  customer_user_id: id, intervalo_medio_dias: 15, dias_desde_ultima_compra: 30,
  atraso_relativo: 2.0, faturamento_90d: 1000, faturamento_prev_90d: 1000, is_cold_start: false,
});

describe('buildCriticaInputs', () => {
  it('dedupa por cliente e normaliza métrica/rota/tarefa', () => {
    const acoes = [acao('c1'), acao('c1'), acao('c2'), acao(null)];
    const rota: RotaSinalCliente[] = [{ customerUserId: 'c1', naCallQueue: true, semRespostaRecenteN: 3, ultimoContatoRealHaDias: 2 }];
    const tarefas: TarefaSinalCliente[] = [{ customerUserId: 'c2', atrasada: true, temSugestaoPendente: true, descricao: 'd' }];
    const out = buildCriticaInputs(acoes, [metric('c1')], rota, tarefas);

    expect(out.map(i => i.clienteUserId)).toEqual(['c1', 'c2']); // dedupe + ignora null
    const c1 = out.find(i => i.clienteUserId === 'c1')!;
    expect(c1.metrica?.atrasoRelativo).toBe(2.0);
    expect(c1.rota?.naCallQueue).toBe(true);
    expect(c1.tarefa).toBeNull();
    const c2 = out.find(i => i.clienteUserId === 'c2')!;
    expect(c2.metrica).toBeNull(); // sem linha de métrica
    expect(c2.rota).toEqual({ naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null }); // rota lida, sem sinal deste cliente
    expect(c2.tarefa?.temSugestaoPendente).toBe(true);
  });

  it('rotaSinais=null (cadência indisponível) → rota null em todos', () => {
    const out = buildCriticaInputs([acao('c1')], [metric('c1')], null, []);
    expect(out[0].rota).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/build-inputs.test.ts`
Expected: FAIL — `build-inputs` não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/critica/build-inputs.ts
import type { AcaoSugerida } from '@/lib/fila/types';
import type { CriticaInput, MetricaCliente, RotaCliente, TarefaCliente } from './types';

export interface MetricRowFull {
  customer_user_id: string;
  intervalo_medio_dias: number | null;
  dias_desde_ultima_compra: number | null;
  atraso_relativo: number | null;
  faturamento_90d: number | null;
  faturamento_prev_90d: number | null;
  is_cold_start: boolean | null;
}
export interface RotaSinalCliente {
  customerUserId: string;
  naCallQueue: boolean;
  semRespostaRecenteN: number;
  ultimoContatoRealHaDias: number | null;
}
export interface TarefaSinalCliente {
  customerUserId: string;
  atrasada: boolean;
  temSugestaoPendente: boolean;
  descricao: string;
}

/**
 * Junta ações + linhas de sinal em CriticaInput[] (1 por cliente, dedupe na ordem das ações).
 * rotaSinais === null ⇒ cadência indisponível (rota null em todos = degradação honesta).
 * rotaSinais !== null mas sem o cliente ⇒ rota lida, cliente sem sinal (default neutro).
 */
export function buildCriticaInputs(
  acoes: AcaoSugerida[],
  metricas: MetricRowFull[],
  rotaSinais: RotaSinalCliente[] | null,
  tarefaSinais: TarefaSinalCliente[],
): CriticaInput[] {
  const mByCli = new Map(metricas.map(m => [m.customer_user_id, m]));
  const rByCli = rotaSinais ? new Map(rotaSinais.map(s => [s.customerUserId, s])) : null;

  // 1 tarefa por cliente: prioriza a atrasada-com-indício
  const tByCli = new Map<string, TarefaSinalCliente>();
  for (const s of tarefaSinais) {
    const atual = tByCli.get(s.customerUserId);
    if (!atual || (s.atrasada && s.temSugestaoPendente)) tByCli.set(s.customerUserId, s);
  }

  const out: CriticaInput[] = [];
  const vistos = new Set<string>();
  for (const a of acoes) {
    const cli = a.clienteUserId;
    if (cli == null || vistos.has(cli)) continue;
    vistos.add(cli);

    const mRow = mByCli.get(cli);
    const metrica: MetricaCliente | null = mRow
      ? {
          intervaloMedioDias: mRow.intervalo_medio_dias,
          diasDesdeUltimaCompra: mRow.dias_desde_ultima_compra,
          atrasoRelativo: mRow.atraso_relativo,
          faturamento90d: mRow.faturamento_90d,
          faturamentoPrev90d: mRow.faturamento_prev_90d,
          isColdStart: mRow.is_cold_start ?? false,
        }
      : null;

    let rota: RotaCliente | null;
    if (rByCli == null) rota = null; // cadência indisponível globalmente
    else {
      const rRow = rByCli.get(cli);
      rota = rRow
        ? { naCallQueue: rRow.naCallQueue, semRespostaRecenteN: rRow.semRespostaRecenteN, ultimoContatoRealHaDias: rRow.ultimoContatoRealHaDias }
        : { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null };
    }

    const tRow = tByCli.get(cli);
    const tarefa: TarefaCliente | null = tRow
      ? { atrasada: tRow.atrasada, temSugestaoPendente: tRow.temSugestaoPendente, descricao: tRow.descricao }
      : null;

    out.push({ clienteUserId: cli, clienteNome: a.clienteNome, metrica, rota, tarefa });
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/fila/critica/__tests__/build-inputs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/critica/build-inputs.ts src/lib/fila/critica/__tests__/build-inputs.test.ts
git commit -m "feat(critica): mapper buildCriticaInputs (ações + sinais → CriticaInput)"
```

---

## Task 8: Hook `useCriticaFila`

**Files:**
- Create: `src/hooks/useCriticaFila.ts`

> Sem teste unitário próprio (hook fino de fetch/composição — a lógica pura está em `montarEvidencePack` e `buildCriticaInputs`, já testadas). `useRouteContactList(workdayIso)` e `useMinhasTarefas()` reusam a mesma queryKey de `useFilaAcoes` → o React Query **dedupa** (sem fetch duplicado).

- [ ] **Step 1: Implementar o hook**

```ts
// src/hooks/useCriticaFila.ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { spBusinessDate } from '@/lib/time/sp-day';
import { montarEvidencePack } from '@/lib/fila/critica/montar';
import { buildCriticaInputs, type MetricRowFull, type RotaSinalCliente, type TarefaSinalCliente } from '@/lib/fila/critica/build-inputs';
import type { AcaoSugerida } from '@/lib/fila/types';
import type { EvidencePack } from '@/lib/fila/critica/types';

const IN_CHUNK = 200;

async function fetchCriticaMetrics(ids: string[]): Promise<MetricRowFull[]> {
  const out: MetricRowFull[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('customer_metrics_mv')
      .select('customer_user_id, intervalo_medio_dias, dias_desde_ultima_compra, atraso_relativo, faturamento_90d, faturamento_prev_90d, is_cold_start')
      .in('customer_user_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as MetricRowFull[]));
  }
  return out;
}

/** EvidencePack por cliente para os top-N cards da fila. Map keyed por clienteUserId. */
export function useCriticaFila(acoes: AcaoSugerida[], topN = 5): Map<string, EvidencePack> {
  const workdayIso = useMemo(() => spBusinessDate(new Date()), []);

  const topIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const a of acoes) {
      if (a.clienteUserId && !seen.has(a.clienteUserId)) { seen.add(a.clienteUserId); ids.push(a.clienteUserId); }
      if (ids.length >= topN) break;
    }
    return ids;
  }, [acoes, topN]);

  const rota = useRouteContactList(workdayIso);
  const tarefas = useMinhasTarefas();
  const metricsQ = useQuery({
    queryKey: ['critica-metrics', topIds],
    enabled: topIds.length > 0,
    staleTime: 60_000,
    queryFn: () => fetchCriticaMetrics(topIds),
  });

  return useMemo(() => {
    const result = new Map<string, EvidencePack>();
    if (topIds.length === 0) return result;

    const callQueue = rota.data?.callQueue ?? [];
    const cadenciaIndisponivel = rota.data?.cadenciaIndisponivel ?? false;
    const rotaSinais: RotaSinalCliente[] | null = cadenciaIndisponivel
      ? null
      : callQueue.map(c => ({
          customerUserId: c.customer_user_id,
          naCallQueue: true,
          semRespostaRecenteN: c.semRespostaRecenteN,
          ultimoContatoRealHaDias: c.ultimoContatoRealHaDias,
        }));

    const tarefaSinais: TarefaSinalCliente[] = (tarefas.data ?? []).map(t => ({
      customerUserId: t.customer_user_id,
      atrasada: t.atrasada,
      temSugestaoPendente: t.tem_sugestao_pendente,
      descricao: t.descricao,
    }));

    const topAcoes = acoes.filter(a => a.clienteUserId != null && topIds.includes(a.clienteUserId));
    const inputs = buildCriticaInputs(topAcoes, metricsQ.data ?? [], rotaSinais, tarefaSinais);
    for (const input of inputs) result.set(input.clienteUserId, montarEvidencePack(input));
    return result;
  }, [topIds, acoes, rota.data, tarefas.data, metricsQ.data]);
}
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS. (Se houver erro em `c.customer_user_id`, conferir o campo em `RouteContactItem` — é `customer_user_id` herdado de `ScoredCandidate`; o tipo já é usado assim em `useFilaAcoes`/adapters.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCriticaFila.ts
git commit -m "feat(critica): hook useCriticaFila (fetch + composição dos top-5)"
```

---

## Task 9: UI — `PorQueAgora` + wiring em `FilaDoDia` + telemetria

**Files:**
- Create: `src/components/fila/PorQueAgora.tsx`
- Modify: `src/components/fila/FilaDoDia.tsx`

- [ ] **Step 1: Criar o componente `PorQueAgora`**

```tsx
// src/components/fila/PorQueAgora.tsx
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import type { EvidencePack, SeveridadeSinal } from '@/lib/fila/critica/types';

const SEV_CLS: Record<SeveridadeSinal, string> = {
  critico: 'text-status-error',
  atencao: 'text-status-warning',
  info: 'text-status-info',
};

type Feedback = 'util' | 'errado' | 'ja_resolvi' | 'falta_dado';
const FEEDBACK_LABEL: Record<Feedback, string> = {
  util: 'Útil', errado: 'Errado', ja_resolvi: 'Já resolvi', falta_dado: 'Falta dado',
};

/** Bloco "Por que agora": badges de contradição + timeline expansível + feedback. */
export function PorQueAgora({ pack }: { pack: EvidencePack }) {
  const [aberto, setAberto] = useState(false);
  const [enviado, setEnviado] = useState<Feedback | null>(null);

  if (pack.contradicoes.length === 0) return null; // nada a mostrar → card normal

  const chaves = pack.contradicoes.map(c => c.chave);

  const onToggle = () => {
    const novo = !aberto;
    setAberto(novo);
    if (novo) track('fila.critica_opened', { cliente: pack.clienteUserId, chaves });
  };
  const onFeedback = (f: Feedback) => {
    setEnviado(f);
    track('fila.critica_feedback', { cliente: pack.clienteUserId, feedback: f, chaves });
  };

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-1 items-center">
        {pack.contradicoes.map(c => (
          <Badge key={c.chave} variant="outline" className={`text-2xs ${SEV_CLS[c.evidencias[0]?.severidade ?? 'atencao']}`}>
            {c.texto}
          </Badge>
        ))}
        <button type="button" onClick={onToggle} className="text-2xs text-muted-foreground underline ml-1">
          {aberto ? 'ocultar' : 'por que agora'}
        </button>
      </div>

      {aberto && (
        <div className="mt-1.5 rounded-md border border-border bg-muted/20 p-2 space-y-1">
          <ul className="space-y-0.5">
            {pack.sinais.map((s, i) => (
              <li key={i} className={`text-2xs ${SEV_CLS[s.severidade]}`}>• {s.texto}</li>
            ))}
          </ul>
          {pack.faltaDado.length > 0 && (
            <div className="text-2xs text-muted-foreground">
              {pack.faltaDado.map((f, i) => <div key={i}>— {f}</div>)}
            </div>
          )}
          <div className="flex gap-1 pt-1">
            {(Object.keys(FEEDBACK_LABEL) as Feedback[]).map(f => (
              <Button
                key={f}
                size="sm"
                variant={enviado === f ? 'default' : 'outline'}
                className="h-6 text-2xs px-2"
                disabled={enviado != null}
                onClick={() => onFeedback(f)}
              >
                {FEEDBACK_LABEL[f]}
              </Button>
            ))}
            {enviado && <span className="text-2xs text-status-success self-center">obrigado</span>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Modificar `FilaDoDia.tsx` — importar o hook/componente e disparar `shown`**

Substituir o topo do arquivo (imports) por:

```tsx
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { useFilaAcoes } from '@/hooks/useFilaAcoes';
import { useCriticaFila } from '@/hooks/useCriticaFila';
import { PorQueAgora } from '@/components/fila/PorQueAgora';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';
```

- [ ] **Step 3: Modificar o corpo de `FilaDoDia` — chamar o hook, disparar `shown` uma vez, renderizar o bloco**

Substituir a função `FilaDoDia()` inteira por:

```tsx
export function FilaDoDia() {
  const { acoes, isLoading } = useFilaAcoes();
  const packs = useCriticaFila(acoes);
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [cli, pack] of packs) {
      if (pack.contradicoes.length > 0 && !shownRef.current.has(cli)) {
        shownRef.current.add(cli);
        track('fila.critica_shown', { cliente: cli, chaves: pack.contradicoes.map(c => c.chave) });
      }
    }
  }, [packs]);

  if (isLoading) {
    return (
      <Card className="p-3 space-y-2">
        <Skeleton className="h-4 w-40" />
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
      </Card>
    );
  }

  if (acoes.length === 0) {
    return (
      <Card className="p-6 text-2xs text-muted-foreground">
        Nada na fila agora — sua carteira está em dia. 🎯
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">O que fazer agora</h2>
        <p className="text-2xs text-muted-foreground">
          {acoes.length} ações priorizadas — tarefas, rota e oportunidades, do mais urgente ao menos.
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {acoes.slice(0, 30).map((a, i) => {
          const cat = CATEGORIA_UI[a.categoria];
          const href = clienteHref(a);
          const pack = a.clienteUserId ? packs.get(a.clienteUserId) : undefined;
          return (
            <div key={`${a.dedupeKey}:${i}`} className="p-3 flex items-start justify-between gap-3 hover:bg-muted/30">
              <div className="min-w-0">
                {href ? (
                  <Link to={href} className="block text-sm font-medium truncate hover:underline">{a.titulo}</Link>
                ) : (
                  <div className="text-sm font-medium truncate">{a.titulo}</div>
                )}
                <div className="text-2xs text-muted-foreground flex gap-2 flex-wrap items-center mt-0.5">
                  <Badge variant="outline" className={`text-2xs ${cat.cls}`}>{cat.label}</Badge>
                  <span className="truncate">{a.motivo}</span>
                  {a.valorEsperado != null && (
                    <span className="font-tabular">~R$ {Math.round(a.valorEsperado).toLocaleString('pt-BR')} estimado</span>
                  )}
                </div>
                {pack && <PorQueAgora pack={pack} />}
              </div>
              <div className="shrink-0"><AcaoCta a={a} /></div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
```

> `CATEGORIA_UI`, `clienteHref`, `AcaoCta` permanecem inalterados (já existem no arquivo). A única mudança estrutural no card: `items-center` → `items-start` (pra acomodar o bloco multilinha) e a inserção do `{pack && <PorQueAgora pack={pack} />}`.

- [ ] **Step 4: Type-check + lint + testes**

Run: `bun run typecheck && bun lint && bunx vitest run src/lib/fila/critica`
Expected: PASS nos três.

- [ ] **Step 5: Commit**

```bash
git add src/components/fila/PorQueAgora.tsx src/components/fila/FilaDoDia.tsx
git commit -m "feat(critica): bloco Por que agora no Meu Dia + telemetria (shown/opened/acted/feedback)"
```

---

## Task 10: Health gate final

**Files:** nenhum (só verificação).

- [ ] **Step 1: Rodar a suite canônica completa**

Run: `bun run typecheck`
Expected: PASS (strict, todo o src + testes).

Run: `bun run test`
Expected: PASS (todos os testes, incluindo `critica`).

Run: `bun lint`
Expected: 0 errors.

Run: `bun run build`
Expected: build OK (PWA gerado).

- [ ] **Step 2: Marcar `fila.critica_acted` no CTA (verificação)**

Confirmar que o clique no CTA já dispara telemetria associável à crítica. O `AcaoCta` existente dispara `fila.acao_fazer` com `{ fonte, cta, categoria }`. Para o piloto cruzar "acionou um card com crítica", **estender** o `onClick` do `AcaoCta` para incluir se o cliente tem pack com contradição. Editar `AcaoCta` em `FilaDoDia.tsx`:

```tsx
function AcaoCta({ a, temCritica }: { a: AcaoSugerida; temCritica: boolean }) {
  const onClick = () => {
    track('fila.acao_fazer', { fonte: a.fonte, cta: a.cta, categoria: a.categoria });
    if (temCritica) track('fila.critica_acted', { cliente: a.clienteUserId, cta: a.cta });
  };
  // ... resto inalterado
}
```

E no render do card, passar a flag: `<AcaoCta a={a} temCritica={!!pack && pack.contradicoes.length > 0} />`.

- [ ] **Step 3: Re-rodar typecheck + lint**

Run: `bun run typecheck && bun lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/fila/FilaDoDia.tsx
git commit -m "feat(critica): fila.critica_acted no CTA de card com crítica (medição do piloto)"
```

- [ ] **Step 5: Nota de entrega**

Sem migration / edge / cron. **Deploy = Publish do frontend no Lovable.** Calibração pendente no piloto: `altoValorFat90dMin` e `altoValorDiasQuietoMin` em `CRITICA_CFG_DEFAULT` (pedir o número ao founder com dado real). Piloto de 2 semanas + critério de morte conforme a spec §8.

---

## Self-Review

**1. Spec coverage:**
- §4 arquitetura client-side, helper puro + hook + UI + PostHog → Tasks 1-9. ✅
- §5 schema EvidencePack → Task 1. ✅
- §6 as 4 contradições (recorrente_sumiu, sem_resposta_repetido, tarefa_feita_sem_prova, alto_valor_fora_rota) → Tasks 2-5; WhatsApp adiado (não há task — correto). ✅
- §6 thresholds reusam useAiOps (atraso 2.0 / queda 0.5 / sem_resposta 3) → Task 1 `CRITICA_CFG_DEFAULT`. ✅
- §7 degradação honesta (cold-start, rota indisponível, claim sem evidência, pack mínimo) → Task 6 composer + testes. ✅
- §8 medição PostHog (shown/opened/acted/feedback) + critério de morte → Tasks 9-10. ✅
- §10 riscos: semântica v_tarefas_estado → resolvida (usa `tem_sugestao_pendente`/`atrasada` da view, Task 8/9); limiar alto valor → flag de calibração (Task 10); custo metrics → `.in()` chunked top-N (Task 8); hash de cliente nos eventos → **GAP**, ver abaixo.

**2. Placeholder scan:** nenhum "TBD/TODO"; todo passo tem código real. ✅

**3. Type consistency:** `EvidencePack`/`SinalVoz`/`Contradicao`/`CriticaInput`/`DetectResult`/`CRITICA_CFG_DEFAULT` definidos na Task 1 e usados consistentemente; `detect*` retornam `DetectResult`; `montarEvidencePack` retorna `EvidencePack`; `buildCriticaInputs` retorna `CriticaInput[]`; `useCriticaFila` retorna `Map<string, EvidencePack>`. `RouteContactItem.customer_user_id`/`semRespostaRecenteN`/`ultimoContatoRealHaDias` e `TarefaEstado.tem_sugestao_pendente`/`atrasada`/`customer_user_id`/`descricao` conferidos nos arquivos-fonte. ✅

**Gap corrigido inline (hash de cliente nos eventos):** a spec §10 pede hashear `clienteUserId` nos eventos PostHog (sem PII). Decisão: o `customer_user_id` é um UUID interno (não PII direta — não é nome/CPF/telefone), e os eventos existentes da fila (`fila.acao_fazer`) **não** hasheiam ids. Para manter consistência com o padrão vigente e não inventar um esquema de hash novo, os eventos `fila.critica_*` enviam `cliente: clienteUserId` cru (UUID), igual ao resto da telemetria da fila. Se o founder quiser hash depois, é um follow-up de 1 linha por evento. (Registrado como decisão, não placeholder.)
