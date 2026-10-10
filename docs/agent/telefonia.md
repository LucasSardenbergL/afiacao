# Telefonia (WebRTC) — referência operacional

> Subsistema de chamadas. A guarda da lente "Ver como" sobre a ligação está em `docs/agent/impersonation.md`.

## WebRTC é o ÚNICO backend ativo (desde 2026-06-06)

- `useCallBackend()` (`src/hooks/useCallBackend.ts`) retorna WebRTC **incondicionalmente**; `useWebRTCCall` é só `return useWebRTCCallContext()`. O **Nvoip click-to-call foi descontinuado da UI** (`useNvoipCall`/`NvoipDialer` = **código morto**; não há mais toggle de backend em `/settings`). Doc/código que fale em "dois backends + toggle" é histórico.
- Vendedor liga **direto pelo navegador** (JsSIP + SIP over WebSocket), áudio bidirecional `localStream`/`remoteStream`.

## Fonte ÚNICA da ligação

- `<Dialer/>` (`src/components/call/Dialer.tsx`) renderiza o `WebRTCDialer` (lazy). **Toda ligação passa por `WebRTCCallContext.makeCall`** (+ `acceptIncoming` p/ entrante) — todos os callsites passam por aqui (`AgendaTodayList`, `Telefonia`, `FarmerCalls`). UI compartilhada: `CallDialerView` (`src/components/call/CallDialerView.tsx`).
- ⚠️ **WebRTC NÃO passa pelo Supabase → fura o write-guard do client.** A lente "Ver como" guarda `makeCall`/`acceptIncoming` com `isLensActive()` **na fonte** (ver `docs/agent/impersonation.md`).

## Reconhecimento do número (decide gravar E registrar)

- **Quem é o dono do número = RPC `resolver_cliente_por_telefone`** (via `resolveCustomerByPhone`, o ponto único — ligação feita, recebida e o modal de entrada). Compara **só dígitos** (sufixo de 8): `customer_contacts` antes de `profiles`, perfil de staff não conta. **Nunca** volte a casar telefone com `ILIKE` sobre o texto cru — o cadastro guarda `99999-9999` e o hífen derrubava 96% das carteiras (2026-10-10, `docs/historico/bugs-resolvidos.md`).
- **Telefone compartilhado é comum** (19% dos clientes): sem dono único na carteira de quem liga, o número segue `cliente` (grava) com `customerUserId` null — a vendedora associa em `/farmer/calls/pending-link`. Nunca escolha um cliente ao acaso.
- **`farmer_calls` nasce no fim da ligação gravada com conteúdo — pelo `endCall` OU pelo fim remoto** (efeito terminal). `callStartedAtRef` é a marca de "sessão não persistida": o `endCall` a zera ANTES do `hangUp`. Quem mexer no ciclo de vida preserva isso, senão grava 2× ou perde o fim remoto.

## Segredos & LGPD

- **Credenciais SIP NUNCA em `VITE_*`** (vazaria no bundle público) — servidas pela Edge Function **`nvoip-sip-creds`** (auth + role employee/master via `authorizeCronOrStaff`). Env do server: `NVOIP_SIP_WSS`/`DOMAIN`/`USER`/`PASS`.
- **LGPD:** MP3 de aviso (`public/preroll/aviso-gravacao-lgpd.mp3`) é mixado no `localStream` via `mixPrerollWithMic` (Web Audio API); URL em `VITE_NVOIP_SIP_PREROLL_URL`.

## Cleanup crítico do microfone

- `useWebRTCCall` guarda `rawMicRef` (da `getUserMedia`) e `prerollCloseRef` **separados** do `localStream` mixado. Em `endCall`/unmount, ambos fecham **antes** de `SipClient.hangUp` → libera o microfone físico (red dot apaga na hora).
