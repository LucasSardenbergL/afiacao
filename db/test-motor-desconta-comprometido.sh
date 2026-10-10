#!/usr/bin/env bash
# REGRESSÃO — o motor de reposição desconta o estoque COMPROMETIDO em pedido de venda aberto no Omie
# (supabase/migrations/20261010210000_motor_desconta_comprometido.sql).
#
# O Omie da Oben não reserva: o físico só baixa na NF. A migration faz o motor subtrair, do estoque efetivo que
# decide o gatilho e a quantidade, a Σ das quantidades dos pedidos importados abertos, relidos em 36 h, sem irmão
# de mesmo número, só nos SKUs SEM grupo de equivalência.
#
# O que se prova, com o motor EXECUTADO (PG17, schema + ACL da prod):
#   S — positivos: S1 o exemplo real (físico 10, vendido 4 → compra 10; o antigo não comprava), S2 vários itens e
#       pedidos do mesmo SKU somam, S3 efetivo NEGATIVO compra o pedido + o máximo, B1 relido há 35 h conta.
#   F — cada filtro violado NÃO conta (o SKU compra 8, como sem o pedido): faturado, cancelado, push, deletado,
#       outra conta, relido há 37 h, nunca relido, quantidade texto/negativa/zero, número repetido (parcial),
#       items que não é array, pedido sem número.
#   W — SKU de grupo de equivalência (WP, em L): o desconto NÃO se aplica (idêntico ao antigo, rastro NULL).
#   T/M/N — teto de cobertura com piso de serviço, mínimo forçado, gate de estoque não confirmado: usam o efetivo
#       descontado.
#   K — desligador por empresa: 'false' e lixo desligam (idêntico ao antigo, rastro NULL); 'true' liga.
#   R — o caminho do BOTÃO: o staff (authenticated + RLS + o ACL por coluna de prod) roda o motor e vê o mesmo.
#   X1 — tudo que não tem pedido elegível: byte-idêntico ao motor antigo.
#   P01-P02 · M0-M1 · G1-G5: predecessores = prod, a migration aplica, a PRÉ e a PÓS recusam o que devem.
#
# Rodar:   bash db/test-motor-desconta-comprometido.sh > log 2>&1; echo $?
#          bash db/test-motor-desconta-comprometido.sh --falsificar > log 2>&1; echo $?
# matriz:  HARNESS_LC=C | HARNESS_LC=pt_BR.UTF-8 (lc_messages do servidor; os asserts casam marca ASCII)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5691}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="motor-desconta-comprometido"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261010210000_motor_desconta_comprometido.sql"
MIG_PRED="$REPO_ROOT/supabase/migrations/20261009194000_motor_unidades_concentrado_wp.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
MD5_SNAP=7a15485d16c2a88c2de88cc80f87756b   # o motor do snapshot (antes da 20261009194000)
MD5_PRED=d3f55f2621c27a234925821e06f73dd7   # o motor VIVO em prod em 2026-10-10 (= 20261009194000)
MD5_NOVO=4187116fdf4284f79d416249d3f35335
# Denominador: P01,P02 · M0,M1 · G1-G5 · S0,S1,S2,S3,B1 · F1-F13 · W1,W2 · T1 · M2 · N1 · K1-K4 · R1 · X1.
TOTAL_ESPERADO=38

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: o controle roda PRIMEIRO, na mesma invocação (uma suíte que já falha aprovaria tudo). Cada
# sabotagem declara os asserts que TÊM de ficar vermelhos por RESULTADO e os que TÊM de seguir verdes.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_status:F1:S1,F2
              sem_cancelado_fora:F2:S1,F1
              sem_hash:F3:S1
              sem_deleted:F4:S1
              sem_conta:F5:S1
              sem_janela:F6,F7:S1,B1
              janela_7d:F6:S1,F7
              sem_tipo:F8:S1,F9
              sem_positivo:F9:S1,F8
              sem_parcial:F11:S1,F13
              sem_numero:F13:S1,F11
              rastro_no_grupo:W2:W1,S1
              gatilho_sem_desconto:S1,T1,M2:S2,S3
              efetivo_sem_desconto:S1,S2,S3:F1
              rastro_ausente:S1,S2:X1
              desligador_ignora:K1,K2:K3
              sem_grant:R1:S1
              pre_removida:G1:G2
              pos_removida:G3,G4,G5:G2"
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
    if ! grep -q "SABOTAGEM ativa: ${sab}\$" "$log"; then
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
# Um VALOR que é erro (psql) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de falsificação não
# aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}
iguais() {   # <id> <descrição> <v1> <v2>
  if invalido "$3" || invalido "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=${3:0:80})"; else bad "$1" "$2 — antigo [$3] ≠ novo [$4]"; fi
}
# Roda um arquivo SQL numa transação que VOLTA ATRÁS: 'PASSOU' se não levantou nada; 'NEGOU' se levantou a
# SQLSTATE e a marca ESPERADAS; qualquer outro erro sai como ERRO (o `eq` o lê como execução, não como dente).
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
Exec() { Pq -c "$1" 2>&1 || true; }

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema E ACL de prod: stubs + prelude + snapshot + db/lib/corpo-vivo-acl.sql (o ACL medido: o SELECT
# de sales_orders é POR COLUNA para authenticated, e omie_reconciliado_em NÃO está nele — é o que a migration
# concede). auth.uid() lê test.uid (o staff do R1).
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
P -q -f "$REPO_ROOT/db/lib/corpo-vivo-acl.sql" >/dev/null 2>"$TMPD/acl.err" || { echo "INFRA: ACL de prod não carregou"; tail -5 "$TMPD/acl.err"; exit 1; }
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"

eq P01 "motor do snapshot = o predecessor da 20261009194000" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure")" "$MD5_SNAP"
P --single-transaction -q -f "$MIG_PRED" >/dev/null 2>"$TMPD/pred.err" || { echo "INFRA: a 20261009194000 não aplicou"; tail -3 "$TMPD/pred.err"; exit 1; }
eq P02 "depois da 20261009194000, o motor = o VIVO em prod (predecessor desta migration)" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure")" "$MD5_PRED"

# O MOTOR ANTIGO, renomeado, para a comparação byte a byte.
P -q <<'SQL'
DO $c$
BEGIN
  EXECUTE replace(pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure),
                  'FUNCTION public.gerar_pedidos_sugeridos_ciclo(', 'FUNCTION public.motor_antigo(');
