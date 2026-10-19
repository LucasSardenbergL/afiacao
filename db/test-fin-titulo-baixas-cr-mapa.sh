#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261019110100_fin_titulo_baixas_cr_mapa                         ║
# ║      bash db/test-fin-titulo-baixas-cr-mapa.sh > logs/t.log 2>&1; echo "exit=$?"║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-titulo-baixas-cr-mapa.sh  (2º ambiente)   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# A função copia o ramo CR de v_titulo_baixas com o filtro de empresa dentro do CTE `mov`
# (a view materializa o CTE e varre fin_movimentacoes inteira: 9 avaliações simultâneas do
# cron estouravam o statement_timeout de 8 s). O contrato é IGUALDADE com a view; a prova:
#   - a view é criada com o texto VERBATIM de pg_get_viewdef da PROD (2026-10-19), então o PRE
#     por md5 da migration é exercitado de verdade;
#   - fixture cobre: ótica título × conta corrente, baixa parcelada, status fora da lista,
#     cod NULL, CP (outro ramo), 2 empresas com o MESMO omie_codigo_lancamento;
#   - controle verde na MESMA invocação + 1 sabotagem por camada sobre CÓPIA da migration.
# Asserções ASCII, caixa fixa, sem -i.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5491}"
SLUG="fin-titulo-baixas-cr-mapa"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261019110100_fin_titulo_baixas_cr_mapa.sql"

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
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
  # View VERBATIM da PROD (pg_get_viewdef, 2026-10-19, md5 57e98392e33a254d924927f8e07dea5f).
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
SQL
  P <<'SQL'
INSERT INTO fin_contas_receber VALUES
  ('a', 1, '2026-01-01', 'RECEBIDO'),   -- ótica título, 2 movs (parcial) + 1 CC ignorado
  ('a', 2, '2026-01-10', 'LIQUIDADO'),  -- só conta corrente
  ('a', 3, '2026-01-10', 'A VENCER'),   -- status fora da lista
  ('a', 4, '2026-02-01', 'RECEBIDO'),   -- sem movimento
  ('b', 1, '2026-03-01', 'RECEBIDO'),   -- MESMO cod em outra empresa
  ('b', 2, '2026-01-10', 'RECEBIDO'),   -- MESMO cod 2 da a (só CC), aqui ótica TÍTULO: bool_or não pode vazar
  ('c', 5, '2026-01-10', 'A VENCER');   -- empresa com movimento mas sem CR elegível
INSERT INTO fin_contas_pagar VALUES ('a', 9, '2026-01-01', 'PAGO');
INSERT INTO fin_movimentacoes VALUES
  ('a', 1, 'E', '2026-02-01', 100, 'CONTA_A_RECEBER'),
  ('a', 1, 'E', '2026-03-01', 300, 'CONTA_A_RECEBER'),
  ('a', 1, 'E', '2026-04-01', 999, 'CONTA_CORRENTE_REC'),
  ('a', 2, 'E', '2026-02-15', 50,  'CONTA_CORRENTE_REC'),
  ('a', 2, 'E', '2026-02-20', 70,  'CONTA_CORRENTE_REC'),
  ('a', 3, 'E', '2026-02-01', 10,  'CONTA_A_RECEBER'),
  ('a', NULL, 'E', '2026-02-01', 10, 'CONTA_A_RECEBER'),
  ('a', 9, 'S', '2026-02-01', 40,  'CONTA_A_PAGAR'),
  ('b', 1, 'E', '2026-05-05', 80,  'CONTA_A_RECEBER'),
  ('b', 2, 'E', '2026-06-01', 15,  'CONTA_A_RECEBER'),
  ('b', 2, 'E', '2026-07-01', 99,  'CONTA_CORRENTE_REC'),
  ('c', 5, 'E', '2026-02-01', 10,  'CONTA_A_RECEBER');
SQL
}

aplicar() { P -f "$1" >"$TMPD/apply.log" 2>&1; }

