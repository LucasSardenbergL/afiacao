#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PG17 — a oferta pendente NÃO sobrevive à troca de dono do cliente            ║
# ║      bash db/test-farmer-troca-dono.sh > /tmp/t.log 2>&1; echo "exit=$?"      ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Prova db/farmer-troca-dono-expira-pendentes.sql: a trigger de fronteira em    ║
# ║  farmer_client_scores + o lock causal (FOR SHARE) dentro das RPCs.             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="farmer-troca-dono"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

SINAL="$(mktemp -t troca-dono-sinal.XXXXXX)"; rm -f "$SINAL"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "$SINAL"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
ne()  { if [ "$2" != "$3" ]; then ok "$1 (=$2, != $3)"; else bad "$1 — NÃO devia ser [$3]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos: o que a migração LÊ/ALTERA mas não cria.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

-- UNIQUE(customer_user_id) é o que torna "o dono do cliente" uma FUNÇÃO — premissa do gate.
CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id uuid NOT NULL,
  health_score numeric,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  recommendation_type text,
  product_id uuid, current_product_id uuid,
  p_ij numeric, m_ij numeric, lie numeric,
  affinity_score numeric, complexity_factor numeric, cluster_volume_estimate numeric,
  status text NOT NULL DEFAULT 'pendente',
  run_id uuid, expired_at timestamptz, expired_by_run uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT farmer_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente','ofertado','aceito','rejeitado','expirado'])),
  CONSTRAINT farmer_recommendations_expirado_coerente
    CHECK ((status IS NOT NULL) AND ((status = 'expirado') = (expired_at IS NOT NULL)))
);

CREATE TABLE public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_products jsonb, bundle_type text,
  support numeric, confidence numeric, lift numeric,
  p_bundle numeric, m_bundle numeric, lie_bundle numeric,
  complexity_factor numeric, affinity_bundle numeric,
  approach_type text, argument_phone text, argument_whatsapp text,
  argument_technical text, customer_profile text, argument_effectiveness numeric,
  accepted_products jsonb,
  status text NOT NULL DEFAULT 'pendente',
  run_id uuid, expired_at timestamptz, expired_by_run uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT farmer_bundle_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente','ofertado','aceito_total','aceito_parcial','rejeitado','expirado'])),
  CONSTRAINT farmer_bundle_recommendations_expirado_coerente
    CHECK ((status IS NOT NULL) AND ((status = 'expirado') = (expired_at IS NOT NULL)))
);

CREATE TABLE public.farmer_geracao_vigente (
  motor text NOT NULL, farmer_id uuid NOT NULL, run_id uuid,
  PRIMARY KEY (motor, farmer_id)
);

