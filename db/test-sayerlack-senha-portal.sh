#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — senha do portal Sayerlack no Vault + rotação (escritor único).       ║
# ║  Migration: 20261120130000_sayerlack_senha_portal_vault.sql                   ║
# ║                                                                               ║
# ║      bash db/test-sayerlack-senha-portal.sh > /tmp/t.log 2>&1; echo $?        ║
# ║      bash db/test-sayerlack-senha-portal.sh --falsificar  (sabota 1 a 1)      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║   G  acesso     — anon/authenticated não executam (42501); service_role sim;  ║
# ║                   helper do Vault fechado até p/ service_role                 ║
# ║   B  bootstrap  — Vault vazio e sem rodada → env_bootstrap                    ║
# ║   S  solicitar  — idempotente; com rodada aberta as edges ficam BLOQUEADAS    ║
# ║   D  dona       — candidata presa à rodada; outra rodada não promove/descarta ║
# ║   P  promover   — ativa=candidata, candidata some, e-mail com a versão certa, ║
# ║                   reenfileira SÓ pedido parado por senha sem clique final     ║
# ║   O  órfã       — em_andamento velha após POST vira ambígua (nunca 2º POST)   ║
# ║   A  adotar     — saída humana fecha a ambígua                                ║
# ║   F  falhar     — rejeição inequívoca descarta só a candidata da rodada       ║
# ║   K  copiar     — botão do master (20261120160000): só master, Vault vazio é  ║
# ║                   erro (nunca env), recusa em rotação aberta, audita quem leu ║
# ║   I  idempotência — re-aplicar as migrations passa                            ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20261120130000_sayerlack_senha_portal_vault.sql"
MIGRATION_COPIAR="$REPO_ROOT/supabase/migrations/20261120160000_sayerlack_senha_portal_copiar.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="sayerlack-senha-portal"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIGRATION" ] || { echo "INFRA: migration ausente em $MIGRATION"; exit 1; }
[ -f "$MIGRATION_COPIAR" ] || { echo "INFRA: migration ausente em $MIGRATION_COPIAR"; exit 1; }

DATA=""
parar_servidor() {
  if [ -n "$DATA" ]; then
    "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
    rm -rf "${DATA%/data}"
    DATA=""
  fi
}
trap parar_servidor EXIT

rodada() {
  local MIG="$1" MIG2="${2:-$MIGRATION_COPIAR}"
  parar_servidor
  DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
  "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove

  P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
  Pq() { P -tA "$@"; }

  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;  -- como na PROD
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
-- master, employee (staff NÃO master) e customer
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-0000000000aa', 'master'),
  ('00000000-0000-0000-0000-0000000000bb', 'employee'),
  ('00000000-0000-0000-0000-0000000000cc', 'customer');

-- Vault simulado com as MESMAS assinaturas da PROD (pg_proc 2026-11-19).
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text, description text);
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, description, secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $f$ INSERT INTO vault.secrets (name, secret, description) VALUES (new_name, new_secret, new_description) RETURNING id $f$;
CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$ UPDATE vault.secrets SET secret = coalesce(new_secret, secret), name = coalesce(new_name, name), description = coalesce(new_description, description) WHERE id = secret_id $f$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY, status_envio_portal text, portal_tentativas integer,
  portal_proximo_retry_em timestamptz, portal_erro text, portal_protocolo text
);
CREATE TABLE public.pedidos_portal_tentativas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pedido_id bigint, iniciado_em timestamptz, evidence jsonb
);
-- 4505: parou SÓ por senha, sem clique final → deve voltar.
-- 4506: última tentativa CLICOU em Efetivar → NUNCA reenfileira (risco de PO duplo).
-- 4507: falhou por senha ANTES, mas a última tentativa é outro erro → não volta.
-- 4508: senha sem clique, mas já tem protocolo → não volta.
INSERT INTO public.pedido_compra_sugerido VALUES
  (4505, 'erro_nao_retentavel', 1, NULL, 'troca de senha', NULL),
  (4506, 'erro_nao_retentavel', 1, NULL, 'troca de senha', NULL),
  (4507, 'erro_nao_retentavel', 1, NULL, 'lote', NULL),
  (4508, 'erro_nao_retentavel', 1, NULL, 'troca de senha', 'PROT-1');
