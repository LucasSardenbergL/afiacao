#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261020150000_fin_capital_giro_prazos_empresa                      ║
# ║      bash db/test-fin-capital-giro-prazos-empresa.sh > logs/t.log 2>&1; echo "exit=$?"║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-capital-giro-prazos-empresa.sh  (2º ambiente) ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
# A função copia v_titulo_baixas (como CTE `vb`) + v_capital_giro_prazos com o filtro de empresa
# DENTRO do CTE `mov` (as views varrem fin_movimentacoes inteira 2× por chamada do engine). O
# contrato é IGUALDADE com a view; a prova:
#   - as DUAS views são criadas com o texto VERBATIM de pg_get_viewdef da PROD (2026-10-20), então
#     o PRE por md5 da migration é exercitado de verdade;
#   - fixture (Codex challenge): ótica título × conta corrente; mesmo cod/tipo em 2 empresas com
#     ótica título só numa (CR e CP); empate no DISTINCT ON; emissão nula; baixa ANTES da emissão
#     (prazo negativo); empresa só com CR, só com CP, só com título aberto, liquidado sem
#     movimento (cobertura 0, PMR null), só movimentos (existe=false) e inexistente;
#   - igualdade com a view rodada como service_role (o papel do engine);
#   - controle verde na MESMA invocação + 1 sabotagem por camada sobre CÓPIA da migration.
# O filtro de empresa em `mov` é camada de DESEMPENHO, não de resultado (o join por company já
# isola as empresas): tirá-lo deixa a A6 verde — a prova mede isso e o barra por um pin textual
# do corpo instalado; o ganho em si está medido por EXPLAIN em prod (corpo da migration).
# Asserções ASCII, caixa fixa, sem -i.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5492}"
SLUG="fin-capital-giro-prazos-empresa"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261020150000_fin_capital_giro_prazos_empresa.sql"
MD5_TB="57e98392e33a254d924927f8e07dea5f"
MD5_PZ="795031892dfb09f69f166648affec5d7"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

# shellcheck disable=SC2329  # invocada pelo trap EXIT abaixo
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

FALHAS=0
ok()    { echo "OK   $1"; }
falha() { echo "FAIL $1"; FALHAS=$((FALHAS + 1)); }

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
CREATE TABLE public.fin_movimentacoes (
  company text NOT NULL, omie_codigo_lancamento bigint, tipo text, data_movimento date NOT NULL,
  valor numeric(15,2) NOT NULL, categoria_descricao text);
CREATE TABLE public.fin_contas_receber (
  company text, omie_codigo_lancamento bigint, data_emissao date, status_titulo text,
  UNIQUE (company, omie_codigo_lancamento));
CREATE TABLE public.fin_contas_pagar (
  company text, omie_codigo_lancamento bigint, data_emissao date, status_titulo text,
  UNIQUE (company, omie_codigo_lancamento));
-- Como no Supabase: tabelas legíveis pelo service_role, e o default privilege que dá EXECUTE de
-- toda função nova a anon/authenticated/service_role (é ele que torna o REVOKE nomeado necessário).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
  # Views VERBATIM da PROD (pg_get_viewdef, 2026-10-20).
  P <<'SQL'
