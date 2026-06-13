# Radar de Clientes — Fatia 2 (tela `/radar`) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para implementar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Entregar a tela `/radar` utilizável: o founder/gestor abre, vê os KPIs do lote, filtra a fila de 526k prospects (server-side), abre o detalhe de uma empresa e registra o resultado do contato (em conversa / não atendeu / descartar / virou cliente) com undo.

**Architecture:** Frontend React sobre as tabelas `radar_*` (Fatia 1, em prod). Escrita de prospecção via 2 RPCs novas (`registrar_contato_radar`/`desfazer_contato_radar`) que espelham o gate+dedupe+advisory-lock de `registrar_contato_rota`; KPIs por 1 RPC agregadora (`radar_kpis`). Lista paginada **server-side** (`useInfiniteQuery` + `.range()` — universo de centenas de milhares, jamais carregar tudo). Helpers de apresentação são puros e testados (TDD).

**Tech Stack:** React 18 + TS strict + @tanstack/react-query (`useInfiniteQuery`) + shadcn (`Sheet`, `DropdownMenu`, `AlertDialog`) + sonner (toast+undo) + Supabase RPC + PostgreSQL 17 (validação local). Padrões do repo: `useUrlState`, `useInfiniteScroll`, `useDisplayAccess`, `PageSkeleton`, `EmptyState`, `track()`.

**Escopo (Fatia 2):** RPCs de contato + KPIs (PG17), hook de lista server-side + filtros, KPIs, presets "Novas do lote"/"Estabelecidas", painel de detalhe (Sheet) com registrar contato, rota + item de sidebar (Gestão, gate gestor/master).

**FORA do escopo (Fatia 3):** cadastrar no Omie (`IncluirCliente`), atribuir Tarefa, mapa Leaflet, RPC `radar_contagem_por_municipio`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `supabase/migrations/20260612130000_radar_rpcs_contato.sql` (criar) | `ALTER radar_contatos ADD status_anterior` + RPCs `registrar_contato_radar`/`desfazer_contato_radar`/`radar_kpis` + GRANT/REVOKE + query de validação |
| `db/test-radar-rpcs.sh` (criar) | Validação PG17: registrar muda status+loga, undo<5min reverte ao anterior (com guard anti-regressão), dedupe 2min, gate nega não-gestor, kpis conta certo |
| `src/lib/radar/ui-helpers.ts` (criar) | Helpers PUROS: vocabulário `ACOES_CONTATO`, `presetParaParams`, `idadeEmAnos`, `rotuloPorte`, `formatarCapital`, `formatarCnpj` |
| `src/lib/radar/__tests__/ui-helpers.test.ts` (criar) | Testes vitest dos helpers puros |
| `src/queries/useRadarKpis.ts` (criar) | `useQuery` → RPC `radar_kpis` |
| `src/queries/useRadarLista.ts` (criar) | `useInfiniteQuery` server-side: filtros → `.eq/.ilike/.gte/.range`; tipo `RadarFiltros` |
| `src/queries/useRegistrarContatoRadar.ts` (criar) | mutations `useRegistrarContatoRadar`/`useDesfazerContatoRadar` + invalidação |
| `src/components/radar/RadarKpis.tsx` (criar) | 4 cards de KPI (lê `useRadarKpis`) |
| `src/components/radar/RadarFiltros.tsx` (criar) | Barra de filtros + presets (controlada por `useUrlState`) |
| `src/components/radar/RadarOutcomeMenu.tsx` (criar) | Menu de resultado (espelha `OutcomeMenu`, vocabulário do radar, undo) |
| `src/components/radar/RadarDetailSheet.tsx` (criar) | Sheet de detalhe da empresa + histórico + registrar contato |
| `src/components/radar/RadarLinha.tsx` (criar) | Linha densa da lista (1 empresa) |
| `src/pages/RadarClientes.tsx` (criar) | Página: compõe KPIs + filtros + lista + Sheet |
| `src/App.tsx` (modificar) | Rota lazy `radar` |
| `src/components/AppShell.tsx` (modificar) | Item "Radar de Clientes" na seção Gestão |

---

## Task 1: Migration das RPCs de contato + KPIs (+ validação PG17)

**Files:**
- Create: `supabase/migrations/20260612130000_radar_rpcs_contato.sql`
- Create: `db/test-radar-rpcs.sh`

Vocabulário canônico (já fixado nos CHECKs da Fatia 1 — `radar_empresas.prospeccao_status` e `radar_contatos.acao`): `'a_contatar'`, `'contatado_sem_resposta'`, `'em_conversa'`, `'descartado'`, `'virou_cliente'`. A `acao` registrada vira o novo `prospeccao_status` (mapa identidade). O gate é **só gestor/master** (`pode_ver_carteira_completa`) — o Radar é founder/gestor-only, sem carteira por-vendedora (≠ rota).

- [ ] **Step 1: Conferir o maior timestamp de migration na main (evitar colisão)**

Run: `ls supabase/migrations/ | sort | tail -3`
Se aparecer migration `>= 20260612130000`, renomeie o arquivo desta task para um timestamp claramente maior (ex.: `20260612140000`) e ajuste o nome no commit. Anote o nome final.

- [ ] **Step 2: Escrever a migration**

Conteúdo EXATO de `supabase/migrations/20260612130000_radar_rpcs_contato.sql`:

