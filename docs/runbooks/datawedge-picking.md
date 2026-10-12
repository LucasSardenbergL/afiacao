# DataWedge — perfil do picking v2 (Zebra WT6400 / RS6100 / TC22 / TC53e / MC3400)

Leitor entra no app (PWA no Chrome) **como teclado**. O app reconhece uma leitura pelo prefixo `~~` e pelo ENTER no fim — sem adivinhar por velocidade de digitação. Spec: `docs/superpowers/specs/2026-10-10-picking-v2-design.md` §1.5. Código: `src/lib/picking/scanner/protocolo.ts`.

## Perfil (DataWedge → Profiles → novo perfil "picking-v2")

| Onde | Ajuste | Valor |
|---|---|---|
| Associated apps | App/Activity | `com.android.chrome` / `*` |
| Barcode input | Enabled | ON |
| Barcode input → Scanner selection | Scanner | interno (WT6400/TC22) **ou** o anel RS6100 pareado |
| Barcode input → Reader params | Trigger mode / Scanning mode | Single (uma leitura por gatilho) |
| Barcode input → Reader params | Same symbol timeout | ON, ~500 ms |
| Barcode input → Decoder | EAN-13, EAN-8, UPC-A, Code 128, Code 39, DataMatrix, QR | ON (os demais OFF) |
| Barcode input → Decode feedback | Decode audio feedback | **OFF** (o som de acerto/erro é do app) |
| Barcode input → Decode feedback | LED/vibração do leitor | ON (confirma que o gatilho leu) |
| Keystroke output | Enabled | ON |
| Keystroke output → Action key character | — | nenhum |
| Keystroke output → Advanced data formatting → Basic format | Enabled | ON |
| ↳ Prefix to data | | `~~` |
| ↳ Send data | | ON |
| ↳ Send ENTER key | | ON |
| Keystroke output → AIM code ID | Send AIM code ID | ON (o app separa `]E0` etc.) |
| Keystroke output → Key event options | Send characters as events | **ON** |
| Keystroke output → Inter character delay | — | 0 |
| Intent output | Enabled | **OFF** |

## Conferência no aparelho

1. Abra a tela **Separação** no Chrome e pegue uma tarefa (o toque destrava o som).
2. Bipe um EAN do pedido: tem de tocar 1 bipe agudo, vibrar e pintar a tela de verde.
3. Bipe o mesmo código duas vezes muito rápido (double-decode): a 2ª leitura é ignorada com um clique curto.
4. Bipe um código de outro produto: grave longo + tela vermelha.
5. Tire o ENTER do perfil e bipe: o app tem de avisar "Leitura falhou — bipe de novo" (truncada). Recoloque o ENTER.

Se o passo 2 digitar o código num campo em vez de tocar o bipe, o prefixo `~~` não está saindo: confira "Basic format" e "Send characters as events".
