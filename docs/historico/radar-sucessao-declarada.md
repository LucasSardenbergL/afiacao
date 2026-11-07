# Radar: sucessão/cisão DECLARADA entre clientes (2026-11-07)

**Pedido do founder**, na ficha de MARQUES PLANEJADOS LTDA (CNPJ 69491768000101, aberta em 06/10/2026): os sócios
são filhos do dono do cliente DIVIMOVEIS (03166577000166, ativo). É uma CISÃO: a antiga segue. Entrega 2 de 3 (a 1 é
o "atribuir lead", #3684; a 3 é o rateio do histórico de compras). Desenho revisado pelo Codex `-r max` (9 P1, nenhum
P0) e aprovado pelo founder em 2026-11-06.

## O que mudou
- **Migration `20261107013000_cliente_sucessoes.sql`** (manual, no SQL Editor):
  - `public.cliente_sucessoes`: o fato DIRIGIDO (antigo → novo, CNPJ completo), tipo `cisao`|`sucessao`, data de corte
    COMERCIAL (a abertura na Receita fica em `data_corte_sugerida`), autor. 1 antiga → N novas no mesmo `evento_id`
    (1 evento ativo por antiga, com o mesmo tipo e o mesmo corte). Sem DELETE/TRUNCATE (trigger) e o único UPDATE é a
    revogação, com quem/quando/por quê (motivo obrigatório também no trigger). RLS ligada e fechada ao JWT; o
    `service_role` só LÊ. INSERT/UPDATE só com a "porta" que as RPCs abrem na própria transação, então nem o SQL
    Editor escreve por fora do protocolo.
  - `private.cliente_sucessoes_grafo`: versão otimista do grafo. Toda escrita pega a MESMA advisory lock antes de
    validar, confere a versão e a incrementa.
  - `private.cliente_resolver_documento`: CNPJ → 1 identidade canônica (`profiles` + `customer_canonical_alias`);
    0 = não é cliente, >1 = ambíguo; candidato sem profile, ou que é ele próprio alias ativo, conta como
    `invalidos` e não resolve.
  - `private.cliente_sucessoes_vigentes(hoje)`: `ativa` só com os dois extremos inequívocos, distintos, o novo
    cadastrado e o corte alcançado. Senão `declarada` com o impedimento. **A entrega 3 herda só daqui.** A leitura
    REVALIDA o grafo por identidade (cadeia, par duplicado, evento divergente): uma mudança de alias depois da
    declaração deixa as linhas envolvidas `declarada`, sem herança.
  - RPCs `cliente_declarar_sucessao` / `cliente_revogar_sucessao` / `cliente_sucessao_previa` (gestor/master) e
    `cliente_sucessoes_do_documento` (o selo; Radar ou gestor). A prévia mostra contagens e datas dos pedidos dos dois
    lados do corte, **sem valor**, com o mesmo universo e o mesmo dia de `private.venda_linhas_pedido`.
  - Recusa cadeia e ciclo (A→B→C, B→A), dois documentos do mesmo comprador e CNPJ ambíguo. O grafo é de
    COMPRADORES: cadeia, par já declarado e evento único comparam a identidade canônica dos extremos, não o CNPJ.
  - A prévia só conta pedido com item que conta (produto Omie e quantidade > 0), como `venda_linhas_pedido`.
- **Ficha** (`RadarSucessaoLead.tsx`, na linha "Já é cliente?"): selo "Cisão confirmada de X" separado das pistas
  automáticas, que ganham "Confirmar sucessão" em 1 clique para gestor/master. A declaração mostra a prévia antes de
  confirmar e não aparece na lente "Ver como". O selo não depende de `ja_cliente` e segue depois do cadastro no Omie.
- **Não muda:** `ja_cliente`, `radar_recruzar_ja_cliente`, pedidos, histórico, preço, repasse, margem e crédito.

