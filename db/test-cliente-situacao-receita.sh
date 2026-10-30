#!/usr/bin/env bash
# Prova PG17 da RPC `cliente_situacao_receita(p_customer_user_id)` — migrations
# 20261029200343_cliente_situacao_receita (1ª, aplicada como em prod) e
# 20261030000642_cliente_situacao_receita_lote_publicado (a VIVA; as sabotagens agem nela, exceto as de
# ACL, que agem na 1ª: CREATE OR REPLACE preserva o ACL, então sabotar o REVOKE da 2ª não muda nada).
# (Frente 5 do Radar: selo da Receita na ficha e no pedido.)
# Executa sob `SET ROLE authenticated` + GUC `test.uid` (o auth.uid() do harness):
#   · escopo = cap_carteira_ler OR carteira_visivel_para — o CORPO REAL do gate de carteira (eligible,
#     cobertura ativa/expirada/inativa) extraído da migration que o define, movido para `private` como
#     em prod; fora dele, 42501 com HINT `fora_da_carteira` (o discriminador que o front casa);
#   · a RLS de gestor de radar_situacao_cadastral continua intacta (SELECT direto do vendedor = 0);
#   · ausente ≠ ativa: sem_dado / sem_cnpj / sem_documento, 1 linha sempre; 01 não vira irregular;
#   · lote: o mais recente PUBLICADO (complete + situacao_aplicada_fechamento = finalizado_em), 04→02
#     tira o selo, lote velho sai confirmado_no_vigente=false, lote em carga não é lido, reprocessamento
#     não conta como publicado antes da aplicação, sem lote publicado → 55000 sem_lote_publicado;
#   · a PRE da 2ª aborta se o corpo vivo não for o da 1ª (md5 de PROD) nem já o dela;
#   · espelho da normalização de radar_docs_clientes() (20261019200000), POR DOCUMENTO.
# Locale: PROVA_LC=C (default) ou PROVA_LC=pt_BR.UTF-8 — asserts casam SQLSTATE e marcadores ASCII.
#
#   bash db/test-cliente-situacao-receita.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-cliente-situacao-receita.sh   # tem de ficar VERMELHA
#   bash db/test-cliente-situacao-receita.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG1="$REPO_ROOT/supabase/migrations/20261029200343_cliente_situacao_receita.sql"
MIG="$REPO_ROOT/supabase/migrations/20261030000642_cliente_situacao_receita_lote_publicado.sql"
MIG_GATE="$REPO_ROOT/supabase/migrations/20260717181500_carteira_visivel_para_filtra_eligible.sql"
MIG_DOCS="$REPO_ROOT/supabase/migrations/20261019200000_radar_situacao_cadastral.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:POSn` = a POSTCONDIÇÃO da migration aborta o apply;
  # `_sem_post` cega essa camada para provar que o assert executado pega sozinho (uma camada por vez).
  SABOTAGENS="gate_aberto:post:POS6 gate_aberto_sem_post:A3 sem_hint:post:POS6 sem_hint_sem_post:A3 \
conta_01_irregular:A9 ausente_vira_ativa:A9b lote_velho_confirmado:A11 le_lote_em_carga:A12 lote_mais_antigo:A10 \
so_digitos:A13 acl_aberta:post:POS4 acl_aberta_sem_post:A8 invoker:post:POS2 invoker_sem_post:A1 \
dono_sem_bypass:post:POS7 dono_sem_bypass_sem_post:A1 sem_vigente_le_tudo:post:POS8 sem_vigente_le_tudo_sem_post:A14 \
reprocesso_publica:post:POS8 reprocesso_publica_sem_post:A15 pre_cega:A16"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-cliente-situacao.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "CLIENTE_SITUACAO_RECEITA_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5493}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-cliente-situacao.XXXXXX")/data"
LC="${PROVA_LC:-C}"
export LC_ALL="$LC" LANG="$LC"
MIG_USADA="$(dirname "$DATA")/mig.sql"
MIG1_USADA="$(dirname "$DATA")/mig1.sql"
FN_GATE="$(dirname "$DATA")/fn-gate.sql"
FN_DOCS="$(dirname "$DATA")/fn-docs.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"; cp "$MIG1" "$MIG1_USADA"
# Corpos VIVOS extraídos das migrations que os definem (só o bloco CREATE … $$;).
awk '/^CREATE OR REPLACE FUNCTION public.carteira_visivel_para\(/{p=1} p{print} p && /^\$\$;$/{exit}' "$MIG_GATE" > "$FN_GATE"
grep -q "a.eligible IS TRUE" "$FN_GATE" || { echo "não extraí carteira_visivel_para de $MIG_GATE"; exit 9; }
awk '/^CREATE OR REPLACE FUNCTION public.radar_docs_clientes\(\)/{p=1} p{print} p && /^\$\$;$/{exit}' "$MIG_DOCS" > "$FN_DOCS"
grep -q "DISTINCT ON (doc)" "$FN_DOCS" || { echo "não extraí radar_docs_clientes de $MIG_DOCS"; exit 9; }