```sql
-- =============================================================================
-- RADAR DE CLIENTES — RPCs de contato + KPIs (fatia 2)
-- Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md §3.3/§3.6/§3.7
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate: gestor/master via pode_ver_carteira_completa (helper já em prod; mesmo
-- gate da RLS de SELECT das tabelas radar_*). O Radar é founder/gestor-only.
-- =============================================================================

-- 1) status_anterior: o undo precisa reverter o prospeccao_status DESNORMALIZADO
--    em radar_empresas; guardamos o valor pré-contato na linha do log.
ALTER TABLE public.radar_contatos
  ADD COLUMN IF NOT EXISTS status_anterior text;

-- 2) Registrar contato: muda o status da empresa + loga (append-only) + dedupe.
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(
  p_cnpj text, p_acao text, p_nota text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_existing uuid;
  v_id uuid;
BEGIN
  -- gate: gestor/master (mesma fronteira da RLS das tabelas radar)
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'cnpj inválido';
  END IF;
  IF p_acao NOT IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente') THEN
    RAISE EXCEPTION 'ação inválida: %', p_acao;
  END IF;

  -- lê o status atual (= status_anterior do log) e trava a linha p/ serializar.
  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- serializa o dedupe por chave lógica (race do SELECT→INSERT em double-click).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':'||p_acao||':radar', 0));
  -- dedupe idempotente: mesmo gestor+cnpj+ação nos últimos 2 min → devolve o existente.
  SELECT id INTO v_existing FROM public.radar_contatos
   WHERE criado_por = v_uid AND cnpj = p_cnpj AND acao = p_acao
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_status_atual)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = now(),
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE descarte_motivo END,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- 3) Undo curto (own + < 5 min): reverte o status ao status_anterior do log e
--    apaga a linha. GUARD anti-regressão: só reverte se o status ATUAL da empresa
--    ainda for o que ESTE contato setou (senão um contato mais novo seria pisado).
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cnpj text;
  v_acao text;
  v_anterior text;
  v_status_atual text;
BEGIN
  SELECT cnpj, acao, status_anterior INTO v_cnpj, v_acao, v_anterior
    FROM public.radar_contatos
   WHERE id = p_id AND criado_por = v_uid AND created_at > now() - interval '5 minutes';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  -- só reverte o status se ele ainda é o que este contato aplicou (anti-regressão).
  IF v_status_atual = v_acao THEN
    UPDATE public.radar_empresas SET
      prospeccao_status = COALESCE(v_anterior, 'a_contatar'),
      prospeccao_atualizado_em = now(), updated_at = now()
    WHERE cnpj = v_cnpj;
  END IF;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true);
END $$;

-- 4) KPIs do topo da tela (1 round-trip; "novos" lê o state, não conta a tabela).
CREATE OR REPLACE FUNCTION public.radar_kpis()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lote text;
  v_novos integer;
  v_a_contatar integer;
  v_em_conversa integer;
  v_virou_mes integer;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  SELECT count(*) INTO v_a_contatar FROM public.radar_empresas
   WHERE prospeccao_status = 'a_contatar' AND ja_cliente = false
     AND (v_lote IS NULL OR ultimo_lote = v_lote);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas
   WHERE prospeccao_status = 'em_conversa';
  SELECT count(*) INTO v_virou_mes FROM public.radar_empresas
   WHERE prospeccao_status = 'virou_cliente'
     AND prospeccao_atualizado_em >= date_trunc('month', now());

  RETURN jsonb_build_object(
    'lote', v_lote, 'novos', COALESCE(v_novos, 0),
    'a_contatar', v_a_contatar, 'em_conversa', v_em_conversa,
    'virou_cliente_mes', v_virou_mes);
END $$;

-- 5) Trava: gestor/master via gate interno; só authenticated pode invocar.
REVOKE ALL ON FUNCTION public.registrar_contato_radar(text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.desfazer_contato_radar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_radar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_kpis() TO authenticated;

-- 6) Validação pós-apply (colar junto; esperar coluna_1=1, funcoes_3=3)
SELECT 'RADAR RPCS OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_contatos' AND column_name='status_anterior') AS coluna_1,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('registrar_contato_radar','desfazer_contato_radar','radar_kpis')) AS funcoes_3;
```

- [ ] **Step 3: Escrever o teste PG17**

Conteúdo de `db/test-radar-rpcs.sh` (dê `chmod +x`). Segue o padrão de `db/test-radar-fundacao.sh` (homebrew postgresql@17, mktemp, trap, LC_ALL=C). Stubs: `auth.uid()` via GUC, roles, `radar_empresas`/`radar_contatos` (recriados mínimos), stub de `pode_ver_carteira_completa`. Aplica a migration REAL por cima e exercita as RPCs:

