#!/usr/bin/env bash
# PROVA PG17 — fila "PO a baixar no Omie" (20261118150731_reposicao_po_a_baixar.sql)
#
#   I  a migration aplica com a postcondição OK (I0) e re-aplicar é seguro (I1)
#   F  po_contado_com_nf: PO contado pelo motor + NF no espelho aparece (F1); contado sem NF não (F2); com NF mas
#      EXCLUÍDO da contagem não (F3); só o último run VÁLIDO conta — run mais novo inválido é ignorado e PO só de run
#      antigo não aparece (F4)
#   S  nf_pendente: sombra pendente sem NF no espelho aparece, com os POs abertos do contrato e sem o PO encerrado
#      (S1); NF já recebida no espelho some (S2); sombra velha vem MARCADA desatualizada (S3); classe fora da fila
#      não aparece (S4)
#   E  isolamento por empresa (E1)
#   G  gate: authenticated sem capacidade → 42501 (G1); com capacidade lê (G2); anon sem EXECUTE → 42501 (G3);
#      empresa inválida → 22023 (G4)
#
# Uso: bash db/test-reposicao-po-a-baixar.sh               # suíte
#      bash db/test-reposicao-po-a-baixar.sh --falsificar  # controle + cada sabotagem tem de ficar vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5871}"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261118150731_reposicao_po_a_baixar.sql"
MIG_OBS="$REPO_ROOT/supabase/migrations/20261005131331_reposicao_po_observado_pelo_motor.sql"
MIG_SOMBRA="$REPO_ROOT/supabase/migrations/20261017040000_recebimento_associacao_sombra.sql"
TOTAL_ESPERADO=15

# ── --falsificar: controle VERDE na mesma invocação, depois cada sabotagem (uma camada por vez) tem de acusar.
# Formato <nome>:<VERMELHOS>[:<VERDES>]; `ID!MARCA` exige a marca do motivo no vermelho.
SABOTAGENS="sem_filtro_nf:F2:F1 sem_exclusao:F3:F1 run_qualquer:F4:F1 sombra_ignora_espelho:S2:S1
            sem_marca_velha:S3:S1 gate_aberto:G1:G2 empresa_vaza:E1:F1
            pc_sem_definer:I0!SECURITY pc_anon_executa:I0!anon"
