#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU7: gate interno em `public.wa_owner_efetivo` (oráculo)      ║
# ║      bash db/test-wa-owner-efetivo-gate-staff.sh > /tmp/t.log 2>&1; echo $?     ║
# ║                                                                              ║
# ║  Aplica a migration REAL 20261011120200_wa_owner_efetivo_gate_staff.sql       ║
# ║  sobre a topologia medida em prod (psql-ro 2026-07-18) — os 3 dependentes:    ║
# ║    1. RPC direta do frontend (IncomingCallModal.tsx:90) sob JWT de staff      ║
# ║    2. trigger push_whatsapp_inbound (AFTER INSERT) sob service_role           ║
# ║    3. view v_whatsapp_sla (security_invoker=on) — o dependente que o          ║
# ║       inventário inicial NÃO listou (achado por varredura do banco)           ║
# ║                                                                              ║
# ║  A prova central não é "o gate nega": é que ele nega SEM quebrar o RING-ALL   ║
# ║  da telefonia (P1) nem o push da vendedora (P3) — as duas coisas que o gate   ║
# ║  "óbvio" (carteira_visivel_para) quebraria. F1/F2 sabotam exatamente isso.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5473}"
SLUG="wa-owner-gate"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
# ⚠️ Stubs FIÉIS À PROD: leem `request.jwt.claims` (o GUC que o PostgREST escreve a
# partir do JWT verificado), NÃO uma GUC inventada de teste. Um stub que lê
# `test.uid` prova um mecanismo que não existe em produção — e faria a query de
# validação pós-apply (que seta o claim real) parecer quebrada, ou pior, passar
# por engano. Pego pelo assert V1 nesta sessão.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER="11111111-1111-1111-1111-111111111111"
CUSTOMER="22222222-2222-2222-2222-222222222222"
REGINA="33333333-3333-3333-3333-333333333333"    # employee, dona do CUSTOMER
TATY="44444444-4444-4444-4444-444444444444"      # employee, NÃO atende o CUSTOMER (ring-all)
COBERTURA="55555555-5555-5555-5555-555555555555" # employee que cobre férias da ANA
CUST_COB="66666666-6666-6666-6666-666666666666"  # cliente da ANA (coberto)
CUST_INEL="77777777-7777-7777-7777-777777777777" # cliente eligible=false (#1398)
ANA="99999999-9999-9999-9999-999999999999"       # employee cobrida — ISOLADA da Regina de
                                                 # propósito: cobertura é por OWNER, então
                                                 # cobrir a Regina contaminaria o CUSTOMER
                                                 # e acoplaria asserts posteriores.

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — TOPOLOGIA FIEL À PROD
#   default privilege do Supabase é obrigatório: sem ele a função nasce sem
#   EXECUTE p/ authenticated e o teste de fronteira dá falso-verde.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

-- schema REAL conferido em prod (information_schema + pg_indexes, 2026-07-18):
-- UNIQUE(customer_user_id) => 1 linha por cliente; valid_from NOT NULL DEFAULT now()
CREATE TABLE public.carteira_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'omie',
  eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.carteira_coverage (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz,
  active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- ── o ORÁCULO, na versão de prod PRÉ-fix (sem gate nenhum) ──
CREATE FUNCTION public.wa_owner_efetivo(p_customer uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  select coalesce(
    (select cc.covering_user_id from public.carteira_coverage cc
      where cc.covered_user_id = ca.owner_user_id and cc.active
        and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
      order by cc.valid_from desc limit 1),
    ca.owner_user_id)
  from public.carteira_assignments ca
  where ca.customer_user_id = p_customer and ca.eligible
  order by ca.valid_from desc limit 1;
$f$;

-- ── DEPENDENTE 2: o trigger de push (roda sob service_role via edge whatsapp-inbound) ──
CREATE TABLE public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid,
  contact_name text, phone_e164 text, status text NOT NULL DEFAULT 'aberta');
CREATE TABLE public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  direction text NOT NULL, body text, sender_user_id uuid,
  wa_timestamp timestamptz, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
-- RLS REAL de prod: staff-only (employee OR master)
CREATE POLICY wa_conv_staff_all ON public.whatsapp_conversations FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=(SELECT auth.uid())
                 AND ur.role = ANY (ARRAY['employee'::public.app_role,'master'::public.app_role])));