END
$c$;
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — sementes (gatilhos desligados só NA SEMENTE). Todo SKU é UN, sem grupo, do Sayerlack; pp/máx/físico
# por cenário. t_pv grava um pedido de venda: 'omie' = importado canônico (hash omie_<conta>_<id>, com data e
# número), 'push' = criado no app (sem hash). p_horas = há quantas horas foi relido (NULL = nunca).
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SEQUENCE public.t_pv_seq START 900000001;
CREATE FUNCTION public.t_sku(p_sku bigint, p_pp numeric, p_max numeric, p_fisico numeric,
  p_min numeric DEFAULT NULL, p_classe text DEFAULT NULL, p_demanda numeric DEFAULT NULL,
  p_seed_only boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade)
    VALUES (p_sku, 'oben', 'C' || p_sku, 'PRODUTO ' || p_sku, 'Diversos', true, '00', 'UN');
  INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
      minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao, classe_abc, demanda_media_diaria)
    VALUES ('OBEN', p_sku, 'PRODUTO ' || p_sku, 'Sayerlack', p_pp, p_max, p_min, true, 'automatica', p_classe, p_demanda);
  INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
    VALUES ('OBEN', p_sku::text, p_fisico, 0, CASE WHEN p_seed_only THEN 'cold_start_seed' END);
  IF NOT p_seed_only THEN
    INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
      VALUES (p_sku, 'vendas', p_fisico, 10, now());
  END IF;
  INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', p_sku::text, true);
