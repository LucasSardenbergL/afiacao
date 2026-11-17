#!/usr/bin/env bash
# Prova PG17 do ORÁCULO de dono das edges `kb-ingest-document` e `extrair-sinais-ligacao`
# (scanner Lovable Security, deep scan de 2026-11-17, lote 5).
#
# Não há migration neste lote. O que está sob teste é a PERGUNTA que o gate
# `supabase/functions/_shared/dono-pela-rls.ts` faz ao banco com o JWT do chamador:
#
#     PATCH /rest/v1/<tabela>?id=eq.<id>&select=id     corpo: {"id":"<id>"}
#     ≡  UPDATE public.<tabela> SET id = '<id>' WHERE id = '<id>' RETURNING id
#
# e a afirmação de que ela devolve a linha SE E SOMENTE SE a policy de UPDATE da tabela deixa aquele
# usuário alterar aquela linha — sem mudar valor nenhum. As policies abaixo são as de PROD, copiadas
# de `pg_get_expr(polqual/polwithcheck)` em 2026-11-17 (via psql-ro). As funções `has_role`,
# `private.cap_carteira_escrever`, `private.cap_carteira_ler` e `private.carteira_ve_tudo` são o
# corpo de PROD. `private.carteira_clientes_visiveis` é DUBLÊ (devolve os clientes cuja dona na
# carteira é o chamador): aqui ela só precisa produzir alguém que VÊ a ligação sem poder alterá-la.
#
# O que prova EXECUTANDO, sob SET ROLE authenticated + claims de JWT (como o PostgREST):
#  K0  CONTROLE do furo: com service_role (o cliente que a edge usava) o UPDATE em documento alheio
#      passa. É por isso que a edge precisa perguntar antes.
#  K1  autor do documento → a sonda devolve a linha.
#  K2  employee que NÃO é o autor → zero linha, e nada na linha muda (nem updated_at).
#  K3  master → devolve a linha.
#  K4  customer (sem papel de staff) e K5 anon → zero linha, sem erro.
#  K6  id inexistente → zero linha. K6c: idem para quem tem UM documento só, e o id dele não muda
#      (é o assert que cai sem o filtro: a sonda regravaria a PK do documento do próprio chamador).
#  K7  a sonda do autor não muda valor: só o updated_at anda (trigger BEFORE UPDATE de PROD).
#  K8  o filho com FK (kb_chunks) sobrevive à regravação da PK com o mesmo valor.
#  F1  dono da ligação (farmer_id) → devolve a linha.      F2  outro employee → zero linha.
#  F3  master → devolve a linha.
#  F4  gestor comercial (cap_carteira_ler) VÊ a ligação, mas a sonda devolve zero linha.
#  F5  dona da carteira do cliente VÊ a ligação de cobertura, mas a sonda devolve zero linha.
#  F6  a sonda NÃO dispara os triggers de recálculo (são `UPDATE OF <coluna>`).
#  F7  o filho com FK (farmer_agenda) sobrevive.
#  X1  USING passa e WITH CHECK reprova → 42501 (o PostgREST responde 403; o gate devolve 403).
#  X2  LIMITE DECLARADO: regra por VALOR de coluna. A sonda (no-op) passa e a escrita real que viria
#      depois é negada. A edge grava por service-role depois da sonda, então não veria essa regra.
#      Nas duas tabelas de PROD não há WITH CHECK por valor.
#
# O que a prova NÃO pega, por desenho: abrir só o WITH CHECK de `farmer_calls` deixa tudo verde. Na
# sonda a linha nova é igual à velha, então quem decide é o USING. X1 e X2 mostram o mecanismo numa
# tabela auxiliar.
#
# Uso:
#   bash db/test-seg-lote5-dono-pela-rls.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-seg-lote5-dono-pela-rls.sh
#   bash db/test-seg-lote5-dono-pela-rls.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--falsificar" ]; then
  # sabotagem:assert-que-tem-de-ficar-vermelho
  # `fc_update_aberta` fica vermelha em F4, e NÃO em F2: o employee sem leitura (E2) é barrado também
  # pela policy de SELECT, então abrir só a de UPDATE não o alcança. Quem a policy de UPDATE barra
  # SOZINHA é quem lê sem poder escrever (gestor, dona da carteira). F2 só cai abrindo as duas.
  SABOTAGENS="kb_update_aberta:K2 kb_sem_ramo_do_autor:K1 kb_sem_ramo_do_master:K3 kb_sem_rls:K2 sonda_muda_valor:K7 fc_update_aberta:F4 fc_tudo_aberto:F2 fc_sem_ramo_do_dono:F1 fc_update_igual_ao_select:F5 trigger_em_todo_update:F6 sonda_sem_filtro:K6c"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-lote5.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK seg-lote5" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  grep -E "^PASS=[0-9]+ FAIL=0$" "$LOGDIR/controle.log" || { echo "❌ controle sem recibo PASS/FAIL"; exit 1; }
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -qF -- "FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [$a]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [$a] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5977}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-lote5.XXXXXX")"
DATA="$WORK/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── As policies de PROD (2026-11-17) e os pontos que a falsificação troca ──────────────────────
KB_UPDATE_USING="(( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR (created_by = auth.uid()))"
FC_ESCREVER="(( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever) OR (farmer_id = ( SELECT auth.uid() AS uid)))"
FC_LER="(( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR (( SELECT private.carteira_ve_tudo() AS carteira_ve_tudo) OR (customer_user_id IN ( SELECT private.carteira_clientes_visiveis() AS carteira_clientes_visiveis))))"
FC_UPDATE="$FC_ESCREVER"
KB_RLS="ENABLE"
TRIGGER_SINAIS="AFTER INSERT OR UPDATE OF sinais_ligacao"
SONDA_SET_EXTRA=""        # o que a sonda grava ALÉM da PK (nada)
SONDA_FILTRA="sim"        # a sonda filtra pela PK

