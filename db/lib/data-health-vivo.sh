#!/usr/bin/env bash
# data-health-vivo.sh — monta, num PG17 descartável, o trio de data-health NA VERSÃO QUE PRODUÇÃO
# EXECUTA (_data_health_compute + data_health_watchdog + fin_sync_heartbeat), sobre o schema-snapshot.
# ================================================================================================
# NÃO é executável: é `source`-ado pela prova DEPOIS de ela definir REPO_ROOT e `P` (psql no banco
# que vai receber o schema). Usado por db/test-tint-vigia-cobertura.sh e
# db/test-tint-cobertura-lista-email.sh.
#
# ## Por que ele existe (docs/historico/provas-tint-apodrecidas.md)
#
# As duas provas acima aplicavam as migrations da SUA fase (junho/julho) por cima do snapshot de
# setembro. Um `CREATE OR REPLACE` antigo REVERTE, no banco de teste, tudo o que veio depois
# (database.md §3), e os cenários passavam a medir um watchdog que ninguém executa ("o HARNESS
# mente", money-path.md). Apodreceram por dois sintomas — MV não populada e stub colidindo com a
# função real —, mas o defeito de fundo era o ALVO: VERSÃO COBERTA ≠ VERSÃO ENTREGUE.
#
# ## O que "versão viva" quer dizer aqui — MEDIDO, não presumido
#
# snapshot (pg_dump de 2026-09-05) + as migrations a partir de DHV_INICIO que redefinem uma função
# guardada. Em 2026-09-27 isso reproduziu, com md5(pg_get_functiondef) IDÊNTICO ao da produção
# (psql-ro), as 6 funções de DHV_GUARDADAS. O snapshot sozinho batia só em 3 delas: o trio estava
# 4 migrations atrás.
#
# ## A cadeia é DINÂMICA de propósito
#
# Lista fixa apodrece do mesmo jeito que as provas apodreceram: a próxima reescrita do trio (e ele
# é reescrito quase toda semana) ficaria fora, e a prova voltaria a medir versão velha, verde.
# Um tripwire que REPROVASSE até alguém atualizar a lista fecharia isso, mas numa corrida de merge
# deixaria a main vermelha para TODO PR. Aqui toda migration nova que redefine função guardada
# entra sozinha, e a prova re-exerce as invariantes tint sob ela — que é o que money-path.md exige
# de toda migration que recria a função inteira. A migration nova que não aplicar sobre o snapshot
# (pré-requisito fora da cadeia) reprova a prova: é sinal real, a versão nova ficou sem cobertura.
#
# Limite declarado: a seleção é TEXTUAL (CREATE/ALTER/DROP FUNCTION <guardada>), então a
# substituição programática (`EXECUTE replace(pg_get_functiondef(...))`) escapa dela. É alarme, não
# prova — mesmo contrato do detector de `--falsificar` do db/roda-nucleo-ci.sh.
#
# ## O que o snapshot não carrega e produção tem
#
#   · MV criada `WITH NO DATA` (dump schema-only): `private.customer_metrics_mv` é lida pelo compute
#     vivo. REFRESH num banco vazio = MV populada e vazia, como o cron deixa a de prod.
#   · ACL: o dump é `--no-privileges`, então toda função nasce executável por PUBLIC. A pós-condição
#     da 20260918200000 exige o compute FECHADO para anon/PUBLIC; reproduz-se o ACL MEDIDO em prod
#     (2026-09-27: postgres, service_role e sandbox_exec — nem `authenticated`) ANTES do apply, e aí
#     a pós-condição mede o que a migration faz com ele (CREATE OR REPLACE preserva) em vez de medir
#     o default do harness. Mesmo idioma de db/test-data-health-sync-reprocess.sh.

DHV_INICIO=20260918200000
DHV_GUARDADAS=(_data_health_compute data_health_watchdog fin_sync_heartbeat _data_health_episodio
               _tint_cobertura_bases_lista_email _vendas_familia_ausente_lista_email)

