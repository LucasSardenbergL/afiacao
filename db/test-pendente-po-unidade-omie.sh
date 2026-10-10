#!/usr/bin/env bash
# REGRESSÃO — o "a caminho" do PO entra na unidade do ESTOQUE do Omie (omie-sync-estoque v1.9, adversarial Codex
# do #2849/#2889).
#
# Nos concentrados WP o estoque, o ponto e o máximo estão em LITROS; o PO, em EMBALAGENS (QT 0,81 L · GL 3,24 L).
# Dentro da janela de 7 dias a linha do app conta no em_transito do motor, × conv (migration 20261009194000), e a
# edge a de-duplica (dedup_app, contribuição 0). Fora da janela o MESMO PO passa a contar pela edge, em
# sku_estoque_atual.estoque_pendente_entrada — e cru ele valia 2 onde eram 6,48 L.
#
# A prova atravessa as camadas como a produção: o banco (PG17, snapshot da prod + a migration REAL do motor)
# dá as linhas de sku_embalagem_equivalencia e o em_transito; o código REAL da edge (unidade-omie.ts +
# observacao-po.ts, via deno --no-remote) calcula o pendente e a observação; o pendente é gravado; o MOTOR roda.
#   T0 — PO do app DENTRO da janela: a edge não conta (dedup_app) e o motor vê 2 QT + 1 GL = 4,86 L em trânsito.
#   T1 — o MESMO PO FORA da janela: a edge grava 1,62 + 3,24 e o motor sai IDÊNTICO ao T0 (a passagem é neutra).
#   T2 — o defeito: o pendente CRU (2 + 1) no lugar do convertido muda a compra (7 QT → 9 QT).
#   U1 — o que a edge grava fora da janela, por SKU (1,62 / 3,24); U0 — dentro da janela, nada.
#   W1 — a 2ª testemunha da RPC reposicao_po_observado_publicar aceita a observação (contribuição em litros).
#   T3 — PO MANUAL no Omie (sem o carimbo AFI-), digitado em LITROS (founder): entra CRU e o motor sai idêntico ao T0.
#   X1 — CONTROLE byte a byte: grupo sem cadastro, parcial, incoerente e fora da guarda gravam o PO CRU (a conta de antes).
#
# Rodar:   bash db/test-pendente-po-unidade-omie.sh > log 2>&1; echo $?
#          bash db/test-pendente-po-unidade-omie.sh --falsificar > log 2>&1; echo $?
# matriz:  HARNESS_LC=C | HARNESS_LC=pt_BR.UTF-8 (lc_messages do servidor; os asserts casam marca ASCII)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5681}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="pendente-po-unidade-omie"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261009194000_motor_unidades_concentrado_wp.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
EDGE_SRC="$REPO_ROOT/supabase/functions/omie-sync-estoque"
# Denominador: M0 · U0,U1,U3 · T0,T1,T2,T3 · W1 · X1.
TOTAL_ESPERADO=10

# ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: o controle roda PRIMEIRO, na mesma invocação (suíte que já falha sozinha aprovaria todas as
# sabotagens). Cada sabotagem adultera UMA linha de uma CÓPIA da edge e declara os asserts que TÊM de ficar
# vermelhos por RESULTADO e os que TÊM de continuar verdes. Formato: <sabotagem>:<vermelhos>[:<verdes>]
# ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="pendente_cru:U1,T1:U0,T0,X1
              origem_ignorada:U3,T3:U1,T1
              contribuicao_crua:W1:U1,T1
              sem_guarda_1e9:X1:U1,T1
              sem_coerencia:X1:U1,T1"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (edge real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    n="$(grep -c ' OK — ' "$LOGDIR/controle.log" || true)"
    if [ "$n" != "$TOTAL_ESPERADO" ]; then
      echo "  ❌ controle verde com $n asserts (esperado $TOTAL_ESPERADO) — abortando"; exit 1
    fi
    echo "  ✅ controle VERDE ($n asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""
    for x in ${verm//,/ }; do
      grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x"
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    intrusos="$(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "${intrusos// /}" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "${intrusos// /}" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO em: ${intrusos} — vermelho que não é do assert não mata mutante"
                                     grep 'ERRO_DE_EXECUCAO' "$log" | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi

SABOTAGEM="${SABOTAGEM:-}"
command -v deno >/dev/null || { echo "INFRA: deno ausente (a prova executa o código da edge)"; exit 1; }

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# ── a EDGE: cópia dos 2 módulos puros (a sabotagem adultera a cópia, nunca o repo) ─────────────────────────
EDGE="$TMPD/edge"
mkdir -p "$EDGE"
cp "$EDGE_SRC/unidade-omie.ts" "$EDGE_SRC/observacao-po.ts" "$EDGE/"
troca() {   # <arquivo> <de> <para> — exatamente 1 ocorrência, senão a sabotagem não aplica
  python3 - "$EDGE/$1" "$2" "$3" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrão ocorre %dx: %r" % (s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "$SABOTAGEM" in
  "") ;;
  pendente_cru)      troca unidade-omie.ts "  if (conv === undefined) return { qtde, recebido };" "  return { qtde, recebido };" ;;
  origem_ignorada)   troca unidade-omie.ts "return cCodIntPed.trim().startsWith(PREFIXO_PO_DO_APP) ?" "return true ?" ;;
  contribuicao_crua) troca observacao-po.ts "contribuicao: saldoEmUnidadeOmie(Math.max(0, qtde - recebido), conv?.(skuTexto))" \
                                            "contribuicao: Math.max(0, qtde - recebido)" ;;
  sem_guarda_1e9)    troca unidade-omie.ts "m.u !== null && m.u.n > 0n && paraNumero(m.u) < 1e9" "m.u !== null && m.u.n > 0n" ;;
  sem_coerencia)     troca unidade-omie.ts "    if (!membros.every((m) => mesmaRazao(" "    if (membros.every((m) => !mesmaRazao(" ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# O driver: o que computePendenteViaPedidosCompra faz com cada PO, com as funções REAIS da edge. Entrada (stdin):
# { equiv: linhas de sku_embalagem_equivalencia como o PostgREST as devolve, emTransito: [cNumero], pedidos: [...] }.
# Saída: { pendente: {sku: valor}, observacao: [linhas], problemas: [...] }.
cat > "$EDGE/driver.ts" <<'TS'
import { convDaOrigem, convPendentePorSku, quantidadesEmUnidadeOmie } from "./unidade-omie.ts";
import { criarColetorObservacao } from "./observacao-po.ts";

const entrada = JSON.parse(await new Response(Deno.stdin.readable).text());
const { conv, problemas } = convPendentePorSku(entrada.equiv);
const emTransito = new Set<string>(entrada.emTransito);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const coletor = criarColetorObservacao(() => true, { parseQtd: num, parseRecebido: (v) => (v === undefined ? 0 : num(v)) });
const pendente: Record<string, number> = {};
for (const ped of entrada.pedidos) {
  const cab = { nCodPed: ped.nCodPed, cNumero: ped.cNumero, cEtapa: "15" };
  const convDoPo = convDaOrigem(ped.cCodIntPed, conv);
  if (emTransito.has(ped.cNumero)) { coletor.registrar(cab, ped.itens, "dedup_app"); continue; }
  for (const it of ped.itens) {
    const sku = String(it.nCodProd);
    const q = quantidadesEmUnidadeOmie(it.nQtde, it.nQtdeRec ?? 0, convDoPo(sku));
    const saldo = Math.max(0, q.qtde - q.recebido);
    if (saldo > 0) pendente[sku] = (pendente[sku] ?? 0) + saldo;
  }
  coletor.registrar(cab, ped.itens, null, convDoPo);
}
console.log(JSON.stringify({ pendente, observacao: coletor.linhas, problemas, integra: coletor.integra }));
TS

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
Exec() { Pq -c "$1" 2>&1 || true; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
invalido() { case "$1" in ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*|*error:*) return 0 ;; *) return 1 ;; esac; }
eq() {
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}
iguais() {   # <id> <descrição> <v1> <v2>
  if invalido "$3" || invalido "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=${3:0:90})"; else bad "$1" "$2 — dentro [$3] ≠ fora [$4]"; fi
}

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ── ZONA 1 — schema da prod (snapshot) + a migration REAL do motor (ainda fora do snapshot) ─────────────────
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
P -q <<'SQL'
GRANT EXECUTE ON FUNCTION public.gerar_pedidos_sugeridos_ciclo(text, date) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) TO authenticated, service_role;
SET session_replication_role = replica;
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido)
  VALUES ('OBEN', 'Sayerlack', interval '10:00');
SQL
if P --single-transaction -q -f "$MIG" >/dev/null 2>"$TMPD/mig.err"; then m0=APLICOU; else m0="ERRO: $(tail -2 "$TMPD/mig.err" | tr '\n' ' ')"; fi
eq M0 "a migration do motor (20261009194000) aplica sobre o snapshot" "$m0" APLICOU

