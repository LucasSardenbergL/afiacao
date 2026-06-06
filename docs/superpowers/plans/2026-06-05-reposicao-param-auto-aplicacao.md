# Reposição — Auto-aplicação de parâmetros (olho + freio) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o auto-apply de parâmetros de reposição (que já roda) seguro, registrado, visível e reversível — sem o founder revisar no dia a dia.

**Architecture:** Instrumentar o motor SQL existente (`atualizar_parametros_numericos_skus`) com validação dura + fusível + trava de reversão + log antes→depois; um wrapper diário cria o run; um cron das 18h pré-renderiza o resumo e enfileira em `fornecedor_alerta` (→ `dispatch-notifications`); uma tela no app reverte por `run_id`. Um helper puro TS (vitest) é o oráculo que a SQL espelha; a SQL é provada em PostgreSQL 17 local. Sem edge function nova; o único toque no edge `omie-cron-diario` é trocar 1 chamada.

**Tech Stack:** PostgreSQL (plpgsql, pg_cron), Supabase RLS/RPC, React + TanStack Query + TypeScript, vitest, `db/verify-snapshot-replay.sh` (PG17 local).

**Spec:** `docs/superpowers/specs/2026-06-05-reposicao-param-auto-aplicacao-design.md` — leia antes de começar.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/lib/reposicao/param-auto-helpers.ts` | Oráculo puro: validação, fusível, fingerprint, pin, impacto, `decideStatus` (precedência) | Criar |
| `src/lib/reposicao/__tests__/param-auto-helpers.test.ts` | TDD do oráculo (vitest) | Criar |
| `supabase/migrations/20260605120000_param_auto_tabelas.sql` | 3 tabelas + RLS + índices + seeds `company_config` + CHECK `fornecedor_alerta` | Criar |
| `supabase/migrations/20260605130000_param_auto_core.sql` | DROP+CREATE `atualizar_parametros_numericos_skus(text,uuid)` com decisão + log | Criar |
| `supabase/migrations/20260605140000_param_auto_wrapper_revert_cron.sql` | wrapper diário + RPCs revert/pin + cron resumo | Criar |
| `db/test-param-auto.sh` | Prova PG17: aplica/segura/bloqueia/pina/idempotência/revert/conflito/impacto | Criar |
| `supabase/functions/omie-cron-diario/index.ts` | Trocar a chamada da core pelo wrapper diário (1 linha) | Modificar |
| `src/hooks/useParamAutoMudancas.ts` | Lê run/log do dia + mutations de revert/despin | Criar |
| `src/pages/ParamAutoMudancas.tsx` | Tela "Mudanças automáticas" | Criar |
| `src/App.tsx` + `src/components/AppShell.tsx` | Rota `/admin/reposicao/mudancas-automaticas` + nav | Modificar |

Ordem de execução: Task 1 (oráculo) → Tasks 2-4 (SQL) → Task 5 (prova PG17) → Task 6 (edge) → Tasks 7-8 (front) → Task 9 (rollout manual).

---

## Task 1: Helper puro (oráculo da SQL)

**Files:**
- Create: `src/lib/reposicao/param-auto-helpers.ts`
- Test: `src/lib/reposicao/__tests__/param-auto-helpers.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

```ts
// src/lib/reposicao/__tests__/param-auto-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  passaValidacao, disparaFusivel, fingerprintMaterial, pinBloqueia,
  impactoSimulado, decideStatus, type SugestaoParam, type LimiaresFusivel,
} from '@/lib/reposicao/param-auto-helpers';

const LIM: LimiaresFusivel = { mult: 3, coberturaDias: 120 };
const ok: SugestaoParam = { ponto_pedido: 50, estoque_minimo: 20, estoque_maximo: 120, estoque_seguranca: 15, cobertura_alvo_dias: 30 };

describe('passaValidacao', () => {
  it('aceita sugestão coerente', () => { expect(passaValidacao(ok).ok).toBe(true); });
  it('rejeita campo nulo', () => { expect(passaValidacao({ ...ok, estoque_maximo: null }).ok).toBe(false); });
  it('rejeita não-finito', () => { expect(passaValidacao({ ...ok, ponto_pedido: Number.NaN }).ok).toBe(false); });
  it('rejeita negativo', () => { expect(passaValidacao({ ...ok, estoque_minimo: -1 }).ok).toBe(false); });
  it('rejeita max < pp', () => { expect(passaValidacao({ ...ok, estoque_maximo: 40 }).ok).toBe(false); });
  it('rejeita pp < min', () => { expect(passaValidacao({ ...ok, ponto_pedido: 10 }).ok).toBe(false); });
  it('rejeita cobertura <= 0', () => { expect(passaValidacao({ ...ok, cobertura_alvo_dias: 0 }).ok).toBe(false); });
});

describe('disparaFusivel', () => {
  it('não segura mudança normal', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 150 }, 4, LIM).segurado).toBe(false);
  });
  it('segura salto > 3x do anterior', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 301 }, 4, LIM).segurado).toBe(true);
  });
  it('segura cobertura implícita > 120 dias', () => {
    // demanda 1/dia, máximo 200 → 200 dias de cobertura
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 200 }, 1, LIM).segurado).toBe(true);
  });
  it('sem anterior não dispara por multiplicador (mas dispara por cobertura)', () => {
    expect(disparaFusivel(null, { ...ok, estoque_maximo: 9999 }, 100, LIM).segurado).toBe(false); // 9999/100=100d < 120
    expect(disparaFusivel(null, { ...ok, estoque_maximo: 9999 }, 1, LIM).segurado).toBe(true);   // cobertura
  });
  it('demanda nula não divide por zero', () => {
    expect(() => disparaFusivel(100, { ...ok, estoque_maximo: 150 }, null, LIM)).not.toThrow();
  });
});

describe('fingerprintMaterial / pinBloqueia', () => {
  it('fingerprint arredonda pp+max', () => {
    expect(fingerprintMaterial(50.4, 120.6)).toBe('50|121');
  });
  it('pin bloqueia quando pp+max iguais (arredondados)', () => {
    expect(pinBloqueia(50, 120, { ...ok, ponto_pedido: 50.2, estoque_maximo: 119.8 })).toBe(true);
  });
  it('pin libera quando pp ou max muda materialmente', () => {
    expect(pinBloqueia(50, 120, { ...ok, ponto_pedido: 60, estoque_maximo: 120 })).toBe(false);
  });
});

describe('impactoSimulado', () => {
  it('Δ qtde × custo quando posição <= pp', () => {
    // antes: pp 50, max 120; depois: pp 50, max 150; posição 40 (<=50) → qtde 80→110, Δ30 × 5 = 150
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 40, custo: 5 });
    expect(r.qtdeAntes).toBe(80); expect(r.qtdeDepois).toBe(110); expect(r.impactoRs).toBe(150);
  });
  it('qtde 0 quando posição > pp', () => {
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 60, custo: 5 });
    expect(r.qtdeAntes).toBe(0); expect(r.qtdeDepois).toBe(0); expect(r.impactoRs).toBe(0);
  });
  it('custo nulo → impacto desconhecido (null), não zero', () => {
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 40, custo: null });
    expect(r.impactoRs).toBeNull();
  });
});

describe('decideStatus (precedência validação → fusível → pin → aplicado)', () => {
  it('bloqueado_validacao vence tudo', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, estoque_maximo: 10 }, demandaMediaDiaria: 4, pin: null, limiares: LIM })).toBe('bloqueado_validacao');
  });
  it('segurado vence pin e aplicado', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 100 }, sugestao: { ...ok, estoque_maximo: 400 }, demandaMediaDiaria: 4, pin: { pp: 50, max: 400 }, limiares: LIM })).toBe('segurado');
  });
  it('pinado quando sugestão == rejeitada', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, ponto_pedido: 50, estoque_maximo: 120 }, demandaMediaDiaria: 4, pin: { pp: 50, max: 120 }, limiares: LIM })).toBe('pinado');
  });
  it('aplicado quando difere do atual e do rejeitado', () => {
    expect(decideStatus({ antes: { ...ok, ponto_pedido: 40, estoque_maximo: 100 }, sugestao: ok, demandaMediaDiaria: 4, pin: { pp: 50, max: 999 }, limiares: LIM })).toBe('aplicado');
  });
  it('sem_mudanca quando igual ao atual (arredondado)', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok }, demandaMediaDiaria: 4, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test src/lib/reposicao/__tests__/param-auto-helpers.test.ts`
