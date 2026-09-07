#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — REVOKE de `anon` em duas RPCs de reposição                           ║
# ║  Migration: 20260907095338_authz_revoke_anon_rpc_reposicao.sql                ║
# ║                                                                               ║
# ║      bash db/test-authz-revoke-anon-rpc.sh > /tmp/t.log 2>&1; echo $?         ║
# ║  (NAO pipe pra tail — engole o exit!=0.)                                      ║
# ║  Dois locales (licao #1483):                                                  ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-authz-revoke-anon-rpc.sh             ║
# ║                                                                               ║
# ║  Grupos, e por que cada um existe:                                            ║
# ║   B  BASELINE DO BUG — com o fecho VELHO (só `FROM PUBLIC`), `anon` executa e  ║
# ║                    APROVA o pedido de verdade. Sem B, o verde de P nao prova   ║
# ║                    nada: poderia ser `anon` nunca ter tido acesso neste PG.    ║
# ║   P  positivos   — depois da migration, `anon` leva 42501 nas duas.            ║
# ║   C  contrato    — `authenticated` CONTINUA executando (nao quebrei a UI).     ║
# ║   D  dependentes — a SECDEF que CHAMA a pura continua chamando (o REVOKE de    ║
# ║                    PUBLIC nao quebra quem executa como OWNER).                 ║
# ║   X  o ACHADO    — `REVOKE … FROM anon` SOZINHO NAO fecha a 2a funcao, porque  ║
# ║                    la o EXECUTE vem de PUBLIC e todo role herda de PUBLIC.     ║
# ║   F  falsificacao — controle verde primeiro, na MESMA invocacao; depois sabota ║
# ║                    UMA camada por vez e exige vermelho.                        ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260907095338_authz_revoke_anon_rpc_reposicao.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="revoke-anon-rpc"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIGRATION" ] || { echo "INFRA: migration ausente em $MIGRATION"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }

P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ════════════════════════════════════════════════════════════════════════════
# ZONA 1 — o ambiente que reproduz o VETOR
#
# ⚠️ A linha do ALTER DEFAULT PRIVILEGES e a que faz este teste medir algo. E o
# default privilege do Supabase em `public`: sem ela, funcao nova nasceria SEM
# EXECUTE para anon, o baseline B seria verde por AUSENCIA DO VETOR e todo o
# resto do harness aprovaria qualquer migration, inclusive uma vazia.
# ════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION private.cap_compras_ler(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT COALESCE(nullif(current_setting('test.cap', true), '')::boolean, false) $f$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.pedido_compra_sugerido (
  id           bigint PRIMARY KEY,
  status       text NOT NULL DEFAULT 'pendente_aprovacao',
  aprovado_por text
);
SQL

# `montar_estado` recria as DUAS funcoes no estado PRE-migration (o defeituoso).
# E funcao de shell, e nao SQL solto, porque cada falsificacao precisa reaplicar
# a migration sobre um estado LIMPO — senao o REVOKE de uma rodada anterior
# sobreviveria e a sabotagem mediria um banco ja fechado (verde por inercia).
TMPD="$(dirname "$DATA")"   # ja removido pelo trap; mktemp BSD nao aceita sufixo pos-XXXXXX
MONTAR="$TMPD/montar.sql"
cat > "$MONTAR" <<'SQL'
DROP FUNCTION IF EXISTS public.aprovar_pedido_sugerido(bigint, text, jsonb);
DROP FUNCTION IF EXISTS public.reposicao_pedido_e_portal(text, text);
DROP FUNCTION IF EXISTS public.reposicao_selar_pedido(bigint);
TRUNCATE public.pedido_compra_sugerido;
INSERT INTO public.pedido_compra_sugerido (id, status) VALUES (1, 'pendente_aprovacao');

-- Fiel a 20260906170000: SECDEF, gate fail-OPEN para uid NULL, fecho SO com FROM PUBLIC.
CREATE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text, p_itens_vistos jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  UPDATE public.pedido_compra_sugerido
     SET status = 'aprovado_aguardando_disparo', aprovado_por = p_usuario
   WHERE id = p_pedido_id;
  RETURN jsonb_build_object('status', 'ok');
END $f$;
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text, jsonb) FROM PUBLIC;  -- o fecho INCOMPLETO
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text, jsonb) TO authenticated, service_role;

