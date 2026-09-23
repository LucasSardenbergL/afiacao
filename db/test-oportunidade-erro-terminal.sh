#!/usr/bin/env bash
# Teste PG17 da migration 20260922225449: erro TERMINAL do portal deixa de BLOQUEAR a oferta
# no ciclo de oportunidade (guarda [FANTASMA] replicada nos 2 NOT EXISTS [SIMETRIA-NORMAL]).
#
# Estrutura: CONTROLE (funcao VELHA, do snapshot) -> prova que o defeito EXISTE; depois aplica a
# migration e prova que so o caso FANTASMA destravou. A falsificacao (--falsificar) sabota a
# guarda de cada bloco SEPARADAMENTE e exige vermelho em cada um.
# Tecnica: a view v_oportunidade_economica_hoje vira TABELA-fixture (plpgsql resolve em runtime).
# Base: db/test-fixes-codex-711.sh. Pre-req: brew install postgresql@17 pgvector.
set -euo pipefail

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRACAO="$REPO_ROOT/supabase/migrations/20260922225449_oportunidade_erro_terminal_nao_bloqueia_oferta.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5451
DATA="$(mktemp -d /tmp/pgtest-oppfant.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIGRACAO" ] || { echo "migration ausente: $MIGRACAO"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}" "${SAB:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-oppfant.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres oppfant_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d oppfant_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-oppfant.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "-> stubs + prelude + snapshot (traz a funcao VELHA, sem a guarda)..."
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "-> fixture: view vira tabela deterministica + 5 pedidos normais..."
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP VIEW IF EXISTS v_oportunidade_economica_hoje CASCADE;
CREATE TABLE v_oportunidade_economica_hoje (
  empresa text, cenario text, economia_bruta_estimada numeric, qtde_oportunidade numeric,
  campanha_id bigint, aumentos_json jsonb, fornecedor_nome text,
  sku_codigo_omie text, sku_descricao text, preco_item_eoq numeric,
  desconto_total_perc numeric, promo_item_id bigint
);
-- 4 SKUs do MESMO fornecedor/cenario, cada um com um pedido NORMAL diferente:
--   6001 FANTASMA  (erro terminal, sem protocolo, sem n. Omie) -> deve DESTRAVAR
--   6002 com PROTOCOLO do portal (erro terminal, mas algo chegou) -> segue BLOQUEADO
--   6003 com N. OMIE (erro terminal, mas algo chegou)            -> segue BLOQUEADO
--   6004 pedido normal saudavel com status_envio_portal NULL     -> segue BLOQUEADO
--   6005 pedido normal saudavel 'nao_aplicavel' (o caso REAL da prod) -> segue BLOQUEADO
-- 6004 e o caso-limite que pegou o NULL-blind: com "=" no lugar de IS NOT DISTINCT FROM, o
-- predicado vira NULL, NOT(NULL) e NULL, e o pedido saudavel some do NOT EXISTS (compra dupla).
-- A coluna tem DEFAULT 'nao_aplicavel' e hoje a prod nao tem NULL, mas ela E nullable.
INSERT INTO v_oportunidade_economica_hoje VALUES
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','6001','SKU 6001',20,10,NULL),
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','6002','SKU 6002',20,10,NULL),
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','6003','SKU 6003',20,10,NULL),
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','6004','SKU 6004',20,10,NULL),
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','6005','SKU 6005',20,10,NULL);

-- pedidos NORMAIS: todos 'aprovado_aguardando_disparo' dentro da janela de 7 dias
INSERT INTO pedido_compra_sugerido
  (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo,
   status_envio_portal, portal_protocolo, omie_pedido_compra_numero)
VALUES
  ('OBEN','FORN-N1',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal','erro_nao_retentavel',NULL,NULL),
  ('OBEN','FORN-N2',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal','erro_nao_retentavel','PROTO-XYZ',NULL),
  ('OBEN','FORN-N3',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal','erro_nao_retentavel',NULL,'OMIE-991'),
  ('OBEN','FORN-N4',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal',NULL,NULL,NULL),
  ('OBEN','FORN-N5',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal','nao_aplicavel',NULL,NULL);

INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
SELECT id, s.sku, 'SKU ' || s.sku, 25, 25, 20, 500
FROM pedido_compra_sugerido pcs
JOIN (VALUES ('FORN-N1','6001'),('FORN-N2','6002'),('FORN-N3','6003'),('FORN-N4','6004'),
             ('FORN-N5','6005')) AS s(forn, sku)
  ON s.forn = pcs.fornecedor_nome;
SQL

# ---------- helper: roda a RPC e devolve os SKUs ofertados, em ordem ----------
OFERTADOS() {
  P -At -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM pedido_compra_item WHERE pedido_id IN (SELECT id FROM pedido_compra_sugerido WHERE tipo_ciclo LIKE 'oportunidade_%');
DELETE FROM pedido_compra_sugerido WHERE tipo_ciclo LIKE 'oportunidade_%';
SELECT * FROM public.gerar_pedidos_oportunidade_ciclo('OBEN', CURRENT_DATE);
SELECT COALESCE(string_agg(DISTINCT pci.sku_codigo_omie, ',' ORDER BY pci.sku_codigo_omie), 'NENHUM')
FROM pedido_compra_item pci
JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
WHERE pcs.tipo_ciclo LIKE 'oportunidade_%';
SQL
}

echo "-> CONTROLE: funcao VELHA (snapshot) — o defeito precisa APARECER..."
ANTES="$(OFERTADOS | tail -1)"
if [ "$ANTES" != "NENHUM" ]; then
  echo "FALHOU (controle): com a funcao VELHA esperava NENHUM SKU ofertado, veio '$ANTES'."
  echo "   Sem o controle vermelho a linha de base nao existe e o teste aprovaria qualquer coisa."
  exit 1
fi
echo "   OK controle — funcao velha barra os 4 SKUs, inclusive o FANTASMA (o defeito)."

echo "-> aplica a migration 20260922225449..."
P -v ON_ERROR_STOP=1 -q -f "$MIGRACAO" >/dev/null

echo "-> DEPOIS: so o FANTASMA pode ter destravado..."
DEPOIS="$(OFERTADOS | tail -1)"
if [ "$DEPOIS" != "6001" ]; then
  echo "FALHOU: esperava exatamente '6001' ofertado, veio '$DEPOIS'."
  case "$DEPOIS" in
    NENHUM) echo "   -> o SKU do pedido fantasma continua bloqueado: a guarda nao pegou." ;;
    *6002*|*6003*) echo "   -> pedido COM sinal de chegada destravou: a guarda deixou de ser fail-CLOSED (risco de compra dupla)." ;;
    *6004*) echo "   -> pedido saudavel com status_envio_portal NULL destravou: negacao NULL-blind." ;;
    *6005*) echo "   -> pedido saudavel 'nao_aplicavel' destravou: a guarda vazou do caso terminal." ;;
  esac
  exit 1
fi
echo "   OK A1 — SKU do pedido FANTASMA volta a ser ofertado (destravou a economia)."
echo "   OK A2 — 6002 (protocolo) e 6003 (n. Omie) seguem bloqueados: fail-CLOSED preservado."
echo "   OK A3 — 6004 (status_envio_portal NULL) segue bloqueado: guarda nao e NULL-blind."
echo "   OK A3b — 6005 ('nao_aplicavel', o caso real da prod) segue bloqueado: guarda nao vazou."

echo "-> A4: header x itens coerentes (a guarda entrou nos DOIS blocos)..."
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE v_header int; v_itens int;
BEGIN
  SELECT COALESCE(SUM(num_skus),0) INTO v_header FROM pedido_compra_sugerido WHERE tipo_ciclo LIKE 'oportunidade_%';
  SELECT count(*) INTO v_itens FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id WHERE pcs.tipo_ciclo LIKE 'oportunidade_%';
  IF v_header <> v_itens THEN
    RAISE EXCEPTION 'A4 FALHOU: header num_skus=% x itens=% — a guarda entrou em so UM dos NOT EXISTS', v_header, v_itens;
  END IF;
  IF v_itens <> 1 THEN
    RAISE EXCEPTION 'A4 FALHOU: esperava 1 item na oportunidade, veio %', v_itens;
  END IF;
END $$;
SQL
echo "   OK A4 — header e itens batem (1 e 1)."

echo "-> A5: re-rodar e idempotente (nao duplica)..."
NOVA="$(OFERTADOS | tail -1)"
[ "$NOVA" = "6001" ] || { echo "A5 FALHOU: re-rodada mudou o resultado ('$NOVA')"; exit 1; }
echo "   OK A5 — re-rodada estavel."

if [ "$FALSIFICAR" = "1" ]; then
  echo
  echo "=== FALSIFICACAO: sabota UM bloco por vez; cada um tem de ficar VERMELHO ==="
  SAB="$(mktemp "${TMPDIR:-/tmp}/sabota-oppfant.XXXXXX")"

  # bloco 1 = CTE do header; bloco 2 = INSERT de itens. A sabotagem remove a guarda de UM deles,
  # trocando o predicado por algo sempre-falso (NOT(false) = a guarda nunca dispara).
  for BLOCO in 1 2; do
    python3 - "$MIGRACAO" "$SAB" "$BLOCO" <<'PY'
import sys, re
src, dst, bloco = sys.argv[1], sys.argv[2], int(sys.argv[3])
t = open(src).read()
alvo = "pcsn.status = 'aprovado_aguardando_disparo'"
oc = [m for m in re.finditer(re.escape(alvo), t)]
assert len(oc) == 2, f"esperava 2 guardas, achei {len(oc)} — sabotagem abortada"
m = oc[bloco - 1]
t = t[:m.start()] + "false" + t[m.end():]   # NOT(false AND ...) -> guarda nunca dispara
open(dst, 'w').write(t)
PY
    P -v ON_ERROR_STOP=1 -q -f "$SAB" >/dev/null 2>&1 || true
    SAIDA="$(OFERTADOS | tail -1)"
    if [ "$SAIDA" = "6001" ]; then
      echo "FALSIFICACAO FALHOU (bloco $BLOCO): sabotei a guarda e o teste seguiu com '6001'."
      echo "   O assert nao tem dente — ele aprovaria a versao defeituosa."
      exit 1
    fi
    echo "   OK falsificacao bloco $BLOCO — sabotado, saida virou '$SAIDA' (!= 6001)."
    P -v ON_ERROR_STOP=1 -q -f "$MIGRACAO" >/dev/null   # restaura a versao verdadeira
  done

  # bloco 3: o NULL-blind. Troca IS NOT DISTINCT FROM por "=" — a forma INGENUA da guarda.
  # Tem de destravar o 6004 (status_envio_portal NULL), provando que o assert A3 tem dente.
  python3 - "$MIGRACAO" "$SAB" <<'PY2'
import sys
src, dst = sys.argv[1], sys.argv[2]
t = open(src).read()
alvo = "IS NOT DISTINCT FROM 'erro_nao_retentavel'"
assert t.count(alvo) == 2, f"esperava 2 comparacoes, achei {t.count(alvo)} — sabotagem abortada"
open(dst, 'w').write(t.replace(alvo, "= 'erro_nao_retentavel'"))
PY2
  P -v ON_ERROR_STOP=1 -q -f "$SAB" >/dev/null 2>&1 || true
  SAIDA="$(OFERTADOS | tail -1)"
  case "$SAIDA" in
    *6004*) echo "   OK falsificacao bloco 3 (NULL-blind) — com '=' o 6004 vazou ('$SAIDA'); A3 tem dente." ;;
    *) echo "FALSIFICACAO FALHOU (bloco 3): troquei IS NOT DISTINCT FROM por '=' e o 6004 NAO vazou"
       echo "   (saida '$SAIDA'). O assert A3 nao distingue as duas formas — ele aprovaria a ingenua."
       exit 1 ;;
  esac
  P -v ON_ERROR_STOP=1 -q -f "$MIGRACAO" >/dev/null

  RESTAURADO="$(OFERTADOS | tail -1)"
  [ "$RESTAURADO" = "6001" ] || { echo "FALHOU: restauracao nao voltou ao verde ('$RESTAURADO')"; exit 1; }
  echo "   OK — versao verdadeira restaurada e verde de novo."
fi

echo
echo "OK test-oportunidade-erro-terminal: 6 asserts verdes (controle antes x depois incluido)."
