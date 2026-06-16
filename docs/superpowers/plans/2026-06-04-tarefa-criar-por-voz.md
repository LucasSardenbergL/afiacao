# Criar tarefa por voz — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O founder grava um áudio em pt-BR descrevendo tarefas pras vendedoras; o app transcreve, uma IA estrutura numa lista de tarefas, o founder revisa/corrige (cliente, vendedora, prazo) e cria — zero auto-criação.

**Architecture:** A IA (`tarefa-extrair-voz`, Anthropic tool-use) faz só **extração semântica + split** e devolve **strings cruas** (nome falado do cliente/vendedora, frase de data, categoria-palpite, evidence_text). Toda decisão determinística sai da IA: **datas** via parser pt-BR próprio ancorado em hoje-SP; **cliente/vendedora** via match local com limiar + ambiguidade explícita; **validação** dura no save. Transcrição reusa a edge `elevenlabs-transcribe`. Criação reusa `criarTarefas` (batch).

**Tech Stack:** React 18 + TS + Vite, Supabase edge (Deno) + Anthropic SDK (`claude-sonnet-4-6`, tool-use), vitest (TDD nos helpers puros), sonner, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-06-04-tarefa-criar-por-voz-design.md`

> ⚠️ **Migration:** nenhuma (a feature reusa as tabelas existentes; o evento de auditoria usa `tarefa_eventos`, que já existe).
> ⚠️ **Deploy manual:** a edge nova `tarefa-extrair-voz` precisa ser criada via **chat do Lovable** (depois do merge). Sem secret novo (reusa `ANTHROPIC_API_KEY`, já configurada — usada pelo `claude-spin-analyze`).

---

## File Structure

**Helpers puros (TDD, `src/lib/tarefas/voz/`):**
- `types.ts` — contratos (saída da IA, rascunho, status). Sem teste (só tipos).
- `date-parser.ts` (+ `__tests__/date-parser.test.ts`) — `resolverDataPtBr`.
- `match.ts` (+ `__tests__/match.test.ts`) — `normalizarNome`, `scoreNome`, `casarCliente`, `casarVendedora`.
- `montar-rascunhos.ts` (+ `__tests__/montar-rascunhos.test.ts`) — `montarRascunhos` (orquestra data + vendedora; cliente fica p/ a UI resolver async).
- `validacao.ts` (+ `__tests__/validacao.test.ts`) — `validarRascunho`.

**Edge (Deno):**
- `supabase/functions/tarefa-extrair-voz/index.ts` — Anthropic tool-use, gate master/gestor.

**Frontend:**
- `src/hooks/useBuscaClienteOmie.ts` — busca+resolve de cliente Omie (extraído de `Tarefas.tsx`, usado nos 2 lugares).
- `src/hooks/useGravacaoTranscricao.ts` — grava (MediaRecorder) + transcreve (`elevenlabs-transcribe`).
- `src/components/tarefas/VozTarefaDialog.tsx` — o dialog (grava → transcreve → extrai → rascunhos editáveis com status → salva).
- `src/hooks/useTarefas.ts` (modificar) — `criarTarefas` retorna os ids inseridos + grava evento de auditoria opcional `criada_por_voz`.
- `src/pages/Tarefas.tsx` (modificar) — botão "🎙️ Criar por voz" + render do dialog; migrar a busca de cliente pro hook novo.

---

## Task 1: Tipos do fluxo de voz

**Files:**
- Create: `src/lib/tarefas/voz/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
// src/lib/tarefas/voz/types.ts
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '../types';

/** Saída CRUA da IA (edge tarefa-extrair-voz) — só strings; NUNCA ids ou datas resolvidas. */
export interface TarefaExtraidaIA {
  evidence_text: string;
  descricao: string;
  categoria_palpite: TarefaCategoria | null;
  cliente_nome_falado: string | null;
  vendedora_nome_falado: string | null;
  raw_date_text: string | null;
  target_texto: string | null;
}

export interface ExtracaoVozIA {
  detectei_n: number;
  texto_nao_coberto: string | null;
  tarefas: TarefaExtraidaIA[];
}

export type StatusData = 'sem_data' | 'resolvida' | 'ambigua' | 'nao_resolvida' | 'passado';
export interface ResultadoData {
  modo: TarefaModo;
  due_date: string | null;          // yyyy-mm-dd
  interacao_tipo: TarefaInteracaoTipo | null;
  status: StatusData;
}

export type StatusMatch = 'unico' | 'ambiguo' | 'sem_match';

export interface ClienteCandidato {
  customer_user_id: string;   // '' se ainda não resolvido (cliente Omie sem perfil local)
  nome: string;
}
export interface MatchCliente {
  customer_user_id: string | null;
  nome: string | null;
  status: StatusMatch;
  candidatos: ClienteCandidato[];
}

export interface VendedoraOpcao { user_id: string; nome: string; }
export interface MatchVendedora {
  user_id: string | null;
  nome: string | null;
  status: StatusMatch;
}