IGUAL_A_VIEW="WITH novo AS (
    SELECT e.c, (p->>0)::bigint AS cod, (p->>1)::date AS d
      FROM (VALUES ('a'), ('b'), ('c'), ('zz')) e(c),
           jsonb_array_elements(public.fin_titulo_baixas_cr_mapa(e.c)->'pares') p),
  velho AS (SELECT company, omie_codigo_lancamento, data_baixa_final FROM v_titulo_baixas
             WHERE tipo = 'CR' AND omie_codigo_lancamento IS NOT NULL AND data_baixa_final IS NOT NULL)
  SELECT (SELECT count(*) FROM (SELECT * FROM novo EXCEPT ALL SELECT * FROM velho) x)
       + (SELECT count(*) FROM (SELECT * FROM velho EXCEPT ALL SELECT * FROM novo) y)"

# ── CONTROLE (verde obrigatório) ────────────────────────────────────────────────
preparar_banco
MD5="$(Pq -c "SELECT md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true))")"
if [ "$MD5" = "57e98392e33a254d924927f8e07dea5f" ]; then ok "view local tem o md5 da PROD"; else falha "view local md5=$MD5 (esperado o da PROD)"; fi
if aplicar "$MIG"; then ok "migration aplica (PRE + postcondicoes A1-A6)"; else falha "migration nao aplicou"; cat "$TMPD/apply.log"; fi
if aplicar "$MIG"; then ok "migration idempotente (2a aplicacao)"; else falha "2a aplicacao falhou"; cat "$TMPD/apply.log"; fi
R="$(Pq -c "SELECT public.fin_titulo_baixas_cr_mapa('a')::text")"
if [ "$R" = '{"pares": [[1, "2026-03-01"], [2, "2026-02-20"]], "total": 2}' ]; then ok "empresa a: titulo (max data da otica titulo) + conta corrente"; else falha "empresa a: $R"; fi
R="$(Pq -c "SELECT public.fin_titulo_baixas_cr_mapa('b')::text")"
if [ "$R" = '{"pares": [[1, "2026-05-05"], [2, "2026-06-01"]], "total": 2}' ]; then ok "empresa b: mesmo cod nao vaza da empresa a (otica titulo x CC)"; else falha "empresa b: $R"; fi
R="$(Pq -c "SELECT public.fin_titulo_baixas_cr_mapa('zz')::text")"
if [ "$R" = '{"pares": [], "total": 0}' ]; then ok "empresa inexistente: envelope com total 0"; else falha "empresa zz: $R"; fi
R="$(Pq -c "SELECT public.fin_titulo_baixas_cr_mapa('c')::text")"
if [ "$R" = '{"pares": [], "total": 0}' ]; then ok "empresa com movimento sem CR elegivel: total 0"; else falha "empresa c: $R"; fi
R="$(Pq -c "$IGUAL_A_VIEW")"
if [ "$R" = "0" ]; then ok "igual a view linha a linha"; else falha "diverge da view: $R linhas"; fi
# SQLSTATE (não o texto, que o lc_messages traduz em pt_BR).
R="$(P -tA -v VERBOSITY=sqlstate -c "SET ROLE authenticated; SELECT public.fin_titulo_baixas_cr_mapa('a')" 2>&1 || true)"
case "$R" in *"42501"*) ok "authenticated sem EXECUTE (42501)";; *) falha "authenticated executou: $R";; esac
R="$(P -tA -c "SET ROLE service_role; SELECT (public.fin_titulo_baixas_cr_mapa('a')->>'total')" 2>&1 || true)"
if [ "$R" = "2" ]; then ok "service_role executa"; else falha "service_role: $R"; fi

