#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  Oportunidade: o anti-compra-dupla [SIMETRIA-NORMAL] ve 'disparado_simulado' — prova PG17.   ║
# ║  Migration: 20261001204054_oportunidade_antidup_conta_disparado_simulado.sql                 ║
# ║                                                                                             ║
# ║  bash db/test-oportunidade-antidup-disparado-simulado.sh   (NAO pipe pra tail — engole o rc) ║
# ║  2o locale:  HARNESS_LC=pt_BR.UTF-8 bash db/test-oportunidade-antidup-disparado-simulado.sh  ║
# ║                                                                                             ║
# ║  GRUPOS                                                                                     ║
# ║   M  a base     — a funcao aplicada como CONTROLE e byte a byte a da PROD (md5 conferido)   ║
# ║   B  controle   — versao PROD: o SKU do PO real do dry_run E ofertado (o defeito existe)    ║
# ║   A  conserto   — bloqueia so ele; janela D-7 bloqueia / D-8 libera; empresa isolada        ║
# ║   F  falsificacao — sabota UMA lista por vez (corpo aplicado COM SUCESSO, RPC rc=0) e exige ║
# ║                   o vermelho CERTO, com CONTROLE verde na MESMA sabotagem                   ║
# ║   P  postcondicao — a migration com uma lista so ABORTA (e nao deixa nada aplicado)          ║
# ║   Z  restore    — depois das sabotagens, o corpo real volta e fica verde                    ║
# ║                                                                                             ║
# ║  A falsificacao roda SEMPRE (nao ha modo): controle verde e sabotagem na mesma invocacao.   ║
# ║  Tabelas-stub com os TIPOS da PROD (psql-ro 2026-09-26/10-01); a view v_oportunidade_economica_hoje║
# ║  vira TABELA-fixture (plpgsql resolve o nome em runtime). Triggers de INSERT da PROD         ║
# ║  (outbox de analytics, po_inexistente) ficam fora: nao tocam o NOT EXISTS sob prova.         ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5485}"
SLUG="oport-antidup-simulado"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# A versao da PROD vive DENTRO da 20261001023000 (fuso SP, 1.900 linhas, dezenas de objetos): o
# controle aplica SO o bloco desta funcao, extraido do arquivo, e o M1 prova que e o da PROD.
MIG_PROD="$REPO_ROOT/supabase/migrations/20261001023000_hoje_sp_familia_data_ciclo.sql"
MIG_NOVA="$REPO_ROOT/supabase/migrations/20261001204054_oportunidade_antidup_conta_disparado_simulado.sql"
# md5(pg_get_functiondef) da PROD em 2026-10-01 (psql-ro). Se a PROD mudar, este numero muda —
# e o controle deixa de ser "a versao da PROD": o M1 fica vermelho de proposito.
MD5_PROD="2cae069c6b23cf7f566e58fa425a2084"

[ -f "$MIG_PROD" ] || { echo "INFRA: migration base ausente: $MIG_PROD"; exit 1; }
[ -f "$MIG_NOVA" ] || { echo "INFRA: migration nova ausente: $MIG_NOVA"; exit 1; }

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferencia POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPW="$(mktemp -d "/tmp/${SLUG}-w.XXXXXX")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$TMPW"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
# ── DOIS LOCALES (licao #1483: falsificar num ambiente so nao prova a asercao) ──────────────
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

