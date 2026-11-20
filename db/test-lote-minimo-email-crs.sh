#!/usr/bin/env bash
# PROVA PG17 — Fase 2a do lote mínimo Sayerlack: e-mail ao CRS + cobrança (20261120190000_lote_minimo_email_crs.sql)
#
#   I  a migration aplica com a postcondição OK (I0) e re-aplicar é seguro (I1)
#   B  o pedido 4557 (e-mail enviado À MÃO) vira registro manual, ledger email_enviado, nunca elegível (B1-B3)
#   A  autorizar: só pedido sucesso_portal com protocolo e conjunto completo (A1-A5)
#   R  reservar devolve assunto do founder e itens por LEFT JOIN (R1-R3)
#   C  duas sessões reservando ao mesmo tempo → 1 só reserva (C1-C2)
#   K  confirmar: token errado = zero efeito; certo = ledger + alerta; repetir = idempotente; nunca 2º envio (K1-K6)
#   F  falha 4xx libera com backoff, 3ª bloqueia; indeterminado nunca libera (F1-F7)
#   P  reserva presa > 30 min → indeterminado + alerta; confirmação tardia ainda grava a verdade (P1-P3)
#   V  vencida: 1 dia útil, feriado, 08:00 SP, independente do TimeZone da sessão (V1-V8)
#   Q  cobrança 1 por e-mail no thread, 2ª só alerta, alertas sem duplicar (Q1-Q6)
#   S  resposta da Sayerlack na caixa suspende a cobrança; remetente de fora não conta (S1-S3)
#   M  o manual (sem thread) cobra só por alerta (M1-M3)
#   W  caixa sem cobertura = só alerta (W1); write-once e DELETE proibido (W2-W3)
#   G  privilégios: só service_role executa; staff lê; authenticated não escreve; anon não lê (G1-G4)
#   X  varredor: ajuste sem autorização e autorização parada alertam UMA vez; item tardio bloqueia (X1-X4)
#   J  o comando do cron só chama a edge quando há pendente (J1-J2)
#
# Uso: bash db/test-lote-minimo-email-crs.sh               # suíte
#      bash db/test-lote-minimo-email-crs.sh --falsificar  # controle + cada sabotagem tem de ficar vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5901}"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG1="$REPO_ROOT/supabase/migrations/20261119130000_pedido_portal_ajuste_qtde.sql"
MIG="${MIG_EMAIL_CRS:-$REPO_ROOT/supabase/migrations/20261120190000_lote_minimo_email_crs.sql}"
TOTAL_ESPERADO=75

# ── --falsificar: controle VERDE na mesma invocação, depois cada sabotagem (uma camada por vez) tem de acusar.
# Formato <nome>:<VERMELHOS>[:<VERDES>]; `ID!MARCA` exige a marca do motivo no vermelho.
SABOTAGENS="sem_skip_locked:C1:C2 sem_skip_locked_so:C3:C1 sem_backfill:I0!B6 sem_tz:V6:V7 sem_feriado:V1:V2
            authenticated_executa:I0!B3 sem_write_once:W2:K2 confirma_sem_token:K1:B1
            resposta_cega:S1:Q2 caixa_ignorada:W1:Q2 sem_dedupe:X1:Q3 atraso_nao_desarma:X5:X2 cobranca_atraso_nao_desarma:Q7:Q3
            sem_cancelado:CX1,CX2:S3 protocolo_substring:S4:S1"
