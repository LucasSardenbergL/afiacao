#!/usr/bin/env bash
# REGRESSÃO — o motor de reposição converte UNIDADES nos concentrados WP (#2849,
# supabase/migrations/20261009194000_motor_unidades_concentrado_wp.sql).
#
# O estoque, o ponto e o máximo dos 28 WP estão em LITROS no Omie; a compra (qtde_final), o em trânsito e o PO,
# em EMBALAGENS (QT = 0,81 L, GL = 3,24 L). O motor antigo lia litro como QT, o galão como 4 QT, somava o em
# trânsito cru e cobrava cmc (R$/L) por embalagem. A migration põe sku_embalagem_equivalencia.
# unidades_omie_por_embalagem e o motor usa conv = essa coluna quando o grupo INTEIRO a tem e coerente com o
# fator; senão o fator relativo (a conta de antes).
#
# O que se prova, com o motor EXECUTADO (PG17, schema da prod pelo snapshot):
#   A — quartinho: físico 3,2 L, pp 5, máx 8 → 6 QT (ceil(4,8/0,81)), preço cmc × 0,81. A0: o antigo dava 5 a cmc.
#   B — troca p/ galão: necessidade 7 L → 3 GL (ceil(7/3,24)). B0: o antigo dava 2 (÷4).
#   C — em trânsito: 2 QT + 1 GL = 4,86 L no efetivo → compra 4 QT. C0: o antigo via 6 L e não comprava.
#   F — minimo_forcado_manual (em L) ÷ 0,81: 8 L → 10 QT. F0: o antigo dava 8.
#   D — CONTROLE: grupo SEM cadastro (D1), PARCIAL (D2) e INCOERENTE (D3) saem byte-idênticos ao motor antigo.
#   E — SKU sem grupo: idêntico ao antigo (E1) e o valor esperado (E2). X1: tudo fora dos WP cadastrados idêntico.
#   K — o cadastro WP grava 0,81/3,24 numa cor nova em LITROS (K1), NULL numa cor em UN (K2), não reescreve par WP elegível já cadastrado (K3).
#   P01-P02: os predecessores do snapshot batem o md5 da prod (o ensaio do predicado da PRÉ).
#   M0-M2: a migration aplica, instala ESTES corpos e preenche os membros WP.
#   G1-G8: a PRÉ e a PÓS recusam o que devem (numa transação que volta atrás).
# A TRAVA segue o template "Recriar objeto VIVO", provado em db/test-pre-anti-deriva-concorrencia.sh.
#
# Rodar:   bash db/test-motor-unidades-concentrado.sh > log 2>&1; echo $?
#          bash db/test-motor-unidades-concentrado.sh --falsificar > log 2>&1; echo $?
# matriz:  HARNESS_LC=C | HARNESS_LC=pt_BR.UTF-8 (lc_messages do servidor; os asserts casam marca ASCII)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5661}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="motor-unidades-concentrado"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261009194000_motor_unidades_concentrado_wp.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
MD5_MOTOR_PRED=7a15485d16c2a88c2de88cc80f87756b
MD5_CAD_PRED=141a28f4f696a985e2172de2aa18d1e9
MD5_MOTOR=d3f55f2621c27a234925821e06f73dd7
MD5_CAD=f201f94a74b9371478653ddcb825b86a
# Denominador: P01-P02 · M0-M2 · G1-G8 · A0,A1 · B0,B1 · C0,C1 · F0,F1 · D1-D3 · E1,E2 · X1 · K1-K3.
TOTAL_ESPERADO=30

# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE. O controle roda PRIMEIRO, na mesma invocação: uma
# suíte que já falha sozinha aprovaria todas as sabotagens. Cada sabotagem declara os asserts que TÊM de
# ficar vermelhos por RESULTADO e os que TÊM de continuar verdes. Vermelho por erro de execução não mata
# mutante. Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="transito_pelo_fator:C1:A1,B1
              quartinho_sem_conv:A1,C1:B1,F1
              galao_pelo_fator:B1:A1
              preco_sem_conv:A1:B1
              minimo_sem_conv:F1:A1
              grupo_parcial_vale:D2:A1,D1
              sem_coerencia:D3:A1,D2
              sem_grupo_divide:E1,E2,X1:A1
              cadastro_sem_litros:K2:K1
              cadastro_sem_coluna:K1:K2
              sugerida_em_litros:A1,B1,C1,F1:E2
              cadastro_sobrescreve:K3:K1,K2
              pre_removida:G1,G2:G3
              pos_removida:G4,G5,G6,G7,G8:G3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
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

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
invalido() { case "$1" in ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*) return 0 ;; *) return 1 ;; esac; }
# Um VALOR que é erro (psql) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de falsificação
# não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}
iguais() {   # <id> <descrição> <v1> <v2>
  if invalido "$3" || invalido "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=${3:0:80})"; else bad "$1" "$2 — antigo [$3] ≠ novo [$4]"; fi
}
# Roda um arquivo SQL numa transação que VOLTA ATRÁS, como função: 'PASSOU' se não levantou nada;
# 'NEGOU' se levantou a SQLSTATE e a marca ESPERADAS; qualquer outro erro sai como ERRO (o `eq` o lê como
# execução, não como dente). É o que põe a PRÉ e a PÓS da migration à prova sem deixar rastro no banco.
# shellcheck disable=SC2016  # $f$ e $tenta$ são dollar-quotes do SQL gerado, não expansão do shell
Tenta() {   # <arquivo com o SQL> <sqlstate> <marca>
  local f="$TMPD/tenta.$RANDOM.sql"
  {
    printf 'BEGIN;\n'
    printf 'CREATE FUNCTION pg_temp.tenta(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS $f$\n'
    printf 'BEGIN\n  EXECUTE p_sql;\n  RETURN %s;\nEXCEPTION WHEN OTHERS THEN\n' "'PASSOU'"
    printf '  IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN %s; END IF;\n  RAISE;\nEND $f$;\n' "'NEGOU'"
    printf 'SELECT pg_temp.tenta($tenta$'
    cat "$1"
    printf '$tenta$, %s, %s);\nROLLBACK;\n' "'$2'" "'$3'"
  } > "$f"
  PGOPTIONS="-c client_min_messages=warning" Pq -q -f "$f" 2>&1 || true
}

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única). O ACL de PROD nas 2 funções: o
# snapshot vem SEM privilégios, e sem isto a foto do ACL na PRÉ e a POS3 comparariam o default com o default.
# ════════════════════════════════════════════════════════════════════════════════════════════════════
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
SQL

Exec() { Pq -c "$1" 2>&1 || true; }
eq P01 "motor predecessor do snapshot = prod" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure")" "$MD5_MOTOR_PRED"
eq P02 "cadastro WP predecessor do snapshot = prod" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reposicao_sincronizar_embalagem_wp(text)'::regprocedure")" "$MD5_CAD_PRED"

# O MOTOR ANTIGO, renomeado, para a comparação byte a byte (o controle "idêntico ao de hoje").
P -q <<'SQL'
DO $c$
BEGIN
  EXECUTE replace(pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure),
                  'FUNCTION public.gerar_pedidos_sugeridos_ciclo(', 'FUNCTION public.motor_antigo(');
