#!/usr/bin/env bash
# corpo-vivo.sh — monta, num PG17 descartável, o schema que PRODUÇÃO executa para os objetos que uma
# prova assevera: snapshot + o ACL MEDIDO em prod + a cadeia DINÂMICA das migrations que o snapshot ainda
# não absorveu e que tocam objeto guardado.
# ================================================================================================
# NÃO é executável: é `source`-ado pela prova DEPOIS de ela definir REPO_ROOT, `P` (psql no banco que vai
# receber o schema) e as listas CV_FUNCOES / CV_TABELAS (os objetos que ELA assevera). Usado por
# db/test-whatsapp-hsm.sh, db/test-whatsapp-funil.sh e db/test-whatsapp-proposta.sh. O trio de
# data-health tem a lib dele (db/lib/data-health-vivo.sh: MV, ACL e cadeia do trio); o cv_sabotar abaixo é
# o mesmo idioma do dhv_sabotar.
#
# ## Por que ela existe (docs/historico/provas-db-mortas-fora-do-nucleo.md)
#
# As provas do canal WhatsApp re-aplicavam as migrations da SUA fase (07-13) sobre o snapshot. O re-dump
# que as absorveu matou as três no setup (`CREATE POLICY` não é idempotente), e uma delas nasceu morta.
# Pior que morrer: elas davam `GRANT ALL ON ALL TABLES` a anon/authenticated, um ACL que prod não tem — e
# com esse ACL de mentira nenhuma delas podia ver que o funil do canal dá `permission denied` para todo
# staff em prod (medido em 2026-09-30; docs/historico/provas-canal-revividas.md).
#
# ## O que "versão viva" quer dizer aqui — MEDIDO, não presumido
#
# Em 2026-09-30, `md5(pg_get_functiondef())` via psql-ro × o banco montado por esta lib: as funções sob
# teste das provas do canal (get_whatsapp_funil, get_whatsapp_proposta_cotacao) são IGUAIS às do
# snapshot, e nenhuma migration ≥ CV_INICIO toca os objetos guardados — a cadeia sai vazia, e isso é
# legítimo (diferente do dhv, onde a cadeia vazia é sinal de defeito). Tabelas guardadas: policies,
# constraints, triggers e RLS iguais às de prod no mesmo diff de catálogo.
#
# ## A cadeia é DINÂMICA de propósito
#
# Toda migration ≥ CV_INICIO que faz DDL sobre um objeto guardado entra sozinha: a PRÓXIMA reescrita da
# RPC (ou policy nova numa tabela guardada) é exercitada pela prova no próprio PR que a traz — que é o
# ponto de a prova estar no núcleo. A migration que não aplicar sobre o snapshot (pré-requisito fora da
# cadeia, ACL que a pós-condição dela exige e o fixture não tem) REPROVA a prova: sinal real, a versão
# nova ficou sem cobertura. Limite declarado (o mesmo do dhv): a seleção é TEXTUAL, então substituição
# programática (`EXECUTE replace(pg_get_functiondef(...))`) escapa dela.
#
# ## Ao re-dumpar o snapshot
#
# Avance CV_INICIO para a 1ª migration que o novo dump NÃO absorveu. Senão a cadeia re-aplica o que o
# snapshot já tem, e DDL não-idempotente (CREATE POLICY) derruba a prova — que é exatamente como as
# provas do canal morreram. Ela fica VERMELHA no PR do re-dump (está no núcleo), não apodrece calada.
# Limite declarado: o corte é por VERSÃO, e versão ≠ ordem de chegada — a migration de versão antiga
# mergeada DEPOIS do dump (branch escrita antes) fica fora da cadeia para sempre. Medido em 2026-09-30:
# 5 assim (20260830122701, 0830122702, 0830214547, 0904232555, 0904233000), nenhuma com DDL sobre objeto
# guardado; a 0830122702 tira de profiles um trigger que o snapshot ainda tem. No re-dump, meça o
# início contra prod em vez de presumi-lo pela data.
#
# ## O que o snapshot não carrega e produção tem: o ACL
#
# O dump é `--no-privileges`: sem fixture, toda tabela nasce sem GRANT nenhum (authenticated levaria
# "permission denied" no lugar da RLS) e toda função nasce executável por PUBLIC. O
# db/lib/corpo-vivo-acl.sql reproduz o ACL MEDIDO em prod (tabela, coluna e função) dos objetos que as
# provas leem e escrevem, e o DEFAULT PRIVILEGES de prod, ANTES da cadeia — então a pós-condição de uma
# migration da cadeia mede o que ela faz com o ACL de prod (CREATE OR REPLACE preserva; DROP+CREATE
# volta ao default de PROD, que dá EXECUTE explícito ao anon — não ao default do PG, que só tem PUBLIC).