if [ "${1:-}" = "--falsificar" ]; then
  falhas=0
  rodar() {  # <nome> <porta> → as linhas de veredito do filho
    PGPORT_TEST="$2" SABOTAGEM="$1" bash "$0" 2>&1 | grep -E '^(RESUMO|VERDE|VERMELHO|ERRO)' || true
  }
  ctl="$(rodar "" 5872)"
  if ! grep -q "^RESUMO verdes=$TOTAL_ESPERADO vermelhos=0$" <<<"$ctl"; then
    echo "CONTROLE NÃO VERDE — falsificação inválida:"; printf '%s\n' "$ctl"; exit 1
  fi
  echo "controle: $TOTAL_ESPERADO/$TOTAL_ESPERADO verdes"
  porta=5873
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    out="$(rodar "$sab" "$porta")"; porta=$((porta + 1))
    motivo=""
    grep -q '^RESUMO ' <<<"$out" || motivo="$motivo o filho não chegou ao RESUMO (abortou antes de provar);"
    for decl in ${verm//,/ }; do
      id="${decl%%!*}"; marca=""
      [ "$id" = "$decl" ] || marca="${decl#*!}"
      linha_v="$(printf '%s\n' "$out" | grep -m1 "^VERMELHO $id " || true)"
      if [ -z "$linha_v" ]; then motivo="$motivo $id deveria ficar VERMELHO;"
      elif [ -n "$marca" ] && ! grep -qF "$marca" <<<"$linha_v"; then motivo="$motivo $id vermelho sem a marca [$marca];"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -q "^VERDE $id\$" <<<"$out" || motivo="$motivo $id deveria seguir VERDE (linha VERDE ausente);"
    done
    if [ -z "$motivo" ]; then echo "sabotagem $sab: tem dente ($verm)"; else falhas=$((falhas + 1)); echo "sabotagem $sab:$motivo"; printf '%s\n' "$out"; fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "FALSIFICACAO-OK"; exit 0; fi
  echo "FALSIFICACAO REPROVOU: $falhas sabotagem(ns) sem dente"; exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-po-a-baixar.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q() { Pdb -At -q -c "$1" 2>&1 | tail -n 1; }

trocar() {  # <entrada> <saída> <de> <para> — o padrão tem de ocorrer EXATAMENTE 1x (troca que não pegou é erro)
  python3 - "$@" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(de) != 1:
    sys.exit('padrao ocorre %dx (esperado 1): %r' % (s.count(de), de))
open(dst, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';"
Pdb -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE SCHEMA IF NOT EXISTS private;
-- stub da capacidade: em prod é a matriz de autorização; aqui, "tem papel employee"
CREATE OR REPLACE FUNCTION private.cap_compras_ler(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_uid AND role = 'employee') $$;
-- espelho de POs: só as colunas que a RPC lê (o pré-voo psql-ro confere os nomes na PROD)
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  numero_pedido text,
  fornecedor_nome text,
  t4_data_recebimento timestamptz,
  nfe_numero text,
  nid_receb bigint,
  numero_contrato_fornecedor text,
  encerrado_omie_em timestamptz
);
CREATE OR REPLACE FUNCTION public._prova(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, 'NULL');
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public._prova(text) TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
INSERT INTO public.user_roles (user_id, role) VALUES ('a0000000-0000-4000-8000-000000000001', 'employee');
SQL
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER ROLE service_role BYPASSRLS;"
# as tabelas-fonte vêm das migrations REAIS (não de cópia): a RPC lê o que o motor e a sombra gravam
Pdb -q -f "$MIG_OBS" >/dev/null 2>&1
Pdb -q -f "$MIG_SOMBRA" >/dev/null 2>&1

verdes=0; vermelhos=0
ok() {  # <id> <esperado> <obtido>
  if [ "$2" = "$3" ]; then verdes=$((verdes + 1)); echo "VERDE $1"; else vermelhos=$((vermelhos + 1)); echo "VERMELHO $1 esperado=[$2] obtido=[$3]"; fi
}

# ── I — a migration (real ou sabotada) aplica e re-aplica ──
MIG_USADA="$MIG"
case "$SABOTAGEM" in
  pc_sem_definer) trocar "$MIG" "$TMPD/m.sql" 'STABLE SECURITY DEFINER' 'STABLE' ;;
  pc_anon_executa) trocar "$MIG" "$TMPD/m.sql" 'REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar(text) FROM anon;' 'GRANT EXECUTE ON FUNCTION public.reposicao_po_a_baixar(text) TO anon;' ;;
esac
[ -f "$TMPD/m.sql" ] && MIG_USADA="$TMPD/m.sql"
if Pdb -q -f "$MIG_USADA" >"$TMPD/i0.log" 2>&1 && grep -q "POSTCONDICAO OK" "$TMPD/i0.log"; then ok I0 aplicou aplicou; else ok I0 aplicou "falhou: $(grep -m1 -E 'ERRO|EXCEPTION' "$TMPD/i0.log" | cut -c1-400)"; fi
if [ "$MIG_USADA" != "$MIG" ]; then  # sabotagem de postcondição: só o I0 importa
  echo "RESUMO verdes=$verdes vermelhos=$vermelhos"; exit 0
fi
if Pdb -q -f "$MIG" >"$TMPD/i1.log" 2>&1; then ok I1 reaplicou reaplicou; else ok I1 reaplicou falhou; fi

