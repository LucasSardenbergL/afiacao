# G1 Fase 2 — Loop de Feedback da Fila (zero migration) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para executar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Fechar o loop de feedback da fila do Meu Dia (G1) reusando os 3 motores de feedback existentes — sem tabela nova, sem migration.

**Architecture:** Cada `AcaoSugerida` ganha um `payload` discriminado por fonte. A `FilaDoDia` renderiza, por linha, o CTA "Fazer" (já existe) + um menu de **outcome** que chama o motor de origem: tarefa→`useTarefaMutations.concluir`, rota→`OutcomeMenu` pronto (`registrar_contato_rota`), mix-gap→`useMarkMixGapFeedback`. "Não é pra agora" esconde na sessão (estado React) + `track`. Telemetria `fila.*` com `fila.exibida` 1×/dia via sessionStorage.

**Tech Stack:** React 18 + TS + Vite + @tanstack/react-query + shadcn (DropdownMenu/AlertDialog) + sonner + `@/lib/analytics`. Vitest pros helpers puros.

**Decisões fechadas (pós-Codex Fase 2 — ver spec §5/§7/Anexo):**
- ZERO migration. Os 3 motores já existem e fecham o loop.
- `payload` discriminado obrigatório (Codex P1) — não parsear `entidadeId`/`dedupeKey`.
- Tarefa: **Concluir** + "Não é pra agora". **Nunca Adiar na fila** (muda prazo de negócio). Sem "Abrir tarefa" (`/tarefas` é gestor/master-only; o título já linka o 360).
- Rota: reusar o `OutcomeMenu` pronto (cobre convertido/respondido/sem_resposta/opt_out + undo).
- Mix-gap: Ofertei(`ofertado`)/Vendi(`convertido`)/Sem fit(`recusado`) via `markFeedback`.
- "Não é pra agora": estado de sessão (React Set) + `track('fila.nao_util_agora')`. Sem DB.
- `fila.exibida` 1×/dia/sessão (sessionStorage por `spBusinessDate`), nunca por render.

---

## File Structure

- `src/lib/fila/types.ts` — **modificar**: + `AcaoPayload` union, + `payload` em `AcaoSugerida`.
- `src/lib/fila/adapters/{tarefa,rota,mixgap,whatsappPendente}.ts` — **modificar**: preencher `payload`. `rota` ganha 2º arg `dataRota`.
- `src/hooks/useFilaAcoes.ts` — **modificar**: passar `routeDate` pro `rotaParaAcoes`.
- `src/lib/fila/__tests__/{tarefa,rota,mixgap,whatsappPendente}.test.ts` — **modificar**: assertar `payload`.
- `src/lib/fila/telemetria.ts` — **criar**: `marcarSeNovoNoDia`, `resumoFontes` (puros).
- `src/lib/fila/__tests__/telemetria.test.ts` — **criar**.
- `src/components/fila/AcaoOutcomeMenu.tsx` — **criar**: despacha por `payload.kind`.
- `src/components/fila/FilaDoDia.tsx` — **modificar**: Set de escondidos + menu por linha + telemetria.

---

## Task 1: Payload tipado + adapters preenchem (fundação)

**Files:**
- Modify: `src/lib/fila/types.ts`
- Modify: `src/lib/fila/adapters/tarefa.ts`, `rota.ts`, `mixgap.ts`, `whatsappPendente.ts`
- Modify: `src/hooks/useFilaAcoes.ts`
- Test: `src/lib/fila/__tests__/tarefa.test.ts`, `rota.test.ts`, `mixgap.test.ts`, `whatsappPendente.test.ts`

- [ ] **Step 1: Adicionar o union em `types.ts`** (após os type aliases existentes, antes de `AcaoSugerida`):

```ts
export type AcaoPayload =
  | { kind: 'tarefa'; tarefaId: string }
  | { kind: 'rota'; customerUserId: string; dataRota: string; bucket: string | null; valor: number | null }
  | { kind: 'mixgap'; customerUserId: string; familia: string }
  | { kind: 'whatsapp'; conversationId: string };
```