Expected: FAIL ("Cannot find module '@/lib/reposicao/param-auto-helpers'").

- [ ] **Step 3: Implementar o helper**

```ts
// src/lib/reposicao/param-auto-helpers.ts
export interface SugestaoParam {
  ponto_pedido: number | null;
  estoque_minimo: number | null;
  estoque_maximo: number | null;
  estoque_seguranca: number | null;
  cobertura_alvo_dias: number | null;
}
export interface LimiaresFusivel { mult: number; coberturaDias: number; }
export type StatusAuto = 'bloqueado_validacao' | 'segurado' | 'pinado' | 'aplicado' | 'sem_mudanca';

const arred = (n: number) => Math.round(n);
const finitoNaoNeg = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function passaValidacao(s: SugestaoParam): { ok: boolean; motivo: string | null } {
  const campos = [s.ponto_pedido, s.estoque_minimo, s.estoque_maximo, s.estoque_seguranca, s.cobertura_alvo_dias];
  if (!campos.every(finitoNaoNeg)) return { ok: false, motivo: 'campo nulo/não-finito/negativo' };
  if (s.estoque_maximo! < s.ponto_pedido!) return { ok: false, motivo: 'max < pp' };
  if (s.ponto_pedido! < s.estoque_minimo!) return { ok: false, motivo: 'pp < min' };
  if (s.cobertura_alvo_dias! <= 0) return { ok: false, motivo: 'cobertura <= 0' };
  return { ok: true, motivo: null };
}

export function disparaFusivel(
  maxAntes: number | null, s: SugestaoParam, demandaMediaDiaria: number | null, lim: LimiaresFusivel,
): { segurado: boolean; motivo: string | null } {
  if (typeof s.estoque_maximo !== 'number' || !Number.isFinite(s.estoque_maximo)) return { segurado: false, motivo: null };
  if (typeof maxAntes === 'number' && maxAntes > 0 && s.estoque_maximo > lim.mult * maxAntes) {
    return { segurado: true, motivo: `máximo ${s.estoque_maximo} > ${lim.mult}× anterior ${maxAntes}` };
  }
  if (typeof demandaMediaDiaria === 'number' && demandaMediaDiaria > 0) {
    const coberturaDias = s.estoque_maximo / demandaMediaDiaria;
    if (coberturaDias > lim.coberturaDias) return { segurado: true, motivo: `cobertura ${Math.round(coberturaDias)}d > ${lim.coberturaDias}d` };
  }
  return { segurado: false, motivo: null };
}

export function fingerprintMaterial(pontoPedido: number, estoqueMaximo: number): string {
  return `${arred(pontoPedido)}|${arred(estoqueMaximo)}`;
}

export function pinBloqueia(rejeitadoPp: number, rejeitadoMax: number, s: SugestaoParam): boolean {
  if (typeof s.ponto_pedido !== 'number' || typeof s.estoque_maximo !== 'number') return false;
  return fingerprintMaterial(s.ponto_pedido, s.estoque_maximo) === fingerprintMaterial(rejeitadoPp, rejeitadoMax);
}

export function impactoSimulado(args: {
  ppAntes: number | null; maxAntes: number | null;
  ppDepois: number; maxDepois: number; posicao: number; custo: number | null;
}): { impactoRs: number | null; qtdeAntes: number; qtdeDepois: number } {
  const q = (pp: number | null, max: number | null) =>
    typeof pp === 'number' && typeof max === 'number' && args.posicao <= pp ? Math.max(0, max - args.posicao) : 0;
  const qtdeAntes = q(args.ppAntes, args.maxAntes);
  const qtdeDepois = q(args.ppDepois, args.maxDepois);
  const impactoRs = args.custo == null ? null : (qtdeDepois - qtdeAntes) * args.custo;
  return { impactoRs, qtdeAntes, qtdeDepois };
}

export function decideStatus(args: {
  antes: SugestaoParam; sugestao: SugestaoParam; demandaMediaDiaria: number | null;
  pin: { pp: number; max: number } | null; limiares: LimiaresFusivel;
}): StatusAuto {
  const { antes, sugestao, demandaMediaDiaria, pin, limiares } = args;
  if (!passaValidacao(sugestao).ok) return 'bloqueado_validacao';
  if (disparaFusivel(antes.estoque_maximo, sugestao, demandaMediaDiaria, limiares).segurado) return 'segurado';
  if (pin && pinBloqueia(pin.pp, pin.max, sugestao)) return 'pinado';
  const difere =
    arred(sugestao.ponto_pedido!) !== arred(antes.ponto_pedido ?? Number.NEGATIVE_INFINITY) ||
    arred(sugestao.estoque_maximo!) !== arred(antes.estoque_maximo ?? Number.NEGATIVE_INFINITY);
  return difere ? 'aplicado' : 'sem_mudanca';
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `heavy bun run test src/lib/reposicao/__tests__/param-auto-helpers.test.ts`
Expected: PASS (todos verdes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/param-auto-helpers.ts src/lib/reposicao/__tests__/param-auto-helpers.test.ts
git commit -m "feat(reposicao): helper puro da auto-aplicação de parâmetros (oráculo da SQL)"
```

