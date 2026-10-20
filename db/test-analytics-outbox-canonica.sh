#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — migration CANÔNICA de analytics_outbox_pedido_compra (I2 · plano v2, ciclo 2)  ║
# ║   bash db/test-analytics-outbox-canonica.sh               > "$LOG" 2>&1; echo "exit=$?"    ║
# ║   bash db/test-analytics-outbox-canonica.sh --falsificar  > "$LOG" 2>&1; echo "exit=$?"    ║
# ║   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-analytics-outbox-canonica.sh   (o 2º locale)       ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                    ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
# O que esta prova afirma (supabase/migrations/20261020200000_…_canonica_insert_ja_aprovado.sql):
#   R (restore só de migrations): cadeia real até 20261011150000 + a canônica → o corpo vivo tem o
#     md5 da PROD (ae665653…), o contrato fora do prosrc, e COMPORTA-SE como o envelope: INSERT já
#     aprovado = criada E aprovada; ramos velhos intactos; fail-open vivo. Reaplicar é no-op.
#   P (a prod): cadeia real + o ENVELOPE (db/aplicar-analytics-outbox-insert-ja-aprovado.sql, que é
#     o que a prod rodou) → mesmo md5; a canônica por cima aplica e não muda o corpo.
#   Os dois caminhos terminam no MESMO md5(prosrc), igual à constante da prod (psql-ro 2026-10-20).
#
# `--falsificar` usa o idioma SABOTAGENS (o de db/test-pedido-total-liquido-excecao.sh): cada entrada
# DECLARA os asserts que têm de acusá-la e a MARCA de erro esperada; o laço re-invoca a suíte INTEIRA
# com `SABOTAGEM=<nome>` e só conta a rodada se (a) o controle ficou verde ANTES, na mesma invocação,
# (b) a sabotagem APLICOU (marca `SABOTAGEM ativa:`), (c) os asserts DECLARADOS ficaram vermelhos e
# (d) a marca de erro é a esperada. Integridade (a migration aborta pela defesa certa) e
# comportamento (PÓS cega + ramo fora → o assert de funil acusa) são laços separados.
set -euo pipefail

MODO="normal"
case "${1:-}" in
  "") ;;
  --falsificar) MODO="falsificar" ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5497}"
SABOTAGEM="${SABOTAGEM:-}"
SLUG="analytics-outbox-canonica"

# A marca de erro que cada sabotagem TEM de produzir (regex de grep -E). Sem ela, vermelho de
# ambiente (porta ocupada, arquivo ausente) contaria como dente.
marca_de() {
  case "$1" in
    canonica_corpo_1token)      echo 'POS FALHOU \[CORPO\]' ;;
    canonica_sem_ramo)          echo 'POS FALHOU \[CORPO\]' ;;
    canonica_pre_estranha)      echo 'PRE FALHOU: o corpo vivo' ;;
    canonica_atributo_invoker)  echo 'PRE FALHOU: atributos vivos' ;;
    canonica_volatil_stable)    echo 'PRE FALHOU: analytics_outbox_pedido_compra viva n' ;;
    canonica_trigger_so_update) echo 'POS FALHOU \[TRIGGER\]' ;;
    canonica_trigger_outra_fn)  echo 'POS FALHOU \[TRIGGER\]' ;;
    canonica_owner_trocado)     echo 'PRE FALHOU: owner' ;;
    canonica_outbox_sem_unique) echo 'POS FALHOU \[OUTBOX\]' ;;
    canonica_outbox_diferivel)  echo 'POS FALHOU \[OUTBOX\]: há UNIQUE DIFER' ;;
    canonica_pos_cega_sem_ramo) echo 'ASSERT PURO' ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}

