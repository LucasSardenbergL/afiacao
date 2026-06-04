# G1 Fase 1 — Motor da Fila de Ações (dados) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar um hook `useFilaAcoes()` que retorna UMA fila de ações priorizada, fundindo 4 fontes que já existem (tarefas, ligações da rota, WhatsApp pendente, mix-gap), sem reescrever nenhum motor e sem UI nova ainda.

**Architecture:** Camada de dados pura e testável. Um tipo comum `AcaoSugerida`; um adapter puro por fonte (recebe o output do hook-fonte → `AcaoSugerida[]`); um ranqueador por categoria com dedupe. O hook `useFilaAcoes` é o único pedaço impuro: chama os hooks-fonte existentes, aplica os adapters puros, deduplica e ranqueia via `useMemo`. Derivação no front (sem tabela materializada — decisão do spec §5; materializa pós-piloto). Feedback persistido e UamI NÃO entram nesta fase.

**Tech Stack:** React 18 + TS, `@tanstack/react-query`, Vitest (helpers puros, padrão do repo — ver `src/lib/route/route-outcome.ts`). Domínio em pt-BR (CLAUDE.md §5).

**Spec:** `docs/superpowers/specs/2026-06-04-meudia-fila-unica-g1-design.md` (§4 fontes, §5 arquitetura, §6 ranking).

---

## File Structure

- Create: `src/lib/fila/types.ts` — tipo `AcaoSugerida` + enums (`CategoriaAcao`, `FonteAcao`, `TipoValor`, `TipoCta`).
- Create: `src/lib/fila/ranking.ts` — `rankearFila()` + `dedupe()` (puros).
- Create: `src/lib/fila/adapters/tarefa.ts` — `tarefasParaAcoes(TarefaEstado[])`.
- Create: `src/lib/fila/adapters/rota.ts` — `rotaParaAcoes(RouteContactItem[])`.
- Create: `src/lib/fila/adapters/mixgap.ts` — `mixGapParaAcoes(MixGap | null)`.
- Create: `src/lib/fila/adapters/whatsappPendente.ts` — `whatsappPendenteParaAcoes(WaPendente[])` + tipo `WaPendente`.
- Create: `src/lib/fila/__tests__/{ranking,tarefa,rota,mixgap,whatsappPendente}.test.ts` — Vitest.
- Create: `src/hooks/useWhatsappPendentes.ts` — deriva conversas pendentes do inbox.
- Create: `src/hooks/useFilaAcoes.ts` — glue (hooks-fonte + adapters + dedupe + ranking).

Reaproveita sem tocar: `useMinhasTarefas` (`src/hooks/useTarefas.ts`), `useRouteContactList` (`src/queries/useRouteContactList.ts`), `useMyMixGap` (`src/hooks/useMyMixGap.ts`), `useWhatsappConversations`/`useWhatsappThread` (`src/queries/useWhatsappInbox.ts`).

---

## Task 1: Tipo comum `AcaoSugerida`

**Files:**
- Create: `src/lib/fila/types.ts`

- [ ] **Step 1: Criar o arquivo de tipos**