---

## Task 2: Migration A — tabelas + RLS + seeds + CHECK

**Files:**
- Create: `supabase/migrations/20260605120000_param_auto_tabelas.sql`

- [ ] **Step 1: Escrever a migration** (DDL do spec §5 + seeds + CHECK estendido)

```sql
-- Reposição — auto-aplicação de parâmetros: fundação (tabelas + RLS + seeds + CHECK)
BEGIN;

CREATE TABLE IF NOT EXISTS public.reposicao_param_auto_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  data_negocio_brt date NOT NULL,
  status text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','completo','erro')),
  total_avaliados int, total_aplicados int, total_segurados int, total_pinados int,
  impacto_total_rs numeric, impacto_desconhecido_n int,
  resumo_enviado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_param_auto_run_dia
  ON public.reposicao_param_auto_run (empresa, data_negocio_brt) WHERE status = 'completo';

CREATE TABLE IF NOT EXISTS public.reposicao_param_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.reposicao_param_auto_run(id),
  empresa text NOT NULL, sku_codigo_omie text NOT NULL, sku_descricao text,
  status text NOT NULL CHECK (status IN ('aplicado','segurado','pinado','bloqueado_validacao')),
  ponto_pedido_antes numeric, ponto_pedido_depois numeric,
  estoque_minimo_antes numeric, estoque_minimo_depois numeric,
  estoque_maximo_antes numeric, estoque_maximo_depois numeric,
  estoque_seguranca_antes numeric, estoque_seguranca_depois numeric,
  cobertura_antes numeric, cobertura_depois numeric,
  impacto_rs numeric, qtde_compra_antes numeric, qtde_compra_depois numeric,
  custo_unitario numeric, custo_fonte text,
  demanda_media_diaria numeric, lt_medio_dias_uteis numeric, classe_consolidada text, z_score numeric,
  revertido_em timestamptz, revertido_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_param_auto_log_run ON public.reposicao_param_auto_log (run_id);
CREATE INDEX IF NOT EXISTS idx_param_auto_log_sku ON public.reposicao_param_auto_log (empresa, sku_codigo_omie);

CREATE TABLE IF NOT EXISTS public.reposicao_param_pin (
  empresa text NOT NULL, sku_codigo_omie text NOT NULL,
  ponto_pedido_rejeitado numeric NOT NULL, estoque_maximo_rejeitado numeric NOT NULL,
  pinado_em timestamptz NOT NULL DEFAULT now(), pinado_por uuid,
  PRIMARY KEY (empresa, sku_codigo_omie)
);

-- RLS: leitura staff-gestor; escrita só service_role/SECURITY DEFINER
ALTER TABLE public.reposicao_param_auto_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_param_auto_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_param_pin ENABLE ROW LEVEL SECURITY;

CREATE POLICY param_auto_run_sel ON public.reposicao_param_auto_run FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
CREATE POLICY param_auto_log_sel ON public.reposicao_param_auto_log FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
CREATE POLICY param_auto_pin_sel ON public.reposicao_param_pin FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
-- service_role bypassa RLS; as RPCs revert/pin são SECURITY DEFINER.

-- Seeds dos limiares (ajustáveis sem deploy)
INSERT INTO public.company_config (key, value) VALUES
  ('param_auto_fusivel_mult', '3'),
  ('param_auto_fusivel_cobertura_dias', '120')
ON CONFLICT (key) DO NOTHING;

-- Estender o CHECK de tipo de fornecedor_alerta com 'param_auto_resumo' (preservar os existentes)
-- ⚠️ O worker DEVE ler o CHECK vivo antes: SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.fornecedor_alerta'::regclass AND contype='c' AND conname LIKE '%tipo%';
--    e recriar a constraint adicionando 'param_auto_resumo' à lista, verbatim + 1 item.
ALTER TABLE public.fornecedor_alerta DROP CONSTRAINT IF EXISTS fornecedor_alerta_tipo_check;
ALTER TABLE public.fornecedor_alerta ADD CONSTRAINT fornecedor_alerta_tipo_check
  CHECK (tipo IN (/* COLAR a lista viva + */ 'param_auto_resumo'));

COMMIT;

SELECT 'BLOCO A OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name IN
    ('reposicao_param_auto_run','reposicao_param_auto_log','reposicao_param_pin')) AS tabelas,
  (SELECT count(*) FROM company_config WHERE key LIKE 'param_auto_%') AS seeds;
```

- [ ] **Step 2: Validar sintaxe/ordem em PG17** (parcial — será coberto pelo harness do Task 5)

Run: `psql "$PG17_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260605120000_param_auto_tabelas.sql`
Expected: `BLOCO A OK | tabelas=3 | seeds=2` (após carregar o snapshot base no harness).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260605120000_param_auto_tabelas.sql
git commit -m "feat(reposicao): tabelas/RLS/seeds da auto-aplicação de parâmetros (migration A)"
```

---

## Task 3: Migration B — core reescrita (decisão + log)

**Files:**
- Create: `supabase/migrations/20260605130000_param_auto_core.sql`

> ⚠️ **Money-path.** O worker DEVE ler a função viva (`supabase/migrations/20260531140000_reposicao_atualizar_params_nao_zera.sql`) e preservar **verbatim** o bloco de métricas derivadas (`demanda_media_diaria`/`demanda_sigma_diario`/`coef_variacao_ordem`/`num_ordens`/`valor_total_90d`/`lead_time_medio`/`lead_time_desvio`/`lt_p95_dias`/`fonte_leadtime`/`z_aplicado`) e a semântica COALESCE (status≠OK → preserva anterior). As ADIÇÕES são: `p_run_id`, a CTE de decisão (espelhando `decideStatus` do Task 1), e o INSERT no log. Confirmar os nomes das colunas de posição de inventário/custo na view e em `inventory_position` (ver §6.5 do spec) antes de fechar o impacto.

- [ ] **Step 1: Escrever a migration** (DROP+CREATE com a CTE de decisão)

```sql
-- Reposição — core instrumentada: validação dura + fusível + trava + log (espelha decideStatus do helper)
BEGIN;