# ════════════════════════════════════ modo --falsificar ════════════════════════════════════
if [ "$MODO" = "falsificar" ]; then
  SABOTAGENS="canonica_corpo_1token:R1
              canonica_sem_ramo:R1
              canonica_pre_estranha:R1
              canonica_atributo_invoker:R1
              canonica_volatil_stable:R1
              canonica_trigger_so_update:R1
              canonica_trigger_outra_fn:R1
              canonica_owner_trocado:R1
              canonica_outbox_sem_unique:R1
              canonica_outbox_diferivel:R1
              canonica_pos_cega_sem_ramo:R2,C2"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c '  ✅ ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar: sempre-vermelha aprova qualquer sabotagem"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; verm="${item#*:}"
    marca="$(marca_de "$sab")"
    porta=$((porta + 1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte VERDE com a sabotagem ativa: o assert NÃO tem dente"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO aplicou: quebrou outra coisa"
      { grep -E 'FALHOU|ERROR|could not' "$log" || true; } | head -3 | sed 's/^/       /'; falhas=$((falhas+1)); continue
    fi
    faltou=""
    for x in ${verm//,/ }; do grep -Eq "❌ ${x} " "$log" || faltou="$faltou $x"; done
    if [ -n "$faltou" ]; then
      echo "  ❌ $sab — devia ficar vermelha em:$faltou"; falhas=$((falhas+1)); continue
    fi
    if [ "$marca" = "ASSERT PURO" ]; then
      # O vermelho comportamental só vale se a migration APLICOU (R1 verde): com o apply abortado, o
      # predecessor intacto já deixa R2/C2 vermelhos e o mutante levaria o crédito (Codex de código, P2).
      if ! grep -q '  ✅ R1 ' "$log"; then
        echo "  ❌ $sab — esperava a migration APLICADA (R1 verde) antes do vermelho de assert puro"; falhas=$((falhas+1)); continue
      fi
      if grep -Eq 'PRE FALHOU|POS FALHOU' "$log"; then
        echo "  ❌ $sab — esperava vermelho de ASSERT puro (a migration aplica), mas a migration abortou"; falhas=$((falhas+1)); continue
      fi
    elif ! grep -Eq "$marca" "$log"; then
      echo "  ❌ $sab — vermelha em [$verm], mas sem a marca '$marca': vermelho pela defesa errada"; falhas=$((falhas+1)); continue
    elif ! grep -q '  ✅ R1b ' "$log"; then
      # A recusa só vale com ROLLBACK integral, conferido por OUTRA conexão (parecer Codex de desenho).
      echo "  ❌ $sab — a migration recusou, mas o estado anterior NÃO foi provado intacto (R1b)"; falhas=$((falhas+1)); continue
    fi
    echo "  ✅ $sab — vermelha em [$verm] pela marca '$marca'"
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens no assert DECLARADO ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ FALSIFICAÇÃO FALHOU: $falhas (logs em $LOGDIR) ═══"; exit 1
fi

# ═════════════════════════════════════ a suíte ═════════════════════════════════════════════
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MAE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
PRED="$REPO_ROOT/supabase/migrations/20261011150000_reposicao_recusa_definitiva_portal_servidor.sql"
ENV="$REPO_ROOT/db/aplicar-analytics-outbox-insert-ja-aprovado.sql"
CANON="$REPO_ROOT/supabase/migrations/20261020200000_analytics_outbox_pedido_compra_canonica_insert_ja_aprovado.sql"
for f in "$MAE" "$PRED" "$ENV" "$CANON"; do [ -f "$f" ] || { echo "arquivo ausente: $f"; exit 1; }; done
PRED_MD5='049e1b52b0c41950456268409ecb927f'   # 20261011150000 (prod até 2026-10-18)
PROD_MD5='ae665653674267a3613b015366375a33'   # md5(prosrc) da PROD, psql-ro 2026-10-20

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres restore
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prod
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "${DB:-restore}" -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
ativa() { echo "SABOTAGEM ativa: $SABOTAGEM"; }

# Stubs + tabela-fonte (só as colunas que o trigger e o backfill do envelope leem) + migration-mãe
# + o corpo do predecessor (2026-10-11), num banco.
preparar() {
  DB="$1" P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  DB="$1" P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true) RETURNING jobid;
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; $f$;
CREATE TABLE public.pedido_compra_sugerido (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  status text NOT NULL DEFAULT 'pendente_aprovacao',
  aprovado_por text, aprovado_em timestamptz, cancelado_em timestamptz,
  condicao_origem text, origem_evento_tipo text,
  criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now()
);
SQL
  DB="$1" P -q -f "$MAE" >/dev/null
  DB="$1" P -q -f "$RODADA/pred.sql" >/dev/null
}
awk '/^CREATE OR REPLACE FUNCTION public\.analytics_outbox_pedido_compra\(\)/{f=1} f{print} f && /^\$function\$;/{exit}' "$PRED" > "$RODADA/pred.sql"
[ -s "$RODADA/pred.sql" ] || { echo "não extraí o corpo do predecessor de $PRED"; exit 1; }
md5vivo() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.analytics_outbox_pedido_compra()');"; }
# Tudo que a migration pode tocar, lido por uma conexão nova (cada Pq é um psql à parte).
estado() { Pq -c "SELECT md5(p.prosrc) || '|' || p.oid || '|' || p.proowner::regrole || '|' || coalesce(p.proacl::text, '<default>') || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' || (SELECT string_agg(pg_get_triggerdef(t.oid) || '@' || t.tgfoid, ';') FROM pg_trigger t WHERE t.tgname = 'trg_analytics_outbox_pedido_compra') FROM pg_proc p WHERE p.oid = to_regprocedure('public.analytics_outbox_pedido_compra()');"; }
contrato() { Pq -c "SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || p.proisstrict::text || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_function_result(p.oid) || '|' || l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure('public.analytics_outbox_pedido_compra()');"; }
linhas() { Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE chave_dedup LIKE 'pcs:$1:%';"; }
evento() { Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE chave_dedup = 'pcs:$1:reposicao.$2';"; }

preparar restore
preparar prod
echo "=== setup pronto (PG17 :$PORT · locale $LOCALE_TESTE · lc_messages do servidor: $(Pq -c "SHOW lc_messages;")) ==="
eq "Z1 fixture: o predecessor carregado tem o md5 revisado" "$(md5vivo)" "$PRED_MD5"

# ── A canônica que esta rodada aplica (sabotada ou não) ─────────────────────────────────────
cp "$CANON" "$RODADA/canon.sql"
sabotar_arquivo() {   # $1 = programa perl; exige que o arquivo MUDE
  perl -0pi -e "$1" "$RODADA/canon.sql"
  if cmp -s "$CANON" "$RODADA/canon.sql"; then echo "a sabotagem $SABOTAGEM não mudou o arquivo (regex não casou)"; exit 3; fi
  ativa
}
# shellcheck disable=SC2016  # os programas perl abaixo usam $ do perl, não do shell
case "$SABOTAGEM" in
  "") ;;
  canonica_corpo_1token)      sabotar_arquivo "s/'sistema:reposicao',/'sistema:reposicaX',/" ;;
  canonica_sem_ramo)          sabotar_arquivo "s/\Qv_eventos := array_append(v_eventos, 'reposicao.sugestao_aprovada');\E/NULL;  -- SABOTADO/" ;;
  canonica_pos_cega_sem_ramo) sabotar_arquivo "s/\Qv_eventos := array_append(v_eventos, 'reposicao.sugestao_aprovada');\E/NULL;  -- SABOTADO/; s/IS DISTINCT FROM 'ae665653674267a3613b015366375a33' THEN/IS NULL THEN/" ;;
  canonica_pre_estranha)
    # corpo vivo = predecessor com 1 token a mais: nem o revisado nem este
    perl -0pe "s/'sistema:reposicao',/'sistema:reposicaY',/" "$RODADA/pred.sql" > "$RODADA/estranho.sql"
    cmp -s "$RODADA/pred.sql" "$RODADA/estranho.sql" && { echo "sabotagem não mudou o predecessor"; exit 3; }
    P -q -f "$RODADA/estranho.sql" >/dev/null; ativa ;;
  canonica_atributo_invoker)  P -q -c "ALTER FUNCTION public.analytics_outbox_pedido_compra() SECURITY INVOKER;"; ativa ;;
  canonica_volatil_stable)    P -q -c "ALTER FUNCTION public.analytics_outbox_pedido_compra() STABLE;"; ativa ;;
  canonica_owner_trocado)
    P -q -c "CREATE ROLE dono_sem_insert NOLOGIN; ALTER FUNCTION public.analytics_outbox_pedido_compra() OWNER TO dono_sem_insert;"; ativa ;;
  canonica_outbox_sem_unique)
    P -q -c "DO \$\$ DECLARE c text; BEGIN
               SELECT conname INTO STRICT c FROM pg_constraint
                WHERE conrelid = 'public.analytics_outbox'::regclass AND contype = 'u';
               EXECUTE format('ALTER TABLE public.analytics_outbox DROP CONSTRAINT %I', c);
             END \$\$;"
    ativa ;;
  canonica_outbox_diferivel)
    # o UNIQUE original FICA: o árbitro diferível a mais é que quebra o ON CONFLICT
    P -q -c "ALTER TABLE public.analytics_outbox ADD CONSTRAINT dedup_diferivel UNIQUE (chave_dedup) DEFERRABLE INITIALLY IMMEDIATE;"; ativa ;;
  canonica_trigger_outra_fn)
    # homônima noutro schema, PRIMEIRO no search_path: o pg_get_triggerdef a imprime sem schema e a
    # regex `(public\.)?` aceitaria — só o `tgfoid` separa as duas.
    P -q -c "CREATE SCHEMA outro;
             CREATE FUNCTION outro.analytics_outbox_pedido_compra() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NULL; END \$f\$;
             DROP TRIGGER trg_analytics_outbox_pedido_compra ON public.pedido_compra_sugerido;
             CREATE TRIGGER trg_analytics_outbox_pedido_compra AFTER INSERT OR UPDATE ON public.pedido_compra_sugerido FOR EACH ROW EXECUTE FUNCTION outro.analytics_outbox_pedido_compra();
             ALTER DATABASE restore SET search_path = outro, public;"
    ativa ;;
  canonica_trigger_so_update)
    P -q -c "DROP TRIGGER trg_analytics_outbox_pedido_compra ON public.pedido_compra_sugerido;
             CREATE TRIGGER trg_analytics_outbox_pedido_compra AFTER UPDATE ON public.pedido_compra_sugerido FOR EACH ROW EXECUTE FUNCTION public.analytics_outbox_pedido_compra();"
    ativa ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac

# ── R: restore só de migrations (cadeia real + canônica) ────────────────────────────────────
echo "-- grupo R: restore (cadeia até 20261011150000 + canônica) --"
antes="$(estado)"
if P -q -f "$RODADA/canon.sql" > "$RODADA/r1.log" 2>&1; then
  ok "R1 canônica aplicou sobre o predecessor (TRAVA → PRE → CREATE → PÓS, ON_ERROR_STOP)"
else
  bad "R1 canônica NÃO aplicou: $(grep -m1 -oE '(PRE|POS) FALHOU.{0,90}' "$RODADA/r1.log" || tail -c 300 "$RODADA/r1.log")"
  cat "$RODADA/r1.log"
  # Recusar não basta: o estado anterior tem de ter ficado INTEIRO (rollback), visto de fora.
  eq "R1b recusa com rollback integral: corpo, oid, dono, ACL, atributos e trigger iguais aos de antes" "$(estado)" "$antes"
fi
eq "R2 md5(prosrc) depois do restore = o da PROD" "$(md5vivo)" "$PROD_MD5"
eq "R3 contrato fora do prosrc (SECDEF|VOLATILE|não-STRICT|search_path vazio|trigger|plpgsql)" \
   "$(contrato)" 'true|v|false|search_path=""|trigger|plpgsql'
