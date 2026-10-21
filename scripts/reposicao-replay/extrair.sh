#!/usr/bin/env bash
# extrair.sh — extração SOMENTE-LEITURA dos dados do replay TSB (estoque de segurança Sayerlack).
#
# Uso:
#   bash scripts/reposicao-replay/extrair.sh             # extrai (psql-ro), confere, carimba, grava extracao.log
#   bash scripts/reposicao-replay/extrair.sh --conferir  # só confere os arquivos já presentes em $REPLAY_DADOS
#
# Saída em ${REPLAY_DADOS:-$HOME/.cache/afiacao/reposicao-replay} (NUNCA no repositório).
# Contrato dos CSVs: separador `|`, cabeçalho, ÚLTIMA linha `fim|ok`. Fail-closed: falta de arquivo, de cabeçalho
# ou de marcador => exit != 0 (2 = arquivo ausente/vazio, 3 = marcador `fim|ok` ausente, 1 = psql falhou,
# 5 = skus.csv duplicado ou contagem de recebimentos falhou, 4 = gate §5.1.1 reprovado: outras empresas > 5% das linhas ou do valor — pare e fale com o founder).
# Variáveis: REPLAY_DADOS (pasta), PSQL_RO (default ~/.config/afiacao/psql-ro).
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${REPLAY_DADOS:-$HOME/.cache/afiacao/reposicao-replay}"
PSQL_RO="${PSQL_RO:-$HOME/.config/afiacao/psql-ro}"
CSVS=(vendas recebimentos skus config_custos classificacao_hist teto equivalencias sugestao_hoje)
TXTS=(outras_empresas grupos_embalagem)
LIMITE_GATE="5"

falha() { local cod="$1"; shift; echo "extrair.sh: ERRO: $*" >&2; exit "$cod"; }

# Confere que cada CSV existe, tem cabeçalho e termina em `fim|ok`; cada .txt existe e não é vazio.
conferir() {
  local n f ult
  for n in "${CSVS[@]}"; do
    f="$DIR/$n.csv"
    [[ -s "$f" ]] || falha 2 "faltando ou vazio: $f"
    ult="$(tail -n 1 "$f")"
    [[ "$ult" == "fim|ok" ]] || falha 3 "marcador fim|ok ausente na última linha de $f (última: '$ult')"
    # cabeçalho + >=1 linha de dados + marcador (3 linhas); só equivalencias.csv pode vir sem dados (grupos opcionais)
    minimo=3; [[ "$n" == "equivalencias" ]] && minimo=2
    [[ "$(wc -l < "$f" | tr -d ' ')" -ge "$minimo" ]] || falha 2 "sem linhas de dados (só cabeçalho/marcador) em $f"
  done
  for n in "${TXTS[@]}"; do
    f="$DIR/$n.txt"
    [[ -s "$f" ]] || falha 2 "faltando ou vazio: $f"
  done
  echo "conferir: ok (${#CSVS[@]} CSV com fim|ok, ${#TXTS[@]} txt) em $DIR"
}

if [[ "${1:-}" == "--conferir" ]]; then
  conferir
  exit 0
fi

mkdir -p "$DIR" || falha 1 "não consegui criar $DIR"
[[ -x "$PSQL_RO" ]] || falha 1 "psql read-only não encontrado/executável: $PSQL_RO"

# Remove saídas antigas: um arquivo velho nunca pode passar por novo.
for n in "${CSVS[@]}"; do rm -f "$DIR/$n.csv"; done
for n in "${TXTS[@]}"; do rm -f "$DIR/$n.txt"; done

SAIDA="$(mktemp "${TMPDIR:-/tmp}/extrair-psql.XXXXXX")"
trap 'rm -f "$SAIDA"' EXIT

"$PSQL_RO" -v ON_ERROR_STOP=1 -At -v "dir=$DIR" -f "$AQUI/extrair.sql" >"$SAIDA" 2>&1
rc=$?
if [[ "$rc" -ne 0 ]]; then
  tail -n 15 "$SAIDA" >&2
  falha 1 "psql terminou com rc=$rc"
fi
grep -qx 'fim|ok' "$SAIDA" || { tail -n 15 "$SAIDA" >&2; falha 3 "o psql não imprimiu o marcador fim|ok"; }

# Existência/cabeçalho ANTES de carimbar (um CSV só com cabeçalho é válido: ex.: equivalencias).
for n in "${CSVS[@]}"; do
  [[ -s "$DIR/$n.csv" ]] || falha 2 "faltando ou vazio: $DIR/$n.csv"
done
for n in "${TXTS[@]}"; do
  [[ -s "$DIR/$n.txt" ]] || falha 2 "faltando ou vazio: $DIR/$n.txt"
done

# Carimbo: o `fim|ok` só entra depois do psql rc=0 + marcador na saída.
for n in "${CSVS[@]}"; do echo 'fim|ok' >>"$DIR/$n.csv"; done
conferir

