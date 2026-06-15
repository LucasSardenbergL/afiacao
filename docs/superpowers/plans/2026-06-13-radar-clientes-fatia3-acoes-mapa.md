# Radar de Clientes — Fatia 3 (totalizador/ranking de cidades + ações Oben + mapa) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar a v1 do Radar — totalizador/ranking de cidades ("onde caçar"), contatabilidade (WhatsApp), cadastrar lead no Omie (Oben) + atribuir Tarefa, e o mapa.

**Architecture:** Uma RPC `radar_contagem_por_municipio` (SECURITY DEFINER, gate gestor/master) agrega por `municipio_codigo`+UF e alimenta **ranking + totalizador + mapa** (um backend, três usos). Cadastro no Omie **reusa a action existente `omie-vendas-sync/criar_cliente` (account=oben)** — sem edge nova; o Radar só persiste o resultado via RPC `radar_registrar_cadastro_omie`. Atribuir Tarefa via RPC `radar_atribuir_tarefa` (insere em `tarefas` com `modo='data'`). Mapa = componente `RadarMapa` (Leaflet, lazy) espelhando o padrão do `AdminRoutePlanner`.

**Tech Stack:** PostgreSQL 17 (validação local), Supabase RPC SECURITY DEFINER, React 18 + TS strict, @tanstack/react-query, Leaflet 1.9, Vitest.

> ⚠️ **Decisão de implementação que MELHORA a spec (destacar ao founder):** a spec §2b dizia "edge `omie-sync` action `radar_cadastrar_cliente`". A investigação mostrou que `omie-sync.callOmieApi` é **hardcoded Colacor SC** (não serve pra Oben), enquanto `omie-vendas-sync/criar_cliente` **já cadastra por conta** (`account:'oben'`), é idempotente (`buscarClienteVendas` = ListarClientes-first) e já é usada pelo fluxo de vendas. **Reusar elimina a task de edge** (sem código novo em money-path, sem deploy manual). O Radar só persiste o resultado.

> ⚠️ **Restrições do projeto (ver CLAUDE.md):** migration é **manual** (entregar SQL inline pro SQL Editor do Lovable); **sem deploy de edge nesta fatia** (reuso de action existente); frontend exige **Publish manual** no Lovable; comandos pesados com prefixo `heavy`; nunca `| tail` quando o exit code importa.

