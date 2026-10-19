# Casts que desligam o tipo — módulo governança / DES (plano v2 · item 4 / I1 · PR 3)

2026-10-19. Terceiro PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-pedidos-programados.md](casts-pedidos-programados.md) e [casts-reposicao.md](casts-reposicao.md). Escopo: os arquivos não-teste do módulo `governanca` (manifesto) que ainda tinham `as never` / `as unknown as` — 13 arquivos, 31 casts: `src/components/des/**` (check-in qualitativo, simulador, histórico, posição atual), `useDataHealth`, `useAuditTrail`, `useIniciativasIceberg`, `useClienteGrupos`, `useGrupo{Financeiro,Contatos,Comercial}` e `GestaoGovernanca.tsx`. **Fora, de propósito:** `useExcecoesGestor.ts` (3 casts) — o manifesto o lista em `governanca`, mas o briefing do item congela a família `useTarefas*`/`useExcecoesGestor` junto com o módulo `tarefas`.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (read-only) antes de corrigir:

- **`GestaoGovernanca.tsx` contava 4 tabelas que nunca existiram.** Os cards "Usuários Ativos / Permissões / Parâmetros / Eventos Auditoria" liam `governance_users`, `governance_permissions`, `governance_math_params`, `governance_audit_logs` — `information_schema.tables` em prod: **0 linhas** com esse prefixo (e 0 no `types.ts`). O cast `supabase as unknown as { from(table: string) … }` cegava o TS e o `safeQuery` (try/catch com fallback `0`) engolia o 404 do PostgREST: **os 4 cards mostravam "0" fabricado** desde que nasceram (#140, wave 28). Agora contam nas tabelas que as abas realmente leem (`profiles is_employee`, `permission_overrides`, `farmer_algorithm_config`, `permission_change_log + farmer_audit_log + margin_audit_log`); erro vira "—", não 0.
- **"Cast temporário até a regen de tipos (Task 4)" sobreviveu à regen.** Os 4 hooks de Grupo de Cliente 360 embrulhavam o client (`db = supabase as unknown as { from: (t: string) => any }`) com esse comentário; `cliente_grupos`, `cliente_grupo_membros` e as views `v_grupo_*` **já estavam** no `types.ts`. Um cast "temporário" não tem prazo nem sensor — só sai quando alguém o procura.
- **jsonb de faixa do DES** (`faixa_conservadora`/`faixa_otimista` da `v_des_posicao_trimestre_ao_vivo`) era lido por 3 interfaces locais diferentes (`FaixaInfo`, `{ faixa_numero?; estrelas? }`, inline). Forma real em prod: `{faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max}` — e **NULL** quando não há posição. Agora há uma borda só (`src/components/des/faixa-json.ts`): lê por forma, campo que não é número vira `null`, nunca 0.
- **`get_data_health`** e **`fin_audit_log`**: o `Returns`/`Row` gerado tipa `domain`/`status`/`severity`/`op`/`origem` como `string`. Os vocabulários locais (`HealthDomain`, `AuditEntry['origem']`…) batem com os literais da função SQL (migration `20261005150000`) e com os `CHECK`s da tabela (conferidos em prod) — a borda agora **guarda** e lança fora do vocabulário, em vez de fingir com cast.
- **`simular_puxar_volume_trimestre`** devolve `Json`; `SimResult` (tudo opcional) virava cast. Agora `simResultDeJson` lê os 4 blocos por forma; tipo errado → `undefined` (a UI já mostra "—").

## O que ficou

- `linhasCom`/`exigirColunas`/`ComColunas` **promovidos a plataforma** (`src/lib/linha-view.ts`); `src/lib/reposicao/linha-view.ts` re-exporta e mantém só a guarda de domínio (`empresa_reposicao`). Os tipos de linha do DES (`DescontoCheckin`, `CheckinDescontoRow`, `PedidoTransito`) derivam de `Tables<'v_des_…'>` com as colunas-chave exigidas.
- Gate `casts:stale`: baseline `{from: 30, rpc: 35}` → `{from: 25, rpc: 33}`; piso `castsLiterais` **65 → 58** = contagem real (ratchet: com o piso em 65 e 58 na árvore o gate acusou `CEGO` até o piso descer).
- Testes novos (registrados no manifesto): `faixa-json`, `sim-result`, `dataHealth/borda`.

## Lições

- **Cast + try/catch com fallback é cegueira dupla:** nem o TS (cast) nem o runtime (catch → 0) acusam tabela inexistente. Quando encontrar `safeQuery(…, 0)` sobre um client cegado, confira a tabela em prod antes de qualquer coisa — aqui a resposta era "nunca existiu".
- **Comentário "temporário até X" é candidato de varredura:** `git grep -n "tempor" | grep -i cast`. Se X já aconteceu, o cast é dívida sem dono.
- **Helper de borda genérico sobe para a plataforma quando o 2º módulo precisa** — duplicar `linhasCom` por módulo é slop; o módulo guarda só o que é do domínio (enum, colunas-chave).
- A `psql-ro` **não executa** `get_data_health` (permission denied para `claude_ro` — fail-closed correto); o vocabulário foi conferido no corpo SQL da última migration da função.