case "${SABOTAGEM:-}" in
  '') ;;
  kb_update_aberta)          KB_UPDATE_USING="(( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role))" ;;
  kb_sem_ramo_do_autor)      KB_UPDATE_USING="( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role)" ;;
  kb_sem_ramo_do_master)     KB_UPDATE_USING="(created_by = auth.uid())" ;;
  kb_sem_rls)                KB_RLS="DISABLE" ;;
  sonda_muda_valor)          SONDA_SET_EXTRA=", status = 'error'" ;;
  fc_update_aberta)          FC_UPDATE="true" ;;
  fc_tudo_aberto)            FC_UPDATE="true"; FC_LER="true" ;;
  fc_sem_ramo_do_dono)       FC_UPDATE="( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)" ;;
  fc_update_igual_ao_select) FC_UPDATE="$FC_LER" ;;
  trigger_em_todo_update)    TRIGGER_SINAIS="AFTER INSERT OR UPDATE" ;;
  sonda_sem_filtro)          SONDA_FILTRA="nao" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# Como o PostgREST atual: papel + JSON de claims. `auth.uid()` do stub lê as claims.
como()      { printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}'; %s" "$1" "$2"; }
como_anon() { printf "SET ROLE anon; SET request.jwt.claims = '{\"role\":\"anon\"}'; %s" "$1"; }
como_sr()   { printf "SET ROLE service_role; SET request.jwt.claims = '{\"role\":\"service_role\"}'; %s" "$1"; }

# A SONDA, como o gate a manda: regrava a PK com o MESMO valor, filtrada por essa PK, e devolve o id.
sql_sonda() { # $1=tabela $2=id
  if [ "$SONDA_FILTRA" = "sim" ]; then
    printf "UPDATE public.%s SET id = '%s'%s WHERE id = '%s' RETURNING id;" "$1" "$2" "$SONDA_SET_EXTRA" "$2"
  else
    # sabotagem FIEL: o mesmo SET e o mesmo RETURNING, só sem o WHERE. O UPDATE alcança toda linha
    # que a RLS deixa o chamador alterar e regrava a PK DELA com o id perguntado.
    printf "UPDATE public.%s SET id = '%s'%s RETURNING id;" "$1" "$2" "$SONDA_SET_EXTRA"
  fi
}
# A resposta INTEIRA numa linha (o gate exige exatamente uma linha devolvida; `head -1` esconderia 2).
sonda()      { Pq -c "$(como "$1" "$(sql_sonda "$2" "$3")")" 2>&1 | paste -sd' ' -; }
sonda_anon() { Pq -c "$(como_anon "$(sql_sonda "$1" "$2")")" 2>&1 | paste -sd' ' -; }
# SQLSTATE de um comando que tem de FALHAR ("verde" se passou).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}