-- Stubs de dependência (não são o objeto sob teste; existem p/ a RPC real rodar).
CREATE FUNCTION private.cap_carteira_escrever(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(current_setting('test.cap_ler', true) = 'on', false) $f$;

CREATE FUNCTION public.farmer_geracao_registrar(
  p_motor text, p_farmer_id uuid, p_run_id uuid, p_tipo text, p_n integer,
  p_completude text, p_motivo text, p_insumos jsonb, p_head uuid)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.farmer_geracao_vigente (motor, farmer_id, run_id)
  VALUES (p_motor, p_farmer_id, p_run_id)
  ON CONFLICT (motor, farmer_id) DO UPDATE SET run_id = EXCLUDED.run_id;
END $f$;

-- As triggers REAIS de prod nessas tabelas. Não são decoração: `frec_sem_margem` é
-- BEFORE INSERT **OR UPDATE**, logo ela roda dentro do UPDATE de expiração da trigger nova
-- — se as duas brigassem, seria aqui.
CREATE FUNCTION public.farmer_rec_exige_run_id() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  IF NEW.status = 'pendente' AND NEW.run_id IS NULL THEN
    RAISE EXCEPTION 'recomendação pendente exige run_id' USING ERRCODE = 'FG008';
  END IF;
  RETURN NEW;
END $f$;
CREATE FUNCTION private.frec_sem_margem() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN NEW.m_ij := NULL; NEW.lie := NULL; RETURN NEW; END $f$;
CREATE FUNCTION private.fbrec_sem_margem() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN NEW.m_bundle := NULL; NEW.lie_bundle := NULL; RETURN NEW; END $f$;

CREATE TRIGGER trg_frec_exige_run_id  BEFORE INSERT ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.farmer_rec_exige_run_id();
CREATE TRIGGER trg_fbrec_exige_run_id BEFORE INSERT ON public.farmer_bundle_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.farmer_rec_exige_run_id();
CREATE TRIGGER trg_frec_sem_margem  BEFORE INSERT OR UPDATE ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem();
CREATE TRIGGER trg_fbrec_sem_margem BEFORE INSERT OR UPDATE ON public.farmer_bundle_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.fbrec_sem_margem();
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migração REAL (Lei #1): o mesmo arquivo que o founder cola no SQL Editor.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/db/farmer-troca-dono-expira-pendentes.sql"
[ -f "$MIG" ] || { echo "migração ausente: $MIG"; exit 1; }
P -q -f "$MIG" > /dev/null
echo "═══ migração aplicada ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds
# ══════════════════════════════════════════════════════════════════════════════
A="aaaaaaaa-0000-4000-8000-000000000001"   # dono ANTIGO
B="bbbbbbbb-0000-4000-8000-000000000002"   # dono NOVO
T="eeeeeeee-0000-4000-8000-000000000003"   # um TERCEIRO farmer (órfã pré-existente)
C1="cccccccc-0000-4000-8000-000000000001"  # o cliente que TROCA de dono
C2="cccccccc-0000-4000-8000-000000000002"  # cliente que NÃO se move (controle)
C3="cccccccc-0000-4000-8000-000000000003"  # cliente cujo score será DELETADO
C4="cccccccc-0000-4000-8000-000000000004"  # SEM recomendação: isola o lock na zona G
RUN0="99999999-0000-4000-8000-000000000000"
PROD="dddddddd-0000-4000-8000-000000000001"

semear() {
  P -q <<SQL
TRUNCATE public.farmer_recommendations, public.farmer_bundle_recommendations,
         public.farmer_client_scores, public.farmer_geracao_vigente;
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, health_score) VALUES
  ('$C1','$A',10), ('$C2','$A',10), ('$C3','$A',10), ('$C4','$A',10);
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status, run_id, expired_at)
VALUES
  ('$A','$C1','cross_sell','$PROD',0.5,'pendente','$RUN0',NULL),   -- some na troca
  ('$B','$C1','cross_sell','$PROD',0.6,'pendente','$RUN0',NULL),   -- do dono NOVO: SOBREVIVE
  ('$T','$C1','cross_sell','$PROD',0.4,'pendente','$RUN0',NULL),   -- órfã de terceiro: some
  ('$A','$C1','cross_sell','$PROD',0.9,'ofertado','$RUN0',NULL),   -- DESFECHO: imutável
  ('$A','$C1','cross_sell','$PROD',0.9,'aceito','$RUN0',NULL),     -- DESFECHO: imutável
  ('$A','$C1','cross_sell','$PROD',0.9,'rejeitado','$RUN0',NULL),  -- DESFECHO: imutável
  ('$A','$C2','cross_sell','$PROD',0.5,'pendente','$RUN0',NULL),   -- controle: intocado
  ('$A','$C3','cross_sell','$PROD',0.5,'pendente','$RUN0',NULL);   -- morre no DELETE
INSERT INTO public.farmer_bundle_recommendations
  (farmer_id, customer_user_id, bundle_products, affinity_bundle, status, run_id, expired_at)
VALUES
  ('$A','$C1','[{"id":"x"}]'::jsonb,0.5,'pendente','$RUN0',NULL),
  ('$B','$C1','[{"id":"y"}]'::jsonb,0.6,'pendente','$RUN0',NULL),
  ('$A','$C1','[{"id":"z"}]'::jsonb,0.9,'aceito_total','$RUN0',NULL),
  ('$A','$C2','[{"id":"w"}]'::jsonb,0.5,'pendente','$RUN0',NULL);
SQL
}