CREATE VIEW public.v_titulo_baixas WITH (security_invoker = on) AS
 WITH mov AS (
         SELECT fin_movimentacoes.company,
            fin_movimentacoes.omie_codigo_lancamento AS cod,
            fin_movimentacoes.tipo,
            fin_movimentacoes.data_movimento,
            fin_movimentacoes.valor,
            fin_movimentacoes.categoria_descricao AS grupo
           FROM fin_movimentacoes
          WHERE fin_movimentacoes.omie_codigo_lancamento IS NOT NULL AND fin_movimentacoes.data_movimento IS NOT NULL AND (fin_movimentacoes.tipo = ANY (ARRAY['E'::text, 'S'::text])) AND fin_movimentacoes.valor > 0::numeric AND (fin_movimentacoes.categoria_descricao = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text, 'CONTA_CORRENTE_REC'::text, 'CONTA_CORRENTE_PAG'::text]))
        ), canon AS (
         SELECT mov.company,
            mov.cod,
            mov.tipo,
            bool_or(mov.grupo = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text])) AS tem_otica_titulo
           FROM mov
          GROUP BY mov.company, mov.cod, mov.tipo
        ), base AS (
         SELECT m.company,
            m.cod,
            m.tipo,
            m.data_movimento,
            m.valor,
                CASE
                    WHEN c.tem_otica_titulo THEN 'titulo'::text
                    ELSE 'conta_corrente'::text
                END AS origem
           FROM mov m
             JOIN canon c ON c.company = m.company AND c.cod = m.cod AND c.tipo = m.tipo
          WHERE c.tem_otica_titulo AND (m.grupo = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text])) OR NOT c.tem_otica_titulo
        ), mov_canon AS (
        ( SELECT DISTINCT ON (base.company, base.cod, base.tipo) base.company,
            base.cod,
            base.tipo,
            base.data_movimento,
            base.valor,
            base.origem
           FROM base
          WHERE base.origem = 'titulo'::text
          ORDER BY base.company, base.cod, base.tipo, base.valor DESC, base.data_movimento DESC)
        UNION ALL
         SELECT base.company,
            base.cod,
            base.tipo,
            base.data_movimento,
            base.valor,
            base.origem
           FROM base
          WHERE base.origem = 'conta_corrente'::text
        )
 SELECT cr.company,
    cr.omie_codigo_lancamento,
    'CR'::text AS tipo,
    max(m.data_movimento) AS data_baixa_final,
    sum(m.valor) AS valor_baixado,
    count(*)::integer AS n_movimentos,
        CASE
            WHEN cr.data_emissao IS NOT NULL AND sum(m.valor) > 0::numeric THEN round(sum(m.valor * (m.data_movimento - cr.data_emissao)::numeric) / sum(m.valor))
            ELSE NULL::numeric
        END AS prazo_ponderado_dias,
    max(m.origem) AS origem_baixa
   FROM fin_contas_receber cr
     JOIN mov_canon m ON m.company = cr.company AND m.cod = cr.omie_codigo_lancamento AND m.tipo = 'E'::text
  WHERE cr.omie_codigo_lancamento IS NOT NULL AND (cr.status_titulo = ANY (ARRAY['RECEBIDO'::text, 'LIQUIDADO'::text]))
  GROUP BY cr.company, cr.omie_codigo_lancamento, cr.data_emissao
UNION ALL
 SELECT cp.company,
    cp.omie_codigo_lancamento,
    'CP'::text AS tipo,
    max(m.data_movimento) AS data_baixa_final,
    sum(m.valor) AS valor_baixado,
    count(*)::integer AS n_movimentos,
        CASE
            WHEN cp.data_emissao IS NOT NULL AND sum(m.valor) > 0::numeric THEN round(sum(m.valor * (m.data_movimento - cp.data_emissao)::numeric) / sum(m.valor))
            ELSE NULL::numeric
        END AS prazo_ponderado_dias,
    max(m.origem) AS origem_baixa
   FROM fin_contas_pagar cp
     JOIN mov_canon m ON m.company = cp.company AND m.cod = cp.omie_codigo_lancamento AND m.tipo = 'S'::text
  WHERE cp.omie_codigo_lancamento IS NOT NULL AND (cp.status_titulo = ANY (ARRAY['PAGO'::text, 'LIQUIDADO'::text]))
  GROUP BY cp.company, cp.omie_codigo_lancamento, cp.data_emissao;