E1=00000000-0000-0000-0000-0000000000e1   # employee, AUTOR do documento / vendedor DONO da ligação
E2=00000000-0000-0000-0000-0000000000e2   # employee, não é dono de nada
MA=00000000-0000-0000-0000-0000000000aa   # master
GE=00000000-0000-0000-0000-0000000000a6   # employee + commercial_role gerencial (lê a carteira toda)
DC=00000000-0000-0000-0000-0000000000dc   # employee, DONA DA CARTEIRA do cliente CL
CU=00000000-0000-0000-0000-0000000000c0   # customer
CL=00000000-0000-0000-0000-0000000000c1   # o cliente da ligação
DOC=11111111-1111-4111-8111-111111111111
DOC_E2=33333333-3333-4333-8333-333333333333   # o ÚNICO documento do E2
LIG=22222222-2222-4222-8222-222222222222
NAOEXISTE=99999999-9999-4999-8999-999999999999

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<SQL
ALTER ROLE service_role BYPASSRLS;   -- como no Supabase
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE TABLE public.commercial_roles (user_id uuid PRIMARY KEY, commercial_role text NOT NULL);
CREATE TABLE public.carteira_assignments (customer_user_id uuid PRIMARY KEY, owner_user_id uuid);

-- Corpo de PROD (pg_get_functiondef, 2026-11-17).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$function\$;

CREATE SCHEMA private;
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
\$function\$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
\$function\$;
CREATE OR REPLACE FUNCTION private.carteira_ve_tudo() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$
  SELECT ( SELECT auth.uid() ) IS NOT NULL
     AND COALESCE(public.has_role(( SELECT auth.uid() ), 'master'::app_role), false);
\$function\$;
-- DUBLÊ (não é o corpo de PROD): quem é dona do cliente na carteira o vê.
CREATE OR REPLACE FUNCTION private.carteira_clientes_visiveis() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$ SELECT customer_user_id FROM public.carteira_assignments WHERE owner_user_id = auth.uid() \$function\$;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

-- ── kb_documents / kb_chunks (colunas que importam) ────────────────────────────────────────────
CREATE TABLE public.kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  status_error text,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  UNIQUE (document_id, chunk_index)
);
CREATE FUNCTION public.kb_documents_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  \$\$ BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END \$\$;
CREATE TRIGGER trg_kb_documents_updated_at BEFORE UPDATE ON public.kb_documents
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();
ALTER TABLE public.kb_documents $KB_RLS ROW LEVEL SECURITY;
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY kb_documents_select_staff ON public.kb_documents FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role)));
CREATE POLICY kb_documents_insert_staff ON public.kb_documents FOR INSERT
  WITH CHECK ((( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role)));
CREATE POLICY kb_documents_update_master ON public.kb_documents FOR UPDATE
  USING ($KB_UPDATE_USING);
CREATE POLICY kb_documents_delete_master ON public.kb_documents FOR DELETE
  USING (( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role));
CREATE POLICY kb_chunks_select_staff ON public.kb_chunks FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role)));

-- ── farmer_calls (colunas que importam) ────────────────────────────────────────────────────────
CREATE TABLE public.farmer_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid,
  entities_extracted jsonb,
  sinais_ligacao jsonb
);
CREATE TABLE public.farmer_agenda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_id uuid REFERENCES public.farmer_calls(id));
CREATE TABLE public.disparos_de_trigger (nome text NOT NULL, call_id uuid NOT NULL);
CREATE FUNCTION public.registra_disparo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
  \$\$ BEGIN INSERT INTO public.disparos_de_trigger VALUES (TG_NAME, NEW.id); RETURN NEW; END \$\$;
-- Os dois triggers de PROD são por COLUNA (pg_get_triggerdef, 2026-11-17).
CREATE TRIGGER trg_farmer_calls_enqueue_recalc AFTER INSERT OR UPDATE OF entities_extracted ON public.farmer_calls
  FOR EACH ROW EXECUTE FUNCTION public.registra_disparo();
CREATE TRIGGER trg_farmer_calls_enqueue_recalc_sinais $TRIGGER_SINAIS ON public.farmer_calls
  FOR EACH ROW EXECUTE FUNCTION public.registra_disparo();
ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcall_insert_own_or_gestor ON public.farmer_calls FOR INSERT TO authenticated WITH CHECK ($FC_ESCREVER);
CREATE POLICY fcall_delete_own_or_gestor ON public.farmer_calls FOR DELETE TO authenticated USING ($FC_ESCREVER);
CREATE POLICY fcall_select_carteira ON public.farmer_calls FOR SELECT TO authenticated USING ($FC_LER);
CREATE POLICY fcall_update_own_or_gestor ON public.farmer_calls FOR UPDATE TO authenticated USING ($FC_UPDATE) WITH CHECK ($FC_UPDATE);

