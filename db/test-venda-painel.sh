#!/usr/bin/env bash
# Prova PG17 do PAINEL DO FOUNDER do programa Venda por cliente — migration 20261020235000_venda_cliente_painel:
# `venda_painel(p_de, p_ate)` (master, só leitura) — adoção por farmer × semana, conversão de recompra
# ativa × linha de base (histórico da mesma semana do ano anterior e sombra) e estado das ondas.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T1  farmer → 42501; sem sessão → 42501; master → lê
#  T2  período invertido ou > 400 dias → 22023
#  T3  contagens da semana: na_lista/mostradas/contatados/compraram por COMPRADOR; contato de outra semana não conta
#  T3b taxa = virou / (virou + nao_virou): nao_medivel e pendentes FORA do denominador
#  T3c desfecho de complemento não entra na taxa de recompra
#  T4  ausente ≠ zero: farmer sem lista → taxa NULL e receita NULL (nunca 0)
#  T5  base histórica = mesma semana 52 semanas antes (a semana vizinha não conta)
#  T6  base_confiavel só com venda_onda_log da onda_recompra (config ligada à mão ≠ conferida)
#  T7  repasse (Task 6) ausente → repasse_vigente NULL ("não sei") e repasse_disponivel false
#  T8  pré-requisitos da Onda 1: dias de histórico e sombra ao vivo nos 3 dias anteriores
#  T9  o JSON não tem chave de custo (cmc/custo/markup/piso)
#
#   bash db/test-venda-painel.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-painel.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-painel.sh             # tem de ficar VERMELHA
#   bash db/test-venda-painel.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020235000_venda_cliente_painel.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="gate_aberto:T1 taxa_com_medivel:T3b complemento_na_taxa:T3c receita_zero:T4 hist_semana_errada:T5 base_sem_log:T6 contato_fora_da_semana:T3 acl_aberta:POST!P2_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-painel.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-painel" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [$marca]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5498}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-painel.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  gate_aberto)         sabotar "IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN" "IF v_uid IS NULL THEN" ;;
  taxa_com_medivel)    sabotar "'taxa_ativa',       round(a.virou::numeric / NULLIF(a.virou + a.nao_virou, 0), 4)" \
                               "'taxa_ativa',       round(a.virou::numeric / NULLIF(a.virou + a.nao_virou + a.nao_medivel, 0), 4)" ;;
  complemento_na_taxa) sabotar "count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_virou')    AS nao_virou," \
                               "count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou," ;;
  receita_zero)        sabotar "'receita_realizada', a.receita," "'receita_realizada', COALESCE(a.receita, 0)," ;;
  hist_semana_errada)  sabotar "date_trunc('week', s.dia_referencia)::date + 364 AS semana" "date_trunc('week', s.dia_referencia)::date + 357 AS semana" ;;
  base_sem_log)        sabotar "v_base_confiavel := EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_recompra');" "v_base_confiavel := v_cfg_on1;" ;;
  contato_fora_da_semana) sabotar "                      AND c.dia >= l.semana AND c.dia < l.semana + 7)" "                      )" ;;
  acl_aberta)          sabotar "REVOKE ALL ON FUNCTION public.venda_painel(date, date) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.venda_painel(date, date) FROM PUBLIC;" ;;
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
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; M=00000000-0000-0000-0000-0000000000ee
C1=00000000-0000-0000-0000-0000000000c1; C2=00000000-0000-0000-0000-0000000000c2; C3=00000000-0000-0000-0000-0000000000c3
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
  sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz);

INSERT INTO public.venda_config VALUES
  ('onda_recompra','false'), ('onda_complemento','false'), ('onda_preco','false'),
  ('teto_maiores_atrasos','10'), ('janela_dias','{"recompra":14,"complemento":30,"preco":30}');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee'), ('$F2','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$F1','farmer'), ('$F2','farmer'), ('$M','master');
INSERT INTO public.profiles (user_id, name) VALUES ('$F1','Regina'), ('$F2','Tatyana'), ('$M','Lucas');
SQL

# ── Apply (postcondição DO \$post\$ roda aqui) ────────────────────────────────────────────────────
P -q -f "$MIG_USADA"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# Semana W (segunda) 3 semanas atrás; a mesma semana do ano anterior é W − 364.
W="$(Pq -c "SELECT date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 21)::date")"
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"