CREATE POLICY wa_msg_staff_all ON public.whatsapp_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=(SELECT auth.uid())
                 AND ur.role = ANY (ARRAY['employee'::public.app_role,'master'::public.app_role])));

CREATE FUNCTION public.wa_is_stop_keyword(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT lower(coalesce(p,'')) IN ('sair','parar','stop') $f$;

-- ⚠️ EFEITO OBSERVÁVEL do push. Sem isto o teste do trigger seria teatro: o trigger
-- tem `EXCEPTION WHEN OTHERS → RAISE WARNING` E `IF v_dona IS NULL THEN RETURN NEW`,
-- então o INSERT tem sucesso mesmo quando o push MORRE. "não deu erro" não prova nada.
CREATE TABLE public.push_enviado (destino uuid, titulo text);
CREATE FUNCTION public._push_enviar(p_dest uuid[], p_titulo text, p_body text, p_url text, p_tag text)
RETURNS void LANGUAGE sql AS $f$ INSERT INTO public.push_enviado SELECT unnest(p_dest), p_titulo $f$;

CREATE FUNCTION public.push_whatsapp_inbound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_conv record; v_dona uuid; v_nome text;
BEGIN
  IF public.wa_is_stop_keyword(NEW.body) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_messages m
             WHERE m.conversation_id = NEW.conversation_id AND m.direction='in'
               AND m.id <> NEW.id AND m.created_at > now() - interval '10 minutes') THEN
    RETURN NEW;
  END IF;
  SELECT c.customer_user_id, c.contact_name, c.phone_e164 INTO v_conv
  FROM public.whatsapp_conversations c WHERE c.id = NEW.conversation_id;
  IF v_conv IS NULL OR v_conv.customer_user_id IS NULL THEN RETURN NEW; END IF;
  v_dona := public.wa_owner_efetivo(v_conv.customer_user_id);
  IF v_dona IS NULL THEN RETURN NEW; END IF;
  v_nome := COALESCE(NULLIF(trim(v_conv.contact_name),''), v_conv.phone_e164, 'Cliente');
  PERFORM public._push_enviar(ARRAY[v_dona],'Nova mensagem no WhatsApp',
    v_nome || ' respondeu — toque para abrir a conversa','/whatsapp','wa-'||NEW.conversation_id::text);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[push] falha no push de whatsapp inbound (msg %): %', NEW.id, SQLERRM;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_push_whatsapp_inbound AFTER INSERT ON public.whatsapp_messages
FOR EACH ROW WHEN (new.direction='in' AND new.sender_user_id IS NULL)
EXECUTE FUNCTION public.push_whatsapp_inbound();

-- ── DEPENDENTE 3: a view (security_invoker=on, chama o oráculo na CTE `owner`) ──
CREATE VIEW public.v_whatsapp_sla WITH (security_invoker=on) AS
  SELECT c.id AS conversation_id, c.customer_user_id,
         public.wa_owner_efetivo(c.customer_user_id) AS owner_user_id
  FROM public.whatsapp_conversations c WHERE c.status <> 'fechada';

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555'),('66666666-6666-6666-6666-666666666666'),
  ('77777777-7777-7777-7777-777777777777'),('99999999-9999-9999-9999-999999999999')
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','customer'),
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('44444444-4444-4444-4444-444444444444','employee'),
  ('55555555-5555-5555-5555-555555555555','employee'),
  ('66666666-6666-6666-6666-666666666666','customer'),
  ('77777777-7777-7777-7777-777777777777','customer'),
  ('99999999-9999-9999-9999-999999999999','employee');
