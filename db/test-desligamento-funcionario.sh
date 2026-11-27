#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Prova PG17 da migration 20261127120000_desligamento_funcionario.sql
#
#   bash db/test-desligamento-funcionario.sh               → suíte (locale C)
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-desligamento-funcionario.sh
#   bash db/test-desligamento-funcionario.sh --falsificar  → controle verde + cada sabotagem,
#                                                            nos DOIS locales (C e pt_BR.UTF-8)
#
# Fixture = colunas/constraints da PROD no pré-voo (psql-ro 2026-11-27).
#
#   A0  a migration REAL aplica (postcondição de ACL/RLS passa) em transação única
#   G1  anon e PUBLIC não executam desligar_funcionario; authenticated não executa registrar_ban
#   G2  employee (não master) chamando → 42501, e nada muda
#   G3  master desligando a si mesmo → 42501
#   G4  há carteira e não veio novo dono → 22023
#   G5  novo dono que não é equipe (customer) → 22023
#   G6  alvo que não é equipe e nunca foi desligado → 22023
#   L1  rebuild de carteira em voo → 55P03, e nada muda; L0 sem a linha do rebuild → 55000
#   L2  (2 conexões) a RPC SEGURA a linha do rebuild até o COMMIT: o claim concorrente espera
#   L3  (2 conexões) masters recíprocos: o 2º espera o 1º e cai no gate (42501)
#   P1  desligar F→N: papel, flag, commercial_roles, mapa Omie, carteira, hunter, cobertura,
#       cobrança/tarefas ABERTAS, SIP — e o que é histórico/de terceiros fica intacto
#   P2  idempotente: 2ª chamada → ja_desligado, mesmo id, sem nova linha de auditoria
#   P3  resíduo (reaprovado depois): a re-chamada revoga de novo e audita
#   R1  RLS da auditoria: master lê, employee não lê, anon sem privilégio
#   R2  ninguém da aplicação escreve na auditoria (nem service_role lê); INSERT real → 42501
#   B1  registrar_ban (service_role) marca aplicado; B2 falha atrasada não rebaixa o sucesso
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_REAL="$REPO_ROOT/supabase/migrations/20261127120000_desligamento_funcionario.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="gate_aberto:G2 self_liberado:G3 anon_via_public:A0 elegivel_sem_equipe:G6 sem_remap:P1m cobranca_fechada:P1c status_rebuild_ignorado:L1 sem_for_update:L2 lock_por_usuario:L3 sem_idempotencia:P2 aprovacao_residual:P3 rls_aberta:R1 service_role_le:R2 callback_rebaixa:B2"
  LOGDIR="$(mktemp -d "/tmp/falsifica-desligamento.XXXXXX")"
  falhas=0; n_sab=0
  for loc in C pt_BR.UTF-8; do
    echo "== CONTROLE ($loc) =="
    if ! LOCALE_TESTE="$loc" SABOTAGEM="" bash "$0" > "$LOGDIR/controle-$loc.log" 2>&1; then
      echo "CONTROLE VERMELHO em $loc — falsificacao abortada (log: $LOGDIR/controle-$loc.log)"; exit 1
    fi
    grep -q '^TESTE_DESLIGAMENTO_OK$' "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) sem marcador de fim"; exit 1; }
    grep -q "^LOCALE_ATIVO=$loc\$" "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) nao rodou no locale pedido"; exit 1; }
    echo "controle verde em $loc ($(grep -c '^  OK ' "$LOGDIR/controle-$loc.log") OK)"
    for par in $SABOTAGENS; do
      s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
      log="$LOGDIR/$s-$loc.log"
      if LOCALE_TESTE="$loc" SABOTAGEM="$s" bash "$0" > "$log" 2>&1; then
        echo "XX $s ($loc): suite ficou VERDE"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "SABOTAGEM ATIVA: $s" "$log"; then
        echo "XX $s ($loc): sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "^  FAIL $a " "$log"; then
        echo "XX $s ($loc): vermelho, mas NAO no assert $a (log: $log)"; falhas=$((falhas+1)); continue
      fi
      echo "ok $s ($loc) -> vermelho em $a"
    done
  done
  echo "FALSIFICACAO: $((n_sab - falhas))/$n_sab sabotagens acusadas pelo assert certo"
  [ "$falhas" -eq 0 ] || exit 1
  echo "FALSIFICACAO_DESLIGAMENTO_OK"
  exit 0
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5547}"
SLUG="desligamento-$$"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# ── Cópia da migration (a sabotagem só mexe na cópia) ──
MIG="$TMPD/mig.sql"
cp "$MIG_REAL" "$MIG"
sab() { sed -i.bak "$1" "$MIG"; rm -f "$MIG.bak"; }
case "${SABOTAGEM:-}" in
  "") ;;
  gate_aberto)      sab "s/  IF v_ator IS NULL OR NOT COALESCE(public.has_role(v_ator, 'master'::public.app_role), false) THEN/  IF false THEN/" ;;
  self_liberado)    sab 's/  IF p_user_id = v_ator THEN/  IF false THEN/' ;;
  anon_via_public)  sab 's/^REVOKE ALL ON FUNCTION public.desligar_funcionario(uuid, uuid, text) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.desligar_funcionario(uuid, uuid, text) FROM anon;/' ;;
  sem_remap)        sab 's/    UPDATE public.omie_vendedor_map SET user_id = p_novo_dono WHERE user_id = p_user_id;/    NULL;/' ;;
  cobranca_fechada) sab 's/     WHERE dona_user_id = p_user_id AND fechado_em IS NULL;/     WHERE dona_user_id = p_user_id;/' ;;
  elegivel_sem_equipe) sab 's/AND NOT v_flag AND v_anterior IS NULL THEN/AND false THEN/' ;;
  status_rebuild_ignorado) sab "s/  IF v_rb_status = 'syncing' AND/  IF false AND/" ;;
  sem_for_update)   sab 's/^   FOR UPDATE;$/   ;/' ;;
  lock_por_usuario) sab "s/hashtextextended('desligar_funcionario', 0)/hashtextextended('desligar_funcionario' || p_user_id::text, 0)/" ;;
  sem_idempotencia) sab 's/  IF cardinality(v_papeis) = 0 AND v_cr IS NULL AND NOT v_flag AND NOT v_aprovado/  IF false AND cardinality(v_papeis) = 0/' ;;
  aprovacao_residual) sab 's/ AND NOT v_aprovado AND NOT v_tem_dono/ AND NOT v_tem_dono/' ;;
  service_role_le)  sab 's/^GRANT SELECT ON public.funcionario_desligamentos TO authenticated;/GRANT SELECT ON public.funcionario_desligamentos TO authenticated, service_role;/' ;;
  callback_rebaixa) sab "s/     AND (p_ok OR d.ban_status <> 'aplicado');/     ;/" ;;
  rls_aberta)       sab "s/  USING (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));/  USING (true);/" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "sabotagem $SABOTAGEM nao alterou a copia"; exit 2; fi
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -At "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "LOCALE_ATIVO=$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database()")"

