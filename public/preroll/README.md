# Pre-roll LGPD

Arquivo `aviso-gravacao-lgpd.mp3` é o aviso de gravação tocado para o cliente
no início de cada chamada WebRTC outbound, atendendo o requisito LGPD de
informar gravação (Art. 7º, IX — base legal de legítimo interesse).

## Texto canônico

> "Esta ligação pode ser gravada para qualidade. Se preferir não gravar,
> avise o atendente."

Texto compacto (~5s) que cobre os 3 requisitos LGPD mínimos: notificação,
finalidade e direito de oposição (Art. 18 §2º). Versão anterior tinha ~13s
e era longa demais — cliente perdia a paciência antes do vendedor falar.

## Como regenerar (ElevenLabs — recomendado)

Gerado via ElevenLabs TTS PT-BR (modelo `eleven_multilingual_v2`, voz Sara).

```bash
export ELEVENLABS_API_KEY="sua_api_key"  # obter em https://elevenlabs.io
./scripts/generate-lgpd-preroll.sh
```

O script (`scripts/generate-lgpd-preroll.sh`) valida HTTP 200 e tamanho mínimo
do MP3 antes de gravar. Após gerar, ouvir pra confirmar:

```bash
afplay public/preroll/aviso-gravacao-lgpd.mp3
```

Se a voz Sara não couber, trocar `VOICE_ID` no script por outra (lista em
https://elevenlabs.io/app/voice-library). Manter sempre PT-BR neutro.

## Alternativa: voz nativa do macOS (sem ElevenLabs)

Se você não tem API key da ElevenLabs ou só quer um quick fallback:

```bash
TEXT="Esta ligação pode ser gravada para qualidade. Se preferir não gravar, avise o atendente."

say -v "Luciana" "$TEXT" -o /tmp/aviso.aiff
afconvert -f mp4f -d aac /tmp/aviso.aiff public/preroll/aviso-gravacao-lgpd.mp3
rm /tmp/aviso.aiff
```

Qualidade é inferior à ElevenLabs mas funcional pra teste/staging.

## Integração no código

URL configurada por `VITE_NVOIP_SIP_PREROLL_URL` (default: `/preroll/aviso-gravacao-lgpd.mp3`).
Mixado com mic do vendedor via `mixPrerollWithMic` (`src/lib/sip/audio-preroll.ts`)
e enviado ao peer (cliente) via WebRTC.

## Direito de oposição

O texto encerra com "informe ao atendente" — atendendo o direito de oposição
do Art. 18, §2º da LGPD. Quando o cliente solicitar não-gravação, marcar
`customers.no_recording = true` (campo a ser criado em PR6 — gravação completa).
