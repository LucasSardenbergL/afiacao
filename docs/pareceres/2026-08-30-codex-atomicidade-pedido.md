<!-- Parecer do ritual /codex sobre o PR #2134 (atomicidade lógica do pedido).
     Transporte: scripts/codex-async.sh -m gpt-5.6-sol -r xhigh, exit 0, 10.196 bytes, HEAD ffa740ac4.
     VEREDITO: BLOQUEAR. Os achados NÃO estão consertados neste commit — ver a nota abaixo. -->

# Parecer independente — BLOQUEIA a entrega (2026-08-30)

**Estado: os 4 achados P1 seguem ABERTOS.** Este arquivo é a evidência, não o desfecho.

## Verificação minha, contra a PROD, do achado que decide

O parecer afirma "1.138 pares repetidos". Medido por mim em `psql-ro` — **é verdade e é pior**:

| | |
|---|---|
| pares `(sales_order_id, omie_codigo_produto)` repetidos | **1.179** |
| pedidos afetados | **1.049** |
| destes, pedidos Omie **vivos** (`omie\_%`, sem `deleted_at`) | **1.049 — todos** |

O guard de SKU repetido da migration olha **só o conjunto desejado**. Duplicata no estado
**ATUAL** não é detectada: as duas linhas do mesmo código caem no `UPDATE` (`d.cod = a.cod`),
recebem o **mesmo** conteúdo, nenhuma é deletada — e o cabeçalho é atualizado como se fosse uma
linha só. Apriori e cockpit passam a double-contar, com o valor do item **duplicado**.

E o assert `C6` do meu harness **codificava o comportamento errado**: ele exige "filhos antigos +
cabeçalho novo", que é exatamente a revisão MISTA que esta entrega existe para eliminar. O teste
estava protegendo o defeito.

## O achado sobre o meu próprio antídoto de falso-verde (item 7)

Confirmado por leitura: no `T1`, `TA` é registrado **depois** da leitura. Se a RPC de B demorasse
mais que o `pg_sleep(0.8)` de A, a leitura aconteceria **antes** de B escrever — a cesta antiga
viria pelo motivo errado — e ainda assim `TB0 < TA < TB1` passaria. O antídoto tem a mesma classe
de furo que ele existe para pegar. Conserto: `TA0` antes e `TA1` depois, exigindo
`TB0 < TA0 < TA1 < TB1`, e sincronizar A pela emissão de `TB0`, não por `sleep`.

---

=== PARECER CODEX (modelo gpt-5.6-sol · reasoning xhigh · tentativa 1) ===
## Veredito

**BLOQUEAR a afirmação de que a pendência está totalmente fechada.** A escolha arquitetural `(a)` é adequada para o volume e o escopo, mas a implementação ainda permite estados logicamente mistos e regressão para uma revisão velha.

Revisei o HEAD atual `ffa740ac4`.

## Achados

### [P1, confiança 10/10] SKU não é identidade de linha, e os dois caminhos de duplicidade estão errados

O guard conta duplicatas apenas no conjunto desejado em [reconciliar_pedidos_omie.sql:177](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:177).

Isso deixa dois defeitos:

- Se o estado atual tem duas linhas do mesmo SKU e o desejado tem uma, ambas entram no `UPDATE` por `d.cod = a.cod`; nenhuma é deletada e nenhuma é inserida. O resultado continua com duas linhas, agora possivelmente idênticas, enquanto `sales_orders.items/total` representam uma. Apriori/cockpit double-countam.
- Se o desejado tem SKU repetido, a função pula os filhos em [reconciliar_pedidos_omie.sql:200](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:200), mas ainda atualiza o cabeçalho em [reconciliar_pedidos_omie.sql:284](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:284). O teste C6 inclusive exige “filhos antigos + cabeçalho novo” em [test-reconciliar-pedidos-omie.sh:271](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/db/test-reconciliar-pedidos-omie.sh:271).