-- Overload: remover a assinatura de 1-arg p/ chamadas existentes resolverem na nova (text, uuid DEFAULT NULL)
DROP FUNCTION IF EXISTS public.atualizar_parametros_numericos_skus(text);

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL)
  RETURNS integer LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE
  atualizados int := 0;
  v_mult numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_mult'), 3);
  v_cob  numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_cobertura_dias'), 120);
BEGIN
  -- (opcional) rótulo p/ o trigger de histórico distinguir automação
  PERFORM set_config('app.param_auto', CASE WHEN p_run_id IS NULL THEN 'manual' ELSE 'auto' END, true);

  WITH base AS (
    SELECT sp.id, sp.empresa, sp.sku_codigo_omie,
           sp.ponto_pedido AS pp_antes, sp.estoque_minimo AS min_antes, sp.estoque_maximo AS max_antes,
           sp.estoque_seguranca AS ss_antes, sp.cobertura_alvo_dias AS cob_antes,
           sp.habilitado_reposicao_automatica AS habilitado,
           COALESCE(sp.tipo_reposicao,'automatica') AS tipo,
           v.sku_descricao, v.fornecedor_nome,
           v.estoque_minimo_sugerido AS min_sug, v.ponto_pedido_sugerido AS pp_sug,
           v.estoque_maximo_sugerido AS max_sug, v.estoque_seguranca_sugerido AS ss_sug,
           v.cobertura_alvo_dias AS cob_sug,
           v.demanda_media_diaria, v.demanda_sigma_diario, v.coef_variacao_ordem, v.num_ordens,
           v.valor_total_90d, v.lead_time_medio, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime,
           v.z_aplicado, v.classe_consolidada,
           pin.ponto_pedido_rejeitado, pin.estoque_maximo_rejeitado
    FROM public.sku_parametros sp
    JOIN public.v_sku_parametros_sugeridos v
      ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
    LEFT JOIN public.reposicao_param_pin pin
      ON pin.empresa = sp.empresa AND pin.sku_codigo_omie = sp.sku_codigo_omie
    WHERE sp.empresa = p_empresa
  ),
  decidido AS (
    SELECT b.*,
      CASE
        -- status != OK (sugerido NULL): COALESCE preserva → não conta como mudança
        WHEN b.pp_sug IS NULL OR b.max_sug IS NULL OR b.min_sug IS NULL
             OR b.ss_sug IS NULL OR b.cob_sug IS NULL THEN 'sem_mudanca'
        -- validação dura (OK porém incoerente)
        WHEN b.max_sug < b.pp_sug OR b.pp_sug < b.min_sug
             OR b.min_sug < 0 OR b.ss_sug < 0 OR b.cob_sug <= 0 THEN 'bloqueado_validacao'
        -- fusível (multiplicador OU cobertura)
        WHEN b.max_antes IS NOT NULL AND b.max_antes > 0 AND b.max_sug > v_mult * b.max_antes THEN 'segurado'
        WHEN b.demanda_media_diaria > 0 AND (b.max_sug / b.demanda_media_diaria) > v_cob THEN 'segurado'
        -- trava de reversão (fingerprint material igual ao rejeitado)
        WHEN b.ponto_pedido_rejeitado IS NOT NULL
             AND round(b.pp_sug) = round(b.ponto_pedido_rejeitado)
             AND round(b.max_sug) = round(b.estoque_maximo_rejeitado) THEN 'pinado'
        -- aplica se PP ou máx diferem do atual (arredondado)
        WHEN round(b.pp_sug) <> round(COALESCE(b.pp_antes, -1))
             OR round(b.max_sug) <> round(COALESCE(b.max_antes, -1)) THEN 'aplicado'
        ELSE 'sem_mudanca'
      END AS status
    FROM base b
  ),
  upd AS (
    UPDATE public.sku_parametros sp SET
      sku_descricao = COALESCE(d.sku_descricao, sp.sku_descricao),
      fornecedor_nome = COALESCE(d.fornecedor_nome, sp.fornecedor_nome),
      -- métricas derivadas: SEMPRE frescas (verbatim da função viva)
      demanda_media_diaria = d.demanda_media_diaria,
      demanda_desvio_padrao = d.demanda_sigma_diario,
      demanda_coef_variacao = d.coef_variacao_ordem,
      demanda_dias_com_movimento = d.num_ordens,
      valor_vendido_90d = d.valor_total_90d,
      lt_medio_dias_uteis = d.lead_time_medio,
      lt_desvio_padrao_dias = d.lead_time_desvio,
      lt_p95_dias = d.lt_p95_dias,
      fonte_leadtime = d.fonte_leadtime,
      z_score = d.z_aplicado,
      -- CONFIG: só sobrescreve no 'aplicado'; senão preserva (COALESCE-equivalente)
      estoque_seguranca = CASE WHEN d.status='aplicado' THEN d.ss_sug ELSE sp.estoque_seguranca END,
      ponto_pedido      = CASE WHEN d.status='aplicado' THEN d.pp_sug ELSE sp.ponto_pedido END,
      estoque_minimo    = CASE WHEN d.status='aplicado' THEN d.min_sug ELSE sp.estoque_minimo END,
      cobertura_alvo_dias = CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE sp.cobertura_alvo_dias END,
      estoque_maximo    = CASE WHEN d.status='aplicado' THEN d.max_sug ELSE sp.estoque_maximo END,
      ultima_atualizacao_calculo = NOW()
    FROM decidido d WHERE sp.id = d.id
    RETURNING sp.id, d.status
  )
  SELECT count(*) FILTER (WHERE status='aplicado') INTO atualizados FROM upd;

  -- LOG (só no run automático e só elegíveis ao motor; status relevantes)
  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.reposicao_param_auto_log (
      run_id, empresa, sku_codigo_omie, sku_descricao, status,
      ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
      estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
      cobertura_antes, cobertura_depois,
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie, d.sku_descricao, d.status,
      d.pp_antes, CASE WHEN d.status='aplicado' THEN d.pp_sug ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes, CASE WHEN d.status='aplicado' THEN d.ss_sug ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';
    -- NOTA: impacto_rs/qtde/custo preenchidos por UPDATE complementar (ver §6.5; junta inventory_position+custo).
  END IF;

  RETURN atualizados;
END;
$$;

COMMIT;

SELECT 'BLOCO B OK' AS status, proname, pronargs
FROM pg_proc WHERE proname='atualizar_parametros_numericos_skus';
```

> **Impacto (§6.5):** após o INSERT base, fazer um `UPDATE reposicao_param_auto_log l SET impacto_rs/qtde/custo` juntando a posição de inventário (`estoque_fisico+pendente+em_transito`) e o custo (`inventory_position.cmc` fallback `preco_medio`) — o worker confirma os nomes exatos no `gerar_pedidos_sugeridos_ciclo` (que já calcula a posição) e espelha a fórmula `qtde(param)=posicao<=pp ? max-posicao : 0`. Custo ausente → `impacto_rs` fica NULL.

- [ ] **Step 2: Validar no harness PG17** (Task 5 cobre os asserts). Sintaxe agora:

Run: `psql "$PG17_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260605130000_param_auto_core.sql`
Expected: `BLOCO B OK | atualizar_parametros_numericos_skus | pronargs=2`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260605130000_param_auto_core.sql
git commit -m "feat(reposicao): core instrumentada (validação+fusível+trava+log) — migration B"
```

---

## Task 4: Migration C — wrapper diário + RPCs revert/pin + cron resumo

**Files:**
- Create: `supabase/migrations/20260605140000_param_auto_wrapper_revert_cron.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Reposição — wrapper diário (run + idempotência) + RPCs revert/pin + cron resumo 18h
BEGIN;

-- Wrapper diário: cria run, chama a core com run_id, marca completo. Idempotente (1 run/dia).
CREATE OR REPLACE FUNCTION public.aplicar_parametros_automatico_diario(p_empresa text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_run uuid; v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_'||p_empresa));
  IF EXISTS (SELECT 1 FROM public.reposicao_param_auto_run
             WHERE empresa=p_empresa AND data_negocio_brt=v_hoje AND status='completo') THEN
    RETURN NULL; -- já rodou hoje
  END IF;
  INSERT INTO public.reposicao_param_auto_run (empresa, data_negocio_brt, status)
    VALUES (p_empresa, v_hoje, 'rodando') RETURNING id INTO v_run;
  PERFORM public.atualizar_parametros_numericos_skus(p_empresa, v_run);
  UPDATE public.reposicao_param_auto_run SET
    status='completo', concluido_em=now(),
    total_avaliados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run),
    total_aplicados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='aplicado'),
    total_segurados = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='segurado'),
    total_pinados   = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='pinado'),
    impacto_total_rs = (SELECT sum(impacto_rs) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND impacto_rs IS NOT NULL),
    impacto_desconhecido_n = (SELECT count(*) FROM public.reposicao_param_auto_log WHERE run_id=v_run AND status='aplicado' AND impacto_rs IS NULL)
  WHERE id=v_run;
  RETURN v_run;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.reposicao_param_auto_run SET status='erro', concluido_em=now() WHERE id=v_run;
  RAISE;
