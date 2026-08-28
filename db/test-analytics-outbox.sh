#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260825214545_analytics_outbox.sql                             ║
# ║      bash db/test-analytics-outbox.sh > /tmp/t.log 2>&1; echo "exit=$?"        ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                                ║
# ║  O que esta prova existe para pegar: plpgsql é late-bound. O trigger, a RPC do ║
# ║  ledger e o claim com SKIP LOCKED passam no CREATE e só quebram EXECUTANDO —   ║
# ║  e o trigger roda dentro da transação que APROVA UMA COMPRA. Um erro dele que  ║
# ║  não fosse fail-open reprovaria o money-path por causa de telemetria.          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="analytics-outbox"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ O ALTER DEFAULT PRIVILEGES abaixo NÃO é enfeite: ele reproduz o que o
# Supabase faz no schema public, e é o que dá TRABALHO REAL ao `REVOKE ... FROM
# authenticated` da migration. Sem ele, `authenticated` já não teria privilégio
# nenhum e o assert do REVOKE passaria por vacuidade — verde por ausência de
# grant, não por presença de defesa.
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);

-- espelha as colunas REAIS da prod (medidas 2026-08-25 via psql-ro):
-- id é bigint e aprovado_por é TEXT guardando e-mail — não uuid.
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id                 bigserial PRIMARY KEY,
  status             text NOT NULL,
  criado_em          timestamptz DEFAULT now(),
  atualizado_em      timestamptz DEFAULT now(),
  aprovado_em        timestamptz,
  aprovado_por       text,
  cancelado_em       timestamptz,
  condicao_origem    text,
  origem_evento_tipo text
);

-- stub do pg_cron (a migration agenda a purga).
-- ⚠️ `cron.job` já vem de db/stubs-supabase.sql, com `jobid bigint PRIMARY KEY`
-- SEM default — por isso o jobid é gerado aqui em vez de recriar a tabela (o
-- CREATE TABLE IF NOT EXISTS não teria efeito e o INSERT quebraria no NOT NULL).
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
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
UID_A='11111111-1111-1111-1111-111111111111'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$UID_A') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$UID_A', 'employee');
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: caminho (A), fato de domínio ──"

P -q -c "INSERT INTO public.pedido_compra_sugerido(id, status, condicao_origem) VALUES (7001, 'pendente_aprovacao', 'cmc');"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='reposicao.sugestao_criada' AND props->>'sugestao_id'='7001';")
eq "A1 INSERT emite sugestao_criada" "$V" "1"

P -q -c "UPDATE public.pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='lucas@exemplo.com', status='disparado' WHERE id=7001;"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada' AND props->>'sugestao_id'='7001';")
eq "A2 aprovado_em NULL→NOT NULL emite sugestao_aprovada" "$V" "1"

# O funil não pode colapsar: a chave_dedup inclui o EVENTO, não só o id.
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE props->>'sugestao_id'='7001';")
eq "A3 funil preserva as 2 transicoes do MESMO pedido" "$V" "2"

# PII: o e-mail de aprovado_por NUNCA pode chegar ao payload.
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE props::text LIKE '%@%';")
eq "A4 nenhum e-mail no payload" "$V" "0"
V=$(Pq -c "SELECT props->>'aprovacao_humana' FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada' AND props->>'sugestao_id'='7001';")
eq "A5 aprovacao_humana diz SE houve humano" "$V" "true"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE user_id IS NOT NULL;")
eq "A6 evento de dominio nao carrega titular" "$V" "0"

# Re-aplicar a MESMA transição não duplica (ON CONFLICT DO NOTHING).
P -q -c "UPDATE public.pedido_compra_sugerido SET status='disparado' WHERE id=7001;"
P -q -c "INSERT INTO public.pedido_compra_sugerido(id, status) VALUES (7001, 'x') ON CONFLICT (id) DO NOTHING;"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE props->>'sugestao_id'='7001';")
eq "A7 transicao repetida nao duplica" "$V" "2"

# UPDATE que NÃO é transição não pode emitir nada.
ANTES=$(Pq -c "SELECT count(*) FROM public.analytics_outbox;")
P -q -c "UPDATE public.pedido_compra_sugerido SET condicao_origem='outra' WHERE id=7001;"
DEPOIS=$(Pq -c "SELECT count(*) FROM public.analytics_outbox;")
eq "A8 UPDATE sem transicao nao emite" "$DEPOIS" "$ANTES"