xmin1="$(Pq -c "SELECT xmin FROM pg_proc WHERE oid = to_regprocedure('public.analytics_outbox_pedido_compra()');")"
est1="$(estado)"
if P -q -f "$RODADA/canon.sql" > "$RODADA/r4.log" 2>&1; then ok "R4 reaplicar é seguro (a PRE aceita 'este')"; else bad "R4 reaplicar falhou: $(tail -c 300 "$RODADA/r4.log")"; fi
xmin2="$(Pq -c "SELECT xmin FROM pg_proc WHERE oid = to_regprocedure('public.analytics_outbox_pedido_compra()');")"
eq "R5 reaplicar: o CREATE rodou de novo (xmin novo) e corpo, oid, dono, ACL e trigger não mudaram" \
   "$([ "$xmin1" != "$xmin2" ] && echo novo || echo igual)|$(estado)" "novo|$est1"
# ACL mais RESTRITA que a default (revogação de emergência) sobrevive: a canônica não normaliza.
P -q -c "REVOKE EXECUTE ON FUNCTION public.analytics_outbox_pedido_compra() FROM PUBLIC, anon, authenticated;" >/dev/null
acl1="$(Pq -c "SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.analytics_outbox_pedido_compra()');")"
P -q -f "$RODADA/canon.sql" > "$RODADA/r6.log" 2>&1 || bad "R6 reaplicar com ACL restrita falhou: $(tail -c 300 "$RODADA/r6.log")"
eq "R6 ACL restrita preservada pelo reaplicar (PUBLIC continua sem EXECUTE)" \
   "$(Pq -c "SELECT proacl::text = '$acl1' AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM pg_proc WHERE oid = to_regprocedure('public.analytics_outbox_pedido_compra()');")" "t"

