#!/usr/bin/env bash
# Benchmark PG17: mede LISTA e RANKING do /radar com 500k empresas sintéticas,
# com e sem índices candidatos. Diagnóstico da lentidão reportada na Fatia 3.
set -euo pipefail
export LC_ALL=C LANG=C

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55471
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

echo "=== setup (tabelas + RPC + gate stub) ==="
"${P[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL, cnae_descricao text, data_abertura date,
  porte text, capital_social numeric, municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text, email text, socios_nomes text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', prospeccao_atualizado_em timestamptz,
  ja_cliente boolean NOT NULL DEFAULT false, ultimo_lote text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
-- índices ATUAIS de prod
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX idx_radar_empresas_local ON public.radar_empresas (uf, municipio_nome);
CREATE INDEX idx_radar_empresas_cnae ON public.radar_empresas (cnae_principal);

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(
  p_uf text DEFAULT NULL, p_cnae_prefix text DEFAULT NULL, p_cnae_exato text DEFAULT NULL,
  p_status text DEFAULT NULL, p_incluir_ja_clientes boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL, p_data_abertura_max date DEFAULT NULL, p_limit integer DEFAULT 500
) RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision,
  total bigint, com_telefone bigint, a_contatar bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  SELECT re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng,
    count(*)::bigint, count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint,
    count(*) FILTER (WHERE re.prospeccao_status='a_contatar')::bigint
  FROM public.radar_empresas re LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
  WHERE (p_uf IS NULL OR re.uf=p_uf)
    AND (p_cnae_exato IS NULL OR re.cnae_principal=p_cnae_exato)
    AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix||'%')
    AND ((p_status IS NOT NULL AND re.prospeccao_status=p_status) OR (p_status IS NULL AND re.prospeccao_status<>'descartado'))
    AND (p_incluir_ja_clientes OR re.ja_cliente=false)
    AND (p_data_abertura_min IS NULL OR re.data_abertura>=p_data_abertura_min)
    AND (p_data_abertura_max IS NULL OR re.data_abertura<=p_data_abertura_max)
  GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
  ORDER BY total DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit,500), 2000));
END $$;
SQL

echo "=== seed: 5000 municípios + 500k empresas ==="
"${P[@]}" <<'SQL'
INSERT INTO public.radar_municipios
  SELECT 'm'||g, 'CIDADE '||g, (ARRAY['MG','SP','RJ','PR','SC'])[1+g%5], -20+(g%100)*0.1, -45+(g%100)*0.1
  FROM generate_series(1,5000) g;
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, data_abertura, municipio_codigo, municipio_nome, uf, telefone1, prospeccao_status, ja_cliente, ultimo_lote, capital_social)
  SELECT lpad(g::text,14,'0'), 'EMPRESA '||g,
    lpad((3101200 + g%80)::text,7,'0'),
    date '2008-01-01' + ((g*7)%6500),
    'm'||(1+g%5000), 'CIDADE '||(1+g%5000), (ARRAY['MG','SP','RJ','PR','SC'])[1+(1+g%5000)%5],
    CASE WHEN g%3<>0 THEN '319'||lpad((g%100000)::text,8,'0') ELSE NULL END,
    (ARRAY['a_contatar','a_contatar','a_contatar','em_conversa','contatado_sem_resposta','descartado'])[1+g%6],
    (g%40=0), '2026-05', (g%200000)::numeric
  FROM generate_series(1,500000) g;
ANALYZE public.radar_empresas; ANALYZE public.radar_municipios;
SQL

run() { echo ""; echo ">>> $1"; "${P[@]}" -c "$2" | grep -E "Execution Time|Planning Time" || true; }

echo ""; echo "############ ANTES (índices de prod apenas) ############"
run "LISTA default (preset novas: order data_abertura desc, filtro ja_cliente=false + status<>descartado, LIMIT 50)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_empresas WHERE ja_cliente=false AND prospeccao_status<>'descartado' ORDER BY data_abertura DESC, cnpj LIMIT 50;"
run "LISTA estabelecidas (order capital_social desc, data_abertura<=2021, LIMIT 50)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_empresas WHERE ja_cliente=false AND prospeccao_status<>'descartado' AND data_abertura<='2021-06-13' ORDER BY capital_social DESC, cnpj LIMIT 50;"
run "RANKING sem filtro (Brasil inteiro — o suspeito)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_contagem_por_municipio();"
run "RANKING filtrado por UF=MG" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_contagem_por_municipio('MG');"

echo ""; echo "############ índices candidatos ############"
"${P[@]}" -c "CREATE INDEX idx_radar_lista_novas ON public.radar_empresas (data_abertura DESC, cnpj) WHERE ja_cliente=false AND prospeccao_status<>'descartado';" >/dev/null
"${P[@]}" -c "CREATE INDEX idx_radar_lista_estab ON public.radar_empresas (capital_social DESC, cnpj) WHERE ja_cliente=false AND prospeccao_status<>'descartado';" >/dev/null
"${P[@]}" -c "CREATE INDEX idx_radar_muni ON public.radar_empresas (municipio_codigo) WHERE ja_cliente=false AND prospeccao_status<>'descartado';" >/dev/null
"${P[@]}" -c "ANALYZE public.radar_empresas;" >/dev/null

echo ""; echo "############ DEPOIS (com índices candidatos) ############"
run "LISTA default (com idx_radar_lista_novas)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_empresas WHERE ja_cliente=false AND prospeccao_status<>'descartado' ORDER BY data_abertura DESC, cnpj LIMIT 50;"
run "LISTA estabelecidas (com idx_radar_lista_estab)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_empresas WHERE ja_cliente=false AND prospeccao_status<>'descartado' AND data_abertura<='2021-06-13' ORDER BY capital_social DESC, cnpj LIMIT 50;"
run "RANKING sem filtro (com idx_radar_muni — índice ajuda o GROUP BY full?)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_contagem_por_municipio();"
run "RANKING filtrado UF=MG (com idx_radar_muni)" \
  "EXPLAIN (ANALYZE, TIMING ON) SELECT * FROM public.radar_contagem_por_municipio('MG');"
echo ""; echo "✅ bench done"
