#!/usr/bin/env bash
# Teste PG17 da RPC adicionar_opcao_tool_spec (medida customizada "Outros").
# Auto-contido: stubs auth.uid()/has_role() por GUC, tool_specifications mínima,
# aplica a migration real e assere gate/normalização/dedupe/NULL/guards/limite/grants/concorrência.
# Base: db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5439
DATA="$(mktemp -d /tmp/pgtest-toolspec.XXXXXX)/data"
export LC_ALL=C LANG=C
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-toolspec.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres toolspec_verify
PSQL=("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d toolspec_verify)
P() { "${PSQL[@]}" "$@"; }

echo "→ fundação (stubs auth + enum + has_role + tool_specifications + seeds)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid
$f$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT current_setting('test.role', true) = _role::text
$f$;
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $g$;
CREATE TABLE public.tool_specifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_category_id uuid,
  spec_key text NOT NULL,
  spec_label text NOT NULL,
  spec_type text NOT NULL DEFAULT 'select',
  options jsonb,
  is_required boolean DEFAULT true,
  display_order integer DEFAULT 0
);
ALTER TABLE public.tool_specifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read tool specifications" ON public.tool_specifications FOR SELECT USING (true);
CREATE POLICY "Only admins can manage specifications" ON public.tool_specifications
  FOR ALL USING (public.has_role(auth.uid(),'master'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(),'master'::public.app_role));
INSERT INTO public.tool_specifications (id, spec_key, spec_label, spec_type, options) VALUES
  ('11111111-1111-1111-1111-111111111111','diametro','Diâmetro','select','["300mm","250mm"]'::jsonb),
  ('22222222-2222-2222-2222-222222222222','comprimento','Comprimento','select','["de 120mm a 300mm","até 120mm"]'::jsonb),
  ('33333333-3333-3333-3333-333333333333','espessura','Espessura (mm)','number',NULL),
  ('44444444-4444-4444-4444-444444444444','marca','Marca','select',NULL);
SQL

echo "→ migration real…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260608120000_tool_spec_custom_option.sql" >/dev/null

echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT set_config('test.role','employee',false);
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false);

DO $$
DECLARE r jsonb; opts jsonb;
BEGIN
  -- A) append no fim, valor_canonico
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290mm');
  IF r->>'valor_canonico' <> '290mm' THEN RAISE EXCEPTION 'A FALHOU: canonico=%', r->>'valor_canonico'; END IF;
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts <> '["300mm","250mm","290mm"]'::jsonb THEN RAISE EXCEPTION 'A FALHOU: options=%', opts; END IF;
  RAISE NOTICE 'OK A — append no fim';

  -- B) dedupe exato idempotente
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290mm');
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF jsonb_array_length(opts) <> 3 THEN RAISE EXCEPTION 'B FALHOU: duplicou len=%', jsonb_array_length(opts); END IF;
  RAISE NOTICE 'OK B — dedupe exato idempotente';

  -- C) dedupe case-insensitive → canônico do servidor é o existente
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290MM');
  IF r->>'valor_canonico' <> '290mm' THEN RAISE EXCEPTION 'C FALHOU: canonico=%', r->>'valor_canonico'; END IF;
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF jsonb_array_length(opts) <> 3 THEN RAISE EXCEPTION 'C FALHOU: duplicou case len=%', jsonb_array_length(opts); END IF;
  RAISE NOTICE 'OK C — dedupe case-insensitive';

  -- D) normaliza espaços
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','  301   mm  ');
  IF r->>'valor_canonico' <> '301 mm' THEN RAISE EXCEPTION 'D FALHOU: [%]', r->>'valor_canonico'; END IF;
  RAISE NOTICE 'OK D — normaliza trim/espaços';
END $$;

-- E) NULL → RAISE 22004 + options intacto
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', NULL);
  RAISE EXCEPTION 'E FALHOU: aceitou NULL';
EXCEPTION WHEN sqlstate '22004' THEN RAISE NOTICE 'OK E — NULL rejeitado'; END $$;
DO $$ DECLARE opts jsonb; BEGIN
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts IS NULL THEN RAISE EXCEPTION 'E2 FALHOU: options corrompido p/ NULL'; END IF;
  RAISE NOTICE 'OK E2 — options intacto após NULL';
END $$;

-- F) vazio → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', '   ');
  RAISE EXCEPTION 'F FALHOU: aceitou vazio';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK F — vazio rejeitado'; END $$;

-- G) >60 → RAISE 22001
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', repeat('x',61));
  RAISE EXCEPTION 'G FALHOU: aceitou >60';
EXCEPTION WHEN sqlstate '22001' THEN RAISE NOTICE 'OK G — >60 rejeitado'; END $$;

-- H) reservado → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', '__outros__');
  RAISE EXCEPTION 'H FALHOU: aceitou reservado';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK H — reservado rejeitado'; END $$;