sabotar() { sabotar_em "$MIG_USADA" "$@"; }
sabotar_em() { # $1 = arquivo, $2 = de, $3 = para (literal; substitui TODAS as ocorrências)
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
GATE_DE="  IF NOT (COALESCE(private.cap_carteira_ler(v_uid), false)
          OR COALESCE(private.carteira_visivel_para(p_customer_user_id, v_uid), false)) THEN"
POS6_DE="  IF position('carteira_visivel_para' IN v_def) = 0 OR position('cap_carteira_ler' IN v_def) = 0
     OR position('fora_da_carteira' IN v_def) = 0 THEN"
POS7_DE="     WHERE pr.oid = f AND (ro.rolbypassrls OR ro.rolsuper OR (pr.proowner = c.relowner AND NOT c.relforcerowsecurity))) THEN"
DONO_DE="DO \$pos\$
DECLARE"
DONO_PARA="ALTER TABLE public.radar_situacao_cadastral FORCE ROW LEVEL SECURITY;
ALTER FUNCTION public.cliente_situacao_receita(uuid) OWNER TO dono_app;
DO \$pos\$
DECLARE"
SEMVIG_DE="  IF v_vig IS NULL THEN
    RAISE EXCEPTION 'cliente_situacao_receita: nenhum lote da Receita publicado'
      USING ERRCODE = '55000', HINT = 'sem_lote_publicado';
  END IF;
"
POS8_DE="  IF position('sem_lote_publicado' IN v_def) = 0 OR position('situacao_aplicada_fechamento = i.finalizado_em' IN v_def) = 0 THEN"
REPROC_DE="     AND i.situacao_aplicada_fechamento IS NOT NULL
     AND i.situacao_aplicada_fechamento = i.finalizado_em;"