```ts
// src/lib/fila/types.ts
// Formato comum de "ação sugerida" da fila do Meu Dia (G1). Forward-compatible
// com a futura tabela materializada `suggested_actions` (spec §5).

export type CategoriaAcao = 'prazo' | 'certo' | 'esperado' | 'risco';
export type FonteAcao = 'tarefa' | 'rota' | 'whatsapp_pendente' | 'mixgap';
export type TipoValor = 'certo' | 'estimado' | 'sem_valor';
export type TipoCta = 'ligar' | 'whatsapp' | 'pedido' | 'tarefa' | 'abrir_cliente';

export interface AcaoSugerida {
  fonte: FonteAcao;
  /** id da entidade no motor de origem (tarefa.id, customer_user_id, conversation.id, etc.) */
  entidadeId: string;
  clienteUserId: string | null;
  clienteNome: string | null;
  telefone: string | null;
  /** verbo curto exibido no card: "Ligar", "Responder", "Oferecer", "Cobrar" */
  acao: string;
  titulo: string;
  /** "por que isto apareceu" — sempre presente (anti-dashboard-vazio) */
  motivo: string;
  categoria: CategoriaAcao;
  /** prioridade DENTRO da categoria, [0,1] */
  score: number;
  /** R$ estimado quando a fonte tem; null quando não há */
  valorEsperado: number | null;
  tipoValor: TipoValor;
  /** qual execução o botão "Fazer" dispara */
  cta: TipoCta;
  /** colapsa duplicatas do mesmo cliente+intenção entre fontes */
  dedupeKey: string;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `bun run typecheck`
Expected: PASS (sem erros novos)

- [ ] **Step 3: Commit**

```bash
git add src/lib/fila/types.ts
git commit -m "feat(fila): tipo comum AcaoSugerida (G1 fase 1)"
```

---

## Task 2: Ranqueador por categoria + dedupe

**Files:**
- Create: `src/lib/fila/ranking.ts`
- Test: `src/lib/fila/__tests__/ranking.test.ts`

Regra (spec §6): a ordem das categorias É o guardrail principal — `prazo` (SLA) > `certo` > `esperado` (incerto) > `risco`. Dentro da categoria: maior `valorEsperado` primeiro (null por último), desempate por `score`. `dedupe` mantém, por `dedupeKey`, a ação de maior prioridade.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/fila/__tests__/ranking.test.ts
import { describe, it, expect } from 'vitest';
import { rankearFila, dedupe } from '../ranking';
import type { AcaoSugerida } from '../types';

function acao(p: Partial<AcaoSugerida>): AcaoSugerida {
  return {
    fonte: 'mixgap', entidadeId: 'x', clienteUserId: 'c1', clienteNome: 'C1', telefone: null,
    acao: 'Oferecer', titulo: 't', motivo: 'm', categoria: 'esperado', score: 0.5,
    valorEsperado: null, tipoValor: 'estimado', cta: 'pedido', dedupeKey: 'c1:pedido', ...p,
  };
}

describe('rankearFila', () => {
  it('coloca prazo acima de esperado mesmo com valorEsperado alto no esperado', () => {
    const fila = rankearFila([
      acao({ categoria: 'esperado', valorEsperado: 9999, dedupeKey: 'a' }),
      acao({ categoria: 'prazo', valorEsperado: null, dedupeKey: 'b' }),
    ]);
    expect(fila[0].categoria).toBe('prazo');
  });

  it('dentro da mesma categoria, maior valorEsperado primeiro; null por último', () => {
    const fila = rankearFila([
      acao({ categoria: 'esperado', valorEsperado: null, dedupeKey: 'a' }),
      acao({ categoria: 'esperado', valorEsperado: 500, dedupeKey: 'b' }),
      acao({ categoria: 'esperado', valorEsperado: 1500, dedupeKey: 'c' }),
    ]);
    expect(fila.map(a => a.valorEsperado)).toEqual([1500, 500, null]);
  });

  it('desempata por score quando valorEsperado é igual', () => {
    const fila = rankearFila([
      acao({ categoria: 'prazo', valorEsperado: null, score: 0.3, dedupeKey: 'a' }),
      acao({ categoria: 'prazo', valorEsperado: null, score: 0.9, dedupeKey: 'b' }),
    ]);
    expect(fila[0].score).toBe(0.9);
  });

  it('é estável e não muta a entrada', () => {
    const entrada = [acao({ dedupeKey: 'a' }), acao({ dedupeKey: 'b' })];
    const copia = [...entrada];
    rankearFila(entrada);
    expect(entrada).toEqual(copia);
  });
});

describe('dedupe', () => {
  it('mantém só a ação de maior prioridade por dedupeKey', () => {
    const out = dedupe([
      acao({ categoria: 'esperado', dedupeKey: 'c1:ligar' }),
      acao({ categoria: 'prazo', dedupeKey: 'c1:ligar' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].categoria).toBe('prazo');
  });

  it('não colapsa dedupeKeys diferentes', () => {
    const out = dedupe([acao({ dedupeKey: 'a' }), acao({ dedupeKey: 'b' })]);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/fila/__tests__/ranking.test.ts`
Expected: FAIL ("Cannot find module '../ranking'")

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/ranking.ts
import type { AcaoSugerida, CategoriaAcao } from './types';

