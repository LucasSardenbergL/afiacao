#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: qtde_final ja sai no MULTIPLO DA EMBALAGEM do portal (litro -> balde).
# Lacuna: o comprador aprovava 36 L e so via 40 L depois do envio (a edge normaliza no envio, #2149).
# Rodar: bash db/test-qtde-multiplo-embalagem.sh > log 2>&1; echo "exit=$?"  (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica as MIGRATIONS REAIS (base 20260730130000 + a nova); asserts numericos por cenario;
# FALSIFICA (sabota a funcao extraida DA PROPRIA migration -> exige vermelho ESPECIFICO -> restaura).
# Sentinelas ASCII, caixa fixa; a sentinela nunca contem texto que a funcao emite.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="qtde-multiplo-embalagem"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260730130000_reposicao_teto_cobertura_motor.sql"
MIG="$REPO_ROOT/supabase/migrations/20260904232555_reposicao_qtde_multiplo_embalagem_portal.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$SAB_DIR"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null || { echo "pg_ctl NAO subiu na :$PORT (porta ocupada?) — abortando, nao testo contra outro Postgres"; exit 1; }
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ── ZONA 1: roles/schemas + stubs das tabelas que a funcao LE (espelham a prod) ──
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
-- espelha a prod: UNIQUE (empresa, fornecedor_nome, sku_omie); fator_conversao numeric DEFAULT 1
CREATE TABLE public.sku_fornecedor_externo (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, sku_omie text, sku_portal text,
  unidade_portal text DEFAULT 'UN', fator_conversao numeric NOT NULL DEFAULT 1, ativo boolean DEFAULT true,
  UNIQUE (empresa, fornecedor_nome, sku_omie));
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
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

# ── ZONA 2: MIGRATIONS REAIS, na ordem (base cria log do teto/ALTERs/config; a nova recria a funcao = a que vence) ──
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") -> $(basename "$MIG")"

# fixture de falsificacao = a funcao EXTRAIDA DA PROPRIA MIGRATION (nao um arquivo paralelo que pode divergir)
FIXTURE="$SAB_DIR/fn-real.sql"
awk '/^CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo/{p=1} p{print} p&&/^\$function\$;/{exit}' "$MIG" > "$FIXTURE"
eq "fixture extraida da migration termina no \$function\$;" "$(tail -1 "$FIXTURE")" "\$function\$;"

# baseline: a funcao VIVA e a nova + a coluna existe (detector com objeto vivo, nao grep de arquivo)
eq "funcao viva grava fator_embalagem_portal" \
   "$(Pq -c "SELECT (pg_get_functiondef(oid) LIKE '%fator_embalagem_portal%')::text FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "true"
eq "coluna pedido_compra_item.fator_embalagem_portal existe" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='pedido_compra_item' AND column_name='fator_embalagem_portal'")" "1"
eq "migration e idempotente (2a colada nao quebra)" "$(P -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo FALHOU)" "ok"

# ── ZONA 3: seeds — 1 SKU por cenario. Todos: pp=19, max=36, fisico=0 confirmado, classe A (sem teto), fornecedor Sayerlack. ──
#   9301 balde 5 L (fator 0,2)             -> 36 L vira 40 L (8 BB)
#   9302 multiplo exato (max=40)           -> 40 fica 40 (nao infla)
#   9303 galao 3,6 L (fator 1/3,6)         -> 36 L fica 36 (10 GL); SEM round6 antes do ceil daria 39,6
#   9304 em grupo QT<->GL + de-para 0,2    -> NAO arredonda (qtde_final ja e embalagem)
#   9305 fator 1                           -> NAO arredonda, coluna NULL
#   9306 minimo_forcado_manual 41          -> 41 L vira 45 L (natural 36 daria 40: o minimo TEM de ser visivel)
#   9307 teto de cobertura B/27d (cap 27)  -> 27 L vira 30 L; sem_teto 36 -> 40; capada + log em L-arredondado
#   9308 de-para INATIVO com fator 0,2     -> NAO arredonda
#   9309 de-para de OUTRO fornecedor 0,2   -> NAO arredonda (precisao > recall)
#   9310 fator NaN                         -> NAO arredonda (guard de finitude)
#   9311 fator 1/3 (16 digitos), max=9     -> 9 (paridade com o round6 externo do TS; sem ele 9,0000000000000009)
#   9312 fator Infinity                    -> NAO arredonda (a MESMA guarda de finitude que barra NaN)
#   9313 fator minusculo 0,0000004, q=1     -> 1 embalagem (2.500.000 L), NUNCA zero: sem GREATEST(1,.) a linha sumiria
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto)
SELECT g, 'oben', 'S'||g, 'Tintas', true, '00' FROM generate_series(9301,9314) g;
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);

INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
SELECT 'OBEN', g, 'S'||g, 'Sayerlack', 19, 36, NULL, true, 'automatica', 1, 'A', NULL
FROM generate_series(9301,9313) g;
UPDATE sku_parametros SET estoque_maximo = 40 WHERE sku_codigo_omie = 9302;
UPDATE sku_parametros SET minimo_forcado_manual = 41 WHERE sku_codigo_omie = 9306;
UPDATE sku_parametros SET classe_abc = 'B' WHERE sku_codigo_omie = 9307;
UPDATE sku_parametros SET ponto_pedido = 5, estoque_maximo = 9 WHERE sku_codigo_omie = 9311;
UPDATE sku_parametros SET ponto_pedido = 0, estoque_maximo = 1 WHERE sku_codigo_omie = 9313;

INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
SELECT 'OBEN', g::text, 0, 0, 'ListarPosEstoque' FROM generate_series(9301,9313) g;

-- preco medio historico (R$10/L) so p/ o 9301: prova valor_linha = 40 x 10
INSERT INTO sku_leadtime_history VALUES ('OBEN','9301',10,100);

-- de-para do portal (empresa UPPER, como em prod)
INSERT INTO sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo) VALUES
 ('OBEN','Sayerlack','9301','TEH.3505.00BB','BB',0.2,true),
 ('OBEN','Sayerlack','9302','X02','BB',0.2,true),
 ('OBEN','Sayerlack','9303','X03','GL',(1::numeric/3.6),true),
 ('OBEN','Sayerlack','9304','X04','QT',0.2,true),
 ('OBEN','Sayerlack','9305','X05','UN',1,true),
 ('OBEN','Sayerlack','9306','X06','BB',0.2,true),
 ('OBEN','Sayerlack','9307','X07','BB',0.2,true),
 ('OBEN','Sayerlack','9308','X08','BB',0.2,false),
 ('OBEN','Outro Fornecedor','9309','X09','BB',0.2,true),
 ('OBEN','Sayerlack','9310','X10','BB','NaN'::numeric,true),
 ('OBEN','Sayerlack','9311','X11','CX',0.3333333333333333,true),
 ('OBEN','Sayerlack','9312','X12','BB','Infinity'::numeric,true),
 ('OBEN','Sayerlack','9313','X13','TQ',0.0000004,true);

-- 9304 em grupo de equivalencia (QT fator 1 + GL fator 4), empresa LOWER como em prod
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','11111111-1111-1111-1111-111111111111','9304',1,true),
 ('oben','11111111-1111-1111-1111-111111111111','9314',4,true);

-- teto de cobertura ligado p/ classe B (27 dias): so o 9307 e B
INSERT INTO company_config (key, value) VALUES
 ('reposicao_teto_cobertura_oben_ativa','true'),
 ('reposicao_teto_cobertura_oben_dias_b','27')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;   -- a migration-base ja semeia as chaves
SQL
echo "seeds ok"

