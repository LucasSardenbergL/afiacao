# Closed-loop da Lista de Ligação (PR2c) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development ou executing-plans.

**Goal:** Fechar o ciclo da lista de ligação: registrar o resultado da ligação (manual, 1 toque) → derivar cadência/opt-out/convertido reais de `route_contact_log` → alimentar o motor `buildContactList` (inalterado) → esconder/marcar na fila + métrica do dia.

**Architecture:** Helper puro testável (`route-outcome.ts`) deriva os sinais; o hook `useRouteContactList` lê o log e injeta os sinais nos campos hoje hardcoded; a escrita é por RPC `SECURITY DEFINER` (dedupe + ownership server-side); a UI ganha menu de outcome + badges + undo. O motor `contact-list.ts` NÃO muda.

**Tech Stack:** React 18 + TS, @tanstack/react-query, Supabase RPC, sonner (toast/undo), vitest (TDD). Spec: `docs/superpowers/specs/2026-05-31-rota-closed-loop-design.md`.

---

### Task 1: `spBusinessDate` — instante → data de negócio SP (TDD)

**Files:**
- Modify: `src/lib/time/sp-day.ts`
- Test: `src/lib/time/sp-day.test.ts` (criar se não existe)

- [ ] **Step 1: Teste** — `spBusinessDate` resolve a data SP de um instante UTC, incl. fronteira de meia-noite.

```ts
import { describe, it, expect } from 'vitest';
import { spBusinessDate } from './sp-day';

describe('spBusinessDate', () => {
  it('22h em SP (01:00Z do dia seguinte) ainda é o dia local', () => {
    // 2026-06-01T01:00:00Z = 2026-05-31 22:00 em SP (UTC-3)
    expect(spBusinessDate('2026-06-01T01:00:00Z')).toBe('2026-05-31');
  });
  it('meio-dia UTC = mesmo dia em SP', () => {
    expect(spBusinessDate('2026-05-31T12:00:00Z')).toBe('2026-05-31');
  });
  it('aceita Date', () => {
    expect(spBusinessDate(new Date('2026-05-31T12:00:00Z'))).toBe('2026-05-31');
  });
});
```

- [ ] **Step 2: Rodar (falha)** — `heavy bun run test src/lib/time/sp-day.test.ts` → FAIL (export não existe).
- [ ] **Step 3: Implementar** — adiciona ao fim de `sp-day.ts`:

```ts
const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});
/** Data de NEGÓCIO (yyyy-mm-dd) de um instante, no fuso America/Sao_Paulo. */
export function spBusinessDate(instant: Date | string): string {
  return SP_DATE_FMT.format(typeof instant === 'string' ? new Date(instant) : instant);
}
```

- [ ] **Step 4: Rodar (passa)** — `heavy bun run test src/lib/time/sp-day.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(time): spBusinessDate (instante → data SP)`.

---

### Task 2: Helper puro `route-outcome.ts` — derivação dos sinais (TDD, coração)

**Files:**
- Create: `src/lib/route/route-outcome.ts`
- Test: `src/lib/route/route-outcome.test.ts`

- [ ] **Step 1: Testes** (cobre o spec §6 — escrever ANTES da implementação):