st()   { Pq -c "SELECT status FROM public.$1 WHERE farmer_id='$2' AND customer_user_id='$3' AND affinity_score $4;"; }
stb()  { Pq -c "SELECT status FROM public.farmer_bundle_recommendations WHERE farmer_id='$1' AND customer_user_id='$2' AND affinity_bundle=$3;"; }
motivo(){ Pq -c "SELECT coalesce(expired_reason,'NULO') FROM public.farmer_recommendations WHERE farmer_id='$1' AND customer_user_id='$2' AND affinity_score $3;"; }
total() { Pq -c "SELECT (SELECT count(*) FROM public.farmer_recommendations) || '/' || (SELECT count(*) FROM public.farmer_bundle_recommendations);"; }
sensor(){ P -tAq -c "SET test.role='service_role'; SELECT $1 FROM public.farmer_escopo_invariante() WHERE tabela='$2';"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "─── A) troca de dono A→B (UPDATE) ───"
semear
ANTES="$(total)"
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C1';"

eq "A1 pendente do dono ANTIGO expira"                "$(st farmer_recommendations "$A" "$C1" '=0.5')" "expirado"
eq "A2 motivo gravado = troca_de_dono"                "$(motivo "$A" "$C1" '=0.5')"                     "troca_de_dono"
eq "A3 expired_at preenchido (CHECK coerente)"        "$(Pq -c "SELECT (expired_at IS NOT NULL)::text FROM public.farmer_recommendations WHERE farmer_id='$A' AND customer_user_id='$C1' AND affinity_score=0.5;")" "true"
eq "A4 expired_by_run fica NULL (não houve run)"      "$(Pq -c "SELECT (expired_by_run IS NULL)::text FROM public.farmer_recommendations WHERE farmer_id='$A' AND customer_user_id='$C1' AND affinity_score=0.5;")" "true"
eq "A5 pendente do dono NOVO SOBREVIVE (regra fraca)" "$(st farmer_recommendations "$B" "$C1" '=0.6')" "pendente"
eq "A6 órfã de TERCEIRO também expira (auto-saneante)" "$(st farmer_recommendations "$T" "$C1" '=0.4')" "expirado"
eq "A7 desfecho 'ofertado' é imutável"                "$(st farmer_recommendations "$A" "$C1" "=0.9 AND status<>'aceito' AND status<>'rejeitado'")" "ofertado"
eq "A8 desfecho 'aceito' é imutável"                  "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE customer_user_id='$C1' AND status='aceito';")" "1"
eq "A9 desfecho 'rejeitado' é imutável"               "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE customer_user_id='$C1' AND status='rejeitado';")" "1"
eq "A10 cliente NÃO envolvido fica intocado"          "$(st farmer_recommendations "$A" "$C2" '=0.5')" "pendente"
eq "A11 bundle do dono antigo expira"                 "$(stb "$A" "$C1" 0.5)" "expirado"
eq "A12 bundle do dono NOVO sobrevive"                "$(stb "$B" "$C1" 0.6)" "pendente"
eq "A13 NUNCA deleta (contagem preservada)"           "$(total)" "$ANTES"

echo "─── B) perda de dono (DELETE do score) ───"
semear
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='$C3';"
eq "B1 DELETE expira a pendente do cliente"     "$(st farmer_recommendations "$A" "$C3" '=0.5')" "expirado"
eq "B2 motivo gravado = perda_de_dono"          "$(motivo "$A" "$C3" '=0.5')"                    "perda_de_dono"
eq "B3 cliente vizinho intocado"                "$(st farmer_recommendations "$A" "$C2" '=0.5')" "pendente"

