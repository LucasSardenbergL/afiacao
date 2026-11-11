# Importar pedido digitado direto no portal Sayerlack → PO no Omie (2026-10-14)

**Pedido do founder:** às vezes ele digita o pedido direto no portal Sayerlack. Quer informar só o número no app e o
sistema buscar o pedido no portal e criar o pedido de compra no Omie "como já faz". Decisões dele: **direto, sem
tela de conferência** (o caminho até o Omie é o mesmo do disparo automático); **bloquear e mostrar** quando algo não
bate; importar **qualquer situação** do portal.

## Como ficou

- Tela **Gerir pedidos** → botão **Importar do portal** → nº do pedido → resultado (itens, PO Omie ou motivo).
- Edge `sayerlack-importar-pedido-portal` (Browserless, **só leitura no portal**): Consulta Pedidos (`/order-viewer`,
  pelo menu) → cliente `SAYERLACK_PORTAL_CLIENTE_CODIGO` → nº início = fim → Filtrar → lê a linha; itens por
  `GET /order-creation/busca-itens-pedido/<nº>` (JSON posicional). Se vier vazio, carrega a página de detalhe
  (`/order-creation-form-edit/<nº>/route/order-viewer` — é tela de EDIÇÃO: só GET, nenhum clique) e lê de novo.
  Diálogo nativo é sempre recusado. Filtro **Exibir = Pedido** (proposta não é pedido efetivado); situação
  qualquer (decisão do founder), mas tem de vir legível.
- `leitura.ts` PROVA a semântica posicional (inferida de 1 amostra) a cada pedido: qtd fat = cap × qtd UN;
  Preço Venda = Preço UN × qtd UN × (1 − desc); Σ Preço Venda = Vlr Mercadoria da consulta; coluna "Pedido" casada
  EXATA (o prefixo pegaria "Pedido Cliente"); cliente tem de ser a OBEN.
- RPC `sayerlack_importar_pedido_portal` (migration `20261014120000`): de-para INVERSO (`sku_fornecedor_externo`
  OBEN ativo, exatamente 1 por sku_portal; qtde Omie = qtde portal ÷ fator, inteira), pedido em
  `aprovado_aguardando_disparo` + `sucesso_portal` + protocolo + `importado_portal_em/_por`, e — na MESMA transação —
  `sayerlack_aplicar_custo_portal` com o **Vlr Total** do portal como prova externa (IPI por NCM). Recusa =
  SQLSTATE IP001–IP006/CP00x e nada gravado. **IP006**: já existe PO OBEN no espelho `purchase_orders_tracking`
  com este nº em `numero_contrato_fornecedor` (210 POs Sayerlack foram lançados direto no Omie assim) — sem isso,
  importar criaria um 2º PO com outra chave `AFI-<id>`. Limite: a defasagem do sync do espelho. Idempotente por protocolo (advisory lock + UNIQUE parcial novo).
- PO pelo `disparar-pedidos-aprovados` de sempre (protocolo ⇒ already_sent). **v1.9:** pedido com protocolo não é
  mais dividido em lotes de 20 (o filho sem protocolo reabriria envio ao portal = pedido duplicado no fornecedor).

## Números do spike (pedido real 2140603)

`[10,"DFA.4080LT","","L",18,288,16,19.8637,357.5466,357.5466,5,"14,9488",4865.5584,"DILUENTE PU 4080A LT",…]` —
consulta: Vlr Mercadoria 4.865,56 · Vlr Total 5.181,82 = 4.865,56 + IPI 6,5% (316,26). Preço no PO: 323,86375/LT.

## 2ª opinião (Codex, high, 2026-10-14)

2 P1, 0 P0 — ambos corrigidos: proposta/situação ausente viravam PO (filtro Exibir=Pedido + situação
obrigatória); PO lançado direto no Omie com o mesmo contrato ganhava um 2º PO (IP006). Authz/rollback da RPC e
o desvio do split: sem achado.

## Sensor

O ledger é a própria coluna: `SELECT count(*) FROM pedido_compra_sugerido WHERE importado_portal_em IS NOT NULL`
(denominador: pedidos Sayerlack com protocolo no mesmo período). PostHog `reposicao.importar_portal` (tom).

## Provas

`db/test-sayerlack-importar-pedido-portal.sh` (49 asserts, 2 locales, 8 falsificações, no núcleo do CI) ·
`leitura_test.ts` (12, Deno) · `importar-portal.test.ts` (vitest).

## Deploy — banco (2026-10-14)

Migration `20261014120000` aplicada pela sessão via `db:aplicar` após o merge do #3075: ensaio (rollback) ok →
apply = tentativa **#449** com recibo (sha256 `658bf9f2…`). 2ª testemunha por `psql-ro`: função, índice UNIQUE
válido, colunas e ACL (anon/authenticated sem EXECUTE, service_role com) ✅; `md5(prosrc)` = md5 do corpo do arquivo
(`e7294d18…`). Carimbo de authz re-medido: os 6 audits de prod exit 0 (o achado `FUNCAO_AUSENTE_EM_PROD` sumiu).
Pendente: edges (`disparar-pedidos-aprovados` v1.9 ANTES de `sayerlack-importar-pedido-portal`) e Publish.

## Deploy e 1º uso real (2026-10-15/16)

- **Edges em ondas**: `disparar-pedidos-aprovados` v1.9 → `sayerlack-importar-pedido-portal`. A ferramenta não emitia
  onda de edge NOVA com ordem (pelo nome retinha; pelo ledger ignorava `NUNCA_ATESTADA`) → #3085. O bloco do Lovable
  só vale colado NA HORA: o `sonda-fingerprints.ts` muda a cada PR que toca edge (2 recusas por hash) e a prova da
  predecessora vence em 6 h (re-sonda via `db:aplicar`; o SQL da sonda sai byte-igual → linha de comentário própria,
  senão "já aplicado").
