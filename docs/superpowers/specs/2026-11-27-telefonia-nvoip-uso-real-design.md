# Telefonia Nvoip em uso real — design

> Status: **aprovado pelo Lucas em 2026-11-27** (provedor Nvoip + fases 1 e 2).
> Origem: levantamento de 25 a 27/11/2026 com Fable (auditoria tela a tela) e Codex (2 pareceres: arquitetura e provedor).
> Referência operacional: `docs/agent/telefonia.md`. PR que descongelou a telefonia: #4181 (mergeado em 25/11; Publish feito, segundo o Lucas).

## 1. Intenção

As vendedoras internas precisam ligar para a carteira de clientes B2B pelo navegador, com a ligação reconhecida (quem é o cliente), transcrita, com resultado registrado e visível ao gestor. O módulo foi construído em maio e junho de 2026 e nunca entrou em uso:
- 1 ramal em `vendor_sip_credentials`;
- 20 tentativas em `call_log` entre 28/05 e 09/06;
- 0 linhas em `farmer_calls`.

O Lucas quer **investir de novo** e escolheu o caminho de **melhor retorno sobre o esforço** (ROE), sem prazo fixo.

**Sucesso:**
- A vendedora liga a partir da tela onde já trabalha (Fila do Dia, ficha e Customer 360) sem perder o som e sem cliques extras.
- Toda tentativa tem resultado em `call_log`, e toda conversa gravada vira linha em `farmer_calls` (ver 6.1).
- O gestor vê quem ligou quanto no dia.
- Depois de 2 semanas existe dado para julgar a Nvoip.

## 2. Decisão de provedor: Nvoip

| | Nvoip | API4Com | Twilio |
|---|---|---|---|
| Custo de troca (estimativa Codex) | 0 dia | 4–7 dias | 6–10 dias + cadastro regulatório BR |
| Minuto fixo / móvel (tabela, a confirmar) | R$ 0,10 / 0,45 | R$ 0,09 / 0,41 | ~US$ 0,035 / 0,07, em dólar |
| DDD 37 | já funciona | confirmar | não aceita portar números do DDD 37 (lista pública) |

**Por que a Nvoip ganha com folga:** a maior parte do trabalho que falta (seção 4) é bug ou lacuna **nossa** e independe do provedor. A Twilio só ganha em eventos de chamada no servidor e TURN incluído, o que importa quando houver roteamento por carteira no número geral (fase 3). **A troca continua reversível:** tudo das fases 1 e 2 se aproveita, e só o `SipClient` e a edge de credencial mudariam.

**Critério para revisar a decisão** (Codex), depois de 2 semanas com pelo menos 50 tentativas e 20 atendidas:
- manter se houver áudio bilateral em ≥95% das atendidas;
- manter se ≥95% das tentativas conciliarem com o extrato da Nvoip;
- manter se o discador for escolhido em ≥8 dos últimos 10 contatos elegíveis.

Baixa adesão com a telefonia funcionando pede revisão do **fluxo comercial**, não do provedor.

## 3. Metas, não-metas e anti-metas

- **Metas:** fases 1 e 2 abaixo.
- **Não-metas (fase 3):**
  - gravação de áudio;
  - transferência (o spike `*2`/REFER fica atrás de flag);
  - fila e roteamento do número geral por carteira;
  - celular e tablet (`tel:` segue no toque);
  - DTMF durante a chamada;
  - duas abas com o mesmo ramal;
  - remoção do código legado (`NvoipDialer`, `useNvoipCall`, edge `nvoip-calls`);
  - descongelar `/rota/ligacoes` e `/whatsapp`.
- **Anti-metas (falha mesmo que "funcione"):**
  - ligação conectada sem linha em `farmer_calls`;
  - número fabricado em KPI. Ausente ≠ zero: sem dado, mostrar "sem dado";
  - transcrever antes do aviso LGPD ou transcrever número desconhecido;
  - microfone aberto sem ligação visível na tela;
  - erro engolido em `console.error`.

## 4. Escopo

Caminhos com linha vêm da auditoria do Fable (lidos no código, não rodados). Esforço: P (pequeno), M (médio), G (grande).

### Fase 1 — a ligação funciona e fica registrada

1. **Registro em `farmer_calls` (P, causa provável do zero).**
   - `src/lib/call-session/build-session-payload.ts:67-68` grava `call_type: 'venda'` e `call_result: 'atendeu'`. O enum de produção só aceita `farmer_call_type = reativacao|cross_sell|up_sell|follow_up` e `farmer_call_result = contato_sucesso|sem_resposta|ocupado|caixa_postal|numero_invalido|reagendado` (conferido via psql-ro em 25/11).
   - Default proposto: `call_result: 'contato_sucesso'` (a ligação conectou e teve conteúdo) e `call_type: 'follow_up'`. O resultado real vem do item 10.
   - Tirar o `as any` que escondia o erro do typecheck.
   - Falha de insert sai do `console.error` (`WebRTCCallContext.tsx:80-84`) para um toast em pt-BR e um `track()`.
