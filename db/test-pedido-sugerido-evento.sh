#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — pedido_sugerido_evento: trilha de remoção de itens e de recusa de    ║
# ║  aprovação. Migration: 20261120120000_pedido_sugerido_evento_auditoria.sql    ║
# ║                                                                               ║
# ║      bash db/test-pedido-sugerido-evento.sh > /tmp/t.log 2>&1; echo $?        ║
# ║      bash db/test-pedido-sugerido-evento.sh --falsificar  (sabota 1 a 1)      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║   P  predecessor — os corpos VIVOS de prod (fixture) passam na PRE            ║
# ║   R  remoção     — snapshot dos itens no evento; esvaziar registra cancelado; ║
# ║                    id de outro pedido / status fora da allowlist = 0 evento    ║
# ║   T  sem trilha não há remoção — gravador falha ⇒ itens INTACTOS              ║
# ║   A  aprovação   — recusa {error} vira evento; aprovação ok não              ║
# ║   W  escrita     — authenticated não grava/apaga na trilha direto (42501)     ║
# ║   I  idempotência— re-aplicar passa; corpo derivado ABORTA na PRE             ║
# ║   F  falsificação— cada sabotagem exige vermelho, com CONTROLE verde antes    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20261120120000_pedido_sugerido_evento_auditoria.sql"
FIXTURE="$REPO_ROOT/db/fixtures/pedido-sugerido-evento-predecessores.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="pedido-sugerido-evento"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIGRATION" ] || { echo "INFRA: migration ausente em $MIGRATION"; exit 1; }
[ -f "$FIXTURE" ] || { echo "INFRA: fixture ausente em $FIXTURE"; exit 1; }

# O servidor da rodada é parado ao começar a PRÓXIMA rodada e no EXIT do script — inclusive
# quando o `set -e` aborta no meio (um trap RETURN não dispara nesse caminho e deixava o PG
# preso na porta).
DATA=""
parar_servidor() {
  if [ -n "$DATA" ]; then
    "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
    rm -rf "${DATA%/data}"
    DATA=""
  fi
}
trap parar_servidor EXIT

# ── Uma rodada completa contra um arquivo de migration (o real ou uma cópia sabotada).
#    Sai 0 só se TODOS os asserts passarem e o marcador de fim for impresso.
rodada() {
  local MIG="$1"
  parar_servidor
  DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"

  "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='${HARNESS_LC:-C}';"

  P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
  Pq() { P -tA "$@"; }

  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- Como na PROD: anon/authenticated usam o schema auth (auth.uid() nas RPCs INVOKER).
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
-- Capacidade de compras: ligada por GUC, para poder negar no teste T.
CREATE OR REPLACE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE
  AS $f$ SELECT coalesce(current_setting('test.cap', true), '1') = '1' $f$;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated, service_role;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY, status text NOT NULL,
  valor_total numeric NOT NULL DEFAULT 0, num_skus integer NOT NULL DEFAULT 0,
  cancelado_por text, cancelado_em timestamptz, justificativa_cancelamento text,
  status_envio_portal text, portal_proximo_retry_em timestamptz, atualizado_em timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id bigint PRIMARY KEY,
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL, sku_descricao text,
  qtde_sugerida numeric NOT NULL, qtde_final numeric, preco_unitario numeric
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido, public.pedido_compra_item TO authenticated;
-- RLS dos ITENS como na PROD (pg_policies 2026-11-19): ler/alterar/apagar exige cap_compras.
-- O PAI fica sem RLS aqui: na prod qualquer employee o lê e atualiza — é a assimetria que
-- deixava um employee sem capacidade cancelar pedido com itens.
ALTER TABLE public.pedido_compra_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY i_sel ON public.pedido_compra_item FOR SELECT USING (private.cap_compras_ler(auth.uid()));
CREATE POLICY i_upd ON public.pedido_compra_item FOR UPDATE USING (private.cap_compras_ler(auth.uid()));
CREATE POLICY i_del ON public.pedido_compra_item FOR DELETE USING (private.cap_compras_ler(auth.uid()));
CREATE POLICY i_ins ON public.pedido_compra_item FOR INSERT WITH CHECK (true);

-- A versão de 3 argumentos (money-path, selo) NÃO é tocada pela migration: aqui é um dublê
-- que recusa quando test.recusa está setado, e aprova (flip de status) caso contrário.
CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text, p_itens_vistos jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  IF nullif(current_setting('test.recusa', true), '') IS NOT NULL THEN
    RETURN jsonb_build_object('error', current_setting('test.recusa'));
  END IF;
  UPDATE pedido_compra_sugerido SET status = 'aprovado_aguardando_disparo' WHERE id = p_pedido_id;
  RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id);