case "${SABOTAGEM:-}" in
  "") ;;
  gate_aberto)          sabotar "$GATE_DE" "  IF false THEN" ;;
  gate_aberto_sem_post) sabotar "$GATE_DE" "  IF false THEN"; sabotar "$POS6_DE" "  IF false THEN" ;;
  sem_hint)             sabotar ", HINT = 'fora_da_carteira'" "" ;;
  sem_hint_sem_post)    sabotar ", HINT = 'fora_da_carteira'" ""; sabotar "$POS6_DE" "  IF false THEN" ;;
  conta_01_irregular)   sabotar "WHEN r.situacao IN ('03', '04', '08')" "WHEN r.situacao IN ('01', '03', '04', '08')" ;;
  ausente_vira_ativa)   sabotar "'sem_dado'::text" "'ativa'::text" ;;
  lote_velho_confirmado) sabotar "COALESCE(r.lote = v_vig, false)" "true" ;;
  le_lote_em_carga)     sabotar "     AND s.lote <= v_vig   -- só lote PUBLICADO" "     -- só lote PUBLICADO" ;;
  lote_mais_antigo)     sabotar "ORDER BY s.lote DESC, s.cnpj" "ORDER BY s.lote ASC, s.cnpj" ;;
  so_digitos)           sabotar "       WHERE v_d ~ '^[0-9A-Z]{12}[0-9]{2}\$'" "       WHERE false AND v_d ~ '^[0-9A-Z]{12}[0-9]{2}\$'" ;;
  acl_aberta)           sabotar_em "$MIG1_USADA" "REVOKE ALL ON FUNCTION public.cliente_situacao_receita(uuid) FROM anon;" "" ;;
  acl_aberta_sem_post)  for m in "$MIG1_USADA" "$MIG_USADA"; do
                          sabotar_em "$m" "REVOKE ALL ON FUNCTION public.cliente_situacao_receita(uuid) FROM anon;" ""
                          sabotar_em "$m" "  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE') THEN" "  IF false THEN"
                        done ;;
  invoker)              sabotar "STABLE SECURITY DEFINER" "STABLE SECURITY INVOKER" ;;
  invoker_sem_post)     sabotar "STABLE SECURITY DEFINER" "STABLE SECURITY INVOKER"
                        sabotar "  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN" "  IF false THEN" ;;
  dono_sem_bypass)      sabotar "$DONO_DE" "$DONO_PARA" ;;
  dono_sem_bypass_sem_post) sabotar "$DONO_DE" "$DONO_PARA"; sabotar "$POS7_DE" "     WHERE true) THEN" ;;
  sem_vigente_le_tudo)  sabotar "$SEMVIG_DE" "" ; sabotar "     AND s.lote <= v_vig   -- só" "     AND (v_vig IS NULL OR s.lote <= v_vig)   -- só" ;;
  sem_vigente_le_tudo_sem_post) sabotar "$SEMVIG_DE" "" ; sabotar "     AND s.lote <= v_vig   -- só" "     AND (v_vig IS NULL OR s.lote <= v_vig)   -- só"
                        sabotar "$POS8_DE" "  IF false THEN" ;;
  reprocesso_publica)   sabotar "$REPROC_DE" "     AND i.situacao_aplicada_em IS NOT NULL;" ;;
  reprocesso_publica_sem_post) sabotar "$REPROC_DE" "     AND i.situacao_aplicada_em IS NOT NULL;"; sabotar "$POS8_DE" "  IF false THEN" ;;
  pre_cega)             sabotar "  IF v_src IS NULL OR md5(v_src) NOT IN (" "  IF false AND md5(v_src) NOT IN (" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
echo "locale do cluster: $(Pq -c 'SHOW lc_messages;')"

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
-- Dono "de app" SEM bypass — só a sabotagem dono_sem_bypass passa a função para ele.
CREATE ROLE dono_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, dono_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, dono_app;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO dono_app;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.test_roles (uid uuid, role public.app_role);
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE FUNCTION public.has_role(p uuid, r public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_roles WHERE uid = p AND role = r) $$;
CREATE FUNCTION private.cap_carteira_ler(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
CREATE FUNCTION private.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
CREATE TABLE public.carteira_assignments (customer_user_id uuid, owner_user_id uuid, eligible boolean);
CREATE TABLE public.carteira_coverage (covered_user_id uuid, covering_user_id uuid, active boolean, valid_until timestamptz);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text, name text, razao_social text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text, razao_social text, nome_fantasia text);
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text, finalizado_em timestamptz,
  situacao_aplicada_em timestamptz, situacao_aplicada_fechamento timestamptz);
-- Mesmas colunas, PK e RLS de prod (20261019200000): leitura só gestor.
CREATE TABLE public.radar_situacao_cadastral (
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  lote text NOT NULL CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  situacao text NOT NULL CHECK (situacao IN ('01','02','03','04','08')),
  data_situacao date, motivo_codigo text, motivo_descricao text,
  observado_em timestamptz NOT NULL DEFAULT now(), alertado_em timestamptz,
  PRIMARY KEY (cnpj, lote));
ALTER TABLE public.radar_situacao_cadastral ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_situacao_cadastral_select_gestor ON public.radar_situacao_cadastral
  FOR SELECT TO authenticated USING (private.pode_ver_carteira_completa((SELECT auth.uid())));
ALTER TABLE public.radar_situacao_cadastral OWNER TO dono_app;
GRANT SELECT ON public.profiles, public.radar_ingest_state, public.carteira_assignments, public.carteira_coverage,
  public.test_roles, public.test_gestores TO dono_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO dono_app;