```ts
import { describe, it, expect } from 'vitest';
import { derivarSinaisContato, type ContatoLog } from './route-outcome';

const HOJE = '2026-05-31';
const ROTA = '2026-06-01'; // fila D-1: liga hoje p/ rota de amanhã
const reg = (status: ContatoLog['status'], dataNegocio: string, dataRota = ROTA): ContatoLog =>
  ({ status, dataNegocio, dataRota });

describe('derivarSinaisContato', () => {
  it('lista vazia → defaults seguros', () => {
    const s = derivarSinaisContato([], HOJE, ROTA);
    expect(s).toMatchObject({ optOut: false, jaConvertidoNaRota: false, contatadoHaDiasParaGate: null, semRespostaRecenteN: 0, cadenciaBloqueadaPor: null });
  });
  it('opt_out é sticky SEM janela (100d atrás ainda bloqueia)', () => {
    const s = derivarSinaisContato([reg('opt_out', '2026-02-20')], HOJE, ROTA);
    expect(s.optOut).toBe(true);
  });
  it('jaConvertidoNaRota casa por data_rota (não created_at) — convertido p/ a rota da fila', () => {
    // registrado hoje (dataNegocio=hoje) p/ a rota de amanhã (dataRota=ROTA)
    const s = derivarSinaisContato([reg('convertido', HOJE, ROTA)], HOJE, ROTA);
    expect(s.jaConvertidoNaRota).toBe(true);
  });
  it('convertido de OUTRA rota não esconde na fila atual', () => {
    const s = derivarSinaisContato([reg('convertido', '2026-05-20', '2026-05-21')], HOJE, ROTA);
    expect(s.jaConvertidoNaRota).toBe(false);
  });
  it('contato real → contatadoHaDiasParaGate = dias do mais recente', () => {
    const s = derivarSinaisContato([reg('respondido', '2026-05-29')], HOJE, ROTA); // 2 dias
    expect(s.ultimoContatoRealHaDias).toBe(2);
    expect(s.contatadoHaDiasParaGate).toBe(2);
    expect(s.cadenciaBloqueadaPor).toBe('real');
  });
  it('sem_resposta ISOLADO (N<3) NÃO bloqueia — só badge', () => {
    const s = derivarSinaisContato([reg('sem_resposta', '2026-05-30')], HOJE, ROTA); // ontem
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.contatadoHaDiasParaGate).toBeNull(); // não bloqueia o retry curto
  });
  it('3 linhas sem_resposta no MESMO dia = N=1 (conta DIAS, não linhas)', () => {
    const s = derivarSinaisContato([reg('sem_resposta','2026-05-30'), reg('sem_resposta','2026-05-30'), reg('sem_resposta','2026-05-30')], HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.contatadoHaDiasParaGate).toBeNull();
  });
  it('sem_resposta em ≥3 DIAS distintos (janela 7d) bloqueia', () => {
    const s = derivarSinaisContato([reg('sem_resposta','2026-05-29'), reg('sem_resposta','2026-05-28'), reg('sem_resposta','2026-05-27')], HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(3);
    expect(s.contatadoHaDiasParaGate).toBe(2); // mais recente dos 3
    expect(s.cadenciaBloqueadaPor).toBe('sem_resposta_esgotada');
  });
  it('respondido há 10d + sem_resposta ontem (N=1) → gate=10 (real manda; não bloqueia retry curto)', () => {
    const s = derivarSinaisContato([reg('respondido','2026-05-21'), reg('sem_resposta','2026-05-30')], HOJE, ROTA);
    expect(s.contatadoHaDiasParaGate).toBe(10);
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.cadenciaBloqueadaPor).toBe('real');
  });
  it('sem_resposta fora da janela (8d) não conta', () => {
    const s = derivarSinaisContato([reg('sem_resposta','2026-05-23')], HOJE, ROTA); // 8 dias
    expect(s.semRespostaRecenteN).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar (falha)** — `heavy bun run test src/lib/route/route-outcome.test.ts` → FAIL.
- [ ] **Step 3: Implementar** `route-outcome.ts`:

```ts
export type OutcomeStatus = 'convertido' | 'respondido' | 'sem_resposta' | 'opt_out';
export const OUTCOME_STATUSES: OutcomeStatus[] = ['convertido', 'respondido', 'sem_resposta', 'opt_out'];

export interface ContatoLog {
  status: OutcomeStatus;
  dataNegocio: string; // 'yyyy-mm-dd' (created_at em SP)
  dataRota: string;    // 'yyyy-mm-dd' (coluna data_rota gravada)
}
export interface CadenciaCfg { limiarSemResposta: number; janelaCadenciaDias: number; }
export const CADENCIA_DEFAULT: CadenciaCfg = { limiarSemResposta: 3, janelaCadenciaDias: 7 };