Não é hipótese: produção tem 1.138 pares repetidos, documentados em [database.md:171](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/docs/agent/database.md:171).

Correção mínima: detectar duplicidade tanto no atual quanto no desejado e, enquanto não houver identidade de linha, pular o pedido inteiro — inclusive cabeçalho. Correção estrutural: persistir `det.ide.codigo_item`.

### [P1, confiança 9/10] `FOR UPDATE` serializa chegada, não versão: payload velho pode vencer

O payload não carrega nenhuma revisão do Omie: a interface termina em `cabecalho/det` em [sync-reprocess/index.ts:42](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/functions/sync-reprocess/index.ts:42), e a RPC recebe apenas conteúdo em [sync-reprocess/index.ts:268](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/functions/sync-reprocess/index.ts:268).

Cenário:

1. Run A busca revisão R1.
2. Run B busca R2, mais nova, e publica.
3. A chega depois, obtém o lock e sobrescreve R2 com R1.

O banco fica atomicamente errado. O T3 aceita explicitamente qualquer uma das revisões como resultado em [test-reconciliar-pedidos-omie.sh:380](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/db/test-reconciliar-pedidos-omie.sh:380), portanto não prova monotonicidade.

Esse é o caminho `(c)`: manter `(a)`, mas acrescentar compare-and-set por revisão de origem e identidade de linha. A [documentação oficial do Omie](https://app.omie.com.br/api/v1/produtos/pedido/) expõe `infoCadastro.dAlt/hAlt` e `det.ide.codigo_item`; ambos estão ausentes do contrato atual.

### [P1, confiança 10/10] O cabeçalho não é realmente reconciliado de forma declarativa

O lock lê somente `status` e `total` em [reconciliar_pedidos_omie.sql:190](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:190). A decisão de atualizar ignora o valor atual de `items` e `subtotal` em [reconciliar_pedidos_omie.sql:282](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:282).

Consequências concretas:

- Uma alteração apenas de descrição/cor em `sales_orders.items`, sem mudar preço/quantidade/status, vira no-op permanente.
- Um estado legado “filhos novos, cabeçalho antigo” não é reparado se total/status coincidirem.
- `subtotal` incorreto sozinho nunca é corrigido.

Além disso, `items: []` é aceito como válido. Se qualquer item/total/status mudar, a função apaga o retrato do cabeçalho. Não existe igualdade ou consistência entre `items`, `itens` e `total`.

A função precisa comparar `items` e `subtotal` sob o lock ou, preferencialmente, derivá-los do mesmo payload canônico dentro da transação.

### [P1, confiança 9/10] Falhas sistêmicas podem produzir run `complete`

O `EXCEPTION WHEN OTHERS` em [reconciliar_pedidos_omie.sql:298](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:298) captura também classes que não são “um pedido ruim”: deadlock `40P01`, serialization failure `40001`, permissão, relação/coluna ausente, trigger quebrado etc.

Como a função retorna normalmente, `rpcErr` fica nulo em [sync-reprocess/index.ts:294](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/functions/sync-reprocess/index.ts:294). Mesmo que 100/100 pedidos falhem, o log recebe `error_message`, mas mantém `status='complete'` por [sync-reprocess/index.ts:329](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/functions/sync-reprocess/index.ts:329).

Não encontrei watchdog automatizado no repositório que transforme isso em alerta. `get_health` mostra `error_message` nos logs recentes, mas o resumo diário nem seleciona essa coluna em [sync-reprocess/index.ts:844](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/functions/sync-reprocess/index.ts:844).

Capture apenas erros de dados explicitamente previstos. Deadlock, serialização, schema, permissão e infraestrutura devem ser relançados; a edge deve marcar `partial/error` ou falhar quando todos os pedidos falharem.

## Respostas diretas aos dez pontos

1. **`(a)` sobre `(b)`: correta para este escopo.** Porém, `(b)` precisa apenas de uma transação curta para publicar o ponteiro, não da reconciliação in-place inteira. E o risco de leitor esquecer filtro pode ser eliminado expondo somente uma view da revisão publicada. Ainda assim, o custo migratório não se justifica agora. O melhor `(c)` é `(a) + revisão CAS + identidade de linha`.

2. **As CTEs estão corretas quanto ao snapshot e à ordem.** Os alvos físicos de `DELETE`, `UPDATE` e `INSERT` são disjuntos quando o desejado tem chave única; nenhuma precisa enxergar a anterior. A ordem de execução não importa. O defeito é a chave sem unicidade semântica, não a mecânica das CTEs.

3. **O lock basta para o mesmo pai, mas há deadlock AB/BA.** Uma chamada RPC é uma transação da página inteira, não uma transação top-level por pedido. Locks de pedidos já processados ficam presos até o fim — fato reconhecido pelo T4 em [test-reconciliar-pedidos-omie.sh:418](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/db/test-reconciliar-pedidos-omie.sh:418). Lotes `[A,B]` e `[B,A]`, inclusive cruzando com `criar_pedidos_com_itens`, podem formar ciclo. Ordene ambos por `(account, hash_payload)` e relance/retry `40P01`. T3 testa apenas duas sessões no mesmo pedido, onde não existe ciclo.

4. **Fail-closed incompleto.** `total/items` ausentes são protegidos, mas `quantity`, `unit_price`, `discount` e `hash_payload` ausentes viram `1/0/0/NULL` em [reconciliar_pedidos_omie.sql:217](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql:217). O teto de 500 pedidos não é contornável dentro de uma chamada, mas cada pedido pode carregar quantidade e bytes ilimitados de itens.

5. **Sim, `WHEN OTHERS` mascara classes sistêmicas.** Deve haver allowlist de erros recuperáveis, não catch-all.

6. **Lançar `rpcErr` está certo.** Para pedidos com SKU único e sem falha, as contagens preservam aproximadamente a semântica anterior. Elas mudam em duplicatas atuais e o status da run não representa as falhas capturadas.

7. **T1 prova a visibilidade MVCC básica, mas o antífalso-verde temporal tem uma brecha.** `TA` é registrado depois da leitura em [test-reconciliar-pedidos-omie.sh:323](/Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/strange-mccarthy-194958/db/test-reconciliar-pedidos-omie.sh:323). A cesta pode terminar antes de `TB0`, B registrar `TB0`, e só então A registrar `TA`; `TB0 < TA < TB1` passa mesmo assim. Registre `TA0` antes e `TA1` depois, exigindo `TB0 < TA0 < TA1 < TB1`, e sincronize A pela emissão de `TB0`, não por `sleep(0.8)`. F1 é uma boa falsificação. T1 não cobre duplicatas, stale-write, deadlock AB/BA, payload malformado nem o snapshot do cockpit.

8. **A tolerância foi espelhada corretamente.** TS usava `< 1e-6`; SQL considera igual somente quando `< 1e-6`. Exatamente `1e-6` é divergência em ambos. `numeric` melhora a precisão. A perda de cobertura está nos casos não testados: duplicata já existente, drift apenas de `items/subtotal` e campos individuais ausentes.

9. **`search_path=''` está correto.** Tabelas estão qualificadas e `pg_catalog` continua implicitamente pesquisado para built-ins.

10. **Fecha a janela de commits intermediários para pedidos normais com SKU único.** Não fecha: pedidos com SKU repetido, revisão velha chegando depois da nova, drift isolado de cabeçalho, falhas sistêmicas convertidas em sucesso e concorrência multi-pedido com ordem de locks divergente.

Escopo do diff: limpo. Não alterei arquivos. Não pude reexecutar o harness PG17 porque o ambiente desta revisão é read-only; `git diff --check` não apontou erro de conteúdo.

(cópia em /var/folders/cz/94l8x0rn6hqfk080j49r247r0000gn/T/codex-async.XXXXXX.JY9RQMjgNc)
