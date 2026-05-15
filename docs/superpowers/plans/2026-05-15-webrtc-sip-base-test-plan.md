# Teste Manual — WebRTC SIP Base (PR1 Sales Copilot)

> Use após mergear a PR e configurar as env vars no Supabase. Cada cenário tem checklist + expected outcome.

## Pré-requisitos
- [ ] Env vars `NVOIP_SIP_WSS`, `NVOIP_SIP_DOMAIN`, `NVOIP_SIP_USER`, `NVOIP_SIP_PASS` configuradas no Supabase (Edge Functions → Secrets)
- [ ] Suporte Nvoip confirmou WebRTC habilitado na conta e forneceu o `wsUri` real
- [ ] MP3 real gerado em `public/preroll/aviso-gravacao-lgpd.mp3` (TTS PT-BR via ElevenLabs; usar texto canônico do README)
- [ ] Pre-roll Nvoip OU pre-roll local (`VITE_NVOIP_SIP_PREROLL_URL`) ativo — sem isso, NÃO mergear PR6 (gravação)
- [ ] Browser Chrome 120+ com permissão de microfone concedida
- [ ] Usuário logado com role `employee` ou `master` (customer NÃO acessa `/farmer/calls`)

## Cenário 1 — Ligação WebRTC bem-sucedida (golden path)
- [ ] Login como staff
- [ ] Ir para `/settings` → ativar toggle "Chamadas WebRTC (beta)"
- [ ] Ir para `/farmer/calls` → escolher cliente com telefone válido (DDD + número)
- [ ] Clicar "Ligar"
- [ ] Navegador deve pedir permissão de microfone
- [ ] Conceder permissão
- [ ] Dialer transita: idle → conectando → chamando
- [ ] Cliente recebe ligação no celular; atender
- [ ] Dialer transita para "Em chamada" e timer começa a contar
- [ ] Áudio bidirecional funciona (vendedor ouve cliente; cliente ouve vendedor)
- [ ] Badge "WEBRTC" aparece no painel ativo (não "NVOIP")
- [ ] Clicar "Encerrar"
- [ ] Dialer vira "Finalizada"
- [ ] Red dot do microfone apaga IMEDIATAMENTE (privacy critical)
- [ ] Linha gravada em `farmer_calls` (verificar no banco) com duração correta

## Cenário 2 — Pre-roll LGPD ouvido pelo cliente
- [ ] Repetir cenário 1
- [ ] Confirmar com pessoa do outro lado da linha (alguém em outro celular): "Você ouviu o aviso de gravação antes do vendedor falar?"
- [ ] Se sim: pre-roll funciona via Web Audio mixagem
- [ ] Se não: abrir DevTools → Console → procurar erros em `audio-preroll` (decodeAudioData? fetch 404?)
- [ ] Verificar `VITE_NVOIP_SIP_PREROLL_URL` está definida (Inspect → Sources → arquivo `.env.production`)

## Cenário 3 — Fallback Nvoip (flag off)
- [ ] `/settings` → desativar toggle "Chamadas WebRTC (beta)"
- [ ] `/farmer/calls` → escolher cliente, clicar "Ligar"
- [ ] Comportamento Nvoip click-to-call original deve funcionar normalmente
- [ ] Badge "NVOIP" aparece no painel (não "WEBRTC")
- [ ] Não há prompt de permissão de microfone (Nvoip click-to-call usa softphone, não navegador)
- [ ] Vendedor atende no painel Nvoip; cliente toca depois

## Cenário 4 — Reconexão de rede durante chamada
- [ ] Flag WebRTC ativada
- [ ] Iniciar uma ligação, atender no celular
- [ ] Desligar/religar Wi-Fi (ou modo avião 5s)
- [ ] Verificar: chamada termina com `failed` (não crash do app)
- [ ] Iniciar nova chamada após reconectar: deve funcionar (SipClient re-registra automaticamente)
- [ ] Se SipClient não re-registrar, refresh da página resolve (degradação aceitável pra PR1)

## Cenário 5 — Sem credenciais SIP no servidor
- [ ] Remover env var `NVOIP_SIP_PASS` do Supabase
- [ ] Ativar flag WebRTC
- [ ] Reload `/farmer/calls`
- [ ] Tentar ligar
- [ ] Toast de erro: "Credenciais SIP não configuradas" (ou similar)
- [ ] Dialer fica em estado `error` sem crashar app
- [ ] Restaurar env var antes de continuar testes

## Cenário 6 — Telefone inválido
- [ ] Flag WebRTC ativada
- [ ] Tentar ligar pra cliente com telefone < 10 dígitos (ex.: cadastro antigo só com 8 dígitos sem DDD)
- [ ] Validação local rejeita (toast: "Telefone inválido. É necessário DDD + número.")
- [ ] Não pede permissão de microfone
- [ ] SipClient.makeCall NÃO é chamado (verificar via Network tab que nenhum INVITE saiu)

## Cenário 7 — Mic já em uso (defesa contra race condition)
- [ ] Flag WebRTC ativada
- [ ] Iniciar uma ligação
- [ ] Sem encerrar a primeira, clicar "Ligar" em OUTRO cliente rapidamente
- [ ] Verificar: red dot do microfone NÃO duplica (cleanup defensivo libera mic anterior)
- [ ] Apenas uma chamada ativa por vez
- [ ] Após hangUp, red dot apaga

## Cenário 8 — Customer tenta usar
- [ ] Login como cliente final (role `customer`)
- [ ] Navegar para `/farmer/calls` → deve redirecionar ou mostrar 403 (rota privada)
- [ ] Se conseguir entrar de alguma forma, edge function `nvoip-sip-creds` retorna 401/403
- [ ] Dialer mostra error state, sem expor mensagens internas

## Checklist de regressão (NÃO deve ter regredido)
- [ ] `/farmer/calls` funciona com flag OFF (Nvoip atual)
- [ ] `/farmer/copilot` continua funcionando (não tocamos em PR1)
- [ ] `/admin/*` e demais rotas não foram afetadas
- [ ] Build production passa: `bun build`
- [ ] PWA cache funciona normalmente

## Performance / qualidade
- [ ] Latência da ligação iniciar até toque no celular do cliente: < 3s (vs ~5-8s no Nvoip click-to-call)
- [ ] Bundle main: JsSIP NÃO aparece (`grep RTCSession dist/assets/index-*.js` → 0 matches)
- [ ] WebRTCDialer carrega em chunk separado quando flag liga