# ── SABOTAGENS (cada uma TEM de ficar vermelha) ────────────────────────────────
sabotar() { # $1 nome  $2 expressão sed  $3 trecho esperado no erro
  local copia="$TMPD/sab.sql"
  sed "$2" "$MIG" >"$copia"
  if cmp -s "$copia" "$MIG"; then falha "sabotagem $1 nao alterou a copia"; return; fi
  preparar_banco
  if aplicar "$copia"; then falha "sabotagem $1 passou verde"; return; fi
  if grep -q "$3" "$TMPD/apply.log"; then ok "sabotagem $1 vermelha ($3)"; else falha "sabotagem $1 vermelha pelo motivo errado"; cat "$TMPD/apply.log"; fi
}
sabotar "regra de negocio divergente" "s/ARRAY\['RECEBIDO'::text, 'LIQUIDADO'::text\]/ARRAY['RECEBIDO'::text]/" "A6 FALHOU"
# O filtro em `cr` e o em `mov` são redundantes entre si para o RESULTADO (o join por company
# propaga um ao outro; o de `mov` é o que dá a performance) — sabota-se os dois juntos.
sabotar "sem filtro de empresa" "s/WHERE cr.company = p_company AND /WHERE /;s/WHERE fin_movimentacoes.company = p_company AND /WHERE /" "A6 FALHOU"
sabotar "md5 do PRE trocado" "s/vivo IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f'/vivo IS DISTINCT FROM '00000000000000000000000000000000'/" "PRE FALHOU"
sabotar "sem REVOKE de authenticated" "/FROM authenticated;/d" "A3 FALHOU"
sabotar "sem REVOKE de anon" "/FROM anon;/d" "A3 FALHOU"
sabotar "security definer" "s/LANGUAGE plpgsql STABLE SECURITY INVOKER/LANGUAGE plpgsql STABLE SECURITY DEFINER/" "A2 FALHOU"
# GRANT a service_role: redundante com o default privilege do Supabase (mantido como explícito);
# a A4 é exercitada revogando-o depois do GRANT.
sabotar "guarda de runtime com md5 errado" "s/regclass, true)) IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f'/regclass, true)) IS DISTINCT FROM 'ffffffffffffffffffffffffffffffff'/" "refaca a copia do ramo CR"
sabotar "service_role revogado" "s/^GRANT EXECUTE ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) TO service_role;/REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cr_mapa(text) FROM service_role;/" "A4 FALHOU"

# View viva derivou (outra sessão mudou v_titulo_baixas): o PRE tem de barrar a cópia velha.
preparar_banco
P <<'SQL'
ALTER VIEW public.v_titulo_baixas RENAME TO v_titulo_baixas_antiga;
CREATE VIEW public.v_titulo_baixas WITH (security_invoker = on) AS SELECT * FROM public.v_titulo_baixas_antiga;
SQL
if aplicar "$MIG"; then falha "view derivada passou pelo PRE"; elif grep -q "PRE FALHOU" "$TMPD/apply.log"; then ok "view derivada barrada pelo PRE"; else falha "view derivada: motivo errado"; cat "$TMPD/apply.log"; fi

# Deriva DEPOIS do apply: a função tem de falhar explícita (P0001), não divergir em silêncio.
preparar_banco
aplicar "$MIG" || { falha "apply para o teste de deriva"; cat "$TMPD/apply.log"; }
P <<'SQL'
ALTER VIEW public.v_titulo_baixas RENAME TO v_titulo_baixas_antiga;
CREATE VIEW public.v_titulo_baixas WITH (security_invoker = on) AS SELECT * FROM public.v_titulo_baixas_antiga;
SQL
R="$(P -tA -v VERBOSITY=sqlstate -c "SELECT public.fin_titulo_baixas_cr_mapa('a')" 2>&1 || true)"
case "$R" in *"P0001"*) ok "deriva pos-apply: funcao falha explicita (P0001)";; *) falha "deriva pos-apply passou: $R";; esac

echo "---"
if [ "$FALHAS" -eq 0 ]; then echo "PROVA-FIN-TITULO-BAIXAS-CR-MAPA: TUDO VERDE"; exit 0; fi
echo "PROVA-FIN-TITULO-BAIXAS-CR-MAPA: $FALHAS FALHA(S)"; exit 1