-- ── X1: USING passa, WITH CHECK reprova ────────────────────────────────────────────────────────
CREATE TABLE public.so_using (id uuid PRIMARY KEY, dono uuid NOT NULL);
ALTER TABLE public.so_using ENABLE ROW LEVEL SECURITY;
CREATE POLICY so_using_select ON public.so_using FOR SELECT USING (true);
CREATE POLICY so_using_update ON public.so_using FOR UPDATE USING (true) WITH CHECK (dono = auth.uid());

-- ── X2: regra por VALOR de coluna (o limite declarado da sonda) ────────────────────────────────
CREATE TABLE public.por_valor (id uuid PRIMARY KEY, dono uuid NOT NULL, marca text NOT NULL);
ALTER TABLE public.por_valor ENABLE ROW LEVEL SECURITY;
CREATE POLICY por_valor_select ON public.por_valor FOR SELECT USING (true);
CREATE POLICY por_valor_update ON public.por_valor FOR UPDATE
  USING (dono = auth.uid()) WITH CHECK (dono = auth.uid() AND marca <> 'fechado');

-- Como em PROD: anon e authenticated têm o privilégio de TABELA; a barreira é a RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.user_roles VALUES
  ('$E1','employee'), ('$E2','employee'), ('$MA','master'), ('$GE','employee'), ('$DC','employee'), ('$CU','customer');
INSERT INTO public.commercial_roles VALUES ('$GE','gerencial');
INSERT INTO public.carteira_assignments VALUES ('$CL','$DC');
INSERT INTO public.kb_documents (id, title, status, created_by, updated_at)
  VALUES ('$DOC', 'Boletim do E1', 'ready', '$E1', '2026-01-01T00:00:00Z'),
         (gen_random_uuid(), 'Outro boletim do E1', 'ready', '$E1', '2026-01-01T00:00:00Z'),
         ('$DOC_E2', 'Boletim do E2', 'ready', '$E2', '2026-01-01T00:00:00Z');
INSERT INTO public.kb_chunks (document_id, chunk_index) VALUES ('$DOC', 0), ('$DOC', 1);
INSERT INTO public.farmer_calls (id, farmer_id, customer_user_id) VALUES
  ('$LIG', '$E1', '$CL'),
  (gen_random_uuid(), '$E1', '$CL'),
  (gen_random_uuid(), '$E2', NULL);
INSERT INTO public.farmer_agenda (call_id) VALUES ('$LIG');
INSERT INTO public.so_using VALUES ('$DOC', '$E1');
INSERT INTO public.por_valor VALUES ('$DOC', '$E1', 'aberto');
DELETE FROM public.disparos_de_trigger;   -- os INSERTs acima dispararam; a contagem começa aqui
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
foto_doc()  { Pq -c "SELECT title || '|' || status || '|' || coalesce(status_error,'-') || '|' || created_by || '|' || to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') FROM public.kb_documents WHERE id = '$DOC'"; }
valores_doc() { Pq -c "SELECT title || '|' || status || '|' || coalesce(status_error,'-') || '|' || created_by FROM public.kb_documents WHERE id = '$DOC'"; }

echo "── kb_documents ──"
# K0 roda numa transação com ROLLBACK: o controle do furo não pode sujar as asserções seguintes.
eq "K0 CONTROLE do furo: service_role altera documento alheio" \
  "$(Pq -c "BEGIN; $(como_sr "UPDATE public.kb_documents SET status = 'error' WHERE id = '$DOC' RETURNING status;") ROLLBACK;" 2>&1 | paste -sd' ' -)" "error"

ANTES="$(foto_doc)"
eq "K2 employee NÃO-autor: zero linha" "$(sonda "$E2" kb_documents "$DOC")" ""
eq "K2b a recusa não mudou NADA na linha (nem updated_at)" "$(foto_doc)" "$ANTES"
eq "K4 customer: zero linha, sem erro" "$(sonda "$CU" kb_documents "$DOC")" ""
eq "K5 anon: zero linha, sem erro" "$(sonda_anon kb_documents "$DOC")" ""
eq "K6 id inexistente: zero linha" "$(sonda "$E1" kb_documents "$NAOEXISTE")" ""
eq "K6b ... e nada mudou" "$(foto_doc)" "$ANTES"
eq "K6c quem tem UM documento só e pergunta por id inexistente: zero linha" "$(sonda "$E2" kb_documents "$NAOEXISTE")" ""
eq "K6d ... e o documento dele continua com o id dele" \
  "$(Pq -c "SELECT count(*) FROM public.kb_documents WHERE id = '$DOC_E2' AND created_by = '$E2'")" "1"

