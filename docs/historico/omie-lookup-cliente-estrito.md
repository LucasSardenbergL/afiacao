# Omie: lookup ESTRITO do cliente por documento no `criar_cliente` e no `buscar_cliente` (2026-10-27)

> Follow-up do **achado 4 do Codex** no PR #3293 ([radar-cadastro-omie-idempotente.md](radar-cadastro-omie-idempotente.md)
> §Follow-ups). Edge `omie-vendas-sync` **v1.27-lookup-cliente-estrito**, empilhada sobre a v1.26 do #3359
> (gramática estrita do documento DEVOLVIDO, [radar-cnpj-alfanumerico.md](radar-cnpj-alfanumerico.md)).

## Problema

Antes do `IncluirCliente`, o `criar_cliente` chamava `buscarClienteVendas`: `ListarClientes` com
`registros_por_pagina:1`, pegava `clientes_cadastro[0]` e, se a resposta viesse **malformada** (sem o array, sem
código), devolvia `null`, lido como "não existe". O fluxo então seguia para o `IncluirCliente`. Com **dois códigos**
Omie para o mesmo documento, ele usava o 1º sem avisar. A chave determinística
`codigo_cliente_integracao = APP_<CONTA>_<doc>` só impede repetir a **mesma** chave; ela não detecta um
cadastro duplicado. O `buscar_cliente`, cujo código vira o cliente do pedido, tinha o mesmo defeito.

PROD em 2026-10-27: 0 vínculos e 0 confirmações em `omie_cliente_confirmacoes`. O fluxo nunca foi usado, então
não há dado a migrar, mas o defeito atingiria o primeiro uso real.

## Desenho (Codex `-r max`: ACEITO COM AJUSTES, todos incorporados)

Módulo PURO `supabase/functions/omie-vendas-sync/lookup-cliente-estrito.ts`. O fetch da página é injetado: o
`index.ts` passa o `callOmieVendasApi` com `throwOnTransient`.

| Resposta do Omie | Desfecho |
|---|---|
| 1ª página vazia e válida (fault "Não existem registros" ou `clientes_cadastro: []`) | `null`: ausência **provada** → `IncluirCliente` |
| 1 código distinto, depois uma página vazia | esse cliente (`created:false` + confirmação no ledger) |
| 2+ códigos válidos distintos | `OMIE_LOOKUP_AMBIGUO`, **na hora**, na página que os mostrou — vence registro malformado/divergente na mesma página, relógio estourado e transitório na página seguinte (nada o rebaixa a falha retentável) |
| registro com OUTRO documento, inclusive atrás do certo | `OMIE_LOOKUP_DIVERGENTE` (contrato de antes, agora aplicado a todos os registros) |
| sem `clientes_cadastro` · registro sem código inteiro seguro > 0 · `cnpj_cpf` não-string · eco `pagina` ≠ pedida ou de tipo inválido (`true`/`[1]`/`null`) · `registros` que contradiz o array (`{registros:1, clientes_cadastro:[]}`) · nenhuma página vazia em 10 páginas · resposta que chegou depois de 90 s do início do lookup (conferido após CADA resposta, inclusive a 1ª vazia) | `OMIE_LOOKUP_INDETERMINADO` (nunca "não existe") |
| transitório esgotado | `OMIE_TRANSIENT` (propaga como antes; o lote usa essa marca para parar) |

- **Paginação até a página vazia**, como manda o CLAUDE.md. Cliente ausente continua custando 1 `ListarClientes`;
  cliente existente passa a custar 2. Página curta não prova o fim.
- **Código repetido** entre páginas conta como o mesmo cliente; vale o 1º registro dele, vendedor incluso. A
  deduplicação só roda depois de validar todos os registros da página.
