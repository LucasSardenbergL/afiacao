#!/usr/bin/env bash
# Prova PG17 — [MEMBRO SEM LINHA]: no em_transito de gerar_pedidos_sugeridos_ciclo, o SKU SEM retrato próprio em
# sku_estoque_atual corta os pedidos do app pelo ÚLTIMO retrato da EMPRESA (o run do omie-sync-estoque que pulou o
# PO), e não pelo dia do ciclo. Residual do parecer Codex do PR #3969.
#
# Cenário (ciclo D2 = 2026-12-21, sync da véspera S = 2026-12-20): grupo de embalagem QT (âncora 9711, habilitada,
# retrato próprio) + GL (membro 9712, SEM linha em sku_estoque_atual — "galão vive sem sea próprio"). Pedido do app
# de 1 GL (= 4 unidades) em S−7 = D2−8: o sync o reconheceu e tirou o PO do pendente; o motor de antes cortava em
# D2−7 = 0× = o grupo COMPRA de novo. Com o conserto: conta 4 → estoque 5 > pp 3 → AUSENTE.
#
#   bash db/test-acaminho-membro-sem-linha.sh            (NAO pipe pra tail — engole o rc)
#   LC_ALL=pt_BR.UTF-8 bash db/test-acaminho-membro-sem-linha.sh
#
# Grupos: D pré-voo (motor da 20261118120000 = PROD) · C controle (defeito visível) · A conserto · F falsificação
# (controle verde na MESMA invocação) · P dente da POS-RU1 + rollback · Z restore.
# Sem a migration nova a prova fica VERMELHA (roda o A contra o motor vivo).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5482}"
SLUG="acaminho-membro-sem-linha"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
: "${LC_ALL:=C}"; export LC_ALL LANG="$LC_ALL"
MIG_BASE="$REPO_ROOT/supabase/migrations/20261101090000_reposicao_compra_suspensa.sql"
MIG_VIVA="$REPO_ROOT/supabase/migrations/20261118120000_reposicao_acaminho_relogio_do_sync.sql"
MIG="$REPO_ROOT/supabase/migrations/20261119140000_reposicao_acaminho_membro_sem_linha.sql"
FIXTURE="$REPO_ROOT/db/embalagem-motor-rpc.sql"
# md5(prosrc) do motor na PROD (psql-ro, 2026-11-18, após aplicar a 20261118120000) — o pré-voo.
MD5_PROD_VIVA="48ae5fd128ff81ab38c860e092a86a64"

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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT (LC_ALL=$LC_ALL) ==="

# ── ZONA 1: roles/schemas + stubs (os do db/test-compra-suspensa-motor.sh; sku_estoque_atual = colunas da prod) ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT; GRANT authenticated TO authenticator; GRANT anon TO authenticator;
CREATE SCHEMA auth;
-- auth.uid() como o Supabase: le o sub dos claims da sessao (NULL sem JWT)
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE SCHEMA private;
CREATE TABLE public.cap_stub (user_id uuid PRIMARY KEY, ler boolean NOT NULL, escrever boolean NOT NULL);
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT ler FROM public.cap_stub WHERE user_id = p), false) $$;
CREATE FUNCTION private.cap_compras_escrever(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT escrever FROM public.cap_stub WHERE user_id = p), false) $$;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid), private.cap_compras_escrever(uuid) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- helpers da 20261018200000 (fin_ciclo_giro_sku) que a foto reutiliza — mesma regra, provada la
CREATE FUNCTION public._fin_estoque_account(p_company text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; BEGIN
  v := CASE lower(trim(p_company)) WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v IS NULL THEN RAISE EXCEPTION 'empresa invalida: %', p_company USING ERRCODE = 'P0001'; END IF;
  RETURN v; END $$;
CREATE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(trim(p_familia)) IN ('uso e consumo','imobilizado') THEN 'fora_giro'
              WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
              WHEN trim(p_tipo) IN ('07','08','09','99') THEN 'fora_giro' ELSE 'giro' END $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text, valor_vendido_90d numeric);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_disponivel numeric,
  estoque_pendente_entrada numeric, ultima_sincronizacao timestamptz, fonte_sync text, PRIMARY KEY (empresa, sku_codigo_omie));  -- = prod (pkey empresa,sku)
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean,
  unidades_omie_por_embalagem numeric);  -- [UNIDADES #2849] o motor le a coluna
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean,
  fator_conversao numeric NOT NULL DEFAULT 1);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'rascunho', account text NOT NULL DEFAULT 'oben', hash_payload text, omie_numero_pedido text,
  omie_reconciliado_em timestamptz, deleted_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, capados_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
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
  estoque_fisico numeric, estoque_a_caminho numeric, fator_embalagem_portal numeric, qtde_sem_teto numeric,
  teto_cobertura_aplicado boolean, estoque_comprometido numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