if [ "${1:-}" = "--falsificar" ]; then
  falhas=0
  rodar() {  # <nome> <porta> → as linhas de veredito do filho
    PGPORT_TEST="$2" SABOTAGEM="$1" bash "$0" 2>&1 | grep -E '^(RESUMO|VERDE|VERMELHO|ERRO)' || true
  }
  ctl="$(rodar "" 5902)"
  if ! grep -q "^RESUMO verdes=$TOTAL_ESPERADO vermelhos=0$" <<<"$ctl"; then
    echo "CONTROLE NÃO VERDE — falsificação inválida:"; printf '%s\n' "$ctl"; exit 1
  fi
  echo "controle: $TOTAL_ESPERADO/$TOTAL_ESPERADO verdes"
  porta=5903
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    out="$(rodar "$sab" "$porta")"; porta=$((porta + 1))
    motivo=""
    grep -q '^RESUMO ' <<<"$out" || motivo="$motivo o filho não chegou ao RESUMO (abortou antes de provar);"
    for decl in ${verm//,/ }; do
      id="${decl%%!*}"; marca=""
      [ "$id" = "$decl" ] || marca="${decl#*!}"
      linha_v="$(printf '%s\n' "$out" | grep -m1 "^VERMELHO $id " || true)"
      if [ -z "$linha_v" ]; then motivo="$motivo $id deveria ficar VERMELHO;"
      elif [ -n "$marca" ] && ! grep -qF "$marca" <<<"$linha_v"; then motivo="$motivo $id vermelho sem a marca [$marca];"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -q "^VERDE $id\$" <<<"$out" || motivo="$motivo $id deveria seguir VERDE (linha VERDE ausente);"
    done
    if [ -z "$motivo" ]; then echo "sabotagem $sab: tem dente ($verm)"; else falhas=$((falhas + 1)); echo "sabotagem $sab:$motivo"; printf '%s\n' "$out"; fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "FALSIFICACAO-OK"; exit 0; fi
  echo "FALSIFICACAO REPROVOU: $falhas sabotagem(ns) sem dente"; exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-email-crs.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q() { Pdb -At -q -c "$1" 2>&1 | tail -n 1; }

trocar() {  # <entrada> <saída> <de> <para> — o padrão tem de ocorrer EXATAMENTE 1x (troca que não pegou é erro)
  python3 - "$@" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(de) != 1:
    sys.exit('padrao ocorre %dx (esperado 1): %r' % (s.count(de), de))
open(dst, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';"
Pdb -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS private;
-- Formas medidas na PROD por psql-ro (2026-11-20): só as colunas que a migration lê/escreve.
CREATE TABLE public.pedido_compra_sugerido (id bigint PRIMARY KEY, empresa text, status text, status_envio_portal text,
  portal_protocolo text, portal_situacao_texto text, portal_situacao_codigo text);
CREATE TABLE public.pedido_compra_item (id bigint PRIMARY KEY, sku_descricao text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text, tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL, mensagem text, status text DEFAULT 'pendente_notificacao'
    CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  metadata jsonb, criado_em timestamptz DEFAULT now(),
  CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente',
                  'oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo',
                  'reposicao_pedido_minimo')));
CREATE TABLE public.calendario_feriados (data date, nome text, tipo text);
INSERT INTO public.calendario_feriados VALUES ('2026-11-20','Consciência Negra','nacional'), ('2026-12-25','Natal','nacional');
CREATE TABLE public.gmail_webhook_log (id bigserial PRIMARY KEY, remetente text, subject text, received_at timestamptz, recebido_em timestamptz DEFAULT now());
-- pg_cron / pg_net / vault: o mínimo para a migration agendar e o harness EXECUTAR o comando agendado.
CREATE SEQUENCE IF NOT EXISTS cron.jobid_seq;
CREATE OR REPLACE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_nome;
  IF v IS NULL THEN
    INSERT INTO cron.job (jobid, schedule, command, username, active, jobname)
    VALUES (nextval('cron.jobid_seq'), p_sched, p_cmd, current_user, true, p_nome) RETURNING jobid INTO v;
  ELSE
    UPDATE cron.job SET schedule = p_sched, command = p_cmd, username = current_user WHERE jobid = v;
  END IF;
  RETURN v;
END $f$;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net.chamadas (id bigserial, url text, body jsonb, timeout_ms int);
CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}', body jsonb DEFAULT '{}',
  timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net.chamadas (url, body, timeout_ms) VALUES (url, body, timeout_milliseconds) RETURNING id $f$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'segredo-de-teste');
-- O Supabase concede tudo em objeto novo a anon/authenticated por default: a migration tem de REVOGAR.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
INSERT INTO public.user_roles (user_id, role) VALUES ('a0000000-0000-4000-8000-000000000001', 'employee');
SQL
Pdb -q -f "$MIG1" >/dev/null
# Semente igual à PROD antes da migration: pedido 4557 / ledger id 1, e-mail já enviado à mão.
Pdb -q <<'SQL'
INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_protocolo) VALUES (4557, 'OBEN', 'disparado', 'sucesso_portal', '2152582');
INSERT INTO public.pedido_portal_ajuste_qtde (id, pedido_id, pedido_item_id, empresa, sku_portal, sku_codigo_omie, qtde_omie,
  qtde_portal_necessaria, qtde_portal_lancada, lote_minimo, portal_protocolo, status_envio)
  VALUES (1, 4557, 23234, 'OBEN', 'YO20.1464.00BB', '8689961508', 1, 1, 20, 20, '2152582', 'sucesso_portal');
SELECT setval(pg_get_serial_sequence('public.pedido_portal_ajuste_qtde', 'id'), 1000);
SQL

verdes=0; vermelhos=0
ok() {  # <id> <esperado> <obtido>
  if [ "$2" = "$3" ]; then verdes=$((verdes + 1)); echo "VERDE $1"; else vermelhos=$((vermelhos + 1)); echo "VERMELHO $1 esperado=[$2] obtido=[$3]"; fi
}