- **Documento devolvido** passa pela gramática estrita no helper `_shared/lookup-documento.ts` (#3359): letra fora
  do CNPJ alfanumérico não casa pelos dígitos.
- **Front** (`src/lib/radar/cadastro-omie.ts`): `OMIE_LOOKUP_AMBIGUO` vira
  `DivergenciaCadastro('omie', 'lookup_ambiguo')`, terminal como o `lookup_divergente`. `OMIE_LOOKUP_INDETERMINADO`
  continua `FalhaCadastro` retentável: falta evidência, não há conflito provado.

**Revisão de código do Codex** (`-r max`): APROVADO COM AJUSTES. Os dois MÉDIOS foram corrigidos neste PR:

- o orçamento só era conferido antes da próxima página. Uma 1ª página vazia aos 70 s virava `null`, e uma
  página 2 vazia aos 198 s aceitava o código;
- `arr.map` lançava no 1º registro malformado, então `[777, 778, malformado]` saía INDETERMINADO, retentável, em
  vez de AMBIGUO.

Agora a página é lida inteira, a multiplicidade é decidida primeiro e o defeito da página é lançado depois.

## Prova

- **Deno** (`lookup-cliente-estrito_test.ts`, `--no-remote`), negativos casando a marca do ramo (`startsWith`):
  vazio válido (fault e array), 1 resultado (só depois da página vazia), código repetido, ambíguo (mesma página e
  páginas diferentes), ambíguo + transitório, divergente, 18 formas de malformado, guard de páginas, orçamento,
  transitório e documento devolvido com letra.
- **Vitest** (`cadastro-omie.test.ts`): AMBIGUO lançado ou no corpo vira `lookup_ambiguo` terminal sem gravar;
  INDETERMINADO fica retentável.
- **Falsificação** com controle verde (deno + vitest) na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`:
  16/16 sabotagens vermelhas. Sabotagens: malformado vira vazio · sem ambiguidade · 1º registro · sem guard ·
  código 0 aceito · sem divergente · sem eco de página · eco permissivo (`Number()`) · sem contagem · AMBIGUO
  nunca · sem orçamento · defeito antes da ambiguidade · defeito ignorado · só página 1 · front AMBIGUO retentável · front INDETERMINADO terminal. (A 1ª rodada
  pegou o teste de orçamento verde sob sabotagem — o guard de páginas mascarava; o fake passou a esvaziar a página 2.)

## Deploy (2026-10-27)

- **Edge `omie-vendas-sync` v1.27:** a sessão enviou pelo MCP do Lovable às 16:35:58Z o pacote `7ce1206b7df5`
  (`origin/main@01cb04a6`, closure de 31 arquivos). O agente conferiu **31/31 hashes** (`sha256sum` exit 0) e fez
  o deploy. O sensor de edição deu `SEM_EDICAO`: 0 commits `gpt-engineer-app` e `No files were edited.`
- **Atestação:** a sonda por cron (job 184, 16:37Z) viu `v1.27-lookup-cliente-estrito`, e o `pendencias:deploy`
  deu **exit 0**, com 83/83 edges em `CONFERE`.
- **Front no ar (Publish do founder):** `monitor-deploy.sh --pr 3362 https://steu.lovable.app` deu exit 0 com
  `PR_NO_AR`. O ar serve `2c9b8197`, o squash do #3363, e o squash `01cb04a62` do #3362 está na história dele. Entre
  os dois só entraram os commits do #3364 e do #3363; nenhum commit "Changes" reverteu algo. Com isso,
  `OMIE_LOOKUP_AMBIGUO` chega ao Radar como `lookup_ambiguo` terminal.

## v1.28: identidade do `criar_pedido` pelo mesmo lookup (2026-10-27)

O 1º risco aberto abaixo foi fechado. `buscarClienteVendasMatches`, a identidade que `deriveOmieAccountIdentity`
passa ao `decideAccountIdentity`, tinha três furos:

- usava `registros_por_pagina:2` e `?? []`, então uma resposta malformada virava ausência;
- `.filter(c => c.codigo_cliente_omie)` descartava calado o 2º registro sem código, e o que sobrava virava candidato
  único;
- não conferia o documento: um registro de OUTRO documento virava o cliente do pedido.

Agora ela usa `matchesDoPedido`, o mesmo `buscarClienteEstrito`, com 0 ou 1 match. `erroDeIdentidadeDoPedido`
converte as marcas em `Pedido rejeitado: … (OMIE_LOOKUP_*)`, o prefixo que `submitOrder`, `SalesQuotes` e
`pedido-programado-enviar` já tratam como recusa. `OMIE_TRANSIENT` passa intacto.

**Codex** (`-r max` e depois `-r high`): APROVADO COM AJUSTES e, na 2ª rodada, **APROVADO**. Os três ajustes:

- **P2, tempo:** o orçamento era conferido só depois de cada resposta, e cada chamada tinha o próprio teto de 140 s.
  Duas `ListarClientes` mais o `IncluirPedido` passavam dos 150 s da edge. Agora `callOmieVendasApi` aceita
  `opts.deadline`, aplicado como `min` com o teto. `ListarPagina` recebe o prazo absoluto do lookup, e o orçamento
  caiu de 90 s para 40 s. Ao estourar, a leitura dá `OMIE_TRANSIENT`, nunca ausência. Limite residual: os 40 s
  limitam o lookup, não o lookup somado à escrita.
- **ALTO anterior a este PR, entrada do pedido:** `normalizarDocumento('123ABC45678909')` virava o CPF
  `12345678909`, de outra pessoa. `docDoPedido` passa o documento pela gramática estrita (`documentoParaCadastro`);
  vazio mantém o fallback de `profiles`. Medido em PROD: 0 documentos com letra em `sales_orders` e em `profiles`,
  e 5.668 de 5.668 `profiles` estão na gramática numérica. 32.066 de 32.068 pedidos têm `customer_document` vazio
  e usam esse fallback.
- **Teste:** a conversão das marcas virou função pura testada.

O documento devolvido pelo Omie já passava pela gramática estrita (#3359). Medido em PROD: 10.167 de 10.167
`cnpj_cpf` de clientes Omie são numéricos limpos, então a conferência não barra cliente legítimo. O teste de fiação
`omie-chamada-relogio-fiacao_test.ts` passou a fixar a nova forma do prazo, que continua nascendo FORA do laço.
Falsificação: 21/21 sabotagens vermelhas, com controle verde, em `LC_ALL=C` e `pt_BR.UTF-8`.

**Deploy da v1.28 (2026-10-27):** pacote `0e0201fd65a0`, de `origin/main@e0f60cc5`, enviado pelo MCP às 18:32:44Z.
O agente do Lovable conferiu 31/31 hashes (`sha256sum` exit 0) e fez o deploy. O sensor de edição deu
`SEM_EDICAO`: os 2 commits `gpt-engineer-app` só regeneraram `src/integrations/supabase/types.ts`, que é tolerado. A
sonda por cron das 18:37Z viu `v1.28-identidade-pedido-estrita`, e o `pendencias:deploy` deu **exit 0**, com 83/83
edges em `CONFERE`. Não mudou nada em `src/`, então não há Publish.

## Riscos abertos (fora deste PR)

- ~~**`buscarClienteVendasMatches`** (identidade do `criar_pedido`)~~ → fechado na v1.28 (seção acima).
- ~~**`buscarContextoComercialCliente`** (leitura do contexto comercial, colacor) ainda usa o 1º registro.~~ →
  fechado na **v1.29**. A action `buscar_contexto_comercial_cliente` tem **zero** consumidores (`git grep` no repo e
  `cron.job`: 0), então o risco estava dormente. Mesmo assim ela passou a usar `buscarClienteEstrito` com `docDoPedido`:
  ambíguo, divergente, resposta inválida e transitório LANÇAM, e só a ausência provada devolve o contexto vazio. A
  `buscarClienteVendas`, que pegava o 1º registro, ficou sem chamadores e foi **removida**. Nenhum lookup por
  documento da `omie-vendas-sync` usa mais o 1º registro.
- **Corrida** entre o lookup e o `IncluirCliente`: a paginação não é um snapshot. A chave determinística protege
  concorrentes que usam a mesma chave, não um cadastro manual feito entre as duas chamadas. Uma chave já ocupada
  por outro documento continua falhando sem confirmação.