END $f$;
CREATE FUNCTION public.t_pv(p_items jsonb, p_status text, p_horas numeric, p_tipo text DEFAULT 'omie',
  p_conta text DEFAULT 'oben', p_deletado boolean DEFAULT false, p_numero text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE v_id bigint := nextval('public.t_pv_seq');
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO sales_orders (customer_user_id, created_by, items, status, account, hash_payload, omie_pedido_id,
      omie_numero_pedido, order_date_kpi, omie_reconciliado_em, deleted_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), p_items, p_status, p_conta,
            CASE WHEN p_tipo = 'omie' THEN 'omie_' || p_conta || '_' || v_id END, v_id,
            CASE WHEN p_numero = '' THEN v_id::text ELSE NULLIF(p_numero, 'NULO') END,
            CASE WHEN p_tipo = 'omie' THEN DATE '2026-10-08' END,
            now() - make_interval(secs => (p_horas * 3600)::double precision),
            CASE WHEN p_deletado THEN now() END);
END $f$;
CREATE FUNCTION public.t_it(p_sku bigint, p_q jsonb) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT jsonb_build_array(jsonb_build_object('omie_codigo_produto', p_sku, 'quantidade', p_q, 'descricao', 'X')) $f$;
SET session_replication_role = replica;
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido)
  VALUES ('OBEN', 'Sayerlack', interval '10:00');
SQL
P -q <<'SQL'
-- S: positivos (pp 9, máx 16 salvo nota)
SELECT t_sku(7101, 9, 16, 10);                               -- S1: 10 − 4 = 6 ≤ 9 → compra 10
SELECT t_pv(t_it(7101, '4'), 'enviado', 3);
SELECT t_sku(7102, 9, 16, 8);                                -- S2: 2 itens num pedido + 1 noutro = 4 → 8 − 4 → 12
SELECT t_pv(t_it(7102, '1') || t_it(7102, '2'), 'separacao', 1);
SELECT t_pv(t_it(7102, '1'), 'importado', 20);
SELECT t_sku(7103, 3, 6, 2);                                 -- S3: 2 − 5 = −3 → compra 9
SELECT t_pv(t_it(7103, '5'), 'importado', 2);
SELECT t_sku(7124, 9, 16, 8);                                -- B1: relido há 35 h → conta: 8 − 4 → 12
SELECT t_pv(t_it(7124, '4'), 'importado', 35);
-- F: físico 8 (compra de qualquer jeito: 8); o pedido de 4, se contasse, faria 12
SELECT t_sku(s, 9, 16, 8) FROM generate_series(7111, 7123) s;
SELECT t_pv(t_it(7111, '4'), 'faturado', 1);
SELECT t_pv(t_it(7112, '4'), 'cancelado', 1);
SELECT t_pv(t_it(7113, '4'), 'enviado', 1, 'push');
SELECT t_pv(t_it(7114, '4'), 'enviado', 1, 'omie', 'oben', true);
SELECT t_pv(t_it(7115, '4'), 'enviado', 1, 'omie', 'colacor');
SELECT t_pv(t_it(7116, '4'), 'enviado', 37);
SELECT t_pv(t_it(7117, '4'), 'enviado', NULL);
SELECT t_pv(t_it(7118, '"4"'), 'enviado', 1);
SELECT t_pv(t_it(7119, '-4'), 'enviado', 1);
SELECT t_pv(t_it(7120, '0'), 'enviado', 1);
SELECT t_pv(t_it(7121, '4'), 'importado', 1, 'omie', 'oben', false, '55580');   -- parcial: origem aberta…
SELECT t_pv(t_it(7121, '4'), 'faturado', 1, 'omie', 'oben', false, '55580');    -- …e o irmão faturado
SELECT t_pv('{"omie_codigo_produto": 7122, "quantidade": 4}'::jsonb, 'enviado', 1); -- items objeto, não array
SELECT t_pv(t_it(7123, '4'), 'enviado', 1, 'omie', 'oben', false, 'NULO');      -- sem número
-- T: teto C 30 dias, demanda 0,1/dia → cap = max(floor(3 − 6), ceil(9 − 6)) = 3 (piso de serviço)
SELECT t_sku(7130, 9, 16, 10, NULL, 'C', 0.1);
SELECT t_pv(t_it(7130, '4'), 'enviado', 1);
-- M: mínimo forçado 20 → GREATEST(16 − 6, 20) = 20
SELECT t_sku(7131, 9, 16, 10, 20);
SELECT t_pv(t_it(7131, '4'), 'enviado', 1);
-- N: estoque só-semente (sem inventory_position) → suprimido e LOGADO com o efetivo descontado (10 − 4 = 6)
SELECT t_sku(7132, 9, 16, 10, NULL, NULL, NULL, true);
SELECT t_pv(t_it(7132, '4'), 'enviado', 1);
SET session_replication_role = replica;
INSERT INTO company_config (key, value) VALUES
  ('reposicao_teto_cobertura_oben_ativa', 'true'), ('reposicao_teto_cobertura_oben_dias_c', '30');