GRANT CREATE ON SCHEMA public TO dono_app;
SQL
P -q -f "$FN_GATE" >/dev/null
Pq -c "ALTER FUNCTION public.carteira_visivel_para(uuid, uuid) SET SCHEMA private; GRANT EXECUTE ON FUNCTION private.carteira_visivel_para(uuid, uuid) TO dono_app;" >/dev/null
P -q -f "$FN_DOCS" >/dev/null

P -q -f "$MIG1_USADA" >/dev/null   # a 1ª, como foi aplicada em prod (#764)
echo "md5 do corpo da 1ª no harness: $(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.cliente_situacao_receita(uuid)'::regprocedure;")"
P -q -f "$MIG_USADA" >/dev/null
# Idempotência é propriedade do arquivo REAL: só no controle (um corpo sabotado não é "nem a 1ª nem este" e
# a PRE da 2ª passada o recusaria antes de qualquer assert).
[ -z "${SABOTAGEM:-}" ] && P -q -f "$MIG_USADA" >/dev/null

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

VEND="aaaaaaaa-0000-4000-8000-000000000001"; COBRE="aaaaaaaa-0000-4000-8000-000000000002"
EXPIR="aaaaaaaa-0000-4000-8000-000000000003"; INATIVO="aaaaaaaa-0000-4000-8000-000000000004"
GESTOR="aaaaaaaa-0000-4000-8000-000000000005"; OUTRO="aaaaaaaa-0000-4000-8000-000000000006"
c() { printf 'cccccccc-0000-4000-8000-%012d' "$1"; }   # user_id de cliente n
# Clientes: 1 irregular 04 confirmado · 2 ativa · 3 nula 01 · 4 sem linha · 5 CPF · 6 sem profile · 7 doc vazio
#           8 alfanumérico com máscara 03 · 9 04→02 · 10 irregular só em lote velho · 11 eligible=false · 12 de outro dono
Pq -c "INSERT INTO public.radar_ingest_state VALUES
  ('2026-09','complete','2026-10-21 17:10+00','2026-10-21 17:10+00','2026-10-21 17:10+00'),
  ('2026-10','complete','2026-10-27 16:38+00','2026-10-28 06:05+00','2026-10-27 16:38+00'),
  ('2026-11','running',NULL,NULL,NULL);
INSERT INTO public.profiles (user_id, document) VALUES
  ('$(c 1)','11.111.111/0001-91'), ('$(c 2)','22222222000192'), ('$(c 3)','33.333.333/0001-93'),
  ('$(c 4)','44444444000194'), ('$(c 5)','123.456.789-09'), ('$(c 7)','  '),
  ('$(c 8)','12.ABC.345/01DE-35'), ('$(c 9)','99999999000199'), ('$(c 10)','10101010000110'),
  ('$(c 11)','11111111000191'), ('$(c 12)','11111111000191');
INSERT INTO public.carteira_assignments
  SELECT ('cccccccc-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '$VEND'::uuid, true FROM generate_series(1,10) g;
INSERT INTO public.carteira_assignments VALUES ('$(c 11)','$VEND',false), ('$(c 12)','$OUTRO',true);
INSERT INTO public.carteira_coverage VALUES
  ('$VEND','$COBRE',true,NULL), ('$VEND','$EXPIR',true,'2020-01-01+00'), ('$VEND','$INATIVO',false,NULL);
INSERT INTO public.test_gestores VALUES ('$GESTOR');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao) VALUES
  ('11111111000191','2026-09','04','2025-12-31','63','OMISSAO DE DECLARACOES'),
  ('11111111000191','2026-10','04','2025-12-31','63','OMISSAO DE DECLARACOES'),
  ('11111111000191','2026-11','02','2026-11-02','00','SEM MOTIVO'),
  ('22222222000192','2026-10','02','2010-01-01','00','SEM MOTIVO'),
  ('33333333000193','2026-10','01','2019-07-07','00','NULO'),
  ('12ABC34501DE35','2026-10','03','2026-05-20',NULL,NULL),
  ('99999999000199','2026-09','04','2025-01-01','63','OMISSAO DE DECLARACOES'),
  ('99999999000199','2026-10','02','2026-10-01','00','SEM MOTIVO'),
  ('10101010000110','2026-09','08','2026-08-01','01','EXTINCAO');" >/dev/null