P -q <<SQL
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, familia,
                                   mostrada_em, desfecho, valor_realizado) VALUES
 -- F1 na semana W: C1 com 2 SKUs (virou R\$ 300 e nao_virou), C2 mostrado e nao_medivel, C3 pendente
 ('recompra',   'ativa',    '$W'::date,     '$F1','$C1','oben',   111, NULL,       NULL,  'virou_pedido', 300),
 ('recompra',   'ativa',    '$W'::date,     '$F1','$C1','oben',   222, NULL,       NULL,  'nao_virou',    NULL),
 ('recompra',   'ativa',    '$W'::date + 1, '$F1','$C2','colacor',111, NULL,       now(), 'nao_medivel',  NULL),
 ('recompra',   'ativa',    '$W'::date + 2, '$F1','$C3','oben',   333, NULL,       NULL,  NULL,           NULL),
 -- complemento com desfecho: conta na lista, NÃO na taxa de recompra
 ('complemento','ativa',    '$W'::date,     '$F1','$C1','oben',   NULL,'Seladora', NULL,  'nao_virou',    NULL),
 -- base histórica de F1: mesma semana do ano anterior 1 virou + 3 nao_virou (25%) e 1 nao_medivel
 ('recompra',   'historico','$W'::date - 364,'$F1','$C1','oben',  111, NULL,       NULL,  'virou_pedido', 10),
 ('recompra',   'historico','$W'::date - 364,'$F1','$C2','oben',  111, NULL,       NULL,  'nao_virou',    NULL),
 ('recompra',   'historico','$W'::date - 363,'$F1','$C3','oben',  111, NULL,       NULL,  'nao_virou',    NULL),
 ('recompra',   'historico','$W'::date - 362,'$F1','$C3','oben',  222, NULL,       NULL,  'nao_virou',    NULL),
 ('recompra',   'historico','$W'::date - 361,'$F1','$C3','oben',  333, NULL,       NULL,  'nao_medivel',  NULL),
 -- semana VIZINHA do ano anterior (W − 357): tem de ficar fora da base de W
 ('recompra',   'historico','$W'::date - 357,'$F1','$C1','oben',  111, NULL,       NULL,  'virou_pedido', 10),
 ('recompra',   'historico','$W'::date - 357,'$F1','$C2','oben',  111, NULL,       NULL,  'virou_pedido', 10),
 -- sombra de F1 (qualquer semana): 1 virou + 1 nao_virou = 50%
 ('recompra',   'sombra',   '$W'::date + 7, '$F1','$C1','oben',   111, NULL,       NULL,  'virou_pedido', 5),
 ('recompra',   'sombra',   '$W'::date + 8, '$F1','$C2','oben',   111, NULL,       NULL,  'nao_virou',    NULL);
-- contatos: C1 na semana W (conta); C2 só na semana seguinte (não conta em W)
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado) VALUES
 ('$F1','$C1','$W'::date + 3, 'vai_pedir'),
 ('$F1','$C2','$W'::date + 8, 'nao_atendeu');
-- pré-requisitos da Onda 1: 2 dias de histórico; sombra ao vivo ontem; anteontem gravada em OUTRO dia (não conta)
INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, primeira_em) VALUES
 ('$HOJE'::date - 400, 'historico', now()),
 ('$HOJE'::date - 399, 'historico', now()),
 ('$HOJE'::date - 1,   'sombra',    ('$HOJE'::date - 1 + time '09:00') AT TIME ZONE 'America/Sao_Paulo'),
 ('$HOJE'::date - 2,   'sombra',    ('$HOJE'::date + time '09:00') AT TIME ZONE 'America/Sao_Paulo');
SQL

painel() { # $1 = jq-like caminho em SQL sobre o resultado (variável j)
  Pq -c "$(como "$M" "SELECT $1 FROM (SELECT public.venda_painel('$W'::date, '$W'::date + 6) AS j) x;")"
}
linha() { # $1 = farmer, $2 = expressão sobre a linha r
  Pq -c "$(como "$M" "SELECT $2 FROM (SELECT public.venda_painel('$W'::date, '$W'::date + 6) AS j) x,
                       jsonb_array_elements(x.j->'linhas') r WHERE r->>'farmer_user_id' = '$1' AND r->>'semana' = '$W';")"
}

# T1 gate
eq "T1 farmer -> 42501"      "$(estado "$(como "$F1" "SELECT public.venda_painel('$W'::date, '$W'::date + 6);")")" "42501"
eq "T1 sem sessao -> 42501"  "$(estado "$(como "" "SELECT public.venda_painel('$W'::date, '$W'::date + 6);")")" "42501"
eq "T1 master le"            "$(painel "jsonb_array_length(j->'linhas')")" "2"

# T2 período
eq "T2 periodo invertido -> 22023" "$(estado "$(como "$M" "SELECT public.venda_painel('$W'::date + 6, '$W'::date);")")" "22023"
eq "T2 periodo > 400 dias -> 22023" "$(estado "$(como "$M" "SELECT public.venda_painel('$W'::date - 401, '$W'::date);")")" "22023"