P -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null

M=00000000-0000-0000-0000-0000000000a1   # master (ator)
M2=00000000-0000-0000-0000-0000000000a2  # 2º master (L3)
F=00000000-0000-0000-0000-0000000000f1   # farmer a desligar
N=00000000-0000-0000-0000-0000000000b1   # novo dono (employee)
E=00000000-0000-0000-0000-0000000000e1   # outro employee (terceiro)
C=00000000-0000-0000-0000-0000000000c1   # customer

# ── ZONA 1: fixture = schema da PROD (só as colunas que a migration toca) ──
P <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  role public.app_role NOT NULL, UNIQUE (user_id, role));
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  name text, is_employee boolean DEFAULT false, is_approved boolean DEFAULT false);
CREATE TABLE public.commercial_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.omie_vendedor_map (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_account text NOT NULL,
  omie_codigo_vendedor bigint NOT NULL, user_id uuid NOT NULL, UNIQUE (omie_account, omie_codigo_vendedor));
CREATE TABLE public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL, source text NOT NULL,
  eligible boolean NOT NULL DEFAULT true, updated_at timestamptz);
CREATE TABLE public.company_config (key text PRIMARY KEY, value text);
CREATE TABLE public.carteira_coverage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), covering_user_id uuid NOT NULL,
  covered_user_id uuid NOT NULL, valid_from timestamptz, valid_until timestamptz, active boolean NOT NULL DEFAULT true,
  CHECK (covering_user_id <> covered_user_id));
