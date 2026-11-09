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
    `venda-sucessao-reprocesso` (1/min, SQL direto) e o FIM do gerador drenam; o reconcilio é GLOBAL (a lista de hoje
    inteira contra o cálculo efetivo, trocando só a linha que difere). A drenagem também DETECTA mudança de
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
`db/test-cliente-sucessao-plano.sh` (no núcleo do CI): 120 asserts e 38 sabotagens (inclui concorrência real em duas sessões: a drenagem com o gerador rodando, e cadastro + declaração DURANTE o cálculo da drenagem), todas vermelhas no assert declarado,
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

- **Trava longa para coerência troca um bug por outro** (Codex, rodada 3): segurar a trava do grafo durante o cálculo
  de 6–9 s fazia declarar/publicar esperarem e estourarem os 8 s do `authenticated`. Coerência OTIMISTA: o estado
  (assinatura + revisão de cada evento) e a lista saem do MESMO comando SQL (as funções STABLE usam o retrato do
  chamador), e o que mudar depois volta pela detecção. Prova: cálculo lento por stub e outra sessão mudando o estado
  no meio.

- **A assinatura tem de cobrir o que DECIDE de quem é a linha física, não só os extremos** (Codex, rodada 4): um alias
  que muda de dono troca o histórico herdado sem mexer em antigo/novo. E o escopo do reconcilio precisa lembrar o
  farmer da identidade ANTERIOR: quando a antiga muda de identidade, quem deixou de ser encerrada só recupera se o
  farmer dela entrar no reconcilio. Escopo guardado também falhava (rodada 5: o dono NOVO do alias, de outro farmer,
  ficava de fora). Raiz: recortar por farmer a partir de identidades que mudam. O cálculo já era global, então o
  reconcilio virou global (diff da lista inteira), e a assinatura usa PARES `alias>canônico`, não o conjunto.
- **Residual aceito (P2):** pedido sincronizado tarde com dia anterior ao corte muda a herança sem mudar a assinatura.
  É a mesma semântica do gerador factual (a lista do dia é retrato da manhã; o dia seguinte recalcula), e qualquer
  reconcilio do dia já o incorpora.

## Deploy
🟣 founder: a migration no SQL Editor (depois da `20261107013000`) → conferir com `db/validar-cliente-sucessao-plano.sql`
via `psql-ro` (12 ✅) → 🖱️ Publish (este PR não muda front; o Publish entra com o PR C).

**Em prod desde 2026-11-07.** #3701 mergeado às 15:11 UTC. Migration colada pelo founder e conferida pela sessão às
15:39 UTC via `psql-ro`: `db/validar-cliente-sucessao-plano.sql` deu 12/12 ✅ (`venda_gerar_lista` vivo com md5
`3b93a5e8…`; os 4 factuais com os corpos de antes). O cron `venda-sucessao-reprocesso` rodou `succeeded` às
15:39:00 com a fila vazia, porque prod ainda não tem declaração com plano. A migration, a prova e a validação na
`origin/main` são iguais às do PR, sem reversão do sync. O Publish fica para o PR C, porque este não muda o front.

# Entrega 3, PR C — a tela do plano e os consumidores (2026-11-08)