INSERT INTO public.pedidos_portal_tentativas (pedido_id, iniciado_em, evidence) VALUES
  (4505, now() - interval '1 hour', '{"erroTipo":"PASSWORD_CHANGE_REQUIRED","efetivarAttempted":false}'),
  (4505, now() - interval '2 hour', '{"erroTipo":"GRUPO_LEADTIME_MISMATCH","efetivarAttempted":false}'),
  (4506, now() - interval '1 hour', '{"erroTipo":"PASSWORD_CHANGE_REQUIRED","efetivarAttempted":true}'),
  (4507, now() - interval '1 hour', '{"erroTipo":"LOTE_MINIMO_PORTAL","efetivarAttempted":false}'),
  (4507, now() - interval '3 hour', '{"erroTipo":"PASSWORD_CHANGE_REQUIRED","efetivarAttempted":false}'),
  (4508, now() - interval '1 hour', '{"erroTipo":"PASSWORD_CHANGE_REQUIRED","efetivarAttempted":false}');
SQL

  P -q -f "$MIG" >/dev/null 2>"/tmp/${SLUG}-apply.err" || { echo "FAIL aplicar"; cat "/tmp/${SLUG}-apply.err"; return 1; }
  P -q -f "$MIG2" >/dev/null 2>"/tmp/${SLUG}-apply2.err" || { echo "FAIL aplicar"; cat "/tmp/${SLUG}-apply2.err"; return 1; }
  echo "PASS aplicar"

  local FALHAS=0
  ok() {  # ok NOME "SQL que devolve t" — roda como service_role
    local nome="$1" sql="$2" r
    r="$(Pq -c "SET ROLE service_role; $sql" 2>&1 | tail -1)" || true
    if [ "$r" = "t" ]; then echo "PASS $nome"; else echo "FAIL $nome → $r"; Pq -c "SET ROLE service_role; $sql" 2>&1 | grep -m1 ERROR || true; FALHAS=$((FALHAS+1)); fi
  }
  erro() {  # erro NOME SQLSTATE ROLE "SQL" — exige ESSA SQLSTATE, re-lança o resto
    local nome="$1" estado="$2" papel="$3" sql="$4" r
    r="$(Pq -c "SET ROLE $papel; DO \$t\$ BEGIN $sql; RAISE EXCEPTION 'SEM_ERRO'; EXCEPTION WHEN SQLSTATE '$estado' THEN RAISE NOTICE 'CASOU'; END \$t\$;" 2>&1)" || true
    if printf '%s' "$r" | grep -q "CASOU"; then echo "PASS $nome"; else echo "FAIL $nome → $(printf '%s' "$r" | tail -1)"; FALHAS=$((FALHAS+1)); fi
  }

  local MASTER='00000000-0000-0000-0000-0000000000aa' EMP='00000000-0000-0000-0000-0000000000bb' CLI='00000000-0000-0000-0000-0000000000cc'
  okm() {  # okm NOME UID "SQL que devolve t" — roda como authenticated com auth.uid()=UID
    local nome="$1" uid="$2" sql="$3" r
    r="$(Pq -c "SET ROLE authenticated; SET test.uid = '$uid'; $sql" 2>&1 | tail -1)" || true
    if [ "$r" = "t" ]; then echo "PASS $nome"; else echo "FAIL $nome → $r"; FALHAS=$((FALHAS+1)); fi
  }

  # K — copiar senha (botão do master): acesso
  erro K1 42501 anon "PERFORM public.sayerlack_senha_portal_copiar()"
  erro K2 42501 authenticated "PERFORM public.sayerlack_senha_portal_copiar()"   # sem login (uid NULL)
  erro K3 42501 "authenticated; SET test.uid = '$EMP'" "PERFORM public.sayerlack_senha_portal_copiar()"
  erro K3b 42501 "authenticated; SET test.uid = '$CLI'" "PERFORM public.sayerlack_senha_portal_copiar()"
  erro K8 42501 service_role "PERFORM public.sayerlack_senha_portal_copiar()"
  # Vault vazio: erro claro (P0002), NUNCA a senha do env nem NULL copiado
  erro K4 P0002 "authenticated; SET test.uid = '$MASTER'" "PERFORM public.sayerlack_senha_portal_copiar()"

  # G — acesso
  erro G1 42501 anon "PERFORM public.sayerlack_senha_portal_credencial()"
  erro G2 42501 authenticated "PERFORM public.sayerlack_senha_portal_credencial()"
  erro G3 42501 authenticated "PERFORM public.sayerlack_senha_portal_promover(gen_random_uuid())"
  erro G4 42501 service_role "PERFORM public._sayerlack_vault_ler('sayerlack_portal_pass')"
  erro G5 42501 authenticated "PERFORM public.sayerlack_senha_portal_email_pendente()"

  # B — bootstrap
  ok B1 "SELECT origem = 'env_bootstrap' AND senha IS NULL AND bloqueio IS NULL FROM public.sayerlack_senha_portal_credencial()"

  # S — solicitar + bloqueio
  local R1
  R1="$(Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_solicitar('teste')" | tail -1)"
  ok S1 "SELECT public.sayerlack_senha_portal_solicitar('de novo') = '$R1'::uuid"
  ok S2 "SELECT bloqueio = 'rotacao_solicitada' AND senha IS NULL AND origem IS NULL FROM public.sayerlack_senha_portal_credencial()"
  # K5 — rotação aberta: o master também é recusado (a senha pode estar mudando)
  erro K5 55000 "authenticated; SET test.uid = '$MASTER'" "PERFORM public.sayerlack_senha_portal_copiar()"

  # assumir → trocar; candidata
  ok C1 "SELECT modo = 'trocar' AND rotacao_id = '$R1'::uuid AND origem_atual = 'env_bootstrap' FROM public.sayerlack_senha_portal_assumir()"
  ok C2 "SELECT count(*) = 0 FROM public.sayerlack_senha_portal_assumir()"   # viva: ninguém mais assume
  ok C3 "SELECT bloqueio = 'rotacao_em_andamento' FROM public.sayerlack_senha_portal_credencial()"
  erro C4 22023 service_role "PERFORM public.sayerlack_senha_portal_gravar_candidata('$R1', 'curta')"
  Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_gravar_candidata('$R1', 'Candidata1234abcd')" >/dev/null
  erro C5 P0001 service_role "PERFORM public.sayerlack_senha_portal_gravar_candidata('$R1', 'OutraCandidata99')"

  # D — dona
  erro D1 P0001 service_role "PERFORM public.sayerlack_senha_portal_promover(gen_random_uuid())"
  erro D2 P0001 service_role "PERFORM public.sayerlack_senha_portal_falhar(gen_random_uuid(), 'x', true)"
  # D4 confere como DONO (service_role não enxerga o vault):
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT count(*) FROM vault.secrets WHERE name='sayerlack_portal_pass_pendente' AND description='$R1'" | tail -1)" = "1" ] \
    && echo "PASS D4" || { echo "FAIL D4 candidata nao presa a rodada"; FALHAS=$((FALHAS+1)); }

  # D5 — candidata de OUTRA rodada no Vault: promover a rodada aberta tem que recusar (P0002).
  Pq -c "UPDATE vault.secrets SET description = gen_random_uuid()::text WHERE name = 'sayerlack_portal_pass_pendente'" >/dev/null
  erro D5 P0002 service_role "PERFORM public.sayerlack_senha_portal_promover('$R1')"
  Pq -c "UPDATE vault.secrets SET description = '$R1' WHERE name = 'sayerlack_portal_pass_pendente'" >/dev/null

  # P — promover
  ok P1 "SELECT public.sayerlack_senha_portal_promover('$R1') = ARRAY[4505]::bigint[]"
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT string_agg(name||'='||secret||'@'||description, ',' ORDER BY name) FROM vault.secrets" | tail -1)" = "sayerlack_portal_pass=Candidata1234abcd@$R1" ] \
    && echo "PASS P2" || { echo "FAIL P2 vault apos promover: $(Pq -c "SELECT string_agg(name||'@'||description, ',') FROM vault.secrets" | tail -1)"; FALHAS=$((FALHAS+1)); }
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT string_agg(id||':'||status_envio_portal||':'||portal_tentativas, ',' ORDER BY id) FROM public.pedido_compra_sugerido" | tail -1)" = \
    "4505:pendente_envio_portal:0,4506:erro_nao_retentavel:1,4507:erro_nao_retentavel:1,4508:erro_nao_retentavel:1" ] \
    && echo "PASS P3" || { echo "FAIL P3 reenfileiramento: $(Pq -c "SELECT string_agg(id||':'||status_envio_portal, ',' ORDER BY id) FROM public.pedido_compra_sugerido" | tail -1)"; FALHAS=$((FALHAS+1)); }
  ok P4 "SELECT status = 'concluida' AND email_pendente FROM public.sayerlack_senha_rotacao WHERE id = '$R1'"
  # K6 — master copia a ATIVA; a leitura fica auditada (quem + versão, sem senha); só o master vê o log
  ok K6a "SELECT count(*) = 0 FROM public.sayerlack_senha_portal_leituras"
  okm K6 "$MASTER" "SELECT public.sayerlack_senha_portal_copiar() = 'Candidata1234abcd'"
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT count(*)||':'||max(user_id::text)||':'||max(versao) FROM public.sayerlack_senha_portal_leituras" | tail -1)" = "1:$MASTER:$R1" ] \
    && echo "PASS K6b" || { echo "FAIL K6b auditoria: $(Pq -c "SELECT count(*) FROM public.sayerlack_senha_portal_leituras" | tail -1)"; FALHAS=$((FALHAS+1)); }
  okm K7 "$EMP" "SELECT count(*) = 0 FROM public.sayerlack_senha_portal_leituras"
  okm K7b "$MASTER" "SELECT count(*) = 1 FROM public.sayerlack_senha_portal_leituras"
  erro K7c 42501 "authenticated; SET test.uid = '$MASTER'" "INSERT INTO public.sayerlack_senha_portal_leituras (user_id) VALUES (gen_random_uuid())"
  ok P5 "SELECT origem = 'vault' AND senha = 'Candidata1234abcd' AND bloqueio IS NULL FROM public.sayerlack_senha_portal_credencial()"
  ok P6 "SELECT senha = 'Candidata1234abcd' AND rotacao_id = '$R1'::uuid FROM public.sayerlack_senha_portal_email_pendente()"
  Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_email_enviado('$R1')" >/dev/null
  ok P7 "SELECT count(*) = 0 FROM public.sayerlack_senha_portal_email_pendente()"
  erro P8 P0001 service_role "PERFORM public.sayerlack_senha_portal_promover('$R1')"   # já fechada

  # O — órfã depois do POST vira ambígua; reconcilia sem novo POST
  local R2
  R2="$(Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_solicitar('orfa')" | tail -1)"
  Pq -c "SET ROLE service_role; SELECT 1 FROM public.sayerlack_senha_portal_assumir(); SELECT public.sayerlack_senha_portal_gravar_candidata('$R2', 'Candidata2222zzzz'); SELECT public.sayerlack_senha_portal_etapa('$R2', 'post_pode_ter_saido')" >/dev/null
  Pq -c "UPDATE public.sayerlack_senha_rotacao SET atualizado_em = now() - interval '30 minutes' WHERE id = '$R2'" >/dev/null
  ok O1 "SELECT modo = 'reconciliar' AND candidata = 'Candidata2222zzzz' AND senha_atual = 'Candidata1234abcd' AND tentativas_reconciliacao = 1 FROM public.sayerlack_senha_portal_assumir()"
  ok O2 "SELECT status = 'ambigua' FROM public.sayerlack_senha_rotacao WHERE id = '$R2'"
  ok O3 "SELECT bloqueio = 'rotacao_ambigua' FROM public.sayerlack_senha_portal_credencial()"
  # órfã ANTES do POST é re-assumida para trocar (não vira ambígua)
  # A — adotar fecha a ambígua e apaga a candidata
  Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_adotar('SenhaManual777', 'env')" >/dev/null
  ok A1 "SELECT status = 'resolvida_manual' FROM public.sayerlack_senha_rotacao WHERE id = '$R2'"
  ok A2 "SELECT origem = 'vault' AND senha = 'SenhaManual777' FROM public.sayerlack_senha_portal_credencial()"
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT count(*) FROM vault.secrets WHERE name='sayerlack_portal_pass_pendente'" | tail -1)" = "0" ] \
    && echo "PASS A3" || { echo "FAIL A3 candidata sobreviveu a adocao"; FALHAS=$((FALHAS+1)); }
  # A4: rodada concluída com e-mail ainda pendente, mas a ativa já é OUTRA versão (adotada) → nada a enviar.
  Pq -c "UPDATE public.sayerlack_senha_rotacao SET email_pendente = true WHERE id = '$R1'" >/dev/null
  ok A4 "SELECT count(*) = 0 FROM public.sayerlack_senha_portal_email_pendente()"   # senha velha nunca vai por e-mail
  Pq -c "UPDATE public.sayerlack_senha_rotacao SET email_pendente = false WHERE id = '$R1'" >/dev/null

  # Órfã antes do POST: re-assumida como 'trocar'
  local R3
  R3="$(Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_solicitar('pre-post')" | tail -1)"
  Pq -c "SET ROLE service_role; SELECT 1 FROM public.sayerlack_senha_portal_assumir(); SELECT public.sayerlack_senha_portal_gravar_candidata('$R3', 'Candidata3333yyyy')" >/dev/null
  Pq -c "UPDATE public.sayerlack_senha_rotacao SET atualizado_em = now() - interval '30 minutes' WHERE id = '$R3'" >/dev/null
  ok O4 "SELECT modo = 'trocar' AND rotacao_id = '$R3'::uuid FROM public.sayerlack_senha_portal_assumir()"

  # F — falhar com descarte remove SÓ a candidata desta rodada
  Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_gravar_candidata('$R3', 'Candidata4444xxxx')" >/dev/null
  Pq -c "SET ROLE service_role; SELECT public.sayerlack_senha_portal_falhar('$R3', 'portal recusou', true)" >/dev/null
  ok F1 "SELECT status = 'falhou' FROM public.sayerlack_senha_rotacao WHERE id = '$R3'"
  # shellcheck disable=SC2015  # echo nao falha: o ramo || so roda quando o teste [ ] reprova
  [ "$(Pq -c "SELECT string_agg(name, ',' ORDER BY name) FROM vault.secrets" | tail -1)" = "sayerlack_portal_pass" ] \
    && echo "PASS F2" || { echo "FAIL F2 vault apos falhar"; FALHAS=$((FALHAS+1)); }
  ok F3 "SELECT origem = 'vault' AND senha = 'SenhaManual777' FROM public.sayerlack_senha_portal_credencial()"
  # Q — quarentena: com troca recusada há < 6h, solicitar NÃO abre rodada (devolve NULL) e as edges seguem.
  ok Q1 "SELECT public.sayerlack_senha_portal_solicitar('apos-falha') IS NULL"
  ok Q2 "SELECT bloqueio IS NULL FROM public.sayerlack_senha_portal_credencial()"
  Pq -c "UPDATE public.sayerlack_senha_rotacao SET concluido_em = now() - interval '7 hours' WHERE id = '$R3'" >/dev/null
  ok Q3 "SELECT public.sayerlack_senha_portal_solicitar('depois-da-quarentena') IS NOT NULL"

  # I — re-aplicar
  if P -q -f "$MIG" >/dev/null 2>"/tmp/${SLUG}-reapply.err" && P -q -f "$MIG2" >/dev/null 2>>"/tmp/${SLUG}-reapply.err"; then echo "PASS I1"; else echo "FAIL I1"; cat "/tmp/${SLUG}-reapply.err"; FALHAS=$((FALHAS+1)); fi

  [ "$FALHAS" -eq 0 ] || { echo "FALHAS=$FALHAS"; return 1; }
  echo "FIM_OK_SUITE"
}