CREATE TABLE public.cobranca_caso (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dona_user_id uuid,
  atualizado_em timestamptz, atualizado_por uuid, fechado_em timestamptz);
CREATE TABLE public.tarefas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assigned_to uuid,
  status text NOT NULL CHECK (status IN ('aberta','concluida','cancelada')), updated_at timestamptz);
CREATE TABLE public.vendor_sip_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  sip_user text, sip_pass text);
CREATE TABLE public.sync_state (entity_type text, account text, status text, last_sync_at timestamptz,
  PRIMARY KEY (entity_type, account));
SQL

# ── ZONA 2: aplica a migration REAL (cópia, talvez sabotada) em transação única, como o db:aplicar ──
if P -1 -f "$MIG" > "$TMPD/apply.log" 2>&1; then ok "A0 migration aplica e a postcondicao passa"
else bad "A0 migration aplica — $(grep -m1 'ERROR' "$TMPD/apply.log" || echo sem-erro)"; echo "TESTE ABORTADO"; exit 1; fi

# ── ZONA 3: seed ──
P <<SQL
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$M','master'), ('$M2','master'), ('$F','employee'), ('$N','employee'), ('$E','employee'), ('$C','customer');
INSERT INTO public.profiles (user_id, name, is_employee, is_approved) VALUES
  ('$M','Master',false,true), ('$F','Farmer',true,true), ('$N','Novo',true,true),
  ('$E','Outro',true,true), ('$C','Cliente',false,true);
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$F','farmer'), ('$M','master');
INSERT INTO public.omie_vendedor_map (omie_account, omie_codigo_vendedor, user_id) VALUES
  ('oben', 101, '$F'), ('colacor', 102, '$F'), ('oben', 201, '$E');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source) VALUES
  (gen_random_uuid(),'$F','omie'), (gen_random_uuid(),'$F','omie'), (gen_random_uuid(),'$F','hunter_orphan'),
  (gen_random_uuid(),'$E','omie');
-- hunter entre aspas (formato json-string que o carteira-rebuild também aceita)
INSERT INTO public.company_config VALUES ('carteira_hunter_user_id', '"$F"'), ('outra_chave', 'x');
INSERT INTO public.carteira_coverage (covering_user_id, covered_user_id, active) VALUES
  ('$F','$E',true), ('$E','$N',true);
INSERT INTO public.cobranca_caso (dona_user_id, fechado_em) VALUES ('$F', NULL), ('$F', now() - interval '1 day');
INSERT INTO public.tarefas (assigned_to, status) VALUES ('$F','aberta'), ('$F','concluida');
INSERT INTO public.vendor_sip_credentials (user_id, sip_user) VALUES ('$F','ramal-f'), ('$E','ramal-e');
INSERT INTO public.sync_state VALUES ('carteira_rebuild','global','success', now() - interval '1 hour');
SQL

# estado de F (impressão digital para provar "nada mudou" nos negativos)
digital() { Pq -c "SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
  SELECT 'r'||user_id||role FROM public.user_roles UNION ALL
  SELECT 'p'||user_id||is_employee||is_approved FROM public.profiles UNION ALL
  SELECT 'm'||omie_codigo_vendedor||user_id FROM public.omie_vendedor_map UNION ALL
  SELECT 'c'||customer_user_id||owner_user_id FROM public.carteira_assignments UNION ALL
  SELECT 'k'||key||value FROM public.company_config UNION ALL
  SELECT 'v'||id||active FROM public.carteira_coverage UNION ALL
  SELECT 's'||user_id FROM public.vendor_sip_credentials UNION ALL
  SELECT 'q'||user_id||commercial_role FROM public.commercial_roles UNION ALL
  SELECT 'b'||id||coalesce(dona_user_id::text,'-') FROM public.cobranca_caso UNION ALL
  SELECT 't'||id||coalesce(assigned_to::text,'-')||status FROM public.tarefas UNION ALL
  SELECT 'a'||id FROM public.funcionario_desligamentos) x(t);"; }