END
$c$;
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — sementes. Gatilhos desligados (session_replication_role) só NA SEMENTE: os da prod nessas tabelas
# não são o assunto e exigiriam o mundo inteiro. O motor roda com eles LIGADOS.
# t_grupo: 1 âncora QT (com parâmetro) + 1 GL do mesmo grupo, ou só a âncora (gl NULL = SKU sem grupo).
# ════════════════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE FUNCTION public.t_grupo(p_qt bigint, p_gl bigint, p_desc_qt text, p_desc_gl text, p_unidade text,
  p_pp numeric, p_max numeric, p_min numeric, p_fisico numeric, p_preco_qt numeric, p_preco_gl numeric,
  p_cmc numeric, p_u_qt numeric, p_u_gl numeric) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_g uuid := gen_random_uuid();
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade)
    VALUES (p_qt, 'oben', 'C' || p_qt, p_desc_qt, 'Concentrados', true, '00', p_unidade);
  INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
      minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao)
    VALUES ('OBEN', p_qt, p_desc_qt, 'Sayerlack', p_pp, p_max, p_min, true, 'automatica');
  INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
    VALUES ('OBEN', p_qt::text, p_fisico, 0);
  INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
    VALUES (p_qt, 'vendas', p_fisico, p_cmc, now());
  INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', p_qt::text, true);
  IF p_gl IS NULL THEN RETURN; END IF;
  INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade)
    VALUES (p_gl, 'oben', 'C' || p_gl, p_desc_gl, 'Concentrados', true, '00', p_unidade);
  INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
    VALUES ('OBEN', p_gl::text, 0, 0);
  INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
    VALUES (p_gl, 'vendas', 0, p_cmc, now());
  INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', p_gl::text, true);
  INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em, fonte)
    VALUES ('oben', p_qt::text, p_preco_qt, 'ok', now(), 'manual_usuario'), ('oben', p_gl::text, p_preco_gl, 'ok', now(), 'manual_usuario');
  INSERT INTO sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, ativo, fator_conversao)
    VALUES ('OBEN', 'Sayerlack', p_qt::text, 'P' || p_qt, true, 1), ('OBEN', 'Sayerlack', p_gl::text, 'P' || p_gl, true, 1);
  INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base,
      fornecedor_nome, ativo, criado_por, unidades_omie_por_embalagem)
    VALUES ('oben', v_g, p_qt::text, 'QT', 1, 'Sayerlack', true, 'teste', p_u_qt),
           ('oben', v_g, p_gl::text, 'QT', 4, 'Sayerlack', true, 'teste', p_u_gl);
END $f$;
SQL
# Os 4 grupos WP entram ANTES da migration, sem a coluna (ela ainda não existe): quem os preenche é o UPDATE.
P -q <<'SQL'
SET session_replication_role = replica;
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido)
  VALUES ('OBEN', 'Sayerlack', interval '10:00');
SQL
semeia_wp() {   # <qt> <gl> <cor> <pp> <max> <min> <fisico> <preco_qt> <preco_gl> <cmc>
  P -q <<SQL
SET session_replication_role = replica;
INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade) VALUES
  ($1, 'oben', 'C$1', '$3QT CONCENTRADO', 'Concentrados', true, '00', 'L'),
  ($2, 'oben', 'C$2', '$3GL CONCENTRADO', 'Concentrados', true, '00', 'L');
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
    minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao)
  VALUES ('OBEN', $1, '$3QT CONCENTRADO', 'Sayerlack', $4, $5, $6, true, 'automatica');
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
  VALUES ('OBEN', '$1', $7, 0), ('OBEN', '$2', 0, 0);
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
  VALUES ($1, 'vendas', $7, ${10}, now()), ($2, 'vendas', 0, ${10}, now());
INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', '$1', true), ('OBEN', '$2', true);
INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em, fonte)
  VALUES ('oben', '$1', $8, 'ok', now(), 'manual_usuario'), ('oben', '$2', $9, 'ok', now(), 'manual_usuario');
INSERT INTO sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, ativo, fator_conversao)
  VALUES ('OBEN', 'Sayerlack', '$1', 'P$1', true, 1), ('OBEN', 'Sayerlack', '$2', 'P$2', true, 1);
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base, fornecedor_nome, ativo, criado_por)
  VALUES ('oben', md5('$3')::uuid, '$1', 'QT', 1, 'Sayerlack', true, 'teste'),
         ('oben', md5('$3')::uuid, '$2', 'QT', 4, 'Sayerlack', true, 'teste');
SQL
}
#          qt          gl          cor        pp  max min  fisico preco_qt preco_gl cmc
semeia_wp  9100000001  9100000002  WP91.01    5   8   NULL 3.2    80       330      101.08   # A: fica no QT
semeia_wp  9200000001  9200000002  WP92.01    5   10  NULL 3      100      300      101.08   # B: troca p/ GL
semeia_wp  9300000001  9300000002  WP93.01    9   12  NULL 2      80       330      101.08   # C: em trânsito
semeia_wp  9400000001  9400000002  WP94.01    5   6   8    5      80       330      101.08   # F: mínimo forçado

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — a migration REAL (a transação é do executor, como no db:aplicar).
# ════════════════════════════════════════════════════════════════════════════════════════════════════
if P --single-transaction -q -f "$MIG" >/dev/null 2>"$TMPD/mig.err"; then m0=APLICOU; else m0="ERRO: $(tail -2 "$TMPD/mig.err" | tr '\n' ' ')"; fi
eq M0 "a migration aplica limpa (TRAVA, PRÉ, CREATE, UPDATE e PÓS)" "$m0" APLICOU
eq M1 "corpos instalados = ESTES (motor + cadastro)" \
  "$(Exec "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('gerar_pedidos_sugeridos_ciclo','reposicao_sincronizar_embalagem_wp')")" \
  "$MD5_MOTOR,$MD5_CAD"