# Chamada como authenticated com GUC; saída verbose (SQLSTATE e HINT/DICA no texto, casados em ASCII).
como() { # $1 = uid ('' = sem identidade), $2 = SQL; imprime a saída e devolve o rc do psql
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qAt -p "$PORT" -h /tmp -U postgres -d postgres \
    -c "SELECT pg_catalog.set_config('test.uid','$1',false);" -c "SET ROLE authenticated;" -c "$2" 2>&1 | sed '1{/^$/d;}'
  return "${PIPESTATUS[0]}"
}
linha() { # estado|cnpj|situacao|data|lote|vigente|confirmado como $1 para o cliente $2
  como "$1" "SELECT estado||'|'||coalesce(cnpj,'-')||'|'||coalesce(situacao,'-')||'|'||coalesce(data_situacao::text,'-')||'|'||coalesce(lote,'-')||'|'||coalesce(lote_vigente,'-')||'|'||confirmado_no_vigente::text FROM public.cliente_situacao_receita('$2');" | tail -1
}
recusa() { # veredito de uma chamada que deveria ser negada: rc + SQLSTATE + discriminador
  local out rc
  if out="$(como "$1" "SELECT * FROM public.cliente_situacao_receita('$2');")"; then rc="verde"; else rc="vermelho"; fi
  local st="outro"; case "$out" in *"42501"*) st="42501";; esac
  local h="sem-hint"; case "$out" in *"fora_da_carteira"*) h="fora_da_carteira";; esac
  echo "$rc $st $h"
}

anon_exec() { # anon chamando a RPC: tem de ser negado com 42501
  local out
  if out="$("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qAt -p "$PORT" -h /tmp -U postgres -d postgres \
    -c "SET ROLE anon;" -c "SELECT * FROM public.cliente_situacao_receita('$(c 1)');" 2>&1)"; then echo verde; return; fi
  case "$out" in *42501*) echo 42501 ;; *) echo outro ;; esac
}

# ── Escopo: vendedor da carteira lê; a RLS de gestor fica intacta ────────────────────────────────
eq "A1 vendedor (dono elegível) lê o irregular 04 do cliente pela RPC, confirmado no lote vigente 2026-10" \
   "$(linha "$VEND" "$(c 1)")" "irregular|11111111000191|04|2025-12-31|2026-10|2026-10|true"
eq "A2 o mesmo vendedor NÃO lê radar_situacao_cadastral direto (policy de gestor intacta); gestor lê" \
   "$(como "$VEND" "SELECT count(*) FROM public.radar_situacao_cadastral;" | tail -1) $(como "$GESTOR" "SELECT count(*) FROM public.radar_situacao_cadastral;" | tail -1)" \
   "0 9"
eq "A3 cliente de OUTRO dono e user_id inexistente: 42501 com HINT fora_da_carteira, indistinguíveis" \
   "$(recusa "$VEND" "$(c 12)") / $(recusa "$VEND" "cccccccc-0000-4000-8000-999999999999")" \
   "vermelho 42501 fora_da_carteira / vermelho 42501 fora_da_carteira"
eq "A4 atribuição eligible=false não dá acesso" "$(recusa "$VEND" "$(c 11)")" "vermelho 42501 fora_da_carteira"
eq "A5 cobertura ativa lê; cobertura expirada e inativa são recusadas" \
   "$(linha "$COBRE" "$(c 1)" | cut -d'|' -f1) / $(recusa "$EXPIR" "$(c 1)") / $(recusa "$INATIVO" "$(c 1)")" \
   "irregular / vermelho 42501 fora_da_carteira / vermelho 42501 fora_da_carteira"
eq "A6 gestor (cap_carteira_ler) lê cliente de qualquer carteira" "$(linha "$GESTOR" "$(c 12)" | cut -d'|' -f1-3)" "irregular|11111111000191|04"
eq "A7 sem identidade: 42501 SEM o discriminador (não é recusa de carteira)" "$(recusa "" "$(c 1)")" "vermelho 42501 sem-hint"
eq "A8 ACL: anon e PUBLIC sem EXECUTE; authenticated e service_role com; anon executando é negado (42501)" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.cliente_situacao_receita(uuid)','EXECUTE')::text||has_function_privilege('public','public.cliente_situacao_receita(uuid)','EXECUTE')::text||has_function_privilege('authenticated','public.cliente_situacao_receita(uuid)','EXECUTE')::text||has_function_privilege('service_role','public.cliente_situacao_receita(uuid)','EXECUTE')::text;") $(anon_exec)" \
   "falsefalsetruetrue 42501"