2. **Som em qualquer tela (P/M).**
   - Hoje o único `<audio>` mora no `CallDialerView` (`CallDialerView.tsx:108-114`). Entrante atendida fora de `/telefonia` fica muda, trocar de rota derruba o som com o mic aberto, e o "Iniciar" de `/farmer/calls` (`FarmerCalls.tsx:287-296`) liga sem som.
   - Correção: um `<audio>` global no `AppShellLayout` ligado a `ctx.remoteStream`.
   - O HUD da ligação também aparece durante o toque (`CallCopilotHud.tsx:26` só mostra em `established`), com botão de desligar.
   - Zerar `remoteStream` entre chamadas (`WebRTCCallContext.tsx:184`).
3. **"Ligar" da Fila do Dia pelo softphone no desktop (P/M).**
   - `FilaDoDia.tsx:131-142,154` usa `LinkTelefone` com `tel:`. Trocar por `CallButton` em `pointer:fine`, mantendo `tel:` em touch e o sensor do ledger.
   - Passar `customerId` (a agenda também não passa: `AgendaQueueCard.tsx:113`).
4. **Religar e estados legíveis (P).**
   - O card terminal só tem X, e o X some com o botão (`CallDialerView.tsx:89,127,146,185-189`). Card de fim com "Ligar de novo".
   - Mapear `busy`/`noanswer` em `SIP_TO_PUBLIC` (`WebRTCCallContext.tsx:28-39`).
   - Trocar o toast "Erro WebRTC — Call failed: Busy" (`sip-client.ts:150-154`) por texto em pt-BR. Cancelar no toque não é erro.
5. **Ramal online e re-registro (M).**
   - Indicador "online/offline" do ramal: `registered` ≠ `idle`.
   - Re-REGISTER automático em `online`, `visibilitychange` e depois de `registrationFailed`, com backoff. Hoje fica em `error` até F5 (`:166-233`).
   - `makeCall` sem registro recusa ANTES de gravar `call_log` e abrir o mic (`:419-431`), com mensagem em pt-BR.
6. **TURN (M, específico da Nvoip).**
   - Hoje só STUN do Google (`sip-client.ts:138`): o ramal registra e pode ficar mudo atrás de NAT simétrico ou firewall.
   - Primeiro perguntar à Nvoip se ela oferece TURN. Senão, TURN gerenciado com credencial temporária servida pela edge `nvoip-sip-creds`.
   - Provar o caminho `relay` num teste forçado, incluindo TLS/443.
   - **Entra no caminho crítico só se o teste na rede do escritório mostrar ligação muda.** Caso contrário, vai para depois do aceite.
7. **LGPD (P).**
   - Entrante: gravar por `shouldAutoRecord(party.kind)`, como a sainte (`WebRTCCallContext.tsx:547-550` vs `:416`).
   - Transcrição só com `established && avisoConcluido` (`:606-610`).
   - Aviso disparado no `confirmed`, não no `answer()` (`:318-336`).
   - Corrigir o `useTranscription`, que só depende de `[enabled]` (`useTranscription.ts:48,124`). Na entrante o `remoteStream` chega depois do `established` e o engine não inicia.
8. **Cron `call-log-missed-backstop` (P, banco).** Está `active = f` desde o congelamento (`20261012203227_crons_modulos_congelados.sql:42-52`), e sem ele `ringing` fica para sempre. Reativar por migration idempotente com postcondição, no ritual `lovable-db-operator`.
9. **Ramal por vendedora (operacional, Lucas + Nvoip).**
   - Criar 1 ramal com WebRTC por vendedora do piloto e cadastrar em `/admin/sip-credentials`.
   - Conferir saldo, saída para fixo e celular, e BINA (o número exibido é definido no painel da Nvoip; o `callerId` não vai no INVITE).
   - Confirmar onde está hospedado o (37) 3222-1035.

### Fase 2 — vale a pena usar todo dia

10. **Resultado em 1 toque no card de fim (M):** os valores do enum `farmer_call_result`, atualizando a linha criada no item 1. Hoje o `OutcomeMenu` só existe em `/rota/ligacoes`, que está congelada.
11. **Painel do gestor: quem ligou quanto hoje (M).**
    - Agregar `call_log` do dia por `farmer_id`: tentativas, atendidas e minutos, com o nome da vendedora.
    - Hoje a aba Time mostra 50 linhas cruas (`useCallLog.ts:27`, `CallHistoryRow.tsx:24-45`).
    - Paginação estável (o PostgREST corta em 1.000 linhas) ou RPC agregadora.
12. **Ligação recebida percebida (P/M):**
    - toque sonoro;
    - `Notification` do navegador;
    - título da aba piscando quando a aba está em segundo plano (`IncomingCallModal.tsx:138-209`);
    - ringback na sainte.
13. **Robustez de sessão (P):**
    - `beforeunload` durante a ligação;
    - invalidar o histórico ao fim (`useCallLog.ts:34`, `staleTime` 30 s);
    - linha `answered` órfã quando a página cai, com o backstop ampliado.
14. **Qualidade medida (M):**
    - `getStats()` no fim da chamada: perda, jitter, RTT e tipo de candidato (host, srflx ou relay), salvo em coluna dedicada de `call_log` (1 writer);
    - consulta de conciliação com o extrato da Nvoip para o critério da seção 2.
    - É o sensor que nasce com a superfície (regra "fase N+1 exige sinal").

