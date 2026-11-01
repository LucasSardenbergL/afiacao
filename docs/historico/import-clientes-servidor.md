# Import de clientes no servidor (2026-11-01)

## Sintoma

O "Importar Clientes (3 Contas Omie)" de `/admin/analytics-sync` era um laço no **navegador**: a tela chamava a edge
`omie-cliente` action `sync_all_clients` página a página e guardava o cursor (conta, página, teto) só na memória da aba.
Ele é o único caminho que **cria** cliente no app (placeholder em `auth.users`, `profiles`, `register_carteira_member`):
o sync diário de clientes só atualiza quem já existe, e o refresh diário de não vinculados só *lista* quem falta.

No mesmo dia, depois do conserto do 504 (v1.5), o laço morreu três vezes no meio:

| Quando (UTC) | Causa | Registro |
|---|---|---|
| 19:42 | preview do editor do Lovable recarregou (a main mudou com o #3499) | `executando` órfão (18:57 e 18:58, clique duplo) |
| 20:27 | "Failed to send a request to the Edge Function" (rede do navegador) | `erro` |

Cada clique recomeçava da página 1 e passava 15–30 min relendo páginas já feitas. Saldo do dia: 2.927 vínculos novos
(zero duplicata), mas 14 clientes da Oben com título em aberto seguiam sem vínculo, todos em páginas não alcançadas, e a
lista de não vinculados da Oben tinha 10.168 nomes. Órfãos `executando` acumulados: 22/07, 17:20, 18:57, 18:58.

## Conserto (migration `20261101200000_clientes_import_servidor.sql`, edge `omie-cliente` v1.6)

Copia o modelo do import de **pedidos** (`vendas_sync_cursor` + semear + lease cercado + cron), simplificado para
uma rodada por vez:

- **`clientes_import_rodada`**: o cursor sai da aba e vai para o banco. A conta é guardada pelo **slug**, não pelo
  índice — `getOmieAccounts()` filtra credencial ausente, então o índice mudaria de conta no meio.
- **Índice único parcial** `((true)) WHERE concluida_em IS NULL AND falhou_em IS NULL`: no máximo uma rodada aberta.
  Clique duplo e cron semanal concorrente caem na mesma.
- **Botão semeia** (`clientes_import_semear`, staff); **cron de 1 min** chama `continuar_import_clientes` (x-cron-secret),
  que reivindica o lease, injeta o cursor e cai no **mesmo** bloco `sync_all_clients` (os guardrails money-path leem
  esse bloco como texto — não foi extraído). Depois do bloco, `clientes_import_avancar` grava o cursor e os acumulados.
- **Lease de 7 min**, acima do tempo máximo de parede de uma edge (400 s): nem a invocação que segue viva depois do
  corte do gateway coincide com a próxima. Duas simultâneas criariam o mesmo cliente duas vezes, porque o dedup é
  carregado no início de cada uma.
- **`sync_all_clients` direto devolve 410**: um front antigo (cache do service worker) seria um 2º escritor fora do lease.
- **Terminalidade honesta**: 5 erros seguidos → `erro_persistente`; 20 lotes sem avanço (inclui lease morto roubado) →
  `sem_progresso`; ambos visíveis e re-armáveis mantendo o cursor. Fim só com `done === true` ou `hasMore === false`.
  Conta abandonada ou sem credencial e erros por cliente deixam a rodada **parcial** na tela, nunca "concluída".
- **Cron semanal** (domingo 06:00 SP) semeia uma varredura completa.
- **Tela**: mostra a rodada aberta, a última falhada e a última concluída; "pode fechar esta aba"; aviso de **atrasada**
  quando o servidor fica 10 min sem sinal (o sucesso do cron não prova que a edge rodou).

## Provas

- `db/test-clientes-import-servidor.sh`: 34 asserts em C e pt_BR; 11 sabotagens vermelhas, 0 falhas (controle verde
  na mesma invocação).
- Deno `omie-cliente/import-servidor_test.ts` (contrato do lease, slug→índice com credencial sumida, fim validado).
- vitest: `rodadaClientes.test.ts`, `ImportCards.test.tsx`; a invariante "o caller acumula a falha" de
  `edge-money-path-invariants.test.ts` passou a medir o caminho do servidor.

## Codex

Desenho (gpt-6-astra · max · 207 s · 133.912 tokens): 0 P0, 9 P1, 4 P2. Adotados: lease 7 min, legado 410, slug,
fim validado, RPCs recusam terminal, re-armar pelo índice único, ACL do helper interno, tela com falhada/atrasada.
**Residual declarado (pré-existente, não introduzido aqui):** a sequência createUser → profile → carteira não é
atômica; uma morte no meio deixa o placeholder órfão e a retomada conta erro naquele cliente.

## Fora do escopo (próximo passo)

**Incremental diário**: pedir ao Omie só os clientes incluídos/alterados desde o último cursor. `ListarClientes`
nunca foi chamado com filtro de data no repo — os nomes dos parâmetros precisam ser medidos em produção antes.