END;
$$;

-- Revert item-a-item: só restaura se atual == "depois" logado; grava pin.
CREATE OR REPLACE FUNCTION public.reverter_parametro_auto(p_log_id uuid)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE r record; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.pode_ver_carteira_completa(v_uid) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  SELECT * INTO r FROM public.reposicao_param_auto_log WHERE id=p_log_id AND status='aplicado' AND revertido_em IS NULL;
  IF NOT FOUND THEN RETURN 'nao_encontrado'; END IF;
  -- guarda de conflito: o valor atual ainda é o que a automação pôs?
  IF NOT EXISTS (
    SELECT 1 FROM public.sku_parametros sp WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie=r.sku_codigo_omie
      AND round(COALESCE(sp.ponto_pedido,-1))=round(COALESCE(r.ponto_pedido_depois,-1))
      AND round(COALESCE(sp.estoque_maximo,-1))=round(COALESCE(r.estoque_maximo_depois,-1))
  ) THEN RETURN 'conflito'; END IF;
  UPDATE public.sku_parametros sp SET
    ponto_pedido=r.ponto_pedido_antes, estoque_minimo=r.estoque_minimo_antes,
    estoque_maximo=r.estoque_maximo_antes, estoque_seguranca=r.estoque_seguranca_antes,
    cobertura_alvo_dias=r.cobertura_antes, ultima_atualizacao_calculo=now()
  WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie=r.sku_codigo_omie;
  -- pin: não re-aplicar o valor recusado até a sugestão mudar
  INSERT INTO public.reposicao_param_pin (empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado, pinado_por)
    VALUES (r.empresa, r.sku_codigo_omie, round(r.ponto_pedido_depois), round(r.estoque_maximo_depois), v_uid)
    ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE
      SET ponto_pedido_rejeitado=excluded.ponto_pedido_rejeitado,
          estoque_maximo_rejeitado=excluded.estoque_maximo_rejeitado, pinado_em=now(), pinado_por=v_uid;
  UPDATE public.reposicao_param_auto_log SET revertido_em=now(), revertido_por=v_uid WHERE id=p_log_id;
  RETURN 'revertido';
END;
$$;

-- Revert tudo do run.
CREATE OR REPLACE FUNCTION public.reverter_run_auto(p_run_id uuid)
  RETURNS TABLE(revertidos int, conflitos int) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE r record; v_rev int := 0; v_conf int := 0; res text;
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  FOR r IN SELECT id FROM public.reposicao_param_auto_log WHERE run_id=p_run_id AND status='aplicado' AND revertido_em IS NULL LOOP
    res := public.reverter_parametro_auto(r.id);
    IF res='revertido' THEN v_rev := v_rev+1; ELSIF res='conflito' THEN v_conf := v_conf+1; END IF;
  END LOOP;
  revertidos := v_rev; conflitos := v_conf; RETURN NEXT;
END;
$$;

