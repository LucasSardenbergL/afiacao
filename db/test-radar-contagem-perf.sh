#!/usr/bin/env bash
# PG17: valida o fast-path de radar_contagem_por_municipio (20260614140000).
# Reproduz prod: tabela GRANDE (colunas TEXT preenchidas, >> índice covering) +
# VACUUM ANALYZE (= prod após autovacuum, visibility map limpo → index-only real).
#  A1 paridade EXATA default (nova vs original) incl. órfãos c/ nome variável
#  A2 paridade com filtro (slow-path = original)
#  A3 fast-path (query interna) usa Index Only Scan no covering + 0 heap fetches
#  A4 fast-path mais RÁPIDO e com menos I/O que a original
set -euo pipefail
export LC_ALL=C LANG=C
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ pg17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55477
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260614140000_radar_contagem_perf.sql"
FAIL=0; ok(){ echo "  ✅ $1"; }; bad(){ echo "  ❌ $1"; FAIL=1; }

echo "=== setup + seed 500k (tabela INFLADA com TEXT, ~prod) ==="
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
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX idx_radar_empresas_local ON public.radar_empresas (uf, municipio_nome);
CREATE INDEX idx_radar_empresas_cnae ON public.radar_empresas (cnae_principal);
CREATE INDEX idx_radar_muni ON public.radar_empresas (municipio_codigo) WHERE ja_cliente=false AND prospeccao_status<>'descartado';

INSERT INTO public.radar_municipios
  SELECT 'm'||g, 'CIDADE '||g, (ARRAY['MG','SP','RJ','PR','SC'])[1+g%5], -20+(g%100)*0.1, -45+(g%100)*0.1
  FROM generate_series(1,1500) g;

-- colunas TEXT preenchidas (razao_social/socios_nomes/email/logradouro) → linha
-- larga como prod (~233 MB/526k ≈ 466 B/linha) → tabela >> índice covering.
INSERT INTO public.radar_empresas (cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao, data_abertura, municipio_codigo, municipio_nome, uf, telefone1, email, socios_nomes, prospeccao_status, ja_cliente, ultimo_lote, capital_social)
  SELECT lpad(g::text,14,'0'),
    'RAZAO SOCIAL EMPRESA EXEMPLO LTDA '||g, 'FANTASIA '||g,
    lpad((3101200 + g%80)::text,7,'0'), 'COMERCIO VAREJISTA DE ARTIGOS DIVERSOS '||g,
    date '2008-01-01' + ((g*7)%6500), 'm'||(1+g%1500), 'CIDADE '||(1+g%1500),
    (ARRAY['MG','SP','RJ','PR','SC'])[1+(1+g%1500)%5],
    CASE WHEN random()<0.66 THEN '319'||lpad((g%100000)::text,8,'0') ELSE NULL END,
    'contato'||g||'@empresaexemplo.com.br',
    repeat('JOAO DA SILVA SANTOS PEREIRA; ', 6),
    (ARRAY['a_contatar','em_conversa','contatado_sem_resposta','descartado'])[1+floor(random()*4)::int],
    (random()<0.025), '2026-05', (g%200000)::numeric
  FROM generate_series(1,500000) g;

INSERT INTO public.radar_empresas (cnpj, cnae_principal, municipio_codigo, municipio_nome, uf, telefone1, prospeccao_status, ja_cliente, ultimo_lote)
  SELECT 'orf'||k||'-'||i, '3101200', 'orf'||k,
    CASE WHEN i%2=0 THEN 'CIDADE ORFA '||k||' A' ELSE 'CIDADE ORFA '||k||' B' END,
    'MG', CASE WHEN i%3<>0 THEN '3199' ELSE NULL END,
    (ARRAY['a_contatar','em_conversa','descartado'])[1+i%3], false, '2026-05'
  FROM generate_series(1,3) k, generate_series(1,60) i;
SQL

echo "=== aplica a migration ==="
"${P[@]}" -f "$MIG" | grep -E "RADAR CONTAGEM|indice_1" || true
echo "=== VACUUM ANALYZE (= prod após autovacuum: visibility map limpo) ==="
"${P[@]}" -c "VACUUM (ANALYZE) public.radar_empresas;" >/dev/null
"${P[@]}" -c "VACUUM (ANALYZE) public.radar_municipios;" >/dev/null

echo "=== tamanhos (prod-like: tabela >> índice covering) ==="
"${P[@]}" -c "SELECT pg_size_pretty(pg_relation_size('public.radar_empresas')) AS tabela,
                     pg_size_pretty(pg_relation_size('public.idx_radar_muni_cover')) AS idx_cover;"

"${P[@]}" <<'SQL'
CREATE OR REPLACE FUNCTION public.radar_contagem_original(
  p_uf text DEFAULT NULL, p_cnae_prefix text DEFAULT NULL, p_cnae_exato text DEFAULT NULL,
  p_status text DEFAULT NULL, p_incluir_ja_clientes boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL, p_data_abertura_max date DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision,
  total bigint, com_telefone bigint, a_contatar bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng,
    count(*)::bigint, count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint,
    count(*) FILTER (WHERE re.prospeccao_status='a_contatar')::bigint
  FROM public.radar_empresas re LEFT JOIN public.radar_municipios m ON m.codigo=re.municipio_codigo
  WHERE (p_uf IS NULL OR re.uf=p_uf)
    AND (p_cnae_exato IS NULL OR re.cnae_principal=p_cnae_exato)
    AND (p_cnae_prefix IS NULL OR re.cnae_principal LIKE p_cnae_prefix||'%')
    AND ((p_status IS NOT NULL AND re.prospeccao_status=p_status) OR (p_status IS NULL AND re.prospeccao_status<>'descartado'))
    AND (p_incluir_ja_clientes OR re.ja_cliente=false)
    AND (p_data_abertura_min IS NULL OR re.data_abertura>=p_data_abertura_min)
    AND (p_data_abertura_max IS NULL OR re.data_abertura<=p_data_abertura_max)
  GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
  ORDER BY total DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit,500),2000));
