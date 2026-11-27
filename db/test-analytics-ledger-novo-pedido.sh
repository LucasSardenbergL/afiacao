#!/usr/bin/env bash
# PROVA PG17 — 20261127100100_analytics_ledger_novo_pedido_funil.sql (Novo Pedido, rodada 3 onda 2, PR 9.1)
#     bash db/test-analytics-ledger-novo-pedido.sh > /tmp/t.log 2>&1; echo "exit=$?"
# (NÃO pipe pra tail — engole o exit≠0.)  Locale: LOCALE_TESTE=pt_BR.UTF-8 roda a mesma prova no outro
# locale (as sentinelas são ASCII, caixa fixa).
#
# Gêmeo de db/test-analytics-ledger-clientes-ficha.sh com a cadeia avançada um elo: base do outbox →
# corpo VIVO da prod (extraído da 20261121231200, md5 4c6e2d58… = o lido via psql-ro em 2026-11-26) →
# esta. Prova que os 11 `novo_pedido.*` gravam, que os antigos seguem, falsifica a PRE e a PÓS e roda a
# query de "quando medir" (db/sensor-novo-pedido-funil.sql) sobre dados semeados.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5493}"
SLUG="analytics-ledger-novo-pedido"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/ (resolve o PGBIN no Mac e no CI)
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
-- Papel COMERCIAL (onda C: o denominador da adoção é por ele). Texto basta: a query só lê o valor.
CREATE TABLE IF NOT EXISTS public.commercial_roles (user_id uuid NOT NULL, commercial_role text NOT NULL);
-- A ponte com o servidor (seção ponte_servidor da query): só as colunas que ela lê.
CREATE TABLE IF NOT EXISTS public.sales_orders (id uuid DEFAULT gen_random_uuid(), checkout_id uuid, account text, omie_pedido_id bigint);
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY, status text NOT NULL, criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(), aprovado_em timestamptz, aprovado_por text,
  cancelado_em timestamptz, condicao_origem text, origem_evento_tipo text
);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true)
  RETURNING jobid;
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; $f$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
-- Supabase dá EXECUTE a PUBLIC por padrão: reproduz para o REVOKE ter trabalho real.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

M_BASE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
M_PRED="$REPO_ROOT/supabase/migrations/20261121231200_analytics_ledger_clientes_ficha_acao.sql"
MIG="$REPO_ROOT/supabase/migrations/20261127100100_analytics_ledger_novo_pedido_funil.sql"
FUNIL="${FUNIL_TESTE:-$REPO_ROOT/db/sensor-novo-pedido-funil.sql}"  # override só p/ falsificar a query
MD5_ESTE="b40dc0f99d2ca61d049593b67acc6d25"
MD5_PRED="4c6e2d58678ba00e2c1d5c14b9c2d88b"

P -q -f "$M_BASE"
# Predecessor = o corpo VIVO de prod (o pg_get_functiondef medido é idêntico a este trecho).
PRED=$(mktemp)
# shellcheck disable=SC2016  # o $ é literal do SQL ($function$), não expansão
sed -n '/^CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar/,/^\$function\$;/p' "$M_PRED" > "$PRED"
P -q -f "$PRED"; rm -f "$PRED"
P -q -c "GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text,text,jsonb) TO anon;"  # o REVOKE tem de tirar
eq "A0 predecessor local = md5 da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "$MD5_PRED"
P -q -1 -f "$MIG"
eq "A1 corpo novo = md5 declarado na migration" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "$MD5_ESTE"
P -q -1 -f "$MIG"
ok "A2 migration aplica 2x sem erro (a PRE aceita este)"

UID_A='11111111-1111-1111-1111-111111111111'   # master (founder testando)
UID_B='22222222-2222-2222-2222-222222222222'   # employee (vendedor)
J1='aaaaaaaa-0000-0000-0000-000000000001'; J2='aaaaaaaa-0000-0000-0000-000000000002'; J3='aaaaaaaa-0000-0000-0000-000000000003'; J4='aaaaaaaa-0000-0000-0000-000000000004'
CK1='cccccccc-0000-0000-0000-000000000001'; CK2='cccccccc-0000-0000-0000-000000000002'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$UID_A'), ('$UID_B') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$UID_A','master'), ('$UID_B','employee');
SQL