# ── Estados: ausente ≠ ativa, sempre 1 linha ─────────────────────────────────────────────────────
eq "A9 02 → ativa; 01 → outra (situacao '01' preservada, nunca irregular); alfanumérico com máscara 03 → irregular" \
   "$(linha "$VEND" "$(c 2)" | cut -d'|' -f1,3) $(linha "$VEND" "$(c 3)" | cut -d'|' -f1,3) $(linha "$VEND" "$(c 8)" | cut -d'|' -f1-3)" \
   "ativa|02 outra|01 irregular|12ABC34501DE35|03"
eq "A9b ausências nomeadas: CNPJ sem linha → sem_dado (com o cnpj) · CPF → sem_cnpj · sem profile e doc em branco → sem_documento" \
   "$(linha "$VEND" "$(c 4)" | cut -d'|' -f1,2,7) $(linha "$VEND" "$(c 5)" | cut -d'|' -f1,2) $(linha "$VEND" "$(c 6)" | cut -d'|' -f1) $(linha "$VEND" "$(c 7)" | cut -d'|' -f1)" \
   "sem_dado|44444444000194|false sem_cnpj|- sem_documento sem_documento"
eq "A9c exatamente 1 linha em cada estado" \
   "$(for n in 1 2 3 4 5 6 7 8 9 10; do como "$VEND" "SELECT count(*) FROM public.cliente_situacao_receita('$(c "$n")');" | tail -1; done | tr '\n' ' ')" \
   "1 1 1 1 1 1 1 1 1 1 "

# ── Lote: o mais recente PUBLICADO decide ────────────────────────────────────────────────────────
eq "A10 04 em 2026-09 e 02 em 2026-10 → ativa (o registro mais recente tira o selo; sem busca retroativa)" \
   "$(linha "$VEND" "$(c 9)" | cut -d'|' -f1,3,5)" "ativa|02|2026-10"
eq "A11 irregular só no lote velho → irregular rotulado 2026-09 com confirmado_no_vigente=false" \
   "$(linha "$VEND" "$(c 10)")" "irregular|10101010000110|08|2026-08-01|2026-09|2026-10|false"
eq "A12 lote 2026-11 em carga (não publicado) não é lido: cliente 1 segue 04/2026-10 apesar do 02 de 2026-11" \
   "$(linha "$VEND" "$(c 1)" | cut -d'|' -f1,3,5)" "irregular|04|2026-10"

# ── Publicação: reprocessamento e ausência de lote publicado ─────────────────────────────────────
# Reprocessar 2026-10: o finalize novo troca finalizado_em e PRESERVA situacao_aplicada_em; a chave de
# fechamento ainda é a antiga → 2026-10 não está publicado até a situação nova ser aplicada.
Pq -c "UPDATE public.radar_ingest_state SET finalizado_em = '2026-10-30 09:00+00' WHERE mes_referencia = '2026-10';" >/dev/null
eq "A15 reprocessamento de 2026-10 ainda não aplicado: vigente cai para 2026-09 e o cliente 1 sai 04/2026-09 confirmado nele" \
   "$(linha "$VEND" "$(c 1)" | cut -d'|' -f1,3,5,6,7)" "irregular|04|2026-09|2026-09|true"
Pq -c "UPDATE public.radar_ingest_state SET situacao_aplicada_fechamento = finalizado_em WHERE mes_referencia = '2026-10';" >/dev/null
eq "A15b aplicada a situação do fechamento novo, 2026-10 volta a ser o vigente" "$(linha "$VEND" "$(c 1)" | cut -d'|' -f5,6)" "2026-10|2026-10"
Pq -c "UPDATE public.radar_ingest_state SET situacao_aplicada_fechamento = NULL;" >/dev/null
SAIDA14="$(como "$VEND" "SELECT * FROM public.cliente_situacao_receita('$(c 1)');" && echo VERDE)" || true
v14="vermelho"; case "$SAIDA14" in *VERDE*) v14="verde";; esac
s14="outro"; case "$SAIDA14" in *55000*) s14="55000";; esac
h14="sem-hint"; case "$SAIDA14" in *sem_lote_publicado*) h14="sem_lote_publicado";; esac
eq "A14 nenhum lote publicado: 55000 com HINT sem_lote_publicado (o front mostra indisponível), nunca selo nem silêncio" \
   "$v14 $s14 $h14" "vermelho 55000 sem_lote_publicado"
