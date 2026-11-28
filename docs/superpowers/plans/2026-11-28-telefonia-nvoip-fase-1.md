# Telefonia Nvoip — fase 1: plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: superpowers:executing-plans (1 tarefa = 1 PR). Passos com checkbox (`- [ ]`).

**Objetivo:** a ligação pelo navegador funciona em qualquer tela e fica registrada (`call_log` + `farmer_calls`), pronta para o piloto com 1 vendedora.

**Arquitetura:** tudo passa por `WebRTCCallContext` (fonte única da ligação). Cada item da fase 1 do design vira um PR pequeno, só front, exceto o item 8 (migration). O resultado da tentativa (`call_log.resultado`) é fase 2 (item 10) e não entra aqui.

**Stack:** React 18 + TS strict, JsSIP, Supabase, vitest + Testing Library, `sonner`, `track()` de `@/lib/analytics`.

**Spec:** `docs/superpowers/specs/2026-11-27-telefonia-nvoip-uso-real-design.md` (seções 4, 6, 6.1, 6.2). Referência: `docs/agent/telefonia.md`, `docs/agent/impersonation.md`.

## Restrições globais

- Ordem dos PRs: **1 → 2 → 4 → 7 → 3 → 5 → 8 → 6**. Item 6 (TURN) só entra no caminho crítico se o teste do Lucas der ligação muda; ele pergunta à Nvoip em 30/11.
- Enum de produção: `farmer_call_type = reativacao|cross_sell|up_sell|follow_up`; `farmer_call_result = contato_sucesso|sem_resposta|ocupado|caixa_postal|numero_invalido|reagendado`. Fonte no código: `Constants.public.Enums` de `src/integrations/supabase/types.ts`.
- `farmer_calls` = só conversa (conectada, gravada, com conteúdo). Nunca criar linha para tentativa.
- Nenhuma mudança fura o guard da lente "Ver como" em `makeCall`/`acceptIncoming`.
- Erro nunca só em `console.error`: toast pt-BR (`sonner`) + `track('<area>.<acao>')` (evento sem hífen: o tipo `SemHifen` barra).
- Arquivo novo em `src/` tem dono em `src/lib/modulos/manifesto.ts`, módulo `telefonia-whatsapp-rota`.
- Teste negativo casa a mensagem/valor do ramo, nunca `toThrow()` pelado. Commitar ANTES de sabotar.
- Prova local: `heavy bun run test`, `heavy bun run typecheck`, `bun lint`. Cada PR traz no corpo um **roteiro de teste manual curto** para o Lucas (não há ramal de teste) e a camada de deploy (front = 🖱️ Publish).

## Foco de revisão (entradas que nenhum teste da tarefa cobre por padrão)

1. **Insert recusado pelo banco (RLS, enum, coluna)** — a vendedora precisa saber na hora que a conversa não entrou no histórico. Coberto na Tarefa 1 (teste de erro).
2. **Exceção antes do insert** (`getUser` ou `resolveCustomerByPhone` lançam) — mesmo aviso, não silêncio. Coberto na Tarefa 1.
3. **Troca de rota com ligação ativa** — o áudio continua (Tarefa 2, teste do `<audio>` global fora de `/telefonia`).
4. **Ocupado / não atende** — estado legível em pt-BR, sem toast "Erro WebRTC" (Tarefa 3).
5. **Ramal caiu (rede/aba em segundo plano)** — `makeCall` recusa antes de abrir mic e gravar `call_log` (Tarefa 6).

---

### Tarefa 1 (item 1): `farmer_calls` com valores do enum e erro de insert visível

**Arquivos:**
- Modificar: `src/lib/call-session/build-session-payload.ts` (tipos de `call_type`/`call_result` = enums do `Database`; defaults `follow_up` / `contato_sucesso`)
- Modificar: `src/contexts/WebRTCCallContext.tsx` (`persistCallSession`: tirar o `as any`; erro de insert e exceção → `toast.error` + `track`)
- Testes: `src/lib/call-session/build-session-payload.test.ts`, `src/lib/call-session/__tests__/build-session-payload.test.ts` (hoje FIXAM `venda`/`atendeu`), `src/contexts/__tests__/WebRTCCallContext.fim-remoto-persiste.test.tsx`

**Interfaces:**
- Produz: `SessionPayload.call_type: Database['public']['Enums']['farmer_call_type']`, `SessionPayload.call_result: Database['public']['Enums']['farmer_call_result']`. O item 10 sobrescreve `call_result` na linha criada aqui.
- Produz: evento `telefonia.registro_falhou` com `{ motivo: 'insert' | 'excecao', codigo: string }`; toast `'A conversa não foi salva no histórico. Registre pelo /farmer/calls e avise o gestor.'`