echo "─── C) o que NÃO deve disparar ───"
semear
P -q -c "UPDATE public.farmer_client_scores SET health_score=99 WHERE customer_user_id='$C1';"
eq "C1 UPDATE de OUTRA coluna não expira nada"  "$(st farmer_recommendations "$A" "$C1" '=0.5')" "pendente"
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$A' WHERE customer_user_id='$C1';"
eq "C2 UPDATE de farmer_id p/ o MESMO valor (no-op) não expira" "$(st farmer_recommendations "$A" "$C1" '=0.5')" "pendente"

echo "─── D) vocabulário fechado de expired_reason (CHECK) ───"
semear
D1="$(Pq -c "DO \$t\$ BEGIN
  UPDATE public.farmer_recommendations SET status='expirado', expired_at=now(), expired_reason='troca_dono'
   WHERE customer_user_id='$C2';
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHECK_MORDEU';
          WHEN OTHERS THEN RAISE;
END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  //p' | tail -1)"
eq "D1 typo no motivo é REJEITADO pelo CHECK" "$D1" "CHECK_MORDEU"
D2="$(Pq -c "DO \$t\$ BEGIN
  UPDATE public.farmer_recommendations SET expired_reason='troca_de_dono' WHERE customer_user_id='$C2';
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHECK_MORDEU';
          WHEN OTHERS THEN RAISE;
END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  //p' | tail -1)"
eq "D2 motivo em linha NÃO expirada é REJEITADO" "$D2" "CHECK_MORDEU"

echo "─── E) o sensor (denominador + ponto cego + gate) ───"
semear
eq "E1 sensor ENXERGA a violação plantada no seed" "$(sensor violacoes farmer_recommendations)" "2"
eq "E2 sensor: denominador = TODAS as pendentes" "$(sensor pendentes_total farmer_recommendations)" "5"
# cria a violação dos dois tipos, SEM trigger (é o estado que o sensor precisa enxergar)
P -q -c "ALTER TABLE public.farmer_client_scores DISABLE TRIGGER trg_fcs_troca_dono_expira_pendentes;
         ALTER TABLE public.farmer_client_scores DISABLE TRIGGER trg_fcs_perda_dono_expira_pendentes;
         UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C1';
         DELETE FROM public.farmer_client_scores WHERE customer_user_id='$C3';
         ALTER TABLE public.farmer_client_scores ENABLE TRIGGER trg_fcs_troca_dono_expira_pendentes;
         ALTER TABLE public.farmer_client_scores ENABLE TRIGGER trg_fcs_perda_dono_expira_pendentes;"
eq "E3 sensor CONTA o dono divergente"           "$(sensor pendentes_dono_divergente farmer_recommendations)" "2"
eq "E4 sensor CONTA o ponto cego (sem score)"    "$(sensor pendentes_sem_dono farmer_recommendations)" "1"
eq "E5 violações = divergente + sem dono"        "$(sensor violacoes farmer_recommendations)" "3"
ne "E6 pct_violacao existe quando há universo"   "$(sensor pct_violacao farmer_recommendations)" ""
P -q -c "UPDATE public.farmer_bundle_recommendations SET status='expirado', expired_at=now() WHERE status='pendente';"
eq "E7 pct é NULL (não 0) sem universo"          "$(sensor "coalesce(pct_violacao::text,'NULO')" farmer_bundle_recommendations)" "NULO"
E8="$(Pq -c "SET test.uid='$A'; SET test.role='authenticated'; SET test.cap_ler='off';
  DO \$t\$ BEGIN PERFORM * FROM public.farmer_escopo_invariante(); RAISE NOTICE 'PASSOU_INDEVIDO';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU';
            WHEN OTHERS THEN RAISE; END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  //p' | tail -1)"
eq "E8 sensor NEGA quem não tem cap_carteira_ler" "$E8" "NEGOU"

echo "─── F) saneamento único é idempotente e alcança o ponto cego ───"
# reaplica só a §6 do arquivo, sobre o estado sujo criado em E
P -q -c "SET test.role='service_role';" >/dev/null
sed -n '/─── 6) Saneamento/,/─── 7) As duas RPCs/p' "$MIG" | P -q -f - >/dev/null
eq "F1 saneamento zera as violações"             "$(sensor violacoes farmer_recommendations)" "0"
eq "F2 marcou motivo = saneamento_escopo"        "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE expired_reason='saneamento_escopo';")" "3"

