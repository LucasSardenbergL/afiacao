# Telefonia/WhatsApp/Rota congelados: os consumidores que vazavam (plano v4, lote 4: C7 e N4)

Plano: `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`. O módulo
`telefonia-whatsapp-rota` está `congelado` (M-41) de 2026-10-12 a 2027-01-10, mas o congelamento
só escondia rota e item de navegação. Dois consumidores continuavam rodando o módulo por fora.

## C7: o `WebRTCCallProvider` montava para todo staff

`ConditionalWebRTCProvider` montava o Provider (lazy) para todo staff no boot. Com isso o chunk do
jssip (263 KB, 61 KB gzip) era baixado, a credencial SIP era pedida e o ramal era registrado, mesmo
com a /telefonia redirecionando. Agora o gate é `!isStaff || rotaCongelada('/telefonia', MODULOS)`.
Congelado, o componente lazy não renderiza e o `import()` não dispara. Ativo, nada muda:
recebimento passivo antes de qualquer clique.

Os consumidores de `useWebRTC*` foram auditados contra Provider ausente:

- `WebRTCDialer`: já lia o contexto opcional. Agora avisa "Telefonia indisponível" em vez de ficar
  num clique mudo.
- `IncomingCallModal`, `CallCopilotHud` e `TransferSpikePanel`: aguentam o Provider ausente.
- `FarmerCalls` **lançaria** sem o Provider. Passa a usar `useCallBackendOpcional` (backend
  `'indisponivel'`), cai no cronômetro manual e não disca.
- `AgendaTodayList` lança, mas não é montado. `Telefonia.tsx` só monta com o módulo ativo.

## N4: a fila crítica lia WhatsApp, Rota e Tarefas congelados

`useCriticaFila` chamava `useWhatsappSla()`, que fazia a query e abria o canal realtime `wa-sla`, e
também `useRouteContactList()` e `useMinhasTarefas()`, tudo incondicionalmente. Agora cada fonte
recebe `enabled: rotaCongelada(<rota>, MODULOS) === null`.

**Bug de quebra (ausente ≠ zero):** `data` ausente virava `[]`, ou seja, "sem sinal". Isso valia
para query desligada, carregando ou com erro. Agora vira `null`, e `buildCriticaInputs` marca
`tarefaIndisponivel`/`waSlaIndisponivel`. O `EvidencePack` passa a dizer "Sinais de … indisponíveis"
em `faltaDado`, como a rota já fazia.

## Provas

- `ConditionalWebRTCProvider.congelamento.test.tsx`: com o módulo congelado, o factory do mock do
  `WebRTCCallContext` não roda (chunk não pedido). Ativo, roda 1×.
- `useCriticaFila.congelamento.test.tsx`: os hooks reais rodam e só o supabase é dublê. Congelado:
  zero consultas a `v_whatsapp_sla`/`route_schedule`/`v_tarefas_estado` e zero canais. Leitura com
  falha também fica indisponível. Mockar os hooks seria aresta de fronteira de módulo (o gate
  `fronteiras` barrou a 1ª versão).
- Falsificação com controle verde na mesma invocação. Cada sabotagem ficou vermelha: o provider sem
  o gate, o WhatsApp ligado e `tarefas ausente → []`.

Deploy: só o Publish (front). Não há migration nem edge.