if [ "${1:-}" != "--falsificar" ]; then
  rodada "$MIGRATION"
  exit $?
fi

# ── Falsificação: CONTROLE verde na MESMA invocação, depois cada sabotagem exige o vermelho do alvo.
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
cp "$MIGRATION" "$SAB_DIR/controle.sql"
if ! rodada "$SAB_DIR/controle.sql" >"$SAB_DIR/controle.log" 2>&1 || ! grep -q FIM_OK_SUITE "$SAB_DIR/controle.log"; then
  echo "CONTROLE VERMELHO — falsificação abortada (sem linha de base)"; tail -5 "$SAB_DIR/controle.log"; exit 1
fi
echo "controle verde"
VIVAS=0
sabota() {  # sabota NOME DE PARA ALVO [copiar] — o 5º arg sabota a migration do botão
  local nome="$1" de="$2" para="$3" alvo="$4" f="$SAB_DIR/$1.sql" src="$MIGRATION"
  [ "${5:-}" = "copiar" ] && src="$MIGRATION_COPIAR"
  python3 - "$src" "$f" "$de" "$para" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src).read()
if s.count(de) < 1:
    sys.exit("sabotagem nao casou: " + de[:60])
s = s.replace(de, para, 1)
open(dst, "w").write(s)
PY
  local ok_rodada=0
  if [ "${5:-}" = "copiar" ]; then rodada "$MIGRATION" "$f" >"$SAB_DIR/$nome.log" 2>&1 || ok_rodada=1
  else rodada "$f" >"$SAB_DIR/$nome.log" 2>&1 || ok_rodada=1; fi
  if [ "$ok_rodada" -eq 0 ]; then
    echo "  SABOTAGEM VIVA: $nome (a suíte ficou verde)"; VIVAS=$((VIVAS+1))
  elif grep -q "FAIL $alvo" "$SAB_DIR/$nome.log"; then
    echo "  morta: $nome → $alvo vermelho"
  else
    echo "  SABOTAGEM VIVA: $nome morreu por outro motivo, não por $alvo"; VIVAS=$((VIVAS+1))
    grep FAIL "$SAB_DIR/$nome.log" | head -3
  fi
}
# Sem o REVOKE em laço, a postcondição A3 aborta o apply (é ela o alvo).
sabota credencial_aberta "    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);" "    NULL;" "aplicar"
sabota promover_sem_dona "  IF v_cand IS NULL OR v_cand_rot IS DISTINCT FROM p_rotacao::text THEN" "  IF v_cand IS NULL THEN" "D5"
sabota reenfileira_apos_clique "       AND u.evidence->>'efetivarAttempted' = 'false'" "" "P3"
sabota reenfileira_ultima_qualquer "    SELECT DISTINCT ON (t.pedido_id) t.pedido_id, t.evidence
      FROM public.pedidos_portal_tentativas t
     ORDER BY t.pedido_id, t.iniciado_em DESC" "    SELECT t.pedido_id, t.evidence
      FROM public.pedidos_portal_tentativas t" "P3"
