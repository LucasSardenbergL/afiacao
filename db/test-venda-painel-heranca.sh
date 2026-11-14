#!/usr/bin/env bash
# Prova PG17 da 20261108010000_venda_painel_heranca: o PAINEL DE GESTÃO (`venda_painel`) separa a parte HERDADA
# (sucessor declarado, entrega 3).
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  M0  o corpo ANTERIOR do repo (20261020235000) é o de prod: md5 78d9e58f…
#  H0  INVARIÂNCIA: tirando `herdadas` e `taxa_ativa_propria`, o JSON é byte a byte o do corpo anterior (mesmos dados)
#  H1  herdadas por linha: compradores distintos, sugestões, desfechos de recompra (complemento fora do desfecho)
#  H2  taxa_ativa_propria = (virou − herdadas) ÷ (virou + não virou − herdadas); a taxa total segue a de antes
#  H3  receita herdada: soma das vendas casadas herdadas, `receita_incompleta` com venda sem valor
#  H4  ausente ≠ zero: farmer só com lista própria → herdadas zeradas, receita herdada NULL, própria = total;
#      linha ativa SÓ herdada → própria NULL (denominador 0, não 0%); semana sem lista ativa → própria NULL
#  H7  a linha de base própria (histórico e sombra sem herdadas): a base antiga mistura, a própria não
#  H5  sombra/histórico herdados não entram na fatia (só a fase ativa)
#  H6  o gate continua master (farmer → 42501)
#  M1  a migration re-aplica (idempotente); M2 ACL (anon/PUBLIC fechados); M3 a PRE recusa corpo alheio
#  M4  db/validar-venda-painel-heranca.sql dá 4 ✅ contra a migration real
#  M5  PÓS que falha desfaz tudo (psql -1, como o SQL Editor): o corpo anterior fica
#
#   bash db/test-venda-painel-heranca.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-painel-heranca.sh   # mesma prova no outro locale (marcas ASCII)
#   bash db/test-venda-painel-heranca.sh --falsificar               # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_ANTES="$REPO_ROOT/supabase/migrations/20261020235000_venda_cliente_painel.sql"
MIG="$REPO_ROOT/supabase/migrations/20261108010000_venda_painel_heranca.sql"
[ -f "$MIG_ANTES" ] && [ -f "$MIG" ] || { echo "migration ausente"; exit 1; }

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="propria_sem_nullif:H4b base_hist_mistura:H7 base_sombra_mistura:H7 herd_sem_distinct:H1 herd_desfecho_com_complemento:H1 propria_sem_subtrair:H2 receita_herdada_zero:H4 herd_sem_filtro_origem:H1 muda_chave_antiga:H0 pre_aberta:M3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-painel-heranca.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-painel-heranca" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -qF -- "FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [FAIL $a]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [FAIL $a] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5632}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-painel-heranca.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; o padrão tem de ocorrer UMA vez)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PYS'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrao ausente ou repetido (%d): %s" % (s.count(de), de))
s = s.replace(de, para)
# o corpo sabotado tem outro md5: a PÓS (e a PRE, no re-apply) passam a esperar o md5 DELE — a sabotagem tem de
# chegar aos asserts, não morrer no catálogo
import hashlib, re
i = s.index("AS $function$") + len("AS $function$"); j = s.index("$function$;", i)
novo = hashlib.md5(s[i:j].encode()).hexdigest()
s = s.replace("2b3f2c1b9af99c6dcc34f413f9534c54", novo)
open(p, "w", encoding="utf-8").write(s)
PYS
}
case "${SABOTAGEM:-}" in
  "") ;;
  herd_sem_distinct)   sabotar "count(DISTINCT s.comprador_id) FILTER (WHERE s.sucessao_origem IS NOT NULL)   AS h_na_lista," \
                               "count(s.comprador_id) FILTER (WHERE s.sucessao_origem IS NOT NULL)   AS h_na_lista," ;;
  herd_desfecho_com_complemento) sabotar "count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL AND s.tipo = 'recompra'
                              AND s.desfecho = 'nao_virou')" "count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL
                              AND s.desfecho = 'nao_virou')" ;;
  propria_sem_subtrair) sabotar "round((a.virou - a.h_virou)::numeric
                                       / NULLIF((a.virou - a.h_virou) + (a.nao_virou - a.h_nao_virou), 0), 4)" \
                                "round(a.virou::numeric / NULLIF(a.virou + a.nao_virou, 0), 4)" ;;
  receita_herdada_zero) sabotar "'receita_realizada', a.h_receita," "'receita_realizada', COALESCE(a.h_receita, 0)," ;;
  herd_sem_filtro_origem) sabotar "count(*) FILTER (WHERE s.sucessao_origem IS NOT NULL)                         AS h_sugestoes," \
                                  "count(*)                                                                    AS h_sugestoes," ;;
  propria_sem_nullif)  sabotar "/ NULLIF((a.virou - a.h_virou) + (a.nao_virou - a.h_nao_virou), 0), 4)," \
                               "/ GREATEST((a.virou - a.h_virou) + (a.nao_virou - a.h_nao_virou), 1), 4)," ;;
  base_hist_mistura)   sabotar "'taxa_base_historico_propria', round(h.p_virou::numeric / NULLIF(h.p_virou + h.p_nao_virou, 0), 4)," \
                               "'taxa_base_historico_propria', round(h.virou::numeric / NULLIF(h.virou + h.nao_virou, 0), 4)," ;;
  base_sombra_mistura) sabotar "'taxa_base_sombra_propria', round(bs.p_virou::numeric / NULLIF(bs.p_virou + bs.p_nao_virou, 0), 4)" \
                               "'taxa_base_sombra_propria', round(bs.virou::numeric / NULLIF(bs.virou + bs.nao_virou, 0), 4)" ;;
  muda_chave_antiga)   sabotar "'mostradas',        COALESCE(a.mostradas, 0)," "'mostradas',        COALESCE(a.mostradas, 0) + COALESCE(a.h_na_lista, 0)," ;;
  pre_aberta)          sabotar "IF v_vivo IS NULL OR NOT (v_vivo = ANY" "IF false AND NOT (v_vivo = ANY" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; M=00000000-0000-0000-0000-0000000000ee