END $f$;
SQL
  P -q -f "$FIXTURE"

  local PASS=0 FAIL=0
  ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
  bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
  eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

  # P — os corpos de prod são os predecessores que a PRE espera.
  eq "P1 md5 remover vivo = predecessor" \
    "$(Pq -c "select md5(prosrc) from pg_proc where oid='public.remover_itens_pedido_sugerido(bigint,bigint[],text)'::regprocedure")" \
    "2c34777763a45e0ce5e87188b460dd4e"
  eq "P2 md5 aprovar(bigint,text) vivo = predecessor" \
    "$(Pq -c "select md5(prosrc) from pg_proc where oid='public.aprovar_pedido_sugerido(bigint,text)'::regprocedure")" \
    "dd87b376da51b2d1603e8ade8c28b3a8"

  # Aplica como o db:aplicar: numa transação do executor.
  if ! P -q -c "BEGIN;" -f "$MIG" -c "COMMIT;" >/tmp/${SLUG}-apply.log 2>&1; then
    bad "aplicar migration -- $(head -c 400 /tmp/${SLUG}-apply.log)"
    echo "RESUMO pass=$PASS fail=$FAIL"; return 1
  fi
  ok "aplicar migration"
  P -q <<'SQL'
CREATE FUNCTION public._t_falha_trilha() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_setting('test.falha_trilha', true) = '1' THEN RAISE EXCEPTION 'trilha indisponivel (teste)'; END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER t_falha_trilha BEFORE INSERT ON public.pedido_sugerido_evento FOR EACH ROW EXECUTE FUNCTION public._t_falha_trilha();
SQL

  P -q <<'SQL'
INSERT INTO pedido_compra_sugerido (id, status) VALUES
  (1, 'pendente_aprovacao'), (2, 'pendente_aprovacao'), (3, 'aprovado_aguardando_disparo'),
  (4, 'pendente_aprovacao'), (5, 'pendente_aprovacao'), (6, 'pendente_aprovacao'), (7, 'pendente_aprovacao');
INSERT INTO pedido_compra_item (id, pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario) VALUES
  (11, 1, '111', 'Verniz A', 2, 2, 10), (12, 1, '112', 'Verniz B', 3, 3, 5), (13, 1, '113', 'Cat C', 1, 1, 7),
  (21, 2, '211', 'Tinta D', 1, NULL, 4),
  (31, 3, '311', 'Tinta E', 1, 1, 9),
  (41, 4, '411', 'Lixa F', 5, 5, 1),
  (51, 5, '511', 'Selador G', 1, 1, 3),
  (71, 7, '711', 'Fundo H', 1, 1, 2);
