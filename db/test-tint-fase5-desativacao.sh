#!/usr/bin/env bash
# Teste PG17 da FASE 5 tintométrica — soft-deactivation da geração SAYERLACK
# ('1') com carimbo de PROVENIÊNCIA (`tint_formulas.desativada_motivo`).
#
# Aplica schema-snapshot + a cadeia REAL de migrations da view NA ORDEM DE PROD
# (Fase 2 → 2b → fix semântico → allowlist → piso legado → FASE 5) e prova a
# desativação em si.
#
# ⚠️ DIFERENÇA ESTRUTURAL para db/test-tint-canonica.sh: a migration da Fase 5 é
# DDL **+ DML** (ela DESATIVA linhas). Então os seeds vêm ANTES dela, e cada
# falsificação precisa RESTAURAR o estado pré-desativação (`reset_estado`) antes
# de reaplicar a versão sabotada — senão a 2ª sabotagem mede um catálogo que a
# 1ª já mexeu, e o vermelho não é o que você pensa.
#
# ⚠️ LIÇÃO #1517 (harness em cascata): os cenários de cada fase validam a versão
# DAQUELA fase. Como a Fase 5 faz CREATE OR REPLACE da view INTEIRA, os
# invariantes críticos da cadeia (allowlist, NULL-preserving, guard de conta)
# são RE-EXERCIDOS aqui sob a versão DA FASE 5 — não herdados. VERSÃO COBERTA ≠
# VERSÃO ENTREGUE.
#
# ── O QUE ESTE HARNESS PROVA ──────────────────────────────────────────────────
# A DESATIVAÇÃO (o UPDATE):
#   D1  ALVO: '1' ativa com gêmea SL VÁLIDA → desativada E carimbada
#       'fase5_geracao_legada'
#   D2  PRESERVAÇÃO (as "12" de prod): '1' ativa SEM gêmea SL → intacta, carimbo
#       NULL. É o assert que impede a fase de apagar cor do catálogo.
#   D3  gêmea SL existe mas com receita VAZIA → não é "válida" → não desativa
#   D4  gêmea SL com receita mas corante sem custo Omie → não desativa
#       (D3/D4 espelham corantes_completos da RPC: desativar contra uma gêmea
#        que o motor de preço rejeitaria deixaria a chave sem preço vendável)
#   D5  linha 'SL' NUNCA é desativada por esta migration
#   D6  personalizada (subcolecao_id NULL) NUNCA é desativada
#   D7  linha JÁ desativada por OUTRO mecanismo (snapshot, carimbo NULL) NÃO é
#       re-carimbada — o UPDATE filtra `desativada_em IS NULL`
#   D8  GUARD DE COBERTURA: se alguma chave ficaria sem NENHUMA linha ativa, a
#       migration ABORTA e a transação inteira reverte (nada é desativado)
#   D9  PRÉ-FLIGHT DE ORDEM: sem a coluna preco_piso_legado (= #1535 não
#       aplicado), a migration ABORTA
#
# A VIEW (re-exercida SOB a versão da Fase 5):
#   V1  desativada COM carimbo → ENTRA no preco_csv_legado (o CSV sobrevive —
#       decisão do founder, opção B)
#   V2  desativada SEM carimbo → FICA FORA (preserva o C18/C23 da cadeia; é a
#       população de 1.704 chaves que a FONTE aposentou, medida em prod)
#   V3  INVARIANTE I1: (csv IS NULL) ⟺ (piso IS NULL), com carimbo em jogo
#   V4  INVARIANTE I2: piso >= csv
#   V5  ⚠️ O MAIS CRÍTICO: o carimbo NÃO ressuscita a linha como CANDIDATA a
#       canônica. Relaxar o filtro de candidata devolveria a geração desativada
#       ao catálogo — o oposto exato desta fase.
#   V6  allowlist NÃO é furada pelo carimbo: personalizada carimbada não entra
#       no RÓTULO quando a canônica é SL (mas entra no PISO, que não filtra
#       proveniência — a assimetria é deliberada e fica FIXADA aqui)
#   V7  SHAPE: as 14 colunas na ordem exata + security_invoker=on sobreviveu ao
#       REPLACE (armadilha #1375: omitir o WITH RESETA a opção e a view passa a
#       bypassar RLS — falha ABERTA que o CI não vê)
#   V8  GUARD DE CONTA re-exercido SOB A FASE 5: fórmula de 'oben' apontando
#       para a subcoleção '1' de 'colacor' (a FK permite — não tem account) não
#       alimenta o rótulo; e não é alvo do UPDATE (V8b)
#   V9  EXCLUSIVIDADE DO LITERAL '1' re-exercida SOB A FASE 5: subcoleções '2',
#       '10' e rótulo-NULL com CSV 960/970/980 ficam fora do rótulo. Mata 4
#       mutantes: `<> 'SL'`, `IN ('1','2')`, `LIKE '1%'`,
#       `COALESCE(rotulo,'1')='1'`. V9b prova o NULL-preserving contra um
#       max_ativo ALTO (csv NULL ⇒ piso NULL mesmo com 980 ativo na chave).
#   ⚠️ V8/V9 existem por causa da lição #1517: db/test-tint-canonica.sh prova
#   esses invariantes contra a versão do #1535, e a Fase 5 faz REPLACE da view
#   INTEIRA — sem re-exercê-los aqui, a cobertura seria ILUSÓRIA.
#
# FALSIFICAÇÕES (cada uma declara o CONJUNTO EXATO que derruba):
#   F1  relaxa TAMBÉM o filtro de candidata (`WHERE f.desativada_em IS NULL`)
#       → derruba {V5c}
#       ⚠️ O ALVO É V5c, NÃO V5 — e a razão é uma lição sobre falsificação.
#       V5 é protegido por DOIS mecanismos independentes: o filtro de candidata
#       E o rank do NOT EXISTS de gêmea melhor. Um invariante do UPDATE os
#       acopla: linha só é carimbada se a chave tem gêmea SL VÁLIDA, e SL válida
#       tem rank 0, que sempre vence a '1' (rank 1). Logo a linha carimbada
#       NUNCA é canônica, mesmo com o filtro relaxado — e F1 contra V5 vinha
#       INERTE ("asserts VERDES sob a sabotagem"), medido na 6ª rodada.
#       ⇒ V5 continua como defesa em profundidade, mas quem F1 falsifica é V5c,
#       no cenário K10, onde a gêmea SL sai de cena DEPOIS do carimbo e o rank
#       não tem como proteger. REGRA QUE GENERALIZA: quando um assert é
#       garantido por dois mecanismos independentes, falsificar UM não prova
#       nada sobre ele — o assert parece ter dente sem ter. É preciso um cenário
#       onde SÓ o mecanismo sob teste esteja em jogo.
#       (E note: o cenário K10 é exatamente o P1-7 do Codex — "a SL invalidar
#       depois da Fase 5" —, calibrado para fora do escopo como follow-up 5b. O
#       caso que preciso construir para falsificar é o mesmo que a produção
#       pode construir sozinha.)
#   F2  relaxa AMPLO (ignora o carimbo: `OR g2.desativada_em IS NOT NULL`)
#       → derruba {V2}
#   F3  NÃO espelha a cópia da subquery do csv dentro do CASE do piso
#       → derruba {V3}
#   F4  EXISTS de gêmea SL válida sempre verdadeiro → a '1' de K4 (as "12" de
#       prod) também viraria alvo → o guard de cobertura ABORTA (prova D8) e a
#       transação reverte (D8b)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260718213000_tint_formula_canonica.sql"
MIGRATION2="$REPO_ROOT/supabase/migrations/20260718233000_tint_canonica_preco_csv_legado.sql"
MIGRATION3="$REPO_ROOT/supabase/migrations/20260722100002_tint_canonica_csv_legado_semantico.sql"
MIGRATION4="$REPO_ROOT/supabase/migrations/20260724130000_tint_canonica_csv_legado_allowlist.sql"
MIGRATION5="$REPO_ROOT/supabase/migrations/20260726160000_tint_canonica_piso_legado.sql"
MIGRATION6="$REPO_ROOT/supabase/migrations/20260727120000_tint_fase5_desativa_geracao_legada.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5449
export LC_ALL=C LANG=C