P -q -c "INSERT INTO public.pedido_compra_sugerido(id, status) VALUES (7002, 'pendente_aprovacao');"
P -q -c "UPDATE public.pedido_compra_sugerido SET status='expirado_sem_aprovacao' WHERE id=7002;"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='reposicao.sugestao_expirada' AND props->>'sugestao_id'='7002';")
eq "A9 status->expirado emite sugestao_expirada" "$V" "1"

echo "── asserts: caminho (B), ledger autenticado ──"

V=$(Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SELECT public.analytics_ledger_registrar('carteira.mixgap_servido','com_gap:fresco','{\"total\":3}'::jsonb); SELECT count(*) FROM public.analytics_outbox WHERE evento='carteira.mixgap_servido';" | tail -1)
eq "A10 ledger registra evento da allowlist" "$V" "1"
V=$(Pq -c "SELECT user_id::text = distinct_id FROM public.analytics_outbox WHERE evento='carteira.mixgap_servido';")
eq "A11 identidade vem de auth.uid(), nao do parametro" "$V" "t"
V=$(Pq -c "SELECT user_id::text FROM public.analytics_outbox WHERE evento='carteira.mixgap_servido';")
eq "A12 titular e o uid autenticado" "$V" "$UID_A"

# Mesma chave no mesmo dia não duplica.
Pq -c "SET test.uid='$UID_A'; SELECT public.analytics_ledger_registrar('carteira.mixgap_servido','com_gap:fresco','{}'::jsonb);" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='carteira.mixgap_servido';")
eq "A13 ledger dedupa por chave+dia" "$V" "1"

# NEGATIVO: evento fora da allowlist → 22023. Sentinela anti-teatro: 'SENT_ALLOW_OK'
# não aparece em lugar nenhum da migration (o código emite 'fora da allowlist').
R=$(P -tA 2>&1 <<SQL
SET test.uid='$UID_A';
DO \$t\$ BEGIN
  PERFORM public.analytics_ledger_registrar('carteira.qualquer_coisa','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ALLOW_FURADO';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENT_ALLOW_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
case "$R" in *SENT_ALLOW_OK*) ok "A14 evento fora da allowlist rejeitado (22023)";; *) bad "A14 allowlist NAO barrou — [$R]";; esac

# NEGATIVO: sem auth.uid() → 28000.
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='';
DO $t$ BEGIN
  PERFORM public.analytics_ledger_registrar('carteira.mixgap_servido','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ANON_FURADO';
EXCEPTION
  WHEN invalid_authorization_specification THEN RAISE NOTICE 'SENT_ANON_OK';
  WHEN OTHERS THEN RAISE;
END $t$;
SQL
)
case "$R" in *SENT_ANON_OK*) ok "A15 ledger sem autenticacao rejeitado (28000)";; *) bad "A15 anonimo passou — [$R]";; esac

echo "── asserts: fronteira (RLS + REVOKE) ──"

# authenticated não escreve direto na outbox (REVOKE tirou o grant default).
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $t$ BEGIN
  INSERT INTO public.analytics_outbox(evento, distinct_id, chave_dedup) VALUES ('x.y','forjado','k1');
  RAISE NOTICE 'SENT_INS_FURADO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENT_INS_OK';
  WHEN OTHERS THEN RAISE;
END $t$;
SQL
)
case "$R" in *SENT_INS_OK*) ok "A16 authenticated nao insere direto (42501)";; *) bad "A16 escrita direta passou — [$R]";; esac

# authenticated não roda a API do worker.
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $t$ BEGIN
  PERFORM public.analytics_outbox_claim(10);
  RAISE NOTICE 'SENT_CLAIM_FURADO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENT_CLAIM_OK';
  WHEN OTHERS THEN RAISE;
END $t$;
SQL
)
case "$R" in *SENT_CLAIM_OK*) ok "A17 authenticated nao executa o claim (42501)";; *) bad "A17 claim exposto — [$R]";; esac

echo "── asserts: worker (claim / aceite / retencao) ──"