### Fase 3 — depois

Itens das não-metas. A gravação de áudio exige exclusão verificável em 90 dias e respeito a `legal_hold` (`20261012205652_retencao_lgpd_conversas.sql`). Os planos de gravação da Nvoip publicam retenção de 12 meses a 5 anos.

## 5. Restrições

- Deploy no Lovable tem 3 camadas manuais (Publish, edge, migration). Merge ≠ produção.
- Itens 6 e 14 podem mexer em edge: seguir os 6 gates de edge e o `pendencias:deploy`.
- Item 8 e qualquer coluna nova: migration via ritual de banco, com prova em PG17 (`prove-sql-money-path`) se houver função.
- Toda tela nova segue o Design System v3 (`text-status-*`, `sonner`, `EmptyState`, `PageSkeleton`).
- Arquivo novo em `src/` precisa de dono no manifesto (módulo `telefonia-whatsapp-rota`).
- Lente "Ver como": nenhuma mudança pode furar o guard de `makeCall`/`acceptIncoming` (`docs/agent/impersonation.md`).
- Teste negativo casa a mensagem do ramo, não "lançou algo".

## 6. Decisões tomadas por Claude (o Lucas pode mudar)

- Foco em **ligar para a carteira**. A entrante entra nas correções de fase 1 e 2, mas a fila do número geral fica para a fase 3.
- **Desktop** (Chrome) no piloto. Safari e celular ficam para depois.
- Defaults do item 1: `contato_sucesso` / `follow_up`.
- Aceite antes de liberar para as vendedoras: **10 de 10 ligações controladas** com áudio bilateral, incluindo entrada, saída, uma conversa acima de 5 minutos, BINA correta e aviso inteiro audível.

### 6.1 Respostas à checagem do builder (decisões de Claude, 2026-11-27)

- **Onde mora o resultado:** em `call_log`, numa coluna nova `resultado` (enum `farmer_call_result`, 1 writer: o card de fim), para **toda tentativa**, inclusive as não atendidas.
  - `farmer_calls` continua sendo **conversa** (conectada, gravada e com conteúdo), e recebe o mesmo `call_result` quando existir.
  - A meta da seção 1 passa a ser: **toda tentativa tem resultado em `call_log`, e toda conversa gravada vira linha em `farmer_calls`**.
  - Não se criam linhas de `farmer_calls` para tentativas: isso inflaria os ~10 leitores de scoring e KPI.
- **Defaults do item 1** só valem para conversa (conectada e com conteúdo): `contato_sucesso` / `follow_up`.
  - O card de fim sobrescreve o resultado.
  - O `call_type` é opcional no card e fica `follow_up` se ela não escolher.
  - `reagendado` não pede data nesta fase (o agendamento fica para a fase 3).
- **Registro manual em `/farmer/calls`:** quando a ligação saiu pelo softphone (há `sip_call_id`/`atendimento_id`), o diálogo **atualiza** a linha automática em vez de inserir outra. Ligação feita fora do softphone segue inserindo.
- **Medição dos critérios (item 14):**
  - **Extrato:** CSV exportado à mão do painel da Nvoip na fase 2 (sem edge nova). Conciliação por número normalizado + janela de ±2 min do início.
  - **"Áudio bilateral":** `bytesReceived` > 0 e `bytesSent` > 0 no `getStats()` da chamada atendida; não é marcado pela vendedora.
  - **"8 de 10":** o denominador são as tentativas em `call_log` + os cliques em `tel:` no ledger no mesmo dia.
- **Switch "Gravar" do `DialPad`:** fica, mas o default passa a seguir `shouldAutoRecord(party.kind)`. Número desconhecido começa **desligado**; ligar exige o clique dela, e o aviso LGPD toca antes.

### 6.2 Respostas do Lucas (2026-11-27)

- **Piloto com 1 vendedora.** O Lucas cria o ramal dela na Nvoip e o cadastra em `/admin/sip-credentials`.
- **Quem testa:** o Lucas ou ela. Não há ramal de teste separado, então cada PR é validado pelo Lucas com o ramal do piloto (ou um ramal dele, se ele criar). O builder valida por teste unitário e entrega um roteiro curto de teste manual por PR.
- **Publish do #4181:** feito, segundo o Lucas.
- **TURN:** o Lucas pergunta à Nvoip na segunda, 30/11. Até lá, o item 6 segue a regra do item ("só no caminho crítico se o teste der ligação muda").
- Com 1 vendedora, o piso de 50 tentativas e 20 atendidas pode levar mais de 2 semanas. Vale o piso, não o prazo.

## 7. Deixado para quem implementa

- Ordem e fatiamento em PRs: sugestão de 1 PR por item ou par de itens, na ordem 1 → 2 → 4 → 7 → 3 → 5 → 8 → 6. A fase 2 vem depois do aceite.
- Provedor de TURN, se a Nvoip não oferecer.
- Forma do agregado do gestor (RPC ou view) e o nome da coluna de qualidade.