for m in "$MIGRATION" "$MIGRATION2" "$MIGRATION3" "$MIGRATION4" "$MIGRATION5" "$MIGRATION6"; do
  [ -f "$m" ] || { echo "migration ausente: $m"; exit 1; }
done

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true

DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgfase5.XXXXXX")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres fase5_verify
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d fase5_verify -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# Contrato de falsificação: a sabotagem tem de derrubar EXATAMENTE os asserts
# nomeados — nem menos (assert sem dente), nem mais (sabotagem que mexe em duas
# coisas não isola o que prova). Espelha o confere_falsificacao da canônica
# (achado (e) do challenge Codex xhigh 2026-07-21: "vermelho certo E SÓ ELE" é
# uma afirmação sobre o CONJUNTO — se o harness não sabe contar, não a escreva).
# uso: confere_falsificacao <rotulo> <out> <n_esperado> <Dx|Vx> [...] -- <desc>
confere_falsificacao() {
  local rot="$1" out="$2" n_esp="$3"; shift 3
  local desc="" n_real faltando="" c; local -a nomes=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; desc="$*"; break; fi
    nomes+=("$1"); shift
  done
  case "$out" in
    *TODOS_OK*) bad "$rot NAO pegou: asserts VERDES sob a sabotagem (sem dente) — $desc"; return ;;
  esac
  n_real="$(printf '%s' "$out" | sed -n 's/.*FALHAS\[\([0-9]\{1,\}\)\].*/\1/p' | head -1)"
  if [ -z "$n_real" ]; then
    bad "$rot quebrou FORA do contrato de asserts (sem FALHAS[n] — erro SQL?): $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-180)"; return
  fi
  for c in "${nomes[@]}"; do
    case "$out" in *"$c FALHOU"*) ;; *) faltando="$faltando $c" ;; esac
  done
  if [ -n "$faltando" ]; then
    bad "$rot nao derrubou o(s) assert(s) alvo:$faltando (veio FALHAS[$n_real]) — $desc"; return
  fi
  local caidos
  caidos="$(printf '%s' "$out" | tr '|' '\n' | sed -n 's/.*\([DV][0-9]\{1,2\}[a-z]*\) FALHOU.*/\1/p' | tr '\n' ' ')"
  if [ "$n_real" != "$n_esp" ]; then
    bad "$rot derrubou $n_real assert(s) [$caidos], esperado $n_esp [${nomes[*]}] — o CONJUNTO mudou"; return
  fi
  ok "$rot pegou a sabotagem: FALHAS[$n_real] = [$caidos] — $desc"
}

RR="$(mktemp "${TMPDIR:-/tmp}/snap-fase5.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" || { echo "FALHA no setup: stubs"; exit 1; }
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" || { echo "FALHA no setup: prelude"; exit 1; }
P --single-transaction -q -f "$RR" >/dev/null || { echo "FALHA no setup: snapshot"; exit 1; }
rm -f "$RR"

# O snapshot traz a view pronta; a cadeia prova as MIGRATIONS, não o snapshot
# (regra do #1509 — re-dump quebra harness manual sem nenhum sinal vermelho).
echo "→ cadeia da view: Fase 2 → 2b → semântico → allowlist → piso (SEM a Fase 5 ainda)…"
P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null
P -q -f "$MIGRATION"  >/dev/null || { echo "FALHA: Fase 2"; exit 1; }
P -q -f "$MIGRATION2" >/dev/null || { echo "FALHA: Fase 2b"; exit 1; }
P -q -f "$MIGRATION3" >/dev/null || { echo "FALHA: fix semântico"; exit 1; }
P -q -f "$MIGRATION4" >/dev/null || { echo "FALHA: allowlist"; exit 1; }
P -q -f "$MIGRATION5" >/dev/null || { echo "FALHA: piso legado (#1535)"; exit 1; }