AMOSTRA_MSG=$("$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ═════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRE-REQUISITOS (so as colunas que a funcao le/escreve; tipos da PROD, psql-ro 2026-09-26)
# ═════════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                        bigserial PRIMARY KEY,
  empresa                   text NOT NULL,
  fornecedor_nome           text,
  grupo_codigo              text,
  data_ciclo                date NOT NULL DEFAULT CURRENT_DATE,
  horario_corte_planejado   timestamptz,
  valor_total               numeric NOT NULL DEFAULT 0,
  num_skus                  integer NOT NULL DEFAULT 0,
  status                    text NOT NULL DEFAULT 'pendente_aprovacao',
  omie_pedido_compra_numero text,
  tipo_ciclo                text NOT NULL DEFAULT 'normal'
    CHECK (tipo_ciclo = ANY (ARRAY['normal','oportunidade_promo','oportunidade_aumento'])),
  origem_evento_id          bigint,
  origem_evento_tipo        text
    CHECK (origem_evento_tipo = ANY (ARRAY['campanha_promocao','aumento_anunciado',NULL])),
  status_envio_portal       text DEFAULT 'nao_aplicavel',
  portal_protocolo          text
);
CREATE TABLE public.pedido_compra_item (
  id                      bigserial PRIMARY KEY,
  pedido_id               bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie         text NOT NULL,
  sku_descricao           text,
  estoque_atual           numeric,
  ponto_pedido            numeric,
  estoque_maximo          numeric,
  qtde_sugerida           numeric NOT NULL,
  qtde_final              numeric,
  preco_unitario          numeric,
  valor_linha             numeric,
  primeira_compra         boolean DEFAULT false,
  modo_promocao           text,
  promocao_item_id        bigint,
  preco_sem_desconto      numeric,
  desconto_perc_aplicado  numeric,
  economia_estimada_valor numeric
);
-- A view vira tabela-fixture: o sku_codigo_omie e BIGINT na PROD (a funcao faz ::text no NOT EXISTS).
CREATE TABLE public.v_oportunidade_economica_hoje (
  empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text, cenario text,
  desconto_total_perc numeric, campanha_id bigint, promo_item_id bigint, aumentos_json jsonb,
  qtde_oportunidade numeric, preco_item_eoq numeric, economia_bruta_estimada numeric
);

-- 6 SKUs do MESMO fornecedor/cenario/campanha (um header so — assim um vazamento no INSERT de
-- itens aparece, em vez de ficar sem pedido onde cair):
--   7001 PO REAL do dry_run  ('disparado_simulado', D-0, com n. Omie)  -> ALVO: tem de bloquear
--   7002 'disparado' D-0                                               -> bloqueado antes e depois
--   7003 nenhum pedido normal                                          -> ofertado sempre
--   7004 'disparado_simulado' em D-8 (fora da janela de 7 dias)        -> ofertado sempre
--   7005 'disparado_simulado' D-0 de OUTRA empresa (COLACOR)           -> ofertado sempre
--   7006 'disparado_simulado' em D-7 (borda de dentro da janela)       -> ALVO: tem de bloquear
INSERT INTO public.v_oportunidade_economica_hoje
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, cenario, desconto_total_perc,
   campanha_id, promo_item_id, aumentos_json, qtde_oportunidade, preco_item_eoq, economia_bruta_estimada)
SELECT 'OBEN', s, 'SKU ' || s, 'FORN-OPP', 'promo_flat', 10, 77, NULL, NULL, 10, 20, 100
FROM unnest(ARRAY[7001,7002,7003,7004,7005,7006]::bigint[]) AS s;

INSERT INTO public.pedido_compra_sugerido
  (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, tipo_ciclo, omie_pedido_compra_numero)
VALUES
  ('OBEN',    'N-7001', CURRENT_DATE,     500, 1, 'disparado_simulado', 'normal', 'OMIE-7001'),
  ('OBEN',    'N-7002', CURRENT_DATE,     500, 1, 'disparado',          'normal', 'OMIE-7002'),
  ('OBEN',    'N-7004', CURRENT_DATE - 8, 500, 1, 'disparado_simulado', 'normal', 'OMIE-7004'),
  ('COLACOR', 'N-7005', CURRENT_DATE,     500, 1, 'disparado_simulado', 'normal', 'OMIE-7005'),
  ('OBEN',    'N-7006', CURRENT_DATE - 7, 500, 1, 'disparado_simulado', 'normal', 'OMIE-7006');

INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
SELECT pcs.id, substr(pcs.fornecedor_nome, 3), 'SKU ' || substr(pcs.fornecedor_nome, 3), 25, 25, 20, 500
FROM public.pedido_compra_sugerido pcs;
SQL