# dhv_cadeia <dir de migrations> — imprime, em ordem de versão, as migrations com versão ≥ DHV_INICIO
# que redefinem uma função guardada. Fail-CLOSED: diretório sem migrations, versão fora do formato,
# grep que não leu (exit 2) e a própria DHV_INICIO ausente abortam com exit 1 — nunca "cadeia vazia".
dhv_cadeia() {
  local dir="$1" f base v rc nomes padrao achou_inicio=0 n=0
  nomes="$(IFS='|'; printf '%s' "${DHV_GUARDADAS[*]}")"
  padrao="(create[[:space:]]+(or[[:space:]]+replace[[:space:]]+)?|alter[[:space:]]+|drop[[:space:]]+)function[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?(public\.)?\"?(${nomes})\"?[[:space:]]*\("
  for f in "$dir"/*.sql; do
    [ -f "$f" ] || { echo "dhv_cadeia: nenhuma migration em $dir" >&2; return 1; }
    base="$(basename "$f")"; v="${base%%_*}"
    printf '%s' "$v" | grep -qE '^[0-9]{14}$' || { echo "dhv_cadeia: versão fora do formato: $base" >&2; return 1; }
    [ "$v" = "$DHV_INICIO" ] && achou_inicio=1
    [ "$v" -lt "$DHV_INICIO" ] && continue
    if grep -qiE "$padrao" "$f"; then
      printf '%s\n' "$f"; n=$((n + 1))
    else
      rc=$?
      [ "$rc" -eq 1 ] || { echo "dhv_cadeia: grep não leu $base (exit $rc)" >&2; return 1; }
    fi
  done
  [ "$achou_inicio" -eq 1 ] || { echo "dhv_cadeia: a migration de início $DHV_INICIO sumiu de $dir" >&2; return 1; }
  [ "$n" -ge 1 ] || { echo "dhv_cadeia: cadeia vazia a partir de $DHV_INICIO" >&2; return 1; }
}

# dhv_aplicar_cadeia <dir de migrations> — aplica a cadeia no banco de `P`, em ordem, e conta.
dhv_aplicar_cadeia() {
  local dir="$1" lista f n=0
  lista="$(dhv_cadeia "$dir")" || return 1
  while IFS= read -r f; do
    P -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null || { echo "dhv_aplicar_cadeia: não aplicou $(basename "$f")" >&2; return 1; }
    echo "    · $(basename "$f")"
    n=$((n + 1))
  done <<< "$lista"
  echo "    ($n migration(s) — a versão viva do trio)"
}

# dhv_montar — snapshot + o que ele não carrega (MV, ACL) + a cadeia viva, no banco de `P`.
dhv_montar() {
  local rr
  rr="$(mktemp "${TMPDIR:-/tmp}/snap-dhv.XXXXXX")"
  sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
    | grep -vE '^\\(un)?restrict ' > "$rr"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
  P --single-transaction -v ON_ERROR_STOP=1 -q -f "$rr"
  rm -f "$rr"
  P -v ON_ERROR_STOP=1 -q <<'SQL'
REFRESH MATERIALIZED VIEW private.customer_metrics_mv;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
  echo "  → cadeia viva (≥ $DHV_INICIO que redefine função guardada):"
  dhv_aplicar_cadeia "$REPO_ROOT/supabase/migrations"
}

# dhv_sabotar <regprocedure> <âncora> <troca> — troca a âncora por <troca> no corpo VIVO da função e
# o recria. A âncora tem de ocorrer EXATAMENTE uma vez e o md5 do corpo tem de mudar: sabotagem que
# não pegou é erro (exit ≠ 0), nunca "a suíte ficou verde, então o assert não tem dente".
dhv_sabotar() {
  P -v ON_ERROR_STOP=1 -q -v fn="$1" -v ancora="$2" -v troca="$3" > /dev/null <<'SQL'
SELECT set_config('dhv.fn', :'fn', false), set_config('dhv.ancora', :'ancora', false),
       set_config('dhv.troca', :'troca', false);
DO $sab$
DECLARE
  v_fn  regprocedure := current_setting('dhv.fn')::regprocedure;
  v_anc text := current_setting('dhv.ancora');
  v_def text := pg_get_functiondef(current_setting('dhv.fn')::regprocedure);
  v_n   int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SABOTAGEM SEM ANCORA UNICA: % ocorrencia(s) em %', v_n, v_fn;
  END IF;
  EXECUTE replace(v_def, v_anc, current_setting('dhv.troca'));
  IF md5(pg_get_functiondef(v_fn)) = md5(v_def) THEN
    RAISE EXCEPTION 'SABOTAGEM NAO MUDOU O CORPO de %', v_fn;
  END IF;
END $sab$;
SQL
}

# dhv_migracao_nova <regprocedure> <âncora> <troca> — escreve uma migration NOVA (versão
# 29991231235959) com o corpo vivo da função sabotado e reaplica a cadeia a partir de um diretório
# que a contém. É a falsificação da cadeia DINÂMICA: é a regressão que chega pela PRÓXIMA reescrita
# do trio. Se a seleção não pegar a migration nova, a sabotagem não chega ao banco, a suíte fica
# verde e o recibo acusa o dente que falta.
dhv_migracao_nova() {
  local dir nova corpo lista
  dir="$(mktemp -d "${TMPDIR:-/tmp}/dhv-migracoes.XXXXXX")"
  ln -s "$REPO_ROOT"/supabase/migrations/*.sql "$dir"/
  nova="$dir/29991231235959_sabotagem_regride_trio.sql"
  if ! corpo="$(P -X -v ON_ERROR_STOP=1 -q -tA -v fn="$1" -v ancora="$2" -v troca="$3" <<'SQL'
SELECT CASE WHEN (length(d) - length(replace(d, :'ancora', ''))) / length(:'ancora') = 1
            THEN replace(d, :'ancora', :'troca') ELSE 'SABOTAGEM SEM ANCORA UNICA' END
  FROM (SELECT pg_get_functiondef(:'fn'::regprocedure) AS d) s;
SQL
)"; then
    rm -rf "$dir"; return 1
  fi
  case "$corpo" in
    ''|'SABOTAGEM SEM ANCORA UNICA') echo "dhv_migracao_nova: âncora não é única em $1" >&2; rm -rf "$dir"; return 1 ;;
  esac
  printf '%s;\n' "$corpo" > "$nova"
  if ! lista="$(dhv_cadeia "$dir")"; then rm -rf "$dir"; return 1; fi
  case "$lista" in
    *"$nova"*) ;;
    *) echo "dhv_migracao_nova: a seleção dinâmica NÃO pegou a migration nova" >&2; rm -rf "$dir"; return 1 ;;
  esac
  if ! dhv_aplicar_cadeia "$dir"; then rm -rf "$dir"; return 1; fi
  rm -rf "$dir"
}