# ── I — a migration (real ou sabotada) aplica e re-aplica ──
MIG_USADA="$MIG"
case "$SABOTAGEM" in
  sem_skip_locked) trocar "$MIG" "$TMPD/m.sql" 'ORDER BY x.autorizado_em, x.pedido_id
     LIMIT 1 FOR UPDATE SKIP LOCKED;' 'ORDER BY x.autorizado_em, x.pedido_id
     LIMIT 1;' ;;
  sem_skip_locked_so) trocar "$MIG" "$TMPD/m.sql" 'ORDER BY x.autorizado_em, x.pedido_id
     LIMIT 1 FOR UPDATE SKIP LOCKED;' 'ORDER BY x.autorizado_em, x.pedido_id
     LIMIT 1 FOR UPDATE;' ;;
  atraso_nao_desarma) trocar "$MIG" "$TMPD/m.sql" "    UPDATE public.pedido_portal_ajuste_email
       SET bloqueado_em = p_agora, bloqueio_motivo = 'não saiu em 30 min: entregue ao founder'
     WHERE pedido_id = r.pedido_id;" "" ;;
  cobranca_atraso_nao_desarma) trocar "$MIG" "$TMPD/m.sql" "(senão saem 2 cobranças).
      UPDATE public.pedido_portal_ajuste_email SET cobranca1_alerta_em = p_agora, cobranca1_modo = 'alerta'
       WHERE pedido_id = r.pedido_id;" "(senão saem 2 cobranças)." ;;
  sem_cancelado) trocar "$MIG" "$TMPD/m.sql" "                   AND (p.status IN ('cancelado', 'cancelado_humano', 'expirado_sem_aprovacao')
                        OR p.portal_situacao_codigo = '6'
                        OR coalesce(p.portal_situacao_texto, '') ILIKE '%cancel%'))" "                   AND false)" ;;
  protocolo_substring) trocar "$MIG" "$TMPD/m.sql" "OR (p_protocolo ~ '^[0-9]+\$' AND coalesce(g.subject, '') ~ ('(^|[^0-9])' || p_protocolo || '([^0-9]|\$)'))" "OR strpos(coalesce(g.subject, ''), p_protocolo) > 0" ;;
  sem_backfill) trocar "$MIG" "$TMPD/m.sql" " WHERE a.id = 1 AND a.pedido_id = 4557 AND a.portal_protocolo = '2152582'" " WHERE false AND a.id = 1 AND a.pedido_id = 4557 AND a.portal_protocolo = '2152582'" ;;
  sem_tz) trocar "$MIG" "$TMPD/m.sql" "v_ef := (p_inicio AT TIME ZONE 'America/Sao_Paulo')::date;" "v_ef := p_inicio::date;" ;;
  sem_feriado) trocar "$MIG" "$TMPD/m.sql" "     AND NOT EXISTS (SELECT 1 FROM public.calendario_feriados f WHERE f.data = p_dia)" "" ;;
  authenticated_executa) trocar "$MIG" "$TMPD/m.sql" "REVOKE ALL ON FUNCTION public.ajuste_lote_email_reservar(text, timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.ajuste_lote_email_reservar(text, timestamptz) FROM PUBLIC, anon;" ;;
  confirma_sem_token) trocar "$MIG" "$TMPD/m.sql" "    IF e.reserva_token IS DISTINCT FROM p_token THEN RETURN 'token_invalido'; END IF;
    IF e.enviado_em IS NOT NULL THEN" "    IF e.enviado_em IS NOT NULL THEN" ;;
esac
[ -f "$TMPD/m.sql" ] && MIG_USADA="$TMPD/m.sql"
if Pdb -q -f "$MIG_USADA" >"$TMPD/i0.log" 2>&1 && grep -q "lote_minimo_email_crs OK" "$TMPD/i0.log"; then ok I0 aplicou aplicou; else ok I0 aplicou "falhou: $(grep -m1 -E 'ERRO|ERROR|EXCEPTION' "$TMPD/i0.log" | cut -c1-400)"; fi
case "$SABOTAGEM" in sem_backfill|authenticated_executa)  # sabotagem de postcondição: só o I0 importa
  echo "RESUMO verdes=$verdes vermelhos=$vermelhos"; exit 0 ;;
esac
if Pdb -q -f "$MIG_USADA" >"$TMPD/i1.log" 2>&1 && grep -q "lote_minimo_email_crs OK" "$TMPD/i1.log"; then ok I1 reaplicou reaplicou; else ok I1 reaplicou falhou; fi

# ── sabotagens de COMPORTAMENTO, aplicadas no banco depois da migration ──
case "$SABOTAGEM" in
  sem_write_once) Pdb -q -c "DROP TRIGGER trg_ajuste_email_write_once ON public.pedido_portal_ajuste_email;" ;;
  resposta_cega) Pdb -q -c "CREATE OR REPLACE FUNCTION private._ajuste_lote_resposta_log(p_pedido_id bigint, p_protocolo text, p_desde timestamptz, p_agora timestamptz) RETURNS bigint LANGUAGE sql AS 'SELECT NULL::bigint';" ;;
  caixa_ignorada) Pdb -q -c "CREATE OR REPLACE FUNCTION private._ajuste_lote_caixa_coberta(p_agora timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT true';" ;;
  sem_dedupe) Pdb -q -c "ALTER TABLE public.pedido_portal_ajuste_email_alerta DROP CONSTRAINT pedido_portal_ajuste_email_alerta_pkey;" ;;
  ""|sem_skip_locked|sem_skip_locked_so|sem_tz|sem_feriado|confirma_sem_token|atraso_nao_desarma|cobranca_atraso_nao_desarma|sem_cancelado|protocolo_substring) ;;
  *) echo "ERRO sabotagem desconhecida: $SABOTAGEM"; exit 1 ;;
esac