D0="$(digital)"

# neg <id> <sqlstate> <uid> <chamada> — passa só se a SQLSTATE esperada vier; outro erro aborta o psql.
neg() {
  local out
  out="$(P 2>&1 <<SQL
SET request.jwt.claim.sub = '$3'; SET ROLE authenticated;
DO \$\$ BEGIN PERFORM $4; RAISE NOTICE 'X_SEM_ERRO'; EXCEPTION WHEN SQLSTATE '$2' THEN RAISE NOTICE 'X_PEGO_$1'; END \$\$;
SQL
)" || true
  if grep -q "X_PEGO_$1" <<<"$out"; then ok "$1 rejeitado com $2"; else bad "$1 — esperado $2, veio: $(tr '\n' ' ' <<<"$out" | cut -c1-200)"; fi
}

echo "── gates ──"
eq "G1 anon executa desligar" "$(Pq -c "SELECT has_function_privilege('anon','public.desligar_funcionario(uuid,uuid,text)','EXECUTE')")" "f"
eq "G1 PUBLIC executa desligar" "$(Pq -c "SELECT count(*) FROM pg_proc, aclexplode(proacl) a WHERE oid='public.desligar_funcionario(uuid,uuid,text)'::regprocedure AND a.grantee=0")" "0"
eq "G1 authenticated executa registrar_ban" "$(Pq -c "SELECT has_function_privilege('authenticated','public.registrar_ban_desligamento(uuid,boolean,text)','EXECUTE')")" "f"
neg G2 42501 "$E" "public.desligar_funcionario('$F','$N','saiu da empresa')"
neg G3 42501 "$M" "public.desligar_funcionario('$M','$N','saiu da empresa')"
neg G4 22023 "$M" "public.desligar_funcionario('$F',NULL,'saiu da empresa')"
neg G5 22023 "$M" "public.desligar_funcionario('$F','$C','saiu da empresa')"
neg G6 22023 "$M" "public.desligar_funcionario('$C','$N','saiu da empresa')"
P -c "UPDATE public.sync_state SET status='syncing', last_sync_at=now()"
neg L1 55P03 "$M" "public.desligar_funcionario('$F','$N','saiu da empresa')"
P -c "UPDATE public.sync_state SET status='success', last_sync_at=now() - interval '1 hour'"
P -c "DELETE FROM public.sync_state"
neg L0 55000 "$M" "public.desligar_funcionario('$F','$N','saiu da empresa')"
P -c "INSERT INTO public.sync_state VALUES ('carteira_rebuild','global','success', now() - interval '1 hour')"
eq "G2 negativos não mudaram nada" "$(digital)" "$D0"