CREATE TABLE public.reposicao_teto_cobertura_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, classe_abc text, teto_dias numeric, demanda_diaria numeric,
  estoque_efetivo numeric, ponto_pedido numeric, estoque_maximo numeric, cap_teto_ancora numeric, qtde_sem_teto numeric, qtde_final numeric, motivo text);
-- fontes da FOTO (consumo efetivo e substituicao) — tabela no lugar da view: mesma assinatura lida
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.sku_substituicao (id bigserial, empresa text, sku_codigo_antigo text, sku_codigo_novo text, acao_parametros text, status text);
-- o motor e INVOKER: o staff (authenticated) le/escreve estas tabelas no "Recalcular" — GRANT como na prod
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido, public.pedido_compra_item, public.reposicao_motor_run,
  public.reposicao_estoque_nao_confirmado_log, public.reposicao_teto_cobertura_log TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
SQL
echo "stubs criados"

# ── ZONA 2: o motor que está na PROD (a 20261118120000 aplica sobre o predecessor dela, como em prod) ──
fsrc() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'"; }
P -q -f "$MIG_BASE" >/dev/null || { echo "INFRA: a 20261101090000 nao aplicou"; exit 1; }
P -1 -q -f "$MIG_VIVA" >/dev/null || { echo "INFRA: a 20261118120000 nao aplicou"; exit 1; }
eq "D0 pre-voo: md5(prosrc) do motor vivo = o da PROD" "$(fsrc)" "$MD5_PROD_VIVA"

# ── ZONA 3: seeds. Grupo QT (9711, âncora habilitada) + GL (9712, membro SEM linha). pp 3, max 5.
#    sem contar o pedido do GL -> estoque do grupo 1 <= 3 -> COMPRA ; contando (1 GL x 4) -> 5 > 3 -> AUSENTE
#    COLACOR tem um retrato MAIS NOVO (D2): se o máximo vazar entre empresas, o corte volta a D2−7 (falsificação F2).
P -q <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO company_config (key, value) VALUES ('embalagem_preco_motor_stale_dias','45') ON CONFLICT (key) DO NOTHING;
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (9711,'oben','MS QT','Tintas',true,'00'), (9712,'oben','MS GL','Tintas',true,'00');
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
VALUES ('OBEN', 9711, 'MS QT', 'Sayerlack', 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL);
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync) VALUES
 ('OBEN','9711',1,0,'2026-12-20 09:10:00+00','ListarPosEstoque'),     -- âncora: retrato da véspera (S = D2−1)
 ('COLACOR','5555',0,0,'2026-12-21 09:10:00+00','ListarPosEstoque');  -- outra empresa, retrato do dia
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','97110000-0000-0000-0000-000000000000','9711',1,true),
 ('oben','97110000-0000-0000-0000-000000000000','9712',4,true);
INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em) VALUES
 ('oben','9711',100,'ok', now()-interval '1 day'), ('oben','9712',300,'ok', now()-interval '1 day');
INSERT INTO sku_fornecedor_externo (empresa, sku_omie, sku_portal, ativo) VALUES
 ('OBEN','9711','MSQT',true), ('OBEN','9712','MSGL',true);
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-12-13','disparado','nao_aplicavel','5712','normal');  -- 1 GL do app em S−7 = D2−8
DO $s$ BEGIN PERFORM setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100); END $s$;
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES (1,'9712','MS GL',1);
SQL
echo "seeds ok"
D2="2026-12-21"