# ── D9: PRÉ-FLIGHT DE ORDEM ──────────────────────────────────────────────────
# Antes de aplicar a Fase 5, prove que ela SE RECUSA a rodar sem o #1535. Este
# assert roda AQUI (e não junto dos outros) porque precisa do mundo SEM a coluna
# preco_piso_legado — depois de aplicar a Fase 5 não dá mais para reconstruí-lo.
# Baseline do DETECTOR (#1488): confirmo primeiro que a coluna EXISTE agora, para
# que "detectou a ausência" e "o assert está quebrado" não sejam indistinguíveis.
echo "→ D9 pré-flight de ordem…"
TEM_PISO="$(Pq -c "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='v_tint_formula_canonica' AND column_name='preco_piso_legado')")"
eq "D9.baseline o detector enxerga a coluna VIVA (senão o assert é tautologia)" "$TEM_PISO" "t"

# Derruba a view para a versão de 13 colunas (= mundo sem o #1535) e exige que a
# Fase 5 ABORTE. Captura a SQLSTATE e o texto do RAISE — nunca `WHEN OTHERS`.
P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null
P -q -f "$MIGRATION"  >/dev/null; P -q -f "$MIGRATION2" >/dev/null
P -q -f "$MIGRATION3" >/dev/null; P -q -f "$MIGRATION4" >/dev/null
# ⚠️ O BLOCO 1 (DDL) roda ANTES do pré-flight, que vive no BLOCO 2 — então a
# coluna/CHECK são criados mesmo nesta tentativa de ordem errada. É inócuo
# (ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT são idempotentes) e nenhuma
# LINHA é tocada, que é o que importa: o UPDATE está atrás do pré-flight.
#
# ⚠️ Sentinela ASCII, caixa fixa, sem `-i`, e EXCLUSIVA deste ramo: 'FASE 5
# ABORTADA' aparece em 6 RAISEs diferentes desta migration e casaria o vermelho
# errado. A 1ª rodada deste harness falhou exatamente aqui — procurava 'ORDEM
# ERRADA' enquanto a v2 emite 'ORDEM/SHAPE ERRADO', e o assert reportou "sem
# dente" para um pré-flight que estava funcionando. O tell foi a saída capturada
# não conter NENHUM texto de erro meu.
ORDEM_OUT="$(P -f "$MIGRATION6" 2>&1 || true)"
case "$ORDEM_OUT" in
  *"ORDEM/SHAPE ERRADO"*) ok "D9 a Fase 5 ABORTA quando o #1535 não foi aplicado (13 colunas)" ;;
  *) bad "D9 a Fase 5 NÃO abortou sem o #1535 — pré-flight de ordem sem dente. Saída: $(printf '%s' "$ORDEM_OUT" | tr '\n' ' ' | cut -c1-260)" ;;
esac
# O UPDATE não pode ter tocado nada: prova que o pré-flight barra ANTES do DML.
eq "D9b nenhuma linha foi carimbada na tentativa de ordem errada" \
   "$(Pq -c "SELECT count(*) FROM public.tint_formulas WHERE desativada_motivo IS NOT NULL")" "0"
# Restaura o mundo COM o #1535 para o resto do harness
P -q -f "$MIGRATION5" >/dev/null || { echo "FALHA: re-aplicar piso legado"; exit 1; }

echo "→ seeds (ANTES da Fase 5 — ela é DDL+DML)…"
P -q <<'SQL' || { echo "FALHA no seed"; exit 1; }
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master') ON CONFLICT DO NOTHING;

INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem, descricao) VALUES
  ('5c000000-0000-0000-0000-000000000001','oben','SL','SL'),
  ('0d000000-0000-0000-0000-000000000001','oben','1','SAYERLACK'),
  -- Subcoleções FUTURAS + rótulo NULL: sem elas, "allowlist da '1'" é
  -- indistinguível de `<> 'SL'`, `IN ('1','2')`, `LIKE '1%'` e
  -- `COALESCE(id_subcolecao_sayersystem,'1')='1'` — 4 mutantes passariam tudo
  -- (achado (a)-2 do challenge Codex sobre o #1505). '10' mata o LIKE; o
  -- rótulo NULL mata o COALESCE (a coluna é NULLABLE em prod).
  ('02000000-0000-0000-0000-000000000002','oben','2','FUTURA 2'),
  ('10000000-0000-0000-0000-000000000010','oben','10','FUTURA 10'),
  ('0e000000-0000-0000-0000-00000000000e','oben',NULL,'SEM CODIGO'),
  -- 2ª CONTA: a FK de tint_formulas.subcolecao_id referencia tint_subcolecoes(id)
  -- SEM account, então nada no banco impede uma fórmula de 'oben' apontar para a
  -- subcoleção '1' de 'colacor'. Quem barra é o `s2.account = g2.account` do
  -- EXISTS da allowlist — e um harness monoconta não exerce esse guard.
  ('c1000000-0000-0000-0000-000000000001','colacor','1','COLACOR SAYERLACK');

INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account) VALUES
  ('0b000000-0000-0000-0000-00000000ba5e', 900001,'BASE-OK','Base OK',    100, true, 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c01', 900003,'COR-OK','Corante OK',  200, true, 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c02', 900004,'COR-Z','Corante zero',   0, true, 'oben');

INSERT INTO public.tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','oben','WPOK','Corante OK',  810,'0c000000-0000-0000-0000-0000000c0c01'),
  ('c0000000-0000-0000-0000-000000000002','oben','WPRU','Corante RUIM',810,'0c000000-0000-0000-0000-0000000c0c02');