-- Devolver ao automático (apaga o pin).
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.aplicar_parametros_automatico_diario(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.reverter_parametro_auto(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reverter_run_auto(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.despinar_parametro(text, text) FROM anon;

-- Resumo do fim do dia (SQL-local, idempotente; corpo pré-renderizado).
CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE r record; v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_corpo text; v_top text;
BEGIN
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id; RETURN; -- nada relevante
  END IF;
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s%s', sku_codigo_omie,
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            CASE WHEN impacto_rs IS NULL THEN ' (R$ ?)' ELSE ' (R$ '||round(impacto_rs)::text||')' END), E'\n')
    INTO v_top FROM (
      SELECT * FROM public.reposicao_param_auto_log WHERE run_id=r.id AND status='aplicado'
      ORDER BY impacto_rs DESC NULLS LAST LIMIT 10) t;
  v_corpo := format(E'%s parâmetros mudaram hoje (OBEN).\nImpacto estimado total: R$ %s%s\n\nMaiores mudanças:\n%s\n\nSegurados pelo fusível (confira): %s\n\nVeja e reverta em: /admin/reposicao/mudancas-automaticas',
    r.total_aplicados, round(COALESCE(r.impacto_total_rs,0)),
    CASE WHEN COALESCE(r.impacto_desconhecido_n,0)>0 THEN ' (+'||r.impacto_desconhecido_n||' sem custo)' ELSE '' END,
    COALESCE(v_top,'—'), COALESCE(r.total_segurados,0));
  INSERT INTO public.fornecedor_alerta (tipo, titulo, mensagem, empresa, severidade, status)
    VALUES ('param_auto_resumo', 'Parâmetros de reposição — resumo do dia', v_corpo, r.empresa, 'info', 'pendente_notificacao');
  UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
END;
$$;
REVOKE ALL ON FUNCTION public.reposicao_param_auto_resumo_tick() FROM anon, authenticated, public;

-- Cron 18h BRT (21h UTC), SQL-local (sem net.http_post).
SELECT cron.schedule('reposicao-param-auto-resumo', '0 21 * * *',
  $cron$ SELECT public.reposicao_param_auto_resumo_tick(); $cron$);

COMMIT;

SELECT 'BLOCO C OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN
    ('aplicar_parametros_automatico_diario','reverter_parametro_auto','reverter_run_auto','despinar_parametro','reposicao_param_auto_resumo_tick')) AS funcs,
  (SELECT count(*) FROM cron.job WHERE jobname='reposicao-param-auto-resumo') AS crons;
```

> ⚠️ O worker confirma os nomes de coluna de `fornecedor_alerta` (`titulo`/`mensagem`/`empresa`/`severidade`/`status`) contra o schema vivo — espelhar o que o `dispatch-notifications` consome (ver o digest WhatsApp-SLA, CLAUDE.md §5). Ajustar `severidade`/`status` aos valores aceitos pelo CHECK.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260605140000_param_auto_wrapper_revert_cron.sql
git commit -m "feat(reposicao): wrapper diário + RPCs revert/pin + cron resumo — migration C"
```

---

## Task 5: Prova em PostgreSQL 17 local (harness)

**Files:**
- Create: `db/test-param-auto.sh`

- [ ] **Step 1: Escrever o harness** (base `db/verify-snapshot-replay.sh`: sobe PG17, aplica snapshot + stubs, depois as 3 migrations; semeia e asserta)

```bash
#!/usr/bin/env bash
set -euo pipefail
# Reusa a fundação de db/verify-snapshot-replay.sh para subir um PG17 com o schema public.
# Depois aplica as migrations A/B/C e roda asserts da auto-aplicação.
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib-pg17.sh"   # se não existir, extrair o bootstrap de verify-snapshot-replay.sh
PSQL="psql $PG17_URL -v ON_ERROR_STOP=1 -qtA"

$PSQL -f "$DIR/../supabase/migrations/20260605120000_param_auto_tabelas.sql" >/dev/null
$PSQL -f "$DIR/../supabase/migrations/20260605130000_param_auto_core.sql" >/dev/null
$PSQL -f "$DIR/../supabase/migrations/20260605140000_param_auto_wrapper_revert_cron.sql" >/dev/null

# Stub mínimo da view (o snapshot já a tem; aqui forçamos linhas de teste via tabela temporária + override
# da v_sku_parametros_sugeridos se necessário). O worker semeia sku_parametros + a view com casos:
#   A) mudança normal (aplica)  B) salto >3x (segura)  C) cobertura>120d (segura)
#   D) máx<pp (bloqueia)  E) pin igual (pina)  F) pin diferente (aplica+limpa pin)  G) igual (sem_mudanca)
# Ver db/seed-param-auto.sql (criar junto).

assert() { local got="$1" exp="$2" msg="$3"; [ "$got" = "$exp" ] && echo "ok: $msg" || { echo "FALHOU: $msg (got=$got exp=$exp)"; exit 1; }; }

RUN=$($PSQL -c "SELECT public.aplicar_parametros_automatico_diario('oben');")
assert "$($PSQL -c "SELECT status FROM reposicao_param_auto_log WHERE sku_codigo_omie='A';")" "aplicado" "A aplica"
assert "$($PSQL -c "SELECT status FROM reposicao_param_auto_log WHERE sku_codigo_omie='B';")" "segurado" "B segura (>3x)"
assert "$($PSQL -c "SELECT status FROM reposicao_param_auto_log WHERE sku_codigo_omie='C';")" "segurado" "C segura (cobertura)"
assert "$($PSQL -c "SELECT status FROM reposicao_param_auto_log WHERE sku_codigo_omie='D';")" "bloqueado_validacao" "D bloqueia"
# idempotência: 2º run mesmo dia = NULL (no-op)
assert "$($PSQL -c "SELECT public.aplicar_parametros_automatico_diario('oben') IS NULL;")" "t" "idempotente no mesmo dia"
# revert restaura + cria pin
LOG_A=$($PSQL -c "SELECT id FROM reposicao_param_auto_log WHERE sku_codigo_omie='A';")
assert "$($PSQL -c "SELECT public.reverter_parametro_auto('$LOG_A'::uuid);")" "revertido" "revert A"
assert "$($PSQL -c "SELECT count(*) FROM reposicao_param_pin WHERE sku_codigo_omie='A';")" "1" "pin criado"
# conflito: editar o SKU e tentar reverter de novo
$PSQL -c "UPDATE sku_parametros SET estoque_maximo=estoque_maximo+999 WHERE sku_codigo_omie='A';" >/dev/null
assert "$($PSQL -c "SELECT public.reverter_parametro_auto('$LOG_A'::uuid);")" "nao_encontrado" "revert já-revertido não repete"
echo "TODOS OS ASSERTS PASSARAM"
```