## Prova
`db/test-cliente-sucessoes.sh` (no núcleo do CI): 85 asserts e 35 sabotagens, todas vermelhas no assert declarado,
com controle verde na mesma invocação. Inclui concorrência REAL (duas sessões, W1→W2 × W2→W1). A prontidão da 2ª
sessão é medida pela sessão (já no `pg_sleep`), não pela trava, senão a sabotagem `sem_trava` ficaria verde. Também
prova o dia do pedido no fuso de SP com a sessão em UTC.

## Lição
- **O sinal de prontidão de um teste de concorrência não pode ser a própria trava sob teste.** Na 1ª rodada a 2ª
  sessão esperava `pg_locks` mostrar a advisory lock. Sem a trava (sabotagem), ela esperava o timeout, rodava depois do
  COMMIT e a prova seguia verde. Agora a espera é pelo `pg_stat_activity` da 1ª sessão.
- **Versão otimista fixa no teste vira cascata na falsificação.** Uma sabotagem que deixa passar 1 escrita bumpa a
  versão, e os asserts seguintes, com versão literal, ficam vermelhos por `versao_mudou`, não pelo que medem. Só o
  assert que prova a versão usa número fixo; os demais leem a versão corrente.

- **Validar o grafo pelo CNPJ deixa passar a cadeia pelo alias** (Codex, P1). Dois CNPJs do mesmo comprador
  davam DX→ANT e MESMO→NOV2 "sem cadeia", que viram UX→UA→UN2 para quem herda. Regra de grafo sobre entidades
  resolvidas compara a identidade resolvida, na escrita E na leitura, porque o cadastro muda depois.
- **CHECK com `length(btrim(x)) > 0` aceita `x` NULL** (NULL satisfaz CHECK). A obrigatoriedade precisa de
  `IS NOT NULL` explícito.
- **Assert de "sem preço" que olha só as chaves do 1º nível não prova nada**: o vazamento cabe num objeto aninhado.
  Agora a prova percorre toda chave, em todo nível (`jsonb_path_query '$.**'`), contra a lista do contrato.