-- I) spec_type number → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('33333333-3333-3333-3333-333333333333', '5mm');
  RAISE EXCEPTION 'I FALHOU: aceitou number';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK I — number rejeitado'; END $$;

-- J) faixa (allow_custom_option=false via UPDATE da migration) → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('22222222-2222-2222-2222-222222222222', '290mm');
  RAISE EXCEPTION 'J FALHOU: aceitou em faixa';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK J — faixa fechada pela migration'; END $$;

-- K) select sem options (marca) → COALESCE, 1ª opção entra
DO $$ DECLARE opts jsonb; BEGIN
  PERFORM public.adicionar_opcao_tool_spec('44444444-4444-4444-4444-444444444444','Freud');
  SELECT options INTO opts FROM public.tool_specifications WHERE id='44444444-4444-4444-4444-444444444444';
  IF opts <> '["Freud"]'::jsonb THEN RAISE EXCEPTION 'K FALHOU: options=%', opts; END IF;
  RAISE NOTICE 'OK K — options NULL → COALESCE';
END $$;

-- L) spec inexistente → RAISE P0002
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('99999999-9999-9999-9999-999999999999','x');
  RAISE EXCEPTION 'L FALHOU: aceitou inexistente';
EXCEPTION WHEN sqlstate 'P0002' THEN RAISE NOTICE 'OK L — inexistente rejeitada'; END $$;

-- M) gate: customer → RAISE 42501 e nada escrito
SELECT set_config('test.role','customer',false);
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','999mm');
  RAISE EXCEPTION 'M FALHOU: customer adicionou';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'OK M — customer bloqueado'; END $$;
SELECT set_config('test.role','employee',false);
DO $$ DECLARE opts jsonb; BEGIN
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts @> '["999mm"]'::jsonb THEN RAISE EXCEPTION 'M2 FALHOU: customer escreveu'; END IF;
  RAISE NOTICE 'OK M2 — nada escrito pelo customer';
END $$;

-- N) master também passa
SELECT set_config('test.role','master',false);
DO $$ DECLARE r jsonb; BEGIN
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','310mm');
  IF r->>'valor_canonico' <> '310mm' THEN RAISE EXCEPTION 'N FALHOU'; END IF;
  RAISE NOTICE 'OK N — master adiciona';
END $$;

-- O) limite 200 → RAISE 54000
SELECT set_config('test.role','employee',false);
DO $$ DECLARE big jsonb; BEGIN
  SELECT jsonb_agg('opt'||g) INTO big FROM generate_series(1,200) g;
  UPDATE public.tool_specifications SET options=big WHERE id='11111111-1111-1111-1111-111111111111';
  BEGIN
    PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','nova');
    RAISE EXCEPTION 'O FALHOU: passou do limite';
  EXCEPTION WHEN sqlstate '54000' THEN RAISE NOTICE 'OK O — limite 200 respeitado'; END;
END $$;

-- P) policy de escrita dropada
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tool_specifications'
            AND policyname='Only admins can manage specifications') THEN
    RAISE EXCEPTION 'P FALHOU: policy de escrita ainda existe';
  END IF;
  RAISE NOTICE 'OK P — policy de escrita dropada';
END $$;

-- Q) grants: authenticated EXECUTE sim, anon não
DO $$ BEGIN
  IF NOT has_function_privilege('authenticated','public.adicionar_opcao_tool_spec(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Q FALHOU: authenticated sem EXECUTE'; END IF;
  IF has_function_privilege('anon','public.adicionar_opcao_tool_spec(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Q2 FALHOU: anon tem EXECUTE'; END IF;
  RAISE NOTICE 'OK Q — grants corretos';
END $$;

SELECT 'ASSERTS SEQUENCIAIS OK ✓' AS resultado;
SQL

echo "→ concorrência: 10 inserts paralelos da MESMA medida → 1 entrada (prova FOR UPDATE)…"
seq 1 10 | xargs -P 10 -I{} "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d toolspec_verify -q -c \
  "SELECT set_config('test.role','employee',false); SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false); SELECT public.adicionar_opcao_tool_spec('44444444-4444-4444-4444-444444444444','PARALELO');" >/dev/null 2>&1
CNT="$(P -tAc "SELECT count(*) FROM jsonb_array_elements_text((SELECT options FROM public.tool_specifications WHERE id='44444444-4444-4444-4444-444444444444')) e WHERE e='PARALELO';")"
[ "$CNT" = "1" ] || { echo "CONC FALHOU: PARALELO apareceu $CNT vezes (esperado 1)"; exit 1; }
echo "OK concorrência — 10 paralelos, 1 entrada"

echo ""
echo "✓ db/test-tool-spec-custom-option.sh — PASSOU"