# ─── helper: roda a RPC. Devolve UMA linha "ofertados#rpc_skus#pior_divergencia_por_pedido".
# O rc de CADA chamada e conferido: erro de runtime da funcao (late-bound) vira FALHA, nunca
# "NENHUM ofertado" — que e exatamente o resultado que o conserto espera para o alvo.
RODA() {
  local out rc
  out="$(Pq 2>&1 <<'SQL'
DELETE FROM pedido_compra_sugerido WHERE tipo_ciclo LIKE 'oportunidade_%';
SELECT skus_incluidos AS rpc_skus FROM public.gerar_pedidos_oportunidade_ciclo('OBEN', CURRENT_DATE) \gset
SELECT COALESCE((SELECT string_agg(DISTINCT pci.sku_codigo_omie, ',' ORDER BY pci.sku_codigo_omie)
                   FROM pedido_compra_item pci
                   JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
                  WHERE pcs.tipo_ciclo LIKE 'oportunidade_%'), 'NENHUM')
       || '#' || :'rpc_skus'
       || '#' || COALESCE((SELECT max(abs(pcs.num_skus - (SELECT count(*) FROM pedido_compra_item i WHERE i.pedido_id = pcs.id)))
                             FROM pedido_compra_sugerido pcs WHERE pcs.tipo_ciclo LIKE 'oportunidade_%'), 0);
SQL
)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "RPC_FALHOU rc=$rc: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
    return 1
  fi
  printf '%s\n' "$out" | tail -1
}

# Aplica SO o CREATE OR REPLACE da funcao a partir de um arquivo (sem BEGIN/post/COMMIT), com rc.
APLICA_CORPO() {
  local arq="$1" rc=0
  P -q -f "$arq" >"$TMPW/aplica.log" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || { echo "   (psql rc=$rc: $(head -c 300 "$TMPW/aplica.log" | tr '\n' ' '))"; }
  return "$rc"
}

# Extrai o corpo (CREATE ... $function$;) da migration nova e, se pedido, tira 'disparado_simulado'
# da lista N (1 = CTE do header, 2 = INSERT de itens). Aborta se nao achar EXATAMENTE 2 listas.
CORPO() {
  python3 - "$MIG_NOVA" "$1" "$2" <<'PY'
import sys
src, n, dst = sys.argv[1], int(sys.argv[2]), sys.argv[3]
t = open(src).read()
ini = t.index("CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(")
fim = t.index("$function$;", ini) + len("$function$;")
t = t[ini:fim]
alvo = "'disparado','disparado_simulado','concluido_recebido')"
pos, i = [], t.find(alvo)
while i >= 0:
    pos.append(i); i = t.find(alvo, i + 1)
assert len(pos) == 2, f"esperava 2 listas, achei {len(pos)} — sabotagem abortada"
if n in (1, 2):
    p = pos[n - 1]
    t = t[:p] + "'disparado','concluido_recebido')" + t[p + len(alvo):]
open(dst, "w").write(t + "\n")
PY
}

