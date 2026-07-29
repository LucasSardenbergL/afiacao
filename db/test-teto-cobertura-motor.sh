#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: TETO DE COBERTURA pós-compra (B/C, cap só-reduz).
# Spec: docs/superpowers/specs/2026-07-29-reposicao-teto-cobertura-motor-spec.md
# Rodar: bash db/test-teto-cobertura-motor.sh > log 2>&1; echo "exit=$?"   (NÃO pipe pra tail — engole exit)
# Lei de Ferro: aplica a MIGRATION REAL (20260730130000 — DDL do log + config + funcao); asserts numericos;
# FALSIFICA (sabota -> exige vermelho ESPECIFICO -> restaura -> re-verde). Sentinelas ASCII, caixa fixa.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="teto-cobertura"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260730130000_reposicao_teto_cobertura_motor.sql"
FIXTURE="$REPO_ROOT/db/embalagem-motor-rpc.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ── ZONA 1: roles/schemas que a MIGRATION exige + stubs de tabela (espelham a prod no que a funcao le) ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE SCHEMA private;
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric, fonte_sync text);
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean);
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, sku_omie text, sku_portal text, ativo boolean);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
-- prod tem UNIQUE(key) — o seed da migration usa ON CONFLICT (key) (stub espelha a PROD, money-path.md)
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric, lt_logistica_dias int);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric NOT NULL DEFAULT 0, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
SQL
echo "stubs criados"

# ── ZONA 2: aplicar a MIGRATION REAL (DDL do log + ALTERs + config + funcao) ──
P -q -f "$MIG"
echo "migration aplicada"

# Estrutura minima do que a migration criou (detector com baseline: objeto VIVO)
eq "log criado com RLS" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE relname='reposicao_teto_cobertura_log'")" "t"
eq "policies do log (sel+ins)" "$(Pq -c "SELECT count(*) FROM pg_policy WHERE polrelid='public.reposicao_teto_cobertura_log'::regclass")" "2"
eq "config semeada dormente" "$(Pq -c "SELECT value FROM company_config WHERE key='reposicao_teto_cobertura_oben_ativa'")" "false"

# ── ZONA 3: seeds ──
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (9001,'oben','CZ DENTE QT','Abrasivos',true,'00'),
 (9002,'oben','CZ ZERADO QT','Abrasivos',true,'00'),
 (9003,'oben','B PARCIAL QT','Abrasivos',true,'00'),
 (9004,'oben','A LIVRE QT','Abrasivos',true,'00'),
 (9005,'oben','C MINFORC QT','Abrasivos',true,'00'),
 (9006,'oben','C SEM DEMANDA QT','Abrasivos',true,'00'),
 (9007,'oben','C PP ALTO QT','Abrasivos',true,'00'),
 (9009,'oben','A FORCADA C QT','Abrasivos',true,'00'),
 (9101,'oben','GRUPO WP QT','Concentrados',true,'00'),
 (9102,'oben','GRUPO WP GL','Concentrados',true,'00'),
 (7001,'colacor','C COLACOR QT','Abrasivos',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7),
 ('COLACOR','Fornecedor X', interval '18:00:00', 7);

-- classe/demanda/pp/max desenhados p/ cada cenario (estoque em sku_estoque_atual, fonte confirmada)
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada) VALUES
 ('OBEN',9001,'CZ DENTE QT','Sayerlack',1,2,NULL,true,'automatica',0.005,'C',NULL),
 ('OBEN',9002,'CZ ZERADO QT','Sayerlack',1,2,NULL,true,'automatica',0.005,'C',NULL),
 ('OBEN',9003,'B PARCIAL QT','Sayerlack',3,20,NULL,true,'automatica',0.1,'B',NULL),
 ('OBEN',9004,'A LIVRE QT','Sayerlack',1,8,NULL,true,'automatica',0.01,'A',NULL),
 ('OBEN',9005,'C MINFORC QT','Sayerlack',1,2,10,true,'automatica',0.005,'C',NULL),
 ('OBEN',9006,'C SEM DEMANDA QT','Sayerlack',2,6,NULL,true,'automatica',NULL,'C',NULL),
 ('OBEN',9007,'C PP ALTO QT','Sayerlack',4,6,NULL,true,'automatica',0.02,'C',NULL),
 ('OBEN',9009,'A FORCADA C QT','Sayerlack',1,3,NULL,true,'automatica',0.005,'A','C'),
 ('OBEN',9101,'GRUPO WP QT','Sayerlack',1,4,NULL,true,'automatica',0.005,'C',NULL),
 ('COLACOR',7001,'C COLACOR QT','Fornecedor X',1,3,NULL,true,'automatica',0.005,'C',NULL);

INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
 ('OBEN','9001',1,0,'ListarPosEstoque'),
 ('OBEN','9002',0,0,'ListarPosEstoque'),
 ('OBEN','9003',2,0,'ListarPosEstoque'),
 ('OBEN','9004',1,0,'ListarPosEstoque'),
 ('OBEN','9005',1,0,'ListarPosEstoque'),
 ('OBEN','9006',1,0,'ListarPosEstoque'),
 ('OBEN','9007',0,0,'ListarPosEstoque'),
 ('OBEN','9009',1,0,'ListarPosEstoque'),
 ('OBEN','9101',1,0,'ListarPosEstoque'),
 ('OBEN','9102',0,0,'ListarPosEstoque'),
 ('COLACOR','7001',1,0,'ListarPosEstoque');

-- grupo de embalagem QT+GL (ancora 9101 fator 1, galao 9102 fator 4) → grupo NAO recebe cap
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','11111111-1111-1111-1111-111111111111','9101',1,true),
 ('oben','11111111-1111-1111-1111-111111111111','9102',4,true);
SQL
echo "seeds ok"

run_ciclo() { Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos"; }
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
qst() { Pq -c "SELECT COALESCE((SELECT pci.qtde_sem_teto::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
qcap() { Pq -c "SELECT COALESCE((SELECT pci.teto_cobertura_aplicado::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }

echo "=== R1: flag DORMENTE (false) — comportamento IDENTICO ao motor sem teto ==="
run_ciclo OBEN 2026-07-01 >/dev/null
eq "R1 T1 dente 1-2 compra 1 (sem cap)" "$(qf OBEN 2026-07-01 9001)" "1"
eq "R1 T3 B compra necessidade cheia 18" "$(qf OBEN 2026-07-01 9003)" "18"
eq "R1 T7 pp alto compra 6" "$(qf OBEN 2026-07-01 9007)" "6"
eq "R1 log do teto VAZIO" "$(Pq -c "SELECT count(*) FROM reposicao_teto_cobertura_log")" "0"
eq "R1 capados_n=0 no marker" "$(Pq -c "SELECT capados_n FROM reposicao_motor_run ORDER BY criado_em DESC LIMIT 1")" "0"
eq "R1 item nasce teto_cobertura_aplicado=false" "$(qcap OBEN 2026-07-01 9001)" "false"

echo "=== R2: flag LIGADA (b=90, c=60) ==="
P -q -c "UPDATE company_config SET value='true' WHERE key='reposicao_teto_cobertura_oben_ativa';"
run_ciclo OBEN 2026-07-02 >/dev/null
# T1: C d=0.005 teto 60 -> 0.3; estoque 1 >= pp 1 -> piso 0; cap 0 -> linha some do pedido + log capado_zero
eq "R2 T1 dente 1-2 SOME do pedido" "$(qf OBEN 2026-07-02 9001)" "AUSENTE"
eq "R2 T1 log capado_zero" "$(Pq -c "SELECT motivo FROM reposicao_teto_cobertura_log WHERE sku_codigo_omie='9001' AND empresa='OBEN'")" "capado_zero"
# T2: estoque 0 -> piso de servico ceil(1-0)=1 -> compra 1 (nao 2); log capado_parcial
eq "R2 T2 estoque zero compra 1 (piso servico)" "$(qf OBEN 2026-07-02 9002)" "1"
eq "R2 T2 qtde_sem_teto=2" "$(qst OBEN 2026-07-02 9002)" "2"
eq "R2 T2 teto_cobertura_aplicado=true" "$(qcap OBEN 2026-07-02 9002)" "true"
eq "R2 T2 log capado_parcial" "$(Pq -c "SELECT motivo FROM reposicao_teto_cobertura_log WHERE sku_codigo_omie='9002' AND empresa='OBEN'")" "capado_parcial"
# T3: B d=0.1 teto 90 -> 9; estoque 2 -> cap GREATEST(floor(9-2)=7, ceil(3-2)=1)=7; necessidade 18 -> 7
eq "R2 T3 B capado parcial a 7" "$(qf OBEN 2026-07-02 9003)" "7"
eq "R2 T3 qtde_sem_teto=18" "$(qst OBEN 2026-07-02 9003)" "18"
# T4: A sem teto -> intocado
eq "R2 T4 A intocado compra 7" "$(qf OBEN 2026-07-02 9004)" "7"
eq "R2 T4 A sem flag de teto" "$(qcap OBEN 2026-07-02 9004)" "false"
# T5: minimo forcado vence (10)
eq "R2 T5 min forcado vence o teto" "$(qf OBEN 2026-07-02 9005)" "10"
# T6: d NULL -> sem cap (compra 5)
eq "R2 T6 sem demanda sem cap" "$(qf OBEN 2026-07-02 9006)" "5"
# T7: pp=4 alto, teto*d=1.2, estoque 0 -> cap GREATEST(floor(1.2)=1, ceil(4-0)=4)=4 -> repoe ate o pp
eq "R2 T7 pp alto repoe ate o pp (4)" "$(qf OBEN 2026-07-02 9007)" "4"
eq "R2 T7 log registra parcial" "$(Pq -c "SELECT motivo FROM reposicao_teto_cobertura_log WHERE sku_codigo_omie='9007' AND empresa='OBEN'")" "capado_parcial"
# T9: classe_abc A + classe_forcada C -> capa como C (some: estoque 1 >= pp 1)
eq "R2 T9 classe forcada C capa" "$(qf OBEN 2026-07-02 9009)" "AUSENTE"
# T10: grupo de embalagem NAO capa (necessidade grupo: max 4 - estoque grupo 1 = 3)
eq "R2 T10 grupo fora do cap" "$(qf OBEN 2026-07-02 9101)" "3"
eq "R2 T10 grupo sem log de teto" "$(Pq -c "SELECT count(*) FROM reposicao_teto_cobertura_log WHERE sku_codigo_omie IN ('9101','9102')")" "0"
# marker do run com os capados de R2 (9001 zero + 9002 parcial + 9003 parcial + 9007 parcial + 9009 zero = 5)
eq "R2 capados_n=5 no marker" "$(Pq -c "SELECT capados_n FROM reposicao_motor_run WHERE empresa='OBEN' ORDER BY criado_em DESC LIMIT 1")" "5"

echo "=== R3: config lixo em dias_c ('60x') — fail-off SO da classe C; B segue capando ==="
P -q -c "UPDATE company_config SET value='60x' WHERE key='reposicao_teto_cobertura_oben_dias_c';"
run_ciclo OBEN 2026-07-03 >/dev/null
eq "R3 C sem cap (config lixo nao aborta, desliga C)" "$(qf OBEN 2026-07-03 9001)" "1"
eq "R3 B segue capado a 7" "$(qf OBEN 2026-07-03 9003)" "7"
P -q -c "UPDATE company_config SET value='60' WHERE key='reposicao_teto_cobertura_oben_dias_c';"

echo "=== R4: COLACOR intacta (config e por-empresa _oben_) ==="
run_ciclo COLACOR 2026-07-02 >/dev/null
eq "R4 COLACOR compra necessidade cheia 2" "$(qf COLACOR 2026-07-02 7001)" "2"
eq "R4 COLACOR sem log de teto" "$(Pq -c "SELECT count(*) FROM reposicao_teto_cobertura_log WHERE empresa='COLACOR'")" "0"

echo "=== FALSIFICACOES (baseline verde acima; cada sabotagem exige vermelho ESPECIFICO e restaura) ==="
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"

falsifica() {  # $1=nome  $2=sed-expr  $3=descricao do vermelho esperado  $4=query  $5=valor_sabotado_esperado
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  P -q -f "$SAB_DIR/$nome.sql" 2>/dev/null || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM reposicao_teto_cobertura_log; DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-07-05 >/dev/null
  local veio; veio="$(eval "$query")"
  if [ "$veio" = "$esperado_sab" ]; then ok "FALSIF $nome pegou a sabotagem ($3)"; else bad "FALSIF $nome NAO detectou — esperado sob sabotagem [$esperado_sab], veio [$veio]"; fi
  P -q -f "$FIXTURE"   # restaura a funcao REAL
}

# F1: remove o cap do ramo ELSE (LEAST vira so a necessidade) -> T3 volta a comprar 18
falsifica "F1-sem-least" \
  "s/ceil(LEAST(b.estoque_maximo - b.estoque_efetivo,/ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,/" \
  "cap removido faz B comprar 18" \
  "qf OBEN 2026-07-05 9003" "18"

# F2: remove o piso de servico (GREATEST(0, ceil(pp-est)) vira 0 fixo) -> T7 compra 1 em vez de 4
falsifica "F2-sem-piso" \
  "s/GREATEST(0, ceil(b0.ponto_pedido - b0.estoque_efetivo))/0/" \
  "sem piso de servico o pp alto compra so 1" \
  "qf OBEN 2026-07-05 9007" "1"

# F3: filtro de inseriveis sem qtde_final>0 -> linha capada a zero APARECE no pedido com qtde 0
falsifica "F3-sem-filtro-zero" \
  "s/WHERE sn.qtde_sugerida > 0 AND sn.qtde_final > 0 AND NOT sn.suprimido/WHERE sn.qtde_sugerida > 0 AND NOT sn.suprimido/" \
  "sem o filtro a linha zerada entra no pedido" \
  "qf OBEN 2026-07-05 9001" "0"

# F4: ignora a flag (v_teto_ativo := true fixo) -> R1-dormente capando (aqui: flag ON ja esta true; sabota o
#     sentido inverso: forca false -> teto some e T3 compra 18 mesmo com config ligada)
falsifica "F4-flag-morta" \
  "s/INTO v_teto_ativo;/INTO v_teto_ativo; v_teto_ativo := false;/" \
  "flag ignorada desliga o teto com config ligada" \
  "qf OBEN 2026-07-05 9003" "18"

rm -rf "$SAB_DIR"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