js() { printf '{%s}' "$1"; }  # props JSON sem chaves no argumento (o bash expandiria {a,b})
reg() { # $1 uid  $2 evento  $3 chave  $4 props
  Pq -c "SET test.uid='$1'; SET test.role='authenticated'; SELECT public.analytics_ledger_registrar('$2','$3','$4'::jsonb); SELECT count(*) FROM public.analytics_outbox WHERE evento='$2' AND user_id='$1';" | tail -1
}

linha() { printf '%s\n' "$1" | grep -qxF "$2"; }  # linha EXATA: prefixo casaria "4||" dentro de "4||400.0"

echo "── query sem dado (antes de semear): ausente ≠ zero ──"
OUT0=$(P -tA -F'|' -f "$FUNIL" 2>&1)
if linha "$OUT0" "janela|sem dado|sem dado|0|0"; then ok "D0a janela vazia = 'sem dado'"; else bad "D0a janela vazia virou outra coisa"; fi
if linha "$OUT0" "funil|2|cliente|0|0||0"; then ok "D0b etapa sem denominador: pct NULL (nunca 0 nem 100)"; else bad "D0b pct com denominador 0 virou número"; fi
if linha "$OUT0" "FIM_FUNIL_OK"; then ok "D0c terminou (marcador)"; else bad "D0c sem marcador"; fi