SQL
  # Chamadas como na tela: role authenticated + uid + capacidade.
  AU() { P -tA -c "SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000aa'; $1"; }
  # Erros esperados casam pela SQLSTATE (VERBOSITY=verbose imprime "ERROR:  42501:"), não pelo
  # texto do servidor — que muda com lc_messages (lição #1483).
  AUV() { P -v VERBOSITY=verbose -tA -c "SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000aa'; $1"; }

  # R — remoção.
  AU "SELECT remover_itens_pedido_sugerido(1, ARRAY[11,12]::bigint[], 'lucas@x')" >/dev/null
  eq "R1 remover 2 de 3: 1 evento itens_removidos" \
    "$(Pq -c "select count(*) from pedido_sugerido_evento where pedido_id=1 and evento='itens_removidos'")" "1"
  eq "R2 snapshot traz os 2 SKUs removidos, na ordem" \
    "$(Pq -c "select string_agg(e->>'sku_codigo_omie', ',') from pedido_sugerido_evento, jsonb_array_elements(detalhe->'itens') e where pedido_id=1")" "111,112"
  eq "R3 evento carimba usuario, auth_uid do servidor e restantes" \
    "$(Pq -c "select usuario||'|'||auth_uid||'|'||(detalhe->>'restantes')||'|'||(detalhe->>'cancelado') from pedido_sugerido_evento where pedido_id=1")" \
    "lucas@x|00000000-0000-0000-0000-0000000000aa|1|false"
  AU "SELECT remover_itens_pedido_sugerido(2, ARRAY[21]::bigint[], 'lucas@x')" >/dev/null
  eq "R4 esvaziar: evento com cancelado=true e status_antes" \
    "$(Pq -c "select (detalhe->>'cancelado')||'|'||(detalhe->>'status_antes') from pedido_sugerido_evento where pedido_id=2")" "true|pendente_aprovacao"
  AU "SELECT remover_itens_pedido_sugerido(4, ARRAY[51]::bigint[], 'lucas@x')" >/dev/null
  eq "R5 id de item de OUTRO pedido: nada removido, 0 evento" \
    "$(Pq -c "select (select count(*) from pedido_sugerido_evento where pedido_id=4)||'|'||(select count(*) from pedido_compra_item where id=51)")" "0|1"
  AU "SELECT remover_itens_pedido_sugerido(3, ARRAY[31]::bigint[], 'lucas@x')" >/dev/null
  eq "R6 status fora da allowlist: recusa, item intacto, 0 evento" \
    "$(Pq -c "select (select count(*) from pedido_sugerido_evento where pedido_id=3)||'|'||(select count(*) from pedido_compra_item where id=31)")" "0|1"

  # T — sem trilha não há remoção: o gravador nega (sem capacidade) ⇒ a remoção volta inteira.
  local T_OUT
  T_OUT=$(P -v VERBOSITY=verbose -tA -c "SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000bb'; SET test.cap='0'; SELECT remover_itens_pedido_sugerido(4, ARRAY[41]::bigint[], 'intruso')" 2>&1) || true
  case "$T_OUT" in
    *"42501"*"requer capacidade de compras"*) ok "T1 gravador negado aborta a remoção (42501)";;
    *) bad "T1 esperado 42501 do gravador -- veio [$(echo "$T_OUT" | head -c 200)]";;
  esac
  eq "T2 item do pedido 4 INTACTO, pedido NÃO cancelado e 0 evento" \
    "$(Pq -c "select (select count(*) from pedido_compra_item where id=41)||'|'||(select status from pedido_compra_sugerido where id=4)||'|'||(select count(*) from pedido_sugerido_evento where pedido_id=4)")" "1|pendente_aprovacao|0"
  # T3 — a trilha falha no meio: a remoção (itens + cabeçalho) volta inteira.
  AU "SET test.falha_trilha='1'; SELECT remover_itens_pedido_sugerido(7, ARRAY[71]::bigint[], 'lucas@x')" >/dev/null 2>&1 || true
  eq "T3 trilha indisponível: item 71 INTACTO e pedido 7 NÃO cancelado" \
    "$(Pq -c "select (select count(*) from pedido_compra_item where id=71)||'|'||(select status from pedido_compra_sugerido where id=7)")" "1|pendente_aprovacao"

  # A — aprovação pela via da tela (2 argumentos).
  AU "SET test.recusa='pedido não encontrado'; SELECT aprovar_pedido_sugerido(9999::bigint, 'lucas@x')" >/dev/null
  eq "A1 recusa de pedido regerado (id inexistente) vira evento com o erro" \
    "$(Pq -c "select detalhe->>'erro' from pedido_sugerido_evento where pedido_id=9999 and evento='aprovacao_recusada'")" "pedido não encontrado"
  eq "A2 a recusa continua chegando à tela como {error}" \
    "$(AU "SET test.recusa='pedido já está no estado cancelado_humano'; SELECT aprovar_pedido_sugerido(5::bigint, 'lucas@x')->>'error'" | tail -1)" \
    "pedido já está no estado cancelado_humano"
  AU "SELECT aprovar_pedido_sugerido(6::bigint, 'lucas@x')" >/dev/null
  eq "A4 pedido_id NULL: a recusa chega como {error}, não como erro de RPC" \
    "$(AU "SET test.recusa='pedido não encontrado'; SELECT aprovar_pedido_sugerido(NULL::bigint, 'lucas@x')->>'error'" | tail -1)" "pedido não encontrado"
  eq "A5 trilha indisponível: a recusa ORIGINAL chega intacta" \
    "$(AU "SET test.falha_trilha='1'; SET test.recusa='os itens mudaram'; SELECT aprovar_pedido_sugerido(5::bigint, 'lucas@x')->>'error'" 2>/dev/null | tail -1)" "os itens mudaram"
  eq "A3 aprovação ok: status muda e 0 evento" \
    "$(Pq -c "select (select status from pedido_compra_sugerido where id=6)||'|'||(select count(*) from pedido_sugerido_evento where pedido_id=6)")" "aprovado_aguardando_disparo|0"

  # W — ninguém grava/apaga a trilha por fora do gravador.
  local W_OUT
  W_OUT=$(AUV "INSERT INTO pedido_sugerido_evento (pedido_id, evento) VALUES (1, 'itens_removidos')" 2>&1) || true
  case "$W_OUT" in *" 42501: "*) ok "W1 authenticated não INSERE na trilha";; *) bad "W1 -- [$(echo "$W_OUT" | head -c 200)]";; esac
  W_OUT=$(AUV "DELETE FROM pedido_sugerido_evento" 2>&1) || true
  case "$W_OUT" in *" 42501: "*) ok "W2 authenticated não APAGA a trilha";; *) bad "W2 -- [$(echo "$W_OUT" | head -c 200)]";; esac
  W_OUT=$(P -v VERBOSITY=verbose -tA -c "SET ROLE anon; SELECT private.registrar_evento_pedido_sugerido(1, 'itens_removidos', 'x', '{}')" 2>&1) || true
  case "$W_OUT" in *" 42501: "*) ok "W3 anon não executa o gravador";; *) bad "W3 -- [$(echo "$W_OUT" | head -c 200)]";; esac
  W_OUT=$(P -v VERBOSITY=verbose -tA -c "SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000bb'; SET test.cap='0'; SELECT private.registrar_evento_pedido_sugerido(1, 'itens_removidos', 'x', '{}')" 2>&1) || true
  case "$W_OUT" in *" 42501: "*"requer capacidade"*) ok "W5 authenticated SEM capacidade não grava pelo gravador";; *) bad "W5 -- [$(echo "$W_OUT" | head -c 200)]";; esac
  W_OUT=$(AUV "SELECT setval('public.pedido_sugerido_evento_id_seq', 1)" 2>&1) || true
  case "$W_OUT" in *" 42501: "*) ok "W6 authenticated não mexe no contador da trilha";; *) bad "W6 -- [$(echo "$W_OUT" | head -c 200)]";; esac
  eq "W4 authenticated com capacidade LÊ a trilha" \
    "$(AU "SELECT count(*) FROM pedido_sugerido_evento" | tail -1)" "4"

  # I — idempotência e anti-deriva.
  if P -q -c "BEGIN;" -f "$MIG" -c "COMMIT;" >/tmp/${SLUG}-reapply.log 2>&1; then ok "I1 re-aplicar passa (PRE aceita o corpo deste arquivo)"
  else bad "I1 re-aplicar -- $(head -c 300 /tmp/${SLUG}-reapply.log)"; fi
  P -q -c "CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text) RETURNS jsonb LANGUAGE plpgsql AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;"
  if P -q -c "BEGIN;" -f "$MIG" -c "COMMIT;" >/tmp/${SLUG}-deriva.log 2>&1; then bad "I2 corpo derivado deveria ABORTAR na PRE"
  elif grep -q "PRE FALHOU: aprovar_pedido_sugerido" /tmp/${SLUG}-deriva.log; then ok "I2 corpo derivado ABORTA na PRE"
  else bad "I2 abortou, mas não pela PRE -- $(head -c 300 /tmp/${SLUG}-deriva.log)"; fi

  echo "RESUMO pass=$PASS fail=$FAIL"
  [ "$FAIL" -eq 0 ] && echo "FIM_OK_${SLUG}"
  [ "$FAIL" -eq 0 ]
}