E adicionar o campo em `AcaoSugerida` (no fim da interface):
```ts
  /** dados estruturais p/ o CTA de outcome chamar o motor de origem (Codex P1) */
  payload: AcaoPayload;
```

- [ ] **Step 2: Atualizar testes dos adapters pra assertar o payload (devem falhar)**

Em `tarefa.test.ts`: após o `.map`, assertar `expect(acoes[0].payload).toEqual({ kind: 'tarefa', tarefaId: <id da fixture> })`.
Em `rota.test.ts`: a chamada vira `rotaParaAcoes(callQueue, '2026-06-04')`; assertar `payload` = `{ kind:'rota', customerUserId, dataRota:'2026-06-04', bucket:<fixture>, valor:<fixture> }`.
Em `mixgap.test.ts`: assertar `payload` = `{ kind:'mixgap', customerUserId, familia: <familia_faltante da fixture> }`.
Em `whatsappPendente.test.ts`: assertar `payload` = `{ kind:'whatsapp', conversationId: <conversationId> }`.

- [ ] **Step 3: Rodar os testes pra ver falhar** — `heavy bun run test src/lib/fila` → FAIL (payload ausente).

- [ ] **Step 4: Preencher `payload` nos 4 adapters**

`tarefa.ts` (dentro do `.map`): `payload: { kind: 'tarefa', tarefaId: t.id },`
`rota.ts`: mudar assinatura para `export function rotaParaAcoes(callQueue: RouteContactItem[], dataRota: string): AcaoSugerida[]` e no map: `payload: { kind: 'rota', customerUserId: c.customerUserId, dataRota, bucket: c.bucket, valor: Number.isFinite(c.valorDaLigacao) ? c.valorDaLigacao : null },`
`mixgap.ts`: `payload: { kind: 'mixgap', customerUserId: g.customer_user_id, familia: g.familia_faltante },`
`whatsappPendente.ts`: `payload: { kind: 'whatsapp', conversationId: <campo do conversationId no item> },` (confirmar o nome do campo no adapter atual; é `conversationId` no `WaPendente`).

- [ ] **Step 5: Ligar o `dataRota` no `useFilaAcoes`** — na composição:
```ts
...rotaParaAcoes(rota.data?.callQueue ?? [], rota.data?.routeDate ?? workdayIso),
```
(workdayIso já existe no hook.)

- [ ] **Step 6: Rodar testes** — `heavy bun run test src/lib/fila` → PASS.

- [ ] **Step 7: Typecheck** — `heavy bun run typecheck` → 0 erros (o `payload` propaga; confirmar que nenhum outro consumidor de `AcaoSugerida` quebra).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(fila): payload tipado por fonte em AcaoSugerida (G2)"`

---

## Task 2: Telemetria pura (`fila.exibida` sem inflar)

**Files:**
- Create: `src/lib/fila/telemetria.ts`
- Test: `src/lib/fila/__tests__/telemetria.test.ts`

- [ ] **Step 1: Escrever o teste (deve falhar)**

```ts
import { describe, it, expect } from 'vitest';
import { marcarSeNovoNoDia, resumoFontes } from '../telemetria';
import type { AcaoSugerida } from '../types';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

describe('marcarSeNovoNoDia', () => {
  it('retorna true na 1ª vez e false nas seguintes (idempotente)', () => {
    const s = fakeStorage();
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-04', s)).toBe(true);
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-04', s)).toBe(false);
    expect(marcarSeNovoNoDia('fila_exibida_2026-06-05', s)).toBe(true);
  });
  it('storage indisponível (throw) → não quebra, retorna false', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(marcarSeNovoNoDia('k', bad)).toBe(false);
  });
});

describe('resumoFontes', () => {
  it('conta por fonte', () => {
    const acoes = [
      { fonte: 'tarefa' }, { fonte: 'tarefa' }, { fonte: 'rota' }, { fonte: 'mixgap' },
    ] as AcaoSugerida[];
    expect(resumoFontes(acoes)).toEqual({ tarefa: 2, rota: 1, mixgap: 1 });
  });
  it('lista vazia → objeto vazio', () => {
    expect(resumoFontes([])).toEqual({});
  });
});
```

