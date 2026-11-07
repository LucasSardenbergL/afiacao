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