```bash
#!/usr/bin/env bash
# Valida as RPCs de contato/KPIs do Radar num PostgreSQL 17 local.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55437
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs: schema mínimo que a migration referencia.
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz,
  descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL, acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL, novos integer);
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260612130000_radar_rpcs_contato.sql >/dev/null

"${PSQL[@]}" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_ingest_state VALUES ('2026-05','complete',1000);
INSERT INTO public.radar_empresas (cnpj, ultimo_lote) VALUES
  ('11111111000111','2026-05'), ('22222222000122','2026-05');

SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';

-- A1: registrar 'em_conversa' muda o status da empresa e loga com status_anterior='a_contatar'
DO $$
DECLARE r jsonb;
BEGIN
  r := public.registrar_contato_radar('11111111000111','em_conversa','falei com o dono');
  IF (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A1 FALHOU: não deveria deduplicar 1ª vez'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='11111111000111') <> 'em_conversa'
    THEN RAISE EXCEPTION 'A1 FALHOU: status não mudou'; END IF;
  IF (SELECT status_anterior FROM public.radar_contatos WHERE id=(r->>'id')::uuid) <> 'a_contatar'
    THEN RAISE EXCEPTION 'A1 FALHOU: status_anterior errado'; END IF;
  RAISE NOTICE 'A1 OK';
END $$;

-- A2: dedupe — mesma ação <2min devolve o mesmo id com deduped=true
DO $$
DECLARE r jsonb;
BEGIN
  r := public.registrar_contato_radar('11111111000111','em_conversa',NULL);
  IF NOT (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A2 FALHOU: deveria deduplicar'; END IF;
  RAISE NOTICE 'A2 OK';
END $$;

-- A3: undo reverte ao status_anterior e apaga a linha
DO $$
DECLARE r jsonb; v_id uuid; u jsonb;
BEGIN
  -- novo contato (descartado) numa empresa limpa, depois desfaz
  r := public.registrar_contato_radar('22222222000122','descartado','não é do ramo');
  v_id := (r->>'id')::uuid;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'descartado'
    THEN RAISE EXCEPTION 'A3 FALHOU: não descartou'; END IF;
  IF (SELECT descarte_motivo FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'não é do ramo'
    THEN RAISE EXCEPTION 'A3 FALHOU: motivo não gravou'; END IF;
  u := public.desfazer_contato_radar(v_id);
  IF NOT (u->>'deleted')::boolean THEN RAISE EXCEPTION 'A3 FALHOU: undo não deletou'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='22222222000122') <> 'a_contatar'
    THEN RAISE EXCEPTION 'A3 FALHOU: status não reverteu'; END IF;
  IF EXISTS (SELECT 1 FROM public.radar_contatos WHERE id=v_id)
    THEN RAISE EXCEPTION 'A3 FALHOU: linha não apagou'; END IF;
  RAISE NOTICE 'A3 OK';
END $$;

-- A4: undo anti-regressão — se um contato MAIS NOVO mudou o status, o undo do velho
--     apaga a linha mas NÃO reverte o status (não pisa no contato novo).
DO $$
DECLARE r1 jsonb; r2 jsonb; v_id1 uuid; u jsonb;
BEGIN
  r1 := public.registrar_contato_radar('11111111000111','contatado_sem_resposta',NULL); -- status→contatado_sem_resposta
  v_id1 := (r1->>'id')::uuid;
  r2 := public.registrar_contato_radar('11111111000111','virou_cliente',NULL);         -- status→virou_cliente (mais novo)
  u := public.desfazer_contato_radar(v_id1);  -- desfaz o VELHO
  IF NOT (u->>'deleted')::boolean THEN RAISE EXCEPTION 'A4 FALHOU: deveria apagar a linha velha'; END IF;
  IF (SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj='11111111000111') <> 'virou_cliente'
    THEN RAISE EXCEPTION 'A4 FALHOU: undo do velho pisou no status novo'; END IF;
  RAISE NOTICE 'A4 OK';
END $$;

-- A5: KPIs contam certo (novos lê o state; em_conversa/virou_cliente_mes contam a tabela)
DO $$
DECLARE k jsonb;
BEGIN
  k := public.radar_kpis();
  IF (k->>'lote') <> '2026-05' THEN RAISE EXCEPTION 'A5 FALHOU: lote'; END IF;
  IF (k->>'novos')::int <> 1000 THEN RAISE EXCEPTION 'A5 FALHOU: novos (esperado 1000 do state)'; END IF;
  IF (k->>'virou_cliente_mes')::int <> 1 THEN RAISE EXCEPTION 'A5 FALHOU: virou_cliente_mes (esperado 1)'; END IF;
  RAISE NOTICE 'A5 OK';
END $$;

RESET ROLE; SET test.uid = '';

-- A6: gate — não-gestor não registra nem lê KPIs (SQLSTATE de RAISE = P0001)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000b2'; -- não está em test_gestores
DO $$
BEGIN
  PERFORM public.registrar_contato_radar('11111111000111','em_conversa',NULL);
  RAISE EXCEPTION 'A6 FALHOU: não-gestor registrou';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A6 FALHOU%' THEN RAISE; END IF;
  RAISE NOTICE 'A6 OK (registrar negado)';
END $$;
DO $$
BEGIN
  PERFORM public.radar_kpis();
  RAISE EXCEPTION 'A6 FALHOU: não-gestor leu KPIs';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A6 FALHOU%' THEN RAISE; END IF;
  RAISE NOTICE 'A6b OK (kpis negado)';
END $$;
RESET ROLE;

-- A7: EXECUTE revogado de anon
DO $$
BEGIN
  IF has_function_privilege('anon','public.registrar_contato_radar(text,text,text)','EXECUTE')
    THEN RAISE EXCEPTION 'A7 FALHOU: anon tem EXECUTE'; END IF;
  RAISE NOTICE 'A7 OK';
END $$;
SQL
echo "✅ test-radar-rpcs: todos os asserts passaram"
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `./db/test-radar-rpcs.sh`
Expected: NOTICEs `A1 OK` … `A7 OK` + `✅ test-radar-rpcs: todos os asserts passaram`, exit 0.
Se um assert falhar, conserte a migration (não afrouxe o assert) e re-rode. Rode `shellcheck db/test-radar-rpcs.sh` e corrija findings reais.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260612130000_radar_rpcs_contato.sql db/test-radar-rpcs.sh
git commit -m "feat(radar): RPCs de contato (registrar/desfazer com undo anti-regressão) + radar_kpis, validadas PG17"
```

---

## Task 2: Helpers puros de apresentação (TDD)

**Files:**
- Create: `src/lib/radar/__tests__/ui-helpers.test.ts`
- Create: `src/lib/radar/ui-helpers.ts`

- [ ] **Step 1: Escrever o teste primeiro**

Conteúdo de `src/lib/radar/__tests__/ui-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ACOES_CONTATO, presetParaParams, idadeEmAnos, rotuloPorte,
  formatarCapital, formatarCnpj,
} from '../ui-helpers';

describe('ACOES_CONTATO', () => {
  it('cobre o vocabulário do radar (4 ações operáveis pela UI, sem a_contatar)', () => {
    const acoes = ACOES_CONTATO.map((a) => a.acao);
    expect(acoes).toEqual(['em_conversa', 'contatado_sem_resposta', 'virou_cliente', 'descartado']);
  });
  it('só descartado pede confirmação', () => {
    expect(ACOES_CONTATO.filter((a) => a.confirmar).map((a) => a.acao)).toEqual(['descartado']);
  });
});

describe('presetParaParams', () => {
  it('novas: ordena por data_abertura desc, sem corte de idade', () => {
    const p = presetParaParams('novas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'data_abertura', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null });
  });
  it('estabelecidas: corta abertura <= hoje-5anos e ordena por capital desc', () => {
    const p = presetParaParams('estabelecidas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'capital_social', orderAsc: false, dataAberturaMax: '2021-06-12', dataAberturaMin: null });
  });
});

describe('idadeEmAnos', () => {
  it('calcula anos completos', () => expect(idadeEmAnos('2020-06-12', '2026-06-12')).toBe(6));
  it('antes do aniversário no ano conta um a menos', () =>
    expect(idadeEmAnos('2020-06-13', '2026-06-12')).toBe(5));
  it('null/vazio → null', () => {
    expect(idadeEmAnos(null, '2026-06-12')).toBeNull();
    expect(idadeEmAnos('', '2026-06-12')).toBeNull();
  });
});

describe('rotuloPorte', () => {
  it('mapeia códigos RFB', () => {
    expect(rotuloPorte('01')).toBe('ME');
    expect(rotuloPorte('03')).toBe('EPP');
    expect(rotuloPorte('05')).toBe('Demais');
    expect(rotuloPorte('00')).toBe('Não informado');
  });
  it('desconhecido/null → —', () => {
    expect(rotuloPorte(null)).toBe('—');
    expect(rotuloPorte('99')).toBe('—');
  });
});

describe('formatarCapital', () => {
  it('formata BRL sem centavos', () => expect(formatarCapital(1500000)).toBe('R$ 1.500.000'));
  it('null → —', () => expect(formatarCapital(null)).toBe('—'));
});

describe('formatarCnpj', () => {
  it('aplica a máscara', () => expect(formatarCnpj('11222333000144')).toBe('11.222.333/0001-44'));
  it('tamanho errado → devolve cru', () => expect(formatarCnpj('123')).toBe('123'));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test src/lib/radar/__tests__/ui-helpers.test.ts`