-- deixa o DEFAULT real produzir valid_from/eligible (não escrever a premissa à mão)
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id) VALUES
  ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333'),
  ('66666666-6666-6666-6666-666666666666','99999999-9999-9999-9999-999999999999');
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES
  ('77777777-7777-7777-7777-777777777777','33333333-3333-3333-3333-333333333333', false);
INSERT INTO public.whatsapp_conversations(id, customer_user_id, contact_name, phone_e164)
  VALUES ('88888888-8888-8888-8888-888888888888','22222222-2222-2222-2222-222222222222','Zé','+5511999');
GRANT SELECT ON public.v_whatsapp_sla, public.whatsapp_conversations, public.whatsapp_messages,
  public.user_roles, public.carteira_assignments TO authenticated, anon;

-- ACL REAL de prod (proacl medido 2026-07-18): authenticated + service_role, SEM anon.
-- Replicar isto é obrigatório: sem o REVOKE o stub nasce com anon aberto (default
-- privilege) e o teste "provaria" um fechamento de anon que este PR NÃO faz.
REVOKE EXECUTE ON FUNCTION public.wa_owner_efetivo(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.wa_owner_efetivo(uuid) TO authenticated, service_role;
SQL
echo "topologia fiel aplicada (3 dependentes reproduzidos)"

# monta o claim JWT como o PostgREST faria (sem 'sub' quando não há usuário)
claims() { # $1=uid ('' p/ nulo)  $2=role
  if [ -z "$1" ]; then printf '{"role":"%s"}' "$2"; else printf '{"sub":"%s","role":"%s"}' "$1" "$2"; fi
}

# helper: chama o oráculo sob uma identidade. Distingue 3 estados mutuamente
# exclusivos — <uuid> / <NULL> (gate negou no corpo) / <DENIED> (42501 na fronteira
# de GRANT). Nunca ancora em vazio (lição #1380).
call() { # $1=uid ('' p/ nulo)  $2=role  $3=SET ROLE  $4=alvo
  local out
  out=$(Pq -c "SET request.jwt.claims='$(claims "$1" "$2")'; SET ROLE $3; SELECT coalesce(public.wa_owner_efetivo('$4')::text,'<NULL>');" 2>&1) || true
  case "$out" in
    *"permission denied for function"*) echo "<DENIED>" ;;
    *) echo "$out" | tail -1 ;;
  esac
}

# ── baseline PRÉ-migration: o oráculo está ABERTO (senão a prova não vale nada) ──
echo "── baseline pré-migration (o furo existe) ──"
B1=$(call "$CUSTOMER" authenticated authenticated "$CUSTOMER")
eq "P0 ORACULO ABERTO: customer sonda o PROPRIO id e extrai o UUID do funcionario" "$B1" "$REGINA"
B2=$(call "" anon anon "$CUSTOMER")
eq "P0b HONESTIDADE DE ESCOPO: anon JA estava fechado (42501) antes deste PR — o furo e o authenticated" "$B2" "<DENIED>"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20261011120200_wa_owner_efetivo_gate_staff.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── POSITIVOS: os 3 dependentes vivos continuam funcionando ──"

A1=$(call "$TATY" authenticated authenticated "$CUSTOMER")
eq "P1 DECISIVO/RING-ALL: employee que NAO atende o cliente ainda ve o dono (modal 'Cliente da Regina')" "$A1" "$REGINA"

A2=$(call "$REGINA" authenticated authenticated "$CUSTOMER")
eq "P2 o proprio dono ve (realce 'meu' do modal)" "$A2" "$REGINA"

A3=$(call "$MASTER" authenticated authenticated "$CUSTOMER")
eq "P3 master ve" "$A3" "$REGINA"

# service_role: o caminho da automação. Provado pelo EFEITO (push gravado), não pela ausência de erro.
P -q -c "SET request.jwt.claims='$(claims "" service_role)'; SET ROLE service_role;
         INSERT INTO public.whatsapp_messages(conversation_id, direction, body)
         VALUES ('88888888-8888-8888-8888-888888888888','in','oi');"