- [ ] **Step 2: Rodar pra falhar** — `heavy bun run test src/lib/fila/__tests__/telemetria.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar `telemetria.ts`**

```ts
// src/lib/fila/telemetria.ts
// Helpers puros de instrumentação da fila. fila.exibida deve ser logada 1×/dia
// (não por render) — Codex P2. A persistência é injetada (Storage) p/ testar puro.
import type { AcaoSugerida, FonteAcao } from './types';

export function chaveDiaExibida(dia: string): string {
  return `fila_exibida_${dia}`;
}

/** Marca a chave no storage; retorna true só na 1ª vez (idempotente, fail-safe). */
export function marcarSeNovoNoDia(chave: string, storage: Storage): boolean {
  try {
    if (storage.getItem(chave)) return false;
    storage.setItem(chave, '1');
    return true;
  } catch {
    return false; // storage indisponível (modo privado etc.) → não loga, não quebra
  }
}

/** Conta ações por fonte (p/ o payload do evento fila.exibida). */
export function resumoFontes(acoes: AcaoSugerida[]): Partial<Record<FonteAcao, number>> {
  const out: Partial<Record<FonteAcao, number>> = {};
  for (const a of acoes) out[a.fonte] = (out[a.fonte] ?? 0) + 1;
  return out;
}
```

- [ ] **Step 4: Rodar pra passar** — `heavy bun run test src/lib/fila/__tests__/telemetria.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(fila): telemetria pura (fila.exibida 1x/dia + resumoFontes) (G2)"`

---

## Task 3: `AcaoOutcomeMenu` (despacha por payload.kind)

**Files:**
- Create: `src/components/fila/AcaoOutcomeMenu.tsx`

Reusa: `OutcomeMenu` (`@/components/call/OutcomeMenu`), `useTarefaMutations` (`@/hooks/useTarefas`), `useMarkMixGapFeedback` (`@/hooks/useMarkMixGapFeedback`), `track` (`@/lib/analytics`), shadcn DropdownMenu, sonner toast.

- [ ] **Step 1: Implementar o componente**

Props: `{ acao: AcaoSugerida; onNaoUtilAgora: (dedupeKey: string) => void }`.

Comportamento por `acao.payload.kind`:
- **`tarefa`**: `DropdownMenu` (trigger ⋯) com:
  - "Concluir" → `await tarefas.concluir(payload.tarefaId, 'manual')` + `track('fila.outcome', { fonte:'tarefa', tipo:'concluir', dedupeKey: acao.dedupeKey })`. (o `concluir` já dá toast + invalida → some no refetch)
  - separador + "Não é pra agora" → `onNaoUtilAgora(acao.dedupeKey)` + `track('fila.nao_util_agora', { fonte:'tarefa', dedupeKey: acao.dedupeKey })`.
- **`rota`**: renderiza `<OutcomeMenu customerUserId={payload.customerUserId} customerName={acao.clienteNome ?? 'cliente'} dataRota={payload.dataRota} bucket={payload.bucket} valor={payload.valor} />`. (já tem todos os outcomes + undo + confirm de opt_out; não duplicar). Sem "Não é pra agora" (os outcomes da rota cobrem; "não atendeu" = não rolou).
- **`mixgap`**: `DropdownMenu` (trigger ⋯) com:
  - "Já ofereci" → `markFeedback({ customerUserId: payload.customerUserId, familia: payload.familia, status: 'ofertado' })` + `track('fila.outcome', { fonte:'mixgap', tipo:'ofertado', dedupeKey })`.
  - "Cliente comprou" → idem com `status:'convertido'` + tipo `convertido`.
  - "Não tem fit" → idem com `status:'recusado'` + tipo `recusado`.
  - separador + "Não é pra agora" → `onNaoUtilAgora` + `track('fila.nao_util_agora', { fonte:'mixgap', dedupeKey })`.
  - (markFeedback é optimistic no cache `['my-mixgap']` que a fila lê → some na hora.)
- **`whatsapp`**: retorna `null` (fonte desligada no v1 — Fase 3).