eq M2 "os 8 membros WP preenchidos: QT 0,81 / GL 3,24" \
  "$(Exec "SELECT string_agg(sku_codigo_omie || '=' || trim_scale(unidades_omie_por_embalagem), ',' ORDER BY sku_codigo_omie) FROM sku_embalagem_equivalencia")" \
  "9100000001=0.81,9100000002=3.24,9200000001=0.81,9200000002=3.24,9300000001=0.81,9300000002=3.24,9400000001=0.81,9400000002=3.24"

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# G — a PRÉ e a PÓS, sobre o estado limpo pós-migration e ANTES dos grupos de controle (que têm a coluna
# NULL de propósito e fariam a POS4 acusar com razão). Cada G é a migration inteira numa transação que
# volta atrás, com um prefixo que planta o defeito ou um trecho adulterado.
# ════════════════════════════════════════════════════════════════════════════════════════════════════
MIG_G="$TMPD/mig-g.sql"
cp "$MIG" "$MIG_G"
case "$SABOTAGEM" in
  pre_removida) python3 - "$MIG_G" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys, re
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
ini = s.index("DO $pre$"); fim = s.index("$pre$;", ini) + len("$pre$;")
s = s[:ini] + "CREATE TEMP TABLE motor_unidades_wp_foto ON COMMIT DROP AS SELECT p.oid::regprocedure::text AS alvo, p.proacl::text AS acl, p.proconfig::text AS config, p.prosecdef AS secdef, p.provolatile AS vol, pg_catalog.pg_get_userbyid(p.proowner) AS dono FROM pg_catalog.pg_proc p WHERE p.oid = ANY (ARRAY[to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)'), to_regprocedure('public.reposicao_sincronizar_embalagem_wp(text)')]::oid[]);" + s[fim:]
open(p, "w", encoding="utf-8").write(s)
PY
  ;;
  pos_removida) python3 - "$MIG_G" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
ini = s.index("DO $pos$"); fim = s.index("$pos$;", ini) + len("$pos$;")
open(p, "w", encoding="utf-8").write(s[:ini] + s[fim:])
PY
  ;;
