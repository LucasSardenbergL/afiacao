#!/usr/bin/env bash
# doc2md.sh — converte documento binário (PDF/DOCX/XLSX/PPTX) em Markdown COM GUARDA.
#
# Por que existe: `markitdown` sai com exit 0 e 1 byte quando o arquivo não tem camada
# de texto (PDF escaneado, imagem). Exit 0 + saída vazia é falha SILENCIOSA — o agente
# conclui "converteu" e segue lendo o nada. A guarda de bytes torna isso vermelho.
#
# Uso: doc2md.sh <arquivo> [dir-saida]
# Env: DOC2MD_MIN_BYTES (default 200) — piso de evidência positiva.
set -euo pipefail

MIN_BYTES="${DOC2MD_MIN_BYTES:-200}"

if [[ $# -lt 1 ]]; then
  echo "uso: doc2md.sh <arquivo> [dir-saida]" >&2
  exit 2
fi

src="$1"
[[ -f "$src" ]] || { echo "ERRO: arquivo não existe: $src" >&2; exit 2; }

outdir="${2:-${TMPDIR:-/tmp}/doc2md}"
mkdir -p "$outdir"

base="$(basename "$src")"
ext="$(printf '%s' "${base##*.}" | tr '[:upper:]' '[:lower:]')"
dest="$outdir/${base%.*}.md"
errlog="$outdir/${base%.*}.err"

# Imagem NÃO é caso do markitdown: ele devolve metadata (ou nada), não OCR.
case "$ext" in
  png|jpg|jpeg|gif|webp|bmp|tiff|heic)
    cat >&2 <<MSG
ERRO: '$ext' é IMAGEM — markitdown não faz OCR (devolve ~0 byte com exit 0).
      Leia com a ferramenta Read (visão do modelo), não por aqui.
MSG
    exit 3
    ;;
esac

# Extras do markitdown por formato (o pacote base NÃO traz parser algum).
case "$ext" in
  pdf)              extras='markitdown[pdf]' ;;
  docx|doc)         extras='markitdown[docx]' ;;
  xlsx|xls)         extras='markitdown[xlsx,xls]' ;;
  pptx|ppt)         extras='markitdown[pptx]' ;;
  msg)              extras='markitdown[outlook]' ;;
  *)                extras='markitdown[all]' ;;
esac

if ! uvx --from "$extras" markitdown "$src" > "$dest" 2> "$errlog"; then
  echo "ERRO: markitdown falhou (exit $?). stderr:" >&2
  tail -c 600 "$errlog" >&2
  exit 1
fi

bytes=$(wc -c < "$dest" | tr -d ' ')

# GUARDA: exit 0 não prova extração. Bytes provam.
if [[ "$bytes" -lt "$MIN_BYTES" ]]; then
  cat >&2 <<MSG
ERRO: extraiu só ${bytes}B (piso ${MIN_BYTES}B) — exit 0 MENTIU.
      Causa provável: PDF escaneado / sem camada de texto.
      NÃO trate como "documento vazio". Leia o original com Read (visão).
      Saída parcial em: $dest
MSG
  exit 4
fi

echo "OK  $dest  (${bytes}B, $(wc -l < "$dest" | tr -d ' ') linhas)"
echo "    ler recorte:  head -c 2000 '$dest'"
echo "    buscar:       grep -n '<termo>' '$dest' | cut -c1-160"