CREATE VIEW public.v_capital_giro_prazos WITH (security_invoker = on) AS
 WITH companies AS (
         SELECT DISTINCT fin_contas_receber.company
           FROM fin_contas_receber
        UNION
         SELECT DISTINCT fin_contas_pagar.company
           FROM fin_contas_pagar
        ), cr_baixa AS (
         SELECT v_titulo_baixas.company,
            round(sum(v_titulo_baixas.prazo_ponderado_dias * v_titulo_baixas.valor_baixado) / NULLIF(sum(v_titulo_baixas.valor_baixado), 0::numeric)) AS pmr,
            count(*) AS n
           FROM v_titulo_baixas
          WHERE v_titulo_baixas.tipo = 'CR'::text AND v_titulo_baixas.prazo_ponderado_dias IS NOT NULL
          GROUP BY v_titulo_baixas.company
        ), cp_baixa AS (
         SELECT v_titulo_baixas.company,
            round(sum(v_titulo_baixas.prazo_ponderado_dias * v_titulo_baixas.valor_baixado) / NULLIF(sum(v_titulo_baixas.valor_baixado), 0::numeric)) AS pmp,
            count(*) AS n
           FROM v_titulo_baixas
          WHERE v_titulo_baixas.tipo = 'CP'::text AND v_titulo_baixas.prazo_ponderado_dias IS NOT NULL
          GROUP BY v_titulo_baixas.company
        ), cr_set AS (
         SELECT fin_contas_receber.company,
            count(*) AS n
           FROM fin_contas_receber
          WHERE fin_contas_receber.status_titulo = ANY (ARRAY['RECEBIDO'::text, 'LIQUIDADO'::text])
          GROUP BY fin_contas_receber.company
        ), cp_set AS (
         SELECT fin_contas_pagar.company,
            count(*) AS n
           FROM fin_contas_pagar
          WHERE fin_contas_pagar.status_titulo = ANY (ARRAY['PAGO'::text, 'LIQUIDADO'::text])
          GROUP BY fin_contas_pagar.company
        )
 SELECT c.company,
    crb.pmr,
    cpb.pmp,
    round(COALESCE(crb.n, 0::bigint)::numeric / NULLIF(crs.n, 0)::numeric, 3) AS pmr_cobertura,
    round(COALESCE(cpb.n, 0::bigint)::numeric / NULLIF(cps.n, 0)::numeric, 3) AS pmp_cobertura
   FROM companies c
     LEFT JOIN cr_baixa crb ON crb.company = c.company
     LEFT JOIN cp_baixa cpb ON cpb.company = c.company
     LEFT JOIN cr_set crs ON crs.company = c.company
     LEFT JOIN cp_set cps ON cps.company = c.company;
SQL
  P <<'SQL'
INSERT INTO fin_contas_receber VALUES
  ('a', 1, '2026-01-01', 'RECEBIDO'),   -- ótica título, 2 movs + 1 CC ignorado
  ('a', 2, '2026-01-10', 'LIQUIDADO'),  -- só conta corrente (2 movs, ambos contam)
  ('a', 3, '2026-01-10', 'A VENCER'),   -- status fora da lista
  ('a', 4, '2026-02-01', 'RECEBIDO'),   -- sem movimento (entra no denominador da cobertura)
  ('a', 5, '2026-01-01', 'RECEBIDO'),   -- empate no DISTINCT ON (mesmo valor, mesma data)
  ('a', 6, NULL,         'RECEBIDO'),   -- emissão nula: prazo NULL
  ('b', 1, '2026-03-01', 'RECEBIDO'),   -- MESMO cod em outra empresa
  ('b', 2, '2026-01-10', 'RECEBIDO'),   -- MESMO cod 2 da a (só CC), aqui ótica TÍTULO
  ('c', 5, '2026-01-10', 'A VENCER'),   -- empresa só com título aberto (existe, tudo null)
  ('f', 7, '2026-01-10', 'RECEBIDO');   -- liquidado sem movimento: cobertura 0, PMR null
INSERT INTO fin_contas_pagar VALUES
  ('a', 9,  '2026-01-01', 'PAGO'),       -- ótica título
  ('a', 10, '2026-01-01', 'LIQUIDADO'),  -- sem movimento (só denominador)
  ('a', 11, '2026-03-01', 'PAGO'),       -- baixa ANTES da emissão: prazo negativo
  ('b', 9,  '2026-01-01', 'PAGO'),       -- MESMO cod/tipo da a, aqui só conta corrente
  ('e', 1,  '2026-01-01', 'PAGO');       -- empresa só com CP
