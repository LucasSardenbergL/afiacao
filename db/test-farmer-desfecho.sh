#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="farmer-desfecho"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Stub FIEL de `farmer_recommendations`: colunas, CHECKs, RLS e a trigger de
# UPDATE copiados da PROD (psql-ro 2026-08-21). O snapshot inteiro não é usado de
# propósito — 36k linhas para provar uma RPC de 5 parâmetros, e ele pode estar stale.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

-- Capacidades da carteira: stub que devolve o que a PROD devolve. `test.gestor='on'`
-- simula o GESTOR (cap=true) — a policy o deixaria escrever na carteira alheia, e o
-- teste 11 prova que a RPC o barra assim mesmo.
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(u uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(current_setting('test.gestor', true) = 'on', false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(u uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(current_setting('test.gestor', true) = 'on', false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(c uuid, u uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;

CREATE TABLE public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  recommendation_type text NOT NULL,
  product_id uuid,
  current_product_id uuid,
  p_ij numeric DEFAULT 0,
  m_ij numeric DEFAULT 0,
  lie numeric DEFAULT 0,
  complexity_factor numeric DEFAULT 1.0,
  cluster_volume_estimate numeric DEFAULT 1,
  offered_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  actual_margin numeric,
  time_spent_seconds integer,
  status text DEFAULT 'pendente',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  affinity_score numeric,
  run_id uuid,
  expired_at timestamptz,
  expired_by_run uuid,
  CONSTRAINT farmer_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente','ofertado','aceito','rejeitado','expirado'])),
  CONSTRAINT farmer_recommendations_recommendation_type_check
    CHECK (recommendation_type = ANY (ARRAY['cross_sell','up_sell'])),
  CONSTRAINT farmer_recommendations_expirado_coerente
    CHECK ((status IS NOT NULL) AND ((status = 'expirado') = (expired_at IS NOT NULL)))
);

-- Trigger REAL de prod que roda em UPDATE (private.frec_sem_margem): anula m_ij/lie.
-- Está aqui porque o caminho sob teste É um UPDATE — se ela interferisse no desfecho,
-- só um harness fiel pegaria.
CREATE OR REPLACE FUNCTION private.frec_sem_margem() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ BEGIN NEW.m_ij := NULL; NEW.lie := NULL; RETURN NEW; END $f$;
CREATE TRIGGER trg_frec_sem_margem BEFORE INSERT OR UPDATE ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem();

ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY frec_select_carteira ON public.farmer_recommendations FOR SELECT
  USING (private.cap_carteira_ler(auth.uid()) OR farmer_id = auth.uid()
         OR private.carteira_visivel_para(customer_user_id, auth.uid()));
CREATE POLICY frec_update_own_or_gestor ON public.farmer_recommendations FOR UPDATE
  USING (private.cap_carteira_escrever(auth.uid()) OR farmer_id = auth.uid())
  WITH CHECK (private.cap_carteira_escrever(auth.uid()) OR farmer_id = auth.uid());
SQL
echo "pré-requisitos aplicados"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1: o .sql commitado, não um stub da lógica)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260821194411_farmer_recomendacao_desfecho.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
VEND='11111111-1111-1111-1111-111111111111'
OUTRO='22222222-2222-2222-2222-222222222222'
CLI='33333333-3333-3333-3333-333333333333'
PRODA='44444444-4444-4444-4444-444444444444'
PRODB='55555555-5555-5555-5555-555555555555'
PRODC='77777777-7777-7777-7777-777777777777'
PRODD='88888888-8888-8888-8888-888888888888'

P -q <<SQL
GRANT USAGE ON SCHEMA public, private TO authenticated, anon;
GRANT SELECT, UPDATE ON public.farmer_recommendations TO authenticated;

INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status) VALUES
  ('$VEND', '$CLI','cross_sell','$PRODA', 42, 'pendente'),
  ('$VEND', '$CLI','up_sell',   '$PRODB', 37, 'pendente'),
  ('$VEND', '$CLI','cross_sell','$PRODC', 20, 'pendente'),
  ('$OUTRO','$CLI','cross_sell','$PRODA', 11, 'pendente');
-- histórico morto: oferta já substituída por um recompute anterior
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status, expired_at)
  VALUES ('$VEND','$CLI','cross_sell','$PRODD', 9, 'expirado', now());
SQL
echo "seed pronto"

# ── helpers ──────────────────────────────────────────────────────────────────
como()  { P  -q -c "SET ROLE authenticated; SET test.uid='$1'; $2" >/dev/null; }
val()   { Pq -c "$1"; }
# Assert NEGATIVO (Lei #2): exige a SQLSTATE ESPERADA e RE-LANÇA qualquer outra.
# Se a chamada NÃO falhar, levanta ZZ999 e reprova. `WHEN OTHERS THEN RAISE` impede
# que um erro DIFERENTE (inclusive um erro de digitação neste teste) pinte verde.
neg() { # neg <nome> <uid> <sqlstate> <chamada> [gestor]
  local nome="$1" uid="$2" ss="$3" chamada="$4" gestor="${5:-off}"
  if P -q -c "SET ROLE authenticated; SET test.uid='$uid'; SET test.gestor='$gestor';
      DO \$T\$ BEGIN
        PERFORM $chamada;
        RAISE EXCEPTION 'assert_nao_barrou' USING ERRCODE='ZZ999';
      EXCEPTION
        WHEN sqlstate '$ss' THEN NULL;
        WHEN OTHERS THEN RAISE;
      END \$T\$;" >/dev/null 2>&1; then
    ok "$nome (barrou com $ss)"
  else
    bad "$nome — NÃO barrou com $ss (ou veio erro diferente)"
  fi
}
# Idem para SQL cru (CHECK/trigger), com a SQLSTATE esperada.
negsql() { # negsql <nome> <sqlstate> <sql>
  if P -q -c "DO \$T\$ BEGIN
        $3
        RAISE EXCEPTION 'assert_nao_barrou' USING ERRCODE='ZZ999';
      EXCEPTION
        WHEN sqlstate '$2' THEN NULL;
        WHEN OTHERS THEN RAISE;
      END \$T\$;" >/dev/null 2>&1; then
    ok "$1 (barrou com $2)"
  else
    bad "$1 — NÃO barrou com $2 (ou veio erro diferente)"
  fi
}
RPC='public.farmer_recomendacao_registrar_desfecho'

echo ""
echo "═══ CONTROLE POSITIVO (a fixture produz oferta, e o zero de partida é REAL) ═══"
eq "00a a fixture tem ofertas pendentes do vendedor" \
   "$(val "SELECT count(*)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND status='pendente'")" "3"
eq "00b ZERO desfecho antes de qualquer registro" \
   "$(val "SELECT count(*)::text FROM farmer_recommendations WHERE accepted_at IS NOT NULL OR rejected_at IS NOT NULL")" "0"

echo ""
echo "═══ POSITIVOS ═══"
# 01 — pendente → aceito
como "$VEND" "SELECT $RPC('$CLI','$PRODA','cross_sell','aceito');"
eq "01a status vira aceito" \
   "$(val "SELECT status FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA'")" "aceito"
eq "01b accepted_at carimbado" \
   "$(val "SELECT (accepted_at IS NOT NULL)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA'")" "true"

# 02 — [money-path: ausente ≠ zero] o toque captura UM fato
eq "02a actual_margin continua NULL (não 0)" \
   "$(val "SELECT (actual_margin IS NULL)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA'")" "true"
eq "02b time_spent_seconds continua NULL (não 0)" \
   "$(val "SELECT (time_spent_seconds IS NULL)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA'")" "true"
eq "02c offered_at NÃO é fabricado com o instante do clique" \
   "$(val "SELECT (offered_at IS NULL)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA'")" "true"

# 03 — pendente → rejeitado grava o PORQUÊ
como "$VEND" "SELECT $RPC('$CLI','$PRODB','up_sell','rejeitado','preco');"
eq "03 rejeitado COM motivo" \
   "$(val "SELECT status||'/'||rejection_reason FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODB'")" "rejeitado/preco"

# 04 — O TESTE CENTRAL DO HANDOFF: o desfecho SOBREVIVE ao recompute.
# O statement é VERBATIM o da RPC `farmer_recomendacoes_substituir` em PROD
# (pg_get_functiondef, psql-ro 2026-08-21): expira `status='pendente'` do farmer e
# insere a geração nova. 04c prova o COMPLEMENTO — nenhuma linha com desfecho
# pertence ao conjunto que ela expira — para o teste não seguir verde e mentir se
# um dia o predicado dela mudar.
P -q -c "UPDATE public.farmer_recommendations
            SET status='expirado', expired_at=clock_timestamp(),
                expired_by_run='66666666-6666-6666-6666-666666666666', updated_at=clock_timestamp()
          WHERE farmer_id='$VEND' AND status='pendente';
         INSERT INTO public.farmer_recommendations
           (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status)
           VALUES ('$VEND','$CLI','cross_sell','$PRODA', 44, 'pendente');"
eq "04a recompute NÃO expirou o 'aceito'" \
   "$(val "SELECT status FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA' AND accepted_at IS NOT NULL")" "aceito"
eq "04b recompute NÃO expirou o 'rejeitado' nem apagou o motivo" \
   "$(val "SELECT status||'/'||coalesce(rejection_reason,'SUMIU') FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODB'")" "rejeitado/preco"
eq "04c nenhuma linha com desfecho está no conjunto que o recompute expira" \
   "$(val "SELECT count(*)::text FROM farmer_recommendations WHERE status='pendente' AND (accepted_at IS NOT NULL OR rejected_at IS NOT NULL)")" "0"
eq "04d a geração NOVA da mesma chave nasce pendente e registrável" \
   "$(val "SELECT count(*)::text FROM farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA' AND status='pendente'")" "1"

echo ""
echo "═══ NEGATIVOS ═══"
neg "05 desfecho fora do vocabulário"        "$VEND" "FD002" "$RPC('$CLI','$PRODA','cross_sell','talvez')"
# 'ofertado' é recusado DE PROPÓSITO (ver a nota de escopo no fim da migration):
# o estado intermediário é a fonte da ambiguidade R1/R2 que o /codex encontrou.
neg "06 'ofertado' recusado (escopo deliberado)" "$VEND" "FD002" "$RPC('$CLI','$PRODA','cross_sell','ofertado')"
neg "07 recusa SEM motivo"                   "$VEND" "FD003" "$RPC('$CLI','$PRODA','cross_sell','rejeitado')"
neg "08 recusa com motivo em BRANCO"         "$VEND" "FD003" "$RPC('$CLI','$PRODA','cross_sell','rejeitado','   ')"
neg "09 motivo de recusa num ACEITE"         "$VEND" "FD003" "$RPC('$CLI','$PRODA','cross_sell','aceito','preco')"
# ⚠️ O assert da LENTE "Ver como": o GESTOR (cap_carteira_escrever=true, que a policy
# deixaria passar) tenta registrar na carteira da vendedora. Barra porque o farmer_id
# da RPC é auth.uid() FIXO — defesa estrutural, não `disabled` de UI.
neg "10 GESTOR não registra na carteira alheia" "$OUTRO" "FD004" "$RPC('$CLI','$PRODA','cross_sell','aceito')" "on"
neg "11 oferta EXPIRADA não recebe desfecho"    "$VEND" "FD004" "$RPC('$CLI','$PRODD','cross_sell','aceito')"
neg "12 par cliente/produto inexistente"        "$VEND" "FD004" "$RPC('$CLI','$OUTRO','cross_sell','aceito')"
neg "13 desfecho TERMINAL não se reescreve"     "$VEND" "FD004" "$RPC('$CLI','$PRODB','up_sell','aceito')"
neg "14 sem auth.uid() → FD001, não 'não encontrado'" "" "FD001" "$RPC('$CLI','$PRODA','cross_sell','aceito')"

# 15 — AMBIGUIDADE → RECUSA (não escolha). Duas pendentes com a MESMA chave.
P -q -c "INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status)
  VALUES ('$VEND','$CLI','cross_sell','$PRODA', 45, 'pendente');"
neg "15 chave AMBÍGUA recusa em vez de carimbar a errada" "$VEND" "FD006" "$RPC('$CLI','$PRODA','cross_sell','aceito')"
P -q -c "DELETE FROM public.farmer_recommendations WHERE farmer_id='$VEND' AND product_id='$PRODA' AND affinity_score=45;"

echo ""
echo "═══ DEFESAS NO BANCO (independentes da RPC) ═══"
# 16 — o furo que o /codex apontou: `authenticated` tem `w` na tabela, então um
# UPDATE DIRETO poderia reescrever um desfecho deixando o estado final coerente.
negsql "16 trigger congela desfecho terminal contra UPDATE DIRETO" "FD007" \
  "UPDATE public.farmer_recommendations SET status='aceito', accepted_at=now(), rejected_at=NULL, rejection_reason=NULL WHERE product_id='$PRODB' AND status='rejeitado';"
# 17 — CHECK de coerência: status sem carimbo
negsql "17 CHECK barra status='aceito' SEM accepted_at" "23514" \
  "UPDATE public.farmer_recommendations SET status='aceito' WHERE farmer_id='$VEND' AND status='pendente';"
# 18 — a EQUIVALÊNCIA do motivo (a versão anterior deixava passar recusa sem porquê)
negsql "18 CHECK barra recusa SEM motivo" "23514" \
  "UPDATE public.farmer_recommendations SET status='rejeitado', rejected_at=now() WHERE farmer_id='$VEND' AND status='pendente';"
# 19 — vocabulário fechado do motivo
negsql "19 CHECK barra motivo fora do vocabulário" "23514" \
  "UPDATE public.farmer_recommendations SET status='rejeitado', rejected_at=now(), rejection_reason='achei_feio' WHERE farmer_id='$VEND' AND status='pendente';"
# 20 — ACL: o REVOKE nomeando a role
negsql "20 anon não executa a RPC (REVOKE por nome)" "42501" \
  "SET LOCAL ROLE anon; PERFORM $RPC('$CLI','$PRODA','cross_sell','aceito');"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura.
#
# Um assert que continua verde depois da sabotagem não tem dente: ele está
# provando outra coisa (ou nada). Aqui cada sabotagem é CIRÚRGICA — recria só o
# objeto atacado — e o alvo é reaplicar a migration real logo em seguida.
#
# ⚠️ Sentinela anti-teatro: o veredito de cada falsificação é a SQLSTATE que o
# assert original exige, comparada por igualdade EXATA em ASCII (`FD004`, `23514`,
# `FD006`, `FD007`) — nunca um `ILIKE` sobre a mensagem, que casaria o próprio
# texto da sentinela e mentiria. Imune a locale (§CLAUDE.md #1483).
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "═══ FALSIFICAÇÃO ═══"
FALS_OK=0; FALS_BAD=0
# roda um SQL e imprime a SQLSTATE que veio (ou 'NENHUM_ERRO')
sqlstate_de() {
  P -q -c "DO \$T\$ BEGIN
      $1
      RAISE NOTICE 'SENTINELA_SEM_ERRO';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'SENTINELA_ESTADO=%', SQLSTATE;
    END \$T\$;" 2>&1 | command grep -oE 'SENTINELA_ESTADO=[A-Z0-9]{5}|SENTINELA_SEM_ERRO' | head -1
}
# Exige que, DEPOIS da sabotagem, a defesa NÃO barre mais (= o assert ficaria vermelho).
falsifica() { # falsifica <nome> <estado_que_a_defesa_produzia> <sql_de_prova>
  local nome="$1" esperado_antes="SENTINELA_ESTADO=$2" veio
  veio="$(sqlstate_de "$3")"
  if [ "$veio" = "$esperado_antes" ]; then
    FALS_BAD=$((FALS_BAD+1)); echo "  ❌ FALSIFICAÇÃO INERTE: $nome — sabotado e AINDA barrou com $2 (assert não tem dente)"
  else
    FALS_OK=$((FALS_OK+1)); echo "  ✅ $nome — sabotado ⇒ deixou passar (veio [$veio]); o assert TEM dente"
  fi
}
restaura() { P -q -f "$MIG"; }

# ── F1: remover o `farmer_id = auth.uid()` FIXO ⇒ o assert 10 (lente/carteira
#        alheia) tem de deixar de barrar. Se continuasse barrando, o assert 10
#        estaria provando outra coisa (ex.: a policy) e não o gate da RPC.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.farmer_recomendacao_registrar_desfecho(
  p_customer_user_id uuid, p_product_id uuid, p_recommendation_type text,
  p_desfecho text, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.farmer_recommendations
   WHERE customer_user_id = p_customer_user_id AND product_id = p_product_id
     AND recommendation_type = p_recommendation_type AND status = 'pendente'
   LIMIT 1;                       -- SABOTAGEM: sem farmer_id = auth.uid()
  IF v_id IS NULL THEN RAISE EXCEPTION 'nao_achou' USING ERRCODE='FD004'; END IF;
  UPDATE public.farmer_recommendations SET status='aceito', accepted_at=clock_timestamp() WHERE id=v_id;
  RETURN '{}'::jsonb;
END $$;
SQL
falsifica "F1 gate farmer_id=auth.uid() (assert 10)" "FD004" \
  "SET LOCAL ROLE authenticated; PERFORM set_config('test.uid','$OUTRO',true); PERFORM set_config('test.gestor','on',true);
   PERFORM $RPC('$CLI','$PRODA','cross_sell','aceito');"
restaura
P -q -c "UPDATE public.farmer_recommendations SET status='pendente', accepted_at=NULL
          WHERE farmer_id='$VEND' AND product_id='$PRODA' AND status='aceito' AND affinity_score=44;"

# ── F2: dropar o CHECK de motivo ⇒ o assert 18 (recusa SEM porquê) tem de passar.
P -q -c "ALTER TABLE public.farmer_recommendations DROP CONSTRAINT farmer_recommendations_motivo_coerente;"
falsifica "F2 CHECK de motivo (assert 18)" "23514" \
  "UPDATE public.farmer_recommendations SET status='rejeitado', rejected_at=now()
    WHERE farmer_id='$VEND' AND status='pendente';"
P -q -c "UPDATE public.farmer_recommendations SET status='pendente', rejected_at=NULL
          WHERE farmer_id='$VEND' AND status='rejeitado' AND rejection_reason IS NULL;"
restaura

# ── F3: dropar a trigger ⇒ o assert 16 (UPDATE direto reescrevendo desfecho) tem
#        de passar. É a prova de que a imutabilidade vem da TRIGGER e não do CHECK.
P -q -c "DROP TRIGGER trg_frec_desfecho_imutavel ON public.farmer_recommendations;"
falsifica "F3 trigger de imutabilidade (assert 16)" "FD007" \
  "UPDATE public.farmer_recommendations SET status='aceito', accepted_at=now(), rejected_at=NULL, rejection_reason=NULL
    WHERE product_id='$PRODB' AND status='rejeitado';"
P -q -c "UPDATE public.farmer_recommendations SET status='rejeitado', rejected_at=now(), rejection_reason='preco', accepted_at=NULL
          WHERE product_id='$PRODB' AND status='aceito';"
restaura

# ── F4: trocar o guard de ambiguidade pelo `ORDER BY ... LIMIT 1` do desenho
#        ORIGINAL ⇒ o assert 15 tem de deixar de barrar. Esta é a falsificação que
#        prova que o achado do /codex foi de fato CORRIGIDO, e não só comentado.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.farmer_recomendacao_registrar_desfecho(
  p_customer_user_id uuid, p_product_id uuid, p_recommendation_type text,
  p_desfecho text, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.farmer_recommendations
   WHERE farmer_id = auth.uid() AND customer_user_id = p_customer_user_id
     AND product_id = p_product_id AND recommendation_type = p_recommendation_type
     AND status = 'pendente'
   ORDER BY created_at DESC, id DESC LIMIT 1;   -- SABOTAGEM: escolhe em vez de recusar
  IF v_id IS NULL THEN RAISE EXCEPTION 'nao_achou' USING ERRCODE='FD004'; END IF;
  UPDATE public.farmer_recommendations SET status='aceito', accepted_at=clock_timestamp() WHERE id=v_id;
  RETURN '{}'::jsonb;
END $$;
SQL
P -q -c "INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status)
  VALUES ('$VEND','$CLI','cross_sell','$PRODA', 45, 'pendente');"
falsifica "F4 guard de chave ambígua (assert 15)" "FD006" \
  "SET LOCAL ROLE authenticated; PERFORM set_config('test.uid','$VEND',true);
   PERFORM $RPC('$CLI','$PRODA','cross_sell','aceito');"
restaura

echo ""
echo "═══════════════════════════════════════════════════"
echo "  asserts:       $PASS ok / $FAIL falhos"
echo "  falsificações: $FALS_OK com dente / $FALS_BAD inertes"
echo "═══════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ] || [ "$FALS_BAD" -gt 0 ]; then exit 1; fi
echo "VERDE REAL"