# ── sabotagens de COMPORTAMENTO, aplicadas no banco depois da migration real ──
fn_sabotada() {  # <de> <para> — recria a função com UMA troca
  sed -n '/^CREATE OR REPLACE FUNCTION public.reposicao_po_a_baixar/,/^\$fn\$;/p' "$MIG" > "$TMPD/fn.sql"
  trocar "$TMPD/fn.sql" "$TMPD/fn2.sql" "$1" "$2"
  Pdb -q -f "$TMPD/fn2.sql"
}
case "$SABOTAGEM" in
  sem_filtro_nf) fn_sabotada '   WHERE p.t4_data_recebimento IS NOT NULL' '   WHERE true' ;;
  sem_exclusao) fn_sabotada '     WHERE i.exclusao IS NULL' '     WHERE true' ;;
  run_qualquer) fn_sabotada 'WHERE r.empresa = v_empresa AND r.varredura_completa AND r.pendente_aplicado' 'WHERE r.empresa = v_empresa' ;;
  sombra_ignora_espelho) fn_sabotada '                        AND pr.t4_data_recebimento IS NOT NULL);' '                        AND false);' ;;
  sem_marca_velha) fn_sabotada "s.observado_em < now() - interval '36 hours'" 'false' ;;
  gate_aberto) fn_sabotada '(SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE' 'false' ;;
  empresa_vaza) fn_sabotada '      ON p.empresa::text = v_empresa AND p.omie_codigo_pedido = c.cod' '      ON p.omie_codigo_pedido = c.cod' ;;
esac

# ── fixtures ──
# run antigo VÁLIDO (contou o PO 50), run atual VÁLIDO (contou 10, 11, 12; 13 excluído), run mais novo INVÁLIDO (contou 60)
Pdb -q <<'SQL'
INSERT INTO public.reposicao_po_observado_run (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate, filtros,
  varredura_completa, pendente_aplicado, skus_divergentes, pedidos_lidos, versao_edge) VALUES
 ('00000000-0000-4000-8000-0000000000a1', 'OBEN', now() - interval '2 days', now() - interval '2 days', '2026-01-01', '2027-01-01', '{}', true, true, 0, 1, 'v'),
 ('00000000-0000-4000-8000-0000000000a2', 'OBEN', now() - interval '1 hour', now() - interval '1 hour', '2026-01-01', '2027-01-01', '{}', true, true, 0, 4, 'v'),
 ('00000000-0000-4000-8000-0000000000a3', 'OBEN', now() - interval '5 minutes', now() - interval '5 minutes', '2026-01-01', '2027-01-01', '{}', true, false, 0, 1, 'v');
INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, numero_pedido, etapa, sku_codigo_omie, quantidade, quantidade_recebida, contribuicao, exclusao) VALUES
 ('00000000-0000-4000-8000-0000000000a1', 50, 1, '1050', '15', 1, 5, 0, 5, NULL),
 ('00000000-0000-4000-8000-0000000000a2', 10, 1, '1010', '15', 1, 3, 0, 3, NULL),
 ('00000000-0000-4000-8000-0000000000a2', 10, 2, '1010', '15', 2, 2, 0, 2, NULL),
 ('00000000-0000-4000-8000-0000000000a2', 11, 1, '1011', '15', 3, 4, 0, 4, NULL),
 ('00000000-0000-4000-8000-0000000000a2', 13, 1, '1013', '20', 4, 1, 0, 0, 'etapa_nao_aberta'),
 ('00000000-0000-4000-8000-0000000000a3', 60, 1, '1060', '15', 5, 7, 0, 7, NULL);
INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido, numero_pedido, fornecedor_nome, t4_data_recebimento, nfe_numero, nid_receb, numero_contrato_fornecedor, encerrado_omie_em) VALUES
 ('OBEN', 10, '1010', 'Sayerlack', now() - interval '3 days', '000111', 7001, 'C10', NULL),
 ('OBEN', 11, '1011', 'Sayerlack', NULL, NULL, NULL, 'C11', NULL),
 ('OBEN', 13, '1013', 'Sayerlack', now() - interval '3 days', '000113', 7013, 'C13', NULL),
 ('OBEN', 50, '1050', 'Sayerlack', now() - interval '3 days', '000150', 7050, 'C50', NULL),
 ('OBEN', 60, '1060', 'Sayerlack', now() - interval '3 days', '000160', 7060, 'C60', NULL),
 ('OBEN', 21, '1021', 'Sayerlack', NULL, NULL, NULL, 'C21', NULL),
 ('OBEN', 22, '1022', 'Sayerlack', NULL, NULL, NULL, 'C21', now() - interval '1 day'),
 ('OBEN', -8002, NULL, 'Sayerlack', now() - interval '1 day', '000802', 8002, NULL, NULL),
 ('COLACOR', 10, '9910', 'Outro', now() - interval '3 days', '000999', 9910, 'X', NULL);
