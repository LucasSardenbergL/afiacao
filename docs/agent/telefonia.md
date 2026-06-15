# Telefonia (WebRTC) — referência operacional

> Subsistema de chamadas. A guarda da lente "Ver como" sobre a ligação está em `docs/agent/impersonation.md`.

## WebRTC é o ÚNICO backend ativo (desde 2026-06-06)

- `useCallBackend()` (`src/hooks/useCallBackend.ts`) retorna WebRTC **incondicionalmente**; `useWebRTCCall` é só `return useWebRTCCallContext()`. O **Nvoip click-to-call foi descontinuado da UI** (`useNvoipCall`/`NvoipDialer` = **código morto**; não há mais toggle de backend em `/settings`). Doc/código que fale em "dois backends + toggle" é histórico.
- Vendedor liga **direto pelo navegador** (JsSIP + SIP over WebSocket), áudio bidirecional `localStream`/`remoteStream`.

## Fonte ÚNICA da ligação

- `<Dialer/>` (`src/components/call/Dialer.tsx`) renderiza o `WebRTCDialer` (lazy). **Toda ligação passa por `WebRTCCallContext.makeCall`** (+ `acceptIncoming` p/ entrante) — todos os callsites passam por aqui (`AgendaTodayList`, `Telefonia`, `FarmerCalls`). UI compartilhada: `CallDialerView` (`src/components/call/CallDialerView.tsx`).
- ⚠️ **WebRTC NÃO passa pelo Supabase → fura o write-guard do client.** A lente "Ver como" guarda `makeCall`/`acceptIncoming` com `isLensActive()` **na fonte** (ver `docs/agent/impersonation.md`).

## Segredos & LGPD

- **Credenciais SIP NUNCA em `VITE_*`** (vazaria no bundle público) — servidas pela Edge Function **`nvoip-sip-creds`** (auth + role employee/master via `authorizeCronOrStaff`). Env do server: `NVOIP_SIP_WSS`/`DOMAIN`/`USER`/`PASS`.
- **LGPD:** MP3 de aviso (`public/preroll/aviso-gravacao-lgpd.mp3`) é mixado no `localStream` via `mixPrerollWithMic` (Web Audio API); URL em `VITE_NVOIP_SIP_PREROLL_URL`.

## Cleanup crítico do microfone

- `useWebRTCCall` guarda `rawMicRef` (da `getUserMedia`) e `prerollCloseRef` **separados** do `localStream` mixado. Em `endCall`/unmount, ambos fecham **antes** de `SipClient.hangUp` → libera o microfone físico (red dot apaga na hora).