run_ciclo() { Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos"; }
# coluna do item gerado no ciclo (pendente_aprovacao), ou AUSENTE. $4 = expressao SQL sobre pci
col() { Pq -c "SELECT COALESCE((SELECT ($4)::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
qf()  { col "$1" "$2" "$3" "pci.qtde_final"; }
qs()  { col "$1" "$2" "$3" "pci.qtde_sugerida"; }
qst() { col "$1" "$2" "$3" "pci.qtde_sem_teto"; }
fe()  { col "$1" "$2" "$3" "COALESCE(pci.fator_embalagem_portal::text,'NULO')"; }
vl()  { col "$1" "$2" "$3" "trim_scale(pci.valor_linha)"; }   # AVG do preco medio carrega escala 16
teto(){ col "$1" "$2" "$3" "pci.teto_cobertura_aplicado"; }

D=2026-09-05
echo "=== R1: ciclo com a migration aplicada ==="
run_ciclo OBEN $D >/dev/null
eq "S1 balde: qtde_final 36 L -> 40 L (8 BB)"                    "$(qf  OBEN $D 9301)" "40"
eq "S1 balde: qtde_sugerida segue 36 (rastro em L)"              "$(qs  OBEN $D 9301)" "36"
eq "S1 balde: qtde_sem_teto tambem 40 (mesma unidade)"           "$(qst OBEN $D 9301)" "40"
eq "S1 balde: fator gravado 0.2 (causa visivel na tela)"         "$(fe  OBEN $D 9301)" "0.2"
eq "S1 balde: valor_linha = 40 x R\$10 (compra FISICA)"          "$(vl  OBEN $D 9301)" "400"
eq "S1 balde: NAO e capada pelo teto (final = sem_teto)"         "$(teto OBEN $D 9301)" "false"
eq "S2 multiplo exato: 40 fica 40 (nao infla um balde)"          "$(qf  OBEN $D 9302)" "40"
eq "S2 multiplo exato: fator gravado mesmo sem mudar o numero"   "$(fe  OBEN $D 9302)" "0.2"
eq "S3 galao 3,6 L: 36 L fica 36 (10 GL; round6 mata a poeira)"  "$(qf  OBEN $D 9303)" "36"
eq "S4 em grupo QT<->GL: NAO arredonda (ja e embalagem)"         "$(qf  OBEN $D 9304)" "36"
eq "S4 em grupo: coluna NULL"                                    "$(fe  OBEN $D 9304)" "NULO"
eq "S5 fator 1: NAO arredonda"                                   "$(qf  OBEN $D 9305)" "36"
eq "S5 fator 1: coluna NULL"                                     "$(fe  OBEN $D 9305)" "NULO"
eq "S6 minimo forcado 41 L -> 45 L (nao 40 do natural)"         "$(qf  OBEN $D 9306)" "45"
eq "S7 teto B/27d: cap 27 L -> 30 L (6 BB)"                      "$(qf  OBEN $D 9307)" "30"
eq "S7 teto: sem_teto 36 L -> 40 L"                              "$(qst OBEN $D 9307)" "40"
eq "S7 teto: segue marcada como capada (30 < 40)"                "$(teto OBEN $D 9307)" "true"
eq "S7 teto: log do teto guarda o par na unidade arredondada"    "$(Pq -c "SELECT qtde_final::text||'/'||qtde_sem_teto::text FROM reposicao_teto_cobertura_log WHERE sku_codigo_omie='9307'")" "30/40"
eq "S8 de-para INATIVO: NAO arredonda"                           "$(qf  OBEN $D 9308)" "36"
eq "S9 de-para de OUTRO fornecedor: NAO arredonda"               "$(qf  OBEN $D 9309)" "36"
eq "S10 fator NaN: NAO arredonda (guard de finitude)"            "$(qf  OBEN $D 9310)" "36"
eq "S11 fator 1/3 em 16 digitos: 9 fica 9 (round6 externo)"      "$(qf  OBEN $D 9311)" "9"
eq "S12 fator Infinity: NAO arredonda (guard de finitude)"       "$(qf  OBEN $D 9312)" "36"
eq "S13 fator minusculo: 1 embalagem, nunca zero (linha nao some)" "$(qf  OBEN $D 9313)" "2500000"
eq "R1 13 SKUs no pedido (nenhum sumiu por causa da conversao)"  "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='$D' AND pcs.status='pendente_aprovacao'")" "13"
eq "R1 cabecalho valor_total soma as linhas na compra FISICA"     "$(Pq -c "SELECT (valor_total = (SELECT SUM(valor_linha) FROM pedido_compra_item pci WHERE pci.pedido_id = pcs.id))::text FROM pedido_compra_sugerido pcs WHERE data_ciclo='$D' AND status='pendente_aprovacao'")" "true"

echo "=== R2: o 40 aprovado conta como estoque a caminho no ciclo seguinte (anti compra dupla) ==="
P -q -c "UPDATE pedido_compra_sugerido SET status='aprovado_aguardando_disparo', status_envio_portal='nao_aplicavel' WHERE data_ciclo='$D';"
# pp sobe p/ 38: 40 a caminho > 38 suprime; se o motor ainda gravasse 36, 36 <= 38 re-sugeriria (discrimina 36 de 40)
P -q -c "UPDATE sku_parametros SET ponto_pedido = 38 WHERE sku_codigo_omie = 9301;"
run_ciclo OBEN 2026-09-06 >/dev/null
eq "R2 S1: 40 L a caminho > pp 38 -> nao re-sugere (36 re-sugeriria)" "$(qf OBEN 2026-09-06 9301)" "AUSENTE"
P -q -c "UPDATE sku_parametros SET ponto_pedido = 19 WHERE sku_codigo_omie = 9301;"

echo "=== FALSIFICACOES (baseline verde acima; cada sabotagem exige vermelho ESPECIFICO e restaura) ==="
falsifica() {  # $1=nome  $2=sed-expr  $3=descricao  $4=query  $5=valor_sabotado_esperado
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  P -q -f "$SAB_DIR/$nome.sql" 2>/dev/null || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM pedido_compra_sugerido; DELETE FROM reposicao_motor_run; DELETE FROM reposicao_teto_cobertura_log;" >/dev/null
  run_ciclo OBEN 2026-09-07 >/dev/null
  local veio; veio="$(eval "$query")"
  if [ "$veio" = "$esperado_sab" ]; then ok "FALSIF $nome pegou a sabotagem ($3)"; else bad "FALSIF $nome NAO detectou — esperado sob sabotagem [$esperado_sab], veio [$veio]"; fi
  P -q -f "$FIXTURE"   # restaura a funcao REAL
}

# F1: arredondamento morto (equivale a REVERTER a correcao) -> S1 volta a 36 L.
falsifica "F1-arredondamento-morto" \
  "s/^           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0\$/           CASE WHEN false/" \
  "sem a correcao o comprador volta a aprovar 36 L" \
  "qf OBEN 2026-09-07 9301" "36"

# F2: derruba a guarda de GRUPO -> o SKU em grupo QT<->GL (ja em embalagens) seria multiplicado de novo.
falsifica "F2-sem-guarda-grupo" \
  "s/^             CASE WHEN b0.equiv_grupo IS NULL THEN b0.fator_portal ELSE NULL END AS fator_embalagem,\$/             b0.fator_portal AS fator_embalagem,/" \
  "sem a guarda, concentrado em grupo compraria 40 embalagens em vez de 36" \
  "qf OBEN 2026-09-07 9304" "40"

# F3: remove o round6 ANTES do ceil -> 36 x (1/3,6) = 10,000...008 -> ceil 11 -> 39,6 L (um galao a mais).
falsifica "F3-sem-round6-interno" \
  "s/THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_final \* sd.fator_embalagem, 6))) \/ sd.fator_embalagem, 6))/THEN trim_scale(round(GREATEST(1, ceil(sd.qtde_final * sd.fator_embalagem)) \/ sd.fator_embalagem, 6))/" \
  "sem round6 a poeira numerica compra um galao a mais" \
  "qf OBEN 2026-09-07 9303" "39.6"

# F4: derruba a guarda de ATIVO do de-para -> mapeamento desativado voltaria a decidir a embalagem.
falsifica "F4-sem-guarda-ativo" \
  "s/^    WHERE empresa = p_empresa AND ativo = TRUE\$/    WHERE empresa = p_empresa/" \
  "de-para inativo nao pode decidir" \
  "qf OBEN 2026-09-07 9308" "40"

# F5: derruba a guarda de FORNECEDOR -> de-para de outro fornecedor decidiria esta compra.
falsifica "F5-sem-guarda-fornecedor" \
  "s/ AND pf.fornecedor_nome = sp.fornecedor_nome\$//" \
  "de-para de outro fornecedor nao pode decidir" \
  "qf OBEN 2026-09-07 9309" "40"

# F6: derruba a UNICA guarda de finitude -> NaN > 0 e TRUE em Postgres: NaN passaria a qtde_final do item
#     (e Infinity viraria NaN via Inf/Inf). Uma guarda so, de proposito: duas defesas independentes fariam
#     esta falsificacao mentir (sabotar uma nao fica vermelho).
falsifica "F6-sem-guarda-finitude" \
  "s/^      AND fator_conversao < 1e9   -- UMA guarda de finitude.*\$/      AND true/" \
  "fator NaN viraria quantidade NaN no pedido" \
  "qf OBEN 2026-09-07 9310" "NaN"
falsifica "F6b-sem-guarda-finitude-inf" \
  "s/^      AND fator_conversao < 1e9   -- UMA guarda de finitude.*\$/      AND true/" \
  "fator Infinity viraria quantidade NaN no pedido" \
  "qf OBEN 2026-09-07 9312" "NaN"

# F7: derruba o piso GREATEST(1, .) -> fator minusculo zera a linha e ela SOME do pedido (subcompra silenciosa).
falsifica "F7-sem-piso-1-embalagem" \
  "s/THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_final \* sd.fator_embalagem, 6))) \/ sd.fator_embalagem, 6))/THEN trim_scale(round(ceil(round(sd.qtde_final * sd.fator_embalagem, 6)) \/ sd.fator_embalagem, 6))/" \
  "sem o piso a necessidade some do pedido" \
  "qf OBEN 2026-09-07 9313" "AUSENTE"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
