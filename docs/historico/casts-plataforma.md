# Casts que desligam o tipo — módulo plataforma (plano v2 · item 4 / I1 · PR 6)

2026-10-20. Sexto PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-estoque-recebimento.md](casts-estoque-recebimento.md) e do #3257 ([plano-v2-ciclo-2.md](plano-v2-ciclo-2.md), que tirou os 5 `as never` literais do módulo: `analytics-ledger`, `registrar-geracao`, `useAuthzContract`). Escopo: os arquivos não-teste do módulo ativo `plataforma` (manifesto). Eram 37 ocorrências textuais de `as never`/`as unknown as`: 33 em código, 4 em comentários. O #3257, de uma sessão paralela, tirou 6 delas (os `as never` literais). Este PR tira as outras 27, em 16 arquivos. Ficou 1 asserção estreita documentada (`useUrlState`) e 4 comentários históricos.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (`pg_get_function_arguments`, `pg_get_functiondef`, CHECKs, contagem de nulos) antes de corrigir:

- **Os comentários "ainda não está no types gerado" eram falsos de novo.** `analytics_ledger_registrar`, `farmer_geracao_registrar`, `farmer_geracao_vigente`, `authz_contract_version`, `acoes_execucoes`, `log_impersonation_start`/`end_impersonation`, `get_user_access_profile_for` e `list_impersonation_targets` estavam todos no `types.ts`. Os clientes estruturais locais (`EscritaExecucoes`, `SelectExecucoes`, `rpc(fn: string, …)`) só desligavam a checagem.
- **`AIDecision` (AI Ops) afirmava não-nulo em 5 colunas que o banco permite NULL**, e o card fazia `(decision.evidences as Evidence[]).slice(…)`: `evidences` NULL derrubaria a tela. A borda `src/components/aiOps/borda.ts` lê os dois jsonb por forma. `evidences` NULL vira lista vazia, e um item fora de `{label, value, type∈CHECK}` lança. `customer_metrics` também tem um flag booleano (`is_cold_start`) que o tipo `Record<string, number | null>` negava. A borda guarda só número ou NULL explícito, e o flag não vira número. Em prod: 1.156 decisões, 2.743 evidências, todas bem-formadas.
- **`fornecedor_alerta.criado_em` é nullable** (tem `DEFAULT now()`, mas não `NOT NULL`; 0 nulos em 545), e `severidade` é CHECK, que o gerador entrega como `string`. A borda `src/components/notificacoes/borda.ts` exige `criado_em` (via `exigirColunas`) e guarda `severidade`. A série de estatísticas usa `linhasCom`, porque o `.gte('criado_em')` já descarta NULL no SQL.
- **`acoes_execucoes.origem`/`status` também são CHECKs.** `AcaoExecucao` agora deriva de `Tables<>`, e `execucaoDaLinha` estreita os dois e lança fora do vocabulário. `detalhes` passou de `Record<string, unknown>` para `{ [k]: Json | undefined }`, e todos os chamadores de `useMutationComRegistro` já cabiam nesse tipo.
- **`list_impersonation_targets.commercial_role` vem de LEFT JOIN**, então chega NULL embora o gerador diga `string`. O consumidor já tratava NULL, e agora há comentário.
- **`get_user_access_profile_for`** monta as 4 chaves com `jsonb_build_object`, e NULL vem explícito. O retorno era lido com `as` campo a campo, e um `app_role` desconhecido passava direto. Agora é lido por forma: desvio LANÇA, a query vira erro e a lente não inventa papel para o alvo.
- **Args com `DEFAULT NULL`** (`farmer_geracao_registrar.p_motivo/p_head_visto`, `log_impersonation_start.p_reason`) são declarados `?: string` pelo gerador. Passar `valor ?? undefined` remove a chave do JSON e cai no mesmo NULL, sem cast.
- **`melhor-individual.ts`** validava a linha inteira e devolvia `l as unknown as`. Agora o objeto é montado campo a campo a partir do que foi validado. `affinity_score` é aceito como número OU texto, e o tipo passou a dizer isso (`number | string | null`).
- **OAuth consent:** `supabase.auth.oauth` já é tipado pelo auth-js 2.95. O wrapper local lia `client.client_uri` e `redirect_to`, campos que o SDK não conhece. Por isso o site do cliente nunca aparecia: o campo é `client.uri`. O próprio SDK redireciona por `redirect_url` no approve.
- **Plataforma web:** `navigator.locks` ganhou guarda `in`, como em `motor-fila.ts`. `navigator.standalone` (só Safari iOS) também ganhou guarda `in`. `vapidKeyToUint8Array` devolve `Uint8Array<ArrayBuffer>`, que o `BufferSource` aceita. O `PushSubscriptionJSON` (interface do lib.dom, sem assinatura de índice) é remontado com as mesmas 3 chaves. O `event` do workbox aceita o `EventoFetch` local, e o `createLensGuardedClient(cru)` já devolve o tipo do cliente.
- **`InsumoLido` virou `type`** (era `interface`): só alias de objeto ganha assinatura de índice implícita, e é ela que deixa o snapshot entrar no `p_insumos` (Json).

## O que ficou

- Teste novo: `src/components/aiOps/__tests__/borda.test.ts`, coberto pelo glob `src/components/aiOps/**`.
- Gate `casts:stale`: sem mudança (`{from: 21, rpc: 26}`, piso 47). Os `as never` literais do módulo já tinham saído pelo #3257; o que sobrava aqui eram `as unknown as` e clientes estruturais, que o gate não conta.
- Residual deliberado: `useUrlState.deserialize` mantém **um** `as T` estreito, com comentário. O valor tem a família do fallback (texto, número, booleano ou lista), mas a URL não prova a união literal que `T` pode ser. Validar o vocabulário é de quem o conhece, não do parser genérico. Antes eram 4 `as unknown as T`.
- Os 4 `as unknown as` restantes no módulo estão em comentário histórico (`linha-view.ts`, `postgrest.ts`, `logger.ts`, `visitasAgendadas.ts`). O de `visitasAgendadas.ts` descreve o consumidor de farmer-inteligência, que sai no PR desse módulo.

## Lições

- **Tipo local "de domínio" escrito à mão costuma ser mais otimista que o banco.** O `AIDecision` e o `AlertaRow` tinham não-nulos que o banco não garante. Derivar de `Tables<>` e estreitar só o que a borda prova trouxe à tona um crash latente (`evidences` NULL).
- **Interface do lib.dom ou do domínio não cabe em `Json`**, porque falta assinatura de índice. A saída é `type` em vez de `interface`, ou remontar o objeto, nunca o cast.
