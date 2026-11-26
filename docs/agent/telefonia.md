# Telefonia (WebRTC) — referência operacional

> Subsistema de chamadas. A guarda da lente "Ver como" sobre a ligação está em `docs/agent/impersonation.md`.

## WebRTC é o ÚNICO backend ativo (desde 2026-06-06)

- `useCallBackend()` (`src/hooks/useCallBackend.ts`) retorna WebRTC **incondicionalmente**; `useWebRTCCall` é só `return useWebRTCCallContext()`. O **Nvoip click-to-call foi descontinuado da UI** (`useNvoipCall`/`NvoipDialer` = **código morto**; não há mais toggle de backend em `/settings`). Doc/código que fale em "dois backends + toggle" é histórico.
- Vendedor liga **direto pelo navegador** (JsSIP + SIP over WebSocket), áudio bidirecional `localStream`/`remoteStream`.

## Estado de uso (piloto desde 2026-11-25)

- Congelada pelo M-41 de 2026-10-12 a 2026-11-25 (20 tentativas em `call_log` entre 28/05 e 09/06, 0 `farmer_calls`). **Descongelada só a telefonia** para piloto com 1 vendedora no único ramal de `vendor_sip_credentials`; WhatsApp/Rota seguem em `rotasCongeladas` do mesmo módulo no manifesto.
- **Critério de saída do piloto** (Codex): ela escolhe o discador em ≥8 dos últimos 10 contatos, com áudio bilateral, e `call_log`/`farmer_calls` batem com o extrato da Nvoip. Baixa adesão com telefonia funcionando → revisar o fluxo comercial; falha comprovada do provedor → comparar Zenvia/Twilio no mesmo roteiro.
- Riscos conhecidos antes de ampliar: só STUN público (sem TURN — ramal registra e fica mudo atrás de NAT simétrico); entrante só com aba aberta; **não há gravação de áudio**, só transcrição Deepgram no navegador; entrante atendida transcreve até desconhecido, e a transcrição pode começar antes do fim do aviso LGPD.
- Staff sem ramal: o Provider monta, `nvoip-sip-creds` devolve 403 e o estado vai a `error` sem toast no boot; o `CallDialerView` mostra o estado de erro com a mensagem da edge ("peça ao master para cadastrar").

## Fonte ÚNICA da ligação

- `<Dialer/>` (`src/components/call/Dialer.tsx`) renderiza o `WebRTCDialer` (lazy). **Toda ligação passa por `WebRTCCallContext.makeCall`** (+ `acceptIncoming` p/ entrante) — todos os callsites passam por aqui (`AgendaTodayList`, `Telefonia`, `FarmerCalls`). UI compartilhada: `CallDialerView` (`src/components/call/CallDialerView.tsx`).
- ⚠️ **WebRTC NÃO passa pelo Supabase → fura o write-guard do client.** A lente "Ver como" guarda `makeCall`/`acceptIncoming` com `isLensActive()` **na fonte** (ver `docs/agent/impersonation.md`).

## Reconhecimento do número (decide gravar E registrar)

- **Quem é o dono do número = RPC `resolver_cliente_por_telefone`** (via `resolveCustomerByPhone`, o ponto único — ligação feita, recebida e o modal de entrada). Compara **só dígitos** (sufixo de 8): `customer_contacts` antes de `profiles`, perfil de staff não conta, placeholder de dígito repetido (`99999999`) não identifica ninguém. O sufixo ignora o DDD de propósito: só 15 de 5.392 perfis guardam DDD. **Exceção deliberada da onda D (PII por carteira):** a RPC responde a QUALQUER staff, sem carteira — devolve só identidade (cliente; e nome+cargo da pessoa de contato quando o número é de `customer_contacts`), nunca telefone/e-mail/documento/endereço. Não estenda o retorno: PII sai pelas fontes mascaradas (`docs/historico/clientes-onda-d-pii-carteira.md` §4b). **Nunca** volte a casar telefone com `ILIKE` sobre o texto cru — o cadastro guarda `99999-9999` e o hífen derrubava 96% das carteiras (2026-10-10, `docs/historico/bugs-resolvidos.md`).
- **Telefone compartilhado é comum** (19% dos clientes): sem dono único na carteira de quem liga, o número segue `cliente` (grava) com `customerUserId` null — a vendedora associa em `/farmer/calls/pending-link`. Nunca escolha um cliente ao acaso.
- **`farmer_calls` nasce no fim da ligação gravada, CONECTADA e com conteúdo — pelo `endCall` OU pelo fim remoto.** A sessão é explícita (`sessaoRef`): nasce no `makeCall`/`acceptIncoming` com o próprio telefone/atendimento, vira `estabelecida` só ao conectar e é consumida UMA vez (`consumirSessao`; o `endCall` a consome ANTES do `hangUp`). Três invariantes, cada um com teste que falsifica: **(1)** sessão que não conectou não persiste — o `useTranscription` só zera os turns ao conectar, então antes disso o ref tem a conversa da ligação ANTERIOR; **(2)** uma ligação por vez — o `makeCall` recusa com outra em curso (entrante já é recusada pelo SipClient com 486); **(3)** o efeito terminal que persiste fica declarado DEPOIS do que sincroniza os turns, senão o último turno que chega junto com o BYE fica fora.

## Segredos & LGPD

- **Credenciais SIP NUNCA em `VITE_*`** (vazaria no bundle público) — servidas pela Edge Function **`nvoip-sip-creds`** (auth + role employee/master via `authorizeCronOrStaff`). **Ramal é POR VENDEDOR** (`vendor_sip_credentials`, master cadastra em `/admin/sip-credentials`): sem ramal próprio → 403. **Não existe ramal compartilhado** — o fallback para `NVOIP_SIP_USER`/`PASS` do env entregava a senha do ramal master a qualquer staff e foi removido no lote 2 do scanner (2026-11-14); env que sobra: `NVOIP_SIP_WSS`/`DOMAIN`.
- **Token OAuth da Nvoip** (edge `nvoip-calls`, click-to-call legado) mora em `nvoip_oauth_cache` (só service_role), **nunca** em `company_config` — que o staff lê pelo client. Uma CHECK em `company_config` barra a volta.
- **LGPD:** MP3 de aviso (`public/preroll/aviso-gravacao-lgpd.mp3`) é mixado no `localStream` via `mixPrerollWithMic` (Web Audio API); URL em `VITE_NVOIP_SIP_PREROLL_URL`.

## Cleanup crítico do microfone

- `useWebRTCCall` guarda `rawMicRef` (da `getUserMedia`) e `prerollCloseRef` **separados** do `localStream` mixado. Em `endCall`/unmount, ambos fecham **antes** de `SipClient.hangUp` → libera o microfone físico (red dot apaga na hora).