- [ ] **Step 2: Criar o seed** `db/seed-param-auto.sql` com os SKUs A–G (sku_parametros + linhas correspondentes na view de teste). Rodar o harness:

Run: `bash db/test-param-auto.sh`
Expected: `TODOS OS ASSERTS PASSARAM`.

- [ ] **Step 3: Commit**

```bash
git add db/test-param-auto.sh db/seed-param-auto.sql
git commit -m "test(reposicao): prova PG17 da auto-aplicação (aplica/segura/bloqueia/pin/idempotência/revert)"
```

---

## Task 6: Edge `omie-cron-diario` — trocar a chamada da core pelo wrapper

**Files:**
- Modify: `supabase/functions/omie-cron-diario/index.ts`

- [ ] **Step 1: Localizar e trocar a chamada**

Achar a invocação atual de `atualizar_parametros_numericos_skus` (provavelmente `supabase.rpc('atualizar_parametros_numericos_skus', { p_empresa })`) e trocar por:

```ts
// antes: await supabase.rpc('atualizar_parametros_numericos_skus', { p_empresa: 'oben' })
const { error: paramErr } = await supabase.rpc('aplicar_parametros_automatico_diario', { p_empresa: 'oben' });
if (paramErr) console.error('[param-auto] falhou (não derruba o sync):', paramErr.message);
```

(Se houver loop por empresa, manter; v1 só OBEN entra no wrapper — as outras empresas, se existirem aqui, continuam na core direta `atualizar_parametros_numericos_skus(p_empresa)`.)

- [ ] **Step 2: Lint do edge**

Run: `bun lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/omie-cron-diario/index.ts
git commit -m "feat(reposicao): omie-cron-diario chama o wrapper instrumentado (run + log)"
```

---

## Task 7: Hook `useParamAutoMudancas`

**Files:**
- Create: `src/hooks/useParamAutoMudancas.ts`

- [ ] **Step 1: Implementar o hook**