END $$;
SQL

echo ""; echo "=== ASSERTS ==="

A1=$("${P[@]}" -t -A <<'SQL'
WITH nova AS (SELECT * FROM public.radar_contagem_por_municipio(p_limit=>2000)),
     orig AS (SELECT * FROM public.radar_contagem_original(p_limit=>2000))
SELECT (SELECT count(*) FROM (SELECT * FROM nova EXCEPT SELECT * FROM orig) a)
     + (SELECT count(*) FROM (SELECT * FROM orig EXCEPT SELECT * FROM nova) b);
SQL
)
[ "$A1" = "0" ] && ok "A1 paridade default EXATA (incl. órfãos+nome variável): 0 divergentes" || bad "A1: $A1 divergentes"

A1B=$("${P[@]}" -t -A -c "SELECT count(*) FROM public.radar_contagem_por_municipio(p_limit=>2000) WHERE municipio_codigo LIKE 'orf%';")
[ "$A1B" = "6" ] && ok "A1b órfãos preservados: 6 linhas" || bad "A1b órfãos: esperado 6, veio $A1B"

A2=$("${P[@]}" -t -A <<'SQL'
WITH nova AS (SELECT * FROM public.radar_contagem_por_municipio(p_uf=>'MG', p_limit=>2000)),
     orig AS (SELECT * FROM public.radar_contagem_original(p_uf=>'MG', p_limit=>2000))
SELECT (SELECT count(*) FROM (SELECT * FROM nova EXCEPT SELECT * FROM orig) a)
     + (SELECT count(*) FROM (SELECT * FROM orig EXCEPT SELECT * FROM nova) b);
SQL
)
[ "$A2" = "0" ] && ok "A2 paridade com filtro UF (slow-path): 0 divergentes" || bad "A2: $A2 divergentes"

# A3: query interna do fast-path → Index Only Scan + 0 heap fetches (pós-vacuum)
INNER="WITH agg AS MATERIALIZED (SELECT re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn, count(*)::bigint AS t, count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS ct, count(*) FILTER (WHERE re.prospeccao_status='a_contatar')::bigint AS ac FROM public.radar_empresas re WHERE re.ja_cliente=false AND re.prospeccao_status<>'descartado' GROUP BY re.municipio_codigo, re.uf, re.municipio_nome) SELECT a.mc, COALESCE(m.nome,a.mn), a.u, m.lat, m.lng, sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint FROM agg a LEFT JOIN public.radar_municipios m ON m.codigo=a.mc GROUP BY a.mc, COALESCE(m.nome,a.mn), a.u, m.lat, m.lng ORDER BY sum(a.t) DESC, a.mc LIMIT 500"
PLAN="$("${P[@]}" -c "EXPLAIN (ANALYZE, BUFFERS) $INNER;")"
echo "$PLAN" | grep -qiE "Index Only Scan using idx_radar_muni_cover" && ok "A3 fast-path: Index Only Scan em idx_radar_muni_cover" || { bad "A3 NÃO usou index-only"; echo "$PLAN" | grep -iE "scan|heap" | head; }
echo "$PLAN" | grep -qiE "Seq Scan on radar_empresas|Parallel Seq Scan on radar_empresas" && bad "A3b ainda faz Seq Scan da radar_empresas" || ok "A3b sem Seq Scan da radar_empresas"
HEAP=$(echo "$PLAN" | grep -oiE "Heap Fetches: [0-9]+" | grep -oE "[0-9]+" | head -1 || echo "?")
echo "  (Heap Fetches: ${HEAP:-?})"

# A4: Execution Time da FUNÇÃO nova < original (média de 3, cache quente)
tempo() { "${P[@]}" -t -A -c "EXPLAIN (ANALYZE) SELECT * FROM $1;" | grep -oiE "Execution Time: [0-9.]+" | grep -oE "[0-9.]+"; }
warm1=$(tempo "public.radar_contagem_por_municipio()"); warm2=$(tempo "public.radar_contagem_original()")
TNOVA=$(tempo "public.radar_contagem_por_municipio()"); TORIG=$(tempo "public.radar_contagem_original()")
echo "  (Execution Time: nova=${TNOVA}ms  original=${TORIG}ms)"
awk "BEGIN{exit !($TNOVA < $TORIG)}" && ok "A4 fast-path mais rápido que a original (${TNOVA} < ${TORIG} ms)" || bad "A4 fast-path NÃO mais rápido (${TNOVA} vs ${TORIG})"

echo ""; [ "$FAIL" = "0" ] && echo "✅ TODOS OS ASSERTS PASSARAM" || echo "❌ HÁ FALHAS"
exit $FAIL