# O claim roda de verdade: RETURNS TABLE + SKIP LOCKED só quebram EXECUTANDO.
N=$(Pq -c "SELECT count(*) FROM public.analytics_outbox_claim(100);")
TOTAL=$(Pq -c "SELECT count(*) FROM public.analytics_outbox;")
eq "A18 claim devolve a fila inteira" "$N" "$TOTAL"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE tentativas=1;")
eq "A19 claim incrementa tentativas" "$V" "$TOTAL"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE proxima_tentativa_em > now();")
eq "A20 claim empurra o backoff ANTES do HTTP (lease)" "$V" "$TOTAL"
# 2º claim imediato não devolve nada — é o que impede dois crons sobrepostos
# reenviarem o mesmo evento.
N2=$(Pq -c "SELECT count(*) FROM public.analytics_outbox_claim(100);")
eq "A21 claim seguinte nao reivindica o que esta em backoff" "$N2" "0"

# Aceite encurta a retenção de 30 para 7 dias.
Pq -c "SELECT public.analytics_outbox_aceitar(ARRAY(SELECT id FROM public.analytics_outbox));" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE purgar_em < now() + interval '8 days';")
eq "A22 aceite encurta a retencao para 7 dias" "$V" "$TOTAL"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE aceito_em IS NULL;")
eq "A23 tudo marcado como aceito" "$V" "0"

# Purga: leva a vencida, preserva a que não venceu. Nenhuma linha é imortal.
P -q -c "UPDATE public.analytics_outbox SET purgar_em = now() - interval '1 day' WHERE evento='reposicao.sugestao_criada';"
VENCIDAS=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE purgar_em < now();")
REMOVIDAS=$(Pq -c "SELECT public.analytics_outbox_purgar();")
eq "A24 purga remove exatamente as vencidas" "$REMOVIDAS" "$VENCIDAS"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE purgar_em < now();")
eq "A25 nenhuma vencida sobrou" "$V" "0"
# Quarentena TAMBÉM expira — era a falha da posição refutada pelo Codex.
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE purgar_em IS NULL;")
eq "A26 nenhuma linha imortal (purgar_em NOT NULL)" "$V" "0"