A4=$(Pq -c "SELECT coalesce(string_agg(destino::text,','),'<NENHUM>') FROM public.push_enviado;" | tail -1)
eq "P4 DECISIVO/PUSH: trigger sob service_role ENTREGOU o push a dona (efeito observado)" "$A4" "$REGINA"

A5=$(Pq -c "SET request.jwt.claims='$(claims "$REGINA" authenticated)'; SET ROLE authenticated;
            SELECT coalesce(owner_user_id::text,'<NULL>') FROM public.v_whatsapp_sla LIMIT 1;" | tail -1)
eq "P5 a VIEW v_whatsapp_sla segue projetando o dono p/ staff (supervisao de SLA)" "$A5" "$REGINA"

A6=$(call "$MASTER" authenticated authenticated "$CUST_INEL")
eq "P6 eligible=false segue mascarado (o #1398 preservado, mesmo p/ master)" "$A6" "<NULL>"

# cobertura de férias: o COALESCE do corpo tem de sobreviver ao embrulho do gate
P -q -c "INSERT INTO public.carteira_coverage(covering_user_id, covered_user_id, created_by)
         VALUES ('$COBERTURA','$ANA','$MASTER');"
A7=$(call "$TATY" authenticated authenticated "$CUST_COB")
eq "P7 cobertura de ferias segue resolvendo p/ o cobridor (corpo intacto sob o gate)" "$A7" "$COBERTURA"

A8=$(call "$TATY" authenticated authenticated "$CUSTOMER")
eq "P8 isolamento: a cobertura da ANA nao vaza p/ cliente da REGINA (estado nao acopla asserts)" "$A8" "$REGINA"

echo "── NEGATIVOS: o oráculo fecha ──"

N1=$(call "$CUSTOMER" authenticated authenticated "$CUSTOMER")
eq "N1 DECISIVO: customer sondando o PROPRIO id NAO extrai mais o UUID do funcionario" "$N1" "<NULL>"

N2=$(call "$CUSTOMER" authenticated authenticated "$CUST_COB")
eq "N2 customer nao extrai o dono de OUTRO cliente" "$N2" "<NULL>"

N3=$(call "" anon anon "$CUSTOMER")
eq "N3 anon segue fechado na fronteira de GRANT (42501, o REVOKE reafirmado)" "$N3" "<DENIED>"

N4=$(call "" authenticated authenticated "$CUSTOMER")
eq "N4 fail-closed: JWT sem 'sub' utilizavel (uid NULL) NAO autoriza" "$N4" "<NULL>"

N5=$(Pq -c "SET request.jwt.claims='$(claims "$CUSTOMER" authenticated)'; SET ROLE authenticated;
            SELECT count(*) FROM public.v_whatsapp_sla;" | tail -1)
eq "N5 customer nao le a view (RLS staff-only das bases ja fechava — defesa em profundidade)" "$N5" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
#   Sentinelas ancoram em VALOR exato e estados mutuamente distinguíveis,
#   nunca em vazio (lição #1380: assert que passa com "" prova o nada).
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

CORPO="select coalesce(
      (select cc.covering_user_id from public.carteira_coverage cc
        where cc.covered_user_id = ca.owner_user_id and cc.active
          and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
        order by cc.valid_from desc limit 1), ca.owner_user_id)
    from public.carteira_assignments ca
    where ca.customer_user_id = p_customer and ca.eligible
    order by ca.valid_from desc limit 1"

regate() { # $1 = expressão do gate a instalar
  P -q -c "CREATE OR REPLACE FUNCTION public.wa_owner_efetivo(p_customer uuid)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
    AS \$f\$ SELECT CASE WHEN ($1) THEN ($CORPO) ELSE NULL::uuid END; \$f\$;"
}

# F1 — O CAMINHO "ÓBVIO" QUEBRA A TELEFONIA.
#   Sabota o gate p/ carteira_visivel_para (o gate que o brief propunha) e exige
#   que P1 (ring-all) fique VERMELHO. Transforma "isso quebraria o modal" de
#   opinião em fato executável.
P -q -c "CREATE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$f\$ SELECT _uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.carteira_assignments a
       WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid AND a.eligible IS TRUE) \$f\$;"