Expected: FAIL — `Failed to resolve import "../ui-helpers"`.

- [ ] **Step 3: Implementar os helpers**

Conteúdo de `src/lib/radar/ui-helpers.ts`:

```ts
// Helpers PUROS de apresentação da tela /radar. Sem I/O — testáveis.

export type AcaoContato = 'em_conversa' | 'contatado_sem_resposta' | 'virou_cliente' | 'descartado';

export interface AcaoConfig {
  acao: AcaoContato;
  label: string;
  icon: 'message' | 'phone-missed' | 'check' | 'ban';
  confirmar: boolean;     // descartar pede confirmação (AlertDialog)
  destrutivo: boolean;    // estiliza em status-error
}

// Vocabulário operável pela UI (a_contatar é o estado inicial, não uma ação de menu).
export const ACOES_CONTATO: AcaoConfig[] = [
  { acao: 'em_conversa',            label: 'Falei — em conversa', icon: 'message',      confirmar: false, destrutivo: false },
  { acao: 'contatado_sem_resposta', label: 'Não atendeu',         icon: 'phone-missed', confirmar: false, destrutivo: false },
  { acao: 'virou_cliente',          label: 'Virou cliente',       icon: 'check',        confirmar: false, destrutivo: false },
  { acao: 'descartado',             label: 'Descartar',           icon: 'ban',          confirmar: true,  destrutivo: true  },
];

export type PresetRadar = 'novas' | 'estabelecidas';

export interface RadarOrderParams {
  orderColumn: 'data_abertura' | 'capital_social';
  orderAsc: boolean;
  dataAberturaMax: string | null;  // 'YYYY-MM-DD' (abertura <= isto)
  dataAberturaMin: string | null;  // 'YYYY-MM-DD' (abertura >= isto)
}

// Subtrai N anos de uma data ISO 'YYYY-MM-DD' (string-math, sem fuso).
function menosAnos(hojeISO: string, anos: number): string {
  const [a, m, d] = hojeISO.split('-');
  return `${String(Number(a) - anos).padStart(4, '0')}-${m}-${d}`;
}

export function presetParaParams(preset: PresetRadar, hojeISO: string): RadarOrderParams {
  if (preset === 'estabelecidas') {
    return { orderColumn: 'capital_social', orderAsc: false, dataAberturaMax: menosAnos(hojeISO, 5), dataAberturaMin: null };
  }
  return { orderColumn: 'data_abertura', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null };
}

export function idadeEmAnos(dataAbertura: string | null | undefined, hojeISO: string): number | null {
  if (!dataAbertura || !/^\d{4}-\d{2}-\d{2}$/.test(dataAbertura)) return null;
  const [ay, am, ad] = dataAbertura.split('-').map(Number);
  const [hy, hm, hd] = hojeISO.split('-').map(Number);
  let anos = hy - ay;
  if (hm < am || (hm === am && hd < ad)) anos -= 1;
  return anos;
}

const PORTE_RFB: Record<string, string> = { '00': 'Não informado', '01': 'ME', '03': 'EPP', '05': 'Demais' };
export function rotuloPorte(porte: string | null | undefined): string {
  if (!porte) return '—';
  return PORTE_RFB[porte] ?? '—';
}

export function formatarCapital(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
}

export function formatarCnpj(cnpj: string): string {
  if (!/^\d{14}$/.test(cnpj)) return cnpj;
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}
```

- [ ] **Step 4: Rodar e ver passar + typecheck**

Run: `heavy bun run test src/lib/radar/__tests__/ui-helpers.test.ts`
Expected: todos passam.
Run: `heavy bun run typecheck`
Expected: limpo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/radar/ui-helpers.ts src/lib/radar/__tests__/ui-helpers.test.ts
git commit -m "feat(radar): helpers puros de apresentação (vocabulário de ações, presets, idade, porte) — TDD"
```

---

## Task 3: Hooks de dados (KPIs, lista server-side, mutations)

**Files:**
- Create: `src/queries/useRadarKpis.ts`
- Create: `src/queries/useRadarLista.ts`
- Create: `src/queries/useRegistrarContatoRadar.ts`

- [ ] **Step 1: Hook de KPIs**

Conteúdo de `src/queries/useRadarKpis.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RadarKpis {
  lote: string | null;
  novos: number;
  a_contatar: number;
  em_conversa: number;
  virou_cliente_mes: number;
}