SQL
# W: grupo WP em LITROS (QT 0,81 / GL 3,24, cadastro coerente) com 2 vendidos no QT: o desconto NÃO se aplica.
P -q <<'SQL'
SET session_replication_role = replica;
INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, ativo, tipo_produto, unidade) VALUES
  (7201, 'oben', 'C7201', 'WP72.01QT CONCENTRADO', 'Concentrados', true, '00', 'L'),
  (7202, 'oben', 'C7202', 'WP72.01GL CONCENTRADO', 'Concentrados', true, '00', 'L');
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
    habilitado_reposicao_automatica, tipo_reposicao)
  VALUES ('OBEN', 7201, 'WP72.01QT CONCENTRADO', 'Sayerlack', 5, 8, true, 'automatica');
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
  VALUES ('OBEN', '7201', 3.2, 0), ('OBEN', '7202', 0, 0);
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
  VALUES (7201, 'vendas', 3.2, 100, now()), (7202, 'vendas', 0, 100, now());
INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN', '7201', true), ('OBEN', '7202', true);
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base,
    fornecedor_nome, ativo, criado_por, unidades_omie_por_embalagem)
  VALUES ('oben', md5('WP72')::uuid, '7201', 'QT', 1, 'Sayerlack', true, 'teste', 0.81),
         ('oben', md5('WP72')::uuid, '7202', 'QT', 4, 'Sayerlack', true, 'teste', 3.24);
SELECT t_pv(t_it(7201, '2'), 'enviado', 1);
SQL
# R: o usuário do botão — master (cap_compras_ler: só master escreve pedido de compra); a RLS de sales_orders o deixa ver tudo.
P -q <<'SQL'
SET session_replication_role = replica;
INSERT INTO user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111', 'master');
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — a migration REAL (a transação é do executor, como no db:aplicar). sem_grant age no arquivo aplicado.
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
MIG_RUN="$TMPD/mig-run.sql"
cp "$MIG" "$MIG_RUN"
if [ "$SABOTAGEM" = sem_grant ]; then
  python3 - "$MIG_RUN" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
de = "GRANT SELECT (omie_reconciliado_em) ON public.sales_orders TO authenticated;"
de_pos = "IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'omie_reconciliado_em', 'SELECT')\n       OR "
if s.count(de) != 1 or s.count(de_pos) != 1: sys.exit(1)
open(p, "w", encoding="utf-8").write(s.replace(de, "").replace(de_pos, "IF "))
PY
fi
if P --single-transaction -q -f "$MIG_RUN" >/dev/null 2>"$TMPD/mig.err"; then m0=APLICOU; else m0="ERRO: $(tail -2 "$TMPD/mig.err" | tr '\n' ' ')"; fi
eq M0 "a migration aplica limpa (TRAVA, PRÉ, CREATE, coluna, GRANT e PÓS)" "$m0" APLICOU
eq M1 "o motor instalado = ESTE" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.gerar_pedidos_sugeridos_ciclo(text, date)'::regprocedure")" "$MD5_NOVO"

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# G — a PRÉ e a PÓS: a migration inteira numa transação que volta atrás, com um prefixo que planta o defeito ou
# um trecho adulterado (1 troca exata).
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
MIG_G="$TMPD/mig-g.sql"
cp "$MIG" "$MIG_G"
case "$SABOTAGEM" in
  pre_removida) python3 - "$MIG_G" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