```ts
// src/hooks/useParamAutoMudancas.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface ParamAutoLog {
  id: string; sku_codigo_omie: string; sku_descricao: string | null; status: string;
  ponto_pedido_antes: number | null; ponto_pedido_depois: number | null;
  estoque_maximo_antes: number | null; estoque_maximo_depois: number | null;
  impacto_rs: number | null; revertido_em: string | null;
}
export interface ParamAutoRun {
  id: string; data_negocio_brt: string; total_aplicados: number | null;
  total_segurados: number | null; impacto_total_rs: number | null;
}

export function useParamAutoMudancas(empresa = 'oben') {
  const qc = useQueryClient();

  const runQuery = useQuery({
    queryKey: ['param-auto-run', empresa],
    queryFn: async (): Promise<ParamAutoRun | null> => {
      const { data, error } = await supabase
        .from('reposicao_param_auto_run').select('id,data_negocio_brt,total_aplicados,total_segurados,impacto_total_rs')
        .eq('empresa', empresa).eq('status', 'completo').order('concluido_em', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error; return data;
    },
  });

  const logQuery = useQuery({
    queryKey: ['param-auto-log', runQuery.data?.id],
    enabled: !!runQuery.data?.id,
    queryFn: async (): Promise<ParamAutoLog[]> => {
      const { data, error } = await supabase
        .from('reposicao_param_auto_log')
        .select('id,sku_codigo_omie,sku_descricao,status,ponto_pedido_antes,ponto_pedido_depois,estoque_maximo_antes,estoque_maximo_depois,impacto_rs,revertido_em')
        .eq('run_id', runQuery.data!.id).order('impacto_rs', { ascending: false, nullsFirst: false });
      if (error) throw error; return data ?? [];
    },
  });

  const reverter = useMutation({
    mutationFn: async (logId: string) => {
      const { data, error } = await supabase.rpc('reverter_parametro_auto', { p_log_id: logId });
      if (error) throw error; return data as string;
    },
    onSuccess: (res) => {
      if (res === 'revertido') toast.success('Parâmetro revertido — não será re-aplicado até a sugestão mudar.');
      else if (res === 'conflito') toast.error('Não revertido: o valor já foi alterado depois. Confira na tela.');
      else toast.info('Nada a reverter.');
      qc.invalidateQueries({ queryKey: ['param-auto-log'] });
    },
    onError: (e: Error) => toast.error(`Falha ao reverter: ${e.message}`),
  });

  const reverterTudo = useMutation({
    mutationFn: async (runId: string) => {
      const { data, error } = await supabase.rpc('reverter_run_auto', { p_run_id: runId });
      if (error) throw error; return data as { revertidos: number; conflitos: number }[];
    },
    onSuccess: (rows) => {
      const r = rows?.[0]; toast.success(`Revertidos: ${r?.revertidos ?? 0} · em conflito: ${r?.conflitos ?? 0}`);
      qc.invalidateQueries({ queryKey: ['param-auto-log'] });
    },
    onError: (e: Error) => toast.error(`Falha ao reverter tudo: ${e.message}`),
  });

  return { run: runQuery.data, logs: logQuery.data ?? [], isLoading: runQuery.isLoading || logQuery.isLoading, reverter, reverterTudo };
}
```

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: 0 erros. (Se `reposicao_param_auto_*` não estiver em `types.ts`, usar `as never` no `.from(...)` seguindo o padrão de `useAplicacaoFila.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useParamAutoMudancas.ts
git commit -m "feat(reposicao): hook useParamAutoMudancas (run/log + revert)"
```

---

## Task 8: Tela "Mudanças automáticas" + rota + nav

**Files:**
- Create: `src/pages/ParamAutoMudancas.tsx`
- Modify: `src/App.tsx` (lazy route), `src/components/AppShell.tsx` (item de nav em Reposição)

- [ ] **Step 1: Implementar a página** (padrões do projeto: `PageSkeleton`, `EmptyState tone="operational"`, `text-status-*`, `font-tabular`)

```tsx
// src/pages/ParamAutoMudancas.tsx
import { useParamAutoMudancas } from '@/hooks/useParamAutoMudancas';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';

const fmtRs = (n: number | null) => n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ParamAutoMudancas() {
  const { run, logs, isLoading, reverter, reverterTudo } = useParamAutoMudancas('oben');
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!run) return <EmptyState tone="operational" title="Sem mudanças automáticas hoje" description="O ajuste automático de parâmetros ainda não rodou hoje ou não houve mudança." />;

  const aplicados = logs.filter((l) => l.status === 'aplicado');
  const segurados = logs.filter((l) => l.status === 'segurado');

  return (
    <div className="space-y-6 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl">Mudanças automáticas — {run.data_negocio_brt}</h1>
          <p className="text-sm text-muted-foreground">
            {run.total_aplicados ?? 0} aplicadas · {run.total_segurados ?? 0} seguradas · impacto estimado {fmtRs(run.impacto_total_rs)}
          </p>
        </div>
        {aplicados.some((l) => !l.revertido_em) && (
          <Button variant="outline" onClick={() => reverterTudo.mutate(run.id)} disabled={reverterTudo.isPending}>
            Reverter tudo do dia
          </Button>
        )}
      </header>

      {segurados.length > 0 && (
        <section className="rounded-md border border-status-warning/40 bg-status-warning-bg p-3">
          <h2 className="text-sm font-medium text-status-warning">Segurados pelo fusível — confira ({segurados.length})</h2>
          <ul className="mt-2 space-y-1 text-sm font-tabular">
            {segurados.map((l) => (
              <li key={l.id}>{l.sku_codigo_omie} — {l.sku_descricao ?? ''}: máx {l.estoque_maximo_antes ?? '—'} (sugestão fora da faixa, mantido)</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">Aplicadas (por impacto)</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-muted-foreground">
            <th>SKU</th><th>PP</th><th>Máx</th><th className="text-right">Impacto</th><th></th>
          </tr></thead>
          <tbody>
            {aplicados.map((l) => (
              <tr key={l.id} className="border-t font-tabular">
                <td className="py-1">{l.sku_codigo_omie} <span className="text-muted-foreground">{l.sku_descricao ?? ''}</span></td>
                <td>{l.ponto_pedido_antes ?? '—'} → {l.ponto_pedido_depois ?? '—'}</td>
                <td>{l.estoque_maximo_antes ?? '—'} → {l.estoque_maximo_depois ?? '—'}</td>
                <td className="text-right">{fmtRs(l.impacto_rs)}</td>
                <td className="text-right">
                  {l.revertido_em
                    ? <Badge variant="secondary">revertido</Badge>
                    : <Button size="sm" variant="ghost" onClick={() => reverter.mutate(l.id)} disabled={reverter.isPending}>Reverter</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Registrar a rota** em `src/App.tsx`

```tsx
const ParamAutoMudancas = lazy(() => import('./pages/ParamAutoMudancas'));
// dentro das rotas protegidas de admin/reposição:
<Route path="/admin/reposicao/mudancas-automaticas" element={<ParamAutoMudancas />} />
```

- [ ] **Step 3: Item de nav** na seção Reposição do `src/components/AppShell.tsx` (gated staff/gestor, seguindo o padrão dos demais itens de reposição). Label: "Mudanças automáticas". Badge opcional: `run.total_aplicados`.

- [ ] **Step 4: Typecheck + build + lint**

Run: `heavy bun run typecheck && heavy bun run test && heavy bun build && bun lint`
Expected: typecheck 0 · testes verdes · build ok · lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ParamAutoMudancas.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(reposicao): tela 'Mudanças automáticas' + rota + nav"
```

---

## Task 9: Rollout (manual — founder; documentar no PR)

> Não é código — é a sequência de apply que o founder executa (CLAUDE.md §5/§ deploy). Documentar no corpo do PR.

- [ ] **Step 1:** Codex challenge no diff (money-path) antes do merge: `/codex challenge`. Resolver P1.
- [ ] **Step 2:** Abrir PR com "**ATENÇÃO: migrations manuais**" e os 3 blocos SQL (A/B/C) inline + a query de validação de cada um.
- [ ] **Step 3:** Founder cola **BLOCO A** (`20260605120000`) no SQL Editor → confirma `tabelas=3 · seeds=2`. ⚠️ Antes do A, o founder cola a leitura do CHECK vivo de `fornecedor_alerta` e o worker fecha a lista do CHECK verbatim+1.
- [ ] **Step 4:** Founder cola **BLOCO B** (`20260605130000`) → confirma `pronargs=2`.
- [ ] **Step 5:** Founder cola **BLOCO C** (`20260605140000`) → confirma `funcs=5 · crons=1`.
- [ ] **Step 6:** Redeploy do edge `omie-cron-diario` via chat do Lovable (verbatim da main).
- [ ] **Step 7:** Merge do PR → **Publish** no Lovable (frontend).
- [ ] **Step 8:** Validação em prod: rodar 1 ciclo (`SELECT aplicar_parametros_automatico_diario('oben')`), conferir o run/log + o e-mail das 18h; reverter 1 SKU e confirmar no dia seguinte que o cron **não** re-aplicou o valor revertido (pin segurou); mudar a sugestão (ou despinar) e confirmar que volta a aplicar.

---

## Self-review (executado)

**Cobertura do spec:** §4 arquitetura → Tasks 3/4/6; §5 tabelas → Task 2; §6 regras (validação/fusível/trava/log/impacto) → Task 1 (oráculo) + Task 3 (SQL); §7 wrapper/idempotência → Task 4; §8 resumo → Task 4; §9 tela/RPCs → Tasks 7/8 + 4; §10 mapa codex → coberto pelas tasks; §12 validação PG17 → Task 5; §13 limiares → seeds Task 2; §14 rollout → Task 9. ✅
**Placeholders:** os pontos marcados com ⚠️ (CHECK vivo de `fornecedor_alerta`, colunas de posição/custo do impacto, nomes de coluna de `fornecedor_alerta`) são instruções de **ler-o-vivo-e-confirmar** num módulo money-path, não placeholders de lógica — a decisão e a fórmula estão dadas.
**Consistência de tipos:** `StatusAuto`/`SugestaoParam`/`LimiaresFusivel` do Task 1 batem com os status do CHECK (Task 2) e da CTE (Task 3); `decideStatus` (precedência validação→fusível→pin→aplicado) é o mesmo CASE da SQL.