N_SIMULADO_VIVO() {
  Pq -c "SELECT (length(d) - length(replace(d, 'disparado_simulado', ''))) / length('disparado_simulado')
           FROM (SELECT pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo'::regproc) d) x;"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# GRUPO M + B — CONTROLE: a versao da PROD, com o defeito visivel
# ═════════════════════════════════════════════════════════════════════════════════════════════
echo "-> aplica o bloco da funcao da 20261001023000 (a versao que a PROD roda)..."
python3 - "$MIG_PROD" "$TMPW/prod.sql" <<'PY'
import sys
t = open(sys.argv[1]).read()
abre = "CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo("
assert t.count(abre) == 1, f"esperava 1 bloco da funcao, achei {t.count(abre)}"
i = t.index(abre); f = t.index("$function$;", i) + len("$function$;")
open(sys.argv[2], "w").write(t[i:f] + "\n")
PY
APLICA_CORPO "$TMPW/prod.sql" || { echo "INFRA: o bloco da PROD nao aplicou"; exit 1; }
eq "M1 CONTROLE e a PROD: md5(pg_get_functiondef) local == md5 medido na PROD" \
  "$(Pq -c "SELECT md5(pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo'::regproc));")" "$MD5_PROD"

B="$(RODA)" || { bad "B0 a RPC (versao PROD) falhou ao EXECUTAR: $B"; B="ERRO#ERRO#ERRO"; }
eq "B1 CONTROLE: na versao PROD o SKU do PO real do dry_run (7001, D-0) e o de D-7 (7006) SAO ofertados — o defeito existe" \
  "${B%%#*}" "7001,7003,7004,7005,7006"
case ",${B%%#*}," in
  *,7002,*) bad "B2 CONTROLE: 'disparado' deveria bloquear ja na versao PROD (veio ${B%%#*})" ;;
  *)        ok  "B2 CONTROLE: 'disparado' ja bloqueava na versao PROD — a lista funciona, so era cega ao simulado" ;;
esac

# ═════════════════════════════════════════════════════════════════════════════════════════════
# GRUPO A — CONSERTO
# ═════════════════════════════════════════════════════════════════════════════════════════════
echo "-> aplica a migration nova (com BEGIN/COMMIT + postcondicao)..."
rc=0; P -q -f "$MIG_NOVA" >"$TMPW/nova.log" 2>&1 || rc=$?
eq "A0 a migration nova aplica limpa (postcondicao passou)" "$rc" "0"
[ "$rc" -eq 0 ] || head -c 600 "$TMPW/nova.log"
MD5_NOVA="$(Pq -c "SELECT md5(pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo'::regproc));")"

A="$(RODA)" || { bad "A0b a RPC (versao nova) falhou ao EXECUTAR: $A"; A="ERRO#ERRO#ERRO"; }
eq "A1 conserto: 7001 (D-0) e 7006 (D-7) BLOQUEADOS; 7003 (sem pedido), 7004 (D-8) e 7005 (COLACOR) seguem ofertados" \
  "${A%%#*}" "7003,7004,7005"
eq "A2 header x itens coerentes POR PEDIDO (maior |num_skus - itens|)" "${A##*#}" "0"
A_RPC="${A#*#}"; A_RPC="${A_RPC%%#*}"
eq "A3 o retorno da RPC (skus_incluidos) bate com os itens gravados" "$A_RPC" "3"
A5="$(RODA)" || A5="ERRO#ERRO#ERRO"
eq "A4 re-rodar e idempotente (mesmo resultado)" "$A5" "$A"

# ═════════════════════════════════════════════════════════════════════════════════════════════
# GRUPO F — FALSIFICACAO. Uma lista por vez; o corpo sabotado tem de APLICAR com rc=0 e a RPC
#   tem de RODAR com rc=0 (rejeicao pelo $post$ nao e falsificacao comportamental — Codex P1).
#   E a sabotagem tem de ser CIRURGICA: o CONTROLE da mesma rodada (7002, 7003) nao muda.
# ═════════════════════════════════════════════════════════════════════════════════════════════
SABOTAGENS_VERMELHAS=0
for LISTA in 1 2; do
  NOME=$([ "$LISTA" = 1 ] && echo "CTE do header" || echo "INSERT de itens")
  CORPO "$LISTA" "$TMPW/sab$LISTA.sql"
  if ! APLICA_CORPO "$TMPW/sab$LISTA.sql"; then
    bad "F$LISTA a sabotagem ($NOME) NAO aplicou — sem ela a falsificacao seria teatro"; continue
  fi
  eq "F${LISTA}a a sabotagem pegou: 'disparado_simulado' vivo so 1x no corpo (+2 nos comentarios)" "$(N_SIMULADO_VIVO)" "3"
  S="$(RODA)" || { bad "F$LISTA a RPC sabotada falhou ao EXECUTAR (queria rc=0 e assert vermelho): $S"; continue; }
  OFS="${S%%#*}"; DIV="${S##*#}"
  if [ "$LISTA" = 1 ]; then
    # Header sem o status: 7001/7006 contam no num_skus, mas o INSERT de itens (intacto) os barra.
    if [ "$DIV" != "0" ]; then ok "F1 sabotando a lista do HEADER, o A2 fica vermelho (divergencia=$DIV)"; SABOTAGENS_VERMELHAS=$((SABOTAGENS_VERMELHAS+1))
    else bad "F1 sabotei a lista do header e header x itens seguiu coerente — o A2 nao mede o header"; fi
  else
    # Itens sem o status: o header existe (7003..7005), entao 7001/7006 VAZAM como item.
    case ",$OFS," in
      *,7001,*) ok "F2 sabotando a lista dos ITENS, o A1 fica vermelho (vazou: $OFS)"; SABOTAGENS_VERMELHAS=$((SABOTAGENS_VERMELHAS+1)) ;;
      *)        bad "F2 sabotei a lista dos itens e o 7001 nao vazou ($OFS) — o A1 nao mede o INSERT" ;;
    esac
  fi
  case ",$OFS," in
    *,7002,*) bad "F${LISTA}b a sabotagem nao foi cirurgica: 'disparado' deixou de bloquear ($OFS)" ;;
    *,7003,*) ok  "F${LISTA}b CONTROLE na MESMA sabotagem: 7002 segue bloqueado e 7003 segue ofertado" ;;
    *)        bad "F${LISTA}b a sabotagem derrubou tudo: nem o 7003 livre foi ofertado ($OFS)" ;;
  esac