echo "── asserts: os 11 novo_pedido.* gravam, os antigos seguem ──"
# J1 (vendedor B): o funil inteiro, com uma tentativa que falha (ERP) e a 2ª que confirma as duas contas.
eq "B1 iniciado"          "$(reg $UID_B novo_pedido.iniciado $J1 "$(js "\"modo\":\"staff\",\"jornada\":\"$J1\"")")" "1"
eq "B2 cliente_escolhido" "$(reg $UID_B novo_pedido.cliente_escolhido $J1 "$(js "\"modo\":\"staff\",\"jornada\":\"$J1\"")")" "1"
eq "B3 primeiro_item"     "$(reg $UID_B novo_pedido.primeiro_item $J1 "$(js "\"modo\":\"staff\",\"jornada\":\"$J1\"")")" "1"
eq "B4 envio_tentado"     "$(reg $UID_B novo_pedido.envio_tentado $J1:t1 "$(js "\"jornada\":\"$J1\",\"contas\":\"oben+colacor\"")")" "1"
eq "B5 envio_falhou"      "$(reg $UID_B novo_pedido.envio_falhou $J1:t1:erp_pendente "$(js "\"jornada\":\"$J1\",\"classe\":\"erp_pendente\",\"checkout_id\":\"$CK1\"")")" "1"
eq "B6 envio_confirmado"  "$(reg $UID_B novo_pedido.envio_confirmado $J1:oben "$(js "\"jornada\":\"$J1\",\"conta\":\"oben\",\"checkout_id\":\"$CK1\"")")" "1"
reg $UID_B novo_pedido.envio_tentado $J1:t2 "$(js "\"jornada\":\"$J1\",\"contas\":\"oben+colacor\"")" >/dev/null
reg $UID_B novo_pedido.envio_confirmado $J1:colacor "$(js "\"jornada\":\"$J1\",\"conta\":\"colacor\",\"checkout_id\":\"$CK1\"")" >/dev/null
eq "B7 ia_analise_pedida"     "$(reg $UID_B novo_pedido.ia_analise_pedida $J1:3 "$(js "\"jornada\":\"$J1\",\"imagens\":1")")" "1"
eq "B8 ia_itens_adicionados"  "$(reg $UID_B novo_pedido.ia_itens_adicionados $J1:4 "$(js "\"jornada\":\"$J1\",\"n\":3")")" "1"
eq "B9 ia_itens_descartados"  "$(reg $UID_B novo_pedido.ia_itens_descartados $J1:5 "$(js "\"jornada\":\"$J1\",\"n\":1")")" "1"
eq "B10 rascunho_restaurado"  "$(reg $UID_B novo_pedido.rascunho_restaurado $J1:6 "$(js "\"jornada\":\"$J1\",\"itens\":2")")" "1"
eq "B11 rascunho_descartado"  "$(reg $UID_B novo_pedido.rascunho_descartado $J2:1 "$(js "\"jornada\":\"$J2\",\"itens\":1")")" "1"
eq "B12 dedup: mesma jornada no mesmo dia = 1 iniciado" "$(reg $UID_B novo_pedido.iniciado $J1 "$(js "\"modo\":\"staff\",\"jornada\":\"$J1\"")")" "1"
# J4 (B): 2º pedido, só Oben, confirma na 1ª — dá ao p50 duas amostras distintas (com uma, p0 = p50).
for EV in iniciado cliente_escolhido primeiro_item; do reg $UID_B novo_pedido.$EV $J4 "$(js "\"modo\":\"staff\",\"jornada\":\"$J4\"")" >/dev/null; done
reg $UID_B novo_pedido.envio_tentado $J4:t1 "$(js "\"jornada\":\"$J4\",\"contas\":\"oben\"")" >/dev/null
reg $UID_B novo_pedido.envio_confirmado $J4:oben "$(js "\"jornada\":\"$J4\",\"conta\":\"oben\",\"checkout_id\":\"$CK2\"")" >/dev/null
# J2 (B) só abriu; J3 (master A) abriu e escolheu cliente.
reg $UID_B novo_pedido.iniciado $J2 "$(js "\"modo\":\"staff\",\"jornada\":\"$J2\"")" >/dev/null
reg $UID_A novo_pedido.iniciado $J3 "$(js "\"modo\":\"staff\",\"jornada\":\"$J3\"")" >/dev/null
reg $UID_A novo_pedido.cliente_escolhido $J3 "$(js "\"modo\":\"staff\",\"jornada\":\"$J3\"")" >/dev/null
eq "B13 clientes.ficha_acao segue gravando" "$(reg $UID_A clientes.ficha_acao 'cadastro:novo_pedido' '{"ficha":"cadastro","tipo":"novo_pedido"}')" "1"
eq "B14 rota_servida segue gravando" "$(reg $UID_A navegacao.rota_servida /sales/new '{"rota":"/sales/new"}')" "1"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$UID_A';
DO \$t\$ BEGIN
  PERFORM public.analytics_ledger_registrar('novo_pedido.qualquer_coisa','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ALLOW_FURADO';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENT_ALLOW_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
case "$R" in *SENT_ALLOW_OK*) ok "B15 evento fora da allowlist rejeitado (22023)";; *) bad "B15 allowlist NAO barrou — [$R]";; esac

V=$(Pq -c "SELECT has_function_privilege('anon', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text || ',' || has_function_privilege('public', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text || ',' || has_function_privilege('authenticated', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text;")
eq "B16 ACL: anon e PUBLIC sem EXECUTE, authenticated com" "$V" "false,false,true"