> 🔑 **Lição da RLS (aplicada nesta fatia):** as RPCs SECURITY DEFINER chamam `pode_ver_carteira_completa((SELECT auth.uid()))` **uma vez** no `IF` do topo (não numa cláusula RLS USING). Como SECURITY DEFINER roda como owner, o SELECT interno **bypassa a RLS de `radar_empresas`** → não há avaliação por-linha do gate (o problema do #792 era na RLS, não aqui). O gate único no topo é o que protege contra vazamento.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `supabase/migrations/20260613190000_radar_fatia3.sql` | ALTER `radar_empresas` (+2 col) + 3 RPCs (`radar_contagem_por_municipio`, `radar_atribuir_tarefa`, `radar_registrar_cadastro_omie`) | Create |
| `db/test-radar-fatia3.sh` | Validação PG17 das 3 RPCs (A1–A9) | Create |
| `src/lib/phone.ts` | + `isCellphone` (deriva celular p/ decidir WhatsApp) | Modify |
| `src/lib/__tests__/phone.test.ts` | testes do `isCellphone` (criar arquivo se não existir; senão append) | Create/Modify |
| `src/hooks/useDebouncedValue.ts` | debounce genérico (evita recalcular contagem a cada tecla) — **só criar se não existir** | Create? |
| `src/queries/useRadarContagemMunicipios.ts` | hook da RPC de contagem (ranking + mapa) | Create |
| `src/queries/useRadarAcoesLead.ts` | hooks `useRadarCadastrarOmie` (invoke edge + persiste RPC) + `useRadarAtribuirTarefa` | Create |
| `src/queries/useRadarLista.ts` | + filtro `comTelefone` (mantém `select('*')`) | Modify |
| `src/components/radar/RadarRankingCidades.tsx` | painel "onde caçar" (top-N cidades, clicável) | Create |
| `src/components/radar/RadarMapa.tsx` | mapa Leaflet (lazy), bolhas por cidade | Create |
| `src/components/radar/RadarAcoesLead.tsx` | botões Cadastrar-Omie + Criar-tarefa + WhatsApp (usado no Sheet) | Create |
| `src/components/radar/RadarFiltros.tsx` | + toggle "com telefone" | Modify |
| `src/components/radar/RadarDetailSheet.tsx` | montar `RadarAcoesLead` + botão WhatsApp | Modify |
| `src/pages/RadarClientes.tsx` | ranking + totalizador/selo-lote + toggle Lista\|Mapa | Modify |

---

## Task 1: Migration SQL (3 RPCs) + validação PG17

**Files:**
- Create: `supabase/migrations/20260613190000_radar_fatia3.sql`
- Create: `db/test-radar-fatia3.sh`

- [ ] **Step 1: Escrever a migration**

Crie `supabase/migrations/20260613190000_radar_fatia3.sql`:

```sql
-- =============================================================================
-- RADAR DE CLIENTES — Fatia 3: contagem por município + ações (tarefa + Omie)
-- Spec: docs/superpowers/specs/2026-06-13-radar-clientes-fatia3-acoes-mapa-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate de todas as RPCs: gestor/master via pode_ver_carteira_completa (helper já
-- em prod; mesmo gate da RLS de SELECT das tabelas radar_*).
-- Nota RLS: as RPCs são SECURITY DEFINER (rodam como owner → bypassam a RLS de
-- radar_empresas), então o gate `pode_ver_carteira_completa` no IF do topo é a
-- ÚNICA fronteira de leitura — e é avaliado 1× (não por-linha como na RLS #792).
-- =============================================================================

-- 1) Persistência do cadastro no Omie (Oben) por lead.
ALTER TABLE public.radar_empresas
  ADD COLUMN IF NOT EXISTS omie_codigo_cliente text,
  ADD COLUMN IF NOT EXISTS omie_cadastrado_em  timestamptz;

-- 2) Contagem por município — serve ranking ("onde caçar") + totalizador + mapa.
--    Aplica os MESMOS filtros ESTRUTURAIS da lista (NÃO a busca textual livre —
--    busca por nome é p/ achar 1 empresa, não p/ ranking geográfico; omitir evita
--    o ILIKE '%%' full-scan). Agrupa por municipio_codigo+UF (nome repete entre UFs).
CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(
  p_uf                   text    DEFAULT NULL,
  p_cnae_prefix          text    DEFAULT NULL,
  p_cnae_exato           text    DEFAULT NULL,
  p_status               text    DEFAULT NULL,
  p_incluir_ja_clientes  boolean DEFAULT false,
  p_data_abertura_min    date    DEFAULT NULL,
  p_data_abertura_max    date    DEFAULT NULL,
  p_limit                integer DEFAULT 500
) RETURNS TABLE(
  municipio_codigo text, municipio_nome text, uf text,
  lat double precision, lng double precision,
  total bigint, com_telefone bigint, a_contatar bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  -- só-dígitos defensivo (o cnae já vem normalizado do front, mas a RPC é pública a authenticated)
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;

  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix || '%')
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $$;

-- 3) Atribuir Tarefa de prospecção (sempre pro caller; lead não tem cliente).
--    tarefas: modo='data' EXIGE due_date NOT NULL + interacao_tipo NULL (constraint
--    tarefas_modo_coerencia_chk). auto_satisfy_mode='off' (matcher casa por cliente,
--    que o lead não tem — sem auto-baixa, honesto). customer_user_id NULL (nullable
--    desde a fase 2 de tarefas). categoria='ligar'.
CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(
  p_cnpj text, p_dias_retomada integer DEFAULT 7
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_razao text; v_fantasia text; v_municipio text; v_uf text; v_tel text;
  v_existing uuid; v_id uuid; v_desc text;
  v_dias integer := GREATEST(1, LEAST(COALESCE(p_dias_retomada, 7), 90));
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT razao_social, nome_fantasia, municipio_nome, uf, telefone1
    INTO v_razao, v_fantasia, v_municipio, v_uf, v_tel
    FROM public.radar_empresas WHERE cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- dedupe anti duplo-clique (advisory lock + busca curta por tarefa aberta do mesmo cnpj)
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':tarefa:radar', 0));
  SELECT id INTO v_existing FROM public.tarefas
   WHERE created_by = v_uid AND empresa = 'oben' AND customer_user_id IS NULL
     AND status = 'aberta' AND descricao LIKE '%CNPJ '||p_cnpj||'%'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  v_desc := 'Prospecção: ' || COALESCE(NULLIF(v_fantasia,''), NULLIF(v_razao,''), p_cnpj)
            || ' · ' || COALESCE(v_municipio,'?') || '/' || COALESCE(v_uf,'?')
            || COALESCE(' · tel ' || NULLIF(v_tel,''), '')
            || ' · CNPJ ' || p_cnpj;

  INSERT INTO public.tarefas (
    descricao, categoria, customer_user_id, assigned_to, created_by, empresa,
    modo, due_date, interacao_tipo, auto_satisfy_mode, status
  ) VALUES (
    v_desc, 'ligar', NULL, v_uid, v_uid, 'oben',
    'data', (current_date + v_dias), NULL, 'off', 'aberta'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- 4) Persistir o cadastro no Omie (chamada pelo front DEPOIS da edge omie-vendas-sync).
--    Idempotente: re-clicar sobrescreve o código e re-loga (a edge reconcilia o CNPJ).
CREATE OR REPLACE FUNCTION public.radar_registrar_cadastro_omie(
  p_cnpj text, p_codigo_cliente text, p_ja_existia boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status_atual text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  UPDATE public.radar_empresas SET
    omie_codigo_cliente = COALESCE(NULLIF(p_codigo_cliente,''), omie_codigo_cliente),
    omie_cadastrado_em = now(),
    prospeccao_status = 'virou_cliente',
    prospeccao_atualizado_em = now(),
    ja_cliente = true,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, 'virou_cliente',
    CASE WHEN p_ja_existia
      THEN 'Já cadastrado no Omie/Oben (cód. ' || COALESCE(NULLIF(p_codigo_cliente,''),'?') || ')'
      ELSE 'Cadastrado no Omie/Oben (cód. ' || COALESCE(NULLIF(p_codigo_cliente,''),'?') || ')' END,
    v_uid, v_status_atual);

  RETURN jsonb_build_object('ok', true);
END $$;

-- 5) Travas: só authenticated invoca; o gate interno confere gestor/master.
REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_atribuir_tarefa(text,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO authenticated;

-- 6) Validação pós-apply (colar junto; esperar colunas_2=2, funcoes_3=3)
SELECT 'RADAR FATIA3 OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_empresas'
      AND column_name IN ('omie_codigo_cliente','omie_cadastrado_em')) AS colunas_2,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('radar_contagem_por_municipio','radar_atribuir_tarefa','radar_registrar_cadastro_omie')) AS funcoes_3;
```

- [ ] **Step 2: Escrever o teste PG17**

Crie `db/test-radar-fatia3.sh` (espelha o `db/test-radar-rpcs.sh`):

```bash
#!/usr/bin/env bash
# Valida as RPCs da Fatia 3 do Radar num PostgreSQL 17 local.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55438
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs: schema mínimo que a migration referencia (radar_* + tarefas + gate).
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY,
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL,
  data_abertura date,
  municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  omie_codigo_cliente text, omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL,
  lat double precision, lng double precision);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL, acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, status_anterior text,
  created_at timestamptz NOT NULL DEFAULT now());
-- tarefas: réplica mínima com os CHECKs que a RPC precisa satisfazer.
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('ligar','oferecer','preco','whatsapp','outro')),
  customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL,
  empresa text NOT NULL,
  modo text NOT NULL CHECK (modo IN ('data','interacao')),
  due_date date, interacao_tipo text CHECK (interacao_tipo IN ('ligacao','visita','entrega')),
  auto_satisfy_mode text NOT NULL DEFAULT 'off' CHECK (auto_satisfy_mode IN ('off','interacao','conteudo')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','cancelada')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tarefas_modo_coerencia_chk CHECK (
    (modo='data' AND due_date IS NOT NULL AND interacao_tipo IS NULL)
    OR (modo='interacao' AND interacao_tipo IS NOT NULL AND due_date IS NULL)));
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260613190000_radar_fatia3.sql >/dev/null

"${PSQL[@]}" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_municipios VALUES
  ('3106200','BELO HORIZONTE','MG',-19.92,-43.94),
  ('3550308','SAO PAULO','SP',-23.55,-46.63);
-- 3 em BH (2 com telefone, 2 a_contatar, 1 já cliente), 1 em SP, 1 descartada.
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, municipio_codigo, municipio_nome, uf, telefone1, prospeccao_status, ja_cliente, ultimo_lote, data_abertura) VALUES
  ('11111111000111','MARCENARIA A','3101200','3106200','BELO HORIZONTE','MG','31999990001','a_contatar',false,'2026-05','2020-01-10'),
  ('22222222000122','MARCENARIA B','3101200','3106200','BELO HORIZONTE','MG',NULL,        'a_contatar',false,'2026-05','2024-06-01'),
  ('33333333000133','MOVEIS C',    '3101200','3106200','BELO HORIZONTE','MG','3133334444','em_conversa',true, '2026-05','2015-03-03'),
  ('44444444000144','SERRALHERIA D','2512800','3550308','SAO PAULO','SP','11988887777','a_contatar',false,'2026-05','2019-09-09'),
  ('55555555000155','DESCARTADA E','3101200','3106200','BELO HORIZONTE','MG','31900000000','descartado',false,'2026-05','2021-01-01');

SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';

-- A1: contagem por município — BH default (exclui descartada + já-cliente) = 2 total, 1 com telefone, 2 a_contatar.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT * FROM public.radar_contagem_por_municipio() LOOP
    n := n + 1;
    IF r.municipio_codigo = '3106200' THEN
      IF r.total <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: BH total=% (esperado 2)', r.total; END IF;
      IF r.com_telefone <> 1 THEN RAISE EXCEPTION 'A1 FALHOU: BH com_telefone=% (esperado 1)', r.com_telefone; END IF;
      IF r.a_contatar <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: BH a_contatar=% (esperado 2)', r.a_contatar; END IF;
      IF r.lat IS NULL THEN RAISE EXCEPTION 'A1 FALHOU: BH sem lat (join radar_municipios)'; END IF;
    END IF;
  END LOOP;
  IF n <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: % municípios (esperado 2: BH+SP)', n; END IF;
  RAISE NOTICE 'A1 OK';
END $$;

-- A2: filtro UF=MG + cnae exato 3101200 → só BH com 2; SP some.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.radar_contagem_por_municipio('MG', NULL, '3101200');
  IF n <> 1 THEN RAISE EXCEPTION 'A2 FALHOU: % linhas (esperado 1 = só BH)', n; END IF;
  RAISE NOTICE 'A2 OK';
END $$;

-- A3: incluir já-clientes → BH total sobe pra 3.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.radar_contagem_por_municipio('MG',NULL,NULL,NULL,true) WHERE municipio_codigo='3106200';
  IF r.total <> 3 THEN RAISE EXCEPTION 'A3 FALHOU: BH com já-clientes total=% (esperado 3)', r.total; END IF;
  RAISE NOTICE 'A3 OK';
END $$;

-- A4: atribuir tarefa cria 1 linha correta (modo=data, due_date=hoje+7, customer NULL, oben, ligar).
DO $$
DECLARE r jsonb; t record;
BEGIN
  r := public.radar_atribuir_tarefa('11111111000111', 7);
  IF (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A4 FALHOU: não deveria deduplicar 1ª vez'; END IF;
  SELECT * INTO t FROM public.tarefas WHERE id=(r->>'id')::uuid;
  IF t.customer_user_id IS NOT NULL THEN RAISE EXCEPTION 'A4 FALHOU: customer_user_id deveria ser NULL'; END IF;
  IF t.assigned_to <> '00000000-0000-0000-0000-0000000000a1' THEN RAISE EXCEPTION 'A4 FALHOU: assigned_to'; END IF;
  IF t.empresa <> 'oben' OR t.categoria <> 'ligar' OR t.modo <> 'data' THEN RAISE EXCEPTION 'A4 FALHOU: campos'; END IF;
  IF t.due_date <> current_date + 7 THEN RAISE EXCEPTION 'A4 FALHOU: due_date'; END IF;
  IF t.descricao NOT LIKE '%CNPJ 11111111000111%' THEN RAISE EXCEPTION 'A4 FALHOU: descricao sem cnpj'; END IF;
  RAISE NOTICE 'A4 OK';
END $$;

-- A5: dedupe da tarefa (2ª chamada <2min devolve deduped=true, não cria 2ª linha).
DO $$
DECLARE r jsonb; n int;
BEGIN
  r := public.radar_atribuir_tarefa('11111111000111', 7);
  IF NOT (r->>'deduped')::boolean THEN RAISE EXCEPTION 'A5 FALHOU: deveria deduplicar'; END IF;
  SELECT count(*) INTO n FROM public.tarefas WHERE descricao LIKE '%CNPJ 11111111000111%';
  IF n <> 1 THEN RAISE EXCEPTION 'A5 FALHOU: criou % tarefas (esperado 1)', n; END IF;
  RAISE NOTICE 'A5 OK';
END $$;

-- A6: registrar cadastro Omie → marca virou_cliente + ja_cliente + omie_codigo_cliente + loga.
DO $$
DECLARE r jsonb; e record; c int;
BEGIN
  r := public.radar_registrar_cadastro_omie('22222222000122', '9988', false);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'A6 FALHOU: ok'; END IF;
  SELECT * INTO e FROM public.radar_empresas WHERE cnpj='22222222000122';
  IF e.prospeccao_status <> 'virou_cliente' THEN RAISE EXCEPTION 'A6 FALHOU: status'; END IF;
  IF e.ja_cliente <> true THEN RAISE EXCEPTION 'A6 FALHOU: ja_cliente'; END IF;
  IF e.omie_codigo_cliente <> '9988' THEN RAISE EXCEPTION 'A6 FALHOU: codigo'; END IF;
  SELECT count(*) INTO c FROM public.radar_contatos WHERE cnpj='22222222000122' AND acao='virou_cliente';
  IF c <> 1 THEN RAISE EXCEPTION 'A6 FALHOU: não logou'; END IF;
  RAISE NOTICE 'A6 OK';
END $$;

RESET ROLE; SET test.uid = '';

-- A7: gate — não-gestor é negado nas 3 RPCs.
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000b2'; -- não está em test_gestores
DO $$ BEGIN
  PERFORM public.radar_contagem_por_municipio();
  RAISE EXCEPTION 'A7 FALHOU: não-gestor leu contagem';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7a OK';
END $$;
DO $$ BEGIN
  PERFORM public.radar_atribuir_tarefa('11111111000111', 7);
  RAISE EXCEPTION 'A7 FALHOU: não-gestor criou tarefa';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7b OK';
END $$;
DO $$ BEGIN
  PERFORM public.radar_registrar_cadastro_omie('11111111000111','1',false);
  RAISE EXCEPTION 'A7 FALHOU: não-gestor registrou cadastro';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'A7 FALHOU%' THEN RAISE; END IF; RAISE NOTICE 'A7c OK';
END $$;
RESET ROLE;

-- A8: EXECUTE revogado de anon nas 3.
DO $$ BEGIN
  IF has_function_privilege('anon','public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'A8 FALHOU: anon tem EXECUTE na contagem'; END IF;
  IF has_function_privilege('anon','public.radar_atribuir_tarefa(text,integer)','EXECUTE')
    THEN RAISE EXCEPTION 'A8 FALHOU: anon tem EXECUTE na tarefa'; END IF;
  RAISE NOTICE 'A8 OK';
END $$;

-- A9 (perf informativo): contagem sem filtro sobre N linhas mede o pior caso.
--   (com 5 linhas é trivial; em prod o front debounça. Só prova que não dá erro.)
DO $$ DECLARE n int; BEGIN
  SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-0000000000a1';
  SELECT count(*) INTO n FROM public.radar_contagem_por_municipio();
  RAISE NOTICE 'A9 OK (contagem retornou % municípios)', n;
  RESET ROLE;
END $$;
SQL
echo "✅ test-radar-fatia3: todos os asserts passaram"
```

- [ ] **Step 3: Rodar o teste (deve passar)**

Run: `heavy bash db/test-radar-fatia3.sh > /tmp/radar-f3.log 2>&1; echo "exit=$?"; tail -20 /tmp/radar-f3.log`
Expected: `exit=0` e a última linha `✅ test-radar-fatia3: todos os asserts passaram` (A1..A9 NOTICE OK). ⚠️ **Não** usar `| tail` (engole o exit code — lição §2).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613190000_radar_fatia3.sql db/test-radar-fatia3.sh
git commit -m "feat(radar): Fatia 3 migration — contagem por municipio + RPCs de tarefa/cadastro Omie (PG17 A1-A9)"
```

---

## Task 2: Helper `isCellphone` (TDD)

**Files:**
- Modify: `src/lib/phone.ts`
- Test: `src/lib/__tests__/phone.test.ts` (criar se não existir)

- [ ] **Step 1: Escrever o teste primeiro**

Append em `src/lib/__tests__/phone.test.ts` (se o arquivo não existir, crie com o import + describe):

```typescript
import { describe, it, expect } from 'vitest';
import { isCellphone } from '@/lib/phone';

describe('isCellphone', () => {
  it('celular com DDD (11 dígitos, 9 na frente) → true', () => {
    expect(isCellphone('31999990001')).toBe(true);
    expect(isCellphone('(31) 99999-0001')).toBe(true);
    expect(isCellphone('5531999990001')).toBe(true); // com +55
  });
  it('fixo (10 dígitos) → false', () => {
    expect(isCellphone('3133334444')).toBe(false);
    expect(isCellphone('(31) 3333-4444')).toBe(false);
  });
  it('vazio/nulo/curto → false', () => {
    expect(isCellphone(null)).toBe(false);
    expect(isCellphone(undefined)).toBe(false);
    expect(isCellphone('')).toBe(false);
    expect(isCellphone('999')).toBe(false);
  });
  it('sem DDD com 9 dígitos (9XXXX-XXXX) → aplica DDD padrão e é celular', () => {
    expect(isCellphone('999990001')).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar o teste (deve FALHAR — isCellphone não existe)**

Run: `heavy bun run test src/lib/__tests__/phone.test.ts > /tmp/phone.log 2>&1; echo "exit=$?"; tail -15 /tmp/phone.log`
Expected: FAIL com "isCellphone is not exported" ou similar.

- [ ] **Step 3: Implementar `isCellphone` em `src/lib/phone.ts`**

Adicione ao fim de `src/lib/phone.ts` (reusa `normalizeBrPhone` já existente):

```typescript
/**
 * Retorna true se o telefone é celular (11 dígitos normalizados com 9 na 3ª posição).
 * Fixo = 10 dígitos. Usado p/ decidir mostrar o botão WhatsApp (celular) vs só ligar.
 */
export function isCellphone(phone: string | null | undefined): boolean {
  const d = normalizeBrPhone(phone);
  return d.length === 11 && d[2] === '9';
}
```

- [ ] **Step 4: Rodar o teste (deve PASSAR)**

Run: `heavy bun run test src/lib/__tests__/phone.test.ts > /tmp/phone.log 2>&1; echo "exit=$?"; tail -15 /tmp/phone.log`
Expected: PASS (todos os casos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/phone.ts src/lib/__tests__/phone.test.ts
git commit -m "feat(radar): isCellphone helper (decide botão WhatsApp p/ celular)"
```

---

## Task 3: Hooks de dados + filtro "com telefone"

**Files:**
- Create: `src/hooks/useDebouncedValue.ts` (**só se não existir** — `grep -r "useDebouncedValue\|useDebounce" src/hooks` antes)
- Create: `src/queries/useRadarContagemMunicipios.ts`
- Create: `src/queries/useRadarAcoesLead.ts`
- Modify: `src/queries/useRadarLista.ts`

- [ ] **Step 1: Garantir `useDebouncedValue`**

Run: `grep -rl "export function useDebouncedValue\|export const useDebouncedValue" src/`
- Se já existir, pule este step (reuse o existente, ajuste o import nos próximos steps).
- Se NÃO existir, crie `src/hooks/useDebouncedValue.ts`:

```typescript
import { useEffect, useState } from 'react';

/** Retorna o valor após `delay` ms sem mudanças. Evita recomputar agregados a cada tecla. */
export function useDebouncedValue<T>(value: T, delay = 450): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
```

- [ ] **Step 2: Adicionar filtro `comTelefone` em `useRadarLista.ts`**

Em `src/queries/useRadarLista.ts`, adicione `comTelefone: boolean;` na interface `RadarFiltros` (após `incluirJaClientes`) e o predicado na query (após o bloco `incluirJaClientes`):

```typescript
// na interface RadarFiltros:
  incluirJaClientes: boolean;
  comTelefone: boolean;     // só empresas com telefone1 OU telefone2
  preset: PresetRadar;
```

```typescript
// na queryFn, após `if (!filtros.incluirJaClientes) q = q.eq('ja_cliente', false);`:
      // "com telefone" = positivo (linha sem telefone não casa o OR; sem footgun NULL-blind)
      if (filtros.comTelefone) q = q.or('telefone1.not.is.null,telefone2.not.is.null');
```

- [ ] **Step 3: Criar `useRadarContagemMunicipios.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { presetParaParams, digitosCnae } from '@/lib/radar/ui-helpers';
import type { RadarFiltros } from '@/queries/useRadarLista';

export interface RadarMunicipioContagem {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

// Agrega por município respeitando os filtros ESTRUTURAIS (não a busca textual livre).
export function useRadarContagemMunicipios(filtros: RadarFiltros, hojeISO: string, enabled: boolean) {
  const p = presetParaParams(filtros.preset, hojeISO);
  const cnae = digitosCnae(filtros.cnae);
  const params = {
    p_uf: filtros.uf || null,
    p_cnae_exato: cnae.length === 7 ? cnae : null,
    p_cnae_prefix: cnae.length > 0 && cnae.length < 7 ? cnae : null,
    p_status: filtros.status || null,
    p_incluir_ja_clientes: filtros.incluirJaClientes,
    p_data_abertura_min: p.dataAberturaMin,
    p_data_abertura_max: p.dataAberturaMax,
    p_limit: 500,
  };
  return useQuery({
    queryKey: ['radar', 'contagem-municipios', params],
    enabled,
    queryFn: async (): Promise<RadarMunicipioContagem[]> => {
      // TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10)
      const { data, error } = await (
        supabase.rpc as (fn: string, args: unknown) => ReturnType<typeof supabase.rpc>
      )('radar_contagem_por_municipio', params);
      if (error) throw error;
      return (data ?? []) as unknown as RadarMunicipioContagem[];
    },
    staleTime: 60_000,
  });
}
```

- [ ] **Step 4: Criar `useRadarAcoesLead.ts`** (cadastrar Omie via edge existente + persistir; atribuir tarefa)

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { RadarEmpresa } from '@/queries/useRadarLista';

type RpcFn = typeof supabase.rpc;

interface CadastroOmieResult {
  codigo_cliente: string | number | null;
  ja_existia: boolean;
}

// Cadastra o lead no Omie (conta Oben) reusando a action existente do omie-vendas-sync
// (idempotente: ListarClientes-first reconcilia), depois persiste o resultado via RPC.
export function useRadarCadastrarOmie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (e: RadarEmpresa): Promise<CadastroOmieResult> => {
      const endereco = [e.logradouro].filter(Boolean).join(', ');
      const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_cliente',
          account: 'oben',
          document: e.cnpj,
          razao_social: e.razao_social || e.nome_fantasia || e.cnpj,
          nome_fantasia: e.nome_fantasia || undefined,
          endereco: e.logradouro || undefined,
          endereco_numero: e.numero || undefined,
          bairro: e.bairro || undefined,
          cidade: e.municipio_nome || undefined,
          estado: e.uf || undefined,
          cep: e.cep || undefined,
          telefone: e.telefone1 || undefined,
        },
      });
      if (error) throw new Error(error.message);
      if (data && data.success === false) throw new Error(data.error || 'Falha no cadastro Omie');
      const codigo = (data?.codigo_cliente ?? null) as string | number | null;
      const jaExistia = data?.created === false;
      // persiste no radar (idempotente) — marca virou_cliente + grava o código + loga.
      const { error: rpcErr } = await (supabase.rpc as RpcFn)(
        'radar_registrar_cadastro_omie' as never,
        { p_cnpj: e.cnpj, p_codigo_cliente: codigo != null ? String(codigo) : null, p_ja_existia: jaExistia } as never,
      );
      if (rpcErr) throw rpcErr;
      return { codigo_cliente: codigo, ja_existia: jaExistia };
    },
    onSuccess: (r) => {
      track('radar.lead_cadastrado_omie', { ja_existia: r.ja_existia });
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

// Atribui uma tarefa de prospecção (sempre pro caller).
export function useRadarAtribuirTarefa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; diasRetomada?: number }) => {
      const { data, error } = await (supabase.rpc as RpcFn)(
        'radar_atribuir_tarefa' as never,
        { p_cnpj: v.cnpj, p_dias_retomada: v.diasRetomada ?? 7 } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string; deduped: boolean };
    },
    onSuccess: () => {
      track('radar.tarefa_criada', {});
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}
```

- [ ] **Step 5: Typecheck**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; tail -20 /tmp/tc.log`
Expected: `exit=0`. (Se `RadarEmpresa` não tiver `numero`/`cep`/`logradouro`, confirme os nomes reais no `Database` types — a Fatia 1 criou essas colunas; ajuste os campos do payload ao que existir.)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useDebouncedValue.ts src/queries/useRadarContagemMunicipios.ts src/queries/useRadarAcoesLead.ts src/queries/useRadarLista.ts
git commit -m "feat(radar): hooks Fatia 3 (contagem municipios, cadastrar Omie via omie-vendas-sync, atribuir tarefa) + filtro com-telefone"
```

---

## Task 4: Ranking de cidades + totalizador/selo-lote na página

**Files:**
- Create: `src/components/radar/RadarRankingCidades.tsx`
- Modify: `src/components/radar/RadarFiltros.tsx` (toggle "com telefone")
- Modify: `src/pages/RadarClientes.tsx` (DEFAULTS + ranking + selo-lote + `comTelefone`)

- [ ] **Step 1: `RadarRankingCidades.tsx`** — painel "onde caçar"

```typescript
import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRadarContagemMunicipios, type RadarMunicipioContagem } from '@/queries/useRadarContagemMunicipios';
import type { RadarFiltros } from '@/queries/useRadarLista';

export function RadarRankingCidades({
  filtros,
  hojeISO,
  onPick,
}: {
  filtros: RadarFiltros;
  hojeISO: string;
  onPick: (municipioNome: string) => void;
}) {
  const q = useRadarContagemMunicipios(filtros, hojeISO, true);
  const top = (q.data ?? []).slice(0, 8);
  const totalGeral = (q.data ?? []).reduce((s, m) => s + m.total, 0);
  const comTelGeral = (q.data ?? []).reduce((s, m) => s + m.com_telefone, 0);

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium flex items-center gap-1">
          <MapPin className="w-4 h-4" /> Onde caçar
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {q.isLoading ? '…' : `${totalGeral.toLocaleString('pt-BR')} empresas · ${comTelGeral.toLocaleString('pt-BR')} c/ telefone`}
        </span>
      </div>
      {q.isLoading ? (
        <div className="space-y-1">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : top.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma cidade nestes filtros.</p>
      ) : (
        <ul className="space-y-0.5">
          {top.map((m: RadarMunicipioContagem) => (
            <li key={m.municipio_codigo}>
              <button
                onClick={() => onPick(m.municipio_nome)}
                className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
              >
                <span className="truncate">{m.municipio_nome} <span className="text-muted-foreground">/{m.uf}</span></span>
                <span className="tabular-nums text-xs text-muted-foreground shrink-0 ml-2">
                  {m.total.toLocaleString('pt-BR')} · {m.com_telefone} 📞 · {m.a_contatar} a contatar
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Toggle "com telefone" em `RadarFiltros.tsx`**

No `src/components/radar/RadarFiltros.tsx`, replique o bloco do Switch `incluirJaClientes` para `comTelefone`:

```typescript
        {/* Toggle só com telefone */}
        <div className="flex items-center gap-2">
          <Switch
            id="radar-com-telefone"
            checked={filtros.comTelefone}
            onCheckedChange={(checked) => set({ comTelefone: checked })}
          />
          <Label htmlFor="radar-com-telefone" className="text-sm cursor-pointer">
            Só com telefone
          </Label>
        </div>
```

- [ ] **Step 3: Integrar na página `RadarClientes.tsx`**

No `src/pages/RadarClientes.tsx`:
1. Adicione `comTelefone: false` ao `DEFAULTS` e `comTelefone: boolean` ao tipo `RadarUrlState`.
2. Importe `useRadarKpis` (se ainda não) e mostre o selo do lote no header.
3. Renderize `<RadarRankingCidades filtros={filtros} hojeISO={hojeISO} onPick={(nome) => set({ municipio: nome })} />` acima da lista.

```typescript
import { RadarRankingCidades } from '@/components/radar/RadarRankingCidades';
import { useRadarKpis } from '@/queries/useRadarKpis';

// dentro do componente:
const kpis = useRadarKpis();

// no header, ao lado do título:
{kpis.data?.lote && (
  <span className="ml-2 text-xs text-muted-foreground border rounded px-2 py-0.5">
    lote {kpis.data.lote}
  </span>
)}

// entre <Filtros .../> e a lista (<div className="rounded-md border">):
<RadarRankingCidades filtros={filtros} hojeISO={hojeISO} onPick={(nome) => set({ municipio: nome })} />
```

- [ ] **Step 4: Typecheck + lint**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; tail -10 /tmp/tc.log` → `exit=0`
Run: `bun lint 2>&1 | tail -5` (0 errors)

- [ ] **Step 5: Commit**

```bash
git add src/components/radar/RadarRankingCidades.tsx src/components/radar/RadarFiltros.tsx src/pages/RadarClientes.tsx
git commit -m "feat(radar): ranking de cidades (onde cacar) + totalizador + selo-lote + filtro com-telefone na UI"
```

---

## Task 5: Mapa Leaflet (lazy) + toggle Lista|Mapa

**Files:**
- Create: `src/components/radar/RadarMapa.tsx`
- Modify: `src/pages/RadarClientes.tsx`

- [ ] **Step 1: `RadarMapa.tsx`** — espelha o padrão do `AdminRoutePlanner`

```typescript
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRadarContagemMunicipios } from '@/queries/useRadarContagemMunicipios';
import type { RadarFiltros } from '@/queries/useRadarLista';

// Fix dos ícones padrão do Leaflet com bundler (mesmo do AdminRoutePlanner).
delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

export default function RadarMapa({
  filtros,
  hojeISO,
  onPick,
}: {
  filtros: RadarFiltros;
  hojeISO: string;
  onPick: (municipioNome: string) => void;
}) {
  const q = useRadarContagemMunicipios(filtros, hojeISO, true);
  const mapRef = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!mapRef.current || map.current) return;
    map.current = L.map(mapRef.current).setView([-15.78, -47.93], 4); // Brasil
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    const pts = (q.data ?? []).filter((m) => m.lat != null && m.lng != null);
    if (pts.length === 0) return;
    const max = Math.max(...pts.map((m) => m.total));
    pts.forEach((m) => {
      const r = 10 + Math.round(18 * Math.sqrt(m.total / Math.max(max, 1))); // área ~ total
      const icon = L.divIcon({
        className: 'radar-pin',
        html: `<div style="background:hsl(var(--primary));color:hsl(var(--primary-foreground));
          width:${r}px;height:${r}px;border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:10px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.3)">${m.total}</div>`,
        iconSize: [r, r], iconAnchor: [r / 2, r / 2],
      });
      L.marker([m.lat as number, m.lng as number], { icon })
        .bindPopup(`<strong>${m.municipio_nome}/${m.uf}</strong><br/>${m.total} empresas · ${m.com_telefone} c/ telefone<br/>${m.a_contatar} a contatar`)
        .on('click', () => onPick(m.municipio_nome))
        .addTo(layer.current!);
    });
    const bounds = L.latLngBounds(pts.map((m) => [m.lat as number, m.lng as number] as L.LatLngExpression));
    map.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
  }, [q.data, onPick]);

  return (
    <Card className="overflow-hidden">
      <div ref={mapRef} className="w-full h-[420px]" style={{ zIndex: 1 }} />
      {q.isLoading && (
        <div className="p-2"><Skeleton className="h-4 w-40" /></div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Toggle Lista|Mapa em `RadarClientes.tsx`**

1. Adicione `vista: 'lista'` ao `DEFAULTS` e `vista: string` ao `RadarUrlState`.
2. `const RadarMapa = lazy(() => import('@/components/radar/RadarMapa'));` (no topo; importe `lazy, Suspense` de `react`).
3. Botões de toggle e render condicional:

```typescript
import { lazy, Suspense } from 'react';
const RadarMapa = lazy(() => import('@/components/radar/RadarMapa'));

// toggle (acima do bloco lista/mapa):
<div className="flex gap-1">
  <Button variant={raw.vista !== 'mapa' ? 'default' : 'outline'} size="sm" onClick={() => set({ vista: 'lista' })}>Lista</Button>
  <Button variant={raw.vista === 'mapa' ? 'default' : 'outline'} size="sm" onClick={() => set({ vista: 'mapa' })}>Mapa</Button>
</div>

// no corpo: se raw.vista === 'mapa', renderiza o mapa em vez da lista:
{raw.vista === 'mapa' ? (
  <Suspense fallback={<Skeleton className="h-[420px]" />}>
    <RadarMapa filtros={filtros} hojeISO={hojeISO} onPick={(nome) => set({ municipio: nome, vista: 'lista' })} />
  </Suspense>
) : (
  /* ...o bloco <div className="rounded-md border"> da lista existente... */
)}
```

- [ ] **Step 3: Typecheck + build (o build pega problema de import lazy/leaflet)**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; tail -10 /tmp/tc.log` → `exit=0`
Run: `heavy bun run build > /tmp/build.log 2>&1; echo "exit=$?"; tail -15 /tmp/build.log` → `exit=0`

- [ ] **Step 4: Commit**

```bash
git add src/components/radar/RadarMapa.tsx src/pages/RadarClientes.tsx
git commit -m "feat(radar): mapa Leaflet (lazy) com bolhas por cidade + toggle Lista|Mapa"
```

---

## Task 6: Ações no Sheet (Cadastrar Omie + Criar tarefa + WhatsApp)

**Files:**
- Create: `src/components/radar/RadarAcoesLead.tsx`
- Modify: `src/components/radar/RadarDetailSheet.tsx`

- [ ] **Step 1: `RadarAcoesLead.tsx`** — os 2 botões de ação + estados

```typescript
import { useState } from 'react';
import { toast } from 'sonner';
import { Building2, ClipboardPlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useRadarCadastrarOmie, useRadarAtribuirTarefa } from '@/queries/useRadarAcoesLead';
import type { RadarEmpresa } from '@/queries/useRadarLista';

export function RadarAcoesLead({ empresa }: { empresa: RadarEmpresa }) {
  const { isImpersonating } = useImpersonation();
  const cadastrar = useRadarCadastrarOmie();
  const tarefa = useRadarAtribuirTarefa();
  const [confirmOmie, setConfirmOmie] = useState(false);
  const [dias, setDias] = useState('7');

  const doCadastrar = async () => {
    setConfirmOmie(false);
    try {
      const r = await cadastrar.mutateAsync(empresa);
      toast.success(r.ja_existia ? 'Já era cliente no Omie (Oben) — reconciliado' : `Cadastrado no Omie (Oben)${r.codigo_cliente ? ` · cód. ${r.codigo_cliente}` : ''}`);
    } catch (e) {
      toast.error('Não foi possível cadastrar', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const doTarefa = async () => {
    try {
      const n = Math.max(1, Math.min(Number(dias) || 7, 90));
      const r = await tarefa.mutateAsync({ cnpj: empresa.cnpj, diasRetomada: n });
      if (!r.deduped) toast.success('Tarefa criada pra você', { description: `Retomar em ${n} dia(s)` });
      else toast.info('Tarefa já existia (criada agora há pouco)');
    } catch (e) {
      toast.error('Não foi possível criar a tarefa', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const disabled = isImpersonating;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={disabled || cadastrar.isPending} onClick={() => setConfirmOmie(true)}
        title={disabled ? 'Indisponível em modo Ver como' : undefined}>
        {cadastrar.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Building2 className="w-4 h-4 mr-1" />}
        Cadastrar no Omie (Oben)
      </Button>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" disabled={disabled || tarefa.isPending} onClick={doTarefa}
          title={disabled ? 'Indisponível em modo Ver como' : undefined}>
          {tarefa.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ClipboardPlus className="w-4 h-4 mr-1" />}
          Criar tarefa pra mim
        </Button>
        <Label htmlFor="radar-dias" className="text-xs text-muted-foreground">retomar em</Label>
        <Input id="radar-dias" value={dias} onChange={(e) => setDias(e.target.value)} className="w-14 h-8" inputMode="numeric" />
        <span className="text-xs text-muted-foreground">dias</span>
      </div>

      <AlertDialog open={confirmOmie} onOpenChange={setConfirmOmie}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar no Omie (Oben)?</AlertDialogTitle>
            <AlertDialogDescription>
              {empresa.razao_social || empresa.cnpj} será cadastrada como cliente na conta <strong>Oben</strong>.
              Se o CNPJ já existir lá, apenas reconcilia (marca como já-cliente). Não cadastra nas outras empresas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doCadastrar}>Cadastrar na Oben</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 2: Montar no `RadarDetailSheet.tsx` + botão WhatsApp**

Em `src/components/radar/RadarDetailSheet.tsx`:
1. Imports: `import { RadarAcoesLead } from './RadarAcoesLead';` + `import { isCellphone, whatsappLink } from '@/lib/phone';` + `import { MessageSquare } from 'lucide-react';`
2. Após o `<div className="mt-4 flex justify-end"><RadarOutcomeMenu cnpj={empresa.cnpj} /></div>`, adicione um bloco de ações:

```typescript
        <div className="mt-3">
          <RadarAcoesLead empresa={empresa} />
        </div>
```

3. Na `<Linha label="Telefone">`, após o link `tel:`, adicione o WhatsApp quando for celular:

```typescript
            {isCellphone(empresa.telefone1) && whatsappLink(empresa.telefone1) && (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs text-status-success-bold"
                href={whatsappLink(empresa.telefone1) as string}
                target="_blank"
                rel="noreferrer"
              >
                <MessageSquare className="w-3 h-3" /> WhatsApp
              </a>
            )}
```

- [ ] **Step 3: Typecheck + build**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; tail -10 /tmp/tc.log` → `exit=0`
Run: `heavy bun run build > /tmp/build.log 2>&1; echo "exit=$?"; tail -10 /tmp/build.log` → `exit=0`

- [ ] **Step 4: Commit**

```bash
git add src/components/radar/RadarAcoesLead.tsx src/components/radar/RadarDetailSheet.tsx
git commit -m "feat(radar): acoes do lead no Sheet (cadastrar Omie/Oben + criar tarefa + WhatsApp p/ celular)"
```

---

## Task 7: CI verde + PR

**Files:** nenhum novo (gate final).

- [ ] **Step 1: Suite completa (typecheck + test + lint + build)**

Run cada um, capturando exit code (nunca `| tail` num gate):
```bash
heavy bun run typecheck > /tmp/g-tc.log 2>&1; echo "tc=$?"
heavy bun run test      > /tmp/g-test.log 2>&1; echo "test=$?"
bun lint                > /tmp/g-lint.log 2>&1; echo "lint=$?"
heavy bun run build     > /tmp/g-build.log 2>&1; echo "build=$?"
```
Expected: `tc=0 test=0 lint=0 build=0`. Se algum ≠0, abra o log e corrija antes de seguir.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin claude/radar-fatia3-acoes
```
Abra o PR (se `gh`/`api.github.com` falhar por timeout do ISP, use o workaround `curl --resolve api.github.com:443:140.82.112.6` — lição §10). Corpo do PR: lista as 3 RPCs + a melhoria (reuso do `omie-vendas-sync`, sem edge nova), **destaca que precisa de migration manual** (cole o SQL inline) + **Publish manual** no Lovable.

- [ ] **Step 3: Rollout (founder)**

Entregar ao founder:
1. **🟣 SQL Editor →** colar `supabase/migrations/20260613190000_radar_fatia3.sql` → Run → confirmar `colunas_2=2, funcoes_3=3`.
2. **Publish** do frontend no Lovable.
3. Smoke no device: abrir `/radar` → ver o ranking "Onde caçar" + selo do lote; toggle Mapa (bolhas por cidade, clicar filtra); filtro "só com telefone"; abrir um lead → WhatsApp (se celular) + "Criar tarefa pra mim" (conferir em `/tarefas`) + "Cadastrar no Omie (Oben)" (conferir no Omie da Oben + o lead vira "virou cliente").

---

## Self-Review (preenchido)

**Spec coverage:**
- Totalizador/ranking por cidade → Task 1 (RPC) + Task 4 (UI). ✅
- Contatabilidade (filtro com-telefone + WhatsApp) → Task 3 (filtro) + Task 2/6 (isCellphone + botão). ✅
- Cadastrar no Omie (Oben) → Task 1 (RPC persiste) + Task 3 (hook reusa edge) + Task 6 (botão). ✅
- Atribuir Tarefa + próxima ação/data → Task 1 (RPC) + Task 6 (botão com campo de dias). ✅
- Mapa Leaflet → Task 5. ✅
- Selo "lote YYYY-MM" → Task 4. ✅
- Cortes (preset rota, edge nova) → respeitados (edge reusada; preset fora). ✅

**Placeholder scan:** sem TBD/TODO de implementação; o único `TODO:` é o comentário de cast `as never` (padrão real do projeto até regenerar types). ✅

**Type consistency:** `RadarMunicipioContagem` (campos `municipio_codigo/municipio_nome/uf/lat/lng/total/com_telefone/a_contatar`) é o mesmo no hook (Task 3) e nos componentes (Task 4/5). `RadarFiltros` ganha `comTelefone` (Task 3) e é consumido por `useRadarContagemMunicipios`/ranking/mapa coerentemente. A RPC `radar_contagem_por_municipio` tem a assinatura de 8 params idêntica no SQL (Task 1), no REVOKE/GRANT (Task 1) e no hook (Task 3). ✅

**Risco aberto que o PG17 resolve:** performance do agregado sem-filtro — o A9 só prova que não dá erro; em prod o front **debounça** (Task 3) e o caso comum tem UF/CNAE. Se em prod o sem-filtro doer (>~1s), follow-up = materializar `radar_municipio_resumo` (registrado na spec §8).
