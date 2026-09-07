#!/usr/bin/env bash
# Harness PG17 — prova a migration de CAPTURA 20260830214547.
#
# O que se prova (12 asserts):
#   C1 positivo      — sobre o corpo da 18h, a captura aplica e os 5 marcadores ficam
#   C2 equivalencia  — a funcao pos-captura EXECUTA e produz o MESMO efeito que a 18h
#                      (plpgsql e late-bound: CREATE passa, so o EXECUTE prova)
#   C3 idempotencia  — aplicar 2x passa (o md5 pos-apply esta na allowlist)
#   C4 negativo      — funcao AUSENTE => guard aborta (nao e a criacao inicial)
#   C5 negativo      — corpo REGRESSIVO da 20260606200000 vivo => guard aborta (eixo semantico)
#   C6 negativo      — corpo hardened porem md5 FORA da allowlist => guard aborta (eixo md5)
#   C7 falsificacao  — com o corpo regressivo instalado, o bloco de VERIFICACAO reprova
#                      (se ele passasse, os 5 marcadores seriam decorativos) + controle
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAPTURA="$REPO/supabase/migrations/20260830214547_reposicao_aplicar_promocoes_captura_corpo_vivo.sql"
H18="$REPO/supabase/migrations/20260606180000_reposicao_aplicar_promocoes_hardening.sql"
R20="$REPO/supabase/migrations/20260606200000_reposicao_promo_forward_buying_min.sql"
for f in "$CAPTURA" "$H18" "$R20"; do [ -f "$f" ] || { echo "ausente: $f"; exit 1; }; done

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
[ -x "$PGBIN/initdb" ] || PGBIN="$(dirname "$(command -v initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
export LC_ALL=C LANG=C
PORT=5471
TMPROOT="$(mktemp -d)"
DATA="$TMPROOT/pgd"
# shellcheck disable=SC2329  # invocada indiretamente pelo `trap cleanup EXIT` abaixo
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPROOT"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPROOT/pg.log" -w start >/dev/null
PSQL=("$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

FALHAS=0
ok()    { echo "  ok   $1"; }
falha() { echo "  FALHA $1"; FALHAS=$((FALHAS+1)); }

# blocos isolados da migration, para falsificacao unitaria.
# shellcheck disable=SC2016  # o `$` de $verifica$/$guard$ e LITERAL (dollar-quoting do plpgsql)
sed -n '/^DO \$verifica\$$/,/^\$verifica\$;$/p' "$CAPTURA" > "$TMPROOT/bloco-verifica.sql"
# shellcheck disable=SC2016
sed -n '/^DO \$guard\$$/,/^\$guard\$;$/p' "$CAPTURA" > "$TMPROOT/bloco-guard.sql"
[ -s "$TMPROOT/bloco-verifica.sql" ] || { echo "extracao do bloco de verificacao falhou"; exit 1; }
[ -s "$TMPROOT/bloco-guard.sql" ]    || { echo "extracao do bloco de guard falhou"; exit 1; }

stubs() {
  "${PSQL[@]}" -d "$1" <<'SQL'
CREATE TABLE pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text, fornecedor_nome text, data_ciclo date, status text, tipo_ciclo text,
  valor_total numeric, pedido_anterior_valor numeric, delta_vs_anterior_perc numeric, mensagem_bloqueio text
);
CREATE TABLE pedido_compra_item (
  id bigint PRIMARY KEY, pedido_id bigint, sku_codigo_omie text, qtde_sugerida numeric, qtde_final numeric,
  preco_unitario numeric, valor_linha numeric, modo_promocao text, promocao_item_id bigint,
  qtde_sem_promocao numeric, preco_sem_desconto numeric, desconto_perc_aplicado numeric,
  economia_estimada_valor numeric, ajustado_humano boolean DEFAULT false
);
CREATE TABLE fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, delta_max_perc numeric);
CREATE TABLE promocao_campanha (id bigint PRIMARY KEY, empresa text, fornecedor_nome text, data_inicio date, data_fim date);
CREATE TABLE v_promocao_avaliacao_hoje (
  empresa text, modo_aplicacao text, sku_codigo_omie bigint, desconto_perc numeric, item_id bigint,
  qtde_com_desconto numeric, economia_bruta_valor numeric, campanha_id bigint, fornecedor_nome text, qtde_base numeric
);
SQL
}