esac
g_arquivo() {   # <saida> <prefixo SQL> [<de> <para>] — a migration de G com um prefixo e, opcional, 1 troca exata
  python3 - "$MIG_G" "$@" <<'PY'
import sys
mig, out, pre = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(mig, encoding="utf-8").read()
if len(sys.argv) > 4:
    de, para = sys.argv[4], sys.argv[5]
    if s.count(de) != 1:
        sys.exit("troca de G ocorre %dx: %r" % (s.count(de), de))
    s = s.replace(de, para)
open(out, "w", encoding="utf-8").write(pre + "\n" + s)
PY
}
# shellcheck disable=SC2016  # $x$ é dollar-quote do SQL
DERIVA_MOTOR='DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('"'"'public.gerar_pedidos_sugeridos_ciclo(text, date)'"'"'::regprocedure), '"'"'v_stale_dias INT := 45;'"'"', '"'"'v_stale_dias INT := 46;'"'"'); END $x$;'
# shellcheck disable=SC2016
DERIVA_CAD='DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('"'"'public.reposicao_sincronizar_embalagem_wp(text)'"'"'::regprocedure), '"'"'v_cores int := 0;'"'"', '"'"'v_cores int := 0; -- outra sessão'"'"'); END $x$;'
g_arquivo "$TMPD/g1.sql" "$DERIVA_MOTOR"
eq G1 "motor vivo DIVERGENTE (outra sessão o recriou) — a PRÉ aborta" "$(Tenta "$TMPD/g1.sql" P0001 'PRE FALHOU: gerar_pedidos_sugeridos_ciclo')" NEGOU
g_arquivo "$TMPD/g2.sql" "$DERIVA_CAD"
eq G2 "cadastro WP vivo DIVERGENTE — a PRÉ aborta" "$(Tenta "$TMPD/g2.sql" P0001 'PRE FALHOU: reposicao_sincronizar_embalagem_wp')" NEGOU
g_arquivo "$TMPD/g3.sql" ""
eq G3 "re-aplicar sobre si mesma passa (idempotente)" "$(Tenta "$TMPD/g3.sql" P0001 'nunca')" PASSOU
g_arquivo "$TMPD/g4.sql" "" '-- DADO: unidades Omie' 'REVOKE EXECUTE ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) FROM authenticated;
-- DADO: unidades Omie'
eq G4 "ACL do cadastro mexido no meio — a POS3 recusa" "$(Tenta "$TMPD/g4.sql" P0001 'POS3 FALHOU')" NEGOU
g_arquivo "$TMPD/g5.sql" "UPDATE public.sku_embalagem_equivalencia SET unidades_omie_por_embalagem = NULL WHERE sku_codigo_omie = '9100000002';
UPDATE public.omie_products SET unidade = 'UN' WHERE omie_codigo_produto = 9100000002;"
eq G5 "membro WP sem unidade preenchível (produto em UN) — a POS4 recusa" "$(Tenta "$TMPD/g5.sql" P0001 'POS4 FALHOU')" NEGOU
g_arquivo "$TMPD/g6.sql" "" '-- [UNIDADES #2849] NULL p/ SKU sem grupo' '-- [UNIDADES #2849] NULL p/ SKU sem grupo.'
eq G6 "corpo do motor adulterado — a POS1 recusa" "$(Tenta "$TMPD/g6.sql" P0001 'POS1 FALHOU')" NEGOU
g_arquivo "$TMPD/g7.sql" "UPDATE public.sku_embalagem_equivalencia SET unidades_omie_por_embalagem = 3 WHERE sku_codigo_omie = '9200000002';"
eq G7 "membro com unidade ERRADA já gravada (3 em vez de 3,24; o UPDATE só preenche NULL) — a POS4 recusa" \
  "$(Tenta "$TMPD/g7.sql" P0001 'POS4 FALHOU')" NEGOU
g_arquivo "$TMPD/g8.sql" "" '-- motor fica no fator relativo (a conta de antes) — nunca um litro presumido.' '-- motor fica no fator relativo (a conta de antes) — nunca um litro presumido!'
eq G8 "corpo do cadastro WP adulterado — a POS2 recusa" "$(Tenta "$TMPD/g8.sql" P0001 'POS2 FALHOU')" NEGOU

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — os CONTROLES, depois da migration: os mesmos números do A, com a coluna NULL (D1), PARCIAL (D2:
# só o QT) e INCOERENTE (D3: GL = 4 L, razão ≠ do QT). E o SKU sem grupo (E). E o em trânsito do C. E as
# cores novas para o cadastro (WP88 em litros, WP89 em UN), só em omie_products.
# ════════════════════════════════════════════════════════════════════════════════════════════════════
#                     qt          gl          desc_qt     desc_gl     un   pp max min  fis  pqt pgl  cmc     u_qt  u_gl
P -q -c "SELECT public.t_grupo(9500000001, 9500000002, 'CTL95 QT', 'CTL95 GL', 'L', 5, 8, NULL, 3.2, 80, 330, 101.08, NULL, NULL)" \
     -c "SELECT public.t_grupo(9600000001, 9600000002, 'PAR96 QT', 'PAR96 GL', 'L', 5, 8, NULL, 3.2, 80, 330, 101.08, 0.81, NULL)" \
     -c "SELECT public.t_grupo(9700000001, 9700000002, 'INC97 QT', 'INC97 GL', 'L', 5, 8, NULL, 3.2, 80, 330, 101.08, 0.81, 4)" \
     -c "SELECT public.t_grupo(9800000001, NULL, 'SOLO98 1L', NULL, 'L', 5, 10, NULL, 1.5, NULL, NULL, 50, NULL, NULL)" >/dev/null
P -q <<'SQL'
SET session_replication_role = replica;
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, tipo_ciclo, omie_pedido_compra_numero, valor_total)
  VALUES (990001, 'OBEN', 'Sayerlack', DATE '2026-10-08', 'disparado', 'normal', '4242', 0);
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final)
  VALUES (990001, '9300000001', 2, 2), (990001, '9300000002', 1, 1);
INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade) VALUES
  (8800000001, 'oben', 'C8800000001', 'WP88.01QT CONCENTRADO', 'Concentrados', true, '00', 'L'),
  (8800000002, 'oben', 'C8800000002', 'WP88.01GL CONCENTRADO', 'Concentrados', true, '00', 'L'),
  (8900000001, 'oben', 'C8900000001', 'WP89.01QT CONCENTRADO', 'Concentrados', true, '00', 'UN'),
  (8900000002, 'oben', 'C8900000002', 'WP89.01GL CONCENTRADO', 'Concentrados', true, '00', 'UN');
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM (só no laço --falsificar): recria UMA função a partir do bloco da migration com UMA troca exata.
# ════════════════════════════════════════════════════════════════════════════════════════════════════
sabotar() {   # <nome da função> <de> <para> <n>
  local nome="$1" tmp
  shift
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$MIG" "$nome" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, nome, out, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6])
s = open(mig, encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE FUNCTION public." + nome + "(")
fim = s.find("$function$;\n", ini) + len("$function$;") if ini >= 0 else -1
if ini < 0 or fim <= 0:
    print("   " + nome + " não delimitada", file=sys.stderr); sys.exit(1)
bloco = s[ini:fim]
if bloco.count(de) != n:
    print("   padrão ocorre %dx, esperado %d: %r" % (bloco.count(de), n, de), file=sys.stderr); sys.exit(1)
open(out, "w", encoding="utf-8").write(bloco.replace(de, para) + "\n")
PYSAB
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
}
M=gerar_pedidos_sugeridos_ciclo
C=reposicao_sincronizar_embalagem_wp
case "$SABOTAGEM" in
  "") ;;
  pre_removida|pos_removida) ;;   # agiram no arquivo dos G, acima
  transito_pelo_fator) sabotar $M "COALESCE(et.qtde, 0) * e.conv)" "COALESCE(et.qtde, 0) * e.fator_para_base)" 2 ;;
  quartinho_sem_conv)  sabotar $M "COALESCE(b.cap_teto_ancora, b.estoque_maximo - b.estoque_efetivo)) / COALESCE(b.conv_ancora, 1))" \
                                  "COALESCE(b.cap_teto_ancora, b.estoque_maximo - b.estoque_efetivo)))" 1 ;;
  galao_pelo_fator)    sabotar $M "/ b.conv_escolhido)" "/ b.fator_escolhido)" 2 ;;
  preco_sem_conv)      sabotar $M "b.preco_unitario_ancora * COALESCE(b.conv_ancora, 1)" "b.preco_unitario_ancora" 1 ;;
  minimo_sem_conv)     sabotar $M "b.minimo_forcado_manual) / COALESCE(b.conv_ancora, 1))" "b.minimo_forcado_manual))" 2 ;;
  grupo_parcial_vale)  sabotar $M "bool_and(q.u IS NOT NULL AND q.u > 0 AND q.u < 1e9) OVER (PARTITION BY q.grupo_id)" "true" 1 ;;
  sem_coerencia)       sabotar $M "min(q.u / q.fator_para_base) OVER (PARTITION BY q.grupo_id)" "max(q.u / q.fator_para_base) OVER (PARTITION BY q.grupo_id)" 1 ;;
  sem_grupo_divide)    sabotar $M "COALESCE(b.conv_ancora, 1)" "COALESCE(b.conv_ancora, 0.81)" 6 ;;
  sugerida_em_litros)  sabotar $M "ceil((b.estoque_maximo - b.estoque_efetivo) / COALESCE(b.conv_ancora, 1)) AS qtde_sugerida" \
                                  "ceil(b.estoque_maximo - b.estoque_efetivo) AS qtde_sugerida" 1 ;;
  cadastro_sem_litros) sabotar $C "CASE WHEN r.em_litros THEN x.unidades END" "x.unidades" 1 ;;
  cadastro_sem_coluna) sabotar $C "CASE WHEN r.em_litros THEN x.unidades END" "NULL::numeric" 1 ;;
  cadastro_sobrescreve) sabotar $C "ON CONFLICT (empresa, sku_codigo_omie) WHERE ativo DO NOTHING;" \
                                  "ON CONFLICT (empresa, sku_codigo_omie) WHERE ativo DO UPDATE SET unidades_omie_por_embalagem = EXCLUDED.unidades_omie_por_embalagem;" 1 ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# O MOTOR EXECUTADO — cada leitura roda o motor (novo ou antigo) numa transação que VOLTA ATRÁS e lê as