ini = s.index("DO $pre$"); fim = s.index("$pre$;", ini) + len("$pre$;")
s = s[:ini] + "CREATE TEMP TABLE motor_comprometido_foto ON COMMIT DROP AS SELECT p.proacl::text AS acl, p.proconfig::text AS config, p.prosecdef AS secdef, p.provolatile AS vol, pg_catalog.pg_get_userbyid(p.proowner) AS dono FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.gerar_pedidos_sugeridos_ciclo(text, date)');" + s[fim:]
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
g_arquivo() {   # <saida> <prefixo SQL> [<de> <para>]
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
DERIVA='DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('"'"'public.gerar_pedidos_sugeridos_ciclo(text, date)'"'"'::regprocedure), '"'"'v_stale_dias INT := 45;'"'"', '"'"'v_stale_dias INT := 46;'"'"'); END $x$;'
g_arquivo "$TMPD/g1.sql" "$DERIVA"
eq G1 "motor vivo DIVERGENTE (outra sessão o recriou) — a PRÉ aborta" "$(Tenta "$TMPD/g1.sql" P0001 'PRE FALHOU: gerar_pedidos_sugeridos_ciclo')" NEGOU
g_arquivo "$TMPD/g2.sql" ""
eq G2 "re-aplicar sobre si mesma passa (idempotente)" "$(Tenta "$TMPD/g2.sql" P0001 'nunca')" PASSOU
g_arquivo "$TMPD/g3.sql" "" '-- rastro: NULL = desconto não se aplica' '-- rastro: NULL = desconto nao se aplica'
eq G3 "corpo do motor adulterado — a POS1 recusa" "$(Tenta "$TMPD/g3.sql" P0001 'POS1 FALHOU')" NEGOU
g_arquivo "$TMPD/g4.sql" "" '-- Rastro do desconto no item' 'REVOKE EXECUTE ON FUNCTION public.gerar_pedidos_sugeridos_ciclo(text, date) FROM authenticated;
-- Rastro do desconto no item'
eq G4 "ACL do motor mexido no meio — a POS3 recusa" "$(Tenta "$TMPD/g4.sql" P0001 'POS3 FALHOU')" NEGOU
g_arquivo "$TMPD/g5.sql" "" 'GRANT SELECT (omie_reconciliado_em) ON public.sales_orders TO authenticated;' \
  'GRANT SELECT (omie_reconciliado_em) ON public.sales_orders TO authenticated;
GRANT SELECT (omie_payload) ON public.sales_orders TO authenticated;'
eq G5 "o GRANT reabrindo omie_payload — a POS6 recusa" "$(Tenta "$TMPD/g5.sql" P0001 'POS6 FALHOU')" NEGOU

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM (só no laço --falsificar): recria o motor a partir do bloco da migration com UMA troca exata.
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
sabotar() {   # <de> <para> <n>
  local tmp
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$MIG" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, out, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
s = open(mig, encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(")
fim = s.find("$function$;\n", ini) + len("$function$;") if ini >= 0 else -1
if ini < 0 or fim <= 0:
    print("   motor não delimitado", file=sys.stderr); sys.exit(1)
bloco = s[ini:fim]
if bloco.count(de) != n:
    print("   padrão ocorre %dx, esperado %d: %r" % (bloco.count(de), n, de), file=sys.stderr); sys.exit(1)
open(out, "w", encoding="utf-8").write(bloco.replace(de, para) + "\n")
PYSAB
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
}
case "$SABOTAGEM" in
  ""|sem_grant|pre_removida|pos_removida) ;;   # as 3 últimas agiram nos arquivos, acima
  sem_status)           sabotar "AND so.status IN ('importado', 'separacao', 'enviado')" "AND so.status IN ('importado', 'separacao', 'enviado', 'faturado')" 1 ;;
  sem_cancelado_fora)   sabotar "AND so.status IN ('importado', 'separacao', 'enviado')" "AND so.status IN ('importado', 'separacao', 'enviado', 'cancelado')" 1 ;;
  sem_hash)             sabotar "        AND so.hash_payload LIKE 'omie\\_%'