# ── ZONA 2 — sementes: o grupo WP do cenário C do #2849 + 3 grupos de CONTROLE (u ausente/parcial/incoerente) ─
P -q <<'SQL'
CREATE FUNCTION public.t_grupo(p_qt bigint, p_gl bigint, p_cor text, p_pp numeric, p_max numeric, p_fisico numeric,
  p_u_qt numeric, p_u_gl numeric) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_g uuid := md5(p_cor)::uuid;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade) VALUES
    (p_qt, 'oben', 'C' || p_qt, p_cor || 'QT CONCENTRADO', 'Concentrados', true, '00', 'L'),
    (p_gl, 'oben', 'C' || p_gl, p_cor || 'GL CONCENTRADO', 'Concentrados', true, '00', 'L');
  INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
      habilitado_reposicao_automatica, tipo_reposicao)
    VALUES ('OBEN', p_qt, p_cor || 'QT CONCENTRADO', 'Sayerlack', p_pp, p_max, true, 'automatica');
  INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
    VALUES ('OBEN', p_qt::text, p_fisico, 0), ('OBEN', p_gl::text, 0, 0);
  INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
    VALUES (p_qt, 'vendas', p_fisico, 101.08, now()), (p_gl, 'vendas', 0, 101.08, now());
  INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', p_qt::text, true), ('OBEN', p_gl::text, true);
  INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em, fonte)
    VALUES ('oben', p_qt::text, 80, 'ok', now(), 'manual_usuario'), ('oben', p_gl::text, 330, 'ok', now(), 'manual_usuario');
  INSERT INTO sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, ativo, fator_conversao)
    VALUES ('OBEN', 'Sayerlack', p_qt::text, 'P' || p_qt, true, 1), ('OBEN', 'Sayerlack', p_gl::text, 'P' || p_gl, true, 1);
  INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base,
      fornecedor_nome, ativo, criado_por, unidades_omie_por_embalagem)
    VALUES ('oben', v_g, p_qt::text, 'QT', 1, 'Sayerlack', true, 'teste', p_u_qt),
           ('oben', v_g, p_gl::text, 'QT', 4, 'Sayerlack', true, 'teste', p_u_gl);
END $f$;
SQL
#                                qt          gl          cor      pp max fis  u_qt  u_gl
P -q -c "SELECT public.t_grupo(9300000001, 9300000002, 'WP93.01', 9, 12, 2,   0.81, 3.24)" \
     -c "SELECT public.t_grupo(9500000001, 9500000002, 'CTL95',   9, 12, 2,   NULL, NULL)" \
     -c "SELECT public.t_grupo(9600000001, 9600000002, 'PAR96',   9, 12, 2,   0.81, NULL)" \
     -c "SELECT public.t_grupo(9700000001, 9700000002, 'INC97',   9, 12, 2,   0.81, 4)" \
     -c "SELECT public.t_grupo(9800000001, 9800000002, 'BIG98',   9, 12, 2,   5e8,  2e9)" >/dev/null
# BIG98 é COERENTE (2e9/4 = 5e8) com um membro fora da guarda de finitude (u < 1e9): só a validade o barra — sem ele a
# exigência de 'todos válidos' seria mascarada pela coerência (u NULL já quebra a razão).
# O PO do app: 2 QT + 1 GL no WP93 (o cenário C do #2849) e o mesmo nos controles, no Omie como nº 4242.
P -q <<'SQL'
SET session_replication_role = replica;
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, tipo_ciclo, omie_pedido_compra_numero, valor_total)
  VALUES (990001, 'OBEN', 'Sayerlack', DATE '2026-10-08', 'disparado', 'normal', '4242', 0);
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final) VALUES
  (990001, '9300000001', 2, 2), (990001, '9300000002', 1, 1),
  (990001, '9500000001', 2, 2), (990001, '9500000002', 1, 1),
  (990001, '9600000001', 2, 2), (990001, '9600000002', 1, 1),
  (990001, '9700000001', 2, 2), (990001, '9700000002', 1, 1),
  (990001, '9800000001', 2, 2), (990001, '9800000002', 1, 1);