export function useRadarKpis() {
  return useQuery({
    queryKey: ['radar', 'kpis'],
    queryFn: async (): Promise<RadarKpis> => {
      const { data, error } = await supabase.rpc('radar_kpis');
      if (error) throw error;
      return data as unknown as RadarKpis;
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Hook da lista (infinite, server-side)**

Conteúdo de `src/queries/useRadarLista.ts`. Usa os helpers de `@/lib/postgrest` (`ilikeOr`) pra busca sanitizada e `presetParaParams` pro ordenamento/corte:

```ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilikeOr } from '@/lib/postgrest';
import { presetParaParams, type PresetRadar } from '@/lib/radar/ui-helpers';
import type { Database } from '@/integrations/supabase/types';

export type RadarEmpresa = Database['public']['Tables']['radar_empresas']['Row'];

export interface RadarFiltros {
  busca: string;
  uf: string;            // '' = todas
  municipio: string;     // '' = todos
  cnae: string;          // '' = todos (1 código por enquanto)
  status: string;        // '' = qualquer; senão um prospeccao_status
  incluirJaClientes: boolean;
  preset: PresetRadar;
}

const PAGE = 50;

export function useRadarLista(filtros: RadarFiltros, hojeISO: string) {
  return useInfiniteQuery({
    queryKey: ['radar', 'lista', filtros, hojeISO],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const p = presetParaParams(filtros.preset, hojeISO);
      let q = supabase.from('radar_empresas').select('*');

      if (filtros.busca.trim()) q = q.or(ilikeOr(['razao_social', 'nome_fantasia'], filtros.busca.trim()));
      if (filtros.uf) q = q.eq('uf', filtros.uf);
      if (filtros.municipio) q = q.eq('municipio_nome', filtros.municipio);
      if (filtros.cnae) q = q.eq('cnae_principal', filtros.cnae);
      if (filtros.status) q = q.eq('prospeccao_status', filtros.status);
      else q = q.neq('prospeccao_status', 'descartado'); // fila default esconde descartados
      if (!filtros.incluirJaClientes) q = q.eq('ja_cliente', false);
      if (p.dataAberturaMax) q = q.lte('data_abertura', p.dataAberturaMax);
      if (p.dataAberturaMin) q = q.gte('data_abertura', p.dataAberturaMin);

      const from = (pageParam as number) * PAGE;
      const { data, error } = await q
        .order(p.orderColumn, { ascending: p.orderAsc, nullsFirst: false })
        .order('cnpj', { ascending: true }) // tie-break estável p/ paginação
        .range(from, from + PAGE - 1);
      if (error) throw error;
      return data as RadarEmpresa[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length : undefined),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 3: Hooks de mutation (registrar + desfazer)**

Conteúdo de `src/queries/useRegistrarContatoRadar.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { AcaoContato } from '@/lib/radar/ui-helpers';

export function useRegistrarContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; acao: AcaoContato; nota?: string | null }) => {
      const { data, error } = await supabase.rpc('registrar_contato_radar', {
        p_cnpj: v.cnpj, p_acao: v.acao, p_nota: v.nota ?? null,
      });
      if (error) throw error;
      return data as unknown as { id: string; deduped: boolean };
    },
    onSuccess: (_d, v) => {
      track('radar.contato_registrado', { acao: v.acao });
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

export function useDesfazerContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('desfazer_contato_radar', { p_id: id });
      if (error) throw error;
      return data as unknown as { deleted: boolean };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radar'] }),
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `heavy bun run typecheck`
Expected: limpo. ⚠️ Se as RPCs `radar_kpis`/`registrar_contato_radar`/`desfazer_contato_radar` ainda não estiverem nos types gerados do Supabase (a migration da Task 1 não foi aplicada em prod ainda no momento do desenvolvimento), o `supabase.rpc('nome')` dará erro de tipo de string literal. Nesse caso, use o cast `supabase.rpc('radar_kpis' as never)` e os args `as never` — registre um comentário `// TODO: tipos regeneram após apply da migration da fatia 2`. NÃO adicione as funções ao types.ts à mão (lição §10: quebra com Duplicate identifier).

- [ ] **Step 5: Commit**

```bash
git add src/queries/useRadarKpis.ts src/queries/useRadarLista.ts src/queries/useRegistrarContatoRadar.ts
git commit -m "feat(radar): hooks de dados — KPIs, lista infinita server-side, mutations de contato"
```

---

## Task 4: Componentes de UI

**Files:**
- Create: `src/components/radar/RadarKpis.tsx`
- Create: `src/components/radar/RadarOutcomeMenu.tsx`
- Create: `src/components/radar/RadarLinha.tsx`
- Create: `src/components/radar/RadarDetailSheet.tsx`
- Create: `src/components/radar/RadarFiltros.tsx`

- [ ] **Step 1: RadarKpis (4 cards)**

Conteúdo de `src/components/radar/RadarKpis.tsx`:

```tsx
import { useRadarKpis } from '@/queries/useRadarKpis';
import { Skeleton } from '@/components/ui/skeleton';

function Card({ label, valor, hint }: { label: string; valor: number | string; hint?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{valor}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

export function RadarKpis() {
  const { data, isLoading } = useRadarKpis();
  if (isLoading) return <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card label="Novos no lote" valor={data.novos.toLocaleString('pt-BR')} hint={data.lote ?? undefined} />
      <Card label="A contatar" valor={data.a_contatar.toLocaleString('pt-BR')} />
      <Card label="Em conversa" valor={data.em_conversa.toLocaleString('pt-BR')} />
      <Card label="Viraram cliente (mês)" valor={data.virou_cliente_mes.toLocaleString('pt-BR')} />
    </div>
  );
}
```

- [ ] **Step 2: RadarOutcomeMenu (espelha OutcomeMenu)**

Conteúdo de `src/components/radar/RadarOutcomeMenu.tsx`:

```tsx
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, MessageCircle, PhoneMissed, Ban, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { useRegistrarContatoRadar, useDesfazerContatoRadar } from '@/queries/useRegistrarContatoRadar';
import { ACOES_CONTATO, type AcaoContato } from '@/lib/radar/ui-helpers';

const ICON = { message: MessageCircle, 'phone-missed': PhoneMissed, check: CheckCircle2, ban: Ban } as const;
const LABEL_OK: Record<AcaoContato, string> = {
  em_conversa: 'Marcado: em conversa',
  contatado_sem_resposta: 'Marcado: não atendeu',
  virou_cliente: 'Marcado: virou cliente',
  descartado: 'Lead descartado',
};

export function RadarOutcomeMenu({ cnpj }: { cnpj: string }) {
  const reg = useRegistrarContatoRadar();
  const undo = useDesfazerContatoRadar();
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [motivo, setMotivo] = useState('');

  const registrar = async (acao: AcaoContato, nota?: string) => {
    try {
      const r = await reg.mutateAsync({ cnpj, acao, nota });
      if (!r.deduped) {
        toast.success(LABEL_OK[acao], {
          action: {
            label: 'Desfazer',
            onClick: async () => {
              const u = await undo.mutateAsync(r.id);
              toast[u.deleted ? 'success' : 'error'](u.deleted ? 'Desfeito' : 'Não foi possível desfazer');
            },
          },
        });
      }
    } catch {
      toast.error('Não foi possível registrar');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={reg.isPending}>
            <ClipboardCheck className="w-4 h-4 mr-2" /> Registrar contato
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {ACOES_CONTATO.filter((a) => !a.confirmar).map((a) => {
            const Icon = ICON[a.icon];
            return (
              <DropdownMenuItem key={a.acao} onClick={() => registrar(a.acao)}>
                <Icon className="w-4 h-4 mr-2" /> {a.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-status-error" onClick={() => { setMotivo(''); setConfirmDescartar(true); }}>
            <Ban className="w-4 h-4 mr-2" /> Descartar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDescartar} onOpenChange={setConfirmDescartar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar este lead?</AlertDialogTitle>
            <AlertDialogDescription>
              Sai da fila de prospecção. Você pode anotar o motivo (opcional).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (opcional)" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => registrar('descartado', motivo || undefined)}>Descartar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

- [ ] **Step 3: RadarLinha (linha densa da lista)**

Conteúdo de `src/components/radar/RadarLinha.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';
import { idadeEmAnos, rotuloPorte, type PresetRadar } from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const STATUS_LABEL: Record<string, string> = {
  a_contatar: 'A contatar',
  contatado_sem_resposta: 'Não atendeu',
  em_conversa: 'Em conversa',
  descartado: 'Descartado',
  virou_cliente: 'Virou cliente',
};

export function RadarLinha({ empresa, hojeISO, onAbrir }: { empresa: RadarEmpresa; hojeISO: string; onAbrir: () => void }) {
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  return (
    <button
      onClick={onAbrir}
      className="w-full text-left border-b px-3 py-2 hover:bg-accent/50 transition-colors grid grid-cols-[1fr_auto] gap-2 items-center"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{empresa.nome_fantasia || empresa.razao_social || empresa.cnpj}</span>
          {empresa.ja_cliente && <Badge variant="secondary" className="shrink-0">já é cliente</Badge>}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[empresa.municipio_nome, empresa.uf].filter(Boolean).join(' · ')}
          {empresa.cnae_descricao ? ` · ${empresa.cnae_descricao}` : ''}
        </div>
      </div>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div>{idade != null ? `${idade} anos` : '—'} · {rotuloPorte(empresa.porte)}</div>
        <div>{STATUS_LABEL[empresa.prospeccao_status] ?? empresa.prospeccao_status}</div>
      </div>
    </button>
  );
}
```

- [ ] **Step 4: RadarDetailSheet (detalhe + registrar)**

Conteúdo de `src/components/radar/RadarDetailSheet.tsx`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MapPin, Phone, Mail } from 'lucide-react';
import { RadarOutcomeMenu } from './RadarOutcomeMenu';
import { formatarCnpj, formatarCapital, rotuloPorte, idadeEmAnos } from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

function Linha({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function RadarDetailSheet({ empresa, hojeISO, onClose }: { empresa: RadarEmpresa | null; hojeISO: string; onClose: () => void }) {
  if (!empresa) return null;
  const endereco = [empresa.logradouro, empresa.numero, empresa.bairro, empresa.municipio_nome, empresa.uf, empresa.cep].filter(Boolean).join(', ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco || empresa.cnpj)}`;
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  return (
    <Sheet open={!!empresa} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {empresa.razao_social || empresa.cnpj}
            {empresa.ja_cliente && <Badge variant="secondary">já é cliente</Badge>}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 flex justify-end">
          <RadarOutcomeMenu cnpj={empresa.cnpj} />
        </div>

        <div className="mt-4 divide-y">
          {empresa.nome_fantasia && <Linha label="Fantasia">{empresa.nome_fantasia}</Linha>}
          <Linha label="CNPJ"><span className="font-tabular">{formatarCnpj(empresa.cnpj)}</span></Linha>
          <Linha label="CNAE">{empresa.cnae_principal} {empresa.cnae_descricao ? `— ${empresa.cnae_descricao}` : ''}</Linha>
          <Linha label="Abertura">{empresa.data_abertura ?? '—'} {idade != null ? `(${idade} anos)` : ''}</Linha>
          <Linha label="Porte">{rotuloPorte(empresa.porte)}</Linha>
          <Linha label="Capital">{formatarCapital(empresa.capital_social)}</Linha>
          <Linha label="Telefone">
            {empresa.telefone1
              ? <a className="inline-flex items-center gap-1 underline" href={`tel:${empresa.telefone1}`}><Phone className="w-3 h-3" />{empresa.telefone1}</a>
              : '—'}
            {empresa.telefone2 ? ` · ${empresa.telefone2}` : ''}
          </Linha>
          <Linha label="E-mail">
            {empresa.email
              ? <a className="inline-flex items-center gap-1 underline truncate" href={`mailto:${empresa.email}`}><Mail className="w-3 h-3" />{empresa.email}</a>
              : '—'}
          </Linha>
          <Linha label="Endereço">
            {endereco || '—'}
            {endereco && (
              <a className="ml-2 inline-flex items-center gap-1 text-xs underline" href={mapsUrl} target="_blank" rel="noreferrer">
                <MapPin className="w-3 h-3" /> mapa
              </a>
            )}
          </Linha>
          {empresa.socios_nomes && <Linha label="Sócios">{empresa.socios_nomes}</Linha>}
          {empresa.descarte_motivo && <Linha label="Motivo descarte">{empresa.descarte_motivo}</Linha>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 5: RadarFiltros (busca + UF + status + presets + toggle já-cliente)**

Conteúdo de `src/components/radar/RadarFiltros.tsx`. `useUrlState` é montado na PÁGINA (Task 5) e passado por props pra este componente controlado:

```tsx
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { RadarFiltros as Filtros } from '@/queries/useRadarLista';
import type { PresetRadar } from '@/lib/radar/ui-helpers';

const UFS = ['', 'MG', 'SP', 'RJ', 'ES', 'PR', 'SC', 'RS', 'GO', 'BA', 'PE', 'CE'];
const STATUS = [
  { v: '', label: 'Fila (ativos)' },
  { v: 'a_contatar', label: 'A contatar' },
  { v: 'em_conversa', label: 'Em conversa' },
  { v: 'contatado_sem_resposta', label: 'Não atendeu' },
  { v: 'virou_cliente', label: 'Virou cliente' },
  { v: 'descartado', label: 'Descartados' },
];

export function RadarFiltros({ filtros, set }: { filtros: Filtros; set: (next: Partial<Filtros>) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button variant={filtros.preset === 'novas' ? 'default' : 'outline'} size="sm" onClick={() => set({ preset: 'novas' as PresetRadar })}>Novas do lote</Button>
        <Button variant={filtros.preset === 'estabelecidas' ? 'default' : 'outline'} size="sm" onClick={() => set({ preset: 'estabelecidas' as PresetRadar })}>Estabelecidas</Button>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-xs"
          placeholder="Buscar razão social / fantasia…"
          value={filtros.busca}
          onChange={(e) => set({ busca: e.target.value })}
        />
        <Select value={filtros.uf} onValueChange={(v) => set({ uf: v })}>
          <SelectTrigger className="w-28"><SelectValue placeholder="UF" /></SelectTrigger>
          <SelectContent>{UFS.map((u) => <SelectItem key={u || 'all'} value={u}>{u || 'Todas UFs'}</SelectItem>)}</SelectContent>
        </Select>
        <Input
          className="w-40"
          placeholder="Município"
          value={filtros.municipio}
          onChange={(e) => set({ municipio: e.target.value })}
        />
        <Input
          className="w-32 font-tabular"
          placeholder="CNAE (7 díg.)"
          value={filtros.cnae}
          onChange={(e) => set({ cnae: e.target.value.replace(/\D/g, '').slice(0, 7) })}
        />
        <Select value={filtros.status} onValueChange={(v) => set({ status: v })}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS.map((s) => <SelectItem key={s.v || 'fila'} value={s.v}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="jacli" checked={filtros.incluirJaClientes} onCheckedChange={(c) => set({ incluirJaClientes: c })} />
          <Label htmlFor="jacli" className="text-xs">incluir já-clientes</Label>
        </div>
      </div>
    </div>
  );
}
```

⚠️ Ao montar o `useUrlState` na Task 5, o `municipio` filtra por igualdade exata (`.eq('municipio_nome', …)`) — digitar parcial não casa. Aceitável v1 (o nome vem do dump RFB, maiúsculo). Se incomodar no uso, vira `.ilike` em follow-up.

- [ ] **Step 6: Typecheck dos componentes**

Run: `heavy bun run typecheck`
Expected: limpo (pode depender da Task 3; rode após ela).

- [ ] **Step 7: Commit**

```bash
git add src/components/radar/
git commit -m "feat(radar): componentes da tela — KPIs, filtros+presets, linha densa, detalhe (Sheet), menu de contato"
```

---

## Task 5: Página + rota + sidebar

**Files:**
- Create: `src/pages/RadarClientes.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Página RadarClientes**

Conteúdo de `src/pages/RadarClientes.tsx`. Monta `useUrlState`, compõe KPIs + filtros + lista infinita + Sheet. `hojeISO` é calculado uma vez (string local):

```tsx
import { useMemo, useState } from 'react';
import { useUrlState } from '@/hooks/useUrlState';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useRadarLista, type RadarFiltros, type RadarEmpresa } from '@/queries/useRadarLista';
import { RadarKpis } from '@/components/radar/RadarKpis';
import { RadarFiltros as Filtros } from '@/components/radar/RadarFiltros';
import { RadarLinha } from '@/components/radar/RadarLinha';
import { RadarDetailSheet } from '@/components/radar/RadarDetailSheet';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Radar } from 'lucide-react';
import type { PresetRadar } from '@/lib/radar/ui-helpers';

const DEFAULTS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, preset: 'novas',
};

export default function RadarClientes() {
  // useUrlState serializa primitivos; preset é string union compatível.
  const [raw, set] = useUrlState<Record<string, string | boolean>>(DEFAULTS as unknown as Record<string, string | boolean>);
  const filtros = raw as unknown as RadarFiltros;
  const hojeISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const q = useRadarLista(filtros, hojeISO);
  const [aberta, setAberta] = useState<RadarEmpresa | null>(null);
  const sentinelRef = useInfiniteScroll(() => q.fetchNextPage(), !!q.hasNextPage && !q.isFetchingNextPage);

  const empresas = q.data?.pages.flat() ?? [];

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-2">
        <Radar className="w-5 h-5" />
        <h1 className="text-2xl font-display">Radar de Clientes</h1>
      </div>
      <RadarKpis />
      <Filtros filtros={filtros} set={set as (next: Partial<RadarFiltros>) => void} />

      <div className="rounded-md border">
        {q.isLoading ? (
          <div className="p-3 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : q.isError ? (
          <EmptyState tone="operational" icon={Radar} title="Não foi possível carregar" description="Tente novamente em instantes." />
        ) : empresas.length === 0 ? (
          <EmptyState tone="operational" icon={Radar} title="Nenhuma empresa nesta fila" description="Ajuste os filtros ou troque o modo de ataque." />
        ) : (
          <>
            {empresas.map((e) => <RadarLinha key={e.cnpj} empresa={e} hojeISO={hojeISO} onAbrir={() => setAberta(e)} />)}
            <div ref={sentinelRef} className="h-10 flex items-center justify-center text-xs text-muted-foreground">
              {q.isFetchingNextPage ? 'Carregando…' : q.hasNextPage ? '' : 'Fim da lista'}
            </div>
          </>
        )}
      </div>

      <RadarDetailSheet empresa={aberta} hojeISO={hojeISO} onClose={() => setAberta(null)} />
    </div>
  );
}
```

⚠️ Sobre o `useUrlState` com `incluirJaClientes` boolean e `preset` union: o `useUrlState` serializa boolean nativamente; `preset` é string. O cast duplo (`DEFAULTS as unknown as Record<string, string | boolean>`) é o ponto de fricção de tipo — se o typecheck reclamar do shape, ajuste pra um `useUrlState<RadarFiltros>(DEFAULTS)` direto (a assinatura aceita `S extends StateShape`; confira se `StateShape` permite a union `PresetRadar` — se não, troque `preset` por `string` no tipo `RadarFiltros` e faça o cast no `presetParaParams`). Resolva da forma que mantém o typecheck limpo SEM `any`.

- [ ] **Step 2: Registrar a rota lazy no App.tsx**

Em `src/App.tsx`, ache o bloco de imports lazy (`const X = lazy(() => import(...))`) e adicione:

```tsx
const RadarClientes = lazy(() => import("./pages/RadarClientes"));
```

Ache as rotas DENTRO do `<AppShellLayout>` (onde estão `rota/ligacoes` etc.) e adicione, junto às rotas de gestão:

```tsx
<Route path="radar" element={<RadarClientes />} />
```

(O wrapper de staff já vem do AppShellLayout; o gate fino de gestor/master é reforçado pela RLS + RPC no servidor e pela visibilidade do item de menu.)

- [ ] **Step 3: Adicionar o item na sidebar (seção Gestão)**

Em `src/components/AppShell.tsx`, ache a seção "Gestão" (procure por `label: 'Gestão'` ou o array de NavItems dessa seção) e adicione, importando o ícone `Radar` de `lucide-react` no topo se ainda não estiver:

```tsx
{ icon: Radar, label: 'Radar de Clientes', path: '/radar', gestorComercialOuMaster: true },
```

Confirme que o ícone `Radar` está no import de `lucide-react` do arquivo (adicione se faltar).

- [ ] **Step 4: Typecheck + lint + build**

Run: `heavy bun run typecheck`
Expected: limpo.
Run: `bun lint 2>&1 | grep -c " error "` (espere `0`)
Run: `heavy bun run build` (espere sucesso — a rota lazy precisa resolver)

- [ ] **Step 5: Commit**

```bash
git add src/pages/RadarClientes.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(radar): página /radar (KPIs + filtros + lista infinita + detalhe) + rota + item de sidebar (Gestão)"
```

---

## Task 6: CI verde + PR

- [ ] **Step 1: Gates locais (cada um separado — nunca `| tail` quando o exit decide um gate)**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"`
Run: `heavy bun run test > /tmp/test.log 2>&1; echo "test=$?"; grep -E "Tests " /tmp/test.log | tail -1`
Run: `bun lint > /tmp/lint.log 2>&1; echo "lint=$?"`
Expected: typecheck=0, test=0 (todos os testes), lint=0 (errors).