" "" 1 ;;
  sem_deleted)          sabotar "AND so.deleted_at IS NULL" "" 1 ;;
  sem_conta)            sabotar "AND so.account = lower(p_empresa)" "" 1 ;;
  sem_janela)           sabotar "AND so.omie_reconciliado_em > now() - make_interval(hours => v_comp_horas)" "" 1 ;;
  janela_7d)            sabotar "make_interval(hours => v_comp_horas)" "interval '7 days'" 1 ;;
  sem_tipo)             sabotar "CASE WHEN jsonb_typeof(it->'quantidade') = 'number' THEN (it->>'quantidade')::numeric END" "(it->>'quantidade')::numeric" 1 ;;
  sem_positivo)         sabotar "WHERE x.q > 0 AND x.q < 1e9" "WHERE x.q < 1e9" 1 ;;
  sem_parcial)          sabotar "AND s2.hash_payload LIKE 'omie\\_%' AND s2.id <> so.id)" "AND s2.hash_payload LIKE 'omie\\_%' AND s2.id <> so.id AND false)" 1 ;;
  sem_numero)           sabotar "AND so.omie_numero_pedido IS NOT NULL" "" 1 ;;
  # O guard do JOIN (cp só casa ea.grupo_id IS NULL) é REDUNDANTE por construção: no grupo o efetivo e o gatilho
  # vêm de ge.estoque_grupo, que não lê cp — sabotá-lo fica VERDE (medido 2026-10-10). W1 prova a PROPRIEDADE
  # (grupo idêntico ao antigo); a camada que decide o rastro do grupo é o CASE, e é ela que se sabota aqui.
  rastro_no_grupo)      sabotar "CASE WHEN ea.grupo_id IS NULL AND v_comp_ativo THEN" "CASE WHEN v_comp_ativo THEN" 1 ;;
  gatilho_sem_desconto) sabotar "                   - COALESCE(cp.qtde, 0)) <= sp.ponto_pedido" "                   ) <= sp.ponto_pedido" 1 ;;
  efetivo_sem_desconto) sabotar "                    - COALESCE(cp.qtde, 0)) AS estoque_efetivo," "                    ) AS estoque_efetivo," 1 ;;
  rastro_ausente)       sabotar "sn.fator_embalagem_portal, sn.estoque_comprometido" "sn.fator_embalagem_portal, NULL::numeric" 1 ;;
  desligador_ignora)    sabotar "WHERE key = 'reposicao_comprometido_' || lower(p_empresa) || '_ativo' LIMIT 1)" "WHERE false LIMIT 1)" 1 ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# ════════════════════════════════════════════════════════════════════════════════════════════════════════
# O MOTOR EXECUTADO — numa transação que VOLTA ATRÁS; lê as linhas gravadas em pedido_compra_item.
# Linha: sku|qtde_sugerida|qtde_final|estoque_atual|estoque_comprometido(NULL→N). Nenhuma linha = 'AUSENTE'
# (valor afirmado, não vazio: o motor RODOU e não sugeriu).
# ════════════════════════════════════════════════════════════════════════════════════════════════════════
linhas() {   # <motor> <filtro SQL sobre i.sku_codigo_omie> [<SQL antes, na mesma transação>]
  Pq -q -c "BEGIN" -c "${3:-SET LOCAL client_min_messages TO warning}" \
     -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.$1('OBEN', DATE '2026-10-09')" \
     -c "SELECT COALESCE(string_agg(format('%s|%s|%s|%s|%s', i.sku_codigo_omie, trim_scale(i.qtde_sugerida), trim_scale(i.qtde_final),
                trim_scale(i.estoque_atual), COALESCE(trim_scale(i.estoque_comprometido)::text, 'N')), ';' ORDER BY i.sku_codigo_omie), 'AUSENTE')
           FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id
          WHERE p.data_ciclo = DATE '2026-10-09' AND ($2)" \
     -c "ROLLBACK" 2>&1 || true
}
# As colunas que o motor ANTIGO também grava, cruas (o controle byte a byte).
linhas_cru() {   # <motor> <filtro>
  Pq -q -c "BEGIN" -c "SET LOCAL client_min_messages TO warning" \
     -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.$1('OBEN', DATE '2026-10-09')" \
     -c "SELECT COALESCE(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', i.sku_codigo_omie, i.qtde_sugerida, i.qtde_final, i.preco_unitario,
                i.valor_linha, i.estoque_fisico, i.estoque_a_caminho, i.qtde_sem_teto, i.estoque_atual), ';' ORDER BY i.sku_codigo_omie), 'AUSENTE')
           FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id
          WHERE p.data_ciclo = DATE '2026-10-09' AND ($2)" \
     -c "ROLLBACK" 2>&1 || true
}
NOVO=gerar_pedidos_sugeridos_ciclo
ANT=motor_antigo
sku() { echo "i.sku_codigo_omie = '$1'"; }