# skus.csv: 1 linha por SKU (join duplicado fabricaria SKU em dobro)
total_skus="$(awk 'NR>1 && $0!="fim|ok"' "$DIR/skus.csv" | wc -l | tr -d ' ')"
unicos_skus="$(awk -F'|' 'NR>1 && $0!="fim|ok"{print $1}' "$DIR/skus.csv" | sort -u | wc -l | tr -d ' ')"
[[ "$total_skus" -gt 0 && "$total_skus" == "$unicos_skus" ]] || falha 5 "skus.csv com SKU duplicado ou vazio (linhas=$total_skus, únicos=$unicos_skus)"

# ── extracao.log ─────────────────────────────────────────────────────────────
LOG="$DIR/extracao.log"
cont() { echo $(( $(wc -l <"$1" | tr -d ' ') - 2 )); }   # linhas de dados (sem cabeçalho e sem fim|ok)
{
  echo "extracao em $(date -u +%Y-%m-%dT%H:%M:%SZ)  dir=$DIR"
  for n in "${CSVS[@]}"; do
    printf '%-22s linhas=%s  md5=%s\n' "$n.csv" "$(cont "$DIR/$n.csv")" "$(md5 -q "$DIR/$n.csv" 2>/dev/null || md5sum "$DIR/$n.csv" | cut -d' ' -f1)"
  done
  echo "-- sanidade (medições anteriores: 391 SKUs Sayerlack; vendas OBEN 7594 linhas / 563 SKUs; sku_leadtime_history 4460 linhas / 1884 distintas)"
  echo "skus.csv linhas=$(cont "$DIR/skus.csv")"
  echo "vendas.csv linhas=$(cont "$DIR/vendas.csv") skus_distintos=$(tail -n +2 "$DIR/vendas.csv" | grep -v '^fim|ok$' | cut -d'|' -f2 | sort -u | wc -l | tr -d ' ') no_escopo=$(tail -n +2 "$DIR/vendas.csv" | grep -v '^fim|ok$' | awk -F'|' '$7==1' | wc -l | tr -d ' ') cmc_linha_vazio=$(tail -n +2 "$DIR/vendas.csv" | grep -v '^fim|ok$' | awk -F'|' '$6==""' | wc -l | tr -d ' ')"
  echo "-- outras_empresas.txt"
  cat "$DIR/outras_empresas.txt"
  echo "-- grupos_embalagem.txt"
  cat "$DIR/grupos_embalagem.txt"
} >"$LOG"

# Contagem de recebimentos contra a fonte (cru, chave distinta e v_sku_leadtime_efetivo, escopo Sayerlack OBEN).
"$PSQL_RO" -v ON_ERROR_STOP=1 -At >>"$LOG" 2>&1 <<'SQL'
select 'recebimentos_fonte_crua_sku_leadtime_history', count(*) from sku_leadtime_history h
 where h.empresa = 'OBEN' and h.sku_codigo_omie::text in (select sp.sku_codigo_omie::text from sku_parametros sp where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%');
select 'recebimentos_chave_distinta', count(*) from (select distinct h.tracking_id, h.empresa, h.sku_codigo_omie, h.t4_data_recebimento, h.quantidade_recebida from sku_leadtime_history h
 where h.empresa = 'OBEN' and h.sku_codigo_omie::text in (select sp.sku_codigo_omie::text from sku_parametros sp where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%')) x;
select 'recebimentos_v_sku_leadtime_efetivo', count(*) from v_sku_leadtime_efetivo v
 where v.empresa = 'OBEN' and v.sku_codigo_omie::text in (select sp.sku_codigo_omie::text from sku_parametros sp where sp.empresa = 'OBEN' and sp.fornecedor_nome ilike '%sayerlack%');
SQL
rc=$?
if [[ "$rc" -ne 0 ]]; then
  echo "FALHA: contagem de recebimentos contra v_sku_leadtime_efetivo (rc=$rc)" | tee -a "$LOG" >&2
  exit 5
fi
echo "contagem de recebimentos: rc=$rc" >>"$LOG"

# ── Gate §5.1.1 ──────────────────────────────────────────────────────────────
pl="$(awk -F'|' '$1=="gate_pct_linhas_max"{print $2}' "$DIR/outras_empresas.txt")"
pv="$(awk -F'|' '$1=="gate_pct_valor_max"{print $2}' "$DIR/outras_empresas.txt")"
echo "gate outras empresas: linhas=${pl:-NA}% valor=${pv:-NA}% (limite ${LIMITE_GATE}%)" | tee -a "$LOG"
if [[ -z "$pl" || -z "$pv" ]]; then
  falha 2 "gate ilegível em outras_empresas.txt (ausente != zero: não sigo)"
fi
if awk -v a="$pl" -v b="$pv" -v l="$LIMITE_GATE" 'BEGIN{exit !(a>l || b>l)}'; then
  echo "GATE REPROVADO: outras empresas acima de ${LIMITE_GATE}% — PARE e reporte ao founder (spec §5.1.1)" | tee -a "$LOG"
  exit 4
fi
echo "extrair.sh: ok — veja $LOG"