done

# ═════════════════════════════════════════════════════════════════════════════════════════════
# GRUPO P — a POSTCONDICAO morde: a migration com UMA lista so aborta e NAO deixa nada aplicado.
#   Parte do corpo verdadeiro (restaurado antes) para provar o rollback pelo md5.
# ═════════════════════════════════════════════════════════════════════════════════════════════
CORPO 0 "$TMPW/verdadeiro.sql"
APLICA_CORPO "$TMPW/verdadeiro.sql" || bad "P0 restaurar o corpo verdadeiro falhou"
python3 - "$MIG_NOVA" "$TMPW/mig-uma-lista.sql" <<'PY'
import sys
t = open(sys.argv[1]).read()
alvo = "'disparado','disparado_simulado','concluido_recebido')"
assert t.count(alvo) == 2, "esperava 2 listas — sabotagem abortada"
open(sys.argv[2], "w").write(t.replace(alvo, "'disparado','concluido_recebido')", 1))
PY
rc=0; P -q -f "$TMPW/mig-uma-lista.sql" >"$TMPW/post.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "POSTCONDICAO FALHOU: disparado_simulado em 1 lista" "$TMPW/post.log"; then
  ok "P1 migration com uma lista so ABORTA pela postcondicao (rc=$rc, motivo certo)"
else
  bad "P1 esperava abort da postcondicao por '1 lista'; rc=$rc, log: $(head -c 300 "$TMPW/post.log" | tr '\n' ' ')"
fi
eq "P2 o abort fez ROLLBACK: o corpo vivo segue o verdadeiro (md5)" \
  "$(Pq -c "SELECT md5(pg_get_functiondef('public.gerar_pedidos_oportunidade_ciclo'::regproc));")" "$MD5_NOVA"

# ═════════════════════════════════════════════════════════════════════════════════════════════
# GRUPO Z — restore: re-aplica a migration verdadeira inteira e exige o verde de novo.
# ═════════════════════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG_NOVA" >/dev/null
Z="$(RODA)" || Z="ERRO#ERRO#ERRO"
eq "Z1 restaurada, a versao verdadeira volta ao verde" "$Z" "$A"

echo
echo "PASS=$PASS FAIL=$FAIL   (lc_messages=$HARNESS_LC, sabotagens vermelhas=$SABOTAGENS_VERMELHAS/2)"
[ "$FAIL" -eq 0 ] && [ "$SABOTAGENS_VERMELHAS" -eq 2 ]