/** 1 card editável na revisão. */
export interface RascunhoVoz {
  evidence_text: string;
  descricao: string;
  categoria: TarefaCategoria;          // default 'outro' se a IA não cravou
  cliente_nome_falado: string | null;
  cliente: MatchCliente | null;        // null até a busca async rodar
  vendedora: MatchVendedora;
  data: ResultadoData;
  target_texto: string | null;
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS (sem erro novo).

- [ ] **Step 3: Commit**

```bash
git add src/lib/tarefas/voz/types.ts
git commit -m "feat(tarefas-voz): tipos do fluxo de criar tarefa por voz"
```

---

## Task 2: Parser de data relativa pt-BR (`resolverDataPtBr`)

**Files:**
- Create: `src/lib/tarefas/voz/date-parser.ts`
- Test: `src/lib/tarefas/voz/__tests__/date-parser.test.ts`

> Decisões (do spec §7): `hoje` conta pra dia-da-semana ("sexta" numa sexta = hoje); "X que vem" = +7 sobre a próxima ocorrência; "dia N" rola pro próximo mês se já passou (sempre futuro); "semana/mês que vem" SEM dia = `ambigua` (não chuta); frase de data não-reconhecida = `nao_resolvida`; sem frase = `sem_data` (→ próxima interação).

- [ ] **Step 1: Escrever o teste (falha)**

```ts
// src/lib/tarefas/voz/__tests__/date-parser.test.ts
import { describe, it, expect } from 'vitest';
import { resolverDataPtBr } from '../date-parser';

const QUI = '2026-06-04'; // quinta-feira
const SEX = '2026-06-05'; // sexta-feira

describe('resolverDataPtBr', () => {
  it('sem frase → sem_data, próxima interação (ligação)', () => {
    expect(resolverDataPtBr(null, QUI)).toEqual({ modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' });
    expect(resolverDataPtBr('   ', QUI).status).toBe('sem_data');
  });

  it('hoje / amanhã / depois de amanhã', () => {
    expect(resolverDataPtBr('hoje', QUI)).toMatchObject({ due_date: '2026-06-04', status: 'resolvida', modo: 'data' });
    expect(resolverDataPtBr('amanhã', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('amanha', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('depois de amanhã', QUI).due_date).toBe('2026-06-06');
  });

  it('dia da semana — quinta falando sexta → próxima sexta (06-05)', () => {
    expect(resolverDataPtBr('sexta', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('sexta-feira', QUI).due_date).toBe('2026-06-05');
  });

  it('"sexta que vem" → +7 sobre a próxima sexta (06-12)', () => {
    expect(resolverDataPtBr('sexta que vem', QUI).due_date).toBe('2026-06-12');
  });

  it('"hoje conta": sexta falando "sexta" → hoje', () => {
    expect(resolverDataPtBr('sexta', SEX).due_date).toBe('2026-06-05');
  });

  it('segunda / segunda da semana que vem', () => {
    expect(resolverDataPtBr('segunda', QUI).due_date).toBe('2026-06-08');
    expect(resolverDataPtBr('segunda da semana que vem', QUI).due_date).toBe('2026-06-15');
  });

  it('"dia N": futuro neste mês; se já passou, próximo mês', () => {
    expect(resolverDataPtBr('dia 15', QUI).due_date).toBe('2026-06-15');
    expect(resolverDataPtBr('dia 2', QUI).due_date).toBe('2026-07-02'); // 2 < 4 → próximo mês
    expect(resolverDataPtBr('dia 4', QUI)).toMatchObject({ due_date: '2026-06-04', status: 'resolvida' }); // hoje conta, não 'passado'
  });

  it('"dia N" inexistente no mês → clamp ao último dia', () => {
    expect(resolverDataPtBr('dia 31', '2026-09-10').due_date).toBe('2026-09-30'); // setembro tem 30
  });

  it('fim do mês → último dia', () => {
    expect(resolverDataPtBr('fim do mês', QUI).due_date).toBe('2026-06-30');
  });

  it('"semana que vem" / "mês que vem" SEM dia → ambígua (não chuta)', () => {
    expect(resolverDataPtBr('semana que vem', QUI).status).toBe('ambigua');
    expect(resolverDataPtBr('mês que vem', QUI).status).toBe('ambigua');
  });

  it('frase de data não reconhecida → nao_resolvida', () => {
    expect(resolverDataPtBr('quando der', QUI).status).toBe('nao_resolvida');
  });
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/date-parser.test.ts`
Expected: FAIL ("resolverDataPtBr is not a function" / módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// src/lib/tarefas/voz/date-parser.ts
import type { ResultadoData } from './types';

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, dom: 0,
  segunda: 1, seg: 1,
  terca: 2, ter: 2,
  quarta: 3, qua: 3,
  quinta: 4, qui: 4,
  sexta: 5, sex: 5,
  sabado: 6, sab: 6,
};

function normaliza(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
function pad(n: number): string { return String(n).padStart(2, '0'); }
function ymd(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }
function parse(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number);
  return [y, m, d];
}
/** Soma `dias` a uma data yyyy-mm-dd usando aritmética UTC (sem fuso — é data de calendário). */
function addDias(hoje: string, dias: number): string {
  const [y, m, d] = parse(hoje);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function diaDaSemana(hoje: string): number {
  const [y, m, d] = parse(hoje);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function ultimoDiaDoMes(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // dia 0 do mês seguinte = último deste
}

export function resolverDataPtBr(rawDateText: string | null, hojeSP: string): ResultadoData {
  if (!rawDateText || !rawDateText.trim()) {
    return { modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' };
  }
  const t = normaliza(rawDateText);

  const comData = (due: string): ResultadoData => ({
    modo: 'data', due_date: due, interacao_tipo: null,
    status: due < hojeSP ? 'passado' : 'resolvida',
  });
  const ambigua: ResultadoData = { modo: 'data', due_date: null, interacao_tipo: null, status: 'ambigua' };

  if (/\bhoje\b/.test(t)) return comData(hojeSP);
  if (/\bdepois de amanha\b/.test(t)) return comData(addDias(hojeSP, 2));
  if (/\bamanha\b/.test(t)) return comData(addDias(hojeSP, 1));

  for (const [nome, alvo] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nome}(\\b|-feira)`).test(t)) {
      const delta = (alvo - diaDaSemana(hojeSP) + 7) % 7;          // hoje conta (0 se for hoje)
      const queVem = /que vem|proxima|semana que vem/.test(t);
      return comData(addDias(hojeSP, queVem ? delta + 7 : delta));
    }
  }

  const mDia = t.match(/\bdia (\d{1,2})\b/);
  if (mDia) {
    const n = Number(mDia[1]);
    if (n >= 1 && n <= 31) {
      const [y, m, d] = parse(hojeSP);
      let ty = y, tm = m;
      if (n < d) { tm = m === 12 ? 1 : m + 1; ty = m === 12 ? y + 1 : y; }
      const dia = Math.min(n, ultimoDiaDoMes(ty, tm)); // clamp (ex.: dia 31 em mês de 30)
      return comData(ymd(ty, tm, dia));
    }
  }

  if (/fim do mes|final do mes/.test(t)) {
    const [y, m] = parse(hojeSP);
    return comData(ymd(y, m, ultimoDiaDoMes(y, m)));
  }

  if (/semana que vem|mes que vem|proxima semana|proximo mes/.test(t)) return ambigua;

  return { modo: 'data', due_date: null, interacao_tipo: null, status: 'nao_resolvida' };
}
```

- [ ] **Step 4: Rodar (passa)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/date-parser.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tarefas/voz/date-parser.ts src/lib/tarefas/voz/__tests__/date-parser.test.ts
git commit -m "feat(tarefas-voz): parser de data relativa pt-BR (TDD)"
```

---

## Task 3: Match de cliente/vendedora com limiar (`match.ts`)

**Files:**
- Create: `src/lib/tarefas/voz/match.ts`
- Test: `src/lib/tarefas/voz/__tests__/match.test.ts`

> `unico` exige score alto **e** folga sobre o 2º (não auto-resolve top-2 empatados — spec §8). Cliente sem `customer_user_id` resolvido nunca é `unico` (a tarefa precisa do id).

- [ ] **Step 1: Escrever o teste (falha)**

```ts
// src/lib/tarefas/voz/__tests__/match.test.ts
import { describe, it, expect } from 'vitest';
import { normalizarNome, casarCliente, casarVendedora } from '../match';

describe('normalizarNome', () => {
  it('tira acento, caixa, pontuação', () => {
    expect(normalizarNome('Padaria do Zé!')).toBe('padaria do ze');
  });
});

describe('casarVendedora', () => {
  const vends = [{ user_id: 'r', nome: 'Regina Silva' }, { user_id: 't', nome: 'Tatyana Souza' }];
  it('nome exato/primeiro nome → unico', () => {
    expect(casarVendedora('Regina', vends)).toMatchObject({ user_id: 'r', status: 'unico' });
  });
  it('apelido por prefixo (Tati → Tatyana) → unico', () => {
    expect(casarVendedora('Tati', vends)).toMatchObject({ user_id: 't', status: 'unico' });
  });
  it('nome desconhecido → sem_match', () => {
    expect(casarVendedora('Maria', vends).status).toBe('sem_match');
  });
  it('nome falado nulo → sem_match', () => {
    expect(casarVendedora(null, vends).status).toBe('sem_match');
  });
});

describe('casarCliente', () => {
  const cands = [
    { customer_user_id: 'a', nome: 'Padaria do Zé' },
    { customer_user_id: 'b', nome: 'Marmoraria Central' },
  ];
  it('match forte e isolado → unico', () => {
    expect(casarCliente('Padaria do Zé', cands)).toMatchObject({ customer_user_id: 'a', status: 'unico' });
  });
  it('dois candidatos parecidos → ambiguo (não auto-seleciona)', () => {
    const ambg = [
      { customer_user_id: 'a', nome: 'Padaria do Zé' },
      { customer_user_id: 'c', nome: 'Padaria do José' },
    ];
    expect(casarCliente('Padaria do Zé', ambg).status).toBe('ambiguo');
  });
  it('sem candidato → sem_match', () => {
    expect(casarCliente('Padaria do Zé', []).status).toBe('sem_match');
  });
  it('melhor candidato sem user_id resolvido → não é unico (cai pra ambiguo)', () => {
    const semId = [{ customer_user_id: '', nome: 'Padaria do Zé' }];
    expect(casarCliente('Padaria do Zé', semId).status).toBe('ambiguo');
  });
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/match.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar**

```ts
// src/lib/tarefas/voz/match.ts
import type { ClienteCandidato, MatchCliente, MatchVendedora, VendedoraOpcao } from './types';

export function normalizarNome(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Score 0..1 entre nome falado e candidato (token-overlap + prefixo de apelido). */
export function scoreNome(falado: string, candidato: string): number {
  const a = normalizarNome(falado), b = normalizarNome(candidato);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(' '), tb = new Set(b.split(' '));
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const overlap = inter / ta.length;                              // fração dos tokens falados presentes
  const prefixo = ta.some((x) => [...tb].some((y) =>
    (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y)))) ? 0.6 : 0;
  const contido = b.includes(a) || a.includes(b) ? 0.5 : 0;
  return Math.min(1, Math.max(overlap, prefixo, contido));
}

function classificar<T extends { score: number }>(
  ordenados: T[], pisoUnico: number, pisoAmbiguo: number, folga: number,
): 'unico' | 'ambiguo' | 'sem_match' {
  if (ordenados.length === 0 || ordenados[0].score < pisoAmbiguo) return 'sem_match';
  const top = ordenados[0].score;
  const segundo = ordenados[1]?.score ?? 0;
  if (top >= pisoUnico && top - segundo >= folga) return 'unico';
  return 'ambiguo';
}

export function casarVendedora(nomeFalado: string | null, vendedoras: VendedoraOpcao[]): MatchVendedora {
  if (!nomeFalado?.trim()) return { user_id: null, nome: null, status: 'sem_match' };
  const ord = vendedoras.map((v) => ({ ...v, score: scoreNome(nomeFalado, v.nome) }))
    .sort((a, b) => b.score - a.score);
  const status = classificar(ord, 0.5, 0.3, 0.15);
  if (status === 'unico') return { user_id: ord[0].user_id, nome: ord[0].nome, status };
  return { user_id: null, nome: null, status };
}

export function casarCliente(nomeFalado: string | null, candidatos: ClienteCandidato[]): MatchCliente {
  if (!nomeFalado?.trim()) return { customer_user_id: null, nome: null, status: 'sem_match', candidatos };
  const ord = candidatos.map((c) => ({ ...c, score: scoreNome(nomeFalado, c.nome) }))
    .sort((a, b) => b.score - a.score);
  let status = classificar(ord, 0.6, 0.4, 0.2);
  // tarefa exige id resolvido: melhor sem id não pode ser 'unico'
  if (status === 'unico' && !ord[0].customer_user_id) status = 'ambiguo';
  if (status === 'unico') {
    return { customer_user_id: ord[0].customer_user_id, nome: ord[0].nome, status, candidatos: ord };
  }
  return { customer_user_id: null, nome: null, status, candidatos: ord };
}
```

- [ ] **Step 4: Rodar (passa)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tarefas/voz/match.ts src/lib/tarefas/voz/__tests__/match.test.ts
git commit -m "feat(tarefas-voz): match de cliente/vendedora com limiar e ambiguidade (TDD)"
```

---

## Task 4: Validação dura do rascunho (`validacao.ts`)

**Files:**
- Create: `src/lib/tarefas/voz/validacao.ts`
- Test: `src/lib/tarefas/voz/__tests__/validacao.test.ts`

> Regras (spec §10): cliente resolvido; vendedora definida; prazo `sem_data`/`resolvida` (bloqueia ambígua/não-resolvida/passado); `modo=data`⇒`due_date` futura; `modo=interacao`⇒`interacao_tipo`; `oferecer`/`preco`⇒`target_texto`.

- [ ] **Step 1: Escrever o teste (falha)**

```ts
// src/lib/tarefas/voz/__tests__/validacao.test.ts
import { describe, it, expect } from 'vitest';
import { validarRascunho } from '../validacao';
import type { RascunhoVoz } from '../types';

const HOJE = '2026-06-04';
const base: RascunhoVoz = {
  evidence_text: 'liga pro Zé amanhã',
  descricao: 'Ligar pro Zé',
  categoria: 'ligar',
  cliente_nome_falado: 'Zé',
  cliente: { customer_user_id: 'a', nome: 'Padaria do Zé', status: 'unico', candidatos: [] },
  vendedora: { user_id: 'r', nome: 'Regina', status: 'unico' },
  data: { modo: 'data', due_date: '2026-06-05', interacao_tipo: null, status: 'resolvida' },
  target_texto: null,
};

describe('validarRascunho', () => {
  it('rascunho completo → ok', () => {
    expect(validarRascunho(base, HOJE)).toEqual({ ok: true, erros: [] });
  });
  it('sem cliente resolvido → erro', () => {
    const r = { ...base, cliente: { customer_user_id: null, nome: null, status: 'ambiguo' as const, candidatos: [] } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('sem vendedora → erro', () => {
    const r = { ...base, vendedora: { user_id: null, nome: null, status: 'sem_match' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('prazo ambíguo → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: null, interacao_tipo: null, status: 'ambigua' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=data sem due_date → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: null, interacao_tipo: null, status: 'resolvida' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=data com data no passado → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: '2026-06-01', interacao_tipo: null, status: 'resolvida' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=interacao sem interacao_tipo → erro', () => {
    const r = { ...base, data: { modo: 'interacao' as const, due_date: null, interacao_tipo: null, status: 'sem_data' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('oferecer sem target_texto → erro', () => {
    const r = { ...base, categoria: 'oferecer' as const, target_texto: null };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/validacao.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/tarefas/voz/validacao.ts
import type { RascunhoVoz, TarefaCategoria } from './types';

const CATEGORIAS: TarefaCategoria[] = ['ligar', 'oferecer', 'preco', 'whatsapp', 'outro'];

export function validarRascunho(r: RascunhoVoz, hojeSP: string): { ok: boolean; erros: string[] } {
  const erros: string[] = [];

  if (!r.cliente || !r.cliente.customer_user_id) erros.push('Cliente não resolvido.');
  if (!r.vendedora.user_id) erros.push('Escolha a vendedora.');
  if (!r.descricao.trim()) erros.push('Descrição vazia.');
  if (!CATEGORIAS.includes(r.categoria)) erros.push('Categoria inválida.');

  const d = r.data;
  if (d.status === 'ambigua' || d.status === 'nao_resolvida' || d.status === 'passado') {
    erros.push('Confirme o prazo.');
  } else if (d.modo === 'data') {
    if (!d.due_date) erros.push('Data não definida.');
    else if (d.due_date < hojeSP) erros.push('Data no passado.');
  } else if (d.modo === 'interacao' && !d.interacao_tipo) {
    erros.push('Escolha o tipo de interação.');
  }

  if ((r.categoria === 'oferecer' || r.categoria === 'preco') && !r.target_texto?.trim()) {
    erros.push('Informe o item/preço.');
  }

  return { ok: erros.length === 0, erros };
}
```

- [ ] **Step 4: Rodar (passa)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/validacao.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tarefas/voz/validacao.ts src/lib/tarefas/voz/__tests__/validacao.test.ts
git commit -m "feat(tarefas-voz): validação dura do rascunho antes de salvar (TDD)"
```

---

## Task 5: Orquestrador `montarRascunhos` (data + vendedora; cliente fica p/ a UI)

**Files:**
- Create: `src/lib/tarefas/voz/montar-rascunhos.ts`
- Test: `src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts`

> Resolve **data** (parser) e **vendedora** (match na lista, que já temos client-side). **Cliente fica `null`** — a UI faz a busca Omie async por `cliente_nome_falado` e roda `casarCliente`.

- [ ] **Step 1: Escrever o teste (falha)**

```ts
// src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts
import { describe, it, expect } from 'vitest';
import { montarRascunhos } from '../montar-rascunhos';
import type { ExtracaoVozIA } from '../types';

const HOJE = '2026-06-04';
const vends = [{ user_id: 'r', nome: 'Regina Silva' }, { user_id: 't', nome: 'Tatyana Souza' }];

const extracao: ExtracaoVozIA = {
  detectei_n: 2,
  texto_nao_coberto: null,
  tarefas: [
    { evidence_text: 'Regina liga pra Padaria do Zé amanhã', descricao: 'Ligar pra Padaria do Zé', categoria_palpite: 'ligar', cliente_nome_falado: 'Padaria do Zé', vendedora_nome_falado: 'Regina', raw_date_text: 'amanhã', target_texto: null },
    { evidence_text: 'whatsapp pra Maria sexta', descricao: 'WhatsApp pra Maria', categoria_palpite: null, cliente_nome_falado: 'Maria', vendedora_nome_falado: null, raw_date_text: 'sexta', target_texto: null },
  ],
};

describe('montarRascunhos', () => {
  it('resolve data + vendedora; cliente fica null carregando o nome falado', () => {
    const r = montarRascunhos(extracao, { hojeSP: HOJE, vendedoras: vends });
    expect(r).toHaveLength(2);
    expect(r[0].vendedora).toMatchObject({ user_id: 'r', status: 'unico' });
    expect(r[0].data.due_date).toBe('2026-06-05');
    expect(r[0].categoria).toBe('ligar');
    expect(r[0].cliente).toBeNull();
    expect(r[0].cliente_nome_falado).toBe('Padaria do Zé');
    // categoria nula → 'outro'; vendedora não falada → sem_match
    expect(r[1].categoria).toBe('outro');
    expect(r[1].vendedora.status).toBe('sem_match');
    expect(r[1].data.due_date).toBe('2026-06-05');
  });
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/tarefas/voz/montar-rascunhos.ts
import type { ExtracaoVozIA, RascunhoVoz, VendedoraOpcao } from './types';
import { resolverDataPtBr } from './date-parser';
import { casarVendedora } from './match';

export function montarRascunhos(
  extracao: ExtracaoVozIA,
  ctx: { hojeSP: string; vendedoras: VendedoraOpcao[] },
): RascunhoVoz[] {
  return extracao.tarefas.map((t) => ({
    evidence_text: t.evidence_text,
    descricao: t.descricao,
    categoria: t.categoria_palpite ?? 'outro',
    cliente_nome_falado: t.cliente_nome_falado,
    cliente: null, // resolvido async na UI (busca Omie + casarCliente)
    vendedora: casarVendedora(t.vendedora_nome_falado, ctx.vendedoras),
    data: resolverDataPtBr(t.raw_date_text, ctx.hojeSP),
    target_texto: t.target_texto,
  }));
}
```

- [ ] **Step 4: Rodar (passa)**

Run: `heavy bun run test src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tarefas/voz/montar-rascunhos.ts src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts
git commit -m "feat(tarefas-voz): orquestrador montarRascunhos (data + vendedora) (TDD)"
```

---

## Task 6: Edge `tarefa-extrair-voz` (Anthropic tool-use, gate master/gestor)

**Files:**
- Create: `supabase/functions/tarefa-extrair-voz/index.ts`

> Espelha o padrão de `claude-spin-analyze` (Anthropic SDK + tool-use forçada) + o gate master/gestor de `omie-analytics-sync` (`authorizeCronOrStaff` → `pode_ver_carteira_completa({ _uid })`). A IA só extrai strings cruas; não resolve data nem entidade. Sem teste automatizado (edge Deno; validado por deploy + smoke).

- [ ] **Step 1: Implementar a edge**

```ts
// supabase/functions/tarefa-extrair-voz/index.ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você estrutura COMANDOS DE VOZ de um gestor que está criando tarefas para vendedoras de uma distribuidora B2B.

Sua ÚNICA função é entender e SEPARAR as tarefas ditas, e extrair STRINGS CRUAS. Você NÃO resolve datas (não calcule dia/mês), NÃO escolhe ids, NÃO inventa nada.

Regras:
- Um comando pode conter VÁRIAS tarefas (clientes/vendedoras diferentes). Separe cada ação imperativa numa tarefa. Em "manda a Regina ligar pro Zé amanhã e whatsapp pra Maria sexta" há 2 tarefas.
- Para CADA tarefa, preencha:
  - evidence_text: o TRECHO LITERAL da transcrição de onde essa tarefa veio.
  - descricao: o que a vendedora precisa fazer, em 1 frase clara.
  - categoria_palpite: "ligar" (telefonar), "oferecer" (apresentar/oferecer item), "preco" (passar/orçar preço), "whatsapp" (mandar zap/whatsapp), "outro". null se incerto.
  - cliente_nome_falado: o NOME do cliente exatamente como foi dito (string). null se não foi dito.
  - vendedora_nome_falado: o nome da vendedora dito. As vendedoras conhecidas estão no input ("vendedoras"). Se um nome dito casar com uma delas, é a vendedora; outros nomes de pessoa são CLIENTES, não vendedoras. null se nenhuma vendedora foi dita.
  - raw_date_text: a FRASE de tempo exatamente como dita ("amanhã", "sexta que vem", "dia 15", "semana que vem"). NÃO calcule a data. null se nenhum prazo foi dito.
  - target_texto: para "oferecer"/"preco", o item/produto/preço mencionado. null caso contrário.
- detectei_n: quantas tarefas você detectou.
- texto_nao_coberto: qualquer trecho IMPERATIVO da transcrição que você NÃO transformou em tarefa (ou null). Serve para o gestor não perder nada.
- NUNCA invente cliente, vendedora ou data. Se não foi dito, use null.
- SEMPRE chame a tool extrair_tarefas com o JSON completo.`;

const TOOL = {
  name: "extrair_tarefas",
  description: "Retorna as tarefas extraídas do comando de voz (apenas strings cruas).",
  input_schema: {
    type: "object",
    properties: {
      detectei_n: { type: "number" },
      texto_nao_coberto: { type: ["string", "null"] },
      tarefas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            evidence_text: { type: "string" },
            descricao: { type: "string" },
            categoria_palpite: { type: ["string", "null"], enum: ["ligar", "oferecer", "preco", "whatsapp", "outro", null] },
            cliente_nome_falado: { type: ["string", "null"] },
            vendedora_nome_falado: { type: ["string", "null"] },
            raw_date_text: { type: ["string", "null"] },
            target_texto: { type: ["string", "null"] },
          },
          required: ["evidence_text", "descricao", "categoria_palpite", "cliente_nome_falado", "vendedora_nome_falado", "raw_date_text", "target_texto"],
        },
      },
    },
    required: ["detectei_n", "texto_nao_coberto", "tarefas"],
  },
} as const;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Gate master/gestor (não basta staff): cron/service_role passam; staff exige carteira completa.
  if (auth.via === "staff") {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: pode, error } = await admin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
    if (error || pode !== true) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const transcricao = String(body?.transcricao ?? "").trim();
    const hoje = String(body?.hoje ?? "");
    const vendedoras: Array<{ nome: string }> = Array.isArray(body?.vendedoras) ? body.vendedoras : [];
    if (!transcricao) return new Response(JSON.stringify({ error: "transcricao vazia" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const userMsg = `Hoje é ${hoje} (America/Sao_Paulo). Vendedoras conhecidas: ${vendedoras.map((v) => v.nome).join(", ") || "(nenhuma)"}.\n\nComando de voz transcrito:\n"""${transcricao}"""\n\nExtraia as tarefas e chame a tool extrair_tarefas.`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "extrair_tarefas" },
      messages: [{ role: "user", content: userMsg }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "IA não retornou estrutura" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const out = toolUse.input as { detectei_n?: number; texto_nao_coberto?: string | null; tarefas?: unknown[] };
    if (!Array.isArray(out?.tarefas)) {
      return new Response(JSON.stringify({ error: "saída fora do schema" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify(out), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "erro" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
```

- [ ] **Step 2: Lint da edge (parte do CI)**

Run: `bun lint`
Expected: PASS (sem `@ts-ignore` banido; sem `.or()` cru).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/tarefa-extrair-voz/index.ts
git commit -m "feat(tarefas-voz): edge tarefa-extrair-voz (Anthropic tool-use, gate master/gestor)"
```

> **Deploy:** após o merge, instruir o chat do Lovable a criar a edge `tarefa-extrair-voz` lendo `supabase/functions/tarefa-extrair-voz/index.ts` do repo, deploy verbatim. Confirmar "Active". Smoke: invocar com `{ transcricao: "manda a Regina ligar pra Padaria do Zé amanhã", hoje: "<hoje>", vendedoras: [{nome:"Regina"}] }` → deve voltar `{ detectei_n:1, tarefas:[{cliente_nome_falado:"Padaria do Zé", raw_date_text:"amanhã", ...}] }`.

---

## Task 7: Hook `useBuscaClienteOmie` (extrair de Tarefas.tsx, usar nos 2 lugares)

**Files:**
- Create: `src/hooks/useBuscaClienteOmie.ts`
- Modify: `src/pages/Tarefas.tsx` (substituir `buscarClientes`/resolução inline pelo hook — comportamento verbatim)

- [ ] **Step 1: Criar o hook (cut/paste verbatim da lógica de Tarefas.tsx)**

```ts
// src/hooks/useBuscaClienteOmie.ts
import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { eqText, orFilter } from '@/lib/postgrest';

/** Resultado da busca de cliente (Omie ERP + perfis locais), antes de resolver user_id. */
export type ClienteBusca = {
  user_id: string;
  nome: string;
  documento: string | null;
  telefone: string | null;
  email: string | null;
  omie_codigo_cliente?: number;
};

export function useBuscaClienteOmie() {
  const buscar = useCallback(async (query: string): Promise<ClienteBusca[]> => {
    if (query.length < 2) return [];
    try {
      const { data: omieData } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_clientes', search: query },
      });
      const omieClientes = (omieData?.clientes || []) as Array<{
        codigo_cliente: number; razao_social?: string; nome_fantasia?: string;
        email?: string | null; telefone?: string | null; cnpj_cpf?: string | null;
      }>;
      let mappingByCode: Record<number, string> = {};
      if (omieClientes.length > 0) {
        const codigos = omieClientes.map((c) => c.codigo_cliente);
        const { data: mappings } = await supabase.from('omie_clientes')
          .select('user_id, omie_codigo_cliente').in('omie_codigo_cliente', codigos);
        mappingByCode = Object.fromEntries((mappings || []).map((m) => [m.omie_codigo_cliente, m.user_id]));
      }
      const omieMapped: ClienteBusca[] = omieClientes.map((c) => ({
        user_id: mappingByCode[c.codigo_cliente] || '',
        nome: c.nome_fantasia || c.razao_social || 'Cliente',
        documento: c.cnpj_cpf || null, telefone: c.telefone || null, email: c.email || null,
        omie_codigo_cliente: c.codigo_cliente,
      }));
      const { data: localProfiles } = await supabase.from('profiles')
        .select('user_id, name, email, phone').ilike('name', `%${query}%`).limit(10);
      const local: ClienteBusca[] = (localProfiles || []).map((p) => ({
        user_id: p.user_id, nome: p.name ?? 'Cliente', documento: null,
        telefone: p.phone ?? null, email: p.email ?? null,
      }));
      const seen = new Set(omieMapped.filter((c) => c.user_id).map((c) => c.user_id));
      return [...omieMapped, ...local.filter((p) => !seen.has(p.user_id))];
    } catch {
      return []; // best-effort (mesma postura do FarmerCalls)
    }
  }, []);

  /** Resolve o customer_user_id local (doc/omie code). Retorna null se não vinculado. */
  const resolver = useCallback(async (c: ClienteBusca): Promise<string | null> => {
    if (c.user_id) return c.user_id;
    if (c.documento) {
      const docClean = c.documento.replace(/\D/g, '');
      const { data: profile } = await supabase.from('profiles').select('user_id')
        .or(orFilter(eqText('document', docClean), eqText('document', c.documento)))
        .limit(1).maybeSingle();
      if (profile?.user_id) return profile.user_id;
    }
    if (c.omie_codigo_cliente) {
      const { data: mapping } = await supabase.from('omie_clientes').select('user_id')
        .eq('omie_codigo_cliente', c.omie_codigo_cliente).maybeSingle();
      if (mapping?.user_id) return mapping.user_id;
    }
    return null;
  }, []);

  return { buscar, resolver };
}
```

- [ ] **Step 2: Migrar `Tarefas.tsx` pra usar o hook (comportamento verbatim)**

Em `src/pages/Tarefas.tsx`:
- Remover o `type ClienteBusca` local (linhas ~18-26) e importar do hook: `import { useBuscaClienteOmie, type ClienteBusca } from '@/hooks/useBuscaClienteOmie';`.
- Remover os imports `eqText, orFilter` (agora usados só no hook) se não houver outro uso.
- Adicionar `const { buscar, resolver } = useBuscaClienteOmie();` no corpo.
- Substituir a função `buscarClientes` (linhas ~57-114) por:

```tsx
  const buscarClientes = useCallback(async (query: string) => {
    if (query.length < 2) { setResultados([]); return; }
    setBuscando(true);
    try { setResultados(await buscar(query)); }
    finally { setBuscando(false); }
  }, [buscar]);
```

- Substituir o miolo de `selecionarCliente` (a resolução manual de `customerUserId`, linhas ~125-149) por:

```tsx
      const customerUserId = await resolver(c);
      if (!customerUserId) {
        toast.error('Cliente sem cadastro local', {
          description: 'Esse cliente Omie ainda não tem perfil no app. Crie um pedido primeiro para vinculá-lo.',
        });
        return;
      }
```

(o resto de `selecionarCliente` — `setCliente`, `setAbrirPicker(false)`, `setAbrirCriar(true)` — fica igual.)

- [ ] **Step 3: Verificar typecheck + a página ainda compila**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useBuscaClienteOmie.ts src/pages/Tarefas.tsx
git commit -m "refactor(tarefas): extrai useBuscaClienteOmie (reuso na criação por voz)"
```

---

## Task 8: Hook `useGravacaoTranscricao` (gravar + transcrever)

**Files:**
- Create: `src/hooks/useGravacaoTranscricao.ts`

> Espelha a gravação do `VoiceServiceInput` (MediaRecorder → `invokeFunction('elevenlabs-transcribe', formData)`), exposta como hook reusável. Não migra o `VoiceServiceInput` (fica como está).

- [ ] **Step 1: Implementar o hook**

```ts
// src/hooks/useGravacaoTranscricao.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

export function useGravacaoTranscricao() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcricao, setTranscricao] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const transcrever = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      let ext = 'webm';
      if (blob.type.includes('mp4')) ext = 'mp4'; else if (blob.type.includes('ogg')) ext = 'ogg';
      const fd = new FormData();
      fd.append('audio', blob, `recording.${ext}`);
      const result = await invokeFunction<{ text?: string }>('elevenlabs-transcribe', fd);
      if (result.text) setTranscricao((prev) => prev + (prev ? ' ' : '') + result.text);
      else toast.error('Nenhum texto detectado no áudio.');
    } catch (e) {
      logger.error('Falha na transcrição da tarefa por voz', { error: e });
      toast.error('Erro na transcrição', { description: e instanceof Error ? e.message : 'Tente novamente.' });
    } finally { setIsTranscribing(false); }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      chunksRef.current = [];
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType });
      recorderRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (chunksRef.current.length > 0) await transcrever(new Blob(chunksRef.current, { type: mimeType }));
      };
      rec.start(1000);
      setIsRecording(true);
    } catch (e) {
      const err = e as { name?: string };
      toast.error(err.name === 'NotAllowedError' ? 'Permissão de microfone negada' : 'Erro ao acessar o microfone');
    }
  }, [transcrever]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    setIsRecording(false);
  }, []);

  const toggle = useCallback(() => { if (isRecording) stop(); else start(); }, [isRecording, start, stop]);
  const reset = useCallback(() => { setTranscricao(''); }, []);

  return { isRecording, isTranscribing, transcricao, setTranscricao, toggle, reset };
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGravacaoTranscricao.ts
git commit -m "feat(tarefas-voz): hook useGravacaoTranscricao (gravar + transcrever)"
```

---

## Task 9: `criarTarefas` retorna ids + auditoria opcional de voz

**Files:**
- Modify: `src/hooks/useTarefas.ts` (função `criarTarefas` dentro de `useTarefaMutations`)

> Hoje `criarTarefas` faz `insert(rows)` e retorna void. Precisamos dos ids pra gravar o evento de auditoria `criada_por_voz` (transcrição crua + evidence_text — spec §11/P3). Mudança backward-compatible: novo param opcional `auditVoz`; o caller atual (CriarTarefaDialog) não passa nada e não quebra.

- [ ] **Step 1: Modificar `criarTarefas`**

Substituir a função `criarTarefas` (linhas ~91-98) por:

```ts
  /** Cria N tarefas pro mesmo cliente. Opcional: grava auditoria da origem por voz. */
  const criarTarefas = async (
    linhas: Array<Record<string, unknown>>,
    auditVoz?: { transcricao: string; evidencias: string[] },
  ): Promise<{ ids: string[] }> => {
    const rows = linhas.map((l) => ({ ...l, created_by: user!.id }));
    const { data, error } = await tarefas().insert(rows as never).select('id');
    if (error) { toast.error('Erro ao criar tarefa', { description: error.message }); throw error; }
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    track('tarefas.created', { qtd: rows.length, origem: auditVoz ? 'voz' : 'form' });
    if (auditVoz && ids.length > 0) {
      // best-effort: ordem do insert preservada pela representação do PostgREST.
      const eventos_rows = ids.map((id, i) => ({
        tarefa_id: id, tipo_evento: 'criada_por_voz', ator: user!.id,
        payload: { transcricao: auditVoz.transcricao, evidence_text: auditVoz.evidencias[i] ?? null },
      }));
      await eventos().insert(eventos_rows as never);
    }
    toast.success(rows.length > 1 ? `${rows.length} tarefas criadas` : 'Tarefa criada');
    invalidate();
    return { ids };
  };
```

- [ ] **Step 2: Verificar typecheck**

Run: `heavy bun run typecheck`
Expected: PASS (o caller existente ignora o retorno — sem erro).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTarefas.ts
git commit -m "feat(tarefas-voz): criarTarefas retorna ids + auditoria criada_por_voz"
```

---

## Task 10: `VozTarefaDialog` (gravar → revisar → criar)

**Files:**
- Create: `src/components/tarefas/VozTarefaDialog.tsx`

> Monta tudo: grava/transcreve (`useGravacaoTranscricao`) → chama a edge `tarefa-extrair-voz` → `montarRascunhos` → por card, busca Omie por `cliente_nome_falado` + `casarCliente` → cards editáveis com status → `validarRascunho` → `criarTarefas`. `empresa` derivada via prop (a página passa o company context). Recebe `vendedoras` e `empresa` como props.

- [ ] **Step 1: Implementar o componente**

```tsx
// src/components/tarefas/VozTarefaDialog.tsx
import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Mic, Square, Loader2, Sparkles, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { invokeFunction } from '@/lib/invoke-function';
import { spBusinessDate } from '@/lib/time/sp-day';
import { useGravacaoTranscricao } from '@/hooks/useGravacaoTranscricao';
import { useBuscaClienteOmie } from '@/hooks/useBuscaClienteOmie';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { autoSatisfyDaCategoria } from '@/lib/tarefas/categoria-map';
import { montarRascunhos } from '@/lib/tarefas/voz/montar-rascunhos';
import { casarCliente } from '@/lib/tarefas/voz/match';
import { validarRascunho } from '@/lib/tarefas/voz/validacao';
import type { ExtracaoVozIA, RascunhoVoz, VendedoraOpcao } from '@/lib/tarefas/voz/types';
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '@/lib/tarefas/types';

export function VozTarefaDialog({ open, onOpenChange, vendedoras, empresa }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  vendedoras: VendedoraOpcao[]; empresa: string;
}) {
  const { isRecording, isTranscribing, transcricao, setTranscricao, toggle, reset } = useGravacaoTranscricao();
  const { buscar } = useBuscaClienteOmie();
  const { criarTarefas } = useTarefaMutations();
  const [extraindo, setExtraindo] = useState(false);
  const [rascunhos, setRascunhos] = useState<RascunhoVoz[] | null>(null);
  const [naoCoberto, setNaoCoberto] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const hojeSP = spBusinessDate(new Date());

  // reset ao fechar
  useEffect(() => { if (!open) { reset(); setRascunhos(null); setNaoCoberto(null); } }, [open, reset]);

  const resolverClienteDoCard = useCallback(async (r: RascunhoVoz): Promise<RascunhoVoz> => {
    if (!r.cliente_nome_falado) return { ...r, cliente: { customer_user_id: null, nome: null, status: 'sem_match', candidatos: [] } };
    const achados = await buscar(r.cliente_nome_falado);
    const cands = achados.map((a) => ({ customer_user_id: a.user_id, nome: a.nome }));
    return { ...r, cliente: casarCliente(r.cliente_nome_falado, cands) };
  }, [buscar]);

  const extrair = async () => {
    if (!transcricao.trim()) { toast.error('Grave ou digite o comando primeiro.'); return; }
    setExtraindo(true);
    try {
      const out = await invokeFunction<ExtracaoVozIA>('tarefa-extrair-voz', {
        transcricao: transcricao.trim(), hoje: hojeSP, tz: 'America/Sao_Paulo',
        vendedoras: vendedoras.map((v) => ({ nome: v.nome })),
      });
      const base = montarRascunhos(out, { hojeSP, vendedoras });
      const comCliente = await Promise.all(base.map(resolverClienteDoCard));
      setRascunhos(comCliente);
      setNaoCoberto(out.texto_nao_coberto);
      if (comCliente.length === 0) toast.warning('Não detectei nenhuma tarefa. Revise o texto.');
    } catch (e) {
      // degradação: não perde a fala — vira 1 rascunho cru pra ele preencher
      setRascunhos([{
        evidence_text: transcricao, descricao: transcricao, categoria: 'outro',
        cliente_nome_falado: null, cliente: { customer_user_id: null, nome: null, status: 'sem_match', candidatos: [] },
        vendedora: { user_id: null, nome: null, status: 'sem_match' },
        data: { modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' },
        target_texto: null,
      }]);
      toast.error('Não consegui estruturar — revise/preencha manualmente.', { description: e instanceof Error ? e.message : undefined });
    } finally { setExtraindo(false); }
  };

  const patch = (i: number, p: Partial<RascunhoVoz>) =>
    setRascunhos((rs) => rs ? rs.map((r, idx) => idx === i ? { ...r, ...p } : r) : rs);

  const buscarTrocaCliente = async (i: number, query: string) => {
    const r = rascunhos?.[i]; if (!r) return;
    const achados = await buscar(query);
    const cands = achados.map((a) => ({ customer_user_id: a.user_id, nome: a.nome }));
    patch(i, { cliente: casarCliente(query || r.cliente_nome_falado || '', cands) });
  };

  const salvar = async () => {
    if (!rascunhos) return;
    const validos = rascunhos.map((r) => ({ r, v: validarRascunho(r, hojeSP) }));
    const comErro = validos.filter((x) => !x.v.ok);
    if (comErro.length > 0) { toast.error(`Corrija ${comErro.length} tarefa(s) antes de salvar.`); return; }
    setSalvando(true);
    try {
      // agrupa por cliente (criarTarefas é por cliente). Aqui criamos uma chamada por card
      // (simples e correto; cada card tem seu cliente).
      for (const r of rascunhos) {
        await criarTarefas([{
          descricao: r.descricao, categoria: r.categoria, customer_user_id: r.cliente!.customer_user_id,
          assigned_to: r.vendedora.user_id, empresa, modo: r.data.modo,
          due_date: r.data.modo === 'data' ? r.data.due_date : null,
          interacao_tipo: r.data.modo === 'interacao' ? (r.data.interacao_tipo ?? 'ligacao') : null,
          auto_satisfy_mode: autoSatisfyDaCategoria(r.categoria),
          target_texto: (r.categoria === 'oferecer' || r.categoria === 'preco') ? r.target_texto : null,
        }], { transcricao, evidencias: [r.evidence_text] });
      }
      onOpenChange(false);
    } finally { setSalvando(false); }
  };

  const statusBadge = (s: string) =>
    s === 'unico' ? null
    : <Badge variant="outline" className="text-status-warning">{s === 'ambiguo' ? 'confirme' : 'não encontrado'}</Badge>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Criar tarefa por voz</DialogTitle></DialogHeader>

        {/* Gravação / texto */}
        <div className="space-y-2">
          <div className="relative">
            <Textarea value={transcricao} onChange={(e) => setTranscricao(e.target.value)} disabled={isTranscribing}
              placeholder="Grave ou digite: ex. manda a Regina ligar pra Padaria do Zé amanhã e oferecer a linha nova"
              className="min-h-[90px] pr-12" />
            <button type="button" onClick={toggle} disabled={isTranscribing}
              className={`absolute right-2 top-2 p-2 rounded-full ${isRecording ? 'bg-destructive text-destructive-foreground animate-pulse' : 'bg-muted'}`}>
              {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>
          {isTranscribing && <p className="text-2xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Transcrevendo…</p>}
          <Button onClick={extrair} disabled={!transcricao.trim() || extraindo || isRecording} className="w-full">
            {extraindo ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Estruturando…</> : <><Sparkles className="w-4 h-4 mr-2" />Detectar tarefas</>}
          </Button>
        </div>

        {/* Revisão */}
        {rascunhos && (
          <div className="space-y-3 mt-2">
            <p className="text-2xs text-muted-foreground">
              Detectei <strong>{rascunhos.length}</strong> tarefa(s).
              {naoCoberto && <span className="text-status-warning"> Não cobri: “{naoCoberto}”.</span>}
            </p>
            {rascunhos.map((r, i) => {
              const erros = validarRascunho(r, hojeSP).erros;
              return (
                <div key={i} className={`rounded-md border p-3 space-y-2 ${erros.length ? 'border-status-warning/50' : 'border-border'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <Textarea value={r.descricao} onChange={(e) => patch(i, { descricao: e.target.value })} className="min-h-[40px] text-sm" />
                    <Button size="icon" variant="ghost" onClick={() => setRascunhos((rs) => rs!.filter((_, idx) => idx !== i))}><Trash2 className="w-4 h-4" /></Button>
                  </div>

                  {/* Vendedora */}
                  <div className="flex items-center gap-2">
                    <Select value={r.vendedora.user_id ?? ''} onValueChange={(v) => patch(i, { vendedora: { user_id: v, nome: vendedoras.find((x) => x.user_id === v)?.nome ?? null, status: 'unico' } })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Vendedora" /></SelectTrigger>
                      <SelectContent>{vendedoras.map((v) => <SelectItem key={v.user_id} value={v.user_id}>{v.nome}</SelectItem>)}</SelectContent>
                    </Select>
                    {statusBadge(r.vendedora.status)}
                  </div>

                  {/* Cliente */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate">{r.cliente?.customer_user_id ? r.cliente.nome : 'Cliente não definido'}</span>
                      {r.cliente_nome_falado && <span className="text-2xs text-muted-foreground">(falado: “{r.cliente_nome_falado}”)</span>}
                      {r.cliente && statusBadge(r.cliente.status)}
                    </div>
                    {(!r.cliente || r.cliente.status !== 'unico') && (
                      <ClienteSwap candidatos={r.cliente?.candidatos ?? []} onPick={(cid, nome) => patch(i, { cliente: { customer_user_id: cid, nome, status: 'unico', candidatos: r.cliente?.candidatos ?? [] } })} onBuscar={(q) => buscarTrocaCliente(i, q)} />
                    )}
                  </div>

                  {/* Categoria + target */}
                  <div className="flex items-center gap-2">
                    <Select value={r.categoria} onValueChange={(v) => patch(i, { categoria: v as TarefaCategoria })}>
                      <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ligar">Ligar</SelectItem><SelectItem value="oferecer">Oferecer</SelectItem>
                        <SelectItem value="preco">Passar preço</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem>
                        <SelectItem value="outro">Outro</SelectItem>
                      </SelectContent>
                    </Select>
                    {(r.categoria === 'oferecer' || r.categoria === 'preco') && (
                      <Input className="h-8 text-xs" placeholder="item/preço" value={r.target_texto ?? ''} onChange={(e) => patch(i, { target_texto: e.target.value })} />
                    )}
                  </div>

                  {/* Prazo */}
                  <div className="flex items-center gap-2">
                    <Select value={r.data.modo} onValueChange={(v) => patch(i, { data: { ...r.data, modo: v as TarefaModo, status: v === 'interacao' ? 'sem_data' : r.data.status } })}>
                      <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="data">Data fixa</SelectItem><SelectItem value="interacao">Próxima interação</SelectItem></SelectContent>
                    </Select>
                    {r.data.modo === 'data'
                      ? <Input type="date" className="h-8 text-xs" value={r.data.due_date ?? ''} onChange={(e) => patch(i, { data: { ...r.data, due_date: e.target.value, status: 'resolvida' } })} />
                      : <Select value={r.data.interacao_tipo ?? 'ligacao'} onValueChange={(v) => patch(i, { data: { ...r.data, interacao_tipo: v as TarefaInteracaoTipo } })}>
                          <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="ligacao">Próxima ligação</SelectItem><SelectItem value="visita">Próxima visita</SelectItem><SelectItem value="entrega">Próxima entrega</SelectItem></SelectContent>
                        </Select>}
                    {(r.data.status === 'ambigua' || r.data.status === 'nao_resolvida' || r.data.status === 'passado') &&
                      <Badge variant="outline" className="text-status-warning">confirme o prazo</Badge>}
                  </div>

                  {erros.length > 0 && <p className="text-2xs text-status-warning">{erros.join(' ')}</p>}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          {rascunhos && rascunhos.length > 0 && (
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Criar {rascunhos.length} tarefa(s)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mini-busca de cliente pra trocar o match (reusa o picker Omie). */
function ClienteSwap({ candidatos, onPick, onBuscar }: {
  candidatos: { customer_user_id: string; nome: string }[];
  onPick: (cid: string, nome: string) => void;
  onBuscar: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => { if (q.length >= 2) onBuscar(q); }, 300); return () => clearTimeout(t); }, [q, onBuscar]);
  const lista = candidatos.filter((c) => c.customer_user_id);
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
        <Input className="h-7 pl-7 text-xs" placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {lista.length > 0 && (
        <div className="border rounded max-h-32 overflow-y-auto">
          {lista.map((c) => (
            <button key={c.customer_user_id} onClick={() => onPick(c.customer_user_id, c.nome)}
              className="w-full text-left px-2 py-1 text-xs hover:bg-muted/50 border-b last:border-b-0">{c.nome}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/tarefas/VozTarefaDialog.tsx
git commit -m "feat(tarefas-voz): VozTarefaDialog (gravar → revisar rascunhos → criar)"
```

---

## Task 11: Wire na página Tarefas + QA + atualizar roadmap/spec

**Files:**
- Modify: `src/pages/Tarefas.tsx`
- Modify: `docs/roadmap-sessao.md`, `docs/superpowers/specs/2026-06-04-tarefa-criar-por-voz-design.md`

- [ ] **Step 1: Adicionar o botão + dialog em Tarefas.tsx**

- Import: `import { VozTarefaDialog } from '@/components/tarefas/VozTarefaDialog';`
- Estado: `const [abrirVoz, setAbrirVoz] = useState(false);`
- No header (ao lado de "Nova tarefa"):

```tsx
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setAbrirVoz(true)} disabled={salespeople.length === 0}>🎙️ Criar por voz</Button>
          <Button onClick={abrirNovaTarefa}>Nova tarefa</Button>
        </div>
```

- Antes do `</div>` final, renderizar o dialog (empresa = o `empresa` já no estado da página, default 'oben'):

```tsx
      <VozTarefaDialog
        open={abrirVoz}
        onOpenChange={setAbrirVoz}
        vendedoras={salespeople.map((s) => ({ user_id: s.user_id, nome: s.name }))}
        empresa={empresa}
      />
```

- [ ] **Step 2: Suíte completa + typecheck + lint + build**

Run: `heavy bun run typecheck && heavy bun run test && bun lint && heavy bun run build`
Expected: tudo PASS (os novos testes de voz inclusos; build gera bundle).

- [ ] **Step 3: Atualizar roadmap + status do spec**

- `docs/superpowers/specs/2026-06-04-tarefa-criar-por-voz-design.md`: trocar o Status (linha 3) pra "plano escrito (`docs/superpowers/plans/2026-06-04-tarefa-criar-por-voz.md`) + em implementação".
- `docs/roadmap-sessao.md` seção 4: marcar ✅ plano escrito; 🔄 build em andamento.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Tarefas.tsx docs/roadmap-sessao.md docs/superpowers/specs/2026-06-04-tarefa-criar-por-voz-design.md
git commit -m "feat(tarefas-voz): botão Criar por voz na página + atualiza roadmap/spec"
```

- [ ] **Step 5: QA manual (founder, no preview Lovable — headless não renderiza a SPA)**

Checklist após **deploy da edge** (Lovable chat) + **Publish**:
1. `/tarefas` → "🎙️ Criar por voz" → permitir microfone → falar "manda a Regina ligar pra Padaria do Zé amanhã e oferecer a linha nova, e whatsapp pra Maria sexta".
2. Conferir: transcrição aparece; "Detectei 2 tarefas"; card 1 = Regina/ligar+oferecer/Padaria do Zé/amanhã; card 2 = WhatsApp/Maria/sexta (vendedora vazia → escolher).
3. Cliente ambíguo → trocar pela busca; vendedora vazia → escolher no dropdown.
4. Prazo "amanhã" resolvido pra data; criar → cai no Meu Dia da vendedora no dia certo.
5. Caso de erro: falar algo sem cliente → card pede cliente; salvar bloqueado até resolver.

---

## Self-Review (executado ao escrever)

**Spec coverage:** §3 princípio (IA extrai, determinístico resolve) → Tasks 2/3/5/6. §6 contrato IA → Task 6 (tool schema). §7 datas → Task 2. §8 cliente → Task 3 (`casarCliente`) + Task 10 (busca por card). §9 vendedora → Task 3 (`casarVendedora`). §10 validação dura → Task 4 + uso no Task 10. §11 degradação/auditoria → Task 10 (fallback cru) + Task 9 (evento `criada_por_voz`) + "Detectei N"/não-coberto na UI. §12 empresa → prop no dialog. §13 gate → Task 6.

**Type consistency:** `RascunhoVoz`/`MatchCliente`/`MatchVendedora`/`ResultadoData`/`ExtracaoVozIA` definidos no Task 1 e usados consistentemente (2,3,4,5,10). `casarCliente`/`casarVendedora`/`resolverDataPtBr`/`montarRascunhos`/`validarRascunho` com assinaturas estáveis entre tasks. `criarTarefas` ganha 2º param opcional sem quebrar o caller existente.

**Placeholders:** nenhum — todo step tem código/teste/comando reais.

**Nota de risco conhecida:** a auditoria `criada_por_voz` assume ordem do array preservada pelo PostgREST no `.select()` (best-effort; a transcrição é a mesma pra todos os cards, só `evidence_text` varia). Aceitável p/ auditoria.