echo "── desligamento ──"
R1="$(Pq -c "SET request.jwt.claim.sub = '$M'; SET ROLE authenticated; SELECT public.desligar_funcionario('$F','$N','  saiu da empresa  ')" | tail -1)"
eq "P1 status" "$(jq -r .status <<<"$R1")" "desligado"
ID1="$(jq -r .desligamento_id <<<"$R1")"
eq "P1 papéis de F" "$(Pq -c "SELECT count(*) FROM public.user_roles WHERE user_id='$F'")" "0"
eq "P1 flag/aprovação de F" "$(Pq -c "SELECT is_employee||'/'||is_approved FROM public.profiles WHERE user_id='$F'")" "false/false"
eq "P1 commercial_roles de F" "$(Pq -c "SELECT count(*) FROM public.commercial_roles WHERE user_id='$F'")" "0"
eq "P1m mapa Omie de F foi para N" "$(Pq -c "SELECT string_agg(omie_codigo_vendedor||':'||(user_id='$N'), ',' ORDER BY omie_codigo_vendedor) FROM public.omie_vendedor_map WHERE omie_codigo_vendedor IN (101,102)")" "101:true,102:true"
eq "P1 carteira de F foi para N" "$(Pq -c "SELECT count(*) FILTER (WHERE owner_user_id='$N')||'/'||count(*) FILTER (WHERE owner_user_id='$F') FROM public.carteira_assignments")" "3/0"
eq "P1 hunter virou N" "$(Pq -c "SELECT value FROM public.company_config WHERE key='carteira_hunter_user_id'")" "$N"
eq "P1 cobertura de F encerrada; a de E→N intacta" "$(Pq -c "SELECT string_agg((covering_user_id='$F')||':'||active, ',' ORDER BY covering_user_id='$F') FROM public.carteira_coverage")" "false:true,true:false"
eq "P1c cobrança: aberta→N, fechada segue EXATAMENTE em F" "$(Pq -c "SELECT string_agg((fechado_em IS NULL)||':'||CASE dona_user_id WHEN '$F' THEN 'F' WHEN '$N' THEN 'N' ELSE '?' END, ',' ORDER BY fechado_em NULLS FIRST) FROM public.cobranca_caso")" "true:N,false:F"
eq "P1 tarefas: aberta→N, concluída segue EXATAMENTE em F" "$(Pq -c "SELECT string_agg(status||':'||CASE assigned_to WHEN '$F' THEN 'F' WHEN '$N' THEN 'N' ELSE '?' END, ',' ORDER BY status) FROM public.tarefas")" "aberta:N,concluida:F"
eq "P1 SIP: F removido, E intacto" "$(Pq -c "SELECT string_agg(sip_user, ',') FROM public.vendor_sip_credentials")" "ramal-e"
eq "P1 terceiros intactos (E: papel, mapa, carteira; N: papel)" "$(Pq -c "SELECT (SELECT count(*) FROM public.user_roles WHERE user_id IN ('$E','$N'))||'/'||(SELECT user_id FROM public.omie_vendedor_map WHERE omie_codigo_vendedor=201)||'/'||(SELECT count(*) FROM public.carteira_assignments WHERE owner_user_id='$E')")" "2/$E/1"
eq "P1 auditoria" "$(Pq -c "SELECT desligado_por||'|'||novo_dono_user_id||'|'||motivo||'|'||array_to_string(papeis_removidos,',')||'|'||commercial_role||'|'||(resumo->>'carteira')||'|'||(resumo->>'vendedor_map')||'|'||(resumo->>'sip')||'|'||ban_status FROM public.funcionario_desligamentos WHERE id='$ID1'")" "$M|$N|saiu da empresa|employee|farmer|3|2|1|pendente"

R2="$(Pq -c "SET request.jwt.claim.sub = '$M'; SET ROLE authenticated; SELECT public.desligar_funcionario('$F','$N','de novo')" | tail -1)"
eq "P2 2ª chamada idempotente" "$(jq -r '.status+"|"+.desligamento_id' <<<"$R2")" "ja_desligado|$ID1"
eq "P2 sem nova auditoria" "$(Pq -c "SELECT count(*) FROM public.funcionario_desligamentos")" "1"
P -c "UPDATE public.profiles SET is_approved = true WHERE user_id = '$F'"
R3="$(Pq -c "SET request.jwt.claim.sub = '$M'; SET ROLE authenticated; SELECT public.desligar_funcionario('$F',NULL,'reaprovado por engano')" | tail -1)"
eq "P3 resíduo de aprovação revogado e auditado" "$(jq -r .status <<<"$R3")/$(Pq -c "SELECT is_approved FROM public.profiles WHERE user_id='$F'")/$(Pq -c "SELECT count(*) FROM public.funcionario_desligamentos")" "desligado/f/2"
ID3="$(jq -r .desligamento_id <<<"$R3")"

echo "── RLS da auditoria ──"
eq "R1 master lê" "$(Pq -c "SET request.jwt.claim.sub = '$M'; SET ROLE authenticated; SELECT count(*) FROM public.funcionario_desligamentos" | tail -1)" "2"
eq "R1 employee não lê" "$(Pq -c "SET request.jwt.claim.sub = '$E'; SET ROLE authenticated; SELECT count(*) FROM public.funcionario_desligamentos" | tail -1)" "0"
eq "R1 anon sem privilégio" "$(Pq -c "SELECT has_table_privilege('anon','public.funcionario_desligamentos','SELECT')")" "f"
OUT="$(P 2>&1 <<SQL
SET request.jwt.claim.sub = '$M'; SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.funcionario_desligamentos (user_id, desligado_por, motivo) VALUES ('$E','$M','forjado');
  RAISE NOTICE 'X_SEM_ERRO';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'X_PEGO_R2'; END \$\$;