- **1º uso (2141068) — leitura**: "0 linha(s) lida(s)" com o pedido existindo. A edge clicava em Filtrar antes de o
  portal ligar jQuery/DataTables → v1.1 (#3101) espera `table.dataTable` e a RESPOSTA do `POST /order-viewer/form/list`.
- **1º uso — gravação**: "UPDATE requires a WHERE clause". O Supabase carrega o **pg-safeupdate** nas sessões da API;
  a RPC tinha 2 UPDATE sem WHERE em tabela temporária, e o PG17 local NÃO carrega a extensão → a prova não pega.
  Migration `20261016013000` (#3102) + postcondição/assert que reprova UPDATE sem WHERE (regex com `\m`: sem fronteira,
  o comentário "safeupdate" dava falso positivo). Tudo-ou-nada segurou: nada gravado.
- **Resultado**: pedido #3644 → **PO 1291** no Omie; 10 × DFA.4080LT, R$ 304,097 + IPI 6,5% = R$ 323,863/un,
  total R$ 3.238,63 = Vlr Total do portal (provado).

## 2026-10-16 — cancelado recusado (#3105) e varredura automática (cron)

Palavras do founder: "não precisa pegar pedidos cancelados" e "quero que exista um cron às 12:30, 17:30 e 22:30 que,
caso algum pedido esteja lançado no portal da Sayerlack e não exista no Omie, ele seja lançado no Omie".

- **Cancelado** (#3105, importar v1.2): `leitura.ts` recusa a situação `6 - Cancelado` (motivo `pedido_cancelado`).
  O filtro do portal segue `todos`: o cancelado é LIDO e recusado, para a tela dizer "cancelado", não "não encontrado".
- **Varredura** (edge nova `sayerlack-varrer-pedidos-portal` v1.0 + migration `20261016150000`): job
  `30 1,15,20 * * *` UTC (= 22:30/12:30/17:30 SP), modo `importar`. Lê a Consulta Pedidos (OBEN, Exibir = Pedido,
  emissão dos últimos 7 dias, todas as páginas) e chama a edge de importar — o MESMO caminho do botão — para cada
  pedido sem `portal_protocolo` no app e sem contrato no espelho do Omie. Decisões do founder (money-path):
  - corrida com envio do próprio app: pedido OBEN em `enviando_portal` / `aceito_portal_sem_protocolo` /
    `indeterminado_requer_conciliacao` ⇒ a rodada não importa, e reconfere antes de cada importação. A trava fecha
    porque o envio grava estado e protocolo no MESMO UPDATE. A consulta do portal só tem DATA de emissão (sem hora):
    carência em minutos não é possível;
  - janela de 7 dias, sem cancelados e sem faturados: a situação importável é **lista fechada** de códigos
    (`SITUACOES_IMPORTAVEIS`, vazia na partida = só relata, inclusive o `<select id="situacao">` real); há POs
    Sayerlack no Omie sem nº de contrato (vindos de NF), e um faturado viraria PO em dobro;
  - falha ⇒ `sayerlack_varredura_falha` + e-mail 1 vez por protocolo; `<UltimaExecucao acao="reposicao.varrer_portal_sayerlack">`
    em Gerir pedidos.
- **IPI — alíquota no PO**: a API do Omie (IncluirPedCompra, `produtos_incluir`/`produtos_alterar`/`produtos_consulta`)
  **não tem campo de alíquota**, só `nValorIpi` (que já vai). O `raw_data` do PO 1291 (ConsultarPedCompra) confirma: 29
  chaves por item, nenhuma de alíquota. O campo que o founder vê na tela do Omie não é exposto pela API.

## 2026-10-17 — 1ª rodada real e lista fechada ligada (varredura v1.1)

- **1ª rodada real** (modo listar, disparo manual em 16/10 23:26 SP; o cron de sábado 12:30 cai no portal fechado):
  22 pedidos lidos em 1 página — 15 no app, 5 no Omie, 1 cancelado (2140501), 1 fora (2140762, "1 - Aberto").
  Select real do portal: 1 Aberto · 2 Atendido Parcial · 3 Atendido Total · 4 Pendentes · 5 Suspenso · 6 Cancelado ·
  7 Fatur Balcão.
- **Founder**: "aberto + suspenso + atendido total ou parcial caso as respectivas NF dos pedidos não tenham sido
  lançadas ainda no Omie"; Pendentes desconhecido → fora.
- **Codex (2 rodadas, 0 P0)** mostrou que o espelho NÃO prova "NF não lançada": NF com 2 pedidos casada só com um não
  deixa órfã do outro (`omie-sync-nfes-recebidas` só cria órfã quando NENHUM pedido casa); NF que o sync não leu some.
  Decisão do founder: o cron importa sozinho só **1 Aberto e 5 Suspenso**; **2/3 Atendido** sem PO viram e-mail
  (1 vez por pedido, `sayerlack_varredura_falha`) para conferir no Omie e usar "Importar do portal".
- **Carência de 1 rodada** (founder, contra PO lançado à mão no Omie: 8 de 21 em outubro): só importa o pedido já
  visto numa rodada de IMPORTAR anterior (`sayerlack_varredura_visto`, migration `20261017120000`, só INSERT) E com
  `sync_state(pedidos_compra, oben)` `complete` terminado > vista + 5 min. Risco residual registrado pelo Codex: PO
  manual criado DEPOIS desse sync e antes da rodada seguinte ainda escapa (o espelho é a única fonte; sem consulta ao
  vivo no Omie). Não usar `status` do tracking para NF: o sync de PO reescreve `FATURADO` com `CRIADO`.
- **Contrato composto** "1998739/1998740" (15 POs em prod) passou a contar os dois protocolos na varredura. A RPC
  (IP006, `btrim(contrato) = protocolo`) ainda compara inteiro — o filtro da varredura é quem pega.

## 2026-10-19/21 — 1ª semana do cron em produção (varredura v1.2)

- **Fim de semana** (17/10 12:30 → 18/10 22:30): 6 rodadas puladas por portal fechado, registro `sucesso`.
- **19/10 12:30**: 23 lidos — 16 no app, 5 no Omie, 1 cancelado (2140501), **2140762 em `carencia_primeira_vista`**
  (vista gravada às 15:30:17 UTC). Nada importado — a carência funcionou.
- **19/10 17:30 e 22:30**: carência vencida, o cron chamou a importadora e ela **recusou** (tudo-ou-nada, "nada
  gravado"): NCM 32091020 sem alíquota de IPI conhecida. Rodadas com `erro`, `sayerlack_varredura_falha` com 2
  tentativas e **1 e-mail** (`notificado_em` = 1ª falha) — fail-closed como desenhado, nenhum PO pela metade.
- **19/10 22:36**: pedido entrou **fora do cron** (sem execução registrada; botão "Importar do portal") →
  `pedido_compra_sugerido` #3752, PO Omie **1298** (R$ 954,64), espelho com `numero_contrato_fornecedor = 2140762`
  numa linha só (sem 2º PO).
- **20/10 12:30 em diante**: 2140762 em `ja_no_app`, falha marcada `resolvido_em` pela própria rodada; 20/10 17:30 e
  22:30 sem candidatos (`importados: []`, `falhas: []`).
- **Lição**: o 1º pedido "novo" do portal travou na alíquota de IPI do NCM, não na varredura — NCM novo de item
  Sayerlack ainda depende de cadastro manual; o e-mail é o aviso.
- **21/10 22:30 — 1ª importação 100% pelo cron**: 2142771 (visto, carência cumprida, sync `complete` depois) →
  PO Omie **1306**, espelho com uma linha só para o contrato. De 21/10 a 05/11: 49 rodadas `sucesso`, 0 `erro`, 0
  falha nova em `sayerlack_varredura_falha`.

## Revisão Fable + Codex (2026-11)

Os dois revisores, separados, chegaram aos mesmos P1 (nenhum P0). O que mudou:

- **Contrato composto** ("1998739/1998740", 15 POs em prod): o IP006 do botão comparava o contrato inteiro e criava
  2º PO; agora compara cada número (o cron já fazia).
- **Trava "pedido do app em voo"** (IP008) também no botão — antes só o cron tinha.
- **Condição de pagamento lida do portal** (decisão do founder: regra exata). A tela de detalhe tem
  `#condicoes_pagamento` ("70 - 7 DIAS"); a RPC casa com o catálogo `omie_condicao_pagamento_catalogo` por texto exato
  ("N DIAS"→"Para N dias", "28/56"→"28/56", "A VISTA"→000) e exige 1 linha única — senão **IP007** (nunca chuta, nunca
  cai em à vista). Antes TODO importado ia como "000 À Vista".
- **Depois de gravar, nunca "não importado"**: o disparo tem prazo de 60 s e a resposta sempre carrega o #id; na tela,
  chamada sem corpo vira "Não sei se entrou — importe de novo, não duplica; não lance à mão no Omie".
- **Cron**: pedido no app SEM PO não é mais "resolvido" — é re-disparado pela importadora; adiado por pedido em voo
  deixou de contar como falha.
- **Tela**: card "Pedidos do portal Sayerlack" em Gerir pedidos (RPC `sayerlack_painel_portal`, gate
  `cap_compras_ler`): pendências abertas do cron (com "Importar de novo" já preenchido), gravados sem PO e importados
  dos últimos 14 dias, com link para o pedido. Diálogo: link "Abrir pedido", copiar nº do PO, condição exibida, X e
  Esc travados durante a espera com tempo decorrido, `role=status`/`alert`, rolagem no celular. `mensagemDoErroEdge`
  passou a ler `mensagem` além de `error`.
- **Código**: trecho login → Consulta Pedidos das duas edges em `_shared/sayerlack-portal-navegador.ts`.
- Fica de fora (sem tela, decisão consciente): cadastrar alíquota de IPI por NCM continua por SQL — a mensagem do
  CP006 agora diz isso em vez de "cadastre o NCM".

Provas: `db/test-sayerlack-importar-pedido-portal.sh` 75/75 nos 2 locales (13 falsificações), testes de tela do card
e do diálogo, `test:edges` 2403, suíte vitest completa.

### Deploy da revisão (2026-11-06)

Migration `20261106140000` via `db:aplicar` (tentativa #924), validada por psql-ro: assinatura de 5 args removida,
corpo em prod = arquivo (md5 `5a3b7fef…`), ACL fechado, painel só com gate. Edges em ondas: `disparar` re-sondada
(prova tinha 455 h, #926) → `sayerlack-importar-pedido-portal` v1.4 → `sayerlack-varrer-pedidos-portal` v1.4, as duas
DEPLOY CONFIRMADO e SEM_EDICAO. Entre a migration e a edge v1.4 a importação ficou recusada sem gravar (~20 min).

## Pontos cegos, Onda 1: alíquota de IPI dos NCMs sem cadastro (2026-11-07)

Plano: `docs/superpowers/plans/2026-11-06-sayerlack-portal-pontos-cegos.md`. A única falha real das importações foi o
CP006 (NCM sem alíquota).

- **De onde sai a prova**: as NFs Sayerlack em `nfe_recebimentos` não guardam XML (56 de 56 sem `xml_completo`), mas
  `nfe_recebimento_itens.valor_total` = `round2(quantidade_nfe × valor_unitario)` + IPI. Então alíquota =
  (valor_total − vProd) ÷ vProd, linha a linha. O método reproduz os NCMs já semeados com fonte `nf` (NF 000953881).
  O espelho de PO não serve: PO lançado à mão traz `nValorIpi` 0 sempre, e PO do app traz o IPI que a própria
  `ipi_aliquota_ncm` deu (circular).
- **Migration `20261107120000`** (tentativa **#941**, ensaio antes): 29209090 = 0% (2 NFs), 32041920 = 0% (4 NFs, 5
  linhas, a maior de R$ 476,20; é o NCM dos 10 tingidores/mordentes), 32110000 = 6,5% (2 NFs, 12,50 → 13,31). Conferido
  por psql-ro depois do commit.
- **Sem NF que prove**: 27101230, 32091010, 32099020, 32159000, 39095012 (6 SKUs). Nenhuma das 90 NFs gravadas
  (desde 04/01/2026) tem esses NCMs. Perguntado ao founder; até lá a importação segue recusando com CP006.
- **Sensor (1.4)**: SKUs Sayerlack ativos no de-para sem alíquota. Em 07/11, depois da migration: 13 SKUs em 9 NCMs
  (os 5 acima e 39073022, 49111090, 29163990, 32071090, que não tiveram compra em 180 dias). A query vai virar número
  no card na Onda 6 (item 6.8):

```sql
SELECT count(*) FROM sku_fornecedor_externo s
JOIN omie_products op ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
LEFT JOIN ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
WHERE s.ativo AND s.fornecedor_nome ILIKE '%sayer%' AND a.ncm IS NULL;
```
## Pontos cegos, Onda 2 + 7.4: re-disparo relido, respostas honestas, condição real (2026-11-07)

- **2.1 / 3.8 re-disparo relê o portal**: pedido já no app sem PO não é mais re-disparado às cegas. A importadora abre o
  portal, exige a leitura provada (cancelado é recusado por `leitura.ts`) e, vindo do cron, a situação na lista fechada;
  ilegível ⇒ "não re-disparei", com o #id. Como a varredura chama a MESMA edge para re-disparar, o 3.8 vem junto.
- **2.2**: resposta com `pedido_id` nunca vira "não foi importado" (tom aviso, "está no app (#id) — falta resolver");
  2xx sem corpo legível vira "não sei se entrou".
- **2.3**: PO lançado à mão diz qual PO vale, que não se lança outro e que o #id fica sem PO até a vinculação (7.1);
  o botão "Abrir pedido" já aparece com o `pedido_id`.
- **2.4**: CP006 diz o NCM e o passo (runbook `docs/runbooks/sayerlack-pedido-portal-nao-entrou.md`, Onda 8).
- **2.5 ledger**: decisão pela leitura do schema — `acoes_execucoes` (slug `reposicao.importar_portal_sayerlack`,
  origem `manual` = botão, `automatica` = varredura), não `sayerlack_varredura_falha` (1 linha por protocolo, sem
  histórico). Toda tentativa abre linha e fecha com o que a resposta disse (`ok:true` = sucesso; resto = erro), com
  etapa, motivo, sqlstate, pedido, PO, condição e duração. Escritor único: a edge.
- **2.7**: PO confirmado marca `resolvido_em` da pendência aberta do protocolo na hora.
- **2.6 / D-2**: `sayerlack_condicao_portal_de_para` (texto normalizado → código OBEN) vence a regra exata; semente
  `30 DIAS → A30 "Para 30 dias (C)"` (a regra daria T54). Tradução ÚNICA em `sayerlack_condicao_portal_para_omie`, usada
  pela importação e pelo envio. As duas edges passam a guardar a lista de opções do `#condicoes_pagamento` (importadora
  na resposta e no IP007; envio em `portal_resposta.portal_condicao.opcoes`): é a "lista real" para completar o de-para.
  Caso ambíguo vai ao founder com a lista.
- **7.4 / D-1 condição real no pedido do app**: `enviar-pedido-portal-sayerlack` v1.13 lê a condição do formulário
  (só leitura, antes do Efetivar) e, depois de `sucesso_portal` e antes de pedir o PO, chama
  `sayerlack_aplicar_condicao_portal`. Só troca o padrão `default_a_vista`, nunca escolha humana nem pedido com PO; sem
  correspondente mantém a de hoje e grava `condicao_portal_lida` (sensor: lida e não aplicada). Fail-open de propósito: o
  pedido já está no portal.
- **Provas**: harness PG17 105/105 nos 2 locales (18 falsificações; as da importação passaram a mirar o corpo VIVO, o da
  migration nova); Deno `leitura_test.ts` 17; vitest da tela com falsificação (2 vermelhos com o ramo novo sabotado).

Sensor da condição real (denominador = pedidos do app aceitos no portal):

```sql
SELECT condicao_origem, (condicao_portal_lida IS NOT NULL) AS lida, count(*)
FROM pedido_compra_sugerido
WHERE fornecedor_nome ILIKE '%sayerlack%' AND status_envio_portal = 'sucesso_portal' AND enviado_portal_em > now() - interval '30 days'
GROUP BY 1, 2;
```

### Codex na Onda 2 (gpt-6-astra high, 1ª rodada 106 s): 2 P1 + 2 P2, todos procedentes

- **P1 corrida**: aplicar a condição DEPOIS do `sucesso_portal` deixava outro disparo criar o PO com 000 no meio. Agora a
  edge de envio aplica com o pedido ainda em `enviando_portal` (o claim dela), e só então grava `sucesso_portal`.
- **P1 fail-open**: condição não resolvida virava PO à vista ("sucesso no portal não prova pagamento à vista"). Agora o
  `disparar-pedidos-aprovados` v1.11 RECUSA o PO de pedido do app com protocolo ainda em `default_a_vista` (cai em
  `falha_envio` com o texto lido); a saída é escolher a condição no pedido (vira `manual_humano`) e disparar de novo.
  Ordem de deploy obrigatória: migration → envio v1.13 → disparo v1.11 (o disparo novo antes do envio novo recusaria
  todos os pedidos do app).
- **P2 HTTP 500 perdia o #id**: o diálogo lê o corpo estruturado do erro (`corpoDoErroEdge`), não só a mensagem.
- **P2 re-disparos lentos estouram o orçamento da varredura**: vai na Onda 3 (candidatos novos antes, teto por rodada).
- **2ª rodada (58 s)**: os 3 consertos fechados; 1 P1 novo — em `falha_envio` a tela não deixava escolher a condição, e o
  pedido recusado ficaria preso. Agora a condição é editável em `falha_envio` e dá para **Confirmar** a condição sem trocar
  o código quando ela é o padrão do motor (`podeSalvarCondicao`, testado).
- **Mudança de forma**: o changelog do `VERSAO` do disparo foi para `docs/historico/versao-disparar-pedidos-aprovados.md`
  (o gate `limpeza-fonte` acusou 5 linhas de código em 62).

## Pontos cegos, Onda 3: varredura nunca verde sem prova (2026-11-07, varredura v1.5)

Incidente que justifica a máquina (regra de máquina meta): **2 de 46 rodadas leram 0 linhas e registraram sucesso**
(23/10 e 03/11, 01:30 UTC); `info_portal` nulo em 46/46.

- **3.1–3.4 prova de leitura** (`provarLeitura`): colunas Pedido (exata)/Situação/Data Emissão/Vlr; total ANUNCIADO por
  até 3 fontes — `recordsFiltered` do JSON da consulta (nunca `recordsTotal`, que é o universo sem filtro),
  `page.info().recordsDisplay` da instância DataTables e o texto "… de N" (seletor ampliado para `[id$="_info"]`); fontes
  que discordam = erro; lidos ≠ total = erro; 0 só com "0 de 0". Sem total nenhum, toda rodada fica vermelha — decisão
  consciente (fail-closed visível; Codex concordou). Ilegível/repetido seguem para o resto mas deixam a rodada vermelha.
- **3.5** re-disparo que falha (dentro ou fora da janela) deixa a rodada vermelha.
- **3.6** registro local em `acoes_execucoes` no lugar de `comRegistro` (o `_shared` não mudou): o erro guarda o resumo
  parcial, preenchido aos poucos (importados, re-disparos, reconsultas, reconciliação).
- **3.7** reconsulta por número além da janela: falhas abertas e pedidos do app sem PO (> 1 h), fila pela tentativa mais
  antiga, teto 4 por rodada, 1×/20 h por protocolo com **reserva condicional no banco** (atômica entre execuções); banco
  reconferido antes de abrir o navegador (PO no espelho resolve sem sessão); **carência vale também aqui** (sem pedido no
  app a reconsulta pode criar PO — Codex P1).
- **3.8** coberto na Onda 2 (a importadora relê a situação).
- **3.9** carência esperando o sync > 6 h vira pendência com e-mail.
- **3.10** `listar` sem efeito (nem `marcarResolvidos`).
- **Orçamento** (P2 da Onda 2): candidatos novos antes dos re-disparos e das reconsultas.
- **Codex**: 1ª rodada 1 P1 + 5 P2; 2ª 4 P2; 3ª 1 P2 (erro de banco na reserva virava adiamento verde) — todos
  consertados. Deno `varredura_test.ts` 28 (falsificado: sem a checagem de total e sem a de 0 lidos, vermelho).
- Changelog do `VERSAO` em `docs/historico/versao-sayerlack-varrer-pedidos-portal.md`.

## Deploy das Ondas 2 e 3 (2026-11-07)

Ordem real das levas: envio → disparar → importar → varrer (`deploy-ordem.json`), com 8 min de assentamento entre elas.
Todas coladas pelo pacote `pendencias-pacote` e provadas pela sonda no envelope, com veredito **DEPLOY CONFIRMADO**:
`enviar-pedido-portal-sayerlack` v1.13 (tentativa #950), `disparar-pedidos-aprovados` v1.11 (#952),
`sayerlack-importar-pedido-portal` v1.5 (#954) e `sayerlack-varrer-pedidos-portal` v1.5 (#958). O bot do Lovable só
regenerou `types.ts`. O founder fez o Publish.

## Pontos cegos, Onda 4: vigia do cron (2026-11-07, varredura v1.6)

- **Incidente** (psql-ro): 2 de 46 rodadas leram 0 linhas e gravaram `sucesso` (23/10 e 03/11, 01:30 UTC), e nenhum
  sinal saiu. Uma falha **antes do protocolo** (login, configuração, Browserless, leitura sem prova) só virava `erro` em
  `acoes_execucoes`: o aviso por e-mail (`sayerlack_varredura_falha`) é **por protocolo**, e sem leitura não há protocolo.
- **4.1 + 4.2: um source no `data_health`**, `sayerlack_varredura_portal` (34º do compute, 26º do watchdog), migration
  `20261107220000`. O trio foi recriado junto, a partir de prod (md5 conferido). Os três estados:
  - **broken**: a última rodada decidida falhou antes de ler os pedidos. A message leva a causa, então a mesma causa
    manda 1 e-mail e uma causa nova reemite. `executando` e rodada pulada não contam como desfecho. Um erro **depois**
    da prova (falha por protocolo, que já é avisada) não conta como broken.
  - **stale**: sem rodada efetiva desde o início do dia útil exigido em SP. De segunda a sexta, a partir das 14:00,
    exige uma de hoje; antes disso e no fim de semana, exige o dia útil anterior. Efetiva = `prova_leitura='ok'`, ou
    rodada legada com `lidos>0` (0 lidos sem prova é o incidente e não conta).
  - O e-mail sai pelo canal existente (watchdog → `_data_health_episodio`). Nenhuma tabela nova.
- **Edge v1.6**: grava `causa_pre_protocolo` (`config_ausente` · `leitura:<erroTipo>` · `prova:<motivo>` · `excecao`)
  e `sessoes_browserless` (leitura_portal + importacao = total) no registro da rodada (**4.3**, só contagem: alerta
  apenas se a série mostrar risco).
- **Prova**: `db/test-data-health-sayerlack-varredura.sh`, PG17, relógio controlado, 33 asserts verdes em `C` e em
  `pt_BR.UTF-8`, `--falsificar` com 16 sabotagens.
- **Feriado** não é conhecido pela regra: com o portal fora, aparece como broken pela causa real.

## Pontos cegos, Onda 5A fatia 1: o disparador não compra pedido cancelado no portal (2026-11-08)

**O furo**: o disparador geral cria o PO de pedido `sucesso_portal` com protocolo (`already_sent`) **sem reler o
portal**. Um pedido cancelado na Sayerlack (situação 6) virava compra real na rodada seguinte. A varredura lia a
situação, mas a descartava quando o pedido já estava no app.

**Fatiamento (honesto)**: a 5A inteira tinha 5 P1 do Codex em 4 peças. Esta fatia fecha o furo de dinheiro. A
**fatia 2** (outra sessão) leva o botão auditado "Encerrar — cancelado no fornecedor" (C), os avisos por e-mail com
reserva e token (D), a cobertura periódica dos protocolos com PO e o painel (E/F). Até lá, o pedido cancelado sem PO
fica parado como hoje: o cron já manda o e-mail de situação impeditiva. A diferença é que ele não vira mais PO.

- **Migration `20261108120000`** (manual, envelope):
  - 6 colunas `portal_situacao_*` em `pedido_compra_sugerido`, com CHECK (todas nulas ou todas válidas, código `^[1-7]$`).
  - **Escritor único** `sayerlack_registrar_situacao_portal(p_lido_de, p_lido_ate, p_itens)`, só service_role. A
    trigger `trg_situacao_portal_escritor_unico` com GUC local dá 42501 para qualquer outra escrita (o staff tem UPDATE
    pela RLS).
  - A observação é o **intervalo** da leitura. Uma leitura só substitui a vigente se começou **depois do fim** dela. Uma
    leitura sobreposta só entra se disser 6 (na dúvida, bloqueia). Código ilegível nunca grava. Protocolo repetido no
    lote é ignorado. Só empresa OBEN.
  - **`reposicao_claim_disparo`** recusa `portal_situacao_codigo='6'` **no WHERE que grava** (EvalPlanQual). Vale para
    qualquer protocolo: trocar `portal_protocolo` não libera. Só uma leitura do protocolo atual com outro código libera.
    A recusa devolve `bloqueio='cancelado_no_portal'` e `pendente_desde`.
  - **Protocolo em forma canônica** (CHECK `^\d{3,12}$`, com 0 de 218 fora na prod): um protocolo com espaço sumiria
    da busca exata da varredura.
  - **Protocolo preenchido é imutável** (trigger): nenhum fluxo o troca. Sem isso, a ida e volta de protocolo pelo
    staff descartava observações e liberava a compra.
- **Edges**:
  - **varrer v1.7** grava a situação dos pedidos do app que estão na lista provada e na leitura estendida da
    reconciliação. Com uma linha ilegível ou repetida na lista, grava só os 6 (bloquear é seguro, liberar não). Se a gravação falha, a rodada fica vermelha.
  - **importar v1.6** grava a situação lida na reconsulta por número, inclusive quando recusa por cancelado.
  - **disparar v1.12**: pedido cancelado com **pendência de disparo aberta** é conciliado **só por consulta**
    (`ConsultarPedCompra AFI-<id>`, nunca `IncluirPedCompra`), antes das validações de criação. Se o PO é confirmado,
    registra o vínculo e avisa que o PO existe com o pedido cancelado. Se não acha, nada muda.
- **Front (5.5)**: o `PortalStatusPanel` de Gerir pedidos mostra a situação lida e quando foi lida. Para 6, diz
  "disparo bloqueado" (sem PO) ou "há PO no Omie, confira" (com PO). Se a leitura for de protocolo anterior, avisa.
- **Prova**: `db/test-sayerlack-situacao-portal.sh`, PG17, 51 asserts verdes em `C` e `pt_BR.UTF-8`. Usa 2 conexões
  com bloqueio observado nas duas ordens gravar × claim. Os 3 dentes da postcondição (S7, S2, S9) são asserts do
  modo normal. `--falsificar` com controle verde e 13 sabotagens de comportamento, uma camada por vez.
- **Codex**: desenho v3 com 4 P1 (reconsulta sem gravar, B' depois das validações, ordem por início da leitura,
  troca de protocolo), todos fechados no v4. A rodada 2 achou 1 P1: um 2º 6 sobreposto era descartado e uma 3ª
  leitura liberava. Agora um 6 sobre 6 **estende** o horizonte (W15). A rodada 3 achou que trocar o protocolo furava a ordem temporal. As rodadas 4 e 5 acharam sequências de ida e volta de protocolo (A→B→A). Agora o **protocolo preenchido é imutável**, assim como a empresa (rodada 7). A rodada 8, uma varredura exaustiva de colunas, achou o protocolo não canônico e o 6 descartado em leitura imperfeita; os dois foram fechados (trigger `trg_situacao_portal_trava_protocolo`, W17–W21). Preencher um vazio segue livre. A correção é só no SQL Editor, com `SET LOCAL app.sayerlack_protocolo_correcao='on'`.
- **Limite declarado**: entre a leitura das 12:30 e a gravação (segundos), um claim concorrente ainda pode criar o PO.
  Esse PO fica com a situação 6 gravada e o painel mostra "há PO no Omie". O aviso por e-mail é da fatia 2.

**Deploy da Onda 5A fatia 1 (2026-11-07, noite):**
- Migration `20261108120000` aplicada pelo envelope (tentativa #966). A 2ª testemunha (psql-ro) conferiu as colunas,
  os triggers, o claim com o veto, o ACL e o CHECK validado.
- A predecessora `enviar` v1.13 foi reconfirmada antes da leva (#969). As edges subiram em 3 ondas, com 10 min entre
  elas: disparar v1.12 (#971) → importar v1.6 (#973) → varrer v1.7 (#975), todas com DEPLOY CONFIRMADO. O bot do
  Lovable só tocou em `types.ts`.
- A chamada da importar ao Lovable estourou 300 s no MCP sem resposta. A sonda provou que o deploy tinha saído, então
  não houve reenvio às cegas.
- O SQL da sonda é determinístico: a mesma edge e a mesma janela dão o mesmo sha, e o `db:aplicar` recusa por "já
  aplicado". Variar `--janela` gera um sha novo.
- Publish feito pelo founder depois do merge.

## Revisão 2, Sessão B parte 1: tela honesta, vários números e runbook (2026-11-08)

Adendo `docs/superpowers/plans/2026-11-08-sayerlack-revisao-2.md`. Só front + doc; nenhuma edge, nenhuma migration.

- **B7 (parte da tela)**: "não foi importado" só com desfecho RECONHECIDO de que nada foi gravado — falha de leitura,
  recusa da RPC com SQLSTATE (a transação voltou) ou recusa de entrada 4xx. `{}`, `{ok:false}`, `etapa` desconhecida,
  `etapa:'importacao'` sem SQLSTATE ("Resposta inesperada", exceção 500) e `{"error":…}` viram "não sei se entrou".
  O diálogo deixou de INVENTAR `etapa:'importacao'` no corpo do erro (era isso que transformava 500 sem contrato em
  recusa). Lógica pura em `interpretarErroEdge`/`statusDoErroEdge`, testada com objeto incompleto.
- **B8**: `situacao_gravada:'erro'` vira aviso próprio no resultado, em qualquer tom.
- **8.5 / D-3**: o campo aceita vários números (linha, vírgula, espaço, ponto e vírgula; até 20; repetido conta 1×;
  inválido bloqueia e é mostrado). Laço SEQUENCIAL (teste prova que o 2º só sai depois do 1º responder), um resultado
  e um "Importar de novo" por número, "Parar depois deste" (o que não foi chamado diz que não foi chamado).
- **6.10**: Cmd-K "Importar pedido do portal Sayerlack" (registrado pelo card, enquanto Gerir pedidos está aberta).
- **6.7 (parte)**: a chave do card passou para `['pedidos-ciclo', 'portal-sayerlack-painel']` — o realtime e toda ação
  de Gerir pedidos já invalidam o prefixo `pedidos-ciclo`, então o card acompanha a página sem tocar nas outras telas.
- **B12 / 8.4**: `docs/runbooks/sayerlack-pedido-portal-nao-entrou.md` (CP006, IP002/IP003, IP006, IP007, IP008, "não
  consegui ler", "não sei se entrou", situação não gravada, senha do portal, cota Browserless, cron parado, backlog
  antigo), com as queries conferidas contra prod via psql-ro.
- **Provas**: vitest 41 (card + interpretação). Falsificação com controle verde antes e depois na mesma invocação:
  etapa inventada, B8 desligado, recusa sem SQLSTATE e laço paralelo → cada um vermelho.
## Revisão 2, bloco 1 (Sessão A): brechas B1–B7 (edge), B9–B11, B13 (2026-11-08)

Adendo: `docs/superpowers/plans/2026-11-08-sayerlack-revisao-2.md`. Importar **v1.7**, varrer **v1.8**, migration
`20261109120000` (manual, envelope). Sem mudança de tela (B7 tela, B8, B12 são da Sessão B).

- **B1 situação reconhecida**: a importadora recusa situação sem código 1..7 (`situacao_ilegivel`, botão e cron). A
  varredura conta situação sem código e emissão ilegível como linha ilegível (`ilegiveis_detalhe`) — a prova reprova,
  em vez de o pedido sumir como `situacao_nao_importavel`/`fora_da_janela`. O teste produz o contador a partir das linhas.
- **B2**: re-disparo de pedido 3 Atendido Total / 7 Fatur Balcão recusa (`faturado_no_portal`, "confira a NF no Omie").
- **B3**: a gravação da situação tenta 2×; na varredura, um 6 não gravado vira pendência com e-mail e a rodada fica
  vermelha; `situacao_gravada` vai ao ledger da importação, e a resposta da importadora com `erro` deixa a rodada vermelha.
- **B4**: pedido em voo/conciliação bloqueia só a importação: a rodada lê, prova e grava as situações, e fecha
  `pulado: bloqueado` com `prova_leitura: ok_bloqueado` (não é "efetiva" para o vigia; bloqueio longo segue stale).
- **B5**: re-disparo de pedido do app sem PO (janela e reconsulta) espera `sync_state(pedidos_compra, oben)` complete
  terminar > última mudança do pedido (`max(atualizado_em, enviado_portal_em)`) + 5 min; > 6 h vira pendência com e-mail.
- **B6/B7 (edge)**: só é resposta da importadora o objeto com `ok` booleano e `mensagem`; o resto é indeterminado, que vira
  linha aberta em `sayerlack_varredura_falha` sem e-mail e deixa a rodada vermelha. A importadora guarda o pedido achado
  por protocolo na hora (500 com `pedido_id`), e erro de RPC sem SQLSTATE da casa relê o pedido.
- **B9**: `modo=listar` grava em `reposicao.listar_portal_sayerlack` — o vigia lê só o slug da importação (sem recriar o
  trio do data_health).
- **B10**: 1ª importação grava a situação lida logo após criar o pedido, antes do disparo.
- **B11**: `detalhes.condicoes_opcoes` (+ `situacao_portal`, `situacao_gravada`) no ledger de toda tentativa.
- **B13 — regra "sem (C)"** (decisão delegada pelo founder: "pode escolher você se mantém ou tira, quero apenas que
  funcione"): a condição do portal vai SEMPRE para a variante sem "(C)" do catálogo. Medida que decidiu: os POs Sayerlack
  no Omie (`purchase_orders_tracking.raw_data` cCodParc, abr–nov/2026) usaram 000 ×396, A15 ×26, A07 ×7, 001 ×3, A10 ×1 —
  **nenhum** usou variante "(C)" (A30, A84, B23, D43, V06), e nenhum pedido do app gravou uma delas. O de-para
  `30 DIAS → A30 "Para 30 dias (C)"` **não foi escolha do founder** (o "(C)" entrou como exemplo no plano, D-2) e passa a
  T54 "Para 30 dias" (migration `20261109120000`, só o UPDATE do de-para). A função de tradução não muda: a regra exata
  de texto já escolhe a sem "(C)" (4 → A04, 6 → U89, 13 → A13) e dá IP007 só quando não há par nenhum.
- **Codex** (gpt-6-astra high): rodada 1 com 5 P1 + 1 P2, todos procedentes e fechados — B5 relê o pedido logo antes do
  re-disparo e exige a entrega dentro da janela do sync incremental (−50..+110 d); B7 a importadora declara
  `desfecho: "indeterminado"` quando a gravação pode ter acontecido; B3 pelo botão abre pendência vencida e a reconsulta
  relê só a situação (`somente_situacao`); B4 grava as situações antes das consultas ao espelho; B11 evidência acumulada
  fora da resposta.
- **Provas**: harness `db/test-sayerlack-importar-pedido-portal.sh` 117/117 em `C` e `pt_BR.UTF-8` (9 asserts B13 +
  falsificação F19: de-para de volta em (C) ⇒ a postcondição aborta e "30 DIAS" vai para A30); Deno 55 (6 sabotagens vermelhas com
  controle verde antes e depois); `test:edges` 2429.
- **No ar (2026-11-08):** #3718 mergeado 02:11Z. Migration `20261109120000` pelo envelope (tentativa #984, sha256
  `068721db…`; psql-ro: "30 DIAS" → T54 "Para 30 dias" ativo, 0 de-para em "(C)"). Edges em 2 ondas pelo pacote
  (`deploy-ordem.json`): importar **v1.7** (sonda #986, DEPLOY CONFIRMADO, fonte `0eca00d2…`) e, com a observação
  envelhecida, varrer **v1.8** (sonda #988, DEPLOY CONFIRMADO, fonte `1251919f…`). Custo 0,8 + 0,9 crédito. O sensor de
  edição deu `EDICAO_DETECTADA` na 1ª onda só porque a resposta trouxe `commit_sha` = o commit TOLERADO do bot
  (`5e197ea43`, `types.ts` regenerado com as tabelas `radar_contato_*` de outra sessão; 0 arquivo fora dos gerados) —
  falso positivo, nada revertido.


## Revisão 2, Sessão B parte 2: card do portal só verde com prova (Onda 6, 2026-11-08)

- **Migration `20261109100000`** (envelope, tentativa **#977**, ensaio antes; pré-voo psql-ro: o corpo executou nos
  dados de prod; 2ª testemunha: md5 do corpo vivo = repo, ACL preservado, anon fechado). `sayerlack_painel_portal`
  v2 é SUPERCONJUNTO do v1 (as 3 listas continuam), então o front antigo seguiu lendo até o Publish.
  - **6.1** `rodada`: última rodada EFETIVA do modo importar (prova ok; legado com lidos>0), a última decidida e
    `em_dia` pela mesma régua do vigia (dia útil SP, 14:00). `modo=listar` não conta (o B9 da Sessão A, no vigia).
    Espera da efetiva: carência (1ª vista + aguardando sync), adiados, indeterminados, carência presa — lista ausente
    vira `null`, não 0.
  - **6.4** a falha do protocolo que também é pedido sem pedido de compra vai DENTRO da linha; `pendentes_unicos`.
  - **6.5** teto 50 por lista e `total_*`. **6.6** `cancelado_humano` fora.
  - Pedidos **originados no app** com protocolo e sem pedido de compra entram (o v1 exigia `importado_portal_em`), com
    1 h em `aguardando_disparo` antes de virar pendência.
  - **6.8** `sem_aliquota` (SKUs Sayerlack ativos OBEN sem alíquota = CP006). Em prod: 13 SKUs, 9 NCMs.
  - **6.11** `cancelado_sem_po` / `cancelado_com_po` pela situação 6 gravada (Onda 5A). "Alterado no portal" fica para
    quando a 5.2 (Sessão A) criar a coluna.
- **Card**: contrato RÍGIDO (`{}`, v1, total ou lista ausente → "não consegui ler"); "Nada pendente" só com rodada
  efetiva em dia, espera conhecida e zero, nada aguardando e sem falha depois da efetiva — senão "não posso afirmar
  que não há" com o motivo; "Consultado às HH:MM"; falha de refetch com dado velho avisa e esconde o verde (6.3);
  atualizar sempre visível e releitura sozinha 7 min depois de cada horário do cron (6.7); "pedido de compra" em todo
  o card (6.9).
- **Estado em prod no apply** (sábado à noite): última efetiva = 07/11 01:30 UTC, legado v1.4 (sem `indeterminados`
  nem `carencia_presa`) → o card mostrará "não posso afirmar" até a 1ª rodada v1.7 de segunda. É o comportamento
  certo (ausente ≠ zero), não defeito.
- **Provas**: `db/test-sayerlack-painel-portal-v2.sh` PG17 36/36 em `C` e `pt_BR.UTF-8`, 5 sabotagens inline com
  controle antes/depois (filtro de modo, `cancelado_humano`, dedupe, gate, chave do contrato na postcondição); no núcleo
  do CI. vitest 51; falsificação do front com controle: sem versão, sem `em_dia`, `null` virando 0, ignorar falha
  posterior, contagem pela soma das listas (este último sobreviveu à 1ª rodada — o teste ganhou a asserção).
- **QA 8.3** (navegador do app, desktop e 375×812, dados de prod): verde no roteiro do card e do diálogo, sem disparar
  importação real. Achado fora da fronteira: o "voltar" do celular não fecha o detalhe do pedido em Gerir pedidos.
- **Rodada bloqueada (contrato da varredura v1.8, Sessão A)**: rodada com `pulado='bloqueado'` (pedido do app em envio
  ou conciliação, IP008) depois da última efetiva deixa o card em "não posso afirmar", com o motivo e o que fazer.
  A RPC já não contava `prova_leitura='ok_bloqueado'` como efetiva. Teste falsificado com controle.

## Alíquota de IPI dos 5 NCMs pendentes, provada no Omie (2026-11-08)

A onda 1 só achou NF no banco para 3 dos 8 NCMs. Os outros 5 ficaram com o founder. A pedido dele ("você não consegue
acessar essas NFes pelo Omie e descobrir o IPI?"), a prova veio do Omie OBEN, só leitura:
`produtos/recebimentonfe/ConsultarRecebimento` (itens com cNCM, CST, nAliqIPI, nBCIPI, nValIPI; Σ nValIPI =
vTotalIPI em cada NF). `contador/xml/ListarDocumentos` não serve: lista só documentos de emissão própria.
Migration `20261109130000`:

| NCM | Alíquota | Prova |
|---|---|---|
| 39095012 | 3,25% | CST 50, 2,31 ÷ 71,02 (NF 000937352, 21/05/2026, YC.1400FP) e mais 2 NFs |
| 32099020 | 0% | CST 51 (NFs 000938767 e 000935816, YO20.1464.00BB) |
| 32091010 | 0% | CST 51 (NF 000923676; 257/259VQT na 000909541) |
| 32159000 | 0% | CST 51 (NF 000915792, TY.1480.00BB) |
| 27101230 | 0% | CST 51 (NF 000909354 de 26/09/2025, DS.451LT, a última entrada do SKU) |

As mesmas NFs têm itens a 6,5% e 3,25% (CST 50), então a alíquota zero não é artefato de importação. Achado lateral: nas
764 NF-e de entrada do Omie OBEN não há compra de DS.451, TY.1480 nem YTS.1284 257/259 nos últimos 180 dias.

**Deploy (2026-11-08):** #3717 mergeado; migration `20261109130000` aplicada pelo envelope (ensaio ok → tentativa
**#979**, recibo na mesma transação). Validação por psql-ro: os 5 NCMs com a alíquota medida (`fonte = nf`); o sensor de
SKUs Sayerlack ativos sem alíquota caiu de 13 para **4** (39073022, 49111090, 29163990, 32071090, sem compra em 180 d).

## Onda 5A fatia 2 — 5.3: "Encerrar — cancelado no fornecedor" (2026-11-08)

Pedido aceito no portal (`sucesso_portal`, protocolo), sem PO, que a Sayerlack cancelou (6 gravado pela fatia 1) ficava
para sempre aguardando disparo: o claim recusa o 6, `cancelar_pedido_sugerido` recusa `sucesso_portal` e
`corrigir_cancelamento_pos_disparo` só aceita `disparado`. Sobrava o UPDATE cru de staff, sem trilha.

- **Migration `20261110100000`**: porta única `sayerlack_encerrar_cancelado_no_portal` (service_role; master pelo
  `has_role`; revalida sob FOR UPDATE: OBEN, protocolo, `sucesso_portal`, sem PO, 6 do protocolo atual, **nenhuma
  pendência de disparo, de qualquer idade**, nada no espelho do Omie por `AFI-<id>` ou contrato; exige a prova
  `ausente` do `AFI-<id>`), trilha imutável `sayerlack_encerramento_cancelado_portal` e guarda na TABELA: pedido com
  protocolo e sem PO não vira `cancelad%` nem é apagado fora da porta (predicado pelo protocolo, imutável — trocar
  `status`/`status_envio_portal` antes não fura). Medido: nenhum escritor legítimo fazia essa transição/DELETE.
- **Edge nova `sayerlack-encerrar-cancelado-portal` v1.0** (não uma ação no disparador: um bundle velho do disparador
  que recebesse `{acao, pedido_id}` cairia no fluxo de DISPARO). Gate canônico para a sonda; a ação exige JWT de master.
  Consulta dirigida `ConsultarPedCompra` por `AFI-<id>`: só fault em formato ESTRITO e ancorado que nega o pedido e cita
  o código vira "ausente" (sem amostra real no banco — o fault cru vai para a trilha); PO devolvido = recusa; o resto =
  indeterminado, nada muda. Registro em `acoes_execucoes` (`reposicao.encerrar_cancelado_portal`).
- **Front**: botão no detalhe do pedido, só master e só no caso exato; justificativa obrigatória; resposta sem contrato
  = "reabra para conferir", nunca "encerrado".
- **Codex**: desenho (6 achados: claim velho com retry em voo, contorno do trigger em 2 instruções, regex frouxa,
  cobertura e aviso persistente da 5.4) + código (P1 fault frouxo; P2 prova truncada, mensagem do PO existente) —
  todos aplicados. Prova PG17 `db/test-sayerlack-encerrar-cancelado-portal.sh`: 34 asserts nos dois locales,
  10 sabotagens vermelhas no assert certo; Deno 14 (handler com o harness + decisão).
- Fora (follow-up): staff gravar PO falso numa instrução e cancelar na seguinte (resíduo aceito); 5.4 + cobertura no
  PR seguinte (incidente persistido por pedido, cobertura dos pedidos não faturados no espelho).

## Onda 5A fatia 2 — 5.4 + cobertura: cancelado no portal com compra viva (2026-11-08)

Pedido com PO que a Sayerlack cancela no portal: o detalhe avisava, mas ninguém abre o detalhe; e a varredura só lia a
situação dos protocolos dos últimos 7 dias — o pedido de 10 dias, com PO, cancelado hoje, nunca era observado.

- **Migration `20261110120000`** (depende da `20261110100000` da 5.3 aplicada antes: o compute lê a trilha dela):
  incidente persistido `sayerlack_incidente_cancelado_com_po` (1 aberto por pedido; trava só-resolve), aberto por
  TRIGGER no pedido — 6 sobre PO, PO sobre 6 e 6 sobre **pendência de disparo** (o PO pode existir com a resposta
  perdida) — e no espelho do Omie (PO que aparece depois de um encerramento da 5.3; fail-open para o sync). Uma leitura
  posterior com outro código não fecha: só a porta `corrigir_cancelamento_pos_disparo` (GUC) ou
  `sayerlack_resolver_incidente_cancelado_com_po` (master, justificativa). Cobertura
  `sayerlack_cobertura_situacao_portal()` = pedidos com protocolo e PO não faturado nem encerrado no espelho (10 em
  prod, 29/10–05/11). Source **`sayerlack_cancelado_com_po`** (35º) no trio: broken com incidente aberto (message cita
  o mais recente → e-mail por incidente novo), stale se algum pedido da cobertura não tem leitura do protocolo no dia
  útil exigido (régua da Onda 4).
- **Varredura v1.9**: passo 8 relê 1×/dia a situação da cobertura (leitura estendida desde a emissão mais antiga − 3
  dias, teto 90), também na rodada bloqueada; qualquer falha deixa a rodada vermelha.
- **Codex**: desenho + 2 rodadas de código (P1: pendência de disparo, espelho só calculado, rodada bloqueada pulando a
  cobertura) — aplicados; P2 aceito: dois incidentes entre execuções do watchdog dão 1 e-mail (o probable_cause lista
  todos). Prova PG17 `db/test-sayerlack-cancelado-com-compra-viva.sh`: 47 asserts nos dois locales, 20 sabotagens
  vermelhas; vizinhos do trio (10 provas de data_health/tint/fin) verdes.
- **No ar (2026-11-08, #3731)**: migration `20261110120000` aplicada pelo envelope (ensaio ok → tentativa #996),
  validada por fora no psql-ro (tabela, os 2 triggers, resolver só `authenticated`, cobertura só `service_role`, source
  no `_data_health_compute`; 0 incidentes abertos). Varrer v1.9 com DEPLOY CONFIRMADO (sonda #999, na mesma leva do
  `gerar-pedidos-diario` do #3726), depois de reprovar a predecessora importar (#998 — prova velha de 9,4 h).
  Sensor do Lovable: `EDICAO_DETECTADA` só pelo `edit_id` da resposta — os commits do bot (`af018bcb1` e, na 5.3,
  `0053e934c`) são a regeração do `types.ts` com os tipos destas migrations, só acréscimos, arquivo tolerado. Nada a reverter.

## 8.1 — testes dos handlers reais (2026-11-08)

- `sayerlack-importar-pedido-portal/index_test.ts` (24 testes, 7 de gate) e `sayerlack-varrer-pedidos-portal/index_test.ts`
  (15, 7 de gate) rodam o `index.ts` DE VERDADE pelo `_shared/harness-handler_test.ts`, com o PostgREST, o Browserless,
  o disparo do PO e a importadora simulados por rota em `_shared/postgrest-falso_test.ts` (rota não prevista LANÇA;
  `.range()` respeitado; coringa `*` opt-in só para PostgREST). A varrer roda com o relógio FIXO (quarta 10h SP; domingo
  para o portal fechado) — sem isso a rodada pula no fim de semana e o teste passaria vazio.
- Ramos cobertos (plano: Codex D1 + revisão 2): importar — 1ª importação com a situação regravada pós-criar (B10),
  existente cancelado no portal, PO manual (contrato composto; contrato que só CONTÉM o nº não vale), re-disparo que falha,
  faturado no portal (B2), resposta da gravação perdida com e sem o pedido na releitura (B7), sqlstate da casa, RPC sem
  `pedido_id`, espelho falhando depois de achar o pedido, 6 não gravado pelo botão × pela varredura (B3), só-situação, cron
  403. Varrer — `listar` com ZERO escrita e o slug próprio (B9), 0 lidos sem prova, lidos ≠ total, 6 não gravado (2
  tentativas, pendência, vermelha), 6 gravado (verde), pendência fora da janela sem resposta da importadora (indeterminado
  durável, vermelha — B6), portal fechado, modo inválido.
- Falsificação (commitado antes; controle verde antes e depois, na mesma invocação): 11 sabotagens no `index.ts` da
  importar e 10 no da varrer, uma camada por vez — todas vermelhas.

## 7.3 — transportadora do portal no `cObs` do PO (2026-11-08)

- **O quê:** o `disparar-pedidos-aprovados` v1.13 põe no `cObs` do PO a transportadora que o portal mostrou
  (`data_pedido.transportadora` do `busca-itens-pedido`). A fonte é a evidência imutável do 7.2: a leitura mais recente
  com `leitura_ok`, sob prazo de 3 s.
- **Fail-open por desenho:** é observação, nunca segura nem muda o disparo. Sem evidência, sem o campo, com caractere de
  controle, vazio ou acima de 60 caracteres, a linha não entra. Ausente ≠ inventada.
- **Sem 2º escritor:** o valor é lido da evidência e não é gravado no pedido; a RPC de importação fica intacta. O frete
  não entra, porque nenhuma leitura real mostrou ainda onde o portal o informa.
- **Provas:** 3 testes Deno das funções puras. Falsificação 6/6 vermelha, com controle verde; uma guarda redundante
  ficou verde e foi removida.
- **Codex:** Caminho B (`sem-codex: cota no teto local (79)`), por decisão do founder de guardar a reserva para o 5.2 e
  o 7.1. O Codex retroativo rodou em 2026-11-09, com o código já em produção. Rodou acima do teto de
  cota (94%), por autorização do founder, e não achou defeito real nos 4 eixos:
  - fail-open: a leitura e a extração estão sob `try/catch` com `AbortSignal.timeout(3_000)`, e só alimentam o
    `cObs`;
  - correlação: a evidência e o disparador usam o mesmo protocolo completo;
  - `cObs`: chega a 168 caracteres no máximo, e o Omie não documenta teto;
  - nenhuma escrita nova.
  Os riscos declarados abaixo continuam como estavam.
- **Resta (declarado):**
  - a fiação no `index.ts` não tem teste de handler;
  - caracteres C1 e bidi passam pelo filtro;
  - o teto do `cObs` no Omie não está provado.
- **Deploy (2026-11-09):** #3751 mergeado às 21:55Z. A ordem entre edges reteve o disparador até a predecessora
  `enviar-pedido-portal-sayerlack` ser sondada de novo (DEPLOY CONFIRMADO, #1027). Depois:
  - disparar v1.13: 17/17 hashes, sonda #1029 DEPLOY CONFIRMADO;
  - o `commit_sha` da resposta foi só o `types.ts` regenerado (`d7792da1`, tolerado), e nenhuma edge mudou.

## 7.2 + 4.3 — evidência imutável de cada leitura e sessão do Browserless pela importadora (2026-11-08)

- **7.2.** A migration `20261111090000` cria a tabela `sayerlack_portal_evidencia`, que só aceita INSERT. Triggers
  ALWAYS recusam UPDATE, DELETE e TRUNCATE (42501). RLS: só staff lê; 1 escritor (`service_role`).
- A importadora (v1.9) grava 1 linha por chamada ao Browserless, logo depois da leitura: consulta, itens brutos,
  condição e opções, e trace cortado em ~100 KB.
- Correlação: `execucao_id` = `acoes_execucoes.id`; o ledger guarda `evidencia_id` e `evidencia_gravada`.
- Fail-open com prazo de 3 s: a evidência nunca segura nem muda a importação.
- **4.3.** Toda resposta da importadora diz `sessao_browserless`.
- A varredura (v1.11) conta `importacao` só com `true`. `false` vira `importacao_sem_sessao`.
- Campo ausente ou rede vira `importacao_indeterminada`; então `total` vem null, com a faixa `total_minimo`/`total_maximo`.
- **Lição (Codex).** O PostgREST falso devolvia 204 COM corpo, e o `Response` lançava. O fecho do ledger falhava mudo
  em todos os testes de handler, e as asserções liam o PATCH tentado. Corrigido no `_shared`.
- **Deploy (2026-11-08):** #3747 mergeado às 21:01Z, depois de um rerun: o 1º CI caiu na rede do runner, com o curl da
  chave PGDG em exit 56, antes de qualquer prova. A migration `20261111090000` foi aplicada pelo envelope (ensaio ok,
  tentativa **#1015**). Validação em psql-ro: RLS ligada, os 2 triggers em `A`, `service_role` com INSERT e SELECT,
  `anon` e `authenticated` sem acesso.
  - **importar v1.9:** 11/11 hashes, sonda #1017 DEPLOY CONFIRMADO. O 401 já traz `sessao_browserless:false`. O
    sensor achou `edit_id`/`commit_sha` do `types.ts` regenerado com a tabela nova (`4e801f49`, tolerado), e nenhuma
    edge mudou.
  - **varrer v1.11:** 14/14 hashes, sem `edit_id`, sonda #1019 DEPLOY CONFIRMADO.
  - `pendencias:deploy` em exit 0.

## 8.2 — seletores e paginação testados contra HTML (2026-11-08)

- **O que mudou:** as funções que rodam NA PÁGINA do portal (filtros, situações, tabela da consulta por nome de coluna,
  "Filtrar", "Próximo", condição selecionada e opções) e o laço de paginação da varredura saíram do template
  `BROWSERLESS_FUNCTION` para `supabase/functions/_shared/sayerlack-portal-dom.ts`, e voltam ao script por
  `${fn.toString()}` (o molde do `classificarPosLogin`). Comportamento igual (Codex conferiu ordem dos filtros,
  mensagens, `erroTipo`, o trace `consulta_lida` antes do `PAGINACAO_INCOMPLETA`). importar **v1.8**, varrer **v1.10**.
- **Testes:** `scripts/sayerlack-portal-dom.test.ts` (vitest + jsdom, fixtures em `scripts/__fixtures__/sayerlack-portal/`):
  HTML → função de página → leitor REAL de Deno (`lerPedidoPortal`, `lerListaConsulta` + `provarLeitura`), sem objeto
  já extraído no meio — 2 páginas pelo "Próximo" provam a leitura (3 = 3 anunciados); 1 página com 3 anunciados reprova.
  As funções são testadas pelo TEXTO serializado (sem o escopo do módulo), no vitest e no Deno
  (`_shared/sayerlack-portal-dom_test.ts`); o `index_test.ts` de cada edge captura o `code` enviado ao Browserless e
  prova que parseia e embute as funções.
- **Falsificação:** 21 sabotagens no módulo (seletor da tabela, placeholder, quebra de linha, `dataTables_empty`,
  "Processando", info pelo id, "Próximo" e o `disabled` no `<li>` pai, `recordsDisplay`, clique no `<a>`, situações,
  filtros, entrega 2020, "Selecione", teto, incompleta, sem resposta, "Filtrar", `bubbles`, `trigger`, `globalThis`),
  todas vermelhas com controle verde na mesma invocação; mais 4 no embutimento das duas edges (tipo TS no texto, função
  não embutida).
- **Codex (gpt-6-astra high, 144 s):** sem P0/P1; 2 P2 de cobertura, ambos fechados no PR ("Filtrar"/eventos/jQuery
  sem teste; testes Deno só provavam sintaxe → agora executam o texto serializado).
- **Resta (declarado):** o `innerText` com layout real, o redesenho assíncrono do DataTables e a execução no Chrome
  remoto só se provam na rodada real (leitura de segunda, `modo=listar`).
- **Deploy (2026-11-08):** #3742 mergeado às 15:05Z. A ordem entre edges reteve a leva até a predecessora
  `disparar-pedidos-aprovados` ser sondada de novo: DEPLOY CONFIRMADO, tentativa #1009. Depois foram duas ondas pelo
  pacote. O importar v1.8 bateu 10/10 hashes, e a sonda (#1011) deu DEPLOY CONFIRMADO. O sensor achou o `edit_id`
  da regeneração do `types.ts` (`d97eb3234`, tolerado), e nenhuma edge mudou. O varrer v1.10 bateu 14/14 hashes, a
  resposta veio sem `edit_id` e a sonda deu DEPLOY CONFIRMADO. `pendencias:deploy` em exit 0.

## 7.5 — o portal expõe NCM/IPI por item? Rodada 1: INCONCLUSIVO (2026-11-08)

Pergunta do adendo `2026-11-08-sayerlack-revisao-2.md` (7.5). Investigação só leitura; nada implementado.

- **Bloqueio**: o portal estava fora no dia (confirmado pelo founder; `portal.sayerlack.com.br/order-viewer` não
  carregou no Chrome). As telas de detalhe, impressão/espelho e downloads (XML/PDF) **não foram vistas**. O veredito
  "não expõe" **não** pode sair daqui: ausência nas fontes abaixo é ausência de dado, não prova.
- **O que já se sabe (evidência indireta)**:
  - `GET /order-creation/busca-itens-pedido/<nº>` devolve um array posicional **mais longo que 14** — a amostra do
    spike (pedido 2140603) foi registrada truncada em `[13]` ("…") e **nunca** foi catalogada além disso (busca em
    repo, histórico git e transcrições de sessão: nenhuma cópia completa). O parser (`leitura.ts`) só lê `[0]..[13]`.
  - Posições não usadas com valor: `[2]` = "" · `[7]` = 19,8637 (= preço UN ÷ cap. 18, preço por L) · `[9]` =
    357,5466 (= `[8]`) · `[10]` = 5. Esse pedido tem IPI de 6,5% (316,26 ÷ 4.865,56), então `[10]` **não** é a
    alíquota de IPI desse item.
  - 257 linhas de `pedidos_portal_tentativas.evidence` (trace + network + DOM do formulário de criação): **0**
    ocorrências de `ipi|ncm|aliq|imposto|tribut` (regex sem caixa no JSON inteiro). A resposta de
    `POST /order-creation/form/add` traz só `itens[{item, value}]` e o total `value` (pedido 2147222: 15.929,24 contra
    `valor_total` 15.929,28 no app — mercadoria, sem IPI). O formulário de criação não mostra NCM/IPI nos campos
    gravados (`it_codigo`, `btnGravarItem`…).
  - A Consulta Pedidos (`/order-viewer`) só tem Vlr Mercadoria e Vlr Total: dá o IPI **do pedido**, não por linha.
- **Fecho (rodada 2, quando o portal voltar — 1 leitura, ~5 min no Chrome do founder logado)**, num pedido já
  faturado com ≥2 NCMs diferentes:
  1. `fetch('/order-creation/busca-itens-pedido/<nº>')` e catalogar **todas** as posições do 1º item (comprimento,
     tipo, valor). Procurar NCM (8 dígitos) e um % que reproduza `(Vlr Total − Vlr Mercadoria)` quando somado por linha.
  2. Abrir `/order-creation-form-edit/<nº>/route/order-viewer` (só GET, sem clicar em gravar) e ler colunas/inputs
     do grid de itens.
  3. Procurar no `/order-viewer` ação de imprimir/espelho/XML/PDF do pedido e ler o conteúdo.
  4. Comparar o IPI por linha (se houver) com `nfe_recebimento_itens` da NF do pedido e com `ipi_aliquota_ncm`.
- **Desenho proposto se expuser** (para a sessão dona das edges; não implementado): ler NCM/IPI% na MESMA prova
  posicional do parser (falhou a prova ⇒ recusa) e usá-los como **2ª fonte** contra `ipi_aliquota_ncm` — divergência
  vira recusa com motivo, nunca sobrescreve a tabela (que é provada na NF-e). Σ(mercadoria × (1+IPI%)) da linha deve
  bater o Vlr Total da consulta.

## Alíquota de IPI dos 4 últimos NCMs, provada no Omie (2026-11-08)

Pedido do founder ("por que você não busca os IPI pelas NFes antigas?"). O #3717 deixou 4 NCMs no sensor, todos sem
compra recente. Desta vez a varredura pegou **todos** os 1.223 recebimentos do Omie OBEN
(`produtos/recebimentonfe/ListarRecebimentos` até página vazia), sendo 835 da Renner Sayerlack (nov/2023 → out/2026), e
`ConsultarRecebimento` em cada um, só leitura. Migration `20261110140000`:

| NCM | Alíquota | Prova |
|---|---|---|
| 39073022 | 3,25% | CST 50 nas 3 NFs: 1,52 ÷ 46,82 (000923122, 21/01/2026, KB.7820.00FG), 000897969, 000838822 |
| 49111090 | 0% | CST 51 em 27 linhas de 19 NFs (cartelas de cores), a última 000954165 de 06/10/2026 |
| 32071090 | 0% | CST 51 (000938767 de 02/06/2026 e 000885575, GG.3842QT) |
| 29163990 | 0% | CST 51 (000928889 de 11/03/2026, 000899121 e 000831532, YG.1045FG) |

Nenhuma dessas NFs tem `vTotalIPI` zero (há outros itens a 6,5% e 3,25%), então a alíquota zero não é artefato. A
postcondição exige o **sensor inteiro em 0**: nenhum SKU Sayerlack ativo sem alíquota. Ensaio pelo `db:aplicar`: ok,
`POSTCONDICAO_OK`, ROLLBACK.

**Deploy (2026-11-08):** migration `20261110140000` aplicada pelo envelope (ensaio ok → tentativa **#1007**, recibo na
mesma transação). Validação por psql-ro: os 4 NCMs com a alíquota medida (`fonte = nf`); sensor de SKUs Sayerlack
ativos sem alíquota = **0**.

**Lição**: "sem compra em 180 dias" não quer dizer "sem NF". O `nfe_recebimentos` do app só começa em jan/2026, e o
Omie guarda as NF-e de entrada desde 2023. Para NCM sem alíquota, a 1ª fonte é o `ConsultarRecebimento` sobre todo o
histórico, não a janela do banco. O CP006 só volta com NCM **nunca comprado**, e é aí que a 7.5 (IPI no portal) ainda
teria valor.

## 7.5 — veredito: o portal NÃO expõe NCM/IPI por item (2026-11-08)

Fecha a rodada 1 acima. **O portal não mostra o valor com IPI por item: o IPI só aparece quando a NF é faturada**
(founder, que opera o portal todo dia). Isso bate com tudo que foi lido: nenhum campo de IPI/NCM nas 257 tentativas de
envio gravadas, `form/add` devolve só item e valor sem IPI, e a Consulta Pedidos só tem os totais. As posições de
`busca-itens-pedido` além da `[13]` não foram catalogadas (portal fora no dia), mas a resposta do founder torna
improvável que alguma delas seja a alíquota. Se um dia precisar reabrir, o roteiro da rodada 1 continua válido.

**Consequência para o desenho:** a fonte da alíquota continua sendo a NF-e de entrada no Omie
(`ConsultarRecebimento` sobre o histórico inteiro). Com o #3744 o sensor de SKUs Sayerlack ativos sem alíquota está
em **0**. O CP006 só volta com NCM que a OBEN nunca comprou; aí o passo é esperar a 1ª NF e medir nela. A conferência
de alíquota que mudou já existe: o CP007 recusa quando o total com IPI calculado não bate o Vlr Total do portal.
Nada a implementar nas edges.

## 7.1 — vincular o PO lançado à mão no Omie (2026-11-08)

**Antes:** a importadora (pedido existente sem PO) e a varredura (reconsulta e re-disparo da janela) detectavam o PO
manual pelo contrato e só avisavam: o pedido ficava sem PO no app para sempre. **Agora** os três pontos chamam a RPC
`sayerlack_vincular_po_manual` (migration `20261111110000`), que vincula só quando o espelho do Omie prova que o PO
é a compra daquele pedido:

1. **Contrato:** o protocolo é um TOKEN EXATO do `numero_contrato_fornecedor` (split `/` + `btrim`, a mesma gramática
   da varredura e do 5.3; o composto `a / b` vale), ou o código de integração é o `AFI-<id>` do próprio pedido.
   Substring nunca vale. Mais de um PO vivo candidato = `po_ambiguo`. PO `CANCELADO` e de outra empresa não contam.
2. **Dono:** recusa o PO com `AFI-<outro id>` ou já vinculado a outro pedido (`po_de_outro_pedido`).
3. **Conteúdo:** conjunto de SKUs igual, quantidade por SKU igual, valor por SKU (`nValTot`, com IPI) a no máximo
   max(R$ 0,01; 0,5 centavo por unidade) de `qtde_final × preco_unitario`. **Calibrado em prod:** dos 213 POs que o
   próprio app criou para pedidos do portal, 206 casam ao centavo; os 7 que não casam são edições reais (SKU
   acrescentado no Omie, quantidade dobrada e o composto 2130311/2130322, cujo PO traz o item do outro protocolo).
   Assim, o composto cujo PO carrega os itens do outro protocolo diverge por conteúdo, e esse é o comportamento
   desejado.
4. **Ausente ≠ zero:** PO sem `produtos_consulta` legível, item sem número ou pedido com item sem SKU, quantidade ou
   preço ⇒ `conteudo_ausente`. A recusa traz as diferenças por SKU na resposta da importadora.
5. **Claim aberto, de qualquer idade, recusa** (`disparo_pendente`): uma tentativa pode ter criado o `AFI-<id>` com a
   resposta perdida, e quem resolve é a conciliação do disparador. O vínculo grava os mesmos campos da conciliação
   (`omie_pedido_compra_*`, status `disparado`, claim limpo) e a trilha em `acoes_execucoes` (`acao =
   sayerlack_vincular_po_manual`) com o antes e o depois.
6. **Corrida e frescor (Codex rodada 1: 2 P1 + 1 P2):** o PO candidato é relido com `FOR UPDATE` e revalidado sob
   a trava (status, contrato, `AFI-`); se mudou, a RPC aborta com `40001`. Assim, dois pedidos nunca pegam o mesmo
   PO. O espelho tem de estar fresco: `sync_state` `pedidos_compra/oben` em `complete` há menos de 2 h, senão
   `espelho_desatualizado`. Na rodada 2 do Codex, nada P0/P1. O risco de deadlock que ela levantou foi descartado,
   porque o gatilho do espelho só insere no incidente e o sync escreve por HTTP em transação própria.

Nas edges (importar v1.10, varrer v1.12): o erro da RPC **lança** na importadora (cai no catch, sem re-disparo) e, na
varredura, mantém a pendência com `vinculo_motivo: "erro"`. Nenhum dos ramos re-dispara.

**Provas:** `db/test-sayerlack-vincular-po-manual.sh` (PG17, 32 asserts, nos 2 locales; `--falsificar` com 14
sabotagens vermelhas nos dois, incluindo a trava com 2 conexões A/B e o espelho velho). Handlers em Deno: importar (vinculou, não casou com diferenças, RPC com erro) e
varrer (reconsulta: casou, não casou, erro), com 4 sabotagens das edges vermelhas.

**No ar (2026-11-09, #3754):**
- **Migration `20261111110000`:** aplicada pelo envelope (ensaio ok, depois a tentativa #1031, com o marcador `VINCULAR_PO_MANUAL_POS_OK`). Conferida no psql-ro: fechada a anon e authenticated, aberta só ao service_role.
- **Edges:** subiram em 2 ondas pelo pacote.
  - A importar v1.10 foi colada às 01:29Z, e nenhuma das sessões da família assumiu o envio. Os hashes eram os do pacote (12/12), e a sonda #1033 deu DEPLOY CONFIRMADO.
  - A varrer v1.12 subiu às 02:10Z, com 15/15 hashes, e a sonda #1035 deu DEPLOY CONFIRMADO.
  - No ledger, as duas ficaram em `CONFERE`.
- **Sensor de edição:**
  - 1ª onda: `EDICAO_DETECTADA` só pelo `edit_id`, que era a regeneração do `types.ts` com a RPC nova (`0b2f1211`, tolerado). Nada em `supabase/` mudou.
  - 2ª onda: `SEM_EDICAO`.

## Leitura operacional de segunda 09/11 — a prova do total observada em prod pela 1ª vez (2026-11-09)

- **O quê:** a prova de leitura (o total anunciado pelo portal precisa bater com as linhas lidas) nunca tinha sido
  observada em prod. Rodamos a varredura em `modo=listar` antes da rodada das 12:30, por uma tarefa agendada no Mac
  do founder, às 06:30. O portal fecha de sábado 12h a segunda 6h, então domingo não servia.
- **Resultado** (execução `9a391148`, 06:38 SP, varrer `v1.12-vincula-po-manual`):
  - `status=sucesso` e `prova_leitura=ok`, numa página só.
  - 6 linhas lidas e `total_anunciado` 6. A fonte que casou foi o `recordsFiltered` do JSON
    (`resposta_chaves`: success, message, data, recordsTotal, recordsFiltered); `dt_total` e `info_portal` vieram
    nulos.
  - Os 6 pedidos já estavam no app, sem ilegível, falha ou indeterminado; 1 sessão do Browserless.
- **Lição:** a fonte que segura a prova hoje é a resposta JSON do DataTables, não o DOM. Se o portal mudar o
  endpoint, `dt_total`/`info_portal` são o fallback, e eles ainda não foram vistos com valor em prod.

## 5.2 fatia 1 — pedido alterado no portal não re-dispara o pedido antigo (2026-11-09)

**Antes:** a importadora relia o portal e, sem PO, re-disparava o pedido ANTIGO do app. Não comparava nada e não havia
diff persistido. Se o fornecedor tivesse trocado SKU, quantidade, preço ou condição no portal, o PO saía errado.
**Agora** (migration `20261111150000`, importar v1.11, disparar v1.14):

1. **Retrato inicial durável:** `sayerlack_portal_retrato`, versionado e imutável, guarda os itens com valor, o total
   e a condição. No pedido importado, ele nasce **dentro** da RPC de importar, na mesma transação do pedido (Codex P1):
   uma resposta perdida não deixa o pedido sem referência. No pedido nascido no app, o retrato é a 1ª leitura.
   - Não dá para tirar o retrato do `resposta_canal`: o `falha_envio` do disparador sobrescreve esse campo
     (`disparar:1523`), justamente no caso que importa.
2. **Conferência** (`sayerlack_conferir_portal`, escritor único, SECURITY DEFINER):
   - SKU e quantidade se comparam com os itens do próprio pedido, por `sku_portal_aprovado` e `qtde_final ×
     fator_portal_aprovado`, com FULL JOIN;
   - valor por SKU, total e condição normalizada se comparam com o retrato. O total carrega o IPI, que o portal não
     expõe por item;
   - item sem selo do portal é diferença, nunca "bateu";
   - leitura sem total, condição ou item legível é 22023.
3. **Divergência:** `sayerlack_portal_divergencia` guarda o diff, a leitura parseada (o insumo da fatia 2), o
   intervalo e a evidência 7.2. Fica no máximo 1 aberta por pedido, e o mesmo diff não empilha linha.
   - Uma leitura só fecha (`portal_voltou`) ou substitui a aberta se for **provadamente posterior** a ela (`lido_de`
     > `lido_ate`); senão volta `leitura_antiga`, sem escrever (Codex P1).
4. **Gate na linha do pedido:** a coluna `portal_divergencia_aberta_id` vai no MESMO WHERE do UPDATE do claim.
   - Com o veto lendo a outra tabela (NOT EXISTS), o EvalPlanQual usa o snapshot velho e o claim que esperou a trava
     passa. A sabotagem `gate_por_not_exists` prova isso com 2 conexões.
   - Um claim aberto não impede a conferência de gravar o gate. Daí em diante, o claim devolve `alterado_no_portal`
     com `pendente_desde`, e o disparador concilia **só por consulta**, com o mesmo helper do cancelado no portal.

**Nas edges:**
- **Importar:** antes de qualquer re-disparo, confere a leitura inteira (itens, total, condição, intervalo e
  evidência). Divergente, recusa, erro ou resposta fora do contrato ⇒ não dispara (fail-closed). Condição ilegível no
  re-disparo também recusa.
- **RPC de importar com `ja_existia:true`** (outra aba importou durante a leitura): agora passa pela recusa de
  faturado e pela conferência (Codex P1).

**Risco residual (documentado):** se o claim do cron passar ANTES de a conferência gravar o gate, o disparo em voo
segue com o pedido antigo. O disparador geral não lê o portal. Fechar essa janela exige autorização por conferência
consumida no claim, o que fica fora da fatia 1.

**Codex na revisão do código:** foram 2 rodadas, todas corrigidas.
- 1ª rodada (2 P1 e 2 P2):
  - o mesmo diff carimba a ÚLTIMA observação (`ultima_lido_ate`), e fechar exige leitura posterior a ela;
  - o retrato só nasce quando SKU e quantidade batem, porque uma 1ª leitura já divergente não pode virar a
    referência de valor;
  - divergência exige o intervalo da leitura; infinito e fuso inválido dão 22023.
- 2ª rodada (2 P1):
  - a ordem é checada ANTES de semear o retrato;
  - a origem `importacao` (instante da gravação, não da captura) nunca fecha nem substitui uma aberta.

**Provas:** `db/test-sayerlack-conferir-portal.sh`, em PG17 sobre a cadeia REAL da RPC de importar:
- 39 asserts, verdes nos 2 locales;
- `--falsificar` com 17 sabotagens vermelhas no assert declarado, nos 2 locales;
- o POS C4 pega o claim sem gate já ao aplicar.

Na edge importar, os handlers em Deno cobrem: bate e dispara, alterado, erro ou leitura antiga, fora do contrato,
condição ilegível, 1ª importação sem conferência pela edge, e `ja_existia` divergente ou faturado.

**No ar (2026-11-09, #3767):**
- **Migration `20261111150000`:** aplicada pelo envelope (tentativa #1050, sha `5da3782a…`).
  - Conferida no psql-ro: a porta está fechada a anon e authenticated e aberta só ao service_role; o service_role
    não tem INSERT direto; a RLS está ligada; o claim leva o gate; a importação chama a porta.
  - O timestamp coincide com o de `20261111150000_radar_privacidade_titular_mei.sql` (#3763). Os objetos são
    independentes e o replay ordena pelo nome do arquivo.
- **Edges:** subiram em 2 ondas pelo pacote, porque o `deploy-ordem.json` da importar pede o disparar antes.
  - Disparar v1.14, colada às 22:48Z: 17/17 hashes, sonda #1057 com DEPLOY CONFIRMADO. Outra sessão repetiu o
    envio às 22:49Z, com o mesmo bundle.
  - Importar v1.11, colada às 23:03Z depois dos 10 min do #3075: 13/13 hashes, sonda #1061 com DEPLOY CONFIRMADO.
  - `pendencias:deploy` saiu com exit 0.
- **Sensor de edição:**
  - 1ª onda: `EDICAO_DETECTADA` só pelo `edit_id`, que é a regeneração do `types.ts` com as tabelas novas
    (`ca7e54a5`, tolerado). Nada em `supabase/` mudou.
  - 2ª onda: `SEM_EDICAO`.

## 5.2 fatia 2 — botão "Aceitar o portal" (2026-11-09)

**Antes:** com a fatia 1, um pedido alterado no portal ficava bloqueado (gate `portal_divergencia_aberta_id`), e
não havia como seguir quando a mudança era combinada com o fornecedor. **Agora** (migration `20261111180000`, decisão
do founder: opção (a), humano com justificativa):

1. **RPC `sayerlack_aceitar_portal(pedido, divergencia, justificativa)`**, SECURITY DEFINER, só staff (marca
   `[ACEITAR-STAFF]`, 42501). Justificativa de 10 a 1000 caracteres.
   - `FOR UPDATE` no pedido e na divergência, com revalidação sob a trava e 40001 na corrida.
   - Recusa sem escrever: sem protocolo, com PO, status ou situação fora de 1/5, claim aberto, sem divergência,
     divergência diferente da que a tela viu, PO no espelho com o protocolo/AFI-<id>, divergência já aceita
     (`aguardando_releitura`).
   - Reescreve itens, cabeçalho e condição a partir da `leitura` da divergência (validações IP001–IP007), herdando do
     item antigo só as colunas de estoque do motor (nada de promoção ou desconto), e recalcula o custo pela mesma prova
     da importação (`sayerlack_aplicar_custo_portal` + `sayerlack_ipi_itens`).
   - Trilha em `acoes_execucoes` com justificativa, diferenças, antes, depois e versão do retrato.
2. **Porta única estendida:** `sayerlack_conferir_portal` ganhou o modo `aceito_portal`, autorizado só pelo GUC local
   que a RPC seta e limpa. Ele grava o retrato v+1 com o marco `leitura_lido_ate` e fecha a divergência como
   `aceito_portal`. **O gate fica** (Codex P1): aponta a divergência fechada e só solta quando uma releitura de
   redisparo com `lido_de` > marco bate. A tela re-dispara pela edge importar de sempre (relê, confere, claim).
   - "Mesmo diff" só mantém a aberta se o CONTEÚDO da leitura também for igual (helper
     `sayerlack__portal_leitura_conteudo`).
   - TRAVA + PRE: md5 exato do corpo vivo da porta ∈ {fatia 1, esta}; a migration aborta se a porta derivou.
3. **UI mínima** (`AceitarPortal.tsx` no `DetalhesModal`, tela da Sessão B): mostra as diferenças e a leitura inteira
   (itens com quantidade e valor, total, condição), pede a justificativa e não deixa aceitar se não conseguir ler.
   Depois do aceite, o card vira "Reler o portal e disparar".

**Codex** (reasoning max, `CODEX_ASYNC_TETO_SALDO=0`): desenho com 3 P1 (conteúdo no mesmo diff, marco do retrato
aceito, `po_no_espelho`); código r1 com 2 P1 (gate fica até a releitura; UI mostra a leitura); código r2 "nada P0/P1".
Foram 3 rodadas, 189.212 tokens no total.

**Provas:** `db/test-sayerlack-aceitar-portal.sh` (PG17, cadeia real): 31 asserts verdes nos 2 locales, inclusive
releitura × aceite em 2 conexões; `--falsificar` com 14 sabotagens vermelhas no assert declarado, nos 2 locales. A
suíte da fatia 1 (39 asserts) segue verde contra a porta nova nos 2 locales. Vitest da tela verde.

**Risco residual:** a recusa `po_no_espelho` depende do espelho de POs do Omie estar sincronizado; um PO lançado à mão
segundos antes do aceite pode não estar lá ainda.

**No ar (2026-11-09):**
- ✅ **Migration `20261111180000`:** ensaio e aplicação pelo envelope (tentativa #1064, sha `75a3d1e8…`), com o
  marcador `ACEITAR_PORTAL_POS_OK`. Conferida no psql-ro: md5 da porta `f6d244ca…`, VOLATILE; coluna
  `leitura_lido_ate`; RPC SECDEF com `search_path` fixo, executável por authenticated e service_role e fechada a anon;
  helper e porta só ao service_role.
- Edges: nenhuma mudou.
- ✅ **Publish** (founder, 2026-11-10): `monitor-deploy.sh --pr 3786` → `PR_NO_AR`; o ar serve o carimbo
  `60f583be`, o squash do #3786 (entry `index-BH7rPGRT`).

## 6.11 — "alterado no portal" no card (2026-11-09)

Faltava do 6.11 a linha do pedido **alterado no portal**: o painel v2 (20261109100000) a deixou para quando a 5.2
criasse a divergência, e ninguém voltou a ela depois da 5.2.

- **Migration `20261112090000_sayerlack_painel_alterado_portal.sql`**: recria `sayerlack_painel_portal()` a partir do
  v2. O pré-voo de 2026-11-09 mostrou o `prosrc` de prod idêntico ao do repo. A versão continua 2 e só ganha chaves:
  `alterado_portal` (teto 50) e `total_alterado_portal`, que trazem o pedido com divergência ABERTA (o JOIN exige
  `resolvida_em IS NULL`, porque um ponteiro velho não conta), com ou sem pedido de compra e com as diferenças.
  Também `sem_po[].divergencia_aberta`. O alterado entra em `pendentes_unicos` e no dedupe da falha do mesmo
  protocolo (6.4). Em prod, nesta data: 0 divergências desde a 5.2.
- **Card**: seção "Alterado no portal" com até 3 diferenças por linha (`descreverDiferenca` da 5.2; diferença
  ilegível vira "não consegui ler") e o link "Abrir o pedido", onde fica o Aceitar o portal. Na linha sem pedido de
  compra travada pela divergência, o link substitui o "Criar pedido de compra", que seria recusado pelo claim. A
  lista é obrigatória no contrato: sem ela, o card diz "não consegui ler".
- **Provas:** `db/test-sayerlack-painel-alterado-portal.sh` (herda os casos do v2): 48 asserts verdes nos 2 locales.
  Inclui 2 sabotagens novas (sem `resolvida_em IS NULL` e sem o alterado no dedupe), com controle antes e depois. No
  vitest do card, sabotar a troca do botão deixa o teste novo vermelho e o controle verde.
- **Ordem de deploy:** a migration vai antes do Publish. O front novo exige a lista; com o banco velho, o card diria
  "não consegui ler". Nenhuma edge mudou.
- **Recibo:** migration aplicada pelo envelope (#1066) e conferida no psql-ro: corpo novo, SECURITY DEFINER, `anon`
  sem EXECUTE e `authenticated` com EXECUTE. PR #3790 mergeado em 2026-11-10. Publish: founder.

## v1.13 — condição ilegível em TODA importação: o detalhe abre pelo clique (2026-11-11)

- **Sintoma:** desde que a leitura da condição entrou (revisão Fable+Codex), nenhuma importação passou. Foram 8
  tentativas em `acoes_execucoes` (09/11 → 11/11) para 2148220 e 2148223, todas com `etapa: leitura` e
  `motivo: condicao_ilegivel`. Em 100% das evidências, `condicao` veio null e `condicoes_opcoes` veio vazio, e
  nenhum `pedido_compra_sugerido` tem `condicao_portal_lida`. O fail-closed funcionou: nada virou "à vista". Mas o
  robô ficou parado.
- **Causa provada no Chrome logado (só leitura):**
  - A rota estava CERTA: o link do nº na Consulta é `/order-creation-form-edit/<nº>/route/order-viewer`.
  - Nessa tela, `#condicoes_pagamento` existe, com 163 opções, e a função do repo lê "70 - 7 DIAS" em ~1,5 s.
  - No Browserless o select nem existia. O `goto` direto não chega ao detalhe, a mesma armadilha que já fazia a
    Consulta abrir pelo MENU.
- **Conserto:**
  - Função nova `clicarDetalhePedidoDom`: clica no link do nº na linha da consulta. Casa o href pelo FIM, então
    2148220 não abre 21482201. O `goto` fica só de fallback.
  - Antes de ler o select, a edge espera a rede assentar, para nunca ler a opção-padrão de passagem.
  - O passo `detalhe_aberto` ganha `via_clique`. O retrato da tela (`condicao_diag`) e a causa na recusa vieram do
    #3815 (C16, v1.12), mergeado minutos antes; este PR é o conserto que aquele retrato iria apontar.
- **Provas:**
  - vitest do DOM contra o fixture da consulta (que agora tem o link real no nº).
  - Sabotar o casamento para prefixo deixa vermelho só o teste do prefixo, com o controle verde antes.
  - Deno 74/74; `edges:typecheck`, `edges:sintaxe`, `sonda:bump` e `sonda:fingerprint`.
- **Deploy:** `sayerlack-importar-pedido-portal` (v1.13-detalhe-por-clique). `sayerlack-varrer-pedidos-portal` mudou
  só de fingerprint, porque o `_shared` é comum às duas, e entra na mesma leva. Nenhuma migration e nenhum Publish.

## v1.14 — todas as opções de condição do portal (2026-11-11)

- **Sintoma:** as evidências 18–20 (v1.13) trazem a condição lida, mas `condicoes_opcoes` com só 80 itens; o portal
  tem 163. O inventário para o de-para 2.6 "(C)" saía cortado.
- **Conserto:** `lerCondicoesOpcoesDom` sobe o teto de 80 para 200 (o teto só protege contra DOM patológico).
- **Provas:** teste com Selecione + 163 opções (`scripts/sayerlack-portal-dom.test.ts`); com o teto 80 fica
  vermelho (`[80, …]`), controle verde na mesma rodada. Deno, `edges:typecheck`, `edges:sintaxe`, `sonda:bump` e
  `sonda:fingerprint` verdes. O `versao.ts` resumiu v1.1–v1.11 num ponteiro para este diário (o sentinela
  `limpeza-fonte` reprovava 7/71 linhas de código).
- **Deploy:** `sayerlack-importar-pedido-portal` (v1.14-condicoes-opcoes-completas) e
  `sayerlack-varrer-pedidos-portal` (só fingerprint, `_shared` comum). Nenhuma migration e nenhum Publish.