- [ ] **Step 2: Regenerar audit de migrations**

Run: `bun run audit:migrations`
Expected: `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` atualizados com a `20260612130000`.

- [ ] **Step 3: Commit do audit + push + PR**

```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(radar): regenera audit de migrations (fatia 2)"
git push -u origin HEAD
```

PR (⚠️ a rede desta máquina tem rota quebrada pra `api.github.com` — se `gh pr create` der i/o timeout, use o REST com IP alternativo: `curl --resolve api.github.com:443:140.82.112.6 ...` — ver lição §"Auditoria de velocidade" no CLAUDE.md). Corpo do PR:

```
feat(radar): Fatia 2 — tela /radar (lista server-side + filtros + detalhe + registrar contato + KPIs)

Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md (fatia 2/4). Plano: docs/superpowers/plans/2026-06-12-radar-clientes-fatia2-tela.md.

**ATENÇÃO: migration manual necessária** — 20260612130000_radar_rpcs_contato.sql (ALTER radar_contatos + 3 RPCs). SQL inline no chat. Validada em PG17 (db/test-radar-rpcs.sh, A1-A7).
Sem edge nova. Requer Publish do frontend (tem UI).
```

- [ ] **Step 4: Auto-merge**

Arme o squash-merge automático (mesmo padrão da fatia 1, via REST com IP alternativo se o `gh` falhar).

