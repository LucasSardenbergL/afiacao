=== PARECER CODEX (modelo gpt-6-astra · reasoning max · tentativa 1 · 626s · 236.808 tokens) ===
**Eu começaria por A1, A2 e C1. B2/B3/B9 estão subestimados em risco; C4 muda o produto; C5 aponta para consumidores já desabilitados; C7 tem uma solução menor: respeitar o congelamento existente.**

Conferi o checkout `11fe0913` e o `dist` existente, identificado com o mesmo SHA. Não alterei arquivos, gerei build ou executei SQL. Os números de produção e das execuções de CI permanecem evidências fornecidas por você; abaixo distingo isso das constatações no código.

“MOVER ↑” significa antecipar; “MOVER ↓”, adiar ou reduzir o escopo. “CORTAR” refere-se à proposta como formulada.

| Item | Veredito | Revisão adversária |
|---|---|---|
| **A1** | **MANTER** | Recalculei: **159 provas, 16 sem custo, cargas previstas de 846–847 s**. Default de 30 s e teto de 20 min confirmados. Recalibrar o mecanismo existente faz sentido; o ganho médio anunciado precisa ser corrigido. [Partição:214](db/roda-nucleo-ci.sh:214) |
| **A2** | **MANTER** | Os scripts não usam incremental nem ajustam heap. Cache deve ser separado por projeto/worktree; aumento de heap deve ficar restrito ao comando necessário. Não reproduzi o crash nem os tempos. [package.json:27](package.json:27) |
| **A3** | **MANTER, com ajuste** | Criar execução rápida **explícita**, preservando `test` completo e CI completo. A classificação “28 arquivos síncronos” não se confirmou: encontrei 14 `.test.ts` contendo esses nomes; o teste dominante usa `spawn` no processo principal. Classificar pelo custo medido. [Teste:18](scripts/exclusividade-medir.test.ts:18) |
| **A4** | **CORTAR o pacote** | `nucleo-ci.txt` contém contratos editáveis, não apenas entradas acrescentadas ao final; união pode conservar versões incompatíveis, que o runner rejeitará como duplicatas. Para o índice documental, cabe decisão isolada do founder, sem prometer eliminar 21 resoluções. [Runner:165](db/roda-nucleo-ci.sh:165) |
| **A5** | **CORTAR como formulado** | “Quente e rápido” não demonstra baixo pico de memória; uma invalidação do cache volta ao caminho frio. A2 aumenta a necessidade de cautela. Lint pode ser reconsiderado com RSS medido, separadamente. [heavy:59](scripts/heavy.sh:59) |

**A1 não demonstra seis minutos por PR:** apenas os retries descritos dão `(2/15) × 25 = 3,3 minutos/run`. O restante precisa vir de balanceamento efetivamente medido. Aumentar o teto evita cancelamentos; não acelera a execução nem garante máximo de 21 minutos.