C1=00000000-0000-0000-0000-0000000000c1; C2=00000000-0000-0000-0000-0000000000c2; C3=00000000-0000-0000-0000-0000000000c3
C4=00000000-0000-0000-0000-0000000000c4; C5=00000000-0000-0000-0000-0000000000c5
como() { # $1 = uid ('' = sem sessão), $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}
# ── Esquema mínimo com as MESMAS colunas de prod (medido via psql-ro em 2026-10-20) ─────────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: função nova NASCE aberta (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
CREATE TYPE public.commercial_role AS ENUM ('farmer', 'hunter', 'master');
CREATE TABLE public.commercial_roles (id uuid DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid, name text);

CREATE TABLE public.venda_config (chave text PRIMARY KEY, valor jsonb NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.venda_onda_log (onda text PRIMARY KEY, ligada_em timestamptz NOT NULL DEFAULT now(), condicao jsonb NOT NULL);
CREATE TABLE public.venda_gerador_execucao (dia_referencia date NOT NULL, fase text NOT NULL,
  primeira_em timestamptz NOT NULL DEFAULT now(), ultima_em timestamptz NOT NULL DEFAULT now(), linhas int NOT NULL DEFAULT 0,
  PRIMARY KEY (dia_referencia, fase));
CREATE TABLE public.venda_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_user_id uuid NOT NULL,
  comprador_id uuid NOT NULL, dia date NOT NULL, resultado text NOT NULL, motivo text,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farmer_user_id, comprador_id, dia));
CREATE TABLE public.venda_sugestao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('recompra','complemento','preco')),
  fase text NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  dia_referencia date NOT NULL, gerada_em timestamptz NOT NULL DEFAULT now(),
  farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL, empresa text NOT NULL,
  omie_codigo_produto bigint, familia text, qtd_ref numeric, valor_ref numeric, preco_alvo numeric,
  motivo_entrada text NOT NULL DEFAULT 'teste', mostrada_em timestamptz,
  desfecho text CHECK (desfecho IN ('virou_pedido','nao_virou','nao_medivel')), desfecho_motivo text,
  sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz,
  sucessao_origem jsonb);  -- PR B (20261107210000): o gerador preenche nas herdadas