INSERT INTO fin_movimentacoes VALUES
  ('a', 1, 'E', '2026-02-01', 100, 'CONTA_A_RECEBER'),
  ('a', 1, 'E', '2026-03-01', 300, 'CONTA_A_RECEBER'),
  ('a', 1, 'E', '2026-04-01', 999, 'CONTA_CORRENTE_REC'),
  ('a', 2, 'E', '2026-02-15', 50,  'CONTA_CORRENTE_REC'),
  ('a', 2, 'E', '2026-02-20', 70,  'CONTA_CORRENTE_REC'),
  ('a', 3, 'E', '2026-02-01', 10,  'CONTA_A_RECEBER'),
  ('a', 5, 'E', '2026-02-10', 60,  'CONTA_A_RECEBER'),
  ('a', 5, 'E', '2026-02-10', 60,  'CONTA_A_RECEBER'),
  ('a', 6, 'E', '2026-02-10', 25,  'CONTA_A_RECEBER'),
  ('a', NULL, 'E', '2026-02-01', 10, 'CONTA_A_RECEBER'),
  ('a', 9, 'S', '2026-02-01', 40,  'CONTA_A_PAGAR'),
  ('a', 11, 'S', '2026-02-20', 30, 'CONTA_A_PAGAR'),
  ('b', 1, 'E', '2026-05-05', 80,  'CONTA_A_RECEBER'),
  ('b', 2, 'E', '2026-06-01', 15,  'CONTA_A_RECEBER'),
  ('b', 2, 'E', '2026-07-01', 99,  'CONTA_CORRENTE_REC'),
  ('b', 9, 'S', '2026-01-20', 45,  'CONTA_CORRENTE_PAG'),
  ('b', 9, 'S', '2026-01-25', 55,  'CONTA_CORRENTE_PAG'),
  ('c', 5, 'E', '2026-02-01', 10,  'CONTA_A_RECEBER'),
  ('d', 1, 'E', '2026-02-01', 10,  'CONTA_A_RECEBER'),   -- empresa só com movimentos
  ('e', 1, 'S', '2026-01-31', 20,  'CONTA_A_PAGAR');
SQL
}

# VERBOSITY verbose: o log traz a SQLSTATE (o texto o lc_messages traduz em pt_BR).
aplicar() { P -v VERBOSITY=verbose -f "$1" >"$TMPD/apply.log" 2>&1; }

# Igualdade com a view, como service_role (o papel do engine), num único statement (1 snapshot).
IGUAL_A_VIEW="SET ROLE service_role;
WITH emp(company) AS (VALUES ('a'), ('b'), ('c'), ('d'), ('e'), ('f'), ('zz')),
  novo AS (
    SELECT e.company, (j->>'existe')::boolean, (j->>'pmr')::numeric, (j->>'pmp')::numeric,
           (j->>'pmr_cobertura')::numeric, (j->>'pmp_cobertura')::numeric
      FROM emp e, LATERAL public.fin_capital_giro_prazos_empresa(e.company) j),
  velho AS (
    SELECT e.company, v.company IS NOT NULL, v.pmr, v.pmp, v.pmr_cobertura, v.pmp_cobertura
      FROM emp e LEFT JOIN public.v_capital_giro_prazos v ON v.company = e.company)
SELECT (SELECT count(*) FROM novo) || ':' || (SELECT count(*) FROM velho) || ':'
       || ((SELECT count(*) FROM (SELECT * FROM novo EXCEPT ALL SELECT * FROM velho) x)
         + (SELECT count(*) FROM (SELECT * FROM velho EXCEPT ALL SELECT * FROM novo) y));"
campo() { Pq -c "SELECT coalesce(public.fin_capital_giro_prazos_empresa('$1')->>'$2', 'NULL')"; }