-- O lado OMIE (PesquisarPedCompra): o PO do app leva o carimbo AFI-<id> do disparo e as quantidades em embalagens.
CREATE TABLE t_po_omie (ncodped bigint, cnumero text, ccodintped text, seq int, sku text, nqtde numeric);
INSERT INTO t_po_omie SELECT 4242000001, '4242', 'AFI-990001', row_number() OVER (ORDER BY sku_codigo_omie),
                             sku_codigo_omie, qtde_final FROM pedido_compra_item WHERE pedido_id = 990001;
SQL

# ── a EDGE executada: as linhas de equivalência e o em_transito vêm do BANCO, no recorte da edge ─────────────
# (fetchEmTransitoKeys: OBEN, os 4 status, data_ciclo >= hoje − 7 — aqui o "hoje" é o data_ciclo do motor).
ENTRADA_SQL="SELECT json_build_object(
  'equiv', (SELECT json_agg(json_build_object('grupo_id', grupo_id, 'sku_codigo_omie', sku_codigo_omie,
              'fator_para_base', fator_para_base, 'unidades_omie_por_embalagem', unidades_omie_por_embalagem))
            FROM sku_embalagem_equivalencia WHERE empresa = 'oben' AND ativo AND fator_para_base > 0),
  'emTransito', (SELECT coalesce(json_agg(omie_pedido_compra_numero), '[]') FROM pedido_compra_sugerido
                 WHERE empresa = 'OBEN' AND omie_pedido_compra_numero IS NOT NULL
                   AND status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')
                   AND data_ciclo >= DATE '2026-10-09' - 7),
  'pedidos', (SELECT coalesce(json_agg(json_build_object('nCodPed', ncodped, 'cNumero', cnumero,
                 'cCodIntPed', ccodintped, 'itens', itens) ORDER BY ncodped), '[]')
              FROM (SELECT ncodped, cnumero, ccodintped,
                           json_agg(json_build_object('nCodItem', seq, 'nCodProd', sku::bigint, 'nQtde', nqtde) ORDER BY seq) AS itens
                      FROM t_po_omie GROUP BY ncodped, cnumero, ccodintped) po))"
edge() {   # roda a edge sobre o estado atual do banco → JSON de saída em $TMPD/edge.json
  Pq -c "$ENTRADA_SQL" > "$TMPD/entrada.json"
  deno run --no-remote --no-prompt --quiet "$EDGE/driver.ts" < "$TMPD/entrada.json" > "$TMPD/edge.json" 2>"$TMPD/edge.err" \
    || { echo "error: deno: $(head -c 300 "$TMPD/edge.err")" > "$TMPD/edge.json"; }
}
jcampo() { python3 -c 'import json,sys
try:
  d = json.load(open(sys.argv[1]))
except Exception as e:
  print("error: " + str(e)); sys.exit(0)
print(eval(sys.argv[2], {"d": d}))' "$TMPD/edge.json" "$1"; }
# Grava o pendente que a edge calculou (o upsert do par: SKU sem PO aberto = 0).
gravar_pendente() {
  python3 - "$TMPD/edge.json" > "$TMPD/grava.sql" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("UPDATE sku_estoque_atual SET estoque_pendente_entrada = 0 WHERE empresa = 'OBEN';")
for sku, v in d["pendente"].items():
    print("UPDATE sku_estoque_atual SET estoque_pendente_entrada = %r WHERE empresa = 'OBEN' AND sku_codigo_omie = '%s';" % (v, sku))
PY
  P -q -f "$TMPD/grava.sql" >/dev/null
}
# O motor numa transação que VOLTA ATRÁS; a linha do WP93: sku|sugerida|final|preco|valor|fisico|a_caminho|sem_teto.
motor() {
  Pq -q -c "BEGIN" \
     -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', DATE '2026-10-09')" \
     -c "SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', i.sku_codigo_omie, trim_scale(i.qtde_sugerida),
                trim_scale(i.qtde_final), trim_scale(i.preco_unitario), trim_scale(i.valor_linha), trim_scale(i.estoque_fisico),
                trim_scale(i.estoque_a_caminho), trim_scale(i.qtde_sem_teto)), ';' ORDER BY i.sku_codigo_omie)
           FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id
          WHERE p.data_ciclo = DATE '2026-10-09' AND p.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
            AND i.sku_codigo_omie IN ('9300000001','9300000002')" \
     -c "ROLLBACK" 2>&1 || true
}
PEND_WP="'%s|%s' % (d['pendente'].get('9300000001', 0), d['pendente'].get('9300000002', 0))"
PEND_CTL="';'.join('%s=%s' % (k, d['pendente'].get(k, 0)) for k in ['9500000001','9500000002','9600000001','9600000002','9700000001','9700000002','9800000001','9800000002'])"