ALERTAS() { Q "SELECT count(*) FROM public.fornecedor_alerta WHERE metadata->>'pedido_id' = '$1' AND metadata->>'etapa' = '$2'"; }
RES() { Q "SELECT coalesce(public.ajuste_lote_email_reservar('$1', ${2:-now()})::text, 'NULL')"; }
ACAO() { Q "SELECT coalesce(public.ajuste_lote_email_reservar('$1', ${2:-now()})->>'acao', 'NULL')"; }
fixa() {  # <pedido> <coluna> <valor> — fixture de tempo, contornando o write-once só no SETUP
  Pdb -q -c "ALTER TABLE public.pedido_portal_ajuste_email DISABLE TRIGGER USER;
             UPDATE public.pedido_portal_ajuste_email SET $2 = $3 WHERE pedido_id = $1;
             ALTER TABLE public.pedido_portal_ajuste_email ENABLE TRIGGER USER;"
}
ledger() {  # <pedido> <item> <protocolo> [status_envio]
  Pdb -q -c "INSERT INTO public.pedido_portal_ajuste_qtde (pedido_id, pedido_item_id, empresa, sku_portal, qtde_omie,
    qtde_portal_necessaria, qtde_portal_lancada, lote_minimo, portal_protocolo, status_envio)
    VALUES ($1, $2, 'OBEN', 'SKU$2', 1, 1, 20, 20, $3, '${4:-sucesso_portal}');"
}
agora_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
pedido() {  # <id> <status_envio_portal> <protocolo>
  Pdb -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_protocolo) VALUES ($1, 'OBEN', 'disparado', '$2', $3);"
}

# ── J (antes de tudo) / B — backfill do manual ──
CMD_ENVIAR="$(Pdb -At -q -c "SELECT command FROM cron.job WHERE jobname = 'ajuste-lote-email-enviar'")"
Pdb -q -c "$CMD_ENVIAR" >/dev/null
ok J1 0 "$(Q "SELECT count(*) FROM net.chamadas")"
ok B1 "manual|2152582|{1}" "$(Q "SELECT origem || '|' || portal_protocolo || '|' || ajuste_ids::text FROM public.pedido_portal_ajuste_email WHERE pedido_id = 4557")"
ok B2 email_enviado "$(Q "SELECT status FROM public.pedido_portal_ajuste_qtde WHERE id = 1")"
ok B3 NULL "$(RES inicial)"

# ── A — autorizar ──
pedido 100 sucesso_portal "'123'"; ledger 100 9001 "'123'"; ledger 100 9002 "'123'"
Pdb -q -c "INSERT INTO public.pedido_compra_item VALUES (9001, 'VERNIZ PU');"   # 9002 sem item: LEFT JOIN
pedido 101 indeterminado_requer_conciliacao "'124'"; ledger 101 9101 "'124'" indeterminado_requer_conciliacao
pedido 102 sucesso_portal "'222'"; ledger 102 9201 "'222'"; ledger 102 9202 "'222'"
ok A1 autorizado "$(Q "SELECT public.ajuste_lote_email_autorizar(100, '123', 2)")"
ok A2 ja_autorizado "$(Q "SELECT public.ajuste_lote_email_autorizar(100, '123', 2)")"
ok A3 recusado:pedido_nao_sucesso_portal "$(Q "SELECT public.ajuste_lote_email_autorizar(101, '124', 1)")"
ok A4 recusado:conjunto_divergente "$(Q "SELECT public.ajuste_lote_email_autorizar(102, '222', 1)")"
ok A5 recusado:protocolo_invalido "$(Q "SELECT public.ajuste_lote_email_autorizar(102, NULL, 2)")"

Pdb -q -c "$CMD_ENVIAR" >/dev/null
ok J2 "1|enviar|120000" "$(Q "SELECT count(*) || '|' || max(body->>'modo') || '|' || max(timeout_ms) FROM net.chamadas")"

# ── C — concorrência: a sessão 1 reserva e segura a transação; a sessão 2 tenta no meio ──
Pdb -At -q -c "BEGIN; SELECT public.ajuste_lote_email_reservar('inicial')->>'acao'; SELECT pg_sleep(3); COMMIT;" >"$TMPD/s1.out" 2>&1 &
S1PID=$!
sleep 1
T0="$(agora_ms)"
S2="$(ACAO inicial)"
DT=$(( $(agora_ms) - T0 ))
wait "$S1PID" || true
ok C1 NULL "$S2"
# SKIP LOCKED: a 2ª sessão não ESPERA a 1ª (sem ele, FOR UPDATE espera o commit e só então devolve NULL)
ok C3 rapido "$([ "$DT" -lt 1500 ] && echo rapido || echo "esperou ${DT}ms")"
ok C2 enviar "$(grep -m1 -E '^(enviar|NULL|bloqueado)$' "$TMPD/s1.out" || echo "s1: $(tr '\n' ' ' <"$TMPD/s1.out" | cut -c1-200)")"

# ── R — o que a reserva devolveu (relido do banco: token, assunto, itens) ──
TOKEN="$(Q "SELECT reserva_token FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100")"
ok R1 "Alteração de quantidade — Pedido Sayerlack 123 [AFI-100]" "$(Q "SELECT assunto FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100")"
ok R2 "<afi-100-$TOKEN@afiacao.sardenberg>" "$(Q "SELECT rfc_message_id_proposto FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100")"
ok R3 NULL "$(RES inicial)"