echo "── S: positivos"
eq S0 "o ANTIGO não comprava o S1 (físico 10 > pp 9 — o vendido não existia para ele)" "$(linhas $ANT "$(sku 7101)")" "AUSENTE"
eq S1 "NOVO: 10 − 4 vendido = 6 ≤ 9 → compra 16 − 6 = 10, rastro 4" "$(linhas $NOVO "$(sku 7101)")" "7101|10|10|6|4"
eq S2 "dois itens num pedido + um noutro somam 4: 8 − 4 = 4 → compra 12" "$(linhas $NOVO "$(sku 7102)")" "7102|12|12|4|4"
eq S3 "efetivo NEGATIVO sem clamp: 2 − 5 = −3 → compra 6 + 3 = 9" "$(linhas $NOVO "$(sku 7103)")" "7103|9|9|-3|5"
eq B1 "relido há 35 h está na janela: 8 − 4 → compra 12" "$(linhas $NOVO "$(sku 7124)")" "7124|12|12|4|4"

echo "── F: o pedido de 4 NÃO conta (compra 8, rastro 0)"
F=(""
   "7111:faturado (já baixou o físico)"
   "7112:cancelado"
   "7113:criado no app (push, sem hash Omie)"
   "7114:deletado"
   "7115:de OUTRA conta (colacor)"
   "7116:relido há 37 h (fora da janela)"
   "7117:nunca relido"
   "7118:quantidade em TEXTO"
   "7119:quantidade negativa"
   "7120:quantidade zero"
   "7121:número repetido (faturamento parcial: origem aberta + irmão faturado)"
   "7122:items que não é array"
   "7123:pedido sem número")
for n in $(seq 1 13); do
  s="${F[$n]%%:*}"; d="${F[$n]#*:}"
  eq "F$n" "$d" "$(linhas $NOVO "$(sku "$s")")" "$s|8|8|8|0"
done

echo "── W: grupo WP (em L) — o desconto NÃO se aplica"
iguais W1 "grupo com 2 vendidos no QT: byte-idêntico ao antigo" "$(linhas_cru $ANT "i.sku_codigo_omie LIKE '720%'")" "$(linhas_cru $NOVO "i.sku_codigo_omie LIKE '720%'")"
eq W2 "rastro NULL no SKU de grupo (não '0': o desconto não foi calculado)" \
  "$(linhas $NOVO "i.sku_codigo_omie LIKE '720%'" | cut -d'|' -f5)" "N"

echo "── T/M/N: teto, mínimo forçado e gate de estoque com o efetivo descontado"
eq T1 "teto C (30 d × 0,1) com piso de serviço: max(floor(3 − 6), ceil(9 − 6)) = 3; sugerida 10" "$(linhas $NOVO "$(sku 7130)")" "7130|10|3|6|4"
eq M2 "mínimo forçado 20 vence a necessidade 10" "$(linhas $NOVO "$(sku 7131)")" "7131|10|20|6|4"
eq N1 "estoque só-semente: suprimido e LOGADO com o efetivo descontado (6)" \
  "$(Pq -q -c "BEGIN" -c "SET LOCAL client_min_messages TO warning" \
        -c "CREATE TEMP TABLE r AS SELECT * FROM public.$NOVO('OBEN', DATE '2026-10-09')" \
        -c "SELECT COALESCE(string_agg(trim_scale(estoque_efetivo)::text || '/' || (SELECT count(*) FROM pedido_compra_item WHERE sku_codigo_omie = '7132'), ','), 'AUSENTE') FROM reposicao_estoque_nao_confirmado_log WHERE sku_codigo_omie = '7132'" \
        -c "ROLLBACK" 2>&1 || true)" "6/0"