INSERT INTO public.venda_config VALUES
  ('onda_recompra','false'), ('onda_complemento','false'), ('onda_preco','false'),
  ('teto_maiores_atrasos','10'), ('janela_dias','{"recompra":14,"complemento":30,"preco":30}');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee'), ('$F2','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$F1','farmer'), ('$F2','farmer'), ('$M','master');
INSERT INTO public.profiles (user_id, name) VALUES ('$F1','Regina'), ('$F2','Tatyana'), ('$M','Lucas');
CREATE TABLE public.prova_antes (j jsonb);
GRANT ALL ON public.prova_antes TO authenticated;
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
md5_vivo() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.venda_painel(date,date)'::regprocedure"; }

# ── O corpo ANTERIOR (o de prod) ────────────────────────────────────────────────────────────────
P -q -f "$MIG_ANTES" > /dev/null
eq "M0 o corpo anterior do repo e o de prod (md5 78d9e58f)" "$(md5_vivo)" "78d9e58f73c7fb3a902f864a2e131993"

W="$(Pq -c "SELECT date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 21)::date")"
H='[{"evento_id":"00000000-0000-0000-0000-0000000000e1","revisao":1}]'

P -q <<SQL
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, familia,
                                   mostrada_em, desfecho, valor_realizado, sucessao_origem) VALUES
 -- F1 em W, PRÓPRIAS: C1 virou R\$ 300 e nao_virou, C2 mostrado e nao_medivel, C3 pendente, complemento nao_virou
 ('recompra',   'ativa', '$W'::date,     '$F1','$C1','oben',    111, NULL,      NULL,  'virou_pedido', 300, NULL),
 ('recompra',   'ativa', '$W'::date,     '$F1','$C1','oben',    222, NULL,      NULL,  'nao_virou',    NULL, NULL),
 ('recompra',   'ativa', '$W'::date + 1, '$F1','$C2','colacor', 111, NULL,      now(), 'nao_medivel',  NULL, NULL),
 ('recompra',   'ativa', '$W'::date + 2, '$F1','$C3','oben',    333, NULL,      NULL,  NULL,           NULL, NULL),
 ('complemento','ativa', '$W'::date,     '$F1','$C1','oben',    NULL,'Seladora',NULL,  'nao_virou',    NULL, NULL),
 -- F1 em W, HERDADAS: C4 (virou R\$ 50, nao_virou, pendente, complemento nao_virou), C1 nao_medivel, C5 virou sem valor
 ('recompra',   'ativa', '$W'::date,     '$F1','$C4','oben',    444, NULL,      now(), 'virou_pedido', 50,   '$H'),
 ('recompra',   'ativa', '$W'::date + 1, '$F1','$C4','oben',    555, NULL,      NULL,  'nao_virou',    NULL, '$H'),
 ('recompra',   'ativa', '$W'::date + 2, '$F1','$C4','oben',    888, NULL,      NULL,  NULL,           NULL, '$H'),
 ('complemento','ativa', '$W'::date,     '$F1','$C4','oben',    NULL,'Verniz',  NULL,  'nao_virou',    NULL, '$H'),
 ('recompra',   'ativa', '$W'::date,     '$F1','$C1','oben',    777, NULL,      NULL,  'nao_medivel',  NULL, '$H'),
 ('recompra',   'ativa', '$W'::date + 3, '$F1','$C5','oben',    999, NULL,      NULL,  'virou_pedido', NULL, '$H'),
 -- herdadas FORA da fase ativa: não entram na fatia (H5)
 ('recompra',   'sombra',   '$W'::date,       '$F1','$C4','oben', 444, NULL,    NULL,  'virou_pedido', 5,    '$H'),
 ('recompra',   'historico','$W'::date - 364, '$F1','$C4','oben', 444, NULL,    NULL,  'virou_pedido', 5,    '$H'),
 -- F2 em W: só própria (H4)
 ('recompra',   'ativa', '$W'::date,     '$F2','$C2','oben',    111, NULL,      NULL,  'virou_pedido', 20,   NULL),
 -- F1 na semana W+7: só sombra (a linha existe, sem lista ativa → própria NULL)
 ('recompra',   'sombra', '$W'::date + 7, '$F1','$C1','oben',   111, NULL,      NULL,  'nao_virou',    NULL, NULL),
 -- F1 na semana W+7, lista ativa SÓ herdada: total 0/(0+1), própria sem denominador (H4b)
 ('recompra',   'ativa',  '$W'::date + 7, '$F1','$C4','oben',   444, NULL,      NULL,  'nao_virou',    NULL, '$H');
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado) VALUES ('$F1','$C4','$W'::date + 3, 'vai_pedir');
SQL