Também corrigiria a justificativa de A4: `union` é um driver **nativo** do Git, não um driver customizado. A documentação alerta que ele pode combinar linhas em ordem arbitrária. Isso não comprova seu comportamento no fluxo de merge do GitHub. [Documentação do Git](https://git-scm.com/docs/gitattributes)

| Item | Veredito | Revisão adversária |
|---|---|---|
| **B0** | **MOVER ↑** | Antes de escolher índices por contadores, obter consultas, tempo acumulado e planos. O founder pode consultar pelo SQL Editor sem conceder acesso permanente. `pg_read_all_stats` libera texto/queryid de outros usuários; não confundir isso com resolver qualquer erro de ACL. [PostgreSQL 17](https://www.postgresql.org/docs/17/pgstatstatements.html) |
| **B1** | **MOVER ↓ e separar** | Retenção e retirada de índices são decisões distintas. Não encontrei leitores operacionais desses históricos, mas 34 h sem scans não basta para aprovar quatro drops. O cron existente é **mensal**, detalhe relevante para a promessa de 30 dias. [Migration:74](supabase/migrations/20261011120400_retencao_scores_farmer.sql:74) |
| **B2** | **MOVER ↓; reestimar** | Os upserts com carimbo novo estão confirmados. Entretanto, `synced_at` participa da validade e seleção do custo, além do monitoramento. Não é uma otimização P enquanto esse contrato estiver acoplado à escrita. [Writer:1569](supabase/functions/omie-analytics-sync/index.ts:1569) |
| **B3** | **MOVER ↓** | A chamada realmente envia apenas paginação; os parâmetros de data da função não chegam ao endpoint. Incremental exige contrato de alterações, retomada e reconciliação; “97% baixadas” não significa “97% imutáveis”. [Writer:890](supabase/functions/omie-financeiro/index.ts:890) |
| **B4** | **MANTER, com escopo menor** | O índice acompanha uma consulta real por conta/último registro. Expurgo precisa distinguir logs, idempotência e registros referenciados; apagar as três tabelas por idade não é automaticamente P. [Leitor:54](src/hooks/dashboard/useTintometricoZone.ts:54) |
| **B5** | **MANTER condicionado ao plano** | A busca por último `complete` existe, mas também filtra `action`. Conferir o plano efetivo do PostgREST, inclusive genérico, antes de escolher o índice parcial. Expurgo é uma entrega independente. [Leitor:246](src/hooks/useUtiContas.ts:246) |
| **B6** | **MANTER, corrigindo o desenho** | A policy customer **não contém `deleted_at IS NULL`**. Portanto, o índice parcial proposto não atende automaticamente toda leitura autorizada por ela. Comparar índice completo e parcial nas consultas reais, sob RLS. [Policy:105](supabase/migrations/20260724120000_authz_sales_orders_split_escrita_fu4.sql:105) |
| **B7** | **MOVER ↓** | Há consulta por `user_id`, mas faltam cardinalidade, seletividade e custo. Índice tem manutenção, armazenamento e custo de criação: “custo zero” não se sustenta. [Leitor:57](src/queries/useProfile.ts:57) |
| **B8** | **MOVER ↓ até B0** | Contagem de scans da tabela não atribui o custo aos filtros por conta. Com poucas contas, uma consulta pode selecionar parcela grande do catálogo e preferir scan. Existe ainda índice parcial começando por `account`, cuja cobertura precisa ser considerada. [Índice existente:20](supabase/migrations/20260604130000_omie_products_tipo_produto_coluna.sql:20) |
| **B9** | **MOVER ↓** | Escrita incondicional confirmada, mas esse writer também grava **preço** e compartilha a tabela com outros escritores. Os 136 mil updates não demonstram economia atribuível integralmente a ele. Também há dependência de frescor. [Payload:487](supabase/functions/omie-vendas-sync/index.ts:487) |

Para B5/B6, há uma diferença decisiva entre “o índice parece combinar com o código” e “o plano consegue utilizá-lo”. O predicado de um índice parcial precisa ser demonstrável no planejamento; parâmetros podem impedir isso em planos genéricos. [Documentação de índices parciais](https://www.postgresql.org/docs/17/indexes-partial.html)

| Item | Veredito | Revisão adversária |
|---|---|---|
| **C1** | **MANTER, alta prioridade** | Confirmei código **e artefato**: DnD importa helpers de `vendor-charts`; são 13 importadores estáticos. A regra ausente é real. “Uma regex resolve tudo” continua sendo hipótese até verificar o novo grafo. [vendorChunk:348](vite.config.ts:348) |
| **C2** | **MANTER, fatiado** | O profile bloqueia a Home staff sem ser usado por ela. Porém, Auth busca `is_approved`, não o mesmo profile; e o cargo da Home respeita “Ver como”. Paralelizar somente consultas independentes. [Index:35](src/pages/Index.tsx:35), [cargo efetivo:60](src/hooks/useMyCommercialRole.ts:60) |
| **C3** | **MANTER, com contrato de busca** | Drain e teto de 5 mil confirmados; o próprio código prevê busca no servidor quando o teto for atingido. Priorizar isso e limitar renderização. A view já é enxuta: `select('*')` nela não equivale a baixar pedidos completos. [Hook:35](src/components/salesOrders/useSalesOrders.ts:35), [view:1](supabase/migrations/20260606210000_order_feed_view.sql:1) |
| **C4** | **CORTAR como otimização** | Janela de 12 meses altera população, recência, intervalo de recompra e associação de produtos. `items` é utilizado nos três caminhos citados. Seria mudança de regra comercial, não redução neutra de payload. [Scoring:396](src/hooks/useFarmerScoring.ts:396) |
| **C5** | **CORTAR como formulado** | Os dois badges já recebem `enabled=false` enquanto os módulos estão congelados. Há consumo residual em outro caminho, detalhado abaixo. Além disso, trocar a mesma query compartilhada de lista para count quebraria seu contrato de cache. [AppShell:538](src/components/AppShell.tsx:538) |
| **C6** | **MOVER; separar RPC e cache** | Agregação no banco merece avaliação própria, sem carregar junto toda migração do hook. Os “60 mil” não estão demonstrados pelo código: a leitura filtra empresa e status. React Query ajuda reutilização, mas não elimina o primeiro drain. [Service:1094](src/services/financeiroService.ts:1094) |
| **C7** | **MOVER ↑, reformulando** | Telefonia está congelada, mas o provider só verifica `isStaff`. Respeitar o congelamento é uma correção pequena. Adiar até intenção de ligar, quando o módulo estiver ativo, interrompe recebimento passivo. [Provider:27](src/contexts/ConditionalWebRTCProvider.tsx:27), [manifesto:769](src/lib/modulos/manifesto.ts:769) |
| **C8** | **CORTAR** | Ausência de `useMemo`/`memo` não demonstra gargalo. O volume citado é pequeno; callbacks e props instáveis também podem neutralizar `memo`. Só retomaria diante de um perfil de renderização concreto. [SidebarSection:248](src/components/AppShell.tsx:248) |

Quanto às restrições, **não vejo violação automática por editar localmente uma edge grande ou paginar uma tela específica**:

- **A3:** configuração estática do runner existente é admissível. Classificador adaptativo, novo gate ou laboratório de testes lentos exigiria incidente. **C0/RUM permanente fica fora** sem incidente; inspeção pontual com DevTools não cria essa infraestrutura.
- **C3:** uma mudança localizada em `/sales` — a rota real de Pedidos — não reabre M-50. Generalizar para dezenas de hooks reabriria.
- **B2/B3/B9:** corrigir uma escrita dentro da função existente não reabre M-58. Aproveitar para decompor o monólito, sim.
- **Money-path:** B2 inclui também o CMC de `inventory_position`; **B9 inclui preço**, embora isso não esteja destacado na proposta. B3, C4 e C6 também exigem prova SQL executada e revisão. O mesmo vale para mudanças financeiras dentro de C2.
- **B4:** expurgo pontual cabe na exceção decidida; reconstruir a promoção tintométrica não cabe. Toda mudança de banco continua em migration nova, aplicada manualmente.

Esta revisão de desenho **não substitui a prova SQL** desses itens.

O risco de frescor em B2/B3/B9 está confirmado, não apenas sugerido pelos nomes das colunas:

| Dado | Consumidor existente |
|---|---|
| `fin_contas_receber.updated_at` | Saúde de recebíveis fica stale após **26 h**. |
| `inventory_position.synced_at` | Saúde do inventário fica stale após **3 h**. |
| `product_costs.updated_at` | Saúde de custos fica stale após **30 h**. |
| `omie_products.updated_at` | Saúde cadastral usa esse máximo, com limite de **30 h**. |

Esses quatro contratos aparecem na [última definição versionada de `_data_health_compute`](supabase/migrations/20261031191715_data_health_saldo_bancario_conta_a_conta.sql:116).

**B2 tem impacto além de alertas:** o cálculo de defasagem rejeita CMC sem confirmação recente, após 48 h. Um custo que permaneceu igual, mas foi confirmado hoje, não pode passar a significar “custo abandonado há três dias”. O timestamp também escolhe a posição mais recente entre fontes. [Regra de frescor:67](supabase/migrations/20261020233000_venda_cliente_repasse.sql:67), [seleção:292](supabase/migrations/20261020233000_venda_cliente_repasse.sql:292)

Portanto:

- Manter o timestamp em cada linha conserva parte importante das escritas; **não entrega automaticamente −92% de updates**.
- Substituir tudo por um heartbeat global perde a confirmação por produto. E `sync_state.status='complete'` sozinho não basta: o writer permite conclusão com erros parciais registrados. [Conclusão da execução:1728](supabase/functions/omie-analytics-sync/index.ts:1728)
- A comparação precisa preservar `NULL`, campos de autoridade e concorrência. Um SELECT seguido de decisão em JS não oferece, sozinho, a mesma garantia de uma comparação atômica no banco.

Em **B3**, a API documenta filtros de registro/alteração, mas isso não prova que toda baixa, estorno, cancelamento ou mudança de status por passagem do dia será capturada como você precisa. É necessário validar esse contrato. A janela deve permanecer fixa durante a paginação; o marco de sincronização só avança após conclusão íntegra por empresa. **Full semanal apenas com upsert não reconcilia exclusões**, e sete dias de atraso de correção não são uma propriedade aceitável por definição para crédito. [API oficial da Omie](https://api.omie.com.br/docs/apis/financas/contareceber)

Em **B1**, os dois supostos leitores citados não sustentam impedimento à retenção: `calculate-scores` **insere** os históricos; `missions.ts` menciona `priority_score_log` apenas em comentário. Não encontrei leitor operacional no escopo pesquisado. Falta confirmar funções/views efetivamente instaladas e o horizonte de auditoria desejado. [Writer:1112](supabase/functions/calculate-scores/index.ts:1112), [comentário:68](src/lib/visit-scoring/missions.ts:68)

Há três correções na conta de armazenamento de B1:

- Com expurgo mensal, corte em 30 dias permite acumular aproximadamente **30–61 dias** entre execuções.
- DELETE libera espaço para reutilização após vacuum; não promete redução imediata equivalente no arquivo ou na cobrança. [PostgreSQL: vacuum](https://www.postgresql.org/docs/17/routine-vacuuming.html)
- Não somar os 209 MB aos 807 MB sem saber se estes já incluem índices. Preservar os índices por data utilizados pelo expurgo.

Em **B4**, `tint_sync_runs` também guarda respostas de idempotência, e `tint_importacoes` é referenciada por fórmulas. O expurgo deve preservar referências e a janela de replay; não resolver bloqueios de FK com um `CASCADE` indiscriminado. [Idempotência:188](supabase/functions/tint-sync-agent/index.ts:188), [referência da fórmula:209](supabase/migrations/20260323134755_0b0a1b70-6b8d-411f-ae42-57ddaf1d693c.sql:209)

Em **C4**, restringir a janela pode remover exatamente clientes inativos que o score deveria recuperar. Mesmo entre clientes restantes, muda o intervalo médio entre compras e a população de normalização. Os itens alimentam diversidade no scoring e cestas nos motores de associação. Não há remoção neutra de `items` nesses três pontos. [Scoring:475](src/hooks/useFarmerScoring.ts:475), [cross-sell:649](src/hooks/useCrossSellEngine.ts:649), [bundle:524](src/hooks/useBundleEngine.ts:524)

Sobre agir sem RUM: **sim para desperdícios estruturais demonstrados; não para prometer ganhos em segundos ou percentuais de experiência.**

No artefato existente, medi `vendor-charts` com **433.211 bytes, 113.912 bytes gzip**. O conjunto adicional de imports estáticos da Home staff sobre o entry soma **169.010 bytes gzip**, aproximadamente 165 KiB. C1 se sustenta particularmente bem. Isso ainda não mede tempo percebido nem frequência de cache frio.

| Item | Verificação mínima antes de considerar concluído |
|---|---|
| **C1** | Novo build: `vendor-charts` sai do fecho de imports da Home sem gráficos; telas com gráficos continuam funcionando; o peso não reaparece inteiro em outro chunk compartilhado. Conferir Network numa navegação fria. |
| **C2** | Waterfall antes/depois, com mesma persona e cache: reduzir consultas dispensáveis e dependências sequenciais. Preservar cliente, staff, “Ver como” e estados de falha. `top orders → profiles` continua dependente; `Promise.all` não reduz quantidade de requests por si só. |
| **C3** | Abertura com conjunto limitado; busca encontra pedido além dos primeiros 5 mil; preserva nome, número, itens, acentos e valor. Conferir ordenação, seleção, detalhe e exclusão. Medir digitação/renderização antes de acrescentar virtualização. |
| **C7** | Congelado: não montar SIP, não pedir credenciais nem registrar ramal. Ativo: receber chamada antes de qualquer clique e completar primeira chamada de saída. A inicialização passiva está explícita no [contexto:181](src/contexts/WebRTCCallContext.tsx:181). |

`useDeferredValue` melhora prioridade de renderização; não reduz sozinho requests nem torna o trabalho pesado mais barato. [Documentação do React](https://react.dev/reference/react/useDeferredValue)

Também separar **bytes necessários para renderizar** de **bytes baixados pelo PWA depois**: o precache atual inclui os vendors. C1/C7 podem melhorar o caminho inicial sem reduzir igualmente o download total de instalação. [Vite:177](vite.config.ts:177)

Encontrei quatro melhorias adicionais com evidência:

1. **Governança dispara scoring que não utiliza.** `FarmerGovernance` consome apenas `{config}`, mas monta `useFarmerScoring`, cujo efeito baixa histórico e calcula a carteira. Ler apenas a configuração remove esse trabalho sem alterar scores nem extrair motor. O hook atual é somente de exibição: não estou atribuindo escritas a ele. [Página:35](src/pages/FarmerGovernance.tsx:35), [disparo:654](src/hooks/useFarmerScoring.ts:654)

2. **Falha de upsert de produtos pode terminar como sucesso.** `syncProducts` registra o erro, avança a página e pode devolver `complete`; a action responde `success:true`. Corrigiria esse caminho antes de B9. É robustez comprovável pelo código, sem alegar ocorrência observada na janela de produção. [Falha e avanço:508](supabase/functions/omie-vendas-sync/index.ts:508), [resposta:2734](supabase/functions/omie-vendas-sync/index.ts:2734)

3. **A zona Sistema ainda fabrica zero em erro.** As consultas ignoram `error` e atribuem `count ?? 0`; `try/catch` não captura o erro retornado normalmente pelo Supabase. Corrigir essas leituras tem benefício de robustez mais claro que C8. [Aprovações:42](src/hooks/dashboard/useSistemaZone.ts:42), [contagem:73](src/hooks/dashboard/useSistemaZone.ts:73)

4. **O congelamento não alcançou todos os consumidores.** Embora os badges estejam desligados, `useCriticaFila` chama SLA, rota e tarefas incondicionalmente, pela fila do Farmer. Esse é o consumidor real a revisar em lugar de C5: respeitar módulos congelados e preservar “indisponível”, sem transformar ausência em zero. [Hook:48](src/hooks/useCriticaFila.ts:48), [fila:89](src/components/fila/FilaDoDia.tsx:89)

Minha sequência de oito PRs seria esta. B0 pode ocorrer em paralelo, por consulta pontual do founder; o PR de índices depende do resultado.

| Ordem | Conteúdo de um PR |
|---|---|
| **1** | **A1:** custos recalibrados e timeout; conferir duração completa dos jobs, incluindo setup. |
| **2** | **A2:** heap e incremental por projeto, mantendo execução sob controle de memória. |
| **3** | **C1:** corrigir alocação dos helpers e verificar o fecho do build. |
| **4** | **C7 reformulado + resíduo da fila:** aplicar o congelamento existente aos consumidores ainda ativos. |
| **5** | **A3:** comando rápido explícito; execução canônica e CI continuam completos. |
| **6** | **C2 inicial + Governança:** remover leituras/cálculos que as telas não usam. Deixar consolidação de cargo e paralelização das zonas para escopos próprios. |
| **7** | **B5 + B6:** somente índices justificados por planos; migration nova, sem misturar expurgos. |
| **8** | **C3:** busca e paginação específicas de Pedidos, com acesso ao histórico. Virtualização entra depois apenas se restar gargalo. |

B1/B4 vêm depois como trabalho de retenção com benefício de capacidade. B2/B3/B9 ficam para propostas que preservem explicitamente frescor e autoridade dos dados. A correção do falso sucesso do catálogo deve preceder a otimização de suas escritas.

**RESUMO EM 10 LINHAS**

1. A1, A2 e C1 têm a melhor combinação de evidência, alcance e esforço.
2. A1 confirma 16 custos ausentes; os retries explicam 3,3 min/run, não seis.
3. A3 cabe como comando rápido explícito, preservando a execução completa.
4. Cortaria union no manifesto de provas e bypass do heavy por duração.
5. Contadores de scans não substituem identificação das consultas e seus planos.
6. B2/B3/B9 afetam frescor; B2 também altera validade do custo por produto.
7. B1 parece viável, mas retenção mensal de 30 dias acumula até cerca de 61.
8. C4 muda scores; C5 mira badges desligados; C7 deve respeitar o congelamento.
9. Governança recalcula sem usar, o catálogo pode falhar com sucesso e Sistema fabrica zero.
10. Verificação pontual basta para agir; ganhos em segundos continuam sem comprovação em campo.