# ── CONTROLE (verde obrigatório) ────────────────────────────────────────────────
preparar_banco
R="$(Pq -c "SELECT md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true))")"
if [ "$R" = "$MD5_TB" ]; then ok "v_titulo_baixas local tem o md5 da PROD"; else falha "v_titulo_baixas md5=$R"; fi
R="$(Pq -c "SELECT md5(pg_get_viewdef('public.v_capital_giro_prazos'::regclass, true))")"
if [ "$R" = "$MD5_PZ" ]; then ok "v_capital_giro_prazos local tem o md5 da PROD"; else falha "v_capital_giro_prazos md5=$R"; fi
if aplicar "$MIG"; then ok "migration aplica (PRE + postcondicoes A1-A7)"; else falha "migration nao aplicou"; cat "$TMPD/apply.log"; fi
if aplicar "$MIG"; then ok "migration idempotente (2a aplicacao)"; else falha "2a aplicacao falhou"; cat "$TMPD/apply.log"; fi
R="$(P -tA -c "$IGUAL_A_VIEW" | tail -n 1)"
if [ "$R" = "7:7:0" ]; then ok "igual a view linha a linha como service_role (7 empresas, 0 divergencias)"; else falha "diverge da view (novo:velho:diff) = $R"; fi
# Valores conferidos à mão (a A6 sozinha não pega uma view e uma cópia erradas do mesmo jeito).
# a: CR cod1 300@03-01 (59d) + cod2 50@02-15/70@02-20 (39d) + cod5 60@02-10 (40d) → (59*300+39*120+40*60)/480 = 51,6 → 52;
# cobertura: 3 com prazo (cod6 tem emissão nula → prazo NULL, fora do numerador) de 5 liquidados = 0.600.
R="$(campo a pmr)|$(campo a pmr_cobertura)"
if [ "$R" = "52|0.600" ]; then ok "a: PMR 52 e cobertura 0.600 (empate DISTINCT ON e emissao nula)"; else falha "a: pmr|cob = $R"; fi
# a CP: cod9 40 em 31d, cod11 30 em -9d → (31*40 - 9*30)/70 = 13,86 → 14; 2 de 3.
R="$(campo a pmp)|$(campo a pmp_cobertura)"
if [ "$R" = "14|0.667" ]; then ok "a: PMP 14 com prazo negativo, cobertura 0.667"; else falha "a: pmp|cob = $R"; fi
# b: cod 9 só CC em b (título só na a): 45@01-20 (19d) + 55@01-25 (24d) → (19*45+24*55)/100 = 21,75 → 22.
R="$(campo b pmp)"
if [ "$R" = "22" ]; then ok "b: mesmo cod/tipo da a nao vaza a otica titulo (PMP 22)"; else falha "b: pmp = $R"; fi
R="$(campo c existe)|$(campo c pmr)|$(campo c pmr_cobertura)"
if [ "$R" = "true|NULL|NULL" ]; then ok "c: so titulo aberto -> existe, tudo null"; else falha "c: $R"; fi
R="$(campo d existe)"
if [ "$R" = "false" ]; then ok "d: so movimentos -> existe=false"; else falha "d: $R"; fi
R="$(campo e pmr)|$(campo e pmp)|$(campo e pmp_cobertura)"
if [ "$R" = "NULL|30|1.000" ]; then ok "e: so CP -> PMR null, PMP 30"; else falha "e: $R"; fi
R="$(campo f pmr)|$(campo f pmr_cobertura)"
if [ "$R" = "NULL|0.000" ]; then ok "f: liquidado sem movimento -> PMR null e cobertura 0 (zero != null)"; else falha "f: $R"; fi
R="$(Pq -c "SELECT public.fin_capital_giro_prazos_empresa('zz')::text")"
if [ "$R" = '{"pmp": null, "pmr": null, "existe": false, "pmp_cobertura": null, "pmr_cobertura": null}' ]; then ok "inexistente: envelope com existe=false"; else falha "zz: $R"; fi
R="$(P -tA -v VERBOSITY=sqlstate -c "SELECT public.fin_capital_giro_prazos_empresa(NULL)" 2>&1 || true)"
case "$R" in *"22004"*) ok "p_company nulo: 22004";; *) falha "p_company nulo: $R";; esac
R="$(P -tA -v VERBOSITY=sqlstate -c "SET ROLE authenticated; SELECT public.fin_capital_giro_prazos_empresa('a')" 2>&1 || true)"
case "$R" in *"42501"*) ok "authenticated sem EXECUTE (42501)";; *) falha "authenticated executou: $R";; esac
R="$(P -tA -v VERBOSITY=sqlstate -c "SET ROLE anon; SELECT public.fin_capital_giro_prazos_empresa('a')" 2>&1 || true)"
case "$R" in *"42501"*) ok "anon sem EXECUTE (42501)";; *) falha "anon executou: $R";; esac
# Pin da camada de DESEMPENHO: o filtro de empresa dentro do `mov` (a A6 não o vê).
PIN_MOV="WHERE fin_movimentacoes.company = p_company AND fin_movimentacoes.omie_codigo_lancamento IS NOT NULL"
pin_mov() { Pq -c "SELECT position('$PIN_MOV' in pg_get_functiondef('public.fin_capital_giro_prazos_empresa(text)'::regprocedure)) > 0"; }
if [ "$(pin_mov)" = "t" ]; then ok "filtro de empresa dentro do mov (pin de desempenho)"; else falha "filtro de empresa ausente do mov"; fi