# o JSON do corpo ANTERIOR, com os MESMOS dados (herdadas inclusas: o corpo velho as conta como próprias)
Pq -c "$(como "$M" "INSERT INTO public.prova_antes SELECT public.venda_painel('$W'::date, '$W'::date + 13);")" > /dev/null

# ── ESTA migration ──────────────────────────────────────────────────────────────────────────────
P -q -f "$MIG_USADA" > /dev/null
echo "md5 do corpo novo: $(md5_vivo)"

painel() { Pq -c "$(como "$M" "SELECT $1 FROM (SELECT public.venda_painel('$W'::date, '$W'::date + 13) AS j) x;")"; }
linha() { # $1 = farmer, $2 = semana, $3 = expressão sobre a linha r
  Pq -c "$(como "$M" "SELECT $3 FROM (SELECT public.venda_painel('$W'::date, '$W'::date + 13) AS j) x,
                       jsonb_array_elements(x.j->'linhas') r WHERE r->>'farmer_user_id' = '$1' AND r->>'semana' = '$2';")"
}

# H0 invariância
eq "H0 sem as 6 chaves novas, o JSON e o do corpo anterior" \
   "$(Pq -c "$(como "$M" "SELECT (n.j - 'linhas') = (a.j - 'linhas')
       AND (SELECT jsonb_agg(e.r - 'herdadas' - 'taxa_ativa_propria' - 'base_historico_propria' - 'taxa_base_historico_propria'
                                 - 'base_sombra_propria' - 'taxa_base_sombra_propria' ORDER BY e.o)
              FROM jsonb_array_elements(n.j->'linhas') WITH ORDINALITY e(r, o)) = a.j->'linhas'
       AND jsonb_array_length(n.j->'linhas') = 4
     FROM (SELECT public.venda_painel('$W'::date, '$W'::date + 13) AS j) n, public.prova_antes a;")")" "t"

# H1 a fatia herdada de F1 em W
eq "H1 herdadas de F1 em W: na_lista sugestoes virou nao_virou nao_medivel pendentes" \
   "$(linha "$F1" "$W" "concat_ws(' ', r->'herdadas'->>'na_lista', r->'herdadas'->>'sugestoes', r->'herdadas'->>'virou',
        r->'herdadas'->>'nao_virou', r->'herdadas'->>'nao_medivel', r->'herdadas'->>'pendentes')")" "3 6 2 1 1 1"

# H2 a taxa própria tira as herdadas; a total é a de antes
eq "H2 taxa total 3/(3+2) e propria 1/(1+1)" \
   "$(linha "$F1" "$W" "concat_ws(' ', r->>'taxa_ativa', r->>'taxa_ativa_propria')")" "0.6000 0.5000"

# H3 receita herdada
eq "H3 receita herdada 50 (C5 sem valor marca incompleta); total 350" \
   "$(linha "$F1" "$W" "concat_ws(' ', r->'herdadas'->>'receita_realizada', r->'herdadas'->>'receita_incompleta', r->>'receita_realizada')")" "50 true 350"

# H4 ausente ≠ zero
eq "H4 F2 so propria: herdadas zeradas, receita herdada null, propria = total" \
   "$(linha "$F2" "$W" "concat_ws(' ', r->'herdadas'->>'na_lista', r->'herdadas'->>'sugestoes', r->'herdadas'->>'virou',
        jsonb_typeof(r->'herdadas'->'receita_realizada'), r->'herdadas'->>'receita_incompleta', r->>'taxa_ativa', r->>'taxa_ativa_propria')")" \
   "0 0 0 null false 1.0000 1.0000"
W7="$(Pq -c "SELECT ('$W'::date + 7)::text")"
eq "H4b linha ativa so herdada: total 0/(0+1), propria null (nao 0%), 1 sugestao herdada" \
   "$(linha "$F1" "$W7" "concat_ws(' ', r->>'taxa_ativa', jsonb_typeof(r->'taxa_ativa_propria'), r->'herdadas'->>'sugestoes', jsonb_typeof(r->'herdadas'->'receita_realizada'))")" \
   "0.0000 null 1 null"