INSERT INTO public.tint_produtos  (id, account, cod_produto, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000001','oben','P1','Produto 1');
INSERT INTO public.tint_bases     (id, account, id_base_sayersystem, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000002','oben','B1','Base 1');
INSERT INTO public.tint_embalagens(id, account, id_embalagem_sayersystem, descricao, volume_ml) VALUES
  ('a0000000-0000-0000-0000-0000000000e1','oben','E1','Emb 1',900),
  ('a0000000-0000-0000-0000-0000000000e2','oben','E2','Emb 2',900),
  ('a0000000-0000-0000-0000-0000000000e3','oben','E3','Emb 3',900),
  ('a0000000-0000-0000-0000-0000000000e4','oben','E4','Emb 4',900),
  ('a0000000-0000-0000-0000-0000000000e5','oben','E5','Emb 5',900),
  ('a0000000-0000-0000-0000-0000000000e6','oben','E6','Emb 6',900),
  ('a0000000-0000-0000-0000-0000000000e7','oben','E7','Emb 7',900),
  ('a0000000-0000-0000-0000-0000000000e8','oben','E8','Emb 8',900),
  ('a0000000-0000-0000-0000-0000000000e9','oben','E9','Emb 9',900),
  ('a0000000-0000-0000-0000-0000000000ea','oben','E10','Emb 10',900);

-- 1 SKU por chave (em prod o sku_id JÁ discrimina embalagem — medido: 2 linhas
-- ativas por chave em 463.995 chaves, 1 em 31.981; a chave da view NÃO colapsa
-- embalagens, e o seed espelha isso).
INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-00000000000a','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000b','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000c','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000d','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e4','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000e','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e5','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000f','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e6','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-000000000010','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e7','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-000000000011','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e8','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-000000000012','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e9','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-000000000013','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000ea','0b000000-0000-0000-0000-00000000ba5e');

-- ── as CHAVES do teste (cada uma num sku_id ⇒ chave própria) ──────────────
-- K1 @sku ...0a  ALVO   : SL válida  +  '1' ativa CSV 300
-- K2 @sku ...0b  D3     : SL SEM receita + '1' ativa CSV 400
-- K3 @sku ...0c  D4     : SL c/ corante sem custo + '1' ativa CSV 500
-- K4 @sku ...0d  D2/"12": SÓ '1' ativa CSV 600 (sem gêmea SL nenhuma)
-- K5 @sku ...0e  V2     : SL válida + '1' JÁ desativada pelo SNAPSHOT CSV 900
-- K6 @sku ...0f  V6     : SL válida + '1' ativa CSV 700 + personalizada CSV 800
-- K7 @sku ...10  D6     : SÓ personalizada ativa CSV 850
INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  ('f0010000-0000-0000-0000-0000000000a1','oben','K1','ALVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0010000-0000-0000-0000-000000000011','oben','K1','ALVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',300),
  ('f0020000-0000-0000-0000-0000000000a2','oben','K2','SLVAZIA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000b',NULL),
  ('f0020000-0000-0000-0000-000000000022','oben','K2','SLVAZIA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000b',400),
  ('f0030000-0000-0000-0000-0000000000a3','oben','K3','SLRUIM','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',NULL),
  ('f0030000-0000-0000-0000-000000000033','oben','K3','SLRUIM','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',500),
  ('f0040000-0000-0000-0000-000000000044','oben','K4','SOSAYER','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e4','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000d',600),
  ('f0050000-0000-0000-0000-0000000000a5','oben','K5','SNAPSHOT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e5','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000e',NULL),
  ('f0050000-0000-0000-0000-000000000055','oben','K5','SNAPSHOT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e5','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000e',900),
  ('f0060000-0000-0000-0000-0000000000a6','oben','K6','MISTA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e6','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000f',NULL),
  ('f0060000-0000-0000-0000-000000000066','oben','K6','MISTA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e6','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000f',700),
  ('f0060000-0000-0000-0000-0000000000b6','oben','K6','MISTA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e6',NULL,'50000000-0000-0000-0000-00000000000f',800),
  ('f0070000-0000-0000-0000-0000000000b7','oben','K7','SOPERSO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e7',NULL,'50000000-0000-0000-0000-000000000010',850),
  -- K8 @sku ...11 GUARD DE CONTA: SL válida + linha de 'oben' apontando para a
  -- subcoleção '1' de COLACOR (a FK permite — não tem account). Quem barra é o
  -- `s2.account = g2.account` da allowlist. Ela NÃO é alvo da Fase 5 (o UPDATE
  -- exige s1.account = f.account), então fica ATIVA — e mesmo ativa não pode
  -- alimentar o rótulo.
  ('f0080000-0000-0000-0000-0000000000a8','oben','K8','CROSSACC','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e8','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000011',NULL),
  ('f0080000-0000-0000-0000-0000000000c8','oben','K8','CROSSACC','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e8','c1000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000011',950),
  -- K9 @sku ...12 EXCLUSIVIDADE DO LITERAL '1': SL válida + subcoleções '2',
  -- '10' e rótulo-NULL com CSV alto, e NENHUMA linha da geração '1'. O rótulo
  -- tem de ser NULL. Mata 4 mutantes de uma vez: `<> 'SL'` (pegaria 960),
  -- `IN ('1','2')` (960), `LIKE '1%'` (970) e `COALESCE(rotulo,'1')='1'` (980).
  ('f0090000-0000-0000-0000-0000000000a9','oben','K9','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e9','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000012',NULL),
  ('f0090000-0000-0000-0000-000000000029','oben','K9','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e9','02000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000012',960),
  ('f0090000-0000-0000-0000-000000000109','oben','K9','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e9','10000000-0000-0000-0000-000000000010','50000000-0000-0000-0000-000000000012',970),
  ('f0090000-0000-0000-0000-0000000000e9','oben','K9','FUTURAS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e9','0e000000-0000-0000-0000-00000000000e','50000000-0000-0000-0000-000000000012',980),
  -- K10 @sku ...13 ISOLA O FILTRO DO RANK (o cenario que torna F1 falsificavel).
  -- SL valida + '1' com CSV 400: a Fase 5 carimba a '1'. DEPOIS o harness
  -- desativa a SL (sem carimbo), simulando o P1-7 do Codex — a gemea sair de
  -- cena apos o carimbo. Ai a chave nao tem NENHUMA linha ativa e some da
  -- canonica; se o filtro de candidata for relaxado, a '1' carimbada volta.
  ('f0100000-0000-0000-0000-0000000000aa','oben','K10','POSTSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000ea','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000013',NULL),
  ('f0100000-0000-0000-0000-0000000000c1','oben','K10','POSTSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000ea','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000013',400);

-- receitas: SL válida em K1/K5/K6; K2 SL sem receita; K3 SL com corante ruim.
-- '1' e personalizadas também recebem receita (não é o que decide o ALVO, mas
-- fórmula sem receita não é canônica e poluiria o rank).
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f0010000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0010000-0000-0000-0000-000000000011','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0020000-0000-0000-0000-000000000022','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0030000-0000-0000-0000-0000000000a3','c0000000-0000-0000-0000-000000000002',1,10),
  ('f0030000-0000-0000-0000-000000000033','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0040000-0000-0000-0000-000000000044','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0050000-0000-0000-0000-0000000000a5','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0050000-0000-0000-0000-000000000055','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0060000-0000-0000-0000-0000000000a6','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0060000-0000-0000-0000-000000000066','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0060000-0000-0000-0000-0000000000b6','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0070000-0000-0000-0000-0000000000b7','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0080000-0000-0000-0000-0000000000a8','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0080000-0000-0000-0000-0000000000c8','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0090000-0000-0000-0000-0000000000a9','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0090000-0000-0000-0000-000000000029','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0090000-0000-0000-0000-000000000109','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0090000-0000-0000-0000-0000000000e9','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0100000-0000-0000-0000-0000000000aa','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0100000-0000-0000-0000-0000000000c1','c0000000-0000-0000-0000-000000000001',1,10);

-- K5: a '1' JÁ desativada por OUTRO mecanismo (o snapshot), carimbo NULL.
-- É a população de 1.704 chaves medida em prod — o CSV dela NÃO pode ressuscitar.
UPDATE public.tint_formulas SET desativada_em = now() - interval '3 days'
 WHERE id = 'f0050000-0000-0000-0000-000000000055';
SQL

# Estado pré-Fase-5, para as falsificações voltarem ao ponto de partida.
P -q -c "CREATE TABLE _estado0 AS SELECT id, desativada_em FROM public.tint_formulas;" >/dev/null
reset_estado() {
  P -q -c "UPDATE public.tint_formulas f SET desativada_em = e.desativada_em, desativada_motivo = NULL
             FROM _estado0 e WHERE e.id = f.id;" >/dev/null
}

# Aplica uma versão da Fase 5 ($1) e recria o cenário K10: a gêmea SL sai de
# cena DEPOIS do carimbo. Precisa rodar após CADA aplicação (real ou sabotada),
# porque o reset_estado devolve a SL de K10 ao estado ativo original.
aplica_fase5() {
  P -q -f "$1" >/dev/null 2>&1 || return 1
  P -q -c "UPDATE public.tint_formulas SET desativada_em = now()
             WHERE id = 'f0100000-0000-0000-0000-0000000000aa';" >/dev/null 2>&1 || true
}

echo "→ aplicando a FASE 5 (migration REAL — Lei #1: nunca um stub da lógica)…"
aplica_fase5 "$MIGRATION6" || { echo "FALHA: a Fase 5 não aplicou"; exit 1; }

# ── ASSERTS ──────────────────────────────────────────────────────────────────
echo
echo "── A DESATIVAÇÃO ──"
eq "D1 ALVO desativada"            "$(Pq -c "SELECT (desativada_em IS NOT NULL) FROM public.tint_formulas WHERE id='f0010000-0000-0000-0000-000000000011'")" "t"
eq "D1 ALVO carimbada"             "$(Pq -c "SELECT COALESCE(desativada_motivo,'(null)') FROM public.tint_formulas WHERE id='f0010000-0000-0000-0000-000000000011'")" "fase5_geracao_legada"
eq "D2 as \"12\" INTACTAS (sem gêmea SL)" "$(Pq -c "SELECT (desativada_em IS NULL AND desativada_motivo IS NULL) FROM public.tint_formulas WHERE id='f0040000-0000-0000-0000-000000000044'")" "t"
eq "D3 gêmea SL sem RECEITA → não desativa"     "$(Pq -c "SELECT (desativada_em IS NULL) FROM public.tint_formulas WHERE id='f0020000-0000-0000-0000-000000000022'")" "t"
eq "D4 gêmea SL com corante SEM CUSTO → não desativa" "$(Pq -c "SELECT (desativada_em IS NULL) FROM public.tint_formulas WHERE id='f0030000-0000-0000-0000-000000000033'")" "t"
# D5 mede o CARIMBO, não `desativada_em`: o próprio harness desativa a SL de K10
# (cenário do V5c), então contar desativações puniria a intervenção deliberada.
# O carimbo é o que a MIGRATION escreve — é ele que prova que ela não tocou a SL.
# ⚠️ Este assert quebrou quando o K10 entrou: endurecer o harness transforma em
# suspeito todo assert que dependia do mundo anterior. Mesma família da lição
# "ao ENDURECER um gate, todo assert que dependia do gate antigo vira suspeito".
eq "D5 nenhuma linha SL foi CARIMBADA pela migration"  "$(Pq -c "SELECT count(*) FROM public.tint_formulas f JOIN public.tint_subcolecoes s ON s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL' WHERE f.desativada_motivo IS NOT NULL")" "0"
eq "D5b a SL de K10 foi desativada pelo HARNESS (sem carimbo), não pela migration" "$(Pq -c "SELECT (desativada_em IS NOT NULL AND desativada_motivo IS NULL) FROM public.tint_formulas WHERE id='f0100000-0000-0000-0000-0000000000aa'")" "t"
eq "D6 nenhuma personalizada foi desativada"    "$(Pq -c "SELECT count(*) FROM public.tint_formulas WHERE subcolecao_id IS NULL AND desativada_em IS NOT NULL")" "0"
eq "D7 desativada pelo SNAPSHOT não foi re-carimbada" "$(Pq -c "SELECT COALESCE(desativada_motivo,'(null)') FROM public.tint_formulas WHERE id='f0050000-0000-0000-0000-000000000055'")" "(null)"

echo
echo "── A VIEW, SOB A VERSÃO DA FASE 5 (lição #1517: re-exercer, não herdar) ──"
# K1: a '1' foi carimbada ⇒ o CSV 300 SOBREVIVE à desativação (decisão opção B).
eq "V1 carimbada ENTRA no preco_csv_legado"  "$(Pq -c "SELECT COALESCE(preco_csv_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K1'")" "300"
# K5: a '1' saiu pela FONTE (carimbo NULL) ⇒ o CSV 900 NÃO ressuscita.
eq "V2 desativada SEM carimbo fica FORA (as 1.704 de prod)" "$(Pq -c "SELECT COALESCE(preco_csv_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K5'")" "(null)"
eq "V3 I1 global: (csv IS NULL) ⟺ (piso IS NULL)" "$(Pq -c "SELECT count(*) FROM public.v_tint_formula_canonica WHERE (preco_csv_legado IS NULL) <> (preco_piso_legado IS NULL)")" "0"
eq "V4 I2 global: piso >= csv"                    "$(Pq -c "SELECT count(*) FROM public.v_tint_formula_canonica WHERE preco_csv_legado IS NOT NULL AND preco_piso_legado < preco_csv_legado")" "0"
# K1: a SL ativa não tem CSV (espelha prod: 0 de 495.057), então max_ativo é
# NULL e o GREATEST cai no próprio csv. Antes da Fase 5 o piso aqui era 300 (a
# '1' ATIVA entrava no max) — mesmo valor ⇒ a fase é NO-OP no gate de submit.
eq "V4b piso de K1 = csv quando não há CSV ativo (NO-OP no gate)" "$(Pq -c "SELECT COALESCE(preco_piso_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K1'")" "300"
# ⚠️ O MAIS CRÍTICO: o carimbo não devolve a linha ao catálogo.
eq "V5 carimbada NÃO volta a ser candidata a canônica" "$(Pq -c "SELECT count(*) FROM public.v_tint_formula_canonica WHERE id='f0010000-0000-0000-0000-000000000011'")" "0"
eq "V5b a canônica de K1 é a SL (1 linha só)"          "$(Pq -c "SELECT count(*)||':'||COALESCE(string_agg(id::text,','),'-') FROM public.v_tint_formula_canonica WHERE cor_id='K1'")" "1:f0010000-0000-0000-0000-0000000000a1"
# K6: allowlist — a personalizada (CSV 800) NÃO entra no RÓTULO (canônica é SL),
# mas ENTRA no PISO (que não filtra proveniência). A assimetria é deliberada.
eq "V6 allowlist intacta: rótulo lê só a '1' carimbada" "$(Pq -c "SELECT COALESCE(preco_csv_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K6'")" "700"
eq "V6b piso lê o superconjunto (personalizada entra)"  "$(Pq -c "SELECT COALESCE(preco_piso_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K6'")" "800"
# ── V8/V9: invariantes da CADEIA re-exercidos SOB A VERSÃO DA FASE 5 ──────────
# ⚠️ Lição #1517: `db/test-tint-canonica.sh` prova C19 (guard de conta) e C20
# (exclusividade do '1') contra a versão do #1535 — a Fase 5 faz REPLACE da view
# INTEIRA e herdaria cobertura ILUSÓRIA. Aqui eles rodam contra a versão que vai
# a produção. VERSÃO COBERTA ≠ VERSÃO ENTREGUE.
eq "V8 guard de CONTA: subcoleção '1' de OUTRA conta não alimenta o rótulo" "$(Pq -c "SELECT COALESCE(preco_csv_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K8'")" "(null)"
eq "V8b a linha cross-account NÃO foi carimbada (não é alvo)" "$(Pq -c "SELECT (desativada_em IS NULL AND desativada_motivo IS NULL) FROM public.tint_formulas WHERE id='f0080000-0000-0000-0000-0000000000c8'")" "t"
eq "V9 EXCLUSIVIDADE do literal '1': subcoleções 2/10/rótulo-NULL fora do rótulo" "$(Pq -c "SELECT COALESCE(preco_csv_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K9'")" "(null)"
eq "V9b I1 vale em K9 (csv NULL ⇒ piso NULL, mesmo com CSV 960/970/980 ativos)" "$(Pq -c "SELECT COALESCE(preco_piso_legado::text,'(null)') FROM public.v_tint_formula_canonica WHERE cor_id='K9'")" "(null)"
eq "V7 shape: 14 colunas"                     "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='v_tint_formula_canonica'")" "14"
eq "V7b 14ª coluna é preco_piso_legado"       "$(Pq -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='v_tint_formula_canonica' AND ordinal_position=14")" "preco_piso_legado"
eq "V7c security_invoker=on sobreviveu ao REPLACE (#1375)" "$(Pq -c "SELECT COALESCE((SELECT 'on' FROM pg_class WHERE relname='v_tint_formula_canonica' AND 'security_invoker=on' = ANY(reloptions)),'AUSENTE')")" "on"

echo
echo "── D8/F4: GUARD DE COBERTURA (o assert que a migration faz sobre si mesma) ──"
# Sabota o UPDATE tornando o EXISTS de gêmea SL válida sempre verdadeiro. Aí a
# '1' de K4 — que NÃO tem gêmea SL nenhuma, e representa as 12 chaves exclusivas
# de prod — também vira alvo, e a chave K4 ficaria SEM NENHUMA linha ativa.
# O guard tem de ABORTAR e a transação inteira reverter.
#
# ⚠️ Este é o assert que separa "a fase preserva as 12" de "a fase apagaria cor
# do catálogo". Sem ele, D2 provaria só que o EXISTS está lá HOJE — não que há
# uma rede embaixo se alguém o afrouxar.
reset_estado
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-f4.XXXXXX")"
# Alvo: o JOIN que restringe o alvo às chaves COM gêmea SL válida. `ON true`
# faz toda linha '1' ativa virar alvo — inclusive a de K4, que não tem gêmea
# nenhuma (as "12" de prod). O guard tem de abortar.
# ⚠️ Este sed já ficou INERTE uma vez: a v1 casava `AND v.cor_id  = f.cor_id);`
# e eu reformulei os guards, movendo o predicado para um JOIN. A guarda `grep -q`
# abaixo é o que transformou isso num vermelho honesto em vez de um verde falso
# — sem ela, "a sabotagem não fez nada" e "a sabotagem não pegou" seriam
# indistinguíveis. Toda falsificação por sed precisa provar que MORDEU o arquivo.
sed 's/^      ON v\.account = f\.account AND v\.sku_id = f\.sku_id AND v\.cor_id = f\.cor_id$/      ON true/' "$MIGRATION6" > "$SAB"
if ! command grep -q '^      ON true$' "$SAB"; then
  bad "F4 a sabotagem NAO casou o alvo no arquivo (sed sem efeito) — falsificacao inerte"
else
  D8_OUT="$(P -f "$SAB" 2>&1 || true)"
  # ⚠️ Sentinela = 'FASE 5 ABORTADA' (comum aos 8 guards), e o REPORTE diz qual
  # pegou. Por que não exigir um guard específico: com `ON true` o JOIN vira
  # produto cartesiano, então a sabotagem dispara PRIMEIRO o guard de contagem
  # (`atualizou X, alvo era Y`) e nunca chega no de cobertura. Exigir a string
  # de um guard específico produziria vermelho por SENTINELA errada — foi o que
  # aconteceu na 3ª rodada (o assert dizia "NAO abortou" enquanto o D8b provava
  # que abortou). O invariante que o F4 defende é "as 12 não são desativadas
  # quando a proteção cai", e quem prova isso é o D8b logo abaixo.
  case "$D8_OUT" in
    *"FASE 5 ABORTADA"*)
      ok "D8/F4 a migration ABORTOU: $(printf '%s' "$D8_OUT" | tr '\n' ' ' | sed -n 's/.*\(FASE 5 ABORTADA.\{0,95\}\).*/\1/p' | head -1)" ;;
    *)
      bad "D8/F4 NAO abortou — sem rede sob as 12 chaves exclusivas. Saída: $(printf '%s' "$D8_OUT" | tr '\n' ' ' | cut -c1-400)" ;;
  esac
  # A transação tem de ter revertido: K4 segue ATIVA e nada ficou carimbado.
  eq "D8b após o ABORT a transação reverteu (K4 intacta)" \
     "$(Pq -c "SELECT (desativada_em IS NULL AND desativada_motivo IS NULL) FROM public.tint_formulas WHERE id='f0040000-0000-0000-0000-000000000044'")" "t"
fi
rm -f "$SAB"

# Repõe o mundo pós-Fase-5 real para as falsificações da VIEW que vêm a seguir.
reset_estado
P -q -f "$MIGRATION6" >/dev/null || { echo "FALHA: re-aplicar a Fase 5 após o teste do guard"; exit 1; }

# ── FALSIFICAÇÕES ────────────────────────────────────────────────────────────
# Cada sabotagem nasce por `sed` sobre a migration REAL, garantindo diferença de
# exatamente 1 ponto (senão a sabotagem muda 2 coisas e não isola o que prova).
echo
echo "── FALSIFICAÇÕES ──"

roda_asserts_sql() {
  # Emite "TODOS_OK" ou "FALHAS[n]: X FALHOU | Y FALHOU". Acumula em array em vez
  # de abortar no 1º RAISE — sem isso "vermelho certo E SÓ ELE" é inverificável
  # (achado (e) do challenge Codex xhigh sobre o #1505).
  Pq <<'SQL'
DO $$
DECLARE f text[] := '{}';
BEGIN
  IF (SELECT COALESCE(preco_csv_legado::text,'-') FROM public.v_tint_formula_canonica WHERE cor_id='K1') <> '300'
    THEN f := array_append(f, 'V1'); END IF;
  IF (SELECT COALESCE(preco_csv_legado::text,'-') FROM public.v_tint_formula_canonica WHERE cor_id='K5') <> '-'
    THEN f := array_append(f, 'V2'); END IF;
  IF (SELECT count(*) FROM public.v_tint_formula_canonica WHERE (preco_csv_legado IS NULL) <> (preco_piso_legado IS NULL)) <> 0
    THEN f := array_append(f, 'V3'); END IF;
  IF (SELECT count(*) FROM public.v_tint_formula_canonica WHERE preco_csv_legado IS NOT NULL AND preco_piso_legado < preco_csv_legado) <> 0
    THEN f := array_append(f, 'V4'); END IF;
  IF (SELECT count(*) FROM public.v_tint_formula_canonica WHERE id='f0010000-0000-0000-0000-000000000011') <> 0
    THEN f := array_append(f, 'V5'); END IF;
  IF (SELECT COALESCE(preco_csv_legado::text,'-') FROM public.v_tint_formula_canonica WHERE cor_id='K6') <> '700'
    THEN f := array_append(f, 'V6'); END IF;
  -- V5c ISOLA O FILTRO DE CANDIDATA DO RANK. K10 tem a '1' carimbada e a SL
  -- desativada DEPOIS ⇒ nenhuma linha ativa ⇒ a chave some da canônica.
  -- Sob F1 (filtro relaxado) a '1' carimbada volta, porque aqui o rank NÃO
  -- protege: não há gêmea ativa melhor para excluí-la.
  IF (SELECT count(*) FROM public.v_tint_formula_canonica WHERE cor_id='K10') <> 0
    THEN f := array_append(f, 'V5c'); END IF;
  IF array_length(f,1) IS NULL THEN RAISE NOTICE 'TODOS_OK';
  ELSE RAISE NOTICE 'FALHAS[%]: %', array_length(f,1),
       (SELECT string_agg(x || ' FALHOU', ' | ') FROM unnest(f) x); END IF;
END $$;
SQL
}

# ⚠️ AS FALSIFICAÇÕES NÃO DROPAM A VIEW — usam `reset_estado` + REPLACE.
# Motivo (achado da 4ª rodada, e é uma interação que a própria v2 criou): o
# pré-flight de ordem da migration exige a view com as 14 colunas. Dropá-la
# antes faz o pré-flight ABORTAR, a versão sabotada nunca é criada, e os asserts
# falham com 'relation does not exist' — vermelho por INFRAESTRUTURA, não por
# defeito, que é indistinguível de "o assert tem dente" se você só olhar o exit.
# Nenhuma das sabotagens muda o SHAPE (só expressões), então CREATE OR REPLACE
# basta. O `reset_estado` devolve o catálogo ao pré-Fase-5 para que o UPDATE da
# versão sabotada tenha alvo (senão o guard de 'alvo VAZIO' aborta).
# Lição geral: endurecer um gate transforma em suspeito todo teste que dependia
# do gate antigo — inclusive a maquinaria do próprio harness.

# F1 — relaxa TAMBÉM o filtro de candidata a canônica.
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-f1.XXXXXX")"
sed 's/^WHERE f\.desativada_em IS NULL$/WHERE (f.desativada_em IS NULL OR f.desativada_motivo = '"'"'fase5_geracao_legada'"'"')/' "$MIGRATION6" > "$SAB"
reset_estado
aplica_fase5 "$SAB" || true
OUT="$(roda_asserts_sql 2>&1 || true)"
confere_falsificacao "F1" "$OUT" 1 V5c -- "relaxar o filtro de CANDIDATA ressuscita a geração desativada onde o rank não protege"
rm -f "$SAB"

# F2 — relaxa AMPLO: ignora o carimbo (é a decisão original de 20/07, e o que a
# medição de prod mostrou ser afrouxamento nas 1.704 chaves).
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-f2.XXXXXX")"
sed "s/OR g2\.desativada_motivo = 'fase5_geracao_legada'/OR g2.desativada_em IS NOT NULL/g" "$MIGRATION6" > "$SAB"
reset_estado
aplica_fase5 "$SAB" || true
OUT="$(roda_asserts_sql 2>&1 || true)"
confere_falsificacao "F2" "$OUT" 1 V2 -- "relaxamento amplo ressuscita o CSV que a FONTE aposentou"
rm -f "$SAB"

# F3 — o SPEC INGÊNUO do piso: devolver o max das ATIVAS direto, em vez de
# GREATEST(csv, COALESCE(max_ativo, csv)). Como a geração SL tem CSV em 0 de
# 495.057 linhas em prod, depois da desativação o max das ativas não acha CSV
# nenhum ⇒ piso NULL com csv 300 ⇒ I1 quebra.
# ⚠️ Na v1 esta falsificação atacava "a 3ª cópia do predicado dessincronizada".
# A v2 (Codex P2-10) calcula o CSV UMA VEZ no LATERAL, então aquela classe de
# bug deixou de existir — não há mais cópias para dessincronizar. O que sobrou
# para falsificar é a EXPRESSÃO do piso, e é ela que este F3 ataca agora.
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-f3.XXXXXX")"
sed 's/ELSE GREATEST(lg\.csv_legado, COALESCE(lg\.max_ativo, lg\.csv_legado))/ELSE lg.max_ativo/' "$MIGRATION6" > "$SAB"
if ! command grep -q 'ELSE lg\.max_ativo' "$SAB"; then
  bad "F3 a sabotagem NAO casou o alvo no arquivo (sed sem efeito) — falsificacao inerte"
else
  reset_estado
  aplica_fase5 "$SAB" || true
  OUT="$(roda_asserts_sql 2>&1 || true)"
  confere_falsificacao "F3" "$OUT" 1 V3 -- "spec ingênuo do piso (max das ativas direto) quebra o NULL-preserving I1"
fi
rm -f "$SAB"

# Restaura a view REAL e reconfirma o verde (o restore é parte da prova).
reset_estado
aplica_fase5 "$MIGRATION6" || true
OUT="$(roda_asserts_sql 2>&1 || true)"
case "$OUT" in
  *TODOS_OK*) ok "R restauração: a migration REAL deixa todos os asserts da view verdes" ;;
  *) bad "R restauração FALHOU — a migration real não repõe o estado: $OUT" ;;
esac

echo
echo "── W: O VALIDADOR PÓS-APPLY TEM DENTE? (lição #1490/#1501) ──"
# db/valida-tint-fase5.sql é o que o founder cola no SQL Editor para decidir se
# o apply deu certo — ou seja, é CÓDIGO DE AUTORIZAÇÃO. E ele nasce sem prova,
# porque "só confere". Erra nas duas direções: falso NEGATIVO (reprova banco
# correto → ensina a ignorar o vermelho, e o próximo vermelho REAL vira ruído)
# e falso POSITIVO (aprova banco errado). Aqui ele é EXECUTADO contra os dois
# mundos.
VALIDA="$REPO_ROOT/db/valida-tint-fase5.sql"
reset_estado; aplica_fase5 "$MIGRATION6" || true

W_OK="$(P -tA -f "$VALIDA" 2>&1 || true)"
case "$W_OK" in
  *"❌"*) bad "W1 o validador REPROVOU um banco CORRETO (falso negativo — pior que não validar): $(printf '%s' "$W_OK" | command grep -o '❌[^|]\{0,90\}' | head -1)" ;;
  *)      ok  "W1 o validador aprova o banco BOM (nenhum ❌)" ;;
esac

# W2 — view SEM o relaxamento do carimbo: o c5_relax tem de acusar.
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-w2.XXXXXX")"
sed "s/OR g2\.desativada_motivo = 'fase5_geracao_legada'//g" "$MIGRATION6" > "$SAB"
reset_estado; aplica_fase5 "$SAB" || true
W_BAD="$(P -tA -f "$VALIDA" 2>&1 || true)"
case "$W_BAD" in
  *"a view NÃO relaxou para o carimbo"*) ok "W2 o validador ACUSA a view sem o relaxamento (c5_relax morde)" ;;
  *) bad "W2 o validador NAO acusou a view sem relaxamento — é CARIMBO: $(printf '%s' "$W_BAD" | tr '\n' ' ' | cut -c1-220)" ;;