# ── SABOTAGENS (cada uma TEM de ficar vermelha) ────────────────────────────────
sabotar() { # $1 nome  $2 expressão sed  $3 trecho esperado no erro
  local copia="$TMPD/sab.sql"
  sed "$2" "$MIG" >"$copia"
  if cmp -s "$copia" "$MIG"; then falha "sabotagem $1 nao alterou a copia"; return; fi
  preparar_banco
  if aplicar "$copia"; then falha "sabotagem $1 passou verde"; return; fi
  if grep -q "$3" "$TMPD/apply.log"; then ok "sabotagem $1 vermelha ($3)"; else falha "sabotagem $1 vermelha pelo motivo errado"; cat "$TMPD/apply.log"; fi
}
sabotar "regra do ramo CR divergente" "s/(cr.status_titulo = ANY (ARRAY\['RECEBIDO'::text, 'LIQUIDADO'::text\]))/(cr.status_titulo = ANY (ARRAY['RECEBIDO'::text]))/" "A6 FALHOU"
sabotar "denominador de CP divergente" "s/fin_contas_pagar.status_titulo = ANY (ARRAY\['PAGO'::text, 'LIQUIDADO'::text\])/fin_contas_pagar.status_titulo = ANY (ARRAY['PAGO'::text])/" "A6 FALHOU"
sabotar "arredondamento da cobertura" "s/NULLIF(cps.n, 0)::numeric, 3)/NULLIF(cps.n, 0)::numeric, 2)/" "A6 FALHOU"
sabotar "companies sem filtro (varias linhas)" "/WHERE fin_contas_receber.company = p_company$/d" "21000"
sabotar "existe fixo em true" "s/'existe', p.company IS NOT NULL/'existe', true/" "A5 FALHOU"
sabotar "sem guarda de nulo" "/RAISE EXCEPTION 'fin_capital_giro_prazos_empresa: p_company nulo'/d;s/^  IF p_company IS NULL THEN$/  IF false THEN NULL;/" "A7 FALHOU"
sabotar "md5 do PRE (v_titulo_baixas) trocado" "s/vivo_tb IS DISTINCT FROM '$MD5_TB'/vivo_tb IS DISTINCT FROM '00000000000000000000000000000000'/" "PRE FALHOU: v_titulo_baixas"
sabotar "md5 do PRE (v_capital_giro_prazos) trocado" "s/vivo_pz IS DISTINCT FROM '$MD5_PZ'/vivo_pz IS DISTINCT FROM '00000000000000000000000000000000'/" "PRE FALHOU: v_capital_giro_prazos"
sabotar "guarda de runtime (v_titulo_baixas) errada" "s/v_titulo_baixas'::regclass, true)) IS DISTINCT FROM '$MD5_TB'$/v_titulo_baixas'::regclass, true)) IS DISTINCT FROM 'ffffffffffffffffffffffffffffffff'/" "refaca a copia"
sabotar "guarda de runtime (v_capital_giro_prazos) errada" "s/v_capital_giro_prazos'::regclass, true)) IS DISTINCT FROM '$MD5_PZ' THEN$/v_capital_giro_prazos'::regclass, true)) IS DISTINCT FROM 'ffffffffffffffffffffffffffffffff' THEN/" "refaca a copia"
sabotar "sem REVOKE de authenticated" "/FROM authenticated;/d" "A3 FALHOU"
sabotar "sem REVOKE de anon" "/FROM anon;/d" "A3 FALHOU"
sabotar "security definer" "s/LANGUAGE plpgsql STABLE SECURITY INVOKER/LANGUAGE plpgsql STABLE SECURITY DEFINER/" "A2 FALHOU"
sabotar "service_role revogado" "s/^GRANT EXECUTE ON FUNCTION public.fin_capital_giro_prazos_empresa(text) TO service_role;/REVOKE ALL ON FUNCTION public.fin_capital_giro_prazos_empresa(text) FROM service_role;/" "A4 FALHOU"