eq "H4c semana sem lista ativa: propria null, herdadas zeradas" \
   "$(linha "$F2" "$W7" "concat_ws(' ', jsonb_typeof(r->'taxa_ativa_propria'), r->'herdadas'->>'sugestoes')")" "null 0"

# H7 a base própria: histórico de W só tem a herdada (total 1/1, própria sem base); sombra 1 herdada virou + 1 própria não
eq "H7 base historico total 1.0000 propria null; sombra total 0.5000 propria 0.0000 (0/1)" \
   "$(linha "$F1" "$W" "concat_ws(' ', r->>'taxa_base_historico_mesma_semana', jsonb_typeof(r->'taxa_base_historico_propria'),
        r->'base_historico_propria'->>'virou', r->>'taxa_base_sombra', r->>'taxa_base_sombra_propria', r->'base_sombra_propria'->>'nao_virou')")" \
   "1.0000 null 0 0.5000 0.0000 1"

# H5 sombra e histórico herdados fora da fatia (a semana W+7 da sombra não tem herdada ativa; a sombra de W não somou)
eq "H5 sombra/historico herdados nao entram: virou herdado continua 2" "$(linha "$F1" "$W" "r->'herdadas'->>'virou'")" "2"

# H6 gate
eq "H6 farmer -> 42501" "$(estado "$(como "$F1" "SELECT public.venda_painel('$W'::date, '$W'::date + 6);")")" "42501"

# M5 PÓS que falha desfaz o CREATE (psql -1 = uma transação, como o SQL Editor): volta ao corpo anterior e reaplica
P -q -f "$MIG_ANTES" > /dev/null
MD5_NOVO="$(grep -oE "IS DISTINCT FROM '[0-9a-f]{32}'" "$MIG_USADA" | sed -n 1p | grep -oE '[0-9a-f]{32}')"
sed "s/IS DISTINCT FROM '$MD5_NOVO'/IS DISTINCT FROM 'pos-quebrada'/" "$MIG_USADA" > "$(dirname "$DATA")/mig-pos-quebrada.sql"
SAIDA_M5="$(P -1 -q -f "$(dirname "$DATA")/mig-pos-quebrada.sql" 2>&1 || true)"
eq "M5 POS quebrada aborta e o corpo anterior fica (rollback)" \
   "$(printf '%s' "$SAIDA_M5" | grep -c 'não ficou com o corpo deste arquivo') $(md5_vivo)" "1 78d9e58f73c7fb3a902f864a2e131993"
P -q -f "$MIG_USADA" > /dev/null

# M1 idempotente
eq "M1 re-aplica" "$(estado "$(cat "$MIG_USADA")")" "verde"
# M2 ACL
eq "M2 anon fechado, PUBLIC fechado, authenticated aberto" \
   "$(Pq -c "SELECT concat_ws(' ', has_function_privilege('anon', 'public.venda_painel(date,date)', 'EXECUTE'),
                    has_function_privilege('public', 'public.venda_painel(date,date)', 'EXECUTE'),
                    has_function_privilege('authenticated', 'public.venda_painel(date,date)', 'EXECUTE'))")" "f f t"
# M4 o validar pós-apply dá 4 ✅ contra a migration real (antes do M3, que troca o corpo)
eq "M4 validar-venda-painel-heranca: 4 linhas, todas OK" \
   "$(P -qAt -F '|' -f "$REPO_ROOT/db/validar-venda-painel-heranca.sql" | awk -F'|' '$2 == "✅" { n++ } END { print n+0 }')" "4"
# M3 a PRE recusa corpo alheio: troca o corpo vivo por um terceiro e re-aplica
P -q -c "CREATE OR REPLACE FUNCTION public.venda_painel(p_de date, p_ate date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
         SET search_path TO 'public', 'pg_temp' AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;" > /dev/null
SAIDA_M3="$(P -q -f "$MIG_USADA" 2>&1 || true)"
eq "M3 a PRE recusa corpo alheio" "$(printf '%s' "$SAIDA_M3" | grep -c 'PRE FALHOU: public.venda_painel vivo')" "1"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-painel-heranca"