# linhas gravadas em pedido_compra_item. Vazio (nenhuma linha) é ausência de dado: vira ERRO_DE_EXECUCAO.
# Linha: sku|qtde_sugerida|qtde_final|preco_unitario|valor_linha|estoque_fisico|estoque_a_caminho|qtde_sem_teto
# ════════════════════════════════════════════════════════════════════════════════════════════════════
linhas() {   # <motor_antigo|gerar_pedidos_sugeridos_ciclo> <filtro SQL sobre i.sku_codigo_omie> [cru]
  local fmt="trim_scale(i.%s)"
  [ "${3:-}" = cru ] && fmt="i.%s"
  local col sel=""
  for col in qtde_sugerida qtde_final preco_unitario valor_linha estoque_fisico estoque_a_caminho qtde_sem_teto; do
    # shellcheck disable=SC2059  # o formato é montado aqui de propósito
    sel="$sel, $(printf "$fmt" "$col")"
  done
  Pq -q -c "BEGIN" \
     -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.$1('OBEN', DATE '2026-10-09')" \
     -c "SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', i.sku_codigo_omie$sel), ';' ORDER BY i.sku_codigo_omie)
           FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id
          WHERE p.data_ciclo = DATE '2026-10-09' AND p.status IN ('pendente_aprovacao', 'bloqueado_guardrail') AND ($2)" \
     -c "ROLLBACK" 2>&1 || true
}
NOVO=gerar_pedidos_sugeridos_ciclo
ANT=motor_antigo
GA="i.sku_codigo_omie IN ('9100000001','9100000002')"
GB="i.sku_codigo_omie IN ('9200000001','9200000002')"
GC="i.sku_codigo_omie IN ('9300000001','9300000002')"
GF="i.sku_codigo_omie IN ('9400000001','9400000002')"

echo "── A: quartinho (físico 3,2 L, pp 5, máx 8, cmc 101,08 R\$/L)"
eq A0 "o ANTIGO lia L como QT: 5 QT a 101,08 (o defeito que a migration conserta)" \
  "$(linhas $ANT "$GA")" "9100000001|5|5|101.08|505.4|3.2|0|5"
eq A1 "NOVO: ceil(4,8/0,81) = 6 QT a 101,08 × 0,81 = 81,8748" \
  "$(linhas $NOVO "$GA")" "9100000001|6|6|81.8748|491.2488|3.2|0|6"
echo "── B: troca p/ galão (físico 3 L, máx 10; GL 300 < 4 × 100)"
eq B0 "o ANTIGO dividia por 4: ceil(7/4) = 2 GL" "$(linhas $ANT "$GB")" "9200000002|7|2|300|600|3|0|2"
eq B1 "NOVO: ceil(7/3,24) = 3 GL a 300" "$(linhas $NOVO "$GB")" "9200000002|9|3|300|900|3|0|3"
echo "── C: em trânsito (físico 2 L; em voo 2 QT + 1 GL; pp 9, máx 12)"
eq C0 "o ANTIGO somava 2 + 1×4 = 6 'L' a caminho → efetivo 8 → 4 QT" \
  "$(linhas $ANT "$GC")" "9300000001|4|4|101.08|404.32|2|6|4"
eq C1 "NOVO: a caminho 2×0,81 + 1×3,24 = 4,86 L → efetivo 6,86 → ceil(5,14/0,81) = 7 QT" \
  "$(linhas $NOVO "$GC")" "9300000001|7|7|81.8748|573.1236|2|4.86|7"
echo "── F: minimo_forcado_manual = 8 L (físico 5, pp 5, máx 6)"
eq F0 "o ANTIGO comprava 8 QT (= 6,48 L) para um mínimo de 8 L" \
  "$(linhas $ANT "$GF")" "9400000001|1|8|101.08|808.64|5|0|8"