echo "── query de quando medir (a versionada) sobre os dados semeados ──"
# Tempo determinístico de J1: abriu T0, 1º item T0+2min, confirmou oben T0+10min, colacor T0+30min.
P -q <<SQL
UPDATE public.analytics_outbox SET ocorrido_em = now() - interval '60 min' WHERE props->>'jornada' IN ('$J1','$J2','$J3','$J4');
UPDATE public.analytics_outbox SET ocorrido_em = now() - interval '58 min' WHERE evento='novo_pedido.primeiro_item' AND props->>'jornada' IN ('$J1','$J4');
UPDATE public.analytics_outbox SET ocorrido_em = now() - interval '50 min' WHERE evento='novo_pedido.envio_confirmado' AND props->>'jornada'='$J1' AND props->>'conta'='oben';
UPDATE public.analytics_outbox SET ocorrido_em = now() - interval '30 min' WHERE evento='novo_pedido.envio_confirmado' AND props->>'jornada'='$J1' AND props->>'conta'='colacor';
UPDATE public.analytics_outbox SET ocorrido_em = now() - interval '20 min' WHERE evento='novo_pedido.envio_confirmado' AND props->>'jornada'='$J4';
-- Servidor: só o PV Oben do CK1 existe com omie_pedido_id (o Colacor "confirmado" sem PV = divergência visível).
INSERT INTO public.sales_orders(checkout_id, account, omie_pedido_id) VALUES ('$CK1','oben',123), ('$CK1','colacor',NULL), ('$CK2','oben',456);
SQL
OUT=$(P -tA -F'|' -f "$FUNIL" 2>&1)
printf '    %s\n' "${OUT//$'\n'/$'\n'    }"
case "$OUT" in *"denominador|employee|staff|1|3"*) ok "D1 denominador: vendedor = 1 titular, 3 jornadas";; *) bad "D1 denominador employee errado";; esac
case "$OUT" in *"denominador|master|staff|1|1"*) ok "D2 master separado (founder testando não infla o vendedor)";; *) bad "D2 denominador master errado";; esac
if linha "$OUT" "funil|1|iniciado|4|||"; then ok "D3 funil: 4 jornadas iniciadas, sem etapa anterior (pct NULL)"; else bad "D3 etapa iniciado errada"; fi
case "$OUT" in *"funil|2|cliente|3|4|75.0|1"*) ok "D4 funil: cliente 3 de 4 (75.0%, queda 1)";; *) bad "D4 etapa cliente errada";; esac
case "$OUT" in *"funil|3|primeiro_item|2|3|66.7|1"*) ok "D5 funil: 1º item 2 de 3";; *) bad "D5 etapa primeiro_item errada";; esac
case "$OUT" in *"funil|5|envio_confirmado|2|2|100.0|0"*) ok "D6 funil: confirmado 2 de 2 tentados (jornadas, não linhas)";; *) bad "D6 etapa confirmado errada";; esac
case "$OUT" in *"falha|erp_pendente||1|3|33.3"*) ok "D7 falha: erp_pendente em 1 de 3 tentativas";; *) bad "D7 falha por classe errada";; esac
case "$OUT" in *"tempo|abertura->confirmado|2|25.0|37.0"*) ok "D8 abertura→1ª conta confirmada: p50 25, p90 37 (10 e 40 min)";; *) bad "D8 p50 errado";; esac
case "$OUT" in *"tempo|primeiro_item->confirmado|2|23.0|35.0"*) ok "D9 1º item→confirmado: p50 23, p90 35";; *) bad "D9 p50 do 1º item errado";; esac
case "$OUT" in *"conta|oben|2|2|100.0"*) ok "D10 por conta: oben 2 de 2 jornadas";; *) bad "D10 por conta errado";; esac
case "$OUT" in *"uso|ia_itens_adicionados|1|1|3"*) ok "D11 IA: 3 itens adicionados (soma de n)";; *) bad "D11 uso IA errado";; esac
case "$OUT" in *"ponte_servidor|3|2"*) ok "D12 ponte: 3 confirmados no sensor, 2 com PV no servidor (divergência visível)";; *) bad "D12 ponte com o servidor errada";; esac
case "$OUT" in *"FIM_FUNIL_OK"*) ok "D13 a query terminou (marcador positivo)";; *) bad "D13 query sem marcador de fim";; esac

echo "── falsificação: PRE e PÓS têm de abortar a migration sabotada ──"
FALSIF_OK=0; FALSIF_MUDO=0
fals() { # $1 descrição, $2 arquivo sabotado, $3 sentinela esperada
  if R=$(P -q -1 -f "$2" 2>&1); then FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ MUDA: $1 aplicou sem erro"
  else case "$R" in *"$3"*) FALSIF_OK=$((FALSIF_OK+1)); echo "  ✅ detectada: $1";;
                     *) FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ falhou por OUTRO motivo: $1 — [$R]";; esac
  fi
}
md5_do() { python3 -c "import sys,hashlib;s=open(sys.argv[1]).read();i=s.index('AS \$function\$')+len('AS \$function\$');j=s.index('\$function\$;',i);print(hashlib.md5(s[i:j].encode()).hexdigest())" "$1"; }