if [ "${1:-}" != "--falsificar" ]; then
  rodada "$MIGRATION"
  exit $?
fi

# ── FALSIFICAÇÃO: controle verde NA MESMA invocação, depois uma sabotagem por vez.
echo "=== CONTROLE (migration real) ==="
rodada "$MIGRATION" >/tmp/${SLUG}-controle.log 2>&1 || { echo "CONTROLE VERMELHO — falsificação não vale"; tail -c 800 /tmp/${SLUG}-controle.log; exit 1; }
grep -q "FIM_OK_${SLUG}" /tmp/${SLUG}-controle.log || { echo "CONTROLE sem marcador de fim"; exit 1; }
echo "  controle verde"

SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
trap 'parar_servidor; rm -rf "$SAB_DIR"' EXIT
VIVAS=0
sabota() {
  local nome="$1" de="$2" para="$3" alvo="$4"
  local f="$SAB_DIR/$nome.sql"
  python3 - "$MIGRATION" "$f" "$de" "$para" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src).read()
# Vários pares separados por "|||" (uma sabotagem pode precisar abrir E fechar um bloco).
for d, q in zip(de.split("|||"), para.split("|||")):
    if s.count(d) < 1:
        sys.exit("sabotagem nao casou: " + d[:60])
    s = s.replace(d, q)