sabota reenfileira_com_protocolo "       AND p.portal_protocolo IS NULL" "" "P3"
sabota orfa_pos_post_refaz_post "    IF coalesce(r.etapa, '') NOT IN ('', 'assumida', 'candidata_gravada') THEN" "    IF false THEN" "O1"
sabota sem_bloqueio_em_rotacao "  IF FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, ('rotacao_' || v_aberta.status)::text, v_aberta.id;" "  IF false THEN
    RETURN QUERY SELECT NULL::text, NULL::text, ('rotacao_' || v_aberta.status)::text, v_aberta.id;" "S2"
sabota email_senha_de_outra_versao "  IF v_val IS NULL OR v_val_rot IS DISTINCT FROM v_rot::text THEN
    RETURN;  -- ativa" "  IF v_val IS NULL THEN
    RETURN;  -- ativa" "A4"
sabota helper_vault_aberto "REVOKE ALL ON FUNCTION public._sayerlack_vault_ler(text) FROM PUBLIC, anon, authenticated, service_role;" "REVOKE ALL ON FUNCTION public._sayerlack_vault_ler(text) FROM PUBLIC, anon, authenticated;" "aplicar"
sabota sem_quarentena "  IF EXISTS (SELECT 1 FROM public.sayerlack_senha_rotacao
              WHERE status = 'falhou'" "  IF false AND EXISTS (SELECT 1 FROM public.sayerlack_senha_rotacao
              WHERE status = 'falhou'" "Q1"
# — botão do master (20261120160000)
sabota gate_master_aberto "  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN" "  IF v_uid IS NULL OR (false AND NOT public.has_role(v_uid, 'master'::public.app_role)) THEN" "K3" copiar
sabota vault_vazio_copia_nada "  IF v_senha IS NULL THEN
    RAISE EXCEPTION 'SEM_SENHA_NO_VAULT" "  IF false THEN
    RAISE EXCEPTION 'SEM_SENHA_NO_VAULT" "K4" copiar
sabota copia_durante_rotacao "  IF v_status IS NOT NULL THEN" "  IF false THEN" "K5" copiar
sabota sem_auditoria "  INSERT INTO public.sayerlack_senha_portal_leituras (user_id, versao) VALUES (v_uid, v_versao);" "" "K6b" copiar
sabota anon_executa "REVOKE ALL ON FUNCTION public.sayerlack_senha_portal_copiar() FROM PUBLIC, anon, service_role;" "REVOKE ALL ON FUNCTION public.sayerlack_senha_portal_copiar() FROM PUBLIC, service_role;" "aplicar" copiar
sabota log_aberto_a_staff "  USING (public.has_role(auth.uid(), 'master'::public.app_role));" "  USING (true);" "K7" copiar
echo "RESUMO_FALSIFICACAO vivas=$VIVAS"
[ "$VIVAS" -eq 0 ]