echo "─── G) CONCORRÊNCIA: o lock causal (achado do challenge Codex) ───"
# O cenário que a trigger sozinha NÃO cobre: a RPC de A já passou pelo gate FG009 quando a
# troca comita — a oferta nasce DEPOIS da varredura da trigger. O `FOR SHARE` das RPCs faz
# a troca ESPERAR o commit da RPC. Aqui isso é observável como lock_timeout (55P03).
concorrencia() {  # ecoa a SQLSTATE que a troca recebeu enquanto a RPC estava aberta
  semear >/dev/null
  rm -f "$SINAL"
  ( P -q <<SQL2 >/dev/null 2>&1
BEGIN;
SET test.uid='$A'; SET test.role='authenticated';
SELECT public.farmer_recomendacoes_substituir(
  '$A'::uuid, gen_random_uuid(), '$RUN0'::uuid,
  '[{"customer_user_id":"$C4","recommendation_type":"cross_sell","product_id":"$PROD","affinity_score":0.7}]'::jsonb,
  'completa', NULL, NULL, NULL);
\! touch $SINAL
SELECT pg_sleep(5);
COMMIT;
SQL2
  ) &
  local bg=$!
  local i=0
  while [ ! -f "$SINAL" ] && [ $i -lt 100 ]; do i=$((i+1)); "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tAc "SELECT pg_sleep(0.1);" >/dev/null 2>&1; done
  [ -f "$SINAL" ] || { echo "SINAL_NAO_VEIO"; wait $bg 2>/dev/null || true; return; }
  Pq -c "SET lock_timeout='1500ms';
    DO \$t\$ BEGIN
      UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C4';
      RAISE NOTICE 'TROCA_PASSOU';
    EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'TROCA_ESPEROU';
              WHEN OTHERS THEN RAISE;
    END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  //p' | tail -1
  wait $bg 2>/dev/null || true
}
G1="$(concorrencia)"
eq "G1 troca de dono ESPERA a RPC aberta (FOR SHARE morde)" "$G1" "TROCA_ESPEROU"
# depois que a RPC comitou, a troca passa e a trigger alcança a linha NOVA — que é
# exatamente a que nasceu DEPOIS da varredura, o caso que a trigger sozinha não cobre.
eq "G2 a RPC gerou a oferta nova para o cliente"     \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$A' AND customer_user_id='$C4' AND status='pendente';")" "1"
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C4';"
eq "G3 a oferta NOVA é alcançada pela trigger"       \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$A' AND customer_user_id='$C4' AND status='pendente';")" "0"
eq "G4 desfecho da corrida: nada de C4 fora de escopo" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations r
               JOIN public.farmer_client_scores s USING (customer_user_id)
              WHERE r.customer_user_id='$C4' AND r.status='pendente'
                AND r.farmer_id IS DISTINCT FROM s.farmer_id;")" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota, exige VERMELHO, restaura.
# Sentinela anti-teatro: as strings comparadas ('expirado','TROCA_PASSOU') são valores de
# DADO, não texto que o código sob teste emita — nenhum ILIKE casa a própria sentinela.
# ══════════════════════════════════════════════════════════════════════════════
echo "─── Z) falsificação ───"
FALS_OK=0; FALS_BAD=0
fals() { if [ "$2" = "$3" ]; then FALS_BAD=$((FALS_BAD+1)); echo "  ❌ $1 — sabotagem NÃO foi detectada (assert sem dente)"; else FALS_OK=$((FALS_OK+1)); echo "  ✅ $1 (sabotado → [$2], real seria [$3])"; fi; }