export interface SinaisContato {
  optOut: boolean;
  jaConvertidoNaRota: boolean;
  contatadoHaDiasParaGate: number | null; // o ÚNICO que vira ContactCandidate.contatadoHaDias
  ultimoContatoRealHaDias: number | null;
  semRespostaRecenteN: number;
  ultimaSemRespostaHaDias: number | null;
  cadenciaBloqueadaPor: 'real' | 'sem_resposta_esgotada' | null;
}

/** Dias de calendário entre duas datas iso 'yyyy-mm-dd' (a − b). Parse UTC → imune a fuso/DST. */
export function diasEntreIso(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(a) - p(b)) / 86_400_000);
}

export function derivarSinaisContato(
  registros: ContatoLog[], hoje: string, dataRotaFila: string, cfg: CadenciaCfg = CADENCIA_DEFAULT,
): SinaisContato {
  const optOut = registros.some(r => r.status === 'opt_out'); // sticky, sem janela
  const jaConvertidoNaRota = registros.some(r => r.status === 'convertido' && r.dataRota === dataRotaFila);

  // contato REAL (respondido/convertido) — "há X dias" do mais recente (menor X)
  const reaisDias = registros
    .filter(r => r.status === 'respondido' || r.status === 'convertido')
    .map(r => diasEntreIso(hoje, r.dataNegocio))
    .filter(d => d >= 0);
  const ultimoContatoRealHaDias = reaisDias.length ? Math.min(...reaisDias) : null;

  // sem_resposta na janela — conta DIAS distintos, não linhas
  const semRespNaJanela = registros.filter(r => {
    if (r.status !== 'sem_resposta') return false;
    const d = diasEntreIso(hoje, r.dataNegocio);
    return d >= 0 && d <= cfg.janelaCadenciaDias;
  });
  const diasDistintos = new Set(semRespNaJanela.map(r => r.dataNegocio));
  const semRespostaRecenteN = diasDistintos.size;
  const semRespDias = semRespNaJanela.map(r => diasEntreIso(hoje, r.dataNegocio));
  const ultimaSemRespostaHaDias = semRespDias.length ? Math.min(...semRespDias) : null;

  // bloqueio: real sempre bloqueia; sem_resposta só quando esgotado (≥ limiar)
  const diasReal = ultimoContatoRealHaDias;
  const diasSemRespEsgotada = semRespostaRecenteN >= cfg.limiarSemResposta ? ultimaSemRespostaHaDias : null;
  const candidatos = [diasReal, diasSemRespEsgotada].filter((d): d is number => d != null);
  const contatadoHaDiasParaGate = candidatos.length ? Math.min(...candidatos) : null;
  let cadenciaBloqueadaPor: SinaisContato['cadenciaBloqueadaPor'] = null;
  if (contatadoHaDiasParaGate != null) {
    cadenciaBloqueadaPor = diasReal != null && diasReal === contatadoHaDiasParaGate ? 'real' : 'sem_resposta_esgotada';
  }

  return { optOut, jaConvertidoNaRota, contatadoHaDiasParaGate, ultimoContatoRealHaDias, semRespostaRecenteN, ultimaSemRespostaHaDias, cadenciaBloqueadaPor };
}
```

- [ ] **Step 4: Rodar (passa)** — `heavy bun run test src/lib/route/route-outcome.test.ts` → PASS (11 testes).
- [ ] **Step 5: Commit** — `feat(rota): helper puro de derivação de sinais de contato (TDD)`.

---

### Task 3: Migration — RPC de escrita `route_contact_log` (manual apply)

**Files:**
- Create: `supabase/migrations/20260531170000_route_contact_log_escrita.sql`

- [ ] **Step 1: Escrever a migration** (idempotente, `CREATE OR REPLACE`):

```sql
-- Closed-loop da lista de ligação (PR2c): escrita do log por staff via RPC SECURITY DEFINER.
-- Hoje route_contact_log só tem policy de SELECT (staff); escrita era 'service_role' (PR2b).
-- A RPC seta farmer_id server-side (anti-IDOR), canal fixo 'ligacao', dedupe 2min, gate staff.