CV_INICIO=20260905090000   # 1ª migration fora do re-dump de 2026-09-05 (1851416fc); medido em 2026-09-30

# _cv_alternativas <nome…> — "a|b|c" para o regex; vazio se a lista for vazia (o chamador pula o ramo:
# alternação vazia casaria qualquer migration).
_cv_alternativas() { local IFS='|'; printf '%s' "$*"; }

# cv_cadeia <dir de migrations> — imprime, em ordem de versão, as migrations com versão ≥ CV_INICIO que
# fazem DDL sobre função de CV_FUNCOES ou tabela de CV_TABELAS. O texto é lido SEM comentários de linha
# e com as quebras de linha achatadas (DDL multi-linha: `CREATE POLICY x\n  ON public.t`). Fail-CLOSED:
# diretório sem migrations, versão fora do formato, grep que não leu (exit 2), CV_INICIO ausente e as
# duas listas vazias abortam com exit 1. Cadeia vazia é resultado legítimo — o snapshot já é a versão viva.
cv_cadeia() {
  local dir="$1" f base v rc fns tabs sp='[[:space:]]' fim='([^a-z0-9_"]|$)' padrao='' achou_inicio=0
  fns="$(_cv_alternativas "${CV_FUNCOES[@]+"${CV_FUNCOES[@]}"}")"
  tabs="$(_cv_alternativas "${CV_TABELAS[@]+"${CV_TABELAS[@]}"}")"
  [ -n "$fns$tabs" ] || { echo "cv_cadeia: CV_FUNCOES e CV_TABELAS vazias — nada a guardar" >&2; return 1; }
  # Função: CREATE/ALTER/DROP (com ou sem a assinatura — `DROP FUNCTION f;` também) e GRANT/REVOKE
  # ON FUNCTION (o ACL da RPC é o que os asserts de anon medem). Tabela: CREATE/ALTER/DROP TABLE, policy,
  # índice, trigger (inclusive CREATE OR REPLACE) e GRANT/REVOKE em qualquer ponto da lista do ON.
  if [ -n "$fns" ]; then
    padrao="((create${sp}+(or${sp}+replace${sp}+)?|alter${sp}+|drop${sp}+)function${sp}+(if${sp}+exists${sp}+)?|(grant|revoke)[^;]*${sp}on${sp}+function${sp}([^;]*[^a-z0-9_\"])?)(\"?(public|private)\"?\.)?\"?(${fns})\"?${sp}*(\(|;|,)"
  fi
  if [ -n "$tabs" ]; then
    [ -z "$padrao" ] || padrao="$padrao|"
    padrao="$padrao(create${sp}+table${sp}+(if${sp}+not${sp}+exists${sp}+)?|alter${sp}+table${sp}+(if${sp}+exists${sp}+)?(only${sp}+)?|drop${sp}+table${sp}+(if${sp}+exists${sp}+)?|(create|alter|drop)${sp}+policy[^;]*${sp}on${sp}+|create${sp}+(unique${sp}+)?index[^;]*${sp}on${sp}+(only${sp}+)?|(create(${sp}+or${sp}+replace)?|drop)${sp}+(constraint${sp}+)?trigger[^;]*${sp}on${sp}+|(grant|revoke)[^;]*${sp}on${sp}([^;]*[^a-z0-9_\"])?)(\"?public\"?\.)?\"?(${tabs})\"?${fim}"
  fi
  for f in "$dir"/*.sql; do
    [ -f "$f" ] || { echo "cv_cadeia: nenhuma migration em $dir" >&2; return 1; }
    base="${f##*/}"; v="${base%%_*}"
    [[ "$v" =~ ^[0-9]{14}$ ]] || { echo "cv_cadeia: versão fora do formato: $base" >&2; return 1; }
    [ "$v" = "$CV_INICIO" ] && achou_inicio=1
    [ "$v" -lt "$CV_INICIO" ] && continue
    if sed -E 's/--.*$//' "$f" | tr '\n' ' ' | grep -qiE "$padrao"; then
      printf '%s\n' "$f"
    else
      rc=$?
      [ "$rc" -eq 1 ] || { echo "cv_cadeia: grep não leu $base (exit $rc)" >&2; return 1; }
    fi
  done
  [ "$achou_inicio" -eq 1 ] || { echo "cv_cadeia: a migration de início $CV_INICIO sumiu de $dir" >&2; return 1; }
}