# T3 contagens por comprador
eq "T3 na_lista/mostradas/contatados/compraram de F1 em W" \
   "$(linha "$F1" "concat_ws(' ', r->>'na_lista', r->>'mostradas', r->>'contatados', r->>'compraram')")" "3 1 1 1"
eq "T3b virou/nao_virou/nao_medivel/pendentes e taxa = 1/(1+1)" \
   "$(linha "$F1" "concat_ws(' ', r->>'virou', r->>'nao_virou', r->>'nao_medivel', r->>'pendentes', r->>'taxa_ativa')")" "1 1 1 1 0.5000"
eq "T3c complemento fora da taxa de recompra (nao_virou = 1)" "$(linha "$F1" "r->>'nao_virou'")" "1"
eq "T3d receita realizada = soma das vendas casadas" "$(linha "$F1" "r->>'receita_realizada'")" "300"

# T4 ausente ≠ zero
eq "T4 farmer sem lista: na_lista 0, taxa NULL, receita NULL (JSON null)" \
   "$(linha "$F2" "concat_ws(' ', r->>'na_lista', jsonb_typeof(r->'taxa_ativa'), jsonb_typeof(r->'receita_realizada'))")" "0 null null"

# T5 base histórica
eq "T5 base historico mesma semana = 1/(1+3), nao_medivel 1, semana vizinha fora" \
   "$(linha "$F1" "concat_ws(' ', r->>'taxa_base_historico_mesma_semana', r->'base_historico'->>'nao_medivel', r->'base_historico'->>'virou')")" "0.2500 1 1"
eq "T5b base sombra = 1/(1+1)" "$(linha "$F1" "r->>'taxa_base_sombra'")" "0.5000"

# T6 base_confiavel
eq "T6 sem log: base nao confiavel" "$(painel "j->>'base_confiavel'")" "false"
Pq -c "UPDATE public.venda_config SET valor = 'true' WHERE chave = 'onda_recompra';" >/dev/null
eq "T6 config ligada a mao sem log: continua nao confiavel" "$(painel "j->>'base_confiavel'")" "false"
Pq -c "INSERT INTO public.venda_onda_log (onda, condicao) VALUES ('onda_recompra', '{\"historico_dias\":365}');" >/dev/null
eq "T6 com log da onda_recompra: confiavel (e na linha)" \
   "$(painel "j->>'base_confiavel'") $(linha "$F1" "r->>'base_confiavel'")" "true true"
eq "T6b onda_recompra ligada com data e condicao do log" \
   "$(painel "concat_ws(' ', j->'ondas'->'onda_recompra'->>'ligada', CASE WHEN (j->'ondas'->'onda_recompra'->>'ligada_em') IS NOT NULL THEN 'true' ELSE 'false' END, j->'ondas'->'onda_recompra'->'condicao_ao_ligar'->>'historico_dias')")" "true true 365"

# T7 repasse ausente
eq "T7 sem tabela de repasse: repasse_vigente null e repasse_disponivel false" \
   "$(painel "concat_ws(' ', jsonb_typeof(j->'ondas'->'onda_preco'->'prerequisitos'->'repasse_vigente'), j->>'repasse_disponivel')")" "null false"

# T8 pré-requisitos da Onda 1
eq "T8 historico_dias 2; sombra ao vivo: ontem sim, anteontem nao (gravada em outro dia), d-3 nao; hoje nao avaliado" \
   "$(painel "concat_ws(' ', j->'ondas'->'onda_recompra'->'prerequisitos'->>'historico_dias',
              (SELECT string_agg(e->>'ao_vivo', ',' ORDER BY e->>'dia' DESC) FROM jsonb_array_elements(j->'ondas'->'onda_recompra'->'prerequisitos'->'sombra_ao_vivo') e),
              j->'ondas'->'onda_recompra'->'prerequisitos'->>'avaliada_hoje')")" "2 true,false,false false"

# T9 sem chave de custo em nenhum nível
T9_SQL="WITH RECURSIVE t(v) AS (
  SELECT public.venda_painel('$W'::date, '$W'::date + 6)
  UNION ALL
  SELECT e.value FROM t, LATERAL (
    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}' END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v) = 'array' THEN t.v ELSE '[]' END)) e)
SELECT count(*) FROM t, jsonb_object_keys(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}' END) k
 WHERE k ~ '(cmc|custo|markup|piso)';"
eq "T9 nenhuma chave de custo no JSON (recursivo)" "$(Pq -c "$(como "$M" "$T9_SQL")")" "0"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-painel"