O pedido do founder foi "quero que façamos tudo dele": a tela do plano, a lista do vendedor, a ficha, o complemento de
mix e o sensor. A camada de dados é o PR B (#3701).

## O que mudou
- **Migration `20261108000000_cliente_sucessao_consumidores.sql`** (manual, no SQL Editor, depois da `20261107210000`).
  Segue o molde TRAVA → PRE (md5 do corpo VIVO, lido via `psql-ro`) → CREATE → PÓS.
  - **Recria `private._venda_sugestoes_json`**, o helper de `venda_minhas_sugestoes` e `get_venda_sugestoes_for`.
    As duas RPCs públicas não mudam.
    - O helper só ACRESCENTA chaves: por sugestão, `sucessao_origem`, `herdada_de` (os nomes das antigas) e
      `valor_ref_referencia_origem`; por comprador, `valor_ref_total_referencia_origem`.
  - **`public.venda_heranca_comprador(p_comprador)`**: o que o comprador herdou (`novo`) ou repassou (`antigo`) pelo
    plano VIGENTE.
    - Só entra declaração `ativa` em `vigentes(hoje SP)`, e cada item vai para a SUA declaração.
    - Devolve itens e datas, sem valor.
    - O gate é o do `venda_complemento_comprador`: staff + carteira.
  - **`public.cliente_sucessao_plano_itens(p_evento_id)`** (gestor/master), para a tela do plano. Devolve:
    - os destinos, com o estado;
    - os itens que a antiga comprou antes do corte, com nº de pedidos e última data, sem valor;
    - o sensor do dia: as sugestões de HOJE que herdam do evento e quantas já foram mostradas.
- **Tela do plano** (`RadarSucessaoPlano.tsx`): um sheet aberto pelo botão "Plano de rateio" no selo da sucessão,
  visível para gestor/master fora da lente.
  - Edita o destino item a item, com atalho por família. A família já vira itens no front, então o publicar recebe
    só itens explícitos.
  - Mostra o estado (sem plano, vigente com autor e data, revogado), o histórico das revisões, o destino pendente e o
    sensor do dia.
  - Publica com a revisão esperada LIDA. Revogar pede motivo.
  - As recusas viram aviso (`revisao_mudou`, `regra_conflitante` etc.) e a tela diz "as sugestões de hoje se
    atualizam em até 1 minuto".
  - Na lente "Ver como" é só leitura. As 3 RPCs de leitura entraram na allowlist do write-guard.
- **Consumidores do vendedor:**
  - **Fila** (`adapters/recompra.ts`): "· 1 herdado de DIVIMOVEIS (valor com preço da antiga)".
  - **Ficha**, que ganha três coisas:
    - o aviso "Herdou N itens de X (cisão, corte em …)";
    - o rótulo no item herdado do Recomprar, dizendo que o ritmo e o preço de referência são da antiga;
    - no Oferecer também, o rótulo "X já comprava esta família".
  - O "último preço" do item herdado segue "—", porque a nova não herda preço.
- **Sensor:**
  - `track('radar.sucessao_plano_{aberto,publicado,revogado,recusado}')`.
  - No ledger, `venda.ficha_aberta` ganhou `n_herdadas`, ao lado do denominador `n_sugestoes`. Não estende a allowlist
    quente do `analytics_ledger_registrar`.
  - A publicação já é durável em `cliente_sucessao_plano_revisoes`, com autor e data.
- **Não muda:** o `venda_complemento_comprador` (o rótulo é cruzado no front com a herança) e o `venda_painel`. O
  sensor por evento vive na tela do plano; levá-lo ao painel agregado só vale depois de haver plano publicado em
  prod.

## Prova
`db/test-cliente-sucessao-consumidores.sh`, no núcleo do CI. Monta o mesmo schema da prova do PR B: o snapshot e a
cadeia viva, que pega o PR B e esta migration.
- São 38 asserts e 22 sabotagens. Todas ficam vermelhas no assert declarado, com controle verde na mesma invocação.
- Invariância forte: com herança no ar, o JSON novo sem as chaves novas é IGUAL ao do corpo anterior. O corpo anterior
  é recriado verbatim da migration de 21/10, com md5 conferido contra o de prod.
- Paridade dos itens da tela com `venda_linhas_pedido(corte)` da antiga: universo, alias e corte.
- `db/validar-cliente-sucessao-consumidores.sql`: 6 ✅, exercitada pela prova.

## Lições
- **"Herdou" é o que a trilha TRANSFERE, não o que o plano DIZ** (Codex `-r max`, P2; veredito "aprovar com P2", sem
  P0/P1). O publicar aceita regra explícita de SKU que a antiga nunca comprou, e a ficha diria "herdou" sem herança.
  A leitura para o vendedor exige compra da antiga antes do corte, o mesmo critério da trilha. Os outros dois P2
  eram de UI:
  - o destino revogado sumia do seletor, mas seguia no payload; agora aparece como "(saiu da sucessão)" e trava a
    publicação;
  - a cadência mostrada é a factual da nova, então o rótulo virou "o histórico inclui compras da antiga".
- **A camada que fica verde na sabotagem é redundante, e vale dizer qual.** Tirar o `NOT rev.revoga` da herança não
  mudou nada: a revisão que revoga não tem regra, por causa do trigger do PR B. O que discrimina é ler a revisão
  VIGENTE, e a sabotagem passou a ler a menor.
- **Mexer num helper puxa a cadeia inteira das migrations dele para a prova.** A pós-condição da 20261021070000
  executa a RPC como um master de `user_roles`, então o `cv_antes_da_cadeia` semeia um master só da cadeia.
- **Cálculo de histórico dentro de RPC do app: recorte pelo cadastro, com o mesmo predicado.** A trilha
  (`venda_linhas_pedido`) não é inlinável, porque tem `SET search_path`. A varredura do universo levou 3,25 s em
  prod, perto do teto de 8 s. A tela recorta por `customer_user_id = ANY(cadastros)` e mantém o MESMO `COALESCE` do
  comprador, com a paridade provada.

## Deploy
🟣 founder: a migration no SQL Editor (depois da `20261107210000`) → conferir com
`db/validar-cliente-sucessao-consumidores.sql` via `psql-ro` (6 ✅) → 🖱️ Publish. O front degrada sem a migration:
sem as chaves novas, a lista lê tudo como "própria", e a herança da ficha só avisa quando há item herdado.

**Em prod desde 2026-11-07.** A migration foi colada pelo founder antes do merge e conferida pela sessão via
`psql-ro`: `db/validar-cliente-sucessao-consumidores.sql` deu 6/6 ✅ (helper com md5 `6e26a836…`, as RPCs da
lista com os corpos de antes, as 2 novas STABLE + DEFINER com anon e PUBLIC fechados). O #3709 mergeou às
22:48:35 UTC (`41f575309`), e a migration na `origin/main` é byte a byte a do PR (md5 igual), sem reversão do
sync. O 1º Publish saiu ~1 min depois do merge e publicou o commit ANTERIOR (`6eed3725`): o Lovable ainda tinha
o merge como edição `pending`. O build seguinte (entry `index-DfaoeAPM`) foi verificado pelos bytes:
`verify-frontend.sh --pai 6eed37254 --novo 41f575309 'radar-abrir-plano'` deu exit 0, com o alvo em
`RadarClientes-Bg8QHo4G.js`, o controle negativo ok e 392 chunks varridos. Esse build carimba `__BUILD_SHA__`
como `dev`, por isso a prova foi pelo conteúdo e não pelo `monitor-deploy.sh --pr`. Lição: **Publish logo
depois do merge pode publicar a main de antes**; confira o `ar=` do monitor (ou o conteúdo) antes de dar por
feito.

# Entrega 3, painel de gestão — a parte herdada no `venda_painel` (2026-11-07)

Migration `20261108010000_venda_painel_heranca.sql`. Prova: `db/test-venda-painel-heranca.sh`. Validação:
`db/validar-venda-painel-heranca.sql`.

## O que mudou
- `public.venda_painel` recriado do corpo vivo (md5 `78d9e58f…`, o da 20261020235000). Cada linha farmer × semana
  ganhou seis chaves e nenhuma das antigas mudou:
  - `herdadas`: compradores distintos, sugestões, desfechos de recompra, receita casada e receita incompleta. São
    as mesmas réguas da linha, só que restritas a `sucessao_origem IS NOT NULL`. A constraint
    `venda_sugestao_sucessao_origem_ck` (validada em prod) só aceita NULL ou array não vazio, então o `IS NOT NULL`
    separa exatamente a herdada.
  - `taxa_ativa_propria`: a conversão sem as herdadas, calculada por diferença e NULL com denominador 0. O
    histórico de uma herdada inclui compras da antiga.
  - `base_historico_propria`/`taxa_base_historico_propria` e `base_sombra_propria`/`taxa_base_sombra_propria`: a
    linha de base com a mesma régua. O gerador grava a origem nas três fases, então a base de sempre também mistura:
    a conversão própria se compara com a base própria.
- Tela (`TabelaAdocao`): o aviso aparece quando o farmer tem herdadas. Sob cada número, quantos clientes são
  herdados, a receita herdada, a conversão "própria" e a base "própria" (do ano anterior e da sombra). Servidor
  sem a migration (sem nenhuma das seis chaves) mantém a tela de antes. Parte das chaves, ou forma errada, lança
  erro.

## Por que agora, sem sinal
O roadmap deixava este passo esperando o 1º plano publicado em prod, pela regra "fase N+1 exige sinal". No dia,
prod tinha 0 sucessões, 0 revisões de plano e 0 sugestões herdadas. O founder decidiu fazer assim mesmo. O
painel nasce mostrando zero herdadas: a fatia só aparece quando houver sugestão herdada.

## Prova
16 asserts, verde em `LC_ALL=C` e em `pt_BR.UTF-8`, e 10 de 10 sabotagens vermelhas nos dois locales, cada uma no
seu assert. O M5 prova que uma PÓS que falha desfaz o CREATE (`psql -1`, como o SQL Editor). O M0 prende que o corpo anterior do repo é o de prod. O H0 prende a invariância: tirando as duas
chaves, o JSON é o do corpo anterior com os mesmos dados. O M4 roda o validar contra a migration real (4 ✅).
Lição do arnês: a PÓS confere o md5 do corpo, então a sabotagem tem de recalcular o md5 esperado. Sem isso, as 6
sabotagens de corpo morriam no catálogo e nunca chegavam aos asserts. Apareceu no 1º `--falsificar`, com 6
"vermelha, mas NÃO no assert esperado".

## Lição (Codex, P2)
**A linha de base tem a mesma mistura que a taxa.** A 1ª versão tirava as herdadas só da conversão ativa, e a
tela mandava comparar essa conversão "própria" com a linha de base. Só que o gerador grava a origem também nas
fases `historico` e `sombra`. Exemplo do Codex: base com 1 sucesso e 1 fracasso próprios e 9 sucessos herdados
dá 91%; contra uma conversão própria de 50%, a tela sugeriria queda onde não houve. Separar uma fatia vale para
o numerador **e** para cada régua com que ele é comparado. O Codex também apontou duas lacunas na prova: a linha
ativa só herdada (denominador próprio 0, testado antes só com linha ausente) e o rollback da PÓS. Viraram H4b,
com sabotagem do `NULLIF`, e M5. Na 2ª rodada (também "aprovar com P2", sem P1) sobrou o mesmo erro um nível acima: a tela só
mostrava as bases próprias quando havia herdada **ativa**. Com herança só no histórico ou na sombra, a comparação
voltava a ser 50% × 91%. Agora a fatia aparece com herdada em qualquer régua (a base própria difere da total), e o
cenário dele virou teste de tela. Esse último ajuste de tela não passou por uma 3ª rodada do Codex.

## Deploy
🟣 founder: a migration no SQL Editor, depois conferir `db/validar-venda-painel-heranca.sql` via `psql-ro` (4 ✅).
Depois, 🖱️ Publish, só quando o Lovable já tiver o merge como edição `completed`.

**Em prod desde 2026-11-08.** A migration foi colada pelo founder antes do merge e conferida pela sessão via
`psql-ro`: `db/validar-venda-painel-heranca.sql` deu 4/4 ✅ (corpo md5 `2b3f2c1b…`, STABLE DEFINER com o gate
master, ACL igual ao de antes). O #3714 mergeou às 00:44:21 UTC (`6bcbb888`), e a migration na `origin/main` é
idêntica à do merge (md5 igual), sem reversão. O 1º Publish saiu ~1 min depois do merge e voltou a pegar o
commit anterior (`db9c900f`), com a edição ainda `pending` no Lovable: é a mesma armadilha do PR C, agora vista
duas vezes no mesmo dia. O Publish seguinte, com a edição já `completed`, foi provado de duas formas:
`monitor-deploy.sh --pr 3714` deu `PR_NO_AR` (o ar carimba `6bcbb888`), e
`verify-frontend.sh --pai 6bcbb888b^ 'painel-base-sombra-propria'` deu exit 0, com o alvo em
`VendaClientePainel-YJVvrdGY.js`, o controle negativo ok e 395 chunks varridos.