## Deploy
🟣 founder: a migration no SQL Editor (depois da `20261106221000` do #3684) → 🖱️ Publish.

# Entrega 3, PR B — o plano de rateio e a trilha efetiva (2026-11-07)

Desenho aprovado pelo founder ("Aprovo o desenho") depois do Codex `-r max` (9 P1, nenhum P0). Esta é a camada de
DADOS; o painel e os consumidores da lista/ficha/complemento são o PR C.

## O que mudou
- **Migration `20261107210000_cliente_sucessao_plano_rateio.sql`** (manual, no SQL Editor, depois da `20261107013000`):
  - **Plano versionado**: `public.cliente_sucessao_plano_revisoes` (revisão IMUTÁVEL por evento da antiga; a vigente é a
    maior; revogar = revisão nova `revoga`, sem regras) e `public.cliente_sucessao_plano_regras` (ITEM INTEIRO
    (empresa, omie_codigo_produto) → uma declaração do MESMO evento). Família expandida em itens na publicação, só nos
    itens que a antiga comprou ANTES do corte. Item sem regra fica com a antiga; destino `declarada` ou revogado volta à
    origem, sem renormalizar. Sem UPDATE/DELETE/TRUNCATE (trigger) e INSERT só pela porta das RPCs.
  - **`private.historico_consumo_efetivo(p_ate)`**: trilha SEPARADA de `venda_linhas_pedido` (que não muda), mesmo
    universo e dia, com `order_item_id`. Herda só de `vigentes(hoje SP)` `ativa`, linha com dia < corte e visão a partir
    do corte. A nova não herda preço: o líquido é o físico, NULL preservado, `herdada` = referência da origem.
  - **Espelhos ao vivo**: `venda_recompra_efetiva_em`, `venda_situacao_efetiva_em`, `venda_lista_calc_efetiva`. A antiga de
    uma `sucessao` (não cisão) sai da recompra e da situação a partir do corte (`historico_compradores_encerrados`).
  - **`venda_gerar_lista`** (recriado do corpo vivo, TRAVA→PRE→CREATE→PÓS) gera a recompra da lista efetiva e marca
    `venda_sugestao.sucessao_origem` ([{evento_id, revisao}]) e `valor_ref_referencia_origem`.
  - **Invalidação**: publicar/revogar ENFILEIRA o reprocesso (`private.venda_sugestoes_reprocesso_fila`); o cron
    `venda-sucessao-reprocesso` (1/min, SQL direto) e o FIM do gerador drenam. A drenagem também DETECTA mudança de
    estado fora do plano (declaração revogada, alias, cadastro, corte) pela assinatura de `vigentes` + revisão por
    evento (`private.cliente_sucessao_assinaturas` × `private.cliente_sucessao_estado_visto`). Reprocessa o pedido mais
    novo por evento e grava a revisão APLICADA. Por farmer afetado (o ranking "maior atraso" é por farmer):
    sai só a sugestão de HOJE que mudou, nunca mostrada e sem desfecho, para `public.venda_sugestao_substituida` (linha
    inteira, imutável); a substituta entra. `mostrada_em`, `venda_contato` e desfecho ficam.
  - RPCs (gestor/master): `cliente_sucessao_plano_publicar`, `cliente_sucessao_plano_revogar`,
    `cliente_sucessao_plano_do_evento`. RLS ligada nas 4 tabelas novas, REVOKE de PUBLIC e anon.
- **Não muda (provado antes = depois)**: `venda_linhas_pedido`, `venda_recompra_em`, `venda_situacao_em`,
  `venda_lista_calc`, `venda_lista_preco`, `_venda_repasse_base`, `venda_repasse_candidatos`, a TABELA `venda_recompra`
  (o repasse lê a tabela; a herança entra só pelo cálculo ao vivo). Margem/DRE, métricas, crédito, reposição: nenhum
  objeto deles é recriado.

## Prova
`db/test-cliente-sucessao-plano.sh` (no núcleo do CI): 105 asserts e 31 sabotagens, todas vermelhas no assert declarado,
com controle verde na mesma invocação. Monta o schema com `corpo-vivo.sh` (a cadeia dinâmica pega o gerador de venda, a
entrega 2 e esta). Validação do founder: `db/validar-cliente-sucessao-plano.sql` (12 ✅, exercitada pela prova).

## Lições
- **Cálculo pesado dentro de RPC do app morre no `statement_timeout=8s` do `authenticated`** (medido em prod:
  `pg_roles.rolconfig`). O reprocesso é o mesmo cálculo do cron do gerador (6–9 s em `cron.job_run_details`); dentro da
  publicação ele reverteria a transação inteira. Restringir ao farmer não barateia (o maior tem 12.694 clientes na
  carteira). Fila na mesma transação + cron SQL-direto drenando como `postgres`.
- **`{a,b}` dentro de `"$(…)"` sofre brace expansion no bash**, e o JSON de regra virou três argumentos. As chaves do
  JSON da prova saem de `printf` (dado), nunca do texto do script.
- **Controle verde de sabotagem tem de ser um assert que a sabotagem NÃO toca.** Tirar o corte da trilha também move a
  linha do dia do corte, então o "13 linhas herdadas" ficou vermelho junto. O controle passou a ser o destino pendente.

- **Invalidar só pelas RPCs do plano deixa de fora quem muda o estado por outro caminho** (Codex, P1): revogar a
  declaração-destino, trocar alias, cadastrar o novo e o corte que chega mudam a herança sem passar pela publicação.
  O gatilho certo é o ESTADO de que a trilha depende (assinatura), não a porta por onde a mudança costuma entrar.
- **Prova de invariância que recalcula o snapshot antes de comparar restaura a adulteração** (Codex, P1): a assinatura
  só LÊ; o recálculo vira um assert à parte (I1b), e a sabotagem que apaga a tabela tem de ficar vermelha no I1.

## Deploy
🟣 founder: a migration no SQL Editor (depois da `20261107013000`) → conferir com `db/validar-cliente-sucessao-plano.sql`
via `psql-ro` (12 ✅) → 🖱️ Publish (este PR não muda front; o Publish entra com o PR C).
