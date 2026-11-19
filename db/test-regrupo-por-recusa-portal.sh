#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — regrupo por recusa do portal Sayerlack (GRUPO_LEADTIME_MISMATCH)      ║
# ║  Migration: 20261120100000_reposicao_regrupo_por_recusa_portal.sql             ║
# ║  Incidente: #4505 (e #1276/#1497/#2388/#2416/#3169): SKU no grupo errado.      ║
# ║                                                                                ║
# ║      bash db/test-regrupo-por-recusa-portal.sh > /tmp/t.log 2>&1; echo $?       ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-regrupo-por-recusa-portal.sh ...       ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║   M  migration — postcondição do .sql passa e é idempotente.                   ║
# ║   R  regrupo   — move o SKU e cancela; "já corrigido" (#4505) cancela sem      ║
# ║                  tocar o cadastro; 2ª chamada não faz nada.                    ║
# ║   N  negativos — cada condição de prova recusa com O SEU motivo, pedido e      ║
# ║                  cadastro intactos (all-or-nothing).                           ║
# ║   L  lock      — espera o advisory lock do motor (55P03 com lock_timeout).     ║
# ║   A  ACL       — anon/authenticated sem EXECUTE (42501), com controle.         ║
# ║   F  falsificação — remove UMA condição por vez; o caso que ela protege fica   ║
# ║                    vermelho. Controle verde na MESMA invocação do laço.        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5483}"
SLUG="regrupo-portal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
-- Só as colunas que a função lê/escreve; tipos da PROD (information_schema, 2026-11-18).
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigint PRIMARY KEY,
  empresa                    text NOT NULL,
  fornecedor_nome            text NOT NULL,
  grupo_codigo               text,
  status                     text NOT NULL,
  status_envio_portal        text,
  portal_erro                text,
  portal_resposta            jsonb,
  portal_protocolo           text,
  portal_proximo_retry_em    timestamptz,
  omie_pedido_compra_id      text,
  omie_pedido_compra_numero  text,
  disparo_claim_em           timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  atualizado_em              timestamptz DEFAULT now()
);
CREATE TABLE public.pedido_compra_item (
  id bigserial PRIMARY KEY, pedido_id bigint, sku_codigo_omie text, sku_portal_aprovado text);
CREATE TABLE public.sku_fornecedor_externo (
  id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean);
CREATE TABLE public.sku_grupo_producao (
  empresa text, sku_codigo_omie text, grupo_codigo text, atualizado_em timestamptz, atualizado_por text,
  PRIMARY KEY (empresa, sku_codigo_omie));
CREATE TABLE public.fornecedor_grupo_producao (
  id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  lt_producao_dias integer, lt_producao_unidade text);
CREATE TABLE public.sku_embalagem_equivalencia (
  id bigserial PRIMARY KEY, empresa text, sku_codigo_omie text, ativo boolean, vigente_ate date);
CREATE TABLE public.pedidos_portal_tentativas (
  id uuid PRIMARY KEY, pedido_id bigint, iniciado_em timestamptz, concluido_em timestamptz,
  status_resultado text, evidence jsonb, erro text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text, fornecedor_nome text,
  tipo text CHECK (tipo IN ('outro')), severidade text CHECK (severidade IN ('info','atencao','urgente')),
  titulo text, mensagem text, status text CHECK (status IN ('pendente_notificacao')), metadata jsonb);
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;

-- Fixtures: a prova estruturada que a edge v1.16 grava (evidence.grupoLeadtime).
CREATE SCHEMA t;
CREATE FUNCTION t.mm(p_sku text, p_prz int, p_raw text DEFAULT NULL, p_ident boolean DEFAULT true) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('sku_portal', p_sku, 'sku_identificado', p_ident, 'linha', 1, 'prz_ent', p_prz,
    'prz_ent_raw', COALESCE(p_raw, p_prz::text), 'prz_ent_exato', COALESCE(p_raw, p_prz::text) ~ '^\s*\d+\s*$',
    'lt_esperado', 8) $$;