VALORES="$(valores_doc)"
eq "K1 AUTOR: a sonda devolve a linha" "$(sonda "$E1" kb_documents "$DOC")" "$DOC"
eq "K7 a sonda do autor não muda valor (title/status/status_error/created_by)" "$(valores_doc)" "$VALORES"
eq "K7b só o updated_at anda (trigger BEFORE UPDATE)" \
  "$(Pq -c "SELECT updated_at > '2026-01-01T00:00:00Z' FROM public.kb_documents WHERE id = '$DOC'")" "t"
eq "K3 MASTER: a sonda devolve a linha" "$(sonda "$MA" kb_documents "$DOC")" "$DOC"
eq "K8 os chunks (FK) sobrevivem à regravação da PK" \
  "$(Pq -c "SELECT count(*) FROM public.kb_chunks WHERE document_id = '$DOC'")" "2"
eq "K9 nenhum outro documento foi tocado" \
  "$(Pq -c "SELECT count(*) FROM public.kb_documents WHERE id <> '$DOC' AND updated_at = '2026-01-01T00:00:00Z'")" "2"

echo "── farmer_calls ──"
eq "F2 outro employee: zero linha" "$(sonda "$E2" farmer_calls "$LIG")" ""
eq "F4a gestor comercial VÊ a ligação" \
  "$(Pq -c "$(como "$GE" "SELECT count(*) FROM public.farmer_calls WHERE id = '$LIG';")")" "1"
eq "F4 ... mas a sonda do gestor devolve zero linha" "$(sonda "$GE" farmer_calls "$LIG")" ""
eq "F5a dona da carteira VÊ a ligação de cobertura" \
  "$(Pq -c "$(como "$DC" "SELECT count(*) FROM public.farmer_calls WHERE id = '$LIG';")")" "1"
eq "F5 ... mas a sonda da dona da carteira devolve zero linha" "$(sonda "$DC" farmer_calls "$LIG")" ""
eq "F1 DONO da ligação (farmer_id): a sonda devolve a linha" "$(sonda "$E1" farmer_calls "$LIG")" "$LIG"
eq "F3 MASTER: a sonda devolve a linha" "$(sonda "$MA" farmer_calls "$LIG")" "$LIG"
eq "F6 a sonda não disparou trigger de recálculo" \
  "$(Pq -c "SELECT count(*) FROM public.disparos_de_trigger")" "0"
eq "F6b CONTROLE: gravar sinais_ligacao DISPARA (o contador enxerga)" \
  "$(Pq -c "UPDATE public.farmer_calls SET sinais_ligacao = '{\"status\":\"extraido\"}' WHERE id = '$LIG'; SELECT count(*) FROM public.disparos_de_trigger;" | tail -1)" "1"
eq "F7 a agenda (FK) sobrevive à regravação da PK" \
  "$(Pq -c "SELECT count(*) FROM public.farmer_agenda WHERE call_id = '$LIG'")" "1"

echo "── WITH CHECK ──"
eq "X1a dono passa no WITH CHECK" \
  "$(Pq -c "$(como "$E1" "UPDATE public.so_using SET id = '$DOC' WHERE id = '$DOC' RETURNING id;")" 2>&1 | paste -sd' ' -)" "$DOC"
eq "X1 USING passa e WITH CHECK reprova → 42501 (o PostgREST responde 403)" \
  "$(estado "$(como "$E2" "UPDATE public.so_using SET id = '$DOC' WHERE id = '$DOC' RETURNING id;")")" "42501"

eq "X2a LIMITE: com regra por valor, a sonda (no-op) do dono PASSA" \
  "$(Pq -c "$(como "$E1" "UPDATE public.por_valor SET id = '$DOC' WHERE id = '$DOC' RETURNING id;")" 2>&1 | paste -sd' ' -)" "$DOC"
eq "X2 LIMITE: ... e a escrita real que viria depois é NEGADA (42501) — a sonda não vê regra por valor" \
  "$(estado "$(como "$E1" "UPDATE public.por_valor SET marca = 'fechado' WHERE id = '$DOC' RETURNING id;")")" "42501"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK seg-lote5"