regate "public.carteira_visivel_para(p_customer, (SELECT auth.uid()))"
F1=$(call "$TATY" authenticated authenticated "$CUSTOMER")
if [ "$F1" = "<NULL>" ]; then
  # Precisão na afirmação (correção do Codex xhigh): o JSX não tem ramo p/ 'sem_dono'
  # — não existe badge "sem dono". O efeito real é a SUPRESSÃO de informação
  # verdadeira: o realce 'outro' some e o peer perde o direcionamento do ring-all.
  ok "F1 sabotagem detectada: gate por CARTEIRA devolve <NULL> no ring-all → suprime o realce 'outro' e mata o direcionamento (P1 seria vermelho)"
else
  bad "F1 falsificacao SEM DENTE: esperava <NULL>, veio [$F1]"
fi
# restaura o gate VERDADEIRO já aqui: cada sabotagem restaura no fim dela, senão a
# falsificação seguinte roda sob o gate errado e "passa" pelo motivo errado.
P -q -c "DROP FUNCTION public.carteira_visivel_para(uuid,uuid);"
P -q -f "$MIG"

# F2 — sem o disjunct service_role, o push da vendedora MORRE EM SILÊNCIO.
#
# ⚠️ CONTROLE PAREADO, e não uma sabotagem solta. O trigger tem um cooldown
# (`RETURN NEW` se já houve outra inbound na MESMA conversa nos últimos 10 min).
# Reusar a conversa do P4 daria <NENHUM> **mesmo com o gate correto** → a
# falsificação passaria sem testar nada. Foi assim que a 1ª versão deste harness
# ficou verde por engano (achado do Codex xhigh, 2026-07-18). Cada braço usa uma
# conversa NOVA, então a única variável entre eles é o gate.
push_em() { # $1=id da conversa nova → devolve o destino do push, ou <NENHUM>
  P -q -c "TRUNCATE public.push_enviado;
           INSERT INTO public.whatsapp_conversations(id, customer_user_id, contact_name, phone_e164)
           VALUES ('$1','$CUSTOMER','Zé','+5511999');
           SET request.jwt.claims='$(claims "" service_role)'; SET ROLE service_role;
           INSERT INTO public.whatsapp_messages(conversation_id, direction, body)
           VALUES ('$1','in','oi');"
  Pq -c "SELECT coalesce(string_agg(destino::text,','),'<NENHUM>') FROM public.push_enviado;" | tail -1
}

# braço A (controle): gate CORRETO + conversa nova → o push TEM de chegar.
# Sem este braço, um <NENHUM> no braço B não distingue "gate matou" de "cooldown".
F2A=$(push_em "aaaaaaaa-0000-0000-0000-00000000000a")
eq "F2a controle: com o gate correto e conversa NOVA o push CHEGA (isola o cooldown)" "$F2A" "$REGINA"

# braço B (mutante): mesma condição, só sem o disjunct service_role.
regate "COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)
        OR COALESCE(public.has_role((SELECT auth.uid()), 'employee'::public.app_role), false)"
F2B=$(push_em "bbbbbbbb-0000-0000-0000-00000000000b")
if [ "$F2B" = "<NENHUM>" ]; then
  ok "F2b sabotagem detectada: sem o disjunct service_role o push some SEM ERRO (P4 tem dente)"
else
  bad "F2b falsificacao SEM DENTE: esperava <NENHUM>, veio [$F2B]"
fi
P -q -f "$MIG"   # restaura

# F3 — o erro do #1387: autorizar pela AUSÊNCIA de identidade (fail-open).
#   Um gate "uid IS NULL OR staff" deixaria o customer passar? não — mas deixaria
#   passar QUALQUER token sem 'sub'. Sabota e exige que N4 fique vermelho.
regate "(SELECT auth.uid()) IS NULL
        OR COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)
        OR COALESCE(public.has_role((SELECT auth.uid()), 'employee'::public.app_role), false)"