# Camada de DESEMPENHO: sem o filtro no `mov` a migration passa (A6 verde: o resultado não muda)
# e é o pin que tem de ficar vermelho.
sed "s/WHERE fin_movimentacoes.company = p_company AND /WHERE /" "$MIG" >"$TMPD/sab.sql"
if cmp -s "$TMPD/sab.sql" "$MIG"; then falha "sabotagem do mov nao alterou a copia"; else
  preparar_banco
  if aplicar "$TMPD/sab.sql"; then
    if [ "$(pin_mov)" = "f" ]; then ok "sabotagem filtro do mov: A6 verde (camada de desempenho), pin vermelho"; else falha "sabotagem filtro do mov: pin continuou verde"; fi
  else falha "sabotagem filtro do mov: migration falhou (esperava A6 verde)"; cat "$TMPD/apply.log"; fi
fi

# Views vivas derivaram (outra sessão mudou uma delas): o PRE tem de barrar a cópia velha.
derivar() { # $1 view
  P <<SQL
ALTER VIEW public.$1 RENAME TO $1_antiga;
CREATE VIEW public.$1 WITH (security_invoker = on) AS SELECT * FROM public.$1_antiga;
SQL
}
for V in v_titulo_baixas v_capital_giro_prazos; do
  preparar_banco
  derivar "$V" >/dev/null
  if aplicar "$MIG"; then falha "$V derivada passou pelo PRE"; elif grep -q "PRE FALHOU: $V" "$TMPD/apply.log"; then ok "$V derivada barrada pelo PRE"; else falha "$V derivada: motivo errado"; cat "$TMPD/apply.log"; fi
  # Deriva DEPOIS do apply: a função tem de falhar explícita (P0001), não divergir em silêncio.
  preparar_banco
  aplicar "$MIG" || { falha "apply para o teste de deriva"; cat "$TMPD/apply.log"; }
  derivar "$V" >/dev/null
  R="$(P -tA -v VERBOSITY=sqlstate -c "SELECT public.fin_capital_giro_prazos_empresa('a')" 2>&1 || true)"
  case "$R" in *"P0001"*) ok "$V deriva pos-apply: funcao falha explicita (P0001)";; *) falha "$V deriva pos-apply passou: $R";; esac
done

echo "---"
if [ "$FALHAS" -eq 0 ]; then echo "PROVA-FIN-CAPITAL-GIRO-PRAZOS-EMPRESA: TUDO VERDE"; exit 0; fi
echo "PROVA-FIN-CAPITAL-GIRO-PRAZOS-EMPRESA: $FALHAS FALHA(S)"; exit 1