# ── K — confirmar ──
ok K1 "token_invalido|0" "$(Q "SELECT public.ajuste_lote_email_confirmar('inicial', 100, gen_random_uuid(), 'g1', 't1') || '|' || (SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100 AND enviado_em IS NOT NULL)")"
ok K2 confirmado "$(Q "SELECT public.ajuste_lote_email_confirmar('inicial', 100, '$TOKEN', 'g1', 't1')")"
ok K3 "2" "$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_qtde WHERE pedido_id = 100 AND status = 'email_enviado'")"
ok K4 1 "$(ALERTAS 100 enviado)"
ok K5 "ja_confirmado|1" "$(Q "SELECT public.ajuste_lote_email_confirmar('inicial', 100, '$TOKEN', 'g1', 't1') || '|' || (SELECT count(*) FROM public.fornecedor_alerta WHERE metadata->>'pedido_id' = '100' AND metadata->>'etapa' = 'enviado')")"
ok K6 NULL "$(RES inicial)"
ok K7 "rfc_invalido|registrado|ignorado" "$(Q "SELECT public.ajuste_lote_email_registrar_rfc(100, '$TOKEN', 'sem-forma')")|$(Q "SELECT public.ajuste_lote_email_registrar_rfc(100, '$TOKEN', '<real-100@mail.gmail.com>')")|$(Q "SELECT public.ajuste_lote_email_registrar_rfc(100, '$TOKEN', '<outro@x>')")"

# ── F — falhas ──
pedido 103 sucesso_portal "'333'"; ledger 103 9301 "'333'"
Q "SELECT public.ajuste_lote_email_autorizar(103, '333', 1)" >/dev/null
T103="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
ok F1 liberado "$(Q "SELECT public.ajuste_lote_email_falhou('inicial', 103, '$T103', 'nao_enviado', 'HTTP 429', 60)")"
ok F2 NULL "$(RES inicial)"
T103="$(Q "SELECT public.ajuste_lote_email_reservar('inicial', now() + interval '1 hour')->>'token'")"
ok F3 liberado "$(Q "SELECT public.ajuste_lote_email_falhou('inicial', 103, '$T103', 'nao_enviado', 'HTTP 400', NULL)")"
T103="$(Q "SELECT public.ajuste_lote_email_reservar('inicial', now() + interval '2 hours')->>'token'")"
ok F4 bloqueado "$(Q "SELECT public.ajuste_lote_email_falhou('inicial', 103, '$T103', 'nao_enviado', 'HTTP 403', NULL)")"
pedido 104 sucesso_portal "'444'"; ledger 104 9401 "'444'"
Q "SELECT public.ajuste_lote_email_autorizar(104, '444', 1)" >/dev/null
T104="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
ok F5 indeterminado "$(Q "SELECT public.ajuste_lote_email_falhou('inicial', 104, '$T104', 'indeterminado', 'timeout', NULL)")"
ok F6 NULL "$(RES inicial "now() + interval '30 days'")"
ok F7 "1|1" "$(ALERTAS 104 indeterminado)|$(ALERTAS 103 bloqueado)"
ok F8 token_invalido "$(Q "SELECT public.ajuste_lote_email_falhou('inicial', 104, NULL, 'indeterminado', 'x', NULL)")"

# ── P — reserva presa (Gmail aceitou, processo caiu antes de confirmar) ──
pedido 111 sucesso_portal "'1111'"; ledger 111 9111 "'1111'"
Q "SELECT public.ajuste_lote_email_autorizar(111, '1111', 1)" >/dev/null
T111="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
Q "SELECT private.ajuste_lote_email_ciclo(now() + interval '31 minutes')" >/dev/null
ok P1 "1|1" "$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 111 AND indeterminado_em IS NOT NULL")|$(ALERTAS 111 indeterminado)"
ok P2 NULL "$(RES inicial "now() + interval '30 days'")"
ok P3 confirmado "$(Q "SELECT public.ajuste_lote_email_confirmar('inicial', 111, '$T111', 'g111', 't111')")"
fixa 111 enviado_em "'2027-06-01 17:00+00'"   # tira do caminho das cobranças com data fixa abaixo

# ── V — vencida (rodada em 3 TimeZones de sessão; o resultado não pode mudar) ──
V() {  # <inicio> <agora> → t/f igual nas 3 zonas, senão DIVERGE
  local a b c
  a="$(Q "SET TimeZone='UTC'; SELECT private._ajuste_lote_cobranca_vencida('$1'::timestamptz, '$2'::timestamptz)")"
  b="$(Q "SET TimeZone='Asia/Tokyo'; SELECT private._ajuste_lote_cobranca_vencida('$1'::timestamptz, '$2'::timestamptz)")"
  c="$(Q "SET TimeZone='America/Sao_Paulo'; SELECT private._ajuste_lote_cobranca_vencida('$1'::timestamptz, '$2'::timestamptz)")"
  if [ "$a" = "$b" ] && [ "$b" = "$c" ]; then echo "$a"; else echo "DIVERGE:$a/$b/$c"; fi
}
ok V1 f "$(V '2026-11-19 17:00+00' '2026-11-20 11:05+00')"   # qui → sex feriado
ok V2 t "$(V '2026-11-19 17:00+00' '2026-11-23 11:05+00')"   # qui → seg
ok V3 f "$(V '2026-11-20 17:24+00' '2026-11-23 11:05+00')"   # enviado no feriado: conta de seg; seg ainda não
ok V4 t "$(V '2026-11-20 17:24+00' '2026-11-24 11:05+00')"   # … ter sim
ok V5 f "$(V '2026-11-20 17:24+00' '2026-11-24 10:55+00')"   # ter 07:55 SP: antes das 08:00
ok V6 t "$(V '2026-11-27 02:30+00' '2026-11-27 11:05+00')"   # qui 23:30 SP → sex 08:05 SP
ok V7 f "$(V '2026-11-28 15:00+00' '2026-11-30 12:00+00')"   # sáb → seg ainda não
ok V8 t "$(V '2026-11-28 15:00+00' '2026-12-01 12:00+00')"   # … ter sim

