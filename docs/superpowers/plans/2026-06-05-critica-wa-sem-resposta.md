# Crítica da Fila v1.1 — 5ª contradição `wa_sem_resposta` (determinística) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Ativar a 5ª contradição **determinística** da Crítica da Fila — cliente do top-5 da vendedora com conversa de WhatsApp **esperando resposta humana há >30min úteis** (`nivel='vermelho'`), e a vendedora é a **dona** — lendo a view `v_whatsapp_sla` (#587, read-only). Era o item adiado na spec da v1 (§6 ⏸️ `wa_sem_resposta`). NÃO-gated (mais sinal determinístico, que o piloto testa); não é a camada de LLM (essa segue pilot-gated).

**Architecture:** Reusa o motor v1 `src/lib/fila/critica/` (helper puro + detector + composer) + a view SLA já mergeada. Fonte: `v_whatsapp_sla` via `useWhatsappSla()` (existente). Dispara só em `nivel='vermelho'` (>30min úteis; `amarelo` fica fora = ruído). Owner-scoped (`owner_user_id === ` vendedora efetiva, impersonation-aware). **100% frontend, read-only na view (zero colisão com #587), sem backend novo.** Não duplica `sem_resposta_repetido` (rota=ligação; este=WhatsApp).

**Tech Stack:** React + TS strict, vitest, `v_whatsapp_sla`/`useWhatsappSla`.

---

## Task 1: Tipos

**Files:** Modify `src/lib/fila/critica/types.ts`

- [ ] **Step 1: editar os tipos** — `TipoSinal` += `'whatsapp_sla'`; `ChaveContradicao` += `'wa_sem_resposta'`; novo `WaSlaCliente`; `CriticaInput` += `waSla`.

```ts
export type TipoSinal = 'order_delta' | 'rota_outcome' | 'tarefa_estado' | 'whatsapp_sla';

export type ChaveContradicao =
  | 'recorrente_sumiu'
  | 'sem_resposta_repetido'
  | 'tarefa_feita_sem_prova'
  | 'alto_valor_fora_rota'
  | 'wa_sem_resposta';
```

E adicionar (perto de `TarefaCliente`):

```ts
export interface WaSlaCliente {
  minutosUteis: number;
  nivel: 'verde' | 'amarelo' | 'vermelho'; // espelha SlaNivel; só 'vermelho' dispara
}
```

E no `CriticaInput`, adicionar o campo (depois de `tarefa`):

```ts
  tarefa: TarefaCliente | null; // null = sem tarefa atrelada a este cliente
  waSla: WaSlaCliente | null; // null = sem breach de WhatsApp aberto p/ este cliente (ou SLA não lido)
```

- [ ] **Step 2:** `bun run typecheck` → vai FALHAR nos construtores de `CriticaInput` (build-inputs.ts + montar.test.ts `base()`) por falta de `waSla`. Esperado — corrigido nas Tasks 3/2. (Não commitar ainda; seguir.)

---

## Task 2: Detector `detectWaSemResposta` + composer

**Files:** Modify `src/lib/fila/critica/montar.ts` · Test `src/lib/fila/critica/__tests__/montar.test.ts`

- [ ] **Step 1: teste que falha** — adicionar ao `montar.test.ts`. ⚠️ Primeiro **atualizar o factory `base()`** (que monta `CriticaInput`) pra incluir `waSla: null` no default (senão tudo quebra no typecheck). Depois o describe:

```ts
import { detectWaSemResposta } from '../montar';

describe('detectWaSemResposta', () => {
  it('dispara só em nivel vermelho (>30min úteis); amarelo/verde/null não', () => {
    const r = detectWaSemResposta(base({ waSla: { minutosUteis: 45, nivel: 'vermelho' } }), CRITICA_CFG_DEFAULT);
    expect(r.contradicao?.chave).toBe('wa_sem_resposta');
    expect(r.contradicao?.confianca).toBe('alta');
    expect(r.sinais[0].tipo).toBe('whatsapp_sla');
    expect(r.sinais[0].texto).toContain('45');
    expect(detectWaSemResposta(base({ waSla: { minutosUteis: 20, nivel: 'amarelo' } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectWaSemResposta(base({ waSla: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});

describe('montarEvidencePack inclui wa_sem_resposta', () => {
  it('compõe a contradição de WhatsApp', () => {
    const pack = montarEvidencePack(base({ waSla: { minutosUteis: 60, nivel: 'vermelho' } }));
    expect(pack.contradicoes.map(c => c.chave)).toContain('wa_sem_resposta');
  });
});
```

> Atualizar o factory `base()` no topo do arquivo de testes: `const base = (over) => ({ clienteUserId:'c1', clienteNome:'Cliente 1', metrica:null, rota:null, tarefa:null, waSla:null, ...over });` (adicionar `waSla:null`).

- [ ] **Step 2:** `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts` → FAIL (`detectWaSemResposta` não existe).

- [ ] **Step 3: implementar** — adicionar a `montar.ts` (depois de `detectAltoValorForaRota`, antes do composer):

```ts
// ── 5. wa_sem_resposta (WhatsApp esperando resposta humana — fonte v_whatsapp_sla) ──
export function detectWaSemResposta(input: CriticaInput, _cfg: CriticaCfg): DetectResult {
  const w = input.waSla;
  if (w == null || w.nivel !== 'vermelho') return { sinais: [], contradicao: null };
  const ev: SinalVoz = {
    tipo: 'whatsapp_sla',
    texto: `Esperando resposta no WhatsApp há ${w.minutosUteis} min (úteis)`,
    fonte: { tabela: 'v_whatsapp_sla', id: input.clienteUserId, observadoEm: null },
    severidade: 'critico',
  };
  return { sinais: [ev], contradicao: { chave: 'wa_sem_resposta', texto: 'Cliente sem resposta no WhatsApp', evidencias: [ev], confianca: 'alta' } };
}
```

E no composer `montarEvidencePack`, adicionar à lista `resultados`:

```ts
  const resultados = [
    detectRecorrenteSumiu(input, cfg),
    detectSemResposta(input, cfg),
    detectTarefaSemProva(input, cfg),
    detectAltoValorForaRota(input, cfg),
    detectWaSemResposta(input, cfg),
  ];
```

- [ ] **Step 4:** `bunx vitest run src/lib/fila/critica/__tests__/montar.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
git add src/lib/fila/critica/types.ts src/lib/fila/critica/montar.ts src/lib/fila/critica/__tests__/montar.test.ts
git commit -m "feat(critica): 5ª contradição wa_sem_resposta (detector + composer + tipos)"
```

---

## Task 3: Mapper `buildCriticaInputs` aceita o sinal de WhatsApp

**Files:** Modify `src/lib/fila/critica/build-inputs.ts` · Test `src/lib/fila/critica/__tests__/build-inputs.test.ts`

- [ ] **Step 1: teste que falha** — adicionar ao `build-inputs.test.ts`:

```ts
import type { WaSlaSinalCliente } from '../build-inputs';

it('mapeia waSla por cliente (vermelho); ausência → null', () => {
  const acoes = [acao('c1'), acao('c2')];
  const wa: WaSlaSinalCliente[] = [{ customerUserId: 'c1', minutosUteis: 45, nivel: 'vermelho' }];
  const out = buildCriticaInputs(acoes, [], null, [], wa);
  expect(out.find(i => i.clienteUserId === 'c1')!.waSla).toEqual({ minutosUteis: 45, nivel: 'vermelho' });
  expect(out.find(i => i.clienteUserId === 'c2')!.waSla).toBeNull();
});
```

- [ ] **Step 2:** `bunx vitest run src/lib/fila/critica/__tests__/build-inputs.test.ts` → FAIL.

- [ ] **Step 3: implementar** — em `build-inputs.ts`:

Adicionar a interface (perto de `TarefaSinalCliente`):

```ts
export interface WaSlaSinalCliente {
  customerUserId: string;
  minutosUteis: number;
  nivel: 'verde' | 'amarelo' | 'vermelho';
}
```

Estender a assinatura (5º param, default `[]` p/ não quebrar callers existentes) e o import de tipo:

```ts
import type { CriticaInput, MetricaCliente, RotaCliente, TarefaCliente, WaSlaCliente } from './types';
```
```ts
export function buildCriticaInputs(
  acoes: AcaoSugerida[],
  metricas: MetricRowFull[],
  rotaSinais: RotaSinalCliente[] | null,
  tarefaSinais: TarefaSinalCliente[],
  waSlaSinais: WaSlaSinalCliente[] = [],
): CriticaInput[] {
```

Adicionar o Map (perto dos outros `*ByCli`):

```ts
  const wByCli = new Map(waSlaSinais.map(s => [s.customerUserId, s]));
```

E no `out.push`, incluir `waSla`:

```ts
    const wRow = wByCli.get(cli);
    const waSla: WaSlaCliente | null = wRow ? { minutosUteis: wRow.minutosUteis, nivel: wRow.nivel } : null;

    out.push({ clienteUserId: cli, clienteNome: a.clienteNome, metrica, rota, tarefa, waSla });
```

- [ ] **Step 4:** `bunx vitest run src/lib/fila/critica/__tests__/build-inputs.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
git add src/lib/fila/critica/build-inputs.ts src/lib/fila/critica/__tests__/build-inputs.test.ts
git commit -m "feat(critica): buildCriticaInputs aceita sinal de WhatsApp SLA"
```

---

## Task 4: Hook `useCriticaFila` liga o `useWhatsappSla` (owner-scoped)

**Files:** Modify `src/hooks/useCriticaFila.ts`

- [ ] **Step 1: implementar** — adicionar imports:

```ts
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { buildCriticaInputs, type MetricRowFull, type RotaSinalCliente, type TarefaSinalCliente, type WaSlaSinalCliente } from '@/lib/fila/critica/build-inputs';
```

Dentro do hook, antes do `useMemo` de retorno:

```ts
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const donoEfetivo = isImpersonating && effectiveUserId ? effectiveUserId : (user?.id ?? null);
  const slaQ = useWhatsappSla();
```

Dentro do `useMemo` de retorno, montar `waSlaSinais` (filtra dono efetivo + cliente não-nulo + breach pode ser amarelo/vermelho; o detector decide o vermelho) e passar pro mapper:

```ts
    const waSlaSinais: WaSlaSinalCliente[] = (slaQ.data ?? [])
      .filter(r => r.customer_user_id != null && donoEfetivo != null && r.owner_user_id === donoEfetivo)
      .map(r => ({ customerUserId: r.customer_user_id as string, minutosUteis: r.minutos_uteis_aguardando, nivel: r.nivel }));

    const topAcoes = acoes.filter(a => a.clienteUserId != null && topIds.includes(a.clienteUserId));
    const inputs = buildCriticaInputs(topAcoes, metricsQ.data ?? [], rotaSinais, tarefaSinais, waSlaSinais);
```

E adicionar `slaQ.data`, `donoEfetivo` às deps do `useMemo` de retorno.

> Degradação honesta: `slaQ` erro/loading → `slaQ.data` undefined → `waSlaSinais=[]` → sem contradição de WhatsApp (o card NUNCA é escondido por isso; consistente com a fonte `tarefa`). `r.nivel` vem como `SlaNivel` (`'verde'|'amarelo'|'vermelho'`), assignable ao `WaSlaSinalCliente.nivel`.

- [ ] **Step 2:** `bun run typecheck && bun lint` → PASS (0 errors).

- [ ] **Step 3: commit**

```bash
git add src/hooks/useCriticaFila.ts
git commit -m "feat(critica): useCriticaFila liga v_whatsapp_sla (owner-scoped, impersonation-aware)"
```

---

## Task 5: Health gate

- [ ] **Step 1:** `heavy bun run typecheck` → PASS · `heavy bun run test` → PASS (incl. critica) · `bun lint` → 0 errors · `heavy bun run build` → OK.
- [ ] **Step 2: nota** — sem migration/edge/cron; deploy = Publish. PorQueAgora.tsx renderiza a contradição genericamente (sem mudança). v1 spec §6: o `wa_sem_resposta` sai de ⏸️ p/ ✅. Limiar `vermelho` calibrável.

---

## Self-Review

- **Cobertura:** detector wa_sem_resposta (Task 2) + composer (Task 2) + mapper (Task 3) + wiring/owner-scope (Task 4) + gate (Task 5). ✅
- **Placeholders:** nenhum; código completo. ✅
- **Consistência de tipos:** `TipoSinal`/`ChaveContradicao`/`WaSlaCliente`/`CriticaInput.waSla` (Task 1) usados por `detectWaSemResposta`/`buildCriticaInputs`/`useCriticaFila`. `nivel` union idêntico nos 3 lugares (types, build-inputs, hook via SlaNivel). `r.minutos_uteis_aguardania`→ **`minutos_uteis_aguardando`** (campo real do `WaSlaRow`). 5º param default `[]` não quebra callers existentes. ⚠️ O factory `base()` do `montar.test.ts` precisa de `waSla:null` (Task 2 Step 1) e o `out.push` do build-inputs precisa de `waSla` (Task 3) — senão typecheck quebra. ✅
- **Não-dup:** `sem_resposta_repetido` (rota) × `wa_sem_resposta` (WhatsApp) são canais distintos; ambos podem disparar (ok). ✅