echo "── K: desligador por empresa"
K_OFF="INSERT INTO company_config (key, value) VALUES ('reposicao_comprometido_oben_ativo', 'false')"
K_LIXO="INSERT INTO company_config (key, value) VALUES ('reposicao_comprometido_oben_ativo', 'sim')"
K_ON="INSERT INTO company_config (key, value) VALUES ('reposicao_comprometido_oben_ativo', ' TRUE ')"
eq K1 "'false' desliga: S2 volta a 8 (16 − 8), rastro NULL" "$(linhas $NOVO "$(sku 7102)" "$K_OFF")" "7102|8|8|8|N"
eq K2 "valor lixo ('sim') desliga" "$(linhas $NOVO "$(sku 7102)" "$K_LIXO")" "7102|8|8|8|N"
eq K3 "' TRUE ' liga (caixa e espaço normalizados)" "$(linhas $NOVO "$(sku 7102)" "$K_ON")" "7102|12|12|4|4"
iguais K4 "desligado = motor antigo, byte a byte, no universo inteiro" \
  "$(linhas_cru $ANT "true")" \
  "$(Pq -q -c "BEGIN" -c "$K_OFF" -c "SET LOCAL client_min_messages TO warning" \
        -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.$NOVO('OBEN', DATE '2026-10-09')" \
        -c "SELECT COALESCE(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', i.sku_codigo_omie, i.qtde_sugerida, i.qtde_final, i.preco_unitario,
                i.valor_linha, i.estoque_fisico, i.estoque_a_caminho, i.qtde_sem_teto, i.estoque_atual), ';' ORDER BY i.sku_codigo_omie), 'AUSENTE')
              FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id WHERE p.data_ciclo = DATE '2026-10-09'" \
        -c "ROLLBACK" 2>&1 || true)"

echo "── R: o botão — staff (authenticated, RLS, ACL por coluna de prod) roda o motor"
# 42501 no SELECT de sales_orders vira o VALOR 'NEGADO' (resultado, não erro de execução): é o que a sabotagem
# sem_grant tem de produzir. Qualquer outro erro segue inválido.
r1="$(Pq -q -c "BEGIN" -c "SET LOCAL client_min_messages TO warning" -c "SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111'" \
          -c "SET LOCAL ROLE authenticated" -c "SELECT current_user" \
          -c "CREATE TEMP TABLE r_motor AS SELECT * FROM public.$NOVO('OBEN', DATE '2026-10-09')" \
          -c "SELECT COALESCE(string_agg(format('%s|%s|%s|%s|%s', i.sku_codigo_omie, trim_scale(i.qtde_sugerida), trim_scale(i.qtde_final),
                trim_scale(i.estoque_atual), COALESCE(trim_scale(i.estoque_comprometido)::text, 'N')), ';' ORDER BY i.sku_codigo_omie), 'AUSENTE')
                FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id = i.pedido_id
               WHERE p.data_ciclo = DATE '2026-10-09' AND i.sku_codigo_omie IN ('7101','7116')" \
          -c "ROLLBACK" 2>&1 || true)"
case "$r1" in
  *"permission denied for table sales_orders"*|*"permissão negada para tabela sales_orders"*) r1="NEGADO" ;;
  authenticated$'\n'*) r1="${r1#authenticated$'\n'}" ;;
  *) r1="ERRO: papel não confirmado ou falha alheia: $r1" ;;
esac
eq R1 "como STAFF: S1 compra 10 (rastro 4) e o relido há 37 h segue fora — igual ao cron" "$r1" "7101|10|10|6|4;7116|8|8|8|0"

echo "── X: tudo sem pedido elegível — byte-idêntico ao motor antigo"
POS="('7101','7102','7103','7124','7130','7131')"
iguais X1 "universo fora dos positivos (inclui os 13 filtros, o grupo e o resto): idêntico" \
  "$(linhas_cru $ANT "i.sku_codigo_omie NOT IN $POS")" "$(linhas_cru $NOVO "i.sku_codigo_omie NOT IN $POS")"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$PASS" -ne "$TOTAL_ESPERADO" ] && [ "$FAIL" -eq 0 ]; then
  echo "❌ $PASS asserts executados, esperados $TOTAL_ESPERADO — a prova foi TRUNCADA (FAIL=0 com PASS encolhido não é verde)"
  exit 1
fi
[ "$FAIL" -eq 0 ]
