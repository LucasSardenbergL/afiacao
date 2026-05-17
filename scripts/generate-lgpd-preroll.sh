#!/bin/bash
# Gerar pre-roll LGPD via ElevenLabs API.
#
# Uso:
#   export ELEVENLABS_API_KEY="sua_api_key"
#   ./scripts/generate-lgpd-preroll.sh
#
# Saída: public/preroll/aviso-gravacao-lgpd.mp3 (substitui se existir)
#
# Requisitos:
#   - curl
#   - jq (apenas pra validação opcional)
#   - ELEVENLABS_API_KEY env var
#
# Voz: Sara (EXAVITQu4vr4xnSDxMaL) — PT-BR feminina natural.
# Pra mudar a voz, ver lista em https://elevenlabs.io/app/voice-library

set -euo pipefail

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "❌ Erro: ELEVENLABS_API_KEY não está exportada."
  echo ""
  echo "Como obter: https://elevenlabs.io → conta → API Keys"
  echo "Depois:    export ELEVENLABS_API_KEY=\"sua_key\""
  exit 1
fi

TEXT="Esta ligação pode ser gravada para qualidade. Se preferir não gravar, avise o atendente."

VOICE_ID="EXAVITQu4vr4xnSDxMaL"  # Sara — PT-BR feminina
OUTPUT_FILE="public/preroll/aviso-gravacao-lgpd.mp3"

echo "🎤 Gerando pre-roll LGPD via ElevenLabs (voz Sara, PT-BR)..."

# Cria diretório se não existir
mkdir -p "$(dirname "${OUTPUT_FILE}")"

# Chamada à API
HTTP_CODE=$(curl -s -w "%{http_code}" -X POST \
  "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"${TEXT}\",
    \"model_id\": \"eleven_multilingual_v2\",
    \"voice_settings\": {
      \"stability\": 0.5,
      \"similarity_boost\": 0.75,
      \"style\": 0.0,
      \"use_speaker_boost\": true
    }
  }" \
  --output "${OUTPUT_FILE}")

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "❌ Erro: API retornou HTTP ${HTTP_CODE}"
  echo "Verifica o conteúdo do arquivo gerado pra ver a mensagem de erro:"
  cat "${OUTPUT_FILE}" 2>/dev/null || true
  rm -f "${OUTPUT_FILE}"
  exit 1
fi

SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
SIZE_BYTES=$(stat -f%z "${OUTPUT_FILE}" 2>/dev/null || stat -c%s "${OUTPUT_FILE}" 2>/dev/null)

if [[ "${SIZE_BYTES}" -lt 5000 ]]; then
  echo "⚠️  Arquivo gerado é suspeitamente pequeno (${SIZE_BYTES} bytes)."
  echo "Provavelmente uma mensagem de erro JSON, não áudio. Conteúdo:"
  cat "${OUTPUT_FILE}"
  rm -f "${OUTPUT_FILE}"
  exit 1
fi

echo "✅ Gerado: ${OUTPUT_FILE} (${SIZE})"
echo ""
echo "Próximo passo: ouvir pra confirmar qualidade:"
echo "   afplay ${OUTPUT_FILE}"
echo ""
echo "Se tiver bom, commita:"
echo "   git add ${OUTPUT_FILE} public/preroll/README.md"
echo "   git commit -m 'feat(webrtc): real LGPD pre-roll MP3 generated via ElevenLabs'"