CREATE FUNCTION t.ev(p_mms jsonb, p_total int DEFAULT 1, p_valid int DEFAULT NULL, p_efet boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('efetivarAttempted', p_efet, 'erroTipo', 'GRUPO_LEADTIME_MISMATCH',
    'statusFinal', 'erro_nao_retentavel',
    'grupoLeadtime', jsonb_build_object('lt_esperado', 8, 'header_prz', 'Prz Ent', 'linhas_total', p_total,
       'linhas_validadas', COALESCE(p_valid, p_total), 'mismatches', p_mms)) $$;
-- Pedido recusado + item + tentativa com a MESMA prova (o caso feliz); os negativos estragam UMA coisa.
CREATE FUNCTION t.pedido(p_id bigint, p_sku text, p_portal text, p_grupo_sku text, p_ev jsonb,
                         p_forn text DEFAULT 'RENNER SAYERLACK S/A', p_grupo_ped text DEFAULT 'sayerlack_normal')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, grupo_codigo, status, status_envio_portal,
    portal_erro, portal_resposta)
  VALUES (p_id, 'OBEN', p_forn, p_grupo_ped, 'aprovado_aguardando_disparo', 'erro_nao_retentavel',
    'Grupo errado (Prz Ent != lead time do grupo)', jsonb_build_object('evidence', p_ev));
  INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, sku_portal_aprovado) VALUES (p_id, p_sku, p_portal);
  INSERT INTO public.sku_grupo_producao VALUES ('OBEN', p_sku, p_grupo_sku, now() - interval '9 days', 'auto_default_sayerlack')
    ON CONFLICT DO NOTHING;
  INSERT INTO public.pedidos_portal_tentativas (id, pedido_id, iniciado_em, concluido_em, status_resultado, evidence)
  VALUES (('00000000-0000-0000-0000-' || lpad(p_id::text, 12, '0'))::uuid, p_id, now() - interval '2 min',
          now() - interval '1 min', 'erro_nao_retentavel', p_ev);