echo "── assert: FAIL-OPEN (o invariante money-path) ──"
# Com a outbox indisponível, aprovar uma compra AINDA precisa funcionar.
# Sentinela anti-teatro: 'SENT_FAILOPEN_OK' não existe na migration.
P -q -c "ALTER TABLE public.analytics_outbox RENAME TO analytics_outbox_off;"
R=$(P -tA 2>&1 <<'SQL'
INSERT INTO public.pedido_compra_sugerido(id, status) VALUES (7003, 'pendente_aprovacao');
DO $t$ BEGIN
  UPDATE public.pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='x@y.com' WHERE id=7003;
  RAISE NOTICE 'SENT_FAILOPEN_OK';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'SENT_FAILOPEN_REPROVOU_A_COMPRA';
END $t$;
SQL
)
case "$R" in *SENT_FAILOPEN_OK*) ok "A27 outbox quebrada NAO reprova a aprovacao";; *) bad "A27 telemetria derrubou o money-path — [$R]";; esac
V=$(Pq -c "SELECT count(*) FROM public.pedido_compra_sugerido WHERE id=7003 AND aprovado_em IS NOT NULL;")
eq "A28 a aprovacao persistiu de fato" "$V" "1"
P -q -c "ALTER TABLE public.analytics_outbox_off RENAME TO analytics_outbox;"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificacao (asserts sem dente sao teatro) ──"
FALSIF_OK=0; FALSIF_MUDO=0
fals() { if [ "$1" = "vermelho" ]; then FALSIF_OK=$((FALSIF_OK+1)); echo "  🔴 $2 — sabotagem DETECTADA"; else FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ⚠️  $2 — sabotagem PASSOU (assert sem dente)"; fi; }

# F1 — allowlist trocada por porta aberta: A14 tem de virar vermelho.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(p_evento text, p_chave text, p_props jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  INSERT INTO public.analytics_outbox(evento, distinct_id, user_id, props, chave_dedup)
  VALUES (p_evento, coalesce(auth.uid()::text,'?'), auth.uid(), p_props, 'sab:' || p_evento || ':' || p_chave);
END; $fn$;
SQL
R=$(P -tA 2>&1 <<SQL
SET test.uid='$UID_A';
DO \$t\$ BEGIN
  PERFORM public.analytics_ledger_registrar('carteira.qualquer_coisa','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ALLOW_FURADO';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENT_ALLOW_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
case "$R" in *SENT_ALLOW_OK*) fals "verde" "F1 allowlist removida";; *) fals "vermelho" "F1 allowlist removida";; esac

# F2 — chave_dedup sem o EVENTO: o funil colapsa e A3 tem de cair para 1.
P -q -c "TRUNCATE public.analytics_outbox;"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.analytics_outbox_pedido_compra()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_evento := 'reposicao.sugestao_criada';
  ELSIF NEW.aprovado_em IS NOT NULL AND OLD.aprovado_em IS NULL THEN v_evento := 'reposicao.sugestao_aprovada';
  ELSE RETURN NULL; END IF;
  INSERT INTO public.analytics_outbox(evento, distinct_id, props, chave_dedup)
  VALUES (v_evento, 'sistema:reposicao', jsonb_build_object('sugestao_id', NEW.id), 'pcs:' || NEW.id::text)
  ON CONFLICT (chave_dedup) DO NOTHING;
  RETURN NULL;
END; $fn$;
SQL
P -q -c "INSERT INTO public.pedido_compra_sugerido(id, status) VALUES (7101, 'pendente_aprovacao');"
P -q -c "UPDATE public.pedido_compra_sugerido SET aprovado_em=now() WHERE id=7101;"
V=$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE props->>'sugestao_id'='7101';")
if [ "$V" = "2" ]; then fals "verde" "F2 chave_dedup sem o evento"; else fals "vermelho" "F2 chave_dedup sem o evento (funil colapsou p/ $V)"; fi

# F3 — fail-open removido: aprovar compra com a outbox quebrada tem de EXPLODIR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.analytics_outbox_pedido_compra()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_evento := 'reposicao.sugestao_criada';
  ELSIF NEW.aprovado_em IS NOT NULL AND OLD.aprovado_em IS NULL THEN v_evento := 'reposicao.sugestao_aprovada';
  ELSE RETURN NULL; END IF;
  INSERT INTO public.analytics_outbox(evento, distinct_id, props, chave_dedup)
  VALUES (v_evento, 'sistema:reposicao', jsonb_build_object('sugestao_id', NEW.id), 'pcs:' || NEW.id::text || ':' || v_evento)
  ON CONFLICT (chave_dedup) DO NOTHING;
  RETURN NULL;
END; $fn$;
SQL
P -q -c "ALTER TABLE public.analytics_outbox RENAME TO analytics_outbox_off;"
R=$(P -tA 2>&1 <<'SQL'
INSERT INTO public.pedido_compra_sugerido(id, status) VALUES (7102, 'pendente_aprovacao');
DO $t$ BEGIN
  UPDATE public.pedido_compra_sugerido SET aprovado_em=now() WHERE id=7102;
  RAISE NOTICE 'SENT_FAILOPEN_OK';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'SENT_FAILOPEN_REPROVOU_A_COMPRA';
END $t$;
SQL
) || true
case "$R" in *SENT_FAILOPEN_OK*) fals "verde" "F3 fail-open removido";; *) fals "vermelho" "F3 fail-open removido";; esac
P -q -c "ALTER TABLE public.analytics_outbox_off RENAME TO analytics_outbox;"

# F4 — REVOKE desfeito: authenticated volta a executar o claim.
P -q -c "GRANT EXECUTE ON FUNCTION public.analytics_outbox_claim(integer) TO authenticated;"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $t$ BEGIN
  PERFORM public.analytics_outbox_claim(10);
  RAISE NOTICE 'SENT_CLAIM_FURADO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENT_CLAIM_OK';
  WHEN OTHERS THEN RAISE;
END $t$;
SQL
)
case "$R" in *SENT_CLAIM_OK*) fals "verde" "F4 REVOKE do claim desfeito";; *) fals "vermelho" "F4 REVOKE do claim desfeito";; esac

# restaura a migration verdadeira (cirurgicamente: só o que foi sabotado)
P -q -f "$MIG"

echo "  falsificacao: $FALSIF_OK detectadas / $FALSIF_MUDO mudas"
[ "$FALSIF_MUDO" = "0" ] || FAIL=$((FAIL+1))

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