CREATE OR REPLACE FUNCTION public.registrar_contato_rota(
  p_customer_user_id uuid, p_status text, p_data_rota date,
  p_bucket text DEFAULT NULL, p_valor numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_existing uuid; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_uid AND ur.role IN ('employee','master')) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  IF p_customer_user_id IS NULL THEN RAISE EXCEPTION 'customer_user_id required'; END IF;
  IF p_data_rota IS NULL THEN RAISE EXCEPTION 'data_rota required'; END IF;
  IF p_status NOT IN ('convertido','respondido','sem_resposta','opt_out') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;
  -- Codex P0: staff responde "é staff?" mas não "pode afetar ESTE cliente?". Exige visibilidade de carteira.
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)
          OR public.carteira_visivel_para(p_customer_user_id, v_uid)) THEN
    RAISE EXCEPTION 'forbidden: customer not visible';
  END IF;
  -- Codex P1: serializa o dedupe por chave lógica (evita race do SELECT→INSERT em double-click concorrente).
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_uid::text||':'||p_customer_user_id::text||':'||p_data_rota::text||':'||p_status||':ligacao', 0));
  -- dedupe idempotente: mesmo vendedor+cliente+rota+status nos últimos 2 min → devolve o existente
  SELECT id INTO v_existing FROM public.route_contact_log
   WHERE farmer_id = v_uid AND customer_user_id = p_customer_user_id
     AND data_rota = p_data_rota AND status = p_status AND canal = 'ligacao'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;
  INSERT INTO public.route_contact_log (data_rota, customer_user_id, farmer_id, canal, valor_da_ligacao, bucket, status)
  VALUES (p_data_rota, p_customer_user_id, v_uid, 'ligacao', p_valor, p_bucket, p_status)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- Undo curto: deleta SÓ o próprio registro recente (own + < 5 min) — suporta o "Desfazer" do UI.