END $$;
-- Chama a RPC e devolve 1 rótulo: CANCELADO / o motivo / ERRO:<sqlstate>.
CREATE FUNCTION t.chama(p_id bigint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := public.reposicao_regrupar_por_recusa_portal(p_id, ('00000000-0000-0000-0000-' || lpad(p_id::text, 12, '0'))::uuid);
  RETURN CASE WHEN r ->> 'cancelado' = 'true' THEN 'CANCELADO' ELSE r ->> 'motivo' END;
EXCEPTION WHEN OTHERS THEN RETURN 'ERRO:' || SQLSTATE;
END $$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261120100000_reposicao_regrupo_por_recusa_portal.sql"
[ -s "$MIG" ] || { echo "INFRA: migration ausente: $MIG"; exit 1; }

semear() {
  P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido, public.pedido_compra_item, public.sku_fornecedor_externo,
         public.sku_grupo_producao, public.fornecedor_grupo_producao, public.sku_embalagem_equivalencia,
         public.pedidos_portal_tentativas, public.fornecedor_alerta;
DO $$ BEGIN IF to_regclass('public.reposicao_regrupo_audit') IS NOT NULL THEN TRUNCATE public.reposicao_regrupo_audit; END IF; END $$;
INSERT INTO public.fornecedor_grupo_producao (empresa, fornecedor_nome, grupo_codigo, lt_producao_dias, lt_producao_unidade) VALUES
  ('OBEN', 'RENNER SAYERLACK S/A', 'sayerlack_normal', 8, 'uteis'),
  ('OBEN', 'RENNER SAYERLACK S/A', 'sayerlack_rapido', 5, 'uteis'),
  ('OBEN', 'RENNER SAYERLACK S/A', 'sayerlack_outro', 12, 'uteis'),
  ('OBEN', 'FORN2', 'f2_a', 5, 'uteis'), ('OBEN', 'FORN2', 'f2_b', 5, 'uteis'), ('OBEN', 'FORN2', 'f2_c', 8, 'uteis');
-- R1 move · R2 já corrigido (#4505: o SKU já está no rápido, carimbo de UI)
SELECT t.pedido(501, 'A1', 'YC.1400FP', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('YC.1400FP', 5))));
SELECT t.pedido(502, 'A2', 'P2', 'sayerlack_rapido', t.ev(jsonb_build_array(t.mm('P2', 5))));
-- R3 sem selo (sku_portal_aprovado NULL): casa pelo de-para ATIVO do fornecedor exato
SELECT t.pedido(503, 'A3', NULL, 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P3', 5))));
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, ativo) VALUES
  ('OBEN', 'RENNER SAYERLACK S/A', 'A3', 'P3', true);
-- N1 pedido com efetivarAttempted=true
SELECT t.pedido(511, 'B1', 'P11', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P11', 5))));
UPDATE public.pedido_compra_sugerido SET portal_resposta = jsonb_set(portal_resposta, '{evidence,efetivarAttempted}', 'true') WHERE id = 511;
-- N2 claim de disparo · N3 protocolo
SELECT t.pedido(512, 'B2', 'P12', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P12', 5))));
SELECT t.pedido(513, 'B3', 'P13', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P13', 5))));
-- N4 a tentativa chamada NÃO é a mais recente
SELECT t.pedido(514, 'B4', 'P14', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P14', 5))));
INSERT INTO public.pedidos_portal_tentativas (id, pedido_id, iniciado_em, concluido_em, status_resultado, evidence)
VALUES (gen_random_uuid(), 514, now(), now(), 'enviando_portal', '{}');
-- N5 grade parcial (1 linha com Prz ilegível foi pulada)
SELECT t.pedido(515, 'B5', 'P15', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P15', 5)), 2, 1));
-- N6 SKU não identificado (mesmo com sku_portal que casaria)
SELECT t.pedido(516, 'B6', 'P16', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P16', 5, NULL, false))));
-- N7 célula "5-8": o gate leu 5, mas não é inteiro exato
SELECT t.pedido(517, 'B7', 'P17', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P17', 5, '5-8'))));
-- N8 membro de equivalência ativa
SELECT t.pedido(518, 'B8', 'P18', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P18', 5))));
INSERT INTO public.sku_embalagem_equivalencia (empresa, sku_codigo_omie, ativo, vigente_ate) VALUES ('OBEN', 'B8', true, NULL);
-- N9 Prz 3 não casa grupo · N10 SKU num 3º grupo
SELECT t.pedido(519, 'B9', 'P19', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P19', 3))));
SELECT t.pedido(520, 'B10', 'P20', 'sayerlack_outro', t.ev(jsonb_build_array(t.mm('P20', 5))));
-- N11 prova do pedido ≠ prova da tentativa (outra execução)
SELECT t.pedido(521, 'B11', 'P21', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('P21', 5))));
UPDATE public.pedido_compra_sugerido SET portal_resposta = jsonb_set(portal_resposta, '{evidence,grupoLeadtime,header_prz}', '"Outro"') WHERE id = 521;
-- N12 all-or-nothing: o 1º mismatch é válido, o 2º não → nada muda (B12 continua normal)
SELECT t.pedido(522, 'B12', 'P22', 'sayerlack_normal',
  t.ev(jsonb_build_array(t.mm('P22', 5), t.mm('linha 2', 5, NULL, false)), 2));
-- N13 SKU do portal não casa item
SELECT t.pedido(523, 'B13', 'P23', 'sayerlack_normal', t.ev(jsonb_build_array(t.mm('NAOEXISTE', 5))));
-- N14 Prz 5 casa DOIS grupos (FORN2)
SELECT t.pedido(524, 'B14', 'P24', 'f2_c', t.ev(jsonb_build_array(t.mm('P24', 5))), 'FORN2', 'f2_c');
UPDATE public.pedido_compra_sugerido SET disparo_claim_em = now() WHERE id = 512;
UPDATE public.pedido_compra_sugerido SET portal_protocolo = '2134225' WHERE id = 513;
SQL
}
grupo()  { Pq -c "SELECT grupo_codigo || '/' || atualizado_por FROM public.sku_grupo_producao WHERE sku_codigo_omie='$1';"; }
campo()  { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }

# Casos negativos: id|pedido|sku|motivo esperado. Intacto = motivo certo + pedido aprovado + cadastro igual.
NEGATIVOS="N1|511|B1|estado_do_pedido_mudou N2|512|B2|estado_do_pedido_mudou N3|513|B3|estado_do_pedido_mudou
N4|514|B4|tentativa_nao_e_a_mais_recente N5|515|B5|grade_incompleta N6|516|B6|mismatch_sem_identidade_ou_prz_inexato
N7|517|B7|mismatch_sem_identidade_ou_prz_inexato N8|518|B8|sku_em_grupo_de_equivalencia N9|519|B9|prz_ent_nao_casa_1_grupo
N10|520|B10|grupo_atual_inesperado N11|521|B11|prova_ausente_ou_divergente N12|522|B12|mismatch_sem_identidade_ou_prz_inexato
N13|523|B13|sku_portal_nao_casa_1_item N14|524|B14|prz_ent_nao_casa_1_grupo"

# Roda TODOS os casos numa base recém-semeada; imprime "ok <ID>" / "FALHA <ID> <detalhe>".
rodar_casos() {
  semear
  local c id ped sku esp antes r st depois
  # L1: com o lock do motor tomado por outra sessão, a RPC ESPERA (lock_timeout → 55P03) e não escreve.
  P -q -c "SELECT pg_advisory_lock(hashtext('gerar_pedidos_sugeridos_ciclo:oben')); SELECT pg_sleep(4);" >/dev/null 2>&1 &
  local bg=$!
  sleep 1
  r=$(Pq -c "SET lock_timeout = '400ms'; SELECT t.chama(501);" | tail -1)
  wait "$bg" || true
  if [ "$r" = "ERRO:55P03" ] && [ "$(campo 501 status)" = "aprovado_aguardando_disparo" ]; then echo "  ok L1"; else echo "  FALHA L1 [$r]"; fi
  for c in $NEGATIVOS; do
    IFS='|' read -r id ped sku esp <<<"$c"
    antes=$(grupo "$sku")
    r=$(Pq -c "SELECT t.chama($ped);")
    st=$(campo "$ped" status); depois=$(grupo "$sku")
    if [ "$r" = "$esp" ] && [ "$st" = "aprovado_aguardando_disparo" ] && [ "$antes" = "$depois" ]; then echo "  ok $id"
    else echo "  FALHA $id [$r|$st|$antes->$depois]"; fi
  done
  r=$(Pq -c "SELECT t.chama(501);")
  if [ "$r" = "CANCELADO" ] && [ "$(grupo A1)" = "sayerlack_rapido/sistema:prz_ent_portal" ]; then echo "  ok R1"; else echo "  FALHA R1 [$r|$(grupo A1)]"; fi
}

echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="

# ── M: migration real ─────────────────────────────────────────────────────────
P -q -f "$MIG"
ok "M1 postcondição do .sql passou (ON_ERROR_STOP)"
P -q -f "$MIG"
ok "M2 re-aplicar é idempotente (postcondição passou de novo)"
eq "M3 a execução de prova da postcondição não escreveu auditoria" "$(Pq -c "SELECT count(*) FROM public.reposicao_regrupo_audit;")" "0"

# ── R: regrupo ────────────────────────────────────────────────────────────────
echo "-- grupo R: regrupo --"
semear
eq "R1 move o SKU e cancela"                 "$(Pq -c "SELECT t.chama(501);")" "CANCELADO"
eq "R1b SKU no rápido, autor sistema"         "$(grupo A1)" "sayerlack_rapido/sistema:prz_ent_portal"
eq "R1c pedido cancelado"                     "$(campo 501 status)" "cancelado"
eq "R1d autor do cancelamento"                "$(campo 501 cancelado_por)" "sistema:regrupo_portal"
eq "R1e higiene: portal nao_aplicavel"        "$(campo 501 status_envio_portal)" "nao_aplicavel"
eq "R1f cancelado_em carimbado"               "$(Pq -c "SELECT cancelado_em IS NOT NULL FROM pedido_compra_sugerido WHERE id=501;")" "t"
eq "R1g justificativa cita o motivo do portal" "$(Pq -c "SELECT position('Grupo errado (Prz Ent' in justificativa_cancelamento) > 0 FROM pedido_compra_sugerido WHERE id=501;")" "t"
eq "R1h portal_erro preservado (rastro)"      "$(campo 501 portal_erro)" "Grupo errado (Prz Ent != lead time do grupo)"
eq "R1i auditoria: 1 regrupado normal->rapido Prz 5 LT 8" \
   "$(Pq -c "SELECT string_agg(resultado||':'||sku_codigo_omie||':'||grupo_de||'>'||grupo_para||':'||prz_ent||'/'||lt_esperado, ',') FROM reposicao_regrupo_audit WHERE pedido_id=501;")" \
   "regrupado:A1:sayerlack_normal>sayerlack_rapido:5/8"
eq "R1j 1 alerta de desfecho, cita o SKU"     "$(Pq -c "SELECT count(*) || ':' || (position('YC.1400FP (A1): sayerlack_normal' in min(mensagem)) > 0)::text FROM fornecedor_alerta WHERE metadata->>'pedido_id'='501';")" "1:true"
eq "R2 #4505: já corrigido cancela"          "$(Pq -c "SELECT t.chama(502);")" "CANCELADO"
eq "R2b cadastro NÃO reescrito (carimbo da UI fica)" "$(grupo A2)" "sayerlack_rapido/auto_default_sayerlack"
eq "R2c auditoria ja_corrigido"               "$(Pq -c "SELECT resultado FROM reposicao_regrupo_audit WHERE pedido_id=502;")" "ja_corrigido"
eq "R2d alerta marca [já estava corrigido]"   "$(Pq -c "SELECT position('[já estava corrigido]' in mensagem) > 0 FROM fornecedor_alerta WHERE metadata->>'pedido_id'='502';")" "t"
eq "R3 sem selo: casa pelo de-para ativo"     "$(Pq -c "SELECT t.chama(503);")" "CANCELADO"
eq "R3b SKU movido"                           "$(grupo A3)" "sayerlack_rapido/sistema:prz_ent_portal"
eq "R4 2ª chamada no mesmo pedido: nada"      "$(Pq -c "SELECT t.chama(501);")" "estado_do_pedido_mudou"
eq "R4b só 1 alerta para o #501"              "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE metadata->>'pedido_id'='501';")" "1"
eq "R5 pedido inexistente"                    "$(Pq -c "SELECT t.chama(999);")" "pedido_inexistente"
# R6: de-para INATIVO não conta (sem selo) → não casa item
P -q -c "UPDATE public.sku_fornecedor_externo SET ativo=false; UPDATE public.pedido_compra_sugerido SET status='aprovado_aguardando_disparo', status_envio_portal='erro_nao_retentavel' WHERE id=503;"
P -q -c "UPDATE public.sku_grupo_producao SET grupo_codigo='sayerlack_normal' WHERE sku_codigo_omie='A3';"
eq "R6 de-para inativo não casa"              "$(Pq -c "SELECT t.chama(503);")" "sku_portal_nao_casa_1_item"

# ── N + L: negativos e lock, via o MESMO laço da falsificação ─────────────────
echo "-- grupos N/L: negativos e lock --"
rodar_casos > "$RODADA/base.log"
while read -r linha; do
  case "$linha" in ok\ *) ok "${linha#ok }" ;; *) bad "$linha" ;; esac
done < "$RODADA/base.log"
eq "N12b all-or-nothing: nenhuma auditoria de regrupado no #522" "$(Pq -c "SELECT count(*) FROM reposicao_regrupo_audit WHERE pedido_id=522 AND resultado<>'recusado';")" "0"
eq "N0 recusas auditadas com motivo"         "$(Pq -c "SELECT count(*) FROM reposicao_regrupo_audit WHERE resultado='recusado' AND motivo IS NOT NULL;")" "14"
eq "N0b nenhum alerta escrito por recusa"     "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE (metadata->>'pedido_id')::bigint BETWEEN 511 AND 524;")" "0"

# ── A: ACL ─────────────────────────────────────────────────────────────────────
echo "-- grupo A: ACL --"
for r in authenticated anon; do
  if P -q <<SQL >/dev/null 2>&1
SET ROLE $r;
DO \$t\$
BEGIN
  PERFORM public.reposicao_regrupar_por_recusa_portal(-1, gen_random_uuid());
  RAISE EXCEPTION 'TEATRO: $r executou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
  then ok "A1 $r sem EXECUTE (42501)"; else bad "A1 $r: não veio 42501"; fi
done
A1C=$(Pq <<'SQL' | tail -1
SET ROLE service_role;
SELECT public.reposicao_regrupar_por_recusa_portal(-1, gen_random_uuid())->>'motivo';
SQL
)
eq "A1c controle: service_role executa" "$A1C" "pedido_inexistente"

# ── F: FALSIFICAÇÃO — uma condição por vez, controle verde na MESMA invocação ─
echo "-- grupo F: falsificação --"
SABOTAGENS="efetivar:N1 claim:N2 protocolo:N3 recente:N4 grade:N5 identificado:N6 exato:N7 equivalencia:N8
grupo1:N9,N14 inesperado:N10 prova:N11 item:N13 lock:L1"
registradas=""
registra() {
  case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1)" >&2; exit 2 ;; esac
  registradas="$registradas $1"; printf -v "expr_$1" '%s' "$2"
}
registra efetivar     "s#AND v_ped.portal_resposta -> 'evidence' -> 'efetivarAttempted' = 'false'::jsonb##"
registra claim        "s#AND v_ped.disparo_claim_em IS NULL##"
registra protocolo    "s#AND NULLIF(btrim(v_ped.portal_protocolo), '') IS NULL##"
registra recente      "s#IF EXISTS (SELECT 1 FROM public.pedidos_portal_tentativas x#IF false AND EXISTS (SELECT 1 FROM public.pedidos_portal_tentativas x#"
registra grade        "s#AND v_g -> 'linhas_validadas' = v_g -> 'linhas_total'##"
registra identificado "s#IF NOT (v_m -> 'sku_identificado' = 'true'::jsonb#IF NOT (true#"
registra exato        "s#AND v_m -> 'prz_ent_exato' = 'true'::jsonb##"
registra equivalencia "s#IF EXISTS (SELECT 1 FROM public.sku_embalagem_equivalencia q#IF false AND EXISTS (SELECT 1 FROM public.sku_embalagem_equivalencia q#"
registra grupo1       "s#IF v_n <> 1 THEN v_motivo := 'prz_ent_nao_casa_1_grupo'#IF v_n = 0 THEN v_motivo := 'prz_ent_nao_casa_1_grupo'#"
registra inesperado   "s#IF v_atual = v_ped.grupo_codigo THEN#IF true THEN#"
registra prova        "s#OR (v_ped.portal_resposta -> 'evidence' -> 'grupoLeadtime') IS DISTINCT FROM v_g THEN#THEN#"
registra item         "s#IF v_n <> 1 THEN v_motivo := 'sku_portal_nao_casa_1_item'#IF false THEN v_motivo := 'sku_portal_nao_casa_1_item'#"
registra lock         "s#PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(v_empresa)));##"

COPIA="$RODADA/sab.sql"
# Só o CREATE da função (sem tabela/postcondição: a sabotagem não é da migration).
# shellcheck disable=SC2016  # `$function$` é a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^CREATE OR REPLACE FUNCTION public.reposicao_regrupar_por_recusa_portal/,/^\$function\$;/p' "$MIG" > "$COPIA"
[ -s "$COPIA" ] || { echo "INFRA: não extraí a função do .sql"; exit 1; }

ctl="$RODADA/controle.log"
P -q -f "$COPIA"; rodar_casos > "$ctl"
if grep -q "FALHA" "$ctl"; then bad "F0 controle: a função intacta extraída já falha ($(grep FALHA "$ctl" | tr '\n' ' '))"
else ok "F0 controle: função intacta extraída, todos os casos verdes"; fi

for item in $SABOTAGENS; do
  sab="${item%%:*}"; exigidos="${item#*:}"
  v="expr_$sab"; expr="${!v-}"
  if [ -z "$expr" ]; then bad "F $sab: na lista SABOTAGENS e SEM registro — nada foi sabotado"; continue; fi
  sed "$expr" "$COPIA" > "$COPIA.n"
  mudou=$(diff "$COPIA" "$COPIA.n" | grep -c '^<' || true)
  [ "$mudou" = "1" ] || { bad "F $sab: sabotagem não alterou exatamente 1 linha ($mudou) — vazia ou ampla"; continue; }
  log="$RODADA/sab-$sab.log"
  P -q -f "$COPIA.n"; rodar_casos > "$log"
  faltam=""
  for exigido in ${exigidos//,/ }; do
    if ! grep -Eq "^  ok $exigido$" "$ctl" || ! grep -Eq "^  FALHA $exigido( |$)" "$log"; then
      faltam="$faltam $exigido"
    fi
  done
  if [ -z "$faltam" ]; then ok "F $sab → $exigidos vermelho (verde no controle): a condição protege"
  else bad "F $sab: não acusou$faltam — condição redundante ou caso inalcançado"; fi
done
P -q -f "$MIG"

echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "PROVA-REGRUPO-PORTAL-OK"