# Sabotagem de CORPO muda o md5: neutraliza só a régua de md5 da PÓS, para o vermelho vir do
# assert de COMPORTAMENTO (R1/A1), não da PÓS. As outras checagens da PÓS ficam com dente.
for m in ("d74204f18510722a2d1a1ede120b7fff", "f0163119eef31848c34bf7e145899cca"):
    s = s.replace("IS DISTINCT FROM '" + m + "' THEN", "IS NULL THEN")
open(dst, "w").write(s)
PY
  if rodada "$f" >"$SAB_DIR/$nome.log" 2>&1; then
    echo "  SABOTAGEM VIVA: $nome (a suíte ficou verde)"; VIVAS=$((VIVAS+1))
  elif grep -q "FAIL $alvo" "$SAB_DIR/$nome.log"; then
    echo "  morta: $nome → $alvo vermelho"
  else
    echo "  SABOTAGEM VIVA: $nome morreu por outro motivo, não por $alvo"; VIVAS=$((VIVAS+1))
    grep "FAIL" "$SAB_DIR/$nome.log" | head -3
  fi
}
sabota remover_sem_trilha "  PERFORM private.registrar_evento_pedido_sugerido(
    p_pedido_id, 'itens_removidos'|||      'cancelado', v_cancelou
    )
  );" "  IF false THEN PERFORM private.registrar_evento_pedido_sugerido(
    p_pedido_id, 'itens_removidos'|||      'cancelado', v_cancelou
    )
  ); END IF;" "R1"
sabota aprovar_sem_trilha "  IF v_res ? 'error' AND p_pedido_id IS NOT NULL THEN" "  IF false THEN" "A1"
sabota gravador_invoker "RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER" "RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER" "aplicar"
sabota trilha_gravavel "REVOKE ALL ON public.pedido_sugerido_evento FROM PUBLIC, anon, authenticated, service_role;" "GRANT INSERT, DELETE ON public.pedido_sugerido_evento TO authenticated;" "aplicar"
sabota gravador_sem_gate "  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  INSERT" "  INSERT" "W5"
sabota aprovar_sem_blindagem "    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING" "    EXCEPTION WHEN division_by_zero THEN
      RAISE WARNING" "A5"
sabota sequence_aberta "REVOKE ALL ON SEQUENCE public.pedido_sugerido_evento_id_seq FROM PUBLIC, anon, authenticated;" "GRANT ALL ON SEQUENCE public.pedido_sugerido_evento_id_seq TO authenticated;" "aplicar"

# Camadas redundantes de propósito: o gate de entrada do remover e o "nada removido → {error}"
# seguram o T2 cada uma sozinha (sabotar uma fica verde por desenho). Sabotadas JUNTAS, o employee
# sem capacidade volta a cancelar pedido com itens. O filtro de id NULL na aprovação idem: a
# blindagem EXCEPTION já segura o A4 sozinha — por isso não há sabotagem só dele.
sabota_combo() {
  local f="$SAB_DIR/remover_sem_gate_nem_zero.sql"
  python3 - "$MIGRATION" "$f" <<'PY2'
import sys
src, dst = sys.argv[1:3]
s = open(src).read()
gate = """  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  -- (1) TRAVA"""
zero = "  IF COALESCE(cardinality(v_removidos), 0) = 0 THEN\n    RETURN"
assert s.count(gate) == 1 and s.count(zero) == 1, "combo nao casou"
s = s.replace(gate, "  -- (1) TRAVA").replace(zero, "  IF false THEN\n    RETURN")
for m in ("d74204f18510722a2d1a1ede120b7fff", "f0163119eef31848c34bf7e145899cca"):
    s = s.replace("IS DISTINCT FROM '" + m + "' THEN", "IS NULL THEN")
open(dst, "w").write(s)
PY2
  if rodada "$f" >"$SAB_DIR/combo.log" 2>&1; then echo "  SABOTAGEM VIVA: remover_sem_gate_nem_zero"; VIVAS=$((VIVAS+1))
  elif grep -q "FAIL T2" "$SAB_DIR/combo.log"; then echo "  morta: remover_sem_gate_nem_zero → T2 vermelho"
  else echo "  SABOTAGEM VIVA: remover_sem_gate_nem_zero morreu por outro motivo"; VIVAS=$((VIVAS+1)); grep FAIL "$SAB_DIR/combo.log" | head -3; fi
}
sabota_combo

echo "RESUMO_FALSIFICACAO vivas=$VIVAS"
[ "$VIVAS" -eq 0 ] && echo "FIM_OK_FALSIFICACAO_${SLUG}"
[ "$VIVAS" -eq 0 ]
