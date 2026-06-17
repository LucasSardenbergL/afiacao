#!/usr/bin/env bash
# release.sh — cross-compila o sayersync para Windows, calcula o sha256 e gera o
# manifest.json de auto-update. Saída em ./dist. NÃO faz upload: o bucket é
# escrita-só-service_role; o founder publica os 2 arquivos manualmente.
#
# Uso:  ./release.sh <versao-semver>        ex.: ./release.sh 0.2.0
# Env:  BUCKET_BASE_URL   base pública do bucket (default: prod Colacor)
#
# Gera (para publicar em releases/sayersync/ no Supabase Storage):
#   - sayersync-<versao>.exe   binário IMUTÁVEL e versionado (evita cache stale do CDN)
#   - manifest.json            ponteiro MUTÁVEL: {version, sha256, url}
set -euo pipefail

VERSION="${1:-}"
BUCKET_BASE_URL="${BUCKET_BASE_URL:-https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync}"

if [[ -z "$VERSION" ]]; then
  echo "uso: $0 <versao-semver>   (ex.: $0 0.2.0)" >&2
  exit 1
fi
# Semver estrito X.Y.Z — é exatamente o que o anti-downgrade do conector parseia
# (parseSemver em update.go); um sufixo de pre-release não compararia como esperado.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERRO: versao '$VERSION' nao e semver X.Y.Z (ex.: 0.2.0)" >&2
  exit 1
fi

cd "$(dirname "$0")" || exit 1
DIST="dist"
EXE="sayersync-${VERSION}.exe"
mkdir -p "$DIST"

echo "-> cross-compile windows/amd64 (CGO off, stripped) v${VERSION}"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -ldflags "-s -w -X main.Version=${VERSION}" \
  -o "${DIST}/${EXE}" .

# sha256 portavel: sha256sum no Linux, shasum no macOS.
if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "${DIST}/${EXE}" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "${DIST}/${EXE}" | cut -d' ' -f1)"
fi

URL="${BUCKET_BASE_URL}/${EXE}"
cat > "${DIST}/manifest.json" <<EOF
{
  "version": "${VERSION}",
  "sha256": "${SHA}",
  "url": "${URL}"
}
EOF

BYTES="$(wc -c < "${DIST}/${EXE}" | tr -d ' ')"
echo "OK ${DIST}/${EXE}  (${BYTES} bytes)"
echo "OK ${DIST}/manifest.json"
echo
echo "sha256: ${SHA}"
echo
echo "Publicar no Supabase Storage (bucket 'releases', pasta 'sayersync/') NESTA ORDEM:"
echo "  1. upload ${DIST}/${EXE}          (binario imutavel)"
echo "  2. upload ${DIST}/manifest.json   (ponteiro; SO depois do .exe)"
echo
echo "A ordem importa: se o manifest apontar para um .exe ainda nao publicado, o"
echo "conector baixa, falha o sha256 e conta como falha de update (crash-loop guard)."