esac
rm -f "$SAB"

# W3 — filtro de candidata RELAXADO: o c6_candidata tem de acusar. É o furo mais
# grave (a geração desativada volta ao catálogo) e o mais silencioso: todo o
# resto do validador continuaria ✅.
SAB="$(mktemp "${TMPDIR:-/tmp}/fase5-w3.XXXXXX")"
sed 's/^WHERE f\.desativada_em IS NULL$/WHERE (f.desativada_em IS NULL OR f.desativada_motivo = '"'"'fase5_geracao_legada'"'"')/' "$MIGRATION6" > "$SAB"
reset_estado; aplica_fase5 "$SAB" || true
W_BAD3="$(P -tA -f "$VALIDA" 2>&1 || true)"
case "$W_BAD3" in
  *"o filtro de candidata foi relaxado"*) ok "W3 o validador ACUSA o filtro de candidata relaxado (c6 morde)" ;;
  *) bad "W3 o validador NAO acusou o filtro relaxado — o furo mais grave passaria: $(printf '%s' "$W_BAD3" | tr '\n' ' ' | cut -c1-220)" ;;
esac
rm -f "$SAB"

# Repõe o mundo real.
reset_estado; aplica_fase5 "$MIGRATION6" || true

echo
echo "════════════════════════════════════════════"
echo "  ✅ $PASS   ❌ $FAIL"
echo "════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