# ── Q — cobrança do pedido 100 (enviado qui 26/11 14:00 SP; caixa coberta) ──
fixa 100 enviado_em "'2026-11-26 17:00+00'"
Pdb -q -c "INSERT INTO public.gmail_webhook_log (remetente, subject, recebido_em) VALUES ('lucas@gmail.com', 'outra coisa', '2026-11-27 10:00+00');"
ok Q1 NULL "$(RES cobranca1 "'2026-11-27 10:00+00'")"
C100="$(RES cobranca1 "'2026-11-27 11:05+00'")"
ok Q2 "enviar|t1|Alteração de quantidade — Pedido Sayerlack 123 [AFI-100]|<real-100@mail.gmail.com>" "$(Q "SELECT (j->>'acao') || '|' || (j->>'thread_id') || '|' || (j->>'assunto') || '|' || (j->>'in_reply_to') FROM (SELECT '$C100'::jsonb j) s")"
TC="$(Q "SELECT '$C100'::jsonb->>'token'")"
ok Q3 "confirmado|1" "$(Q "SELECT public.ajuste_lote_email_confirmar('cobranca1', 100, '$TC', 'gc1', 't1')")|$(ALERTAS 100 cobranca1)"
fixa 100 cobranca1_enviada_em "'2026-11-27 11:06+00'"   # relógio fixo: a suíte não depende do dia em que roda
Pdb -q -c "INSERT INTO public.gmail_webhook_log (remetente, subject, recebido_em) VALUES ('lucas@gmail.com', 'outra coisa', '2026-11-30 10:00+00');"
Q "SELECT private.ajuste_lote_email_ciclo('2026-11-30 11:05+00')" >/dev/null
ok Q4 "1|1" "$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100 AND cobranca2_alerta_em IS NOT NULL")|$(ALERTAS 100 cobranca2)"
ok Q5 NULL "$(RES cobranca1 "'2026-12-01 11:05+00'")"
Q "SELECT private.ajuste_lote_email_ciclo('2026-12-01 11:05+00')" >/dev/null
ok Q6 "1|1|1" "$(ALERTAS 100 cobranca1)|$(ALERTAS 100 cobranca2)|$(ALERTAS 100 enviado)"

# ── S — resposta da Sayerlack suspende a cobrança ──
for p in 105 106; do
  pedido $p sucesso_portal "'${p}5'"; ledger $p "9${p}" "'${p}5'"
  Q "SELECT public.ajuste_lote_email_autorizar($p, '${p}5', 1)" >/dev/null
  T="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
  Q "SELECT public.ajuste_lote_email_confirmar('inicial', $p, '$T', 'g$p', 't$p')" >/dev/null
  fixa $p enviado_em "'2026-11-26 17:00+00'"
done
Pdb -q -c "INSERT INTO public.gmail_webhook_log (remetente, subject, recebido_em) VALUES
  ('Fulano CRS <fulano@sayerlack.com.br>', 'RES: Alteração de quantidade — Pedido Sayerlack 1055 [AFI-105]', '2026-11-26 19:00+00'),
  ('lucas@gmail.com', 'Fwd: Alteração de quantidade — Pedido Sayerlack 1065 [AFI-106]', '2026-11-26 19:00+00');"