# cv_aplicar_cadeia <dir de migrations> — aplica a cadeia no banco de `P`, em ordem, e conta.
cv_aplicar_cadeia() {
  local dir="$1" lista f n=0
  lista="$(cv_cadeia "$dir")" || return 1
  if [ -z "$lista" ]; then
    echo "    (nenhuma migration ≥ $CV_INICIO toca os objetos guardados — o snapshot já é a versão viva)"
    return 0
  fi
  while IFS= read -r f; do
    P -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null || {
      echo "cv_aplicar_cadeia: não aplicou $(basename "$f") — se o snapshot já a absorveu, avance CV_INICIO;" \
           "se a pós-condição dela exige ACL, meça-o em prod e acrescente a db/lib/corpo-vivo-acl.sql" >&2
      return 1
    }
    echo "    · $(basename "$f")"
    n=$((n + 1))
  done <<< "$lista"
  echo "    ($n migration(s) — a versão viva dos objetos guardados)"
}

# cv_montar — snapshot + o ACL de prod + auth.uid() fiel ao Supabase + o helper de SQLSTATE + a cadeia
# viva, no banco de `P`.
cv_montar() {
  local rr
  rr="$(mktemp "${TMPDIR:-/tmp}/snap-cv.XXXXXX")"
  sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
    | grep -vE '^\\(un)?restrict ' > "$rr"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
  P --single-transaction -v ON_ERROR_STOP=1 -q -f "$rr"
  rm -f "$rr"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/lib/corpo-vivo-acl.sql"
  P -v ON_ERROR_STOP=1 -q <<'SQL'
-- auth.uid()/auth.role() como os do Supabase: leem o JWT da sessão (o stub devolve NULL fixo). A prova
-- fixa `request.jwt.claims` na MESMA sessão em que faz SET ROLE — é assim que o PostgREST chega ao banco.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- prova.sqlstate(sql): executa como QUEM CHAMA (invoker) e devolve 'OK' ou a SQLSTATE, com a CAMADA que
-- negou quando é 42501 — GRANT de função, de tabela/coluna ou de schema, ou a policy: todas dão 42501,
-- e sabotar UMA camada tem de mudar o veredito (o anon, barrado no EXECUTE da RPC, ainda bateria no
-- SELECT da tabela — sem nomear o objeto, abrir o EXECUTE ficaria verde). O servidor sobe com
-- --locale=C, então SQLERRM é inglês em qualquer LC_ALL do cliente. Não é `WHEN OTHERS THEN 'OK'`: o
-- código volta e o assert o compara EXATO.
CREATE SCHEMA prova;
GRANT USAGE ON SCHEMA prova TO anon, authenticated, service_role;
CREATE FUNCTION prova.sqlstate(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  -- ...e o OBJETO que negou: um /acl-tabela vindo da subconsulta de uma policy em OUTRA tabela não pode
  -- passar pelo assert que espera a negação desta.
  RETURN SQLSTATE || CASE
    WHEN SQLSTATE <> '42501' THEN ''
    WHEN SQLERRM LIKE 'permission denied for function %' THEN
      '/acl-funcao:' || coalesce(substring(SQLERRM from 'for function "?([A-Za-z0-9_.]+)'), '?')
    WHEN SQLERRM LIKE 'permission denied for table %' THEN
      '/acl-tabela:' || coalesce(substring(SQLERRM from 'for table "?([A-Za-z0-9_.]+)'), '?')
    WHEN SQLERRM LIKE 'permission denied for schema %' THEN
      '/acl-schema:' || coalesce(substring(SQLERRM from 'for schema "?([A-Za-z0-9_.]+)'), '?')
    WHEN SQLERRM LIKE '%row-level security%' THEN
      '/rls:' || coalesce(substring(SQLERRM from 'for table "?([A-Za-z0-9_.]+)'), '?')
    ELSE '/?' END;
END $f$;
SQL
  echo "  → cadeia viva (≥ $CV_INICIO que toca objeto guardado):"
  cv_aplicar_cadeia "$REPO_ROOT/supabase/migrations"
}

# cv_sabotar <regprocedure> <âncora> <troca> — troca a âncora por <troca> no corpo VIVO da função e o
# recria. A âncora tem de ocorrer EXATAMENTE uma vez e o md5 do corpo tem de mudar: sabotagem que não
# pegou é erro (exit ≠ 0), nunca "a suíte ficou verde, então o assert não tem dente".
cv_sabotar() {
  P -v ON_ERROR_STOP=1 -q -v fn="$1" -v ancora="$2" -v troca="$3" > /dev/null <<'SQL'
SELECT set_config('cv.fn', :'fn', false), set_config('cv.ancora', :'ancora', false),
       set_config('cv.troca', :'troca', false);
DO $sab$
DECLARE
  v_fn  regprocedure := current_setting('cv.fn')::regprocedure;
  v_anc text := current_setting('cv.ancora');
  v_def text := pg_get_functiondef(current_setting('cv.fn')::regprocedure);
  v_n   int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc);
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SABOTAGEM SEM ANCORA UNICA: % ocorrencia(s) em %', v_n, v_fn;
  END IF;
  EXECUTE replace(v_def, v_anc, current_setting('cv.troca'));
  IF md5(pg_get_functiondef(v_fn)) = md5(v_def) THEN
    RAISE EXCEPTION 'SABOTAGEM NAO MUDOU O CORPO de %', v_fn;
  END IF;
END $sab$;
SQL
}