-- Codex: retorna {deleted} (não no-op silencioso) p/ a UI não mostrar "desfeito" quando expirou.
CREATE OR REPLACE FUNCTION public.desfazer_contato_rota(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.route_contact_log
   WHERE id = p_id AND farmer_id = auth.uid() AND created_at > now() - interval '5 minutes';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('deleted', v_deleted > 0);
END $$;

REVOKE ALL ON FUNCTION public.registrar_contato_rota(uuid,text,date,text,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.desfazer_contato_rota(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_rota(uuid,text,date,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_rota(uuid) TO authenticated;
```

- [ ] **Step 2: Query de validação** (pro PR/founder colar depois do apply):

```sql
SELECT 'rpc registrar' AS o, count(*) FROM pg_proc WHERE proname='registrar_contato_rota'
UNION ALL SELECT 'rpc desfazer', count(*) FROM pg_proc WHERE proname='desfazer_contato_rota'
UNION ALL SELECT 'route_contact_log existe', count(*) FROM information_schema.tables WHERE table_name='route_contact_log';
```

- [ ] **Step 3: Commit** — `feat(rota): migration RPC de escrita do route_contact_log`. (Apply é MANUAL via SQL Editor — entregar no PR + na conversa.)

---

### Task 4: Hook — leitura do log + injeção dos sinais + mutations

**Files:**
- Modify: `src/queries/useRouteContactList.ts`
- Create: `src/queries/useRegistrarContato.ts`

- [ ] **Step 1:** Em `useRouteContactList`, após montar `userIds` da fila, ler o log e derivar:
  - `routeFrom('route_contact_log').select('customer_user_id, status, created_at, data_rota')` com `.in('customer_user_id', chunk)` (IN_CHUNK), SEM filtro de data (conjunto já limitado aos clientes da fila → opt_out full-history de graça).
  - agrupar por `customer_user_id`; cada registro → `{ status, dataNegocio: spBusinessDate(created_at), dataRota: data_rota }`.
  - `hoje = spBusinessDate(new Date())`; `dataRotaFila = prep.routeDate`.
  - `const sinais = derivarSinaisContato(regsDoCliente, hoje, dataRotaFila)`.
  - injetar no candidato: `optOut: sinais.optOut`, `contatadoHaDias: sinais.contatadoHaDiasParaGate`, `fechouHoje: sinais.jaConvertidoNaRota`. (mantém `janela24hAberta:false` — é WhatsApp, fora de escopo.)
  - estender `RouteContactItem` com os campos de badge (`ultimoContatoRealHaDias`, `semRespostaRecenteN`, `cadenciaBloqueadaPor`, `jaConvertidoNaRota`) — anexados no `enrich`.
  - **degradação honesta:** se a leitura do log falhar (`try/catch`), usar os defaults hardcoded atuais (fila funciona como hoje) — falha de leitura NÃO esconde cliente.
  - expor a lista de "resolvidos na rota" (convertidos) p/ a UI: derivar dos sinais (`jaConvertidoNaRota`) OU separar uma `resolvidosQueue`.

- [ ] **Step 2:** `useRegistrarContato.ts` — mutations:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
type RpcClient = { rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
const rpc = () => supabase as unknown as RpcClient;

export function useRegistrarContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { customerUserId: string; status: string; dataRota: string; bucket?: string | null; valor?: number | null }) => {
      const { data, error } = await rpc().rpc('registrar_contato_rota', {
        p_customer_user_id: v.customerUserId, p_status: v.status, p_data_rota: v.dataRota, p_bucket: v.bucket ?? null, p_valor: v.valor ?? null,
      });
      if (error) throw new Error(error.message);
      track('rota.contato_registrado', { status: v.status });
      return data as { id: string; deduped: boolean };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
  });
}
export function useDesfazerContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rpc().rpc('desfazer_contato_rota', { p_id: id });
      if (error) throw new Error(error.message);
      track('rota.contato_desfeito', {});
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
  });
}
```

- [ ] **Step 3:** `heavy bun run test` + `heavy bun run typecheck` (o hook usa os novos tipos). Commit — `feat(rota): hook lê route_contact_log e injeta cadência real + mutations`.

---

### Task 5: UI — menu de outcome, confirmação, undo, badges, métrica

**Files:**
- Modify: `src/pages/RotaListaLigacao.tsx`
- Create: `src/components/call/OutcomeMenu.tsx`

- [ ] **Step 1:** `OutcomeMenu.tsx` — `DropdownMenu` com 4 itens (Fechou pedido / Falou, via pensar / Não atendeu / Não quer ser ligado). `opt_out` → `AlertDialog` de confirmação ("Não ligar novamente para {nome}?"). Ao confirmar/registrar, chama `useRegistrarContato` e dispara `toast` com action **Desfazer** (~5s) → `useDesfazerContato(id)`. Touch-friendly (`size="touch"`).

```tsx
// trecho central: ao escolher um status
const reg = useRegistrarContato(); const undo = useDesfazerContato();
const registrar = async (status: string) => {
  const r = await reg.mutateAsync({ customerUserId, status, dataRota, bucket, valor });
  if (!r.deduped) toast.success(LABEL[status], { action: { label: 'Desfazer', onClick: () => undo.mutate(r.id) } });
};
```

- [ ] **Step 2:** Em `RotaListaLigacao.tsx`: cada `<li>` ganha o `<OutcomeMenu>` ao lado do `<CallButton>`. Badges: "contatado há {ultimoContatoRealHaDias}d" e "sem resposta {semRespostaRecenteN}×" (quando >0). Os `convertido`-na-rota saem da `callQueue` (o gate já exclui por `fechouHoje`) e aparecem numa seção **"Resolvidos hoje"** (lista separada do hook). Métrica do topo: `N ligados · N atenderam · N fecharam` (client-side do log do dia, `dataNegocio===hoje`).

- [ ] **Step 3:** `heavy bun run test && heavy bun run typecheck && heavy bun lint` → limpo. Commit — `feat(rota): UI de outcome + badges + undo + métrica do dia`.

---

### Task 6: Validação + Codex adversarial + docs + PR

- [ ] **Step 1:** `heavy bun run typecheck && heavy bun run test && heavy bun lint && heavy bun run build` — tudo verde.
- [ ] **Step 2:** Codex adversarial no DIFF (foco: a derivação, a RPC SQL [injeção/RLS/dedupe], degradação honesta, fuso). Incorporar P1/P2.
- [ ] **Step 3:** Registrar no `CLAUDE.md` §5 (closed-loop PR2c) + nota "⚠️ migration manual" no PR. Confirmar existência da tabela em prod via query (SQL Editor) antes do apply.
- [ ] **Step 4:** PR `feat(rota): closed-loop da lista de ligação (PR2c)` + body com o SQL da migration + validação. `gh pr merge --squash --auto`.

---

## Self-review do plano
- **Cobertura do spec:** §4.1 (vocabulário) → Task 5; §4.2 (RPC) → Task 3; §4.3 (helper) → Task 2 + Task 1 (fuso); §4.4 (hook) → Task 4; §4.5 (UI/métrica) → Task 5; §5 (degradação/risco) → Task 4 step 1 (try/catch) + Task 5 (confirmação/undo); §6 (testes) → Task 2 step 1. ✅
- **Tipos consistentes:** `SinaisContato.contatadoHaDiasParaGate` → injetado como `ContactCandidate.contatadoHaDias`; `jaConvertidoNaRota` → `fechouHoje`. Motor inalterado. ✅
- **Sem placeholder:** helper e RPC têm código completo; Tasks 4-5 têm os trechos-chave + arquivos exatos. ✅

## Correções do Codex no plano (incorporar na execução)
- **Task 2 (+5 testes):** (a) real-antigo-10d + sem_resposta-esgotada-3dias → `gate=1`, motivo `'sem_resposta_esgotada'` (pega `Math.max` no desempate); (b) 2-dentro-janela + 1-fora → `N=2`, **não** bloqueia; (c) off-by-one: `sem_resposta` a 7d conta, 8d não; (d) datas FUTURAS ignoradas (negativo não bloqueia tudo) — `filter(d => d >= 0)`; (e) **corrigir** o teste "convertido de outra rota": `jaConvertidoNaRota=false` MAS ainda é contato real (`ultimoContatoRealHaDias`/`contatadoHaDiasParaGate` refletem) — `reg('convertido', HOJE, '2026-05-31')` → gate=0, `'real'`.
- **Task 3 (RPC):** ✅ já atualizada acima — check de carteira (`pode_ver_carteira_completa OR carteira_visivel_para`), advisory lock, NOT NULL guards, `desfazer` retorna `{deleted}`.
- **Task 4 (hook):** ler o log em **2 queries** (evita `.or()` com template literal — regra anti-injeção do lint): `(A)` `.in(chunk).eq('status','opt_out')` full-history (sticky) + `(B)` `.in(chunk).gte('created_at', cutoff90d)` cadência; mesclar por `id`. Retornar **`dailyStats`** `{ligados, atenderam, fecharam}` (dos registros lidos com `dataNegocio===hoje`) e **`resolvidosQueue`** (enriquecer os `result.excluidos` com `motivoGate==='fechou_hoje'` — têm nome/telefone p/ a seção "Resolvidos hoje"). Fail-open: `try/catch` → defaults + `logger.warn` + flag `cadenciaIndisponivel` p/ a UI avisar discreto.
- **Fix pré-existente (Codex):** `RotaListaLigacao.tsx` usa `new Date().toISOString().slice(0,10)` p/ `workday` → às 22-23h SP vira o dia UTC seguinte → rota errada. Trocar `todayIso()` por `spBusinessDate(new Date())`.