-- Fiel ao ACL MEDIDO em prod 2026-09-07: anon revogado NOMINALMENTE (a mao), PUBLIC ainda com X.
CREATE FUNCTION public.reposicao_pedido_e_portal(p_empresa text, p_fornecedor_nome text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT p_empresa = 'OBEN' AND p_fornecedor_nome ILIKE '%SAYERLACK%';
$f$;
REVOKE ALL ON FUNCTION public.reposicao_pedido_e_portal(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_e_portal(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_e_portal(text, text) TO authenticated, service_role;

-- Dependente REAL: SECDEF que chama a pura. Prova que revogar PUBLIC nao a quebra.
CREATE FUNCTION public.reposicao_selar_pedido(p_id bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT public.reposicao_pedido_e_portal('OBEN', 'SAYERLACK BRASIL');
$f$;
REVOKE ALL ON FUNCTION public.reposicao_selar_pedido(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_selar_pedido(bigint) TO authenticated, service_role;
SQL

montar_estado() { P -q -f "$MONTAR"; }

# probe: executa como $1 e devolve 'EXECUTOU' ou 'SQLSTATE-<codigo>'
probe() {   # $1 = role, $2 = SQL
  local out
  if out=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -v ON_ERROR_STOP=1 2>&1 <<SQL
\set VERBOSITY verbose
SET ROLE $1;
$2
SELECT 'EXECUTOU';
SQL
  ); then printf '%s\n' "$out" | tail -1
  else echo "SQLSTATE-$(printf '%s\n' "$out" | sed -nE 's/.*[[:space:]]([0-9][0-9A-Z]{4}):.*/\1/p' | head -1)"; fi
}
APROVAR="SELECT public.aprovar_pedido_sugerido(1, 'invasor-anonimo', NULL::jsonb);"
PORTAL="SELECT public.reposicao_pedido_e_portal('OBEN', 'SAYERLACK BRASIL');"
SELAR="SELECT public.reposicao_selar_pedido(1);"
status_pedido() { Pq -c "SELECT status || '|' || COALESCE(aprovado_por, '-') FROM public.pedido_compra_sugerido WHERE id = 1;"; }

# ════════════════════════════════════════════════════════════════════════════
echo "-- grupo B: BASELINE DO BUG (estado do repo HOJE, sem a migration nova) --"
# ════════════════════════════════════════════════════════════════════════════
montar_estado
eq "B1 anon EXECUTA a RPC SECDEF de aprovacao (o P0)"        "$(probe anon "$APROVAR")" 'EXECUTOU'
eq "B2 e o pedido fica REALMENTE aprovado por um anonimo"    "$(status_pedido)" 'aprovado_aguardando_disparo|invasor-anonimo'
eq "B3 anon EXECUTA a pura, herdando de PUBLIC"              "$(probe anon "$PORTAL")" 'EXECUTOU'

# ════════════════════════════════════════════════════════════════════════════
echo "-- grupo X: o ACHADO — 'FROM anon' sozinho NAO fecha a 2a funcao --"
# ════════════════════════════════════════════════════════════════════════════
# Aplica exatamente o que o briefing original pedia para a pura, e SO isso.
montar_estado
P -q -c "REVOKE ALL ON FUNCTION public.reposicao_pedido_e_portal(text, text) FROM anon;" >/dev/null
eq "X1 apos REVOKE FROM anon, o ACL NAO lista anon" \
   "$(Pq -c "SELECT CASE WHEN p.proacl::text LIKE '%anon=X%' THEN 'lista' ELSE 'nao-lista' END FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reposicao_pedido_e_portal';")" \
   'nao-lista'
eq "X2 ...mas anon AINDA EXECUTA (herda de PUBLIC) — o REVOKE foi no-op" \
   "$(probe anon "$PORTAL")" 'EXECUTOU'
# X1+X2 juntos sao a prova de que a varredura por `proacl LIKE '%anon=X%'` e CEGA
# a este caso: ela olha o grant NOMINAL e o herdado de PUBLIC nao aparece la.

# ════════════════════════════════════════════════════════════════════════════
echo "-- grupo P/C/D: a migration nova aplicada (CONTROLE VERDE) --"
# ════════════════════════════════════════════════════════════════════════════
montar_estado
P -q -f "$MIGRATION" >/dev/null
eq "P1 anon NEGADO na RPC SECDEF de aprovacao"   "$(probe anon "$APROVAR")" 'SQLSTATE-42501'
eq "P2 o pedido segue PENDENTE (anon nao mexeu)" "$(status_pedido)" 'pendente_aprovacao|-'
eq "P3 anon NEGADO na pura"                      "$(probe anon "$PORTAL")" 'SQLSTATE-42501'
eq "C1 authenticated CONTINUA executando a pura" "$(probe authenticated "$PORTAL")" 'EXECUTOU'
eq "C2 service_role CONTINUA executando a pura"  "$(probe service_role "$PORTAL")" 'EXECUTOU'
eq "D1 a SECDEF dependente continua chamando a pura (executa como OWNER)" \
   "$(probe authenticated "$SELAR")" 'EXECUTOU'
# C3/C3b: `authenticated` alcanca a de aprovacao DE PROPOSITO (e o botao do
# comprador logado) e quem barra ali e o GATE `cap_compras_ler`, nao o ACL.
# So o par separa as duas causas: se C3 medisse sozinho, um 42501 vindo de um
# REVOKE excessivo meu passaria por "gate funcionando" e eu teria quebrado a UI
# sem o teste acusar. `SET` e nao `SET LOCAL` — fora de bloco de transacao o
# LOCAL nao pega, `auth.uid()` volta NULL e o gate (fail-open no uid NULL) nem
# dispara: foi exatamente esse o falso-vermelho da 1a rodada deste harness.
UID_TESTE="SET test.uid = '11111111-1111-1111-1111-111111111111';"
eq "C3 authenticated logado SEM a capacidade leva 42501 do GATE" \
   "$(probe authenticated "$UID_TESTE SET test.cap = 'false'; $APROVAR")" 'SQLSTATE-42501'
eq "C3b ...e COM a capacidade APROVA — logo o 42501 de C3 e do gate, nao do ACL" \
   "$(probe authenticated "$UID_TESTE SET test.cap = 'true'; $APROVAR")" 'EXECUTOU'
eq "C3c ...e a aprovacao legitima gravou de verdade" \
   "$(status_pedido)" 'aprovado_aguardando_disparo|invasor-anonimo'

# ════════════════════════════════════════════════════════════════════════════
echo "-- grupo F: falsificacao (o controle verde acima rodou nesta MESMA invocacao) --"
# ════════════════════════════════════════════════════════════════════════════
# Sabota UMA camada por vez. A que ficar VERDE e redundante ou inalcancada.
sabotar() {   # $1 = regex sed, $2 = rotulo
  local alvo="$TMPD/sabot-$2.sql"
  sed -E "$1" "$MIGRATION" > "$alvo"
  if cmp -s "$alvo" "$MIGRATION"; then
    bad "F-infra [$2]: o sed NAO alterou a migration (regex nao casou) — sabotagem inerte"
    return 1
  fi
  montar_estado
  # a postcondicao embutida deve ABORTAR o apply; capturamos isso como o vermelho
  if P -q -f "$alvo" >/dev/null 2>&1; then echo "APLICOU"; else echo "ABORTOU"; fi
}

F1="$(sabotar 's/^REVOKE ALL ON FUNCTION public\.aprovar_pedido_sugerido\(bigint, text, jsonb\) FROM anon;$/-- sabotado/' 'aprovar-anon')"
eq "F1 sem o REVOKE da SECDEF, a POSTCONDICAO aborta o apply" "$F1" 'ABORTOU'
eq "F1b ...e sem ela o anon voltaria a aprovar (o vetor segue vivo)" \
   "$(probe anon "$APROVAR")" 'EXECUTOU'

F2="$(sabotar 's/^REVOKE ALL ON FUNCTION public\.reposicao_pedido_e_portal\(text, text\) FROM PUBLIC;$/-- sabotado/' 'portal-public')"
eq "F2 sem o REVOKE de PUBLIC, a POSTCONDICAO aborta o apply" "$F2" 'ABORTOU'
# F2 e o teste que defende o ACHADO: a migration sem o FROM PUBLIC ainda tem o
# FROM anon, e mesmo assim fica vermelha. E a prova de que os dois sao precisos.
eq "F2b ...e o anon segue alcancando a pura por PUBLIC" "$(probe anon "$PORTAL")" 'EXECUTOU'

# F3 sabota a POSTCONDICAO em vez do REVOKE: se ela estivesse decorativa (medindo
# `proacl LIKE`, o predicado CEGO), F2 teria ficado verde. Este caso prova que o
# predicado escolhido e o que da dente a F1/F2.
F3="$(sabotar "s/has_function_privilege\('anon', p\.oid, 'EXECUTE'\)/p.proacl::text LIKE '%anon=X%'/" 'postcondicao-cega')"
eq "F3 com a postcondicao medindo o ACL CEGO, o apply sabotado PASSA" "$F3" 'APLICOU'

echo "=== $PASS OK / $FAIL FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "PROVA-COMPLETA"