F3=$(call "" authenticated authenticated "$CUSTOMER")
if [ "$F3" = "$REGINA" ]; then
  ok "F3 sabotagem detectada: gate que aceita uid-nulo autoriza pela AUSENCIA de identidade (N4 tem dente)"
else
  bad "F3 falsificacao SEM DENTE: esperava $REGINA, veio [$F3]"
fi
P -q -f "$MIG"   # restaura

# F4 — gate ausente (o estado de hoje): N1 tem de ficar vermelho.
P -q -c "CREATE OR REPLACE FUNCTION public.wa_owner_efetivo(p_customer uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$f\$ $CORPO; \$f\$;"
F4=$(call "$CUSTOMER" authenticated authenticated "$CUSTOMER")
if [ "$F4" = "$REGINA" ]; then
  ok "F4 sabotagem detectada: sem gate o customer volta a extrair o UUID do staff (N1 tem dente)"
else
  bad "F4 falsificacao SEM DENTE: esperava $REGINA, veio [$F4]"
fi

# restaura a versão VERDADEIRA e prova idempotência (o founder re-cola no SQL Editor)
P -q -f "$MIG"
P -q -f "$MIG"
R1=$(call "$TATY" authenticated authenticated "$CUSTOMER")
eq "F5 re-run da migration e no-op (ring-all intacto)" "$R1" "$REGINA"
R2=$(call "$CUSTOMER" authenticated authenticated "$CUSTOMER")
eq "F6 re-run mantem o oraculo fechado" "$R2" "<NULL>"

# ── V1: a QUERY DE VALIDAÇÃO entregue ao founder é exercitada aqui ──
# Entregar validação não-testada já mordeu no repo (#1308: o bloco pós-apply
# hardcodou `security_invoker=on` e "reportou" uma regressão inexistente).
# O que o founder cola é literalmente este arquivo.
VAL=$(P -tA -f "$REPO_ROOT/db/validate-wa-owner-efetivo-gate.sql" 2>&1 | grep -c '✅ OK' || true)
eq "V1 a query de validacao pos-apply entregue ao founder da os 3 OK contra a migration real" "$VAL" "3"

# e tem dente: sabotada (gate removido), ela tem de acusar
P -q -c "CREATE OR REPLACE FUNCTION public.wa_owner_efetivo(p_customer uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$f\$ $CORPO; \$f\$;"
VALF=$(P -tA -f "$REPO_ROOT/db/validate-wa-owner-efetivo-gate.sql" 2>&1 | grep -c '❌ FALHOU' || true)
if [ "$VALF" = "1" ]; then
  ok "V2 a validacao tem DENTE: sem o gate ela acusa ❌ (1 dos 3 checks)"
else
  bad "V2 validacao SEM DENTE: esperava 1 check vermelho, veio [$VALF]"
fi
P -q -f "$MIG"   # restaura

# F7 — a pós-condição DO $post$ da migration tem dente: um espelho sem o disjunct service_role
# (sabotado em tmpdir, nunca em supabase/migrations/) tem de ABORTAR com M15_POS_FALHOU.
SAB="$(dirname "$DATA")/sabotada.sql"
grep -v "COALESCE((SELECT auth.role()) = 'service_role', false)" "$MIG" \
  | sed "s/      OR COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)/      COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)/" > "$SAB"
if cmp -s "$MIG" "$SAB"; then
  bad "F7 a sabotagem nao alterou a migration (padrao nao casou) — falsificacao nao rodou"
else
  R=$(P -q -f "$SAB" 2>&1 || true)
  case "$R" in *M15_POS_FALHOU*) ok "F7 migration sem o disjunct service_role aborta na pos-condicao (M15_POS_FALHOU)" ;;
    *) bad "F7 pos-condicao nao barrou a migration sabotada — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo "──────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