Notas: usar `Button variant="ghost" size="icon"` com ícone `MoreHorizontal` (lucide) como trigger dos menus que eu controlo. Hooks chamados no topo do componente (sempre), o switch só decide o que renderizar. `track` na convenção `<area>.<action>` (`fila.outcome`/`fila.nao_util_agora`).

- [ ] **Step 2: Typecheck** — `heavy bun run typecheck` → 0 erros.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(fila): AcaoOutcomeMenu — outcome por fonte (tarefa/rota/mixgap) (G2)"`

---

## Task 4: Integrar na `FilaDoDia` (menu + esconder-na-sessão + telemetria)

**Files:**
- Modify: `src/components/fila/FilaDoDia.tsx`

- [ ] **Step 1: Estado de escondidos + telemetria**

No topo do componente:
```ts
const [escondidos, setEscondidos] = useState<Set<string>>(() => new Set());
const ocultar = (k: string) => setEscondidos(s => { const n = new Set(s); n.add(k); return n; });
const visiveis = useMemo(() => acoes.filter(a => !escondidos.has(a.dedupeKey)), [acoes, escondidos]);
```

useEffect de `fila.exibida` (1×/dia):
```ts
useEffect(() => {
  if (isLoading || visiveis.length === 0) return;
  const dia = spBusinessDate(new Date());
  if (marcarSeNovoNoDia(chaveDiaExibida(dia), sessionStorage)) {
    track('fila.exibida', { qtd: visiveis.length, fontes: resumoFontes(visiveis) });
  }
}, [isLoading, visiveis]);
```
(import `useEffect`, `useMemo`, `useState` do react; `spBusinessDate` de `@/lib/time/sp-day`; `marcarSeNovoNoDia`, `chaveDiaExibida`, `resumoFontes` de `@/lib/fila/telemetria`; `track`.)

- [ ] **Step 2: Trocar `acoes` por `visiveis` na renderização da lista** (o `.slice(0,30).map`), e no empty-state/contagem do header usar `visiveis.length`. Manter o skeleton de `isLoading`.

- [ ] **Step 3: Adicionar o menu de outcome em cada linha** — ao lado do `<AcaoCta a={a} />`:
```tsx
<div className="shrink-0 flex items-center gap-1">
  <AcaoCta a={a} />
  <AcaoOutcomeMenu acao={a} onNaoUtilAgora={ocultar} />
</div>
```
(import `AcaoOutcomeMenu` de `./AcaoOutcomeMenu`.)

- [ ] **Step 4: Typecheck + testes + build + lint** — `heavy bun run typecheck && heavy bun run test && heavy bun run build && bun lint` (lint só pra checar a regra `no-restricted-syntax`; warnings de hooks não bloqueiam).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(fila): outcome por linha + esconder-na-sessão + telemetria fila.exibida (G2)"`

---

## Validação final (gate)

- [ ] `heavy bun run typecheck` → 0 erros.
- [ ] `heavy bun run test` → tudo verde (os ~22 testes da fila + os novos de telemetria).
- [ ] `heavy bun run build` → ok.
- [ ] `bun lint` → sem novos erros (a regra `no-restricted-syntax` anti-`.or()` continua; warnings de exhaustive-deps são aceitáveis).
- [ ] Revisão de fidelidade: cada outcome chama o motor certo com os args do `payload`; nada persiste em tabela nova; `fila.exibida` não infla.

## Não-objetivos (v1 da Fase 2)

- Tabela `suggested_action_feedback` (adiada — só se o piloto provar snooze pessoal).
- Optimistic "anti-piscar" em tarefa/rota (refetch resolve; aceitável).
- Enriquecer o "Fazer" (telefone na tarefa, pedido inline) — é a Fase 3 (split + pedido focado).
- Split desktop MeuDia|WhatsApp (Fase 3).

## Handoff

Após o gate: abrir PR `feat/g2-fila-feedback` → main. **Sem migration, sem edge function.** O Lucas mergeia + **Publish no Lovable** (o front não auto-deploya) + valida `/meu-dia` logado como **vendedora** (farmer com carteira) — master vê fila vazia.