echo "── T0: o PO 4242 DENTRO da janela (data_ciclo 08/10, ciclo 09/10)"
edge; gravar_pendente
eq U0 "a edge não conta o PO do app (dedup_app): pendente WP 0|0" "$(jcampo "$PEND_WP")" "0|0"
dentro="$(motor)"
eq T0 "o motor vê 2×0,81 + 1×3,24 = 4,86 L em trânsito → 7 QT (o C1 do #2849)" "$dentro" \
  "9300000001|7|7|81.8748|573.1236|2|4.86|7"

echo "── T1: o MESMO PO FORA da janela (data_ciclo 25/09) — agora quem conta é a edge"
P -q -c "UPDATE pedido_compra_sugerido SET data_ciclo = DATE '2026-09-25' WHERE id = 990001"
edge; gravar_pendente
eq U1 "a edge grava 2 QT = 1,62 L e 1 GL = 3,24 L" "$(jcampo "$PEND_WP")" "1.62|3.24"
controles="$(jcampo "$PEND_CTL")"   # os controles saem desta MESMA execução (o T3 tira o PO do app do Omie)
fora="$(motor)"
iguais T1 "a passagem app→PO é NEUTRA: o motor sai idêntico ao T0" "$dentro" "$fora"

echo "── W1: a 2ª testemunha da RPC (pendente gravado = Σ contribuição da observação)"
python3 - "$TMPD/edge.json" > "$TMPD/obs.sql" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
itens = json.dumps(d["observacao"]).replace("'", "''")
print("SELECT public.reposicao_po_observado_publicar(jsonb_build_object('run_id', gen_random_uuid(), 'empresa', 'OBEN',"
      " 'iniciado_em', now(), 'concluido_em', now(), 'janela_de', DATE '2025-10-09', 'janela_ate', DATE '2027-02-06',"
      " 'filtros', '{}'::jsonb, 'varredura_completa', true, 'pendente_aplicado', true, 'pedidos_lidos', 1,"
      " 'versao_edge', 'teste'), '%s'::jsonb);" % itens)
print("SELECT pendente_aplicado || '|' || skus_divergentes FROM reposicao_po_observado_run;")
PY
eq W1 "a RPC aceita a observação como pendente aplicado, 0 SKU divergente" \
  "$(Pq -q -f "$TMPD/obs.sql" 2>&1 | tail -1 || true)" "true|0"

echo "── T2: o DEFEITO que este conserto fecha — o pendente CRU fora da janela"
P -q -c "UPDATE sku_estoque_atual SET estoque_pendente_entrada = CASE sku_codigo_omie WHEN '9300000001' THEN 2 ELSE 1 END
          WHERE empresa = 'OBEN' AND sku_codigo_omie IN ('9300000001','9300000002')"
eq T2 "cru: a caminho 3 'L' → efetivo 5 → ceil(7/0,81) = 9 QT (compra 2 QT a mais)" "$(motor)" \
  "9300000001|9|9|81.8748|736.8732|2|3|9"

echo "── T3: PO MANUAL (sem carimbo AFI-), digitado em LITROS — o do app já chegou e saiu do Omie"
P -q -c "DELETE FROM t_po_omie" \
     -c "INSERT INTO t_po_omie VALUES (4243000001, '4243', '', 1, '9300000001', 4.86)"
edge; gravar_pendente
eq U3 "a edge grava os 4,86 L CRUS (o PO manual já está na unidade do estoque)" "$(jcampo "$PEND_WP")" "4.86|0"
iguais T3 "4,86 L lançados à mão = 2 QT + 1 GL do app: o motor sai idêntico ao T0" "$dentro" "$(motor)"

echo "── X1: CONTROLE byte a byte — grupo sem cadastro, parcial e incoerente: o PO entra CRU, como antes"
eq X1 "CTL95 / PAR96 / INC97 / BIG98: 2 QT e 1 GL gravados como 2 e 1" "$controles" \
  "9500000001=2;9500000002=1;9600000001=2;9600000002=1;9700000001=2;9700000002=1;9800000001=2;9800000002=1"

echo "═══ $PASS OK / $FAIL falhas (denominador $TOTAL_ESPERADO) ═══"
[ "$FAIL" -eq 0 ] && [ "$PASS" -eq "$TOTAL_ESPERADO" ] || exit 1
echo "PROVA-PENDENTE-PO-UNIDADE-OK"
