#!/usr/bin/env bash
# Teste PG17 da migration 20261114210026_seg_lote2_nvoip_optout_template.sql (lote 2 do rescan
# do scanner Lovable Security). Auto-contido: stubs das tabelas com as policies e GRANTs ABERTOS
# de prod (conferidos via psql-ro em 2026-11-14).
#
# CONTROLE (antes da migration o buraco existe neste harness): staff LÊ o token Nvoip em
# company_config e DESFAZ o opt-out. Depois: (A) token fora do alcance do client; (B) opt-out só
# pelo servidor; (C) reserva de template pago atômica — idempotência, retry só de recusa provada,
# teto diário com rollback, config inválida fail-closed e CONCORRÊNCIA real com duas sessões.
# Aplica a migration 2× (idempotência).
#
# Cada asserção negativa casa a SQLSTATE EXATA (nunca "deu erro").
# Falsificação: MIGRATION=<cópia sabotada> bash db/test-seg-lote2.sh → tem de dar vermelho.
# Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="${MIGRATION:-$REPO_ROOT/supabase/migrations/20261114210026_seg_lote2_nvoip_optout_template.sql}"
export PGVER=17
PORT="${PGPORT_TEST:-${PORT:-5449}}"
DATA="$(mktemp -d /tmp/pgtest-seglote2.XXXXXX)/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres seglote2
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d seglote2 -v ON_ERROR_STOP=1 "$@"; }

echo "→ fundação (stubs com policies e GRANTs abertos de prod)…"
P -q <<'SQL'
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE public.company_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, value text,
  updated_at timestamptz DEFAULT now());
ALTER TABLE public.company_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_config_staff_select ON public.company_config FOR SELECT TO authenticated USING (true);
INSERT INTO public.company_config (key, value) VALUES
  ('nvoip_access_token', 'tok-acesso-falso'), ('nvoip_refresh_token', 'tok-refresh-falso'),
  ('nvoip_token_expires_at', '1777777777777'), ('whatsapp_sla_dias', '1,2,3,4,5');

CREATE TABLE public.whatsapp_templates (nome text PRIMARY KEY);
INSERT INTO public.whatsapp_templates VALUES ('proposta_v1'), ('outro_v1');

CREATE TABLE public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_key text NOT NULL UNIQUE, phone_e164 text,
  opt_in_status text NOT NULL DEFAULT 'unknown', status text NOT NULL DEFAULT 'aberta',
  assigned_operator_id uuid);
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_conv_staff_all ON public.whatsapp_conversations FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO public.whatsapp_conversations (id, phone_key, phone_e164, opt_in_status) VALUES
  ('00000000-0000-0000-0000-00000000c001', '11999990001', '+5511999990001', 'opt_out'),
  ('00000000-0000-0000-0000-00000000c002', '11999990002', '+5511999990002', 'opt_in'),
  ('00000000-0000-0000-0000-00000000c003', '11999990003', '+5511999990003', 'opt_out');

CREATE TABLE public.whatsapp_template_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_nome text NOT NULL REFERENCES public.whatsapp_templates(nome),
  conversation_id uuid REFERENCES public.whatsapp_conversations(id),
  phone_e164 text NOT NULL, body_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id text, erro text,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','proposta','status_pedido','rota')),
  disparado_por uuid, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.whatsapp_template_sends ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_template_sends FROM anon, authenticated;
SQL