RPC_ERR="$(mktemp "/tmp/rpcerr-${SLUG}.XXXXXX")"
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
# Roda o ciclo; RPC que nao retorna sucesso FALHA (senao "AUSENTE" passaria por "contou o pedido").
# Saida: COMPRA (algum item do grupo sugerido) | AUSENTE | ERRO
grupo() {
  local out rc
  P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100;" >/dev/null
  out="$(Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('OBEN','$D2')).skus_incluidos" 2>"$RPC_ERR")"; rc=$?
  if [ "$rc" -ne 0 ] || ! [[ "$out" =~ ^[0-9]+$ ]]; then echo "ERRO(rc=$rc $(head -c 200 "$RPC_ERR" | tr '\n' ' '))"; return; fi
  Pq -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
           WHERE pcs.data_ciclo='$D2' AND pcs.id > 100 AND pci.sku_codigo_omie IN ('9711','9712')) THEN 'COMPRA' ELSE 'AUSENTE' END"
}

# ── GRUPO C: controle — o motor vivo recompra o grupo (o membro sem linha é contado 0x) ──
eq "C1 viva: grupo com membro sem linha e pedido do app em D2-8 RECOMPRA (0x)" "$(grupo)" "COMPRA"
# controle do controle: dentro do corte de antes (D2-7) o vivo JA conta — o cenario mede so o vao
P -q -c "UPDATE pedido_compra_sugerido SET data_ciclo='2026-12-14' WHERE id=1" >/dev/null
eq "C2 viva: o mesmo pedido em D2-7 ja contava (o cenario mede so o vao)" "$(grupo)" "AUSENTE"
P -q -c "UPDATE pedido_compra_sugerido SET data_ciclo='2026-12-13' WHERE id=1" >/dev/null

# ── GRUPO A: conserto ──
if [ -f "$MIG" ]; then
  if P -1 -q -f "$MIG" >/dev/null; then ok "A0 migration aplica sobre a viva (rc=0)"; else bad "A0 migration FALHOU sobre a viva"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; fi
  MD5_NOVA="$(fsrc)"
  eq "A1 a fixture viva e a migration nova tem o mesmo prosrc" "$MD5_NOVA" "$(python3 - "$FIXTURE" <<'PY'
import sys,hashlib
s=open(sys.argv[1]).read(); i=s.index("CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo")
a=s.index("AS $function$",i)+13; b=s.index("$function$",a); print(hashlib.md5(s[a:b].encode()).hexdigest())
PY
)"
else
  echo "(migration nova ausente: o A roda contra o motor vivo e TEM de ficar vermelho)"
fi
eq "A2 nova: o pedido do membro sem linha conta pelo ultimo retrato da empresa -> grupo NAO recompra" "$(grupo)" "AUSENTE"
P -q -c "UPDATE sku_estoque_atual SET ultima_sincronizacao='2026-12-21 09:10:00+00' WHERE empresa='OBEN'" >/dev/null
eq "A3 nova: com o retrato da empresa em dia (S=D2) o vao fecha e o pedido de D2-8 ja estaria no pendente -> sem 2x pelo fallback" "$(grupo)" "COMPRA"
P -q -c "UPDATE sku_estoque_atual SET ultima_sincronizacao='2026-12-20 09:10:00+00' WHERE empresa='OBEN'" >/dev/null
P -q -c "DELETE FROM sku_estoque_atual WHERE empresa='OBEN'" >/dev/null
P -q -c "INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync) VALUES ('OBEN','9711',1,0,NULL,'ListarPosEstoque')" >/dev/null
eq "A4 nova: empresa sem retrato nenhum com data = o corte de antes (nao inventa relogio)" "$(grupo)" "COMPRA"
P -q -c "UPDATE sku_estoque_atual SET ultima_sincronizacao='2026-12-20 09:10:00+00' WHERE empresa='OBEN'" >/dev/null