INSERT INTO public.recebimento_associacao_sombra (empresa, nid_receb, numero_nfe, estado_nf, vinculo, classe, motivos, contratos, pares, pedidos, versao_classificador, observado_em) VALUES
 ('OBEN', 8001, '000801', 'pendente', 'nenhum', 'ambigua', ARRAY['quantidade_menor_que_saldo'], ARRAY['C21'], '[]', '[]', 'v', now() - interval '2 hours'),
 ('OBEN', 8002, '000802', 'pendente', 'nenhum', 'ambigua', ARRAY['item_sem_par'], ARRAY['C11'], '[]', '[]', 'v', now() - interval '2 hours'),
 ('OBEN', 8003, '000803', 'pendente', 'nenhum', 'orfa', ARRAY['contrato_sem_po'], ARRAY['ZZ'], '[]', '[]', 'v', now() - interval '5 days'),
 ('OBEN', 8004, '000804', 'concluida', 'nenhum', 'fora_de_alcance', ARRAY['nf_concluida'], ARRAY['C11'], '[]', '[]', 'v', now());
SQL

FILA="SET ROLE service_role; SELECT public._prova(\$q\$SELECT string_agg(%s, ';' ORDER BY 1) FROM public.reposicao_po_a_baixar('OBEN') %s\$q\$);"
# shellcheck disable=SC2059  # FILA é o molde de propósito
fila() { Q "$(printf "$FILA" "$1" "$2")"; }

# ── F — po_contado_com_nf ──
ok F1 "1010|5|000111" "$(fila "numero_pedido||'|'||unidades_contadas||'|'||numero_nfe" "WHERE tipo='po_contado_com_nf' AND numero_pedido='1010'")"
ok F2 NULL "$(fila "numero_pedido" "WHERE tipo='po_contado_com_nf' AND numero_pedido='1011'")"
ok F3 NULL "$(fila "numero_pedido" "WHERE tipo='po_contado_com_nf' AND numero_pedido='1013'")"
ok F4 NULL "$(fila "numero_pedido" "WHERE tipo='po_contado_com_nf' AND numero_pedido IN ('1050','1060')")"

# ── S — nf_pendente ──
ok S1 "000801|{1021}|false" "$(fila "numero_nfe||'|'||pedidos_sugeridos::text||'|'||evidencia_desatualizada" "WHERE tipo='nf_pendente' AND numero_nfe='000801'")"
ok S2 NULL "$(fila "numero_nfe" "WHERE tipo='nf_pendente' AND numero_nfe='000802'")"
ok S3 "000803|true" "$(fila "numero_nfe||'|'||evidencia_desatualizada" "WHERE tipo='nf_pendente' AND numero_nfe='000803'")"
ok S4 NULL "$(fila "numero_nfe" "WHERE numero_nfe='000804'")"

# ── E — empresa ──
ok E1 NULL "$(fila "numero_pedido" "WHERE numero_pedido='9910' OR numero_nfe='000999'")"

# ── G — gate ──
ok G1 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-0000000000ff'; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar('OBEN')\$q\$);")"
ok G2 3 "$(Q "SET ROLE authenticated; SET test.uid = 'a0000000-0000-4000-8000-000000000001'; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar('OBEN')\$q\$);")"
ok G3 SQLSTATE:42501 "$(Q "SET ROLE anon; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar('OBEN')\$q\$);")"
ok G4 SQLSTATE:22023 "$(Q "SET ROLE service_role; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar('XPTO')\$q\$);")"

total=$((verdes + vermelhos))
if [ "$total" -ne "$TOTAL_ESPERADO" ]; then echo "ERRO asserts=$total esperado=$TOTAL_ESPERADO"; vermelhos=$((vermelhos + 1)); fi
echo "RESUMO verdes=$verdes vermelhos=$vermelhos"
echo "PASS=$verdes  FAIL=$vermelhos"
[ "$vermelhos" -eq 0 ] && echo "PROVA-PO-A-BAIXAR-OK"
[ "$vermelhos" -eq 0 ]