seed() {
  "${PSQL[@]}" -d "$1" <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao VALUES ('OBEN','FORN_A',9999);
INSERT INTO promocao_campanha VALUES (10,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10);
INSERT INTO pedido_compra_sugerido VALUES
  (1,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',1000,1000,0,NULL);
-- item 1: promocao flat aplicavel | item 2: MESMO cenario porem ajustado a mao ([H4] protege)
INSERT INTO pedido_compra_item (id,pedido_id,sku_codigo_omie,qtde_sugerida,qtde_final,preco_unitario,valor_linha,ajustado_humano)
VALUES (1,1,'555',10,10,100,1000,false),
       (2,1,'777',10,10,100,1000,true);
INSERT INTO v_promocao_avaliacao_hoje VALUES
  ('OBEN','flat',555,10,900,10,100,10,'FORN_A',10),
  ('OBEN','flat',777,10,901,10,100,10,'FORN_A',10);
SQL
}

novo_db() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $1;" >/dev/null 2>&1
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE $1;" >/dev/null
  stubs "$1"
}

# aplica sem pipe (pipe engoliria o exit code — CLAUDE.md §evidencia-positiva-shell)
aplica() { "${PSQL[@]}" -d "$1" -f "$2" > "$TMPROOT/out.txt" 2>&1; }
efeito() { "${PSQL[@]}" -A -t -d "$1" -c "SELECT coalesce(modo_promocao,'NULO')||'/'||qtde_final||'/'||valor_linha FROM pedido_compra_item ORDER BY id;"; }
roda()   { "${PSQL[@]}" -d "$1" -c "SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);" > "$TMPROOT/run.txt" 2>&1; }

echo "== C1/C2/C3: caminho positivo, equivalencia de EXECUCAO e idempotencia =="
novo_db c1; seed c1
if ! aplica c1 "$H18"; then falha "C1 setup: a 18h nao aplicou"; fi
if roda c1; then ok "C2a a funcao da 18h EXECUTA (nao e late-bound quebrada)"
else falha "C2a a 18h nao executou: $(head -3 "$TMPROOT/run.txt")"; fi
efeito c1 > "$TMPROOT/ef_ref.txt"

novo_db c2; seed c2
if ! aplica c2 "$H18"; then falha "C1 setup b"; fi
if aplica c2 "$CAPTURA"; then ok "C1 a captura aplica sobre o corpo da 18h"
else falha "C1 a captura NAO aplicou: $(head -5 "$TMPROOT/out.txt")"; fi
if grep -q 'hardening integro' "$TMPROOT/out.txt"; then ok "C1b o bloco de verificacao confirmou os 5 marcadores"
else falha "C1b sem o NOTICE de verificacao"; fi
if roda c2; then ok "C2b a funcao pos-captura EXECUTA"
else falha "C2b nao executou: $(head -3 "$TMPROOT/run.txt")"; fi
efeito c2 > "$TMPROOT/ef_pos.txt"
if diff -q "$TMPROOT/ef_ref.txt" "$TMPROOT/ef_pos.txt" >/dev/null; then
  ok "C2c efeito money-path IDENTICO ao da 18h (modo/qtde/valor por item)"
else
  falha "C2c efeito DIVERGIU: $(diff "$TMPROOT/ef_ref.txt" "$TMPROOT/ef_pos.txt" | head -4)"
fi
# [H4]: o item ajustado a mao NAO pode ter recebido promocao...
if "${PSQL[@]}" -A -t -d c2 -c "SELECT coalesce(modo_promocao,'NULO') FROM pedido_compra_item WHERE id=2;" | grep -qx 'NULO'; then
  ok "C2d [H4] item ajustado_humano ficou INTOCADO pela promocao"
else
  falha "C2d [H4] item ajustado a mao foi alterado pela promocao"
fi
# ...e o CONTROLE anti-vacuidade: o item nao-ajustado TEM de ter recebido, senao C2d/C2c sao vazios
if "${PSQL[@]}" -A -t -d c2 -c "SELECT coalesce(modo_promocao,'NULO') FROM pedido_compra_item WHERE id=1;" | grep -qx 'flat'; then
  ok "C2e controle: o item nao-ajustado RECEBEU a promocao (C2c/C2d nao sao vacuos)"