if [ ! -f "$MIG" ]; then
  rm -rf "$SAB_DIR" "$RPC_ERR"; echo ""; echo "=== RESULTADO (sem a migration nova): PASS=$PASS FAIL=$FAIL ==="; [ "$FAIL" -eq 0 ] || exit 1; exit 0
fi

echo "=== FALSIFICACOES (CONTROLE verde pelo MESMO caminho, depois sabotagem -> vermelho especifico) ==="
troca() {  # literal, so no corpo (ate o 1o $function$;), EXATAMENTE 1 ocorrencia
  perl -ne 'BEGIN{$o=$ENV{OLD};$n=$ENV{NEW};$c=0;$f=0} $c += s/\Q$o\E/$n/g unless $f; $f=1 if /^\$function\$;$/; print; END{exit($c==1?0:3)}' "$1" > "$2"
}
carrega() { awk '{print} /^\$function\$;$/{exit}' "$1" > "$1.fn.sql"; P -q -f "$1.fn.sql" >/dev/null 2>"$1.err"; }
falsifica() {  # $1=nome $2=descricao ; OLD/NEW no ambiente. Verde = AUSENTE, sabotado = COMPRA
  cp "$FIXTURE" "$SAB_DIR/$1.ctl.sql"
  carrega "$SAB_DIR/$1.ctl.sql" || { bad "FALSIF $1: controle nao compilou"; return; }
  local c; c="$(grupo)"
  [ "$c" = "AUSENTE" ] || { bad "FALSIF $1 CONTROLE nao ficou verde (veio [$c]) — sabotar agora seria teatro"; return; }
  troca "$FIXTURE" "$SAB_DIR/$1.sql" || { bad "FALSIF $1: OLD nao casou EXATAMENTE 1 vez"; return; }
  carrega "$SAB_DIR/$1.sql" || { bad "FALSIF $1: sabotagem nao compilou: $(head -c 200 "$SAB_DIR/$1.sql.err")"; return; }
  local v; v="$(grupo)"
  if [ "$v" = "COMPRA" ]; then ok "FALSIF $1 pegou ($2: verde [$c] -> sabotado [$v])"; else bad "FALSIF $1 NAO detectou ($2: veio [$v])"; fi
}
OLD="COALESCE(sea_c.ultima_sincronizacao, sea_e.ult)" NEW="sea_c.ultima_sincronizacao" falsifica F1 "sem o fallback da empresa"
OLD="FROM sku_estoque_atual WHERE empresa = p_empresa) sea_e" NEW="FROM sku_estoque_atual) sea_e" falsifica F2 "maximo vazando entre empresas"

echo "=== POS-RU1: o corte sem o fallback ABORTA a migration e nao deixa nada aplicado ==="
P -q -f "$FIXTURE" >/dev/null
P -1 -q -f "$MIG" > "$SAB_DIR/post-ctl.log" 2>&1; prc=$?
eq "P0 controle: a migration intacta reaplica (idempotente)" "$prc" "0"
OLD="COALESCE(sea_c.ultima_sincronizacao, sea_e.ult)" NEW="sea_c.ultima_sincronizacao" troca "$MIG" "$SAB_DIR/post-sab.sql" \
  || bad "P1: OLD nao casou 1 vez na migration"
P -1 -q -f "$SAB_DIR/post-sab.sql" > "$SAB_DIR/post-sab.log" 2>&1; prc=$?
if [ "$prc" -ne 0 ] && grep -q "POS-RU1 FALHOU" "$SAB_DIR/post-sab.log"; then ok "P1 POS-RU1 abortou o corte sem o fallback (rc=$prc)"
else bad "P1 POS-RU1 NAO barrou o corte sem o fallback (rc=$prc): $(head -c 300 "$SAB_DIR/post-sab.log")"; fi
eq "P2 rollback: motor vivo intacto apos o abort" "$(fsrc)" "$MD5_NOVA"

# restore: a migration verdadeira de volta, verde de novo
P -q -f "$FIXTURE" >/dev/null
eq "Z1 restaurada, a versao verdadeira volta ao verde" "$(grupo)" "AUSENTE"

rm -rf "$SAB_DIR" "$RPC_ERR"
echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