# ── C: comportamento do corpo restaurado (o mesmo funil do envelope) ─────────────────────────
echo "-- grupo C: comportamento do corpo restaurado --"
P -q -c "INSERT INTO public.pedido_compra_sugerido (id) VALUES (101);" >/dev/null
eq "C1 INSERT sem aprovação: só criada" "$(linhas 101)|$(evento 101 sugestao_criada)" "1|1"
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, status, aprovado_por, aprovado_em, condicao_origem) VALUES (102, 'aprovado_aguardando_disparo', 'u', now(), 'importado_portal');" >/dev/null
eq "C2 INSERT já aprovado (importação do portal): criada E aprovada" \
   "$(linhas 102)|$(evento 102 sugestao_criada)|$(evento 102 sugestao_aprovada)" "2|1|1"
P -q -c "UPDATE public.pedido_compra_sugerido SET aprovado_em = now(), aprovado_por = 'u', status = 'aprovado_aguardando_disparo' WHERE id = 101;" >/dev/null
eq "C3 UPDATE que aprova: aprovada" "$(linhas 101)|$(evento 101 sugestao_aprovada)" "2|1"
P -q -c "UPDATE public.pedido_compra_sugerido SET status = 'cancelado' WHERE id = 101;" >/dev/null
eq "C4 UPDATE cancelado (sistema): cancelada, origem sistema" \
   "$(Pq -c "SELECT props->>'origem_cancelamento' FROM public.analytics_outbox WHERE chave_dedup = 'pcs:101:reposicao.sugestao_cancelada';")" "sistema"
P -q -c "UPDATE public.pedido_compra_sugerido SET atualizado_em = now() WHERE id = 101;" >/dev/null
eq "C5 UPDATE sem transição: nenhuma linha nova" "$(linhas 101)" "3"
P -q -c "UPDATE public.pedido_compra_sugerido SET status = 'expirado_sem_aprovacao' WHERE id = 102;" >/dev/null
eq "C6 UPDATE expirado: expirada" "$(evento 102 sugestao_expirada)" "1"
P -q -c "ALTER TABLE public.analytics_outbox ADD CONSTRAINT sabot_fail_open CHECK (evento <> 'reposicao.sugestao_aprovada') NOT VALID;" >/dev/null
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, status, aprovado_por, aprovado_em) VALUES (103, 'aprovado_aguardando_disparo', 'u', now());" > "$RODADA/failopen.log" 2>&1
# A marca é a do PRÓPRIO RAISE (independe de lc_messages: 'WARNING' em C, 'AVISO' em pt_BR).
eq "C7 FAIL-OPEN: outbox recusando, o pedido ainda nasce e o aviso [analytics_outbox] sai" \
   "$(Pq -c "SELECT count(*) FROM public.pedido_compra_sugerido WHERE id = 103;")|$(grep -c '\[analytics_outbox\] evento(s) reposicao' "$RODADA/failopen.log")" "1|1"
P -q -c "ALTER TABLE public.analytics_outbox DROP CONSTRAINT sabot_fail_open;" >/dev/null

# ── P: o caminho da PROD (cadeia + envelope) e a canônica por cima ───────────────────────────
echo "-- grupo P: prod (cadeia + envelope) e a canônica por cima --"
if DB=prod P -q -f "$ENV" > "$RODADA/p0.log" 2>&1; then ok "P1 envelope aplicou (é o que a prod rodou em 2026-10-18)"; else bad "P1 envelope não aplicou: $(tail -c 300 "$RODADA/p0.log")"; fi
eq "P2 md5 da 'prod' simulada = constante medida na PROD" "$(DB=prod md5vivo)" "$PROD_MD5"
if DB=prod P -q -f "$CANON" > "$RODADA/p3.log" 2>&1; then ok "P3 canônica (arquivo REAL) aplica sobre a prod"; else bad "P3 canônica não aplicou sobre a prod: $(tail -c 300 "$RODADA/p3.log")"; fi
eq "P4 canônica sobre a prod é no-op de corpo e de contrato" "$(DB=prod md5vivo)|$(DB=prod contrato)" "$PROD_MD5|true|v|false|search_path=\"\"|trigger|plpgsql"
eq "P5 os dois caminhos (restore e prod) terminam no MESMO corpo" "$(md5vivo)" "$(DB=prod md5vivo)"

echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL ==="
[ "$FAIL" -eq 0 ]