FALHAS=0
PASSOU=0
espera() {  # espera <descricao> <esperado> <obtido>
  if [ "$2" = "$3" ]; then echo "  OK  $1 = $3"; PASSOU=$((PASSOU+1)); else echo "  FALHOU $1: esperado $2, obtido $3"; FALHAS=$((FALHAS+1)); fi
}
# tenta(role, sql) → "ok" | SQLSTATE exata do erro. A asserção casa o código, não "falhou".
tenta() {
  P -tA -q <<SQL | tail -1
SET ROLE $1;
DO \$t\$ BEGIN
  $2;
  PERFORM set_config('test.res','ok',false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('test.res', SQLSTATE, false);
END \$t\$;
SELECT current_setting('test.res');
SQL
}
# q(role, sql) → 1ª coluna da última linha
q() { P -tA -q -c "SET ROLE $1" -c "$2" | tail -1; }
C1=00000000-0000-0000-0000-00000000c001
C2=00000000-0000-0000-0000-00000000c002
C3=00000000-0000-0000-0000-00000000c003
# reserva(dedupe, phone, conv, params) → "resultado|status_existente|tem_token"
reserva() {
  q service_role "SELECT resultado || '|' || coalesce(status_existente,'-') || '|' || (claim_token IS NOT NULL)
                    FROM public.whatsapp_template_reservar('$1','proposta_v1',$3,'$2','$4'::jsonb,'proposta',NULL)"
}

echo "→ CONTROLE (antes da migration os buracos existem)…"
espera "staff LÊ o refresh_token Nvoip (antes)" 1 \
  "$(q authenticated "SELECT count(*) FROM public.company_config WHERE key = 'nvoip_refresh_token'")"
espera "staff DESFAZ o opt-out (antes)" ok \
  "$(tenta authenticated "UPDATE public.whatsapp_conversations SET opt_in_status = 'opt_in' WHERE id = '$C1'")"
P -q -c "UPDATE public.whatsapp_conversations SET opt_in_status = 'opt_out' WHERE id = '$C1'"

echo "→ aplica a migration (1ª vez)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_lote2_nvoip_optout_template' \
  || { echo "FALHOU: 1º apply sem o marcador de fim"; exit 1; }
echo "→ aplica a migration (2ª vez — idempotência)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_lote2_nvoip_optout_template' \
  || { echo "FALHOU: 2º apply sem o marcador de fim"; exit 1; }

echo "→ (A) token Nvoip fora do client…"
espera "token saiu de company_config" 0 \
  "$(q postgres "SELECT count(*) FROM public.company_config WHERE key LIKE 'nvoip\_%token%'")"
espera "config comum ficou" 1 "$(q postgres "SELECT count(*) FROM public.company_config WHERE key = 'whatsapp_sla_dias'")"
espera "staff NÃO lê nvoip_oauth_cache"  42501 "$(tenta authenticated "PERFORM * FROM public.nvoip_oauth_cache")"
espera "anon NÃO grava nvoip_oauth_cache" 42501 \
  "$(tenta anon "INSERT INTO public.nvoip_oauth_cache (key, value) VALUES ('nvoip_access_token','x')")"
espera "service_role grava o cache" ok \
  "$(tenta service_role "INSERT INTO public.nvoip_oauth_cache (key, value) VALUES ('nvoip_access_token','x') ON CONFLICT (key) DO UPDATE SET value = excluded.value")"
espera "edge antiga NÃO recria token em company_config (CHECK)" 23514 \
  "$(tenta service_role "INSERT INTO public.company_config (key, value) VALUES ('nvoip_refresh_token','x')")"

echo "→ (B) opt-out só pelo servidor…"
espera "staff NÃO desfaz opt-out"          42501 "$(tenta authenticated "UPDATE public.whatsapp_conversations SET opt_in_status = 'opt_in' WHERE id = '$C1'")"
espera "staff NÃO fabrica opt-in"          42501 "$(tenta authenticated "UPDATE public.whatsapp_conversations SET opt_in_status = 'opt_out' WHERE id = '$C2'")"
espera "staff NÃO apaga conversa opt-out"  42501 "$(tenta authenticated "DELETE FROM public.whatsapp_conversations WHERE id = '$C1'")"
espera "staff NÃO troca telefone do opt-out" 42501 "$(tenta authenticated "UPDATE public.whatsapp_conversations SET phone_key = '11900000000' WHERE id = '$C1'")"
espera "staff NÃO move outra conversa p/ o telefone do opt-out" 42501 "$(tenta authenticated "UPDATE public.whatsapp_conversations SET phone_e164 = '+5511999990001' WHERE id = '$C2'")"
espera "staff NÃO cria conversa (nem unknown, mesmo telefone)" 42501 "$(tenta authenticated "INSERT INTO public.whatsapp_conversations (phone_key, phone_e164) VALUES ('5511999990001','+5511999990001')")"
espera "staff NÃO trunca conversas" 42501 "$(tenta authenticated "TRUNCATE public.whatsapp_conversations CASCADE")"
espera "staff NÃO trunca envios (dedupe)" 42501 "$(tenta authenticated "TRUNCATE public.whatsapp_template_sends")"
espera "staff segue editando status/operador" ok "$(tenta authenticated "UPDATE public.whatsapp_conversations SET status = 'fechada' WHERE id = '$C1'")"
P -q -c "INSERT INTO public.whatsapp_conversations (phone_key) VALUES ('11977770000')"
espera "servidor segue criando conversa" ok "$(tenta service_role "INSERT INTO public.whatsapp_conversations (phone_key) VALUES ('11966660000')")"
espera "staff apaga conversa SEM opt-out" ok "$(tenta authenticated "DELETE FROM public.whatsapp_conversations WHERE phone_key = '11977770000'")"
espera "opt-out segue opt_out" opt_out "$(q postgres "SELECT opt_in_status FROM public.whatsapp_conversations WHERE id = '$C1'")"
espera "service_role (inbound VOLTAR) reverte" ok "$(tenta service_role "UPDATE public.whatsapp_conversations SET opt_in_status = 'opt_in' WHERE id = '$C3'")"

echo "→ (C) ACL da reserva…"
espera "staff NÃO executa a reserva" 42501 \
  "$(tenta authenticated "PERFORM public.whatsapp_template_reservar('k-acl','proposta_v1',NULL,'+55','[]','proposta',NULL)")"
espera "anon NÃO executa a reserva"  42501 \
  "$(tenta anon "PERFORM public.whatsapp_template_reservar('k-acl','proposta_v1',NULL,'+55','[]','proposta',NULL)")"
espera "staff NÃO mexe no teto"      42501 "$(tenta authenticated "UPDATE public.whatsapp_template_teto_diario SET reservas = 0")"

echo "→ (C) idempotência e retry…"
espera "chave nova reserva"              "reservado|queued|true"  "$(reserva k1 +5511999990002 "'$C2'" '["a"]')"
espera "mesma chave em voo = duplicata"  "duplicata|queued|false" "$(reserva k1 +5511999990002 "'$C2'" '["a"]')"
P -q -c "UPDATE public.whatsapp_template_sends SET status = 'failed', retry_seguro = false WHERE dedupe_key = 'k1'"
espera "failed INCERTO não reenvia"      "duplicata|failed|false" "$(reserva k1 +5511999990002 "'$C2'" '["a"]')"
P -q -c "UPDATE public.whatsapp_template_sends SET retry_seguro = true, erro = 'HTTP 400' WHERE dedupe_key = 'k1'"
espera "failed com outro telefone = conflito" "conflito_payload|failed|false" "$(reserva k1 +5511000000000 "'$C2'" '["a"]')"
P -q -c "UPDATE public.whatsapp_template_sends SET status = 'sent', retry_seguro = true WHERE dedupe_key = 'k1'"
espera "linha não-failed nunca é reclamada (mesmo com retry_seguro)" "duplicata|sent|false" "$(reserva k1 +5511999990002 "'$C2'" '["a"]')"
P -q -c "UPDATE public.whatsapp_template_sends SET status = 'failed' WHERE dedupe_key = 'k1'"
TOK_ANTES="$(q postgres "SELECT tentativa_id FROM public.whatsapp_template_sends WHERE dedupe_key = 'k1'")"
espera "failed PROVADO reenvia (recotado)" "reservado|queued|true" "$(reserva k1 +5511999990002 "'$C2'" '["b"]')"
espera "retry troca o token e os params" "t|b|f|" \
  "$(q postgres "SELECT (tentativa_id <> '$TOK_ANTES')::text || '|' || (body_params->>0) || '|' || retry_seguro::text || '|' || coalesce(erro,'') FROM public.whatsapp_template_sends WHERE dedupe_key = 'k1'" | sed 's/true/t/;s/false/f/')"

echo "→ (C) teto diário com rollback…"
P -q -c "DELETE FROM public.whatsapp_template_teto_diario" \
     -c "INSERT INTO public.company_config (key, value) VALUES ('whatsapp_template_teto_diario', '2')"
espera "teto 1/2" "reservado|queued|true" "$(reserva t1 +5511999990002 "'$C2'" '[]')"
espera "teto 2/2" "reservado|queued|true" "$(reserva t2 +5511999990002 "'$C2'" '[]')"
espera "teto 3/2 recusa" "teto_excedido|-|false" "$(reserva t3 +5511999990002 "'$C2'" '[]')"
espera "recusa NÃO deixa linha" 0 "$(q postgres "SELECT count(*) FROM public.whatsapp_template_sends WHERE dedupe_key = 't3'")"
P -q -c "UPDATE public.whatsapp_template_sends SET status = 'failed', retry_seguro = true, erro = 'HTTP 400' WHERE dedupe_key = 't1'"
TOK_T1="$(q postgres "SELECT tentativa_id FROM public.whatsapp_template_sends WHERE dedupe_key = 't1'")"
espera "retry com teto cheio recusa" "teto_excedido|-|false" "$(reserva t1 +5511999990002 "'$C2'" '[]')"
espera "retry recusado restaura failed/erro/token/elegível" "failed|HTTP 400|$TOK_T1|true" \
  "$(q postgres "SELECT status || '|' || erro || '|' || tentativa_id || '|' || retry_seguro FROM public.whatsapp_template_sends WHERE dedupe_key = 't1'")"
espera "contador parou no teto" 2 "$(q postgres "SELECT sum(reservas) FROM public.whatsapp_template_teto_diario")"

echo "→ (C) config inválida = fail-closed…"
for v in "'abc'" "''" "'0'" "'-3'" "'9999999999'" "NULL"; do
  P -q -c "UPDATE public.company_config SET value = $v WHERE key = 'whatsapp_template_teto_diario'"
  espera "teto $v recusa com 22023" 22023 \
    "$(tenta service_role "PERFORM public.whatsapp_template_reservar('cfg','proposta_v1',NULL,'+55','[]','proposta',NULL)")"
done
P -q -c "DELETE FROM public.company_config WHERE key = 'whatsapp_template_teto_diario'" -c "DELETE FROM public.whatsapp_template_teto_diario"
espera "teto ausente = default 200 (reserva)" "reservado|queued|true" "$(reserva cfg-ausente +5511999990002 "'$C2'" '[]')"

echo "→ (C) concorrência real: dois retries do MESMO failed…"
corrida() {  # corrida <dedupe> <fim da sessão A: COMMIT|ROLLBACK> → "<resultado A>,<resultado B>"
  local outA outB
  outA="$(mktemp)"; outB="$(mktemp)"
  P -tA -q > "$outA" <<SQL &
SET ROLE service_role;
BEGIN;
SELECT resultado FROM public.whatsapp_template_reservar('$1','proposta_v1','$C2','+5511999990002','[]','proposta',NULL);
SELECT pg_sleep(1.5);
$2;
SQL
  local pidA=$!
  sleep 0.5
  q service_role "SELECT resultado FROM public.whatsapp_template_reservar('$1','proposta_v1','$C2','+5511999990002','[]','proposta',NULL)" > "$outB"
  wait "$pidA"
  echo "$(grep -v '^$' "$outA" | head -1),$(cat "$outB")"
  rm -f "$outA" "$outB"
}
P -q -c "INSERT INTO public.whatsapp_template_sends (template_nome, conversation_id, phone_e164, dedupe_key, status, origem, retry_seguro)
         VALUES ('proposta_v1', '$C2', '+5511999990002', 'race1', 'failed', 'proposta', true),
                ('proposta_v1', '$C2', '+5511999990002', 'race2', 'failed', 'proposta', true)"
espera "A confirma → B vê duplicata (1 POST só)" "reservado,duplicata" "$(corrida race1 COMMIT)"
espera "A aborta → B assume (sem perder o retry)" "reservado,reservado" "$(corrida race2 ROLLBACK)"

echo "→ (C) concorrência real: teto com chaves diferentes em paralelo…"
P -q -c "DELETE FROM public.whatsapp_template_teto_diario" \
     -c "INSERT INTO public.company_config (key, value) VALUES ('whatsapp_template_teto_diario', '3')"
OUTD="$(mktemp -d)"
for i in 1 2 3 4 5 6 7 8; do
  q service_role "SELECT resultado FROM public.whatsapp_template_reservar('par$i','proposta_v1','$C2','+5511999990002','[]','proposta',NULL)" > "$OUTD/$i" &
done
wait
espera "8 em paralelo, teto 3 → 3 reservados" 3 "$(cat "$OUTD"/* | grep -c '^reservado$')"
espera "8 em paralelo, teto 3 → 5 recusados"  5 "$(cat "$OUTD"/* | grep -c '^teto_excedido$')"
espera "só 3 linhas par* em sends" 3 "$(q postgres "SELECT count(*) FROM public.whatsapp_template_sends WHERE dedupe_key LIKE 'par%'")"
rm -rf "$OUTD"

ESPERADOS=50
echo "RESULTADO: $PASSOU ok / $FALHAS fail (esperados $ESPERADOS)"
if [ "$FALHAS" -ne 0 ]; then echo "✗ db/test-seg-lote2.sh — $FALHAS falha(s)"; exit 1; fi
if [ "$PASSOU" -ne "$ESPERADOS" ]; then echo "✗ db/test-seg-lote2.sh — rodou $PASSOU asserções, esperava $ESPERADOS"; exit 1; fi
echo "✓ db/test-seg-lote2.sh — PASSOU"