else
  falha "C2e o seed nao aplicou promocao em ninguem — C2c/C2d passariam por vacuidade"
fi
if aplica c2 "$CAPTURA"; then ok "C3 idempotente: 2a aplicacao passa"
else falha "C3 2a aplicacao falhou: $(head -5 "$TMPROOT/out.txt")"; fi

echo "== C4: funcao AUSENTE => guard aborta =="
novo_db c4
if aplica c4 "$CAPTURA"; then
  falha "C4 aplicou num banco SEM a funcao (o guard nao mordeu)"
elif grep -q 'nao existe' "$TMPROOT/out.txt"; then
  ok "C4 guard abortou com a mensagem de funcao ausente"
else
  falha "C4 abortou por outro motivo: $(head -3 "$TMPROOT/out.txt")"
fi

echo "== C5: corpo REGRESSIVO vivo => guard aborta (eixo semantico) =="
novo_db c5
if ! aplica c5 "$R20"; then falha "C5 setup: a 20h nao aplicou nos stubs"; fi
if aplica c5 "$CAPTURA"; then
  falha "C5 a captura SOBRESCREVEU o corpo regressivo sem avisar (guard cego)"
elif grep -q 'linhagem hardened' "$TMPROOT/out.txt"; then
  ok "C5 guard abortou apontando a linhagem errada"
else
  falha "C5 abortou por outro motivo: $(head -3 "$TMPROOT/out.txt")"
fi

echo "== C6: hardened porem md5 FORA da allowlist => guard aborta (eixo md5) =="
novo_db c6
if ! aplica c6 "$H18"; then falha "C6 setup"; fi
"${PSQL[@]}" -d c6 <<'SQL' >/dev/null
DO $deriva$
DECLARE d text; d0 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='aplicar_promocoes_no_ciclo';
  d := replace(d0, 'DECLARE', 'DECLARE -- deriva sintetica: hardening intacto, md5 outro');
  IF d = d0 THEN
    RAISE EXCEPTION 'sabotagem no-op: o replace nao mudou nada';
  END IF;
  EXECUTE d;
END
$deriva$;
SQL
if aplica c6 "$CAPTURA"; then
  falha "C6 a captura sobrescreveu uma variante DESCONHECIDA sem avisar"
elif grep -q 'DESCONHECIDO' "$TMPROOT/out.txt"; then
  ok "C6 guard abortou pedindo re-medicao"
else
  falha "C6 abortou por outro motivo: $(head -3 "$TMPROOT/out.txt")"
fi

echo "== C7: FALSIFICACAO — o bloco de verificacao tem dente? =="
novo_db c7
if ! aplica c7 "$R20"; then falha "C7 setup"; fi
if "${PSQL[@]}" -d c7 -f "$TMPROOT/bloco-verifica.sql" > "$TMPROOT/out7.txt" 2>&1; then
  falha "C7 o bloco de verificacao PASSOU sobre o corpo regressivo — os 5 marcadores sao decorativos"
elif grep -q 'corpo regressivo instalado' "$TMPROOT/out7.txt"; then
  ok "C7 verificacao REPROVOU o corpo regressivo"
else
  falha "C7 reprovou por outro motivo: $(head -3 "$TMPROOT/out7.txt")"
fi
novo_db c7b
if ! aplica c7b "$H18"; then falha "C7b setup"; fi
if "${PSQL[@]}" -d c7b -f "$TMPROOT/bloco-verifica.sql" > "$TMPROOT/out7b.txt" 2>&1; then
  ok "C7b controle: o mesmo bloco APROVA o corpo hardened (nao reprova sempre)"
else
  falha "C7b o bloco reprova ate o corpo certo: $(head -3 "$TMPROOT/out7b.txt")"
fi

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "test-captura-corpo-vivo-aplicar-promocoes OK (12 asserts, 4 negativos, 1 falsificacao com controle)"
  exit 0
fi
echo "test-captura-corpo-vivo-aplicar-promocoes FALHOU: $FALHAS assert(s)"
exit 1