# Z1: dropar a trigger de UPDATE → A1 tem de ficar vermelho.
P -q -c "DROP TRIGGER trg_fcs_troca_dono_expira_pendentes ON public.farmer_client_scores;"
semear
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C1';"
fals "Z1 sem a trigger de UPDATE, a pendente do dono antigo SOBREVIVE" "$(st farmer_recommendations "$A" "$C1" '=0.5')" "expirado"
P -q -c "CREATE TRIGGER trg_fcs_troca_dono_expira_pendentes
  AFTER UPDATE OF farmer_id ON public.farmer_client_scores FOR EACH ROW
  WHEN (OLD.farmer_id IS DISTINCT FROM NEW.farmer_id)
  EXECUTE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior();"

# Z2: trocar `IS DISTINCT FROM` por `<>` → o ramo do DELETE para de expirar (NULL some no WHERE).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_dono_novo uuid; v_motivo text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_dono_novo := NULL; v_motivo := 'perda_de_dono';
  ELSE v_dono_novo := NEW.farmer_id; v_motivo := 'troca_de_dono'; END IF;
  UPDATE public.farmer_recommendations
     SET status='expirado', expired_at=clock_timestamp(), expired_reason=v_motivo, updated_at=clock_timestamp()
   WHERE customer_user_id = OLD.customer_user_id AND status='pendente'
     AND farmer_id <> v_dono_novo;                      -- ← SABOTAGEM
  RETURN NULL;
END $f$;
SQL
semear
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='$C3';"
fals "Z2 com '<>' no lugar de IS DISTINCT FROM, o DELETE não expira NADA" "$(st farmer_recommendations "$A" "$C3" '=0.5')" "expirado"
P -q -f "$MIG" >/dev/null 2>&1   # restaura a função verdadeira

# Z3: tirar o `AND status='pendente'` → o desfecho imutável passa a ser destruído.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_dono_novo uuid; v_motivo text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_dono_novo := NULL; v_motivo := 'perda_de_dono';
  ELSE v_dono_novo := NEW.farmer_id; v_motivo := 'troca_de_dono'; END IF;
  UPDATE public.farmer_recommendations
     SET status='expirado', expired_at=clock_timestamp(), expired_reason=v_motivo, updated_at=clock_timestamp()
   WHERE customer_user_id = OLD.customer_user_id                 -- ← SABOTAGEM: sem o filtro de status
     AND farmer_id IS DISTINCT FROM v_dono_novo;
  RETURN NULL;
END $f$;
SQL
semear
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$B' WHERE customer_user_id='$C1';"
fals "Z3 sem o filtro de status, o desfecho 'aceito' é DESTRUÍDO" \
     "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE customer_user_id='$C1' AND status='aceito';")" "1"
P -q -f "$MIG" >/dev/null 2>&1

# Z4: tirar o FOR SHARE das RPCs → a troca deixa de esperar (a corrida do Codex reabre).
SAB="$(mktemp -t mig-sem-forshare.XXXXXX)"
sed '/^  PERFORM 1$/,/^     FOR SHARE;$/d' "$MIG" > "$SAB"
# GUARD: uma sabotagem que não sabota pinta verde. Antes: 2 (uma por RPC).
REST="$(grep -c '^     FOR SHARE;$' "$SAB" || true)"
[ "$REST" = "0" ] || { echo "  ❌ Z4 ABORTADO: a sabotagem não removeu o FOR SHARE (restaram $REST)"; FAIL=$((FAIL+1)); }
P -q -f "$SAB" >/dev/null
rm -f "$SAB"
Z4="$(concorrencia)"
fals "Z4 sem o FOR SHARE, a troca NÃO espera (corrida reaberta)" "$Z4" "TROCA_ESPEROU"
P -q -f "$MIG" >/dev/null 2>&1

echo
echo "═══ RESULTADO ═══"
echo "asserts: $PASS passaram, $FAIL falharam"
echo "falsificação: $FALS_OK sabotagens detectadas, $FALS_BAD passaram batido"
[ "$FAIL" -eq 0 ] && [ "$FALS_BAD" -eq 0 ] || exit 1
echo "VERDE-REAL"