SQL
)" || true
if grep -q X_PEGO_R2 <<<"$OUT"; then ok "R2 authenticated não escreve na auditoria"; else bad "R2 — $OUT"; fi
eq "R2 privilégios de escrita/leitura indevidos" "$(Pq -c "SELECT count(*) FROM (VALUES ('authenticated'),('service_role'),('anon')) r(n), (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(x) WHERE has_table_privilege(r.n,'public.funcionario_desligamentos',p.x)")/$(Pq -c "SELECT has_table_privilege('service_role','public.funcionario_desligamentos','SELECT')")" "0/f"

echo "── ban ──"
P -c "SET ROLE service_role; SELECT public.registrar_ban_desligamento('$ID1', true, NULL)" >/dev/null
P -c "SET ROLE service_role; SELECT public.registrar_ban_desligamento('$ID3', true, NULL)" >/dev/null
eq "B1 ban registrado no vigente" "$(Pq -c "SELECT ban_status||'/'||(ban_em IS NOT NULL) FROM public.funcionario_desligamentos WHERE id='$ID3'")" "aplicado/true"
P -c "SET ROLE service_role; SELECT public.registrar_ban_desligamento('$ID3', false, 'timeout atrasado')" >/dev/null
eq "B2 falha atrasada não rebaixa o sucesso" "$(Pq -c "SELECT ban_status FROM public.funcionario_desligamentos WHERE id='$ID3'")" "aplicado"

echo "── concorrência (2 conexões) ──"
# L2: a RPC segura a linha do rebuild até o COMMIT ⇒ um claim concorrente (mesmo SQL do claim_carteira_rebuild)
# não passa enquanto ela não comitar (lock_timeout curto ⇒ 55P03 lock_not_available).
( P <<SQL >/dev/null 2>&1
BEGIN;
SET LOCAL request.jwt.claim.sub = '$M'; SET LOCAL ROLE authenticated;
SELECT public.desligar_funcionario('$E','$N','saiu da empresa');
SELECT pg_sleep(2);
COMMIT;
SQL
) & BG=$!
sleep 0.8
OUT="$(P 2>&1 <<'SQL'
SET lock_timeout = '300ms';
DO $$ BEGIN
  INSERT INTO public.sync_state VALUES ('carteira_rebuild','global','syncing', now())
  ON CONFLICT (entity_type, account) DO UPDATE SET status = 'syncing', last_sync_at = now()
   WHERE public.sync_state.status IS DISTINCT FROM 'syncing';
  RAISE NOTICE 'X_SEM_ERRO';
EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'X_PEGO_L2'; END $$;
SQL
)" || true
wait "$BG" || true
if grep -q X_PEGO_L2 <<<"$OUT"; then ok "L2 claim concorrente espera o COMMIT do desligamento"; else bad "L2 — claim passou: $(tr '\n' ' ' <<<"$OUT" | cut -c1-200)"; fi
eq "L2 desligamento do E comitou" "$(Pq -c "SELECT count(*) FROM public.user_roles WHERE user_id='$E'")" "0"
P -c "UPDATE public.sync_state SET status='success', last_sync_at=now() - interval '1 hour'"

# L3: M desliga M2 e segura a transação; M2 tenta desligar M em paralelo ⇒ espera e cai no gate.
( P <<SQL >/dev/null 2>&1
BEGIN;
SET LOCAL request.jwt.claim.sub = '$M'; SET LOCAL ROLE authenticated;
SELECT public.desligar_funcionario('$M2',NULL,'saiu da empresa');
SELECT pg_sleep(2);
COMMIT;
SQL
) & BG=$!
sleep 0.8
neg L3 42501 "$M2" "public.desligar_funcionario('$M','$N','golpe reciproco')"
wait "$BG" || true
eq "L3 M segue master, M2 não" "$(Pq -c "SELECT string_agg(CASE user_id WHEN '$M' THEN 'M' ELSE 'M2' END, ',' ORDER BY user_id) FROM public.user_roles WHERE role='master'")" "M"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "TESTE_DESLIGAMENTO_OK"