# Só a linha do CORPO (22 espaços de recuo); a do array da PÓS tem 30 e fica intacta.
SAB_CORPO="s/^( {22})'novo_pedido.envio_tentado', 'novo_pedido.envio_falhou', 'novo_pedido.envio_confirmado',/\$1'novo_pedido.envio_tentado', 'novo_pedido.envio_falhou',/m"
# S1: allowlist sem envio_confirmado; PRE/PÓS-md5 intactas → a PÓS por md5 barra.
SAB1=$(mktemp); perl -0pe "$SAB_CORPO" "$MIG" > "$SAB1"
cmp -s "$MIG" "$SAB1" && { echo "  ❌ sabotagem 1 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "allowlist SEM envio_confirmado (PÓS por md5)" "$SAB1" "corpo vivo nao e o desta migration"
# S2: mesma sabotagem com o md5 atualizado (a PRE passa a aceitar o vivo = este) — sobra a checagem por evento.
SAB2=$(mktemp); cp "$SAB1" "$SAB2"
M2=$(md5_do "$SAB2"); sed -i.bak "s/$MD5_ESTE/$M2/g; s/'$MD5_PRED', '$M2'/'$MD5_ESTE', '$M2'/" "$SAB2"
fals "allowlist SEM envio_confirmado (por evento)" "$SAB2" "allowlist sem novo_pedido.envio_confirmado"
# S3: recriação que ESQUECE um evento ANTIGO (banco.extrato_conferido), md5 atualizado (1ª ocorrência = corpo).
SAB3=$(mktemp); perl -0pe "s/'banco.extrato_importado', 'banco.extrato_conferido',\n/'banco.extrato_importado',\n/" "$MIG" > "$SAB3"
cmp -s "$MIG" "$SAB3" && { echo "  ❌ sabotagem 3 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
M3=$(md5_do "$SAB3"); sed -i.bak "s/$MD5_ESTE/$M3/g; s/'$MD5_PRED', '$M3'/'$MD5_ESTE', '$M3'/" "$SAB3"
fals "recriação que ESQUECE banco.extrato_conferido" "$SAB3" "allowlist sem banco.extrato_conferido"
# S4: o REVOKE de anon some → a PÓS de ACL barra (o setup deu EXECUTE a anon de propósito).
P -q -c "GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text,text,jsonb) TO anon;"
SAB4=$(mktemp); grep -v "FROM anon;" "$MIG" > "$SAB4"
cmp -s "$MIG" "$SAB4" && { echo "  ❌ sabotagem 4 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "sem o REVOKE de anon" "$SAB4" "anon executa o ledger"
rm -f "$SAB1" "$SAB2" "$SAB2.bak" "$SAB3" "$SAB3.bak" "$SAB4"

# Controle: a função boa sobreviveu (rollback das migrations abortadas) e anon continua fora.
P -q -1 -f "$MIG"
eq "C1 após as sabotagens, envio_confirmado ainda grava" "$(reg $UID_B novo_pedido.envio_confirmado $J2:oben "$(js "\"jornada\":\"$J2\",\"conta\":\"oben\"")")" "4"
eq "C2 após as sabotagens, md5 = este" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='analytics_ledger_registrar'")" "$MD5_ESTE"

# S5 (a PRE): outra sessão mudou a função depois do pré-voo → ABORTA em vez de apagar a mudança alheia.
P -q -c "CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(p_evento text, p_chave text, p_props jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$x\$ BEGIN PERFORM 1; /* outra sessao */ END; \$x\$;"
fals "corpo vivo alheio (deriva) — a PRE barra" "$MIG" "PRE FALHOU"
case "$(Pq -c "SELECT prosrc FROM pg_proc WHERE proname='analytics_ledger_registrar'")" in
  *"outra sessao"*) ok "C3 a mudança alheia sobreviveu";;
  *) bad "C3 a migration apagou a mudança alheia";;
esac

echo "  falsificação: $FALSIF_OK detectadas / $FALSIF_MUDO mudas"
[ "$FALSIF_MUDO" = "0" ] && [ "$FALSIF_OK" = "5" ] || FAIL=$((FAIL+1))

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