ok S1 resposta_observada "$(ACAO cobranca1 "'2026-11-27 11:05+00'")"
ok S2 1 "$(ALERTAS 105 resposta)"
ok S4 "NULL|NULL" "$(Pdb -q -c "INSERT INTO public.gmail_webhook_log (remetente, subject, received_at, recebido_em) VALUES ('pedidos@sayerlack.com.br', 'Pedido 10650 implantado', '2026-11-26 19:00+00', '2026-11-26 19:00+00'), ('pedidos@sayerlack.com.br', 'Pedido 1065 confirmado', '2026-11-26 10:00+00', '2026-11-26 20:00+00');" >/dev/null; Q "SELECT coalesce(private._ajuste_lote_resposta_log(106, '1065', '2026-11-26 17:00+00', '2026-11-27 11:05+00')::text, 'NULL')")|$(Q "SELECT coalesce(private._ajuste_lote_resposta_log(106, '1065', '2026-11-26 17:00+00', '2026-11-26 19:30+00')::text, 'NULL')")"
ok S3 "enviar|106" "$(Q "SELECT (j->>'acao') || '|' || (j->>'pedido_id') FROM (SELECT public.ajuste_lote_email_reservar('cobranca1', '2026-11-27 11:05+00') j) s")"
# cobrança que falha: 429 libera com backoff; depois indeterminado prende e alerta; 3h depois nada de "atrasada" duplicada
T106="$(Q "SELECT cobranca1_token FROM public.pedido_portal_ajuste_email WHERE pedido_id = 106")"
ok FC1 liberado "$(Q "SELECT public.ajuste_lote_email_falhou('cobranca1', 106, '$T106', 'nao_enviado', 'HTTP 429', 60)")"
T106="$(Q "SELECT public.ajuste_lote_email_reservar('cobranca1', '2026-11-27 14:05+00')->>'token'")"
ok FC2 "indeterminado|1" "$(Q "SELECT public.ajuste_lote_email_falhou('cobranca1', 106, '$T106', 'indeterminado', 'HTTP 503', NULL)")|$(ALERTAS 106 cobranca1_indeterminado)"
Q "SELECT private.ajuste_lote_email_ciclo('2026-11-27 18:05+00')" >/dev/null
ok FC3 "NULL|0|0" "$(RES cobranca1 "'2026-11-30 14:05+00'")|$(ALERTAS 106 cobranca1_atrasada)|$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 106 AND cobranca1_enviada_em IS NOT NULL")"

# ── M — o manual (4557, enviado no feriado, sem thread) ──
Q "SELECT private.ajuste_lote_email_ciclo('2026-11-24 11:05+00')" >/dev/null
ok M1 "alerta|1" "$(Q "SELECT cobranca1_modo FROM public.pedido_portal_ajuste_email WHERE pedido_id = 4557")|$(ALERTAS 4557 cobranca1)"
ok M2 0 "$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 4557 AND cobranca1_token IS NOT NULL")"
Q "SELECT private.ajuste_lote_email_ciclo('2026-11-25 11:05+00')" >/dev/null
ok M3 1 "$(ALERTAS 4557 cobranca2)"

# ── W — caixa sem cobertura / write-once ──
pedido 107 sucesso_portal "'1077'"; ledger 107 9107 "'1077'"
Q "SELECT public.ajuste_lote_email_autorizar(107, '1077', 1)" >/dev/null
T="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
Q "SELECT public.ajuste_lote_email_confirmar('inicial', 107, '$T', 'g107', 't107')" >/dev/null
fixa 107 enviado_em "'2027-03-02 17:00+00'"
ok W1 so_alerta "$(ACAO cobranca1 "'2027-03-03 11:05+00'")"   # último log da caixa é de 2026
ok W2 "SQLSTATE:P0001" "$(Pdb -q -c "DO \$\$ BEGIN UPDATE public.pedido_portal_ajuste_email SET enviado_em = now() WHERE pedido_id = 100; RAISE NOTICE 'R=PASSOU'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM LIKE 'WRITE_ONCE%' THEN RAISE NOTICE 'R=SQLSTATE:P0001'; ELSE RAISE NOTICE 'R=OUTRO'; END IF; END \$\$;" 2>&1 | grep -o 'R=[^ ]*' | head -1 | cut -c3-)"
ok W3 "DELETE_BARRADO" "$(Pdb -q -c "DO \$\$ BEGIN DELETE FROM public.pedido_portal_ajuste_email WHERE pedido_id = 100; RAISE NOTICE 'R=DELETE_PASSOU'; EXCEPTION WHEN SQLSTATE 'P0001' THEN RAISE NOTICE 'R=DELETE_BARRADO'; END \$\$;" 2>&1 | grep -o 'R=[A-Z_]*' | head -1 | cut -c3-)"

# ── G — privilégios ──
ok G1 "fffff|ttttt" "$(Q "SELECT string_agg(CASE WHEN has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') THEN 't' ELSE 'f' END, '' ORDER BY f) || '|' || string_agg(CASE WHEN has_function_privilege('service_role', f, 'EXECUTE') THEN 't' ELSE 'f' END, '' ORDER BY f) FROM unnest(ARRAY['public.ajuste_lote_email_autorizar(bigint,text,integer)','public.ajuste_lote_email_reservar(text,timestamptz)','public.ajuste_lote_email_confirmar(text,bigint,uuid,text,text)','public.ajuste_lote_email_registrar_rfc(bigint,uuid,text)','public.ajuste_lote_email_falhou(text,bigint,uuid,text,text,integer)']) f")"
ok G2 "t" "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-000000000001'; SELECT count(*) > 0 FROM public.pedido_portal_ajuste_email")"
ok G3 "SQLSTATE:42501" "$(Pdb -q -c "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-000000000001'; DO \$\$ BEGIN UPDATE public.pedido_portal_ajuste_email SET bloqueado_em = now(); RAISE NOTICE 'R=PASSOU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R=SQLSTATE:42501'; END \$\$;" 2>&1 | grep -o 'R=[^ ]*' | head -1 | cut -c3-)"
ok G4 "SQLSTATE:42501" "$(Pdb -q -c "SET ROLE anon; DO \$\$ BEGIN PERFORM 1 FROM public.pedido_portal_ajuste_email; RAISE NOTICE 'R=PASSOU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R=SQLSTATE:42501'; END \$\$;" 2>&1 | grep -o 'R=[^ ]*' | head -1 | cut -c3-)"