Pq -c "UPDATE public.radar_ingest_state SET situacao_aplicada_fechamento = finalizado_em WHERE status = 'complete';" >/dev/null

# ── Espelho da normalização, POR DOCUMENTO, contra radar_docs_clientes() viva ─────────────────────
# Para cada documento: profiles com SÓ ele; radar_docs_clientes() dá a chave (ou nada) e a RPC (gestor)
# tem de devolver a MESMA (via sem_dado) ou sem_cnpj. Inclui o caso permissivo herdado (CPF com sufixo).
DOCS=("11.111.111/0001-91" "11111111000191" "12.ABC.345/01DE-35" "12ABC34501DE35" "12.abc.345/01de-35" " 12ABC34501DE35 " \
      "123.456.789-09" "112.223.330-00 / 181" "lixo" "12.ABC.345/01DE-3X" "12-ABC-345-01DE-35")
Pq -c "DELETE FROM public.radar_situacao_cadastral; DELETE FROM public.omie_clientes_nao_vinculados;" >/dev/null
DIVERGE=""
for d in "${DOCS[@]}"; do
  esc="${d//\'/\'\'}"
  Pq -c "DELETE FROM public.profiles; INSERT INTO public.profiles (user_id, document) VALUES ('$(c 1)', '$esc');" >/dev/null
  esperado="$(Pq -c "SELECT coalesce(string_agg(doc, ',' ORDER BY doc), 'sem_cnpj') FROM public.radar_docs_clientes();")"
  obtido="$(linha "$GESTOR" "$(c 1)" | awk -F'|' '{ print ($1 == "sem_dado") ? $2 : $1 }')"
  [ "$esperado" = "$obtido" ] || DIVERGE="$DIVERGE [$d: docs=$esperado rpc=$obtido]"
done
eq "A13 espelho por documento: a RPC escolhe a MESMA chave que radar_docs_clientes() em ${#DOCS[@]} formatos (≤1 chave por doc)" \
   "${DIVERGE:-nenhuma}" "nenhuma"

# ── PRE anti-deriva da 2ª: corpo vivo que não é o da 1ª (md5 de PROD) nem o dela aborta o apply ──
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -qAt -p "$PORT" -h /tmp -U postgres -d postgres -f "$MIG1" >/dev/null   # volta ao corpo da 1ª
DERIVA="$(dirname "$DATA")/deriva.sql"
sed 's/-- Atribuição no CORPO (erro em DECLARE não é capturável pelo bloco)./-- corpo derivado por outra sessão/' "$MIG1" > "$DERIVA"
P -q -f "$DERIVA" >/dev/null
if SAIDA16="$(P -q -f "$MIG_USADA" 2>&1)"; then r16="verde"; else r16="vermelho"; fi
p16="sem-pre"; case "$SAIDA16" in *"PRE FALHOU: corpo vivo"*) p16="pre";; esac
eq "A16 corpo vivo derivado (nem a 1ª nem esta): a PRE da 2ª aborta o apply" "$r16 $p16" "vermelho pre"
P -q -f "$MIG1" >/dev/null; P -q -f "$MIG_USADA" >/dev/null
MD5_V2="$(grep -oE "NOT IN \('4dc173d4393fcec59eac2c85a88e09ca', '[0-9a-f]{32}'\)" "$MIG" | grep -oE "[0-9a-f]{32}'\)$" | tr -d "')")"
eq "A16b corpo da 1ª (o de PROD) → a 2ª aplica, e o md5 que o BANCO calcula do corpo novo é o que a PRE da 2ª aceita" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.cliente_situacao_receita(uuid)'::regprocedure;")" "$MD5_V2"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "CLIENTE_SITUACAO_RECEITA_PROVA_OK"
[ "$FAIL" -eq 0 ]