---

## Task 7: Rollout com o founder (pós-merge)

- [ ] **Step 1: Entregar a migration inline no chat** (BLOCO único `sql`, com a query de validação no fim). Founder cola no SQL Editor → confirma `RADAR RPCS OK | coluna_1=1 | funcoes_3=3`.

- [ ] **Step 2: Publish do frontend** no Lovable (a fatia 2 TEM UI — sem Publish, a tela não vai ao ar). Lembrar o founder (lição §"Deploy do FRONTEND").

- [ ] **Step 3: Smoke com o founder**: abrir `/radar` (logado como master), conferir KPIs (novos do lote 2026-05, a-contatar > 0), filtrar por MG, alternar preset Estabelecidas, abrir uma empresa no Sheet, registrar "Em conversa" + Desfazer. Reportar.

- [ ] **Step 4: Atualizar roadmap + CLAUDE.md** marcando a fatia 2 ✅ e apontando a fatia 3 (ações Omie + tarefa + mapa).

---

## Self-review (feita na escrita)

- **Cobertura da spec (fatia 2):** §3.3 RPCs registrar/desfazer ✅ (Task 1; `radar_contagem_por_municipio` é da fatia 3, fora) · §3.6.1 registrar contato (vocabulário+undo) ✅ (Tasks 1/4) · §3.7 KPIs ✅ (Task 1 RPC + Task 4) · filtros server-side `useUrlState` ✅ (Tasks 3/4/5) · presets novas/estabelecidas ✅ (Task 2 `presetParaParams` + Task 4) · lista `useInfiniteQuery` server-side ✅ (Task 3) · Sheet de detalhe + sócios + link Maps ✅ (Task 4) · gate gestor/master ✅ (RPC + RLS + item de menu) · padrões `PageSkeleton`/`EmptyState`/`track` ✅. **Fora de escopo explícito:** mapa Leaflet, cadastrar no Omie, atribuir Tarefa, toggle "só cidades da rota" (depende de cruzar `route_schedule` — **adiado pra fatia 3 junto com o mapa**, registrado como nota).
- **Toggle "só cidades da rota":** a spec §3.7 lista esse filtro, mas ele exige cruzar `route_schedule` + `normalizeCityKey` (mesma infra do mapa). **Decisão: adiar pra fatia 3** (não bloqueia a fila utilizável; o filtro por UF/município já cobre o recorte geográfico na v1). Atualizar a spec com essa decisão na Task 7.
- **Undo do status desnormalizado:** resolvido com `status_anterior` na linha do log + guard anti-regressão (Task 1 A4) — decisão de design nova, documentada na migration.
- **Tipos:** `RadarEmpresa` = `Database['public']['Tables']['radar_empresas']['Row']` (types já existem, sem cast). As 3 RPCs novas podem precisar de cast `as never` até a migration ser aplicada (anotado na Task 3 Step 4).
- **Placeholders:** nenhum — todo step tem código completo ou comando com expected.
- **Consistência de nomes:** `RadarFiltros` (tipo em useRadarLista) reusado nos componentes; `AcaoContato` de ui-helpers usado nos hooks e no menu; `presetParaParams`/`idadeEmAnos`/`rotuloPorte`/`formatarCapital`/`formatarCnpj` idênticos entre teste, helper e consumidores.