- [ ] **Passo 1: testes que falham.** Nos dois testes do payload: `expect(Constants.public.Enums.farmer_call_type).toContain(p.call_type)` e idem para `call_result`, mais `toBe('follow_up')` / `toBe('contato_sucesso')`. No teste do Provider: insert devolvendo `{ data: null, error: { code: '22P02', message: 'invalid input value for enum' } }` ⇒ `toast.error` com a mensagem exata acima e `track('telefonia.registro_falhou', { motivo: 'insert', codigo: '22P02' })`; `resolveCustomerByPhone` rejeitando ⇒ `motivo: 'excecao'`.
- [ ] **Passo 2:** `heavy bun run test src/lib/call-session src/contexts/__tests__/WebRTCCallContext.fim-remoto-persiste.test.tsx` → FALHA nos novos casos.
- [ ] **Passo 3:** implementar (tipos + defaults; helper local `avisarRegistroFalhou(motivo, codigo)` no Provider).
- [ ] **Passo 4:** mesmos testes + `heavy bun run typecheck` + `bun lint` → verdes.
- [ ] **Passo 5:** commit; depois sabotar (a) voltar `'venda'` no payload, (b) remover o `toast.error` — exigir vermelho em cada um, com controle verde na mesma rodada; restaurar.
- [ ] **Passo 6:** PR com roteiro manual: ligar para um cliente da carteira, falar ≥10 s, desligar ⇒ `psql-ro`: `select call_type, call_result, call_backend, created_at from farmer_calls order by created_at desc limit 1;` mostra `follow_up / contato_sucesso / webrtc`.

### Tarefa 2 (item 2): som em qualquer tela + HUD no toque

**Arquivos:** criar `src/components/call/RemoteAudioGlobal.tsx` (dono no manifesto); modificar `src/layouts/AppShellLayout.tsx` (monta o `<audio>` global), `src/components/call/CallDialerView.tsx:108-114` (remove o `<audio>` local), `src/components/call/CallCopilotHud.tsx:26` (mostra em `calling_destination` com botão Desligar), `src/contexts/WebRTCCallContext.tsx:184` (zera `remoteStream` no fim).
**Testes:** `RemoteAudioGlobal` liga `srcObject = ctx.remoteStream` e o zera em `null`; HUD visível em `calling_destination` com botão que chama `endCall`; fim da chamada deixa `remoteStream === null`.
**Roteiro manual:** atender entrante em `/clientes`, trocar para `/farmer/calls` no meio — o áudio segue.

### Tarefa 3 (item 4): religar e estados legíveis

**Arquivos:** `src/components/call/CallDialerView.tsx:89,127,146,185-189` (card de fim com "Ligar de novo" = `makeCall(ultimoNumero, ultimaOrigem)`); `src/contexts/WebRTCCallContext.tsx:28-39` (`busy`/`noanswer` → estados públicos novos `ocupado`/`sem_resposta` em `webrtc-call-context.ts`); `src/lib/sip/sip-client.ts:150-154` (causa JsSIP → texto pt-BR; `Canceled` não emite erro).
**Testes:** mapa causa→estado (Busy, No Answer, Canceled, Rejected); "Ligar de novo" chama `makeCall` com o mesmo número; cancelar no toque não dispara `toast.error`.

### Tarefa 4 (item 7): LGPD da entrante e da transcrição

**Arquivos:** `src/contexts/WebRTCCallContext.tsx:547-550` (entrante grava por `shouldAutoRecord(party.kind)`), `:606-610` (transcrição só com `established && avisoConcluido`), `:318-336` (aviso no `confirmed`); `src/hooks/useTranscription.ts:48,124` (deps incluem o stream).
**Testes:** entrante de número desconhecido ⇒ `recording=false`, nenhum `farmer_calls`; transcrição não inicia antes de `avisoConcluido`; `useTranscription` inicia quando o stream chega depois do `enabled`.

### Tarefa 5 (item 3): "Ligar" da Fila do Dia pelo softphone

**Arquivos:** `src/pages/FilaDoDia.tsx:131-142,154` (`CallButton` em `pointer:fine`, `LinkTelefone`/`tel:` em touch, sensor do ledger mantido nos dois), `src/components/.../AgendaQueueCard.tsx:113` (passa `customerId`).
**Testes:** `matchMedia('(pointer: fine)')` ⇒ renderiza `CallButton` com `clienteOrigemId`; `coarse` ⇒ `href="tel:..."`; ledger registra nos dois ramos.

### Tarefa 6 (item 5): ramal online e re-registro

**Arquivos:** `src/contexts/WebRTCCallContext.tsx:166-233` (re-REGISTER em `online`, `visibilitychange` e após `registrationFailed`, backoff 2→4→8…→60 s), `:419-431` (`makeCall` sem `registered` recusa antes de `logCallStart` e `getUserMedia`, toast pt-BR); indicador online/offline no `CallDialerView`.
**Testes:** fake timers provam o backoff; `makeCall` não registrado ⇒ `logCallStart` e `getUserMedia` não chamados, toast com a mensagem exata.

### Tarefa 7 (item 8): reativar cron `call-log-missed-backstop`

Migration idempotente com postcondição (`cron.job.active = true` para o jobname), ritual `lovable-db-operator`, PR próprio. `timeout_milliseconds` explícito se houver `net.http_post`. Prova: psql-ro antes/depois + 1ª execução em `cron.job_run_details` **e** efeito (linhas `ringing` antigas fechadas).

### Tarefa 8 (item 6): TURN — condicional

Só se o teste do escritório der ligação muda. Depende da resposta da Nvoip (30/11). Se a Nvoip não oferecer, TURN gerenciado com credencial temporária servida pela edge `nvoip-sip-creds` (6 gates de edge + `pendencias:deploy`); prova forçando `iceTransportPolicy: 'relay'`, incluindo TLS/443. Plano detalhado só quando o gatilho disparar.

### Item 9 (operacional, Lucas)

Criar o ramal da vendedora na Nvoip com WebRTC e cadastrar em `/admin/sip-credentials`; conferir saldo, saída fixo/celular e BINA.