# cv_migracao_nova_sql <sql> — escreve uma migration NOVA (versão 29991231235959) com <sql> e reaplica a
# cadeia a partir de um diretório que a contém. É a falsificação da cadeia DINÂMICA: a regressão que chega
# pela PRÓXIMA migration (policy aberta numa tabela guardada, RPC reescrita). Se a seleção não pegar a
# migration nova, a sabotagem não chega ao banco, a suíte fica verde e o recibo acusa o dente que falta.
cv_migracao_nova_sql() {
  local dir nova lista
  dir="$(mktemp -d "${TMPDIR:-/tmp}/cv-migracoes.XXXXXX")"
  ln -s "$REPO_ROOT"/supabase/migrations/*.sql "$dir"/
  nova="$dir/29991231235959_sabotagem_regride_corpo_vivo.sql"
  printf '%s\n' "$1" > "$nova"
  if ! lista="$(cv_cadeia "$dir")"; then rm -rf "$dir"; return 1; fi
  case "$lista" in
    *"$nova"*) ;;
    *) echo "cv_migracao_nova_sql: a seleção dinâmica NÃO pegou a migration nova" >&2; rm -rf "$dir"; return 1 ;;
  esac
  # A rodada é clone da base, que JÁ tem a cadeia: aplica só a nova. Re-aplicar a cadeia inteira
  # derrubaria a sabotagem no 1º DDL não-idempotente dela (CREATE POLICY), não no assert.
  if ! P -v ON_ERROR_STOP=1 -q -f "$nova" > /dev/null; then
    echo "cv_migracao_nova_sql: a migration nova não aplicou" >&2; rm -rf "$dir"; return 1
  fi
  rm -rf "$dir"
}

# cv_migracao_nova <regprocedure> <âncora> <troca> [sql depois] — a mesma, com o corpo VIVO da função
# sabotado (âncora única, como no cv_sabotar). <troca> pode trazer mais de um comando (ex.: DROP + CREATE);
# [sql depois] vem após o corpo (ex.: o REVOKE … FROM PUBLIC que esquece o anon).
cv_migracao_nova() {
  local corpo extra=''
  [ -z "${4:-}" ] || extra=$'\n'"$4"
  if ! corpo="$(P -X -v ON_ERROR_STOP=1 -q -tA -v fn="$1" -v ancora="$2" -v troca="$3" <<'SQL'
SELECT CASE WHEN (length(d) - length(replace(d, :'ancora', ''))) / length(:'ancora') = 1
            THEN replace(d, :'ancora', :'troca') ELSE 'SABOTAGEM SEM ANCORA UNICA' END
  FROM (SELECT pg_get_functiondef(:'fn'::regprocedure) AS d) s;
SQL
)"; then
    return 1
  fi
  case "$corpo" in
    ''|'SABOTAGEM SEM ANCORA UNICA') echo "cv_migracao_nova: âncora não é única em $1" >&2; return 1 ;;
  esac
  cv_migracao_nova_sql "$corpo;$extra"
}