# ── X — varredor ──
pedido 108 indeterminado_requer_conciliacao NULL; ledger 108 9108 NULL indeterminado_requer_conciliacao
pedido 112 sucesso_portal "'1122'"; ledger 112 9112 "'1122'"   # prometeu automático e a autorização não veio
Pdb -q -c "UPDATE public.pedido_portal_ajuste_qtde SET criado_em = now() - interval '2 hours' WHERE pedido_id IN (108, 112);"
pedido 109 sucesso_portal "'1099'"; ledger 109 9109 "'1099'"
Q "SELECT public.ajuste_lote_email_autorizar(109, '1099', 1)" >/dev/null
fixa 109 autorizado_em "now() - interval '2 hours'"
Q "SELECT private.ajuste_lote_email_ciclo(now())" >/dev/null
Q "SELECT private.ajuste_lote_email_ciclo(now() + interval '15 minutes')" >/dev/null
ok X1 "0|1" "$(ALERTAS 108 sem_autorizacao)|$(ALERTAS 112 sem_autorizacao)"   # 108 já recebeu "ACAO: enviar" da Fase 1
ok X2 "1|0" "$(ALERTAS 109 envio_atrasado)|$(ALERTAS 101 sem_autorizacao)"
# P0: o aviso "envie à mão" DESARMA o envio automático na mesma transação
ok X5 "NULL|t" "$(ACAO inicial "now() + interval '1 day'")|$(Q "SELECT bloqueado_em IS NOT NULL FROM public.pedido_portal_ajuste_email WHERE pedido_id = 109")"
pedido 110 sucesso_portal "'1100'"; ledger 110 9110 "'1100'"
Q "SELECT public.ajuste_lote_email_autorizar(110, '1100', 1)" >/dev/null
ledger 110 9119 "'1100'"   # item tardio: conjunto congelado diverge
ok X3 bloqueado "$(ACAO inicial)"
ok X4 "1|0" "$(ALERTAS 110 bloqueado)|$(Q "SELECT count(*) FROM public.pedido_portal_ajuste_email WHERE pedido_id = 110 AND reserva_token IS NOT NULL")"

# ── Q7 — cobrança automática que não saiu em 3h: entrega ao founder e DESARMA ──
pedido 115 sucesso_portal "'1155'"; ledger 115 9115 "'1155'"
Q "SELECT public.ajuste_lote_email_autorizar(115, '1155', 1)" >/dev/null
T="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
Q "SELECT public.ajuste_lote_email_confirmar('inicial', 115, '$T', 'g115', 't115')" >/dev/null
fixa 115 enviado_em "'2027-03-02 17:00+00'"
Pdb -q -c "INSERT INTO public.gmail_webhook_log (remetente, subject, recebido_em) VALUES ('lucas@gmail.com', 'x', '2027-03-03 13:00+00');"
Q "SELECT private.ajuste_lote_email_ciclo('2027-03-03 14:30+00')" >/dev/null   # 11:30 SP: venceu às 08:00, +3h
ok Q7 "1|alerta|NULL" "$(ALERTAS 115 cobranca1_atrasada)|$(Q "SELECT cobranca1_modo FROM public.pedido_portal_ajuste_email WHERE pedido_id = 115")|$(RES cobranca1 "'2027-03-03 14:31+00'")"

# ── CX — pedido cancelado não recebe e-mail nem cobrança ──
pedido 113 sucesso_portal "'1133'"; ledger 113 9113 "'1133'"
Q "SELECT public.ajuste_lote_email_autorizar(113, '1133', 1)" >/dev/null
T="$(Q "SELECT public.ajuste_lote_email_reservar('inicial')->>'token'")"
Q "SELECT public.ajuste_lote_email_confirmar('inicial', 113, '$T', 'g113', 't113')" >/dev/null
fixa 113 enviado_em "'2027-03-02 17:00+00'"
Pdb -q -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '6' WHERE id = 113;"
Q "SELECT private.ajuste_lote_email_ciclo('2027-03-03 11:05+00')" >/dev/null
ok CX1 "NULL|0" "$(Q "SELECT coalesce((SELECT j->>'pedido_id' FROM (SELECT public.ajuste_lote_email_reservar('cobranca1', '2027-03-03 11:06+00') j) s WHERE j->>'pedido_id' = '113'), 'NULL')")|$(ALERTAS 113 cobranca1)"
pedido 116 sucesso_portal "'1166'"; ledger 116 9116 "'1166'"
Q "SELECT public.ajuste_lote_email_autorizar(116, '1166', 1)" >/dev/null
Pdb -q -c "UPDATE public.pedido_compra_sugerido SET status = 'cancelado_humano' WHERE id = 116;"
ok CX2 "bloqueado|pedido cancelado (sistema ou portal)" "$(Q "SELECT (j->>'acao') || '|' || (j->>'motivo') FROM (SELECT public.ajuste_lote_email_reservar('inicial') j) s")"

echo "RESUMO verdes=$verdes vermelhos=$vermelhos"
[ "$vermelhos" -eq 0 ] && [ "$verdes" -eq "$TOTAL_ESPERADO" ]