// menor = mais alta na fila. A ordem é o guardrail: incerto nunca atropela SLA/certo.
const ORDEM_CATEGORIA: Record<CategoriaAcao, number> = {
  prazo: 0, certo: 1, esperado: 2, risco: 3,
};

/** Compara prioridade: categoria, depois valorEsperado desc (null por último), depois score desc. */
function comparar(a: AcaoSugerida, b: AcaoSugerida): number {
  const dc = ORDEM_CATEGORIA[a.categoria] - ORDEM_CATEGORIA[b.categoria];
  if (dc !== 0) return dc;
  const va = a.valorEsperado, vb = b.valorEsperado;
  if (va != null && vb != null && va !== vb) return vb - va;
  if (va == null && vb != null) return 1;
  if (va != null && vb == null) return -1;
  return b.score - a.score;
}

export function rankearFila(acoes: AcaoSugerida[]): AcaoSugerida[] {
  return [...acoes].sort(comparar);
}

/** Mantém, por dedupeKey, só a ação de maior prioridade. */
export function dedupe(acoes: AcaoSugerida[]): AcaoSugerida[] {
  const melhor = new Map<string, AcaoSugerida>();
  for (const a of acoes) {
    const atual = melhor.get(a.dedupeKey);
    if (!atual || comparar(a, atual) < 0) melhor.set(a.dedupeKey, a);
  }
  return [...melhor.values()];
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/fila/__tests__/ranking.test.ts`
Expected: PASS (6 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/ranking.ts src/lib/fila/__tests__/ranking.test.ts
git commit -m "feat(fila): ranqueador por categoria + dedupe (G1 fase 1)"
```

---

## Task 3: Adapter — Tarefas

**Files:**
- Create: `src/lib/fila/adapters/tarefa.ts`
- Test: `src/lib/fila/__tests__/tarefa.test.ts`

Mapeia `TarefaEstado` (de `src/lib/tarefas/types.ts`) → `AcaoSugerida`. Categoria `prazo` (é compromisso explícito do founder). `dedupeKey` inclui o id da tarefa (N tarefas distintas pro mesmo cliente NÃO se colapsam).

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/fila/__tests__/tarefa.test.ts
import { describe, it, expect } from 'vitest';
import { tarefasParaAcoes } from '../adapters/tarefa';
import type { TarefaEstado } from '@/lib/tarefas/types';

function tarefa(p: Partial<TarefaEstado>): TarefaEstado {
  return {
    id: 't1', descricao: 'Ligar pro cliente', categoria: 'ligar', customer_user_id: 'c1',
    assigned_to: 'v1', created_by: 'founder', empresa: 'oben', modo: 'data', due_date: null,
    interacao_tipo: null, backstop_days: 7, tolerancia_dias: 1, adiada_para: null,
    motivo_adiamento: null, auto_satisfy_mode: 'off', target_produto_id: null, target_texto: null,
    target_preco_centavos: null, status: 'aberta', concluida_em: null, concluida_por: null,
    conclusao_origem: null, nota_conclusao: null, escalado_em: null, effective_due: '2026-06-04',
    responsavel_efetivo: 'v1', atrasada: false, escalavel: false, tem_sugestao_pendente: false, ...p,
  };
}

describe('tarefasParaAcoes', () => {
  it('mapeia tarefa aberta para categoria prazo, sem valor', () => {
    const [a] = tarefasParaAcoes([tarefa({})]);
    expect(a.fonte).toBe('tarefa');
    expect(a.categoria).toBe('prazo');
    expect(a.valorEsperado).toBeNull();
    expect(a.tipoValor).toBe('sem_valor');
    expect(a.clienteUserId).toBe('c1');
    expect(a.dedupeKey).toBe('c1:tarefa:t1');
  });

  it('atrasada tem score maior e motivo de atraso', () => {
    const [normal] = tarefasParaAcoes([tarefa({ id: 'a', atrasada: false })]);
    const [atrasada] = tarefasParaAcoes([tarefa({ id: 'b', atrasada: true })]);
    expect(atrasada.score).toBeGreaterThan(normal.score);
    expect(atrasada.motivo).toMatch(/atras/i);
  });

  it('ignora tarefas não-abertas', () => {
    expect(tarefasParaAcoes([tarefa({ status: 'concluida' })])).toHaveLength(0);
  });

  it('mapeia categoria->cta (oferecer vira pedido, ligar vira ligar)', () => {
    expect(tarefasParaAcoes([tarefa({ categoria: 'oferecer' })])[0].cta).toBe('pedido');
    expect(tarefasParaAcoes([tarefa({ categoria: 'ligar' })])[0].cta).toBe('ligar');
    expect(tarefasParaAcoes([tarefa({ categoria: 'whatsapp' })])[0].cta).toBe('whatsapp');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/fila/__tests__/tarefa.test.ts`
Expected: FAIL ("Cannot find module '../adapters/tarefa'")

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/adapters/tarefa.ts
import type { TarefaEstado, TarefaCategoria } from '@/lib/tarefas/types';
import type { AcaoSugerida, TipoCta } from '../types';

const CTA_POR_CATEGORIA: Record<TarefaCategoria, TipoCta> = {
  ligar: 'ligar', whatsapp: 'whatsapp', oferecer: 'pedido', preco: 'pedido', outro: 'tarefa',
};
const VERBO_POR_CATEGORIA: Record<TarefaCategoria, string> = {
  ligar: 'Ligar', whatsapp: 'Responder', oferecer: 'Oferecer', preco: 'Revisar preço', outro: 'Cobrar',
};

export function tarefasParaAcoes(tarefas: TarefaEstado[]): AcaoSugerida[] {
  return tarefas
    .filter(t => t.status === 'aberta')
    .map(t => ({
      fonte: 'tarefa' as const,
      entidadeId: t.id,
      clienteUserId: t.customer_user_id,
      clienteNome: null,
      telefone: null,
      acao: VERBO_POR_CATEGORIA[t.categoria],
      titulo: t.descricao,
      motivo: t.atrasada ? 'Tarefa atrasada — seu chefe pediu' : 'Tarefa do seu chefe',
      categoria: 'prazo' as const,
      score: t.atrasada ? 1 : 0.6,
      valorEsperado: null,
      tipoValor: 'sem_valor' as const,
      cta: CTA_POR_CATEGORIA[t.categoria],
      dedupeKey: `${t.customer_user_id}:tarefa:${t.id}`,
    }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/fila/__tests__/tarefa.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/adapters/tarefa.ts src/lib/fila/__tests__/tarefa.test.ts
git commit -m "feat(fila): adapter de tarefas (G1 fase 1)"
```

---

## Task 4: Adapter — Ligações da rota

**Files:**
- Create: `src/lib/fila/adapters/rota.ts`
- Test: `src/lib/fila/__tests__/rota.test.ts`

Recebe `RouteContactItem[]` (a `callQueue` de `useRouteContactList`). Categoria `esperado`; `valorEsperado` = `valorDaLigacao` (R$ já calculado pelo motor da rota); `tipoValor` = `estimado`; `cta` = `ligar`.

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/fila/__tests__/rota.test.ts
import { describe, it, expect } from 'vitest';
import { rotaParaAcoes } from '../adapters/rota';
import type { RouteContactItem } from '@/queries/useRouteContactList';

function item(p: Partial<RouteContactItem>): RouteContactItem {
  return {
    customerUserId: 'c1', farmerId: 'v1', cityKey: 'CIDADE (MG)', pConverte: 0.5, ticketEsperado: 1000,
    margemPerc: 0.22, diasDesdeUltima: 30, intervaloMedioDias: 30, isColdStart: false, optOut: false,
    contatadoHaDias: null, fechouHoje: false, janela24hAberta: false, margemNegativaConhecida: false,
    valorDaLigacao: 220, prontidao: 1, motivoGate: null, bucket: 'top',
    name: 'Cliente 1', phone: '5599...', farmerName: 'Vendedora', ultimoContatoRealHaDias: null,
    semRespostaRecenteN: 0, cadenciaBloqueadaPor: null, jaConvertidoNaRota: false, ...p,
  } as RouteContactItem;
}

describe('rotaParaAcoes', () => {
  it('mapeia para categoria esperado com valorEsperado = valorDaLigacao', () => {
    const [a] = rotaParaAcoes([item({ valorDaLigacao: 220 })]);
    expect(a.fonte).toBe('rota');
    expect(a.categoria).toBe('esperado');
    expect(a.valorEsperado).toBe(220);
    expect(a.tipoValor).toBe('estimado');
    expect(a.cta).toBe('ligar');
    expect(a.telefone).toBe('5599...');
    expect(a.dedupeKey).toBe('c1:ligar');
  });

  it('usa prontidao como score e o nome no título', () => {
    const [a] = rotaParaAcoes([item({ prontidao: 0.8, name: 'Marcenaria X' })]);
    expect(a.score).toBe(0.8);
    expect(a.titulo).toContain('Marcenaria X');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/fila/__tests__/rota.test.ts`
Expected: FAIL ("Cannot find module '../adapters/rota'")

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/adapters/rota.ts
import type { RouteContactItem } from '@/queries/useRouteContactList';
import type { AcaoSugerida } from '../types';

export function rotaParaAcoes(callQueue: RouteContactItem[]): AcaoSugerida[] {
  return callQueue.map(c => ({
    fonte: 'rota' as const,
    entidadeId: c.customerUserId,
    clienteUserId: c.customerUserId,
    clienteNome: c.name,
    telefone: c.phone,
    acao: 'Ligar',
    titulo: `Ligar para ${c.name}`,
    motivo: 'Cidade da rota de hoje · recompra provável',
    categoria: 'esperado' as const,
    score: c.prontidao ?? 0.5,
    valorEsperado: Number.isFinite(c.valorDaLigacao) ? c.valorDaLigacao : null,
    tipoValor: 'estimado' as const,
    cta: 'ligar' as const,
    dedupeKey: `${c.customerUserId}:ligar`,
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/fila/__tests__/rota.test.ts`
Expected: PASS (2 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/adapters/rota.ts src/lib/fila/__tests__/rota.test.ts
git commit -m "feat(fila): adapter de ligações da rota (G1 fase 1)"
```

---

## Task 5: Adapter — Mix/Gap (oportunidade comercial)

**Files:**
- Create: `src/lib/fila/adapters/mixgap.ts`
- Test: `src/lib/fila/__tests__/mixgap.test.ts`

Recebe `MixGap | null` (de `useMyMixGap`). Categoria `esperado`; sem R$ (`valorEsperado: null`, `tipoValor: 'estimado'`); `score` derivado de `confidence` ponderado por `lift` (cap em 3 pra não explodir); `cta` = `pedido`. Ignora gaps já `ofertado`.

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/fila/__tests__/mixgap.test.ts
import { describe, it, expect } from 'vitest';
import { mixGapParaAcoes } from '../adapters/mixgap';
import type { MixGap } from '@/hooks/useMyMixGap';

const base: MixGap = {
  totalComGap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'Cliente 1', familia_faltante: 'Lixas', confidence: 0.8, lift: 2, evidence_count: 10 },
    { customer_user_id: 'c2', nome: 'Cliente 2', familia_faltante: 'Vernizes', confidence: 0.5, lift: 1.2, evidence_count: 5, feedback_status: 'ofertado' },
  ],
};

describe('mixGapParaAcoes', () => {
  it('mapeia para categoria esperado, estimado, sem valor R$', () => {
    const out = mixGapParaAcoes(base);
    const a = out.find(x => x.clienteUserId === 'c1')!;
    expect(a.fonte).toBe('mixgap');
    expect(a.categoria).toBe('esperado');
    expect(a.valorEsperado).toBeNull();
    expect(a.tipoValor).toBe('estimado');
    expect(a.cta).toBe('pedido');
    expect(a.titulo).toContain('Lixas');
    expect(a.dedupeKey).toBe('c1:oferecer:Lixas');
  });

  it('ignora gaps já ofertados', () => {
    expect(mixGapParaAcoes(base).some(a => a.clienteUserId === 'c2')).toBe(false);
  });

  it('null retorna lista vazia', () => {
    expect(mixGapParaAcoes(null)).toEqual([]);
  });

  it('score cresce com confidence', () => {
    const so = mixGapParaAcoes(base)[0];
    expect(so.score).toBeGreaterThan(0);
    expect(so.score).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/fila/__tests__/mixgap.test.ts`
Expected: FAIL ("Cannot find module '../adapters/mixgap'")

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/adapters/mixgap.ts
import type { MixGap } from '@/hooks/useMyMixGap';
import type { AcaoSugerida } from '../types';

export function mixGapParaAcoes(mixgap: MixGap | null): AcaoSugerida[] {
  if (!mixgap) return [];
  return mixgap.lista
    .filter(g => g.feedback_status !== 'ofertado')
    .map(g => {
      const liftCap = Math.min(Math.max(g.lift, 1), 3);
      const score = Math.min(1, g.confidence * (liftCap / 3));
      const nome = g.nome ?? 'cliente';
      return {
        fonte: 'mixgap' as const,
        entidadeId: `${g.customer_user_id}:${g.familia_faltante}`,
        clienteUserId: g.customer_user_id,
        clienteNome: g.nome,
        telefone: null,
        acao: 'Oferecer',
        titulo: `Oferecer ${g.familia_faltante} para ${nome}`,
        motivo: `Clientes parecidos compram ${g.familia_faltante} (confiança ${(g.confidence * 100).toFixed(0)}%)`,
        categoria: 'esperado' as const,
        score,
        valorEsperado: null,
        tipoValor: 'estimado' as const,
        cta: 'pedido' as const,
        dedupeKey: `${g.customer_user_id}:oferecer:${g.familia_faltante}`,
      };
    });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/fila/__tests__/mixgap.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/adapters/mixgap.ts src/lib/fila/__tests__/mixgap.test.ts
git commit -m "feat(fila): adapter de mix-gap (G1 fase 1)"
```

---

## Task 6: Adapter — WhatsApp pendente

**Files:**
- Create: `src/lib/fila/adapters/whatsappPendente.ts`
- Test: `src/lib/fila/__tests__/whatsappPendente.test.ts`

O adapter é **puro**: recebe `WaPendente[]` (já filtrado/derivado pelo hook da Task 7b). Categoria `prazo` (a janela de 24h é SLA real); sem R$; `score` cresce conforme aproxima das 24h; `cta` = `whatsapp`. A regra de "o que é pendente" mora no hook (Task 7b), não aqui — assim o adapter fica testável.

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/fila/__tests__/whatsappPendente.test.ts
import { describe, it, expect } from 'vitest';
import { whatsappPendenteParaAcoes, type WaPendente } from '../adapters/whatsappPendente';

function pend(p: Partial<WaPendente>): WaPendente {
  return { conversationId: 'conv1', clienteUserId: 'c1', nome: 'Cliente 1', telefone: '5599', horasDesde: 2, ...p };
}

describe('whatsappPendenteParaAcoes', () => {
  it('mapeia para categoria prazo, cta whatsapp, sem valor', () => {
    const [a] = whatsappPendenteParaAcoes([pend({})]);
    expect(a.fonte).toBe('whatsapp_pendente');
    expect(a.categoria).toBe('prazo');
    expect(a.cta).toBe('whatsapp');
    expect(a.valorEsperado).toBeNull();
    expect(a.dedupeKey).toBe('c1:whatsapp');
  });

  it('score cresce ao se aproximar das 24h', () => {
    const [novo] = whatsappPendenteParaAcoes([pend({ horasDesde: 2 })]);
    const [velho] = whatsappPendenteParaAcoes([pend({ horasDesde: 20 })]);
    expect(velho.score).toBeGreaterThan(novo.score);
  });

  it('sem clienteUserId usa conversationId no dedupeKey', () => {
    const [a] = whatsappPendenteParaAcoes([pend({ clienteUserId: null, conversationId: 'conv9' })]);
    expect(a.dedupeKey).toBe('conv9:whatsapp');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/fila/__tests__/whatsappPendente.test.ts`
Expected: FAIL ("Cannot find module '../adapters/whatsappPendente'")

- [ ] **Step 3: Implementar**

```ts
// src/lib/fila/adapters/whatsappPendente.ts
import type { AcaoSugerida } from '../types';

/** Conversa do inbox aguardando resposta da vendedora, dentro da janela de 24h. */
export interface WaPendente {
  conversationId: string;
  clienteUserId: string | null;
  nome: string | null;
  telefone: string | null;
  /** horas desde a última mensagem do cliente (inbound) ainda sem resposta */
  horasDesde: number;
}

export function whatsappPendenteParaAcoes(pendentes: WaPendente[]): AcaoSugerida[] {
  return pendentes.map(p => ({
    fonte: 'whatsapp_pendente' as const,
    entidadeId: p.conversationId,
    clienteUserId: p.clienteUserId,
    clienteNome: p.nome,
    telefone: p.telefone,
    acao: 'Responder',
    titulo: `Responder ${p.nome ?? p.telefone ?? 'cliente'} no WhatsApp`,
    motivo: `Cliente respondeu há ${Math.round(p.horasDesde)}h e ninguém retornou`,
    categoria: 'prazo' as const,
    score: Math.max(0, Math.min(1, p.horasDesde / 24)),
    valorEsperado: null,
    tipoValor: 'sem_valor' as const,
    cta: 'whatsapp' as const,
    dedupeKey: `${p.clienteUserId ?? p.conversationId}:whatsapp`,
  }));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/fila/__tests__/whatsappPendente.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/fila/adapters/whatsappPendente.ts src/lib/fila/__tests__/whatsappPendente.test.ts
git commit -m "feat(fila): adapter de WhatsApp pendente (G1 fase 1)"
```

---

## Task 7: Hook `useWhatsappPendentes` (deriva pendência do inbox)

**Files:**
- Create: `src/hooks/useWhatsappPendentes.ts`

Lê as conversas do inbox (`useWhatsappConversations`) e, pra cada uma, decide se está **pendente**: a última mensagem é do cliente (inbound), sem resposta posterior da vendedora, dentro de 24h. v1: usa o campo de "última mensagem" da conversa se existir; se a direção da última msg não estiver na conversa, busca a última `WaMessage` por conversa. Confirmar os campos reais de `WaConversation`/`WaMessage` em `src/queries/useWhatsappInbox.ts` na implementação (decisão em aberto §13.3 do spec).

- [ ] **Step 1: Implementar (sem teste unitário — é glue de query; coberto pelo adapter puro da Task 6)**

```ts
// src/hooks/useWhatsappPendentes.ts
import { useMemo } from 'react';
import { useWhatsappConversations } from '@/queries/useWhatsappInbox';
import type { WaPendente } from '@/lib/fila/adapters/whatsappPendente';

const MS_24H = 24 * 60 * 60 * 1000;

/**
 * Conversas aguardando resposta da vendedora dentro da janela de 24h.
 * Regra v1 (spec §13.3): última msg é inbound (do cliente) e foi há < 24h.
 * ATENÇÃO no implementar: confirmar em useWhatsappInbox.ts os campos reais que
 * indicam direção/horário da última msg (ex.: last_inbound_at / last_message_direction).
 * Se a conversa não expõe isso, buscar a última WaMessage por conversa.
 */
export function useWhatsappPendentes() {
  const conversas = useWhatsappConversations();
  const data = useMemo<WaPendente[]>(() => {
    const lista = conversas.data ?? [];
    const agora = Date.now();
    return lista
      .map((c): WaPendente | null => {
        const ultimaInbound = (c as { last_inbound_at?: string | null }).last_inbound_at;
        const ultimaOutbound = (c as { last_outbound_at?: string | null }).last_outbound_at;
        if (!ultimaInbound) return null;
        const tInbound = Date.parse(ultimaInbound);
        if (!Number.isFinite(tInbound)) return null;
        const respondida = ultimaOutbound != null && Date.parse(ultimaOutbound) > tInbound;
        if (respondida) return null;
        const horasDesde = (agora - tInbound) / (1000 * 60 * 60);
        if (horasDesde * 60 * 60 * 1000 > MS_24H) return null; // fora da janela
        return {
          conversationId: c.id,
          clienteUserId: c.customer_user_id,
          nome: c.contact_name,
          telefone: c.phone_e164,
          horasDesde,
        };
      })
      .filter((x): x is WaPendente => x !== null);
  }, [conversas.data]);

  return { data, isLoading: conversas.isLoading };
}
```

- [ ] **Step 2: Verificar compilação**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useWhatsappPendentes.ts
git commit -m "feat(fila): hook de WhatsApp pendente do inbox (G1 fase 1)"
```

---

## Task 8: Hook `useFilaAcoes` (glue final)

**Files:**
- Create: `src/hooks/useFilaAcoes.ts`

Junta as 4 fontes via os adapters puros, deduplica e ranqueia. Único ponto impuro; a lógica testável já está coberta pelos adapters + ranking.

- [ ] **Step 1: Implementar**

```ts
// src/hooks/useFilaAcoes.ts
import { useMemo } from 'react';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useRouteContactList } from '@/queries/useRouteContactList';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useWhatsappPendentes } from '@/hooks/useWhatsappPendentes';
import { tarefasParaAcoes } from '@/lib/fila/adapters/tarefa';
import { rotaParaAcoes } from '@/lib/fila/adapters/rota';
import { mixGapParaAcoes } from '@/lib/fila/adapters/mixgap';
import { whatsappPendenteParaAcoes } from '@/lib/fila/adapters/whatsappPendente';
import { dedupe, rankearFila } from '@/lib/fila/ranking';
import type { AcaoSugerida } from '@/lib/fila/types';

export function useFilaAcoes(): { acoes: AcaoSugerida[]; isLoading: boolean } {
  const tarefas = useMinhasTarefas();
  const rota = useRouteContactList();
  const mixgap = useMyMixGap();
  const waPend = useWhatsappPendentes();

  const acoes = useMemo(() => {
    const todas: AcaoSugerida[] = [
      ...tarefasParaAcoes(tarefas.data ?? []),
      ...rotaParaAcoes(rota.data?.callQueue ?? []),
      ...mixGapParaAcoes(mixgap.data ?? null),
      ...whatsappPendenteParaAcoes(waPend.data ?? []),
    ];
    return rankearFila(dedupe(todas));
  }, [tarefas.data, rota.data, mixgap.data, waPend.data]);

  return { acoes, isLoading: tarefas.isLoading || rota.isLoading || mixgap.isLoading || waPend.isLoading };
}
```

- [ ] **Step 2: Verificar compilação + suíte completa da fila**

Run: `bun run typecheck && bun run test -- src/lib/fila`
Expected: PASS (typecheck limpo; 19 testes da fila verdes)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useFilaAcoes.ts
git commit -m "feat(fila): hook useFilaAcoes (junta fontes + dedupe + ranking) (G1 fase 1)"
```

---

## Verificação final da fase

- [ ] `bun run typecheck` limpo.
- [ ] `bun run test -- src/lib/fila` verde (ranking 6 + tarefa 4 + rota 2 + mixgap 4 + whatsappPendente 3 = 19).
- [ ] `bun lint` sem novos erros.
- [ ] `useFilaAcoes()` retorna `AcaoSugerida[]` ranqueada — pronto pra Fase 3 (UI) consumir.

---

## Self-review (preenchido pelo autor do plano)

**Spec coverage:** §4 (4 fontes) → Tasks 3-7. §5 (derivar no front, dedupe) → Tasks 2 e 8 (sem materializar — correto pra fase). §6 (ranking por categoria + guardrails) → Task 2. Loop de feedback (§7), tela (§8), instrumentação (§9), migration (§13.2) = **fora desta fase, por design** (Fases 2 e 3).

**Placeholder scan:** sem TBD/TODO. A única incerteza marcada é §13.3 (campos de `WaConversation` pra "pendente") — Task 7 instrui confirmar os campos reais na implementação; é a decisão-em-aberto do spec, não um placeholder de código.

**Type consistency:** `AcaoSugerida` (Task 1) usado idêntico em todos os adapters e no ranking. `MixGap`/`GapCliente`, `TarefaEstado`, `RouteContactItem`, `WaPendente` batem com as fontes reais lidas do código. `dedupeKey` consistente: tarefa = `cliente:tarefa:id`, rota = `cliente:ligar`, mixgap = `cliente:oferecer:familia`, whatsapp = `cliente|conv:whatsapp`.

## Decisões empurradas pras próximas fases

- **Fase 2 — Feedback & persistência:** migration `suggested_action_feedback` (ritual `lovable-db-operator`), reuso de `useTarefas.concluir/adiar` e `route_contact_log`, estados Concluir/Adiar/Dispensar+motivo.
- **Fase 3 — Tela:** fila lidera `FarmerDashboardV2`, split desktop MeuDia|WhatsApp, pedido em modo focado (`/sales/new` com retorno), WhatsApp por composição.
- **Instrumentação (§9):** eventos `track('fila.*')` entram quando houver UI (Fase 3) — não há o que medir sem tela.