eq F1 "NOVO: ceil(8/0,81) = 10 QT" "$(linhas $NOVO "$GF")" "9400000001|2|10|81.8748|818.748|5|0|10"
echo "── D: CONTROLES — byte-idênticos ao motor antigo (valores crus, sem trim_scale)"
iguais D1 "grupo SEM cadastro (coluna NULL)" \
  "$(linhas $ANT "i.sku_codigo_omie LIKE '95%'" cru)" "$(linhas $NOVO "i.sku_codigo_omie LIKE '95%'" cru)"
iguais D2 "grupo PARCIAL (só o QT cadastrado) — o grupo INTEIRO volta ao fator" \
  "$(linhas $ANT "i.sku_codigo_omie LIKE '96%'" cru)" "$(linhas $NOVO "i.sku_codigo_omie LIKE '96%'" cru)"
iguais D3 "grupo INCOERENTE (QT 0,81 e GL 4: u/fator diferente) — volta ao fator" \
  "$(linhas $ANT "i.sku_codigo_omie LIKE '97%'" cru)" "$(linhas $NOVO "i.sku_codigo_omie LIKE '97%'" cru)"
echo "── E: SKU sem grupo"
iguais E1 "SKU sem grupo byte-idêntico ao antigo" \
  "$(linhas $ANT "i.sku_codigo_omie = '9800000001'" cru)" "$(linhas $NOVO "i.sku_codigo_omie = '9800000001'" cru)"
eq E2 "SKU sem grupo: ceil(8,5) = 9 a cmc 50" "$(linhas $NOVO "i.sku_codigo_omie = '9800000001'")" "9800000001|9|9|50|450|1.5|0|9"
FORA="i.sku_codigo_omie NOT LIKE '91%' AND i.sku_codigo_omie NOT LIKE '92%' AND i.sku_codigo_omie NOT LIKE '93%' AND i.sku_codigo_omie NOT LIKE '94%'"
iguais X1 "TUDO fora dos 4 grupos WP cadastrados: byte-idêntico" "$(linhas $ANT "$FORA" cru)" "$(linhas $NOVO "$FORA" cru)"

echo "── K: o cadastro WP (cron, auth.uid() NULL) numa transação que volta atrás"
cad() {   # <filtro sobre sku_codigo_omie> [<SQL antes do cadastro, na mesma transação>]
  Pq -q -c "BEGIN" -c "${2:-SET LOCAL client_min_messages TO warning}" -c "CREATE TEMP TABLE r_cad AS SELECT public.reposicao_sincronizar_embalagem_wp('oben')" \
     -c "SELECT string_agg(sku_codigo_omie || '/' || trim_scale(fator_para_base) || '=' || COALESCE(trim_scale(unidades_omie_por_embalagem)::text, 'NULL'), ',' ORDER BY sku_codigo_omie)
           FROM sku_embalagem_equivalencia WHERE ativo AND ($1)" \
     -c "ROLLBACK" 2>&1 || true
}
eq K1 "cor nova em LITROS nasce com 0,81 / 3,24" "$(cad "sku_codigo_omie LIKE '88%'")" "8800000001/1=0.81,8800000002/4=3.24"
eq K2 "cor nova em UN nasce com NULL (o motor fica no fator)" "$(cad "sku_codigo_omie LIKE '89%'")" "8900000001/1=NULL,8900000002/4=NULL"
# K3: o WP91 é ELEGÍVEL (WP, em L, QT+GL) e já está no grupo; um valor que o cadastro nunca escreveria (0,8/3,2)
# denuncia sobrescrita — o ON CONFLICT DO NOTHING o preserva.
eq K3 "par WP elegível já cadastrado NÃO é reescrito (0,8/3,2 sobrevivem ao cadastro)" \
  "$(cad "sku_codigo_omie LIKE '91%'" "UPDATE sku_embalagem_equivalencia SET unidades_omie_por_embalagem = fator_para_base * 0.8 WHERE sku_codigo_omie LIKE '91%'")" \
  "9100000001/1=0.8,9100000002/4=3.2"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$PASS" -ne "$TOTAL_ESPERADO" ] && [ "$FAIL" -eq 0 ]; then
  echo "❌ $PASS asserts executados, esperados $TOTAL_ESPERADO — a prova foi TRUNCADA (FAIL=0 com PASS encolhido não é verde)"
  exit 1
fi
[ "$FAIL" -eq 0 ]
