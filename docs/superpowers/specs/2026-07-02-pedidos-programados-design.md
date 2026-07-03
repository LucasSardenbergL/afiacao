# Pedidos Programados — upload de PDF do cliente → envio agendado ao Omie

**Data:** 2026-07-02 · **Status:** aprovado pelo founder (brainstorm nesta sessão)
**Módulo:** Vendas (`/sales`) · **Money-path:** SIM (gera pedido de venda no Omie)

## Problema

Um cliente específico envia pedidos de compra em PDF com faturamento programado. Hoje o
fluxo é braçal: ler o PDF, traduzir cada item para o produto interno (Oben ou Colacor),
digitar o pedido no Omie na data certa, lembrar de colocar o número do pedido de compra
do cliente nas informações complementares da NF e repetir as mensagens fixas exigidas
por ele. Qualquer esquecimento gera NF recusada/retrabalho.

**Vocabulário (não confundir com o módulo de reposição/compras):** o "pedido de compra"
é documento DO CLIENTE — do nosso lado ele vira um pedido de **VENDA** no Omie
(`omie-vendas-sync` action `criar_pedido`). O nº do PC do cliente entra apenas como
referência no nosso PV e na NF. Nada aqui toca o fluxo de compras a fornecedor.

## Decisões de produto (respostas do founder no brainstorm)

| Pergunta | Decisão |
|---|---|
| Estrutura do PDF | **1 PDF = 1 pedido de compra** (um nº no topo, N itens) — mas cada item tem **DATA ENTREGA própria** (exemplar 213294: 17/06, 24/06 e 20/07 no mesmo PDF) |
| Clientes | **Um cliente específico** — LIDER INDUSTRIA E COMERCIO DE ESTOFADOS S/A, CNPJ 64.422.892/0001-00 (de-para por cliente deixa porta aberta p/ futuros) |
| Empresas | Itens podem sair pela Oben ou pela Colacor; a seleção de itens de um envio é dividida **automaticamente por empresa** (de-para) → até 2 pedidos Omie por envio, ambos com o nº do PC |
| Agendamento | **Seleção manual**: a tela lista todos os itens (cada um com sua data de entrega) e o founder **marca itens** para compor cada envio, que ganha sua própria data de envio. Um PDF gera vários envios ao longo das semanas; itens não selecionados ficam pendentes no pool |
| De-para | **Memorizado**: 1ª vez mapeia manual, sistema memoriza pelo código do item do cliente; item novo **bloqueia** até mapear. O `COD.FORN` impresso no PDF (nosso código!) alimenta **sugestão automática** na 1ª vez — founder só confirma |
| Preço | O preço do PDF **sempre vem errado** → campo pré-preenchido com o **último preço ajustado** daquele item (memorizado); PDF fica só como referência visual |
| Envio | **100% automático na data escolhida** (cron); só envia envio 100% resolvido, senão segura e avisa |
| Mensagens fixas | São **DUAS** (conferidas em pedido real 11691 no Omie): bloco "RECIBO DE ENTREGA..." em **Observações** (`obs_venda`, não sai na NF) e bloco "FORMA DE PGTO BOLETO / Operação contratada..." em **Dados Adicionais para a NF** (`dados_adicionais_nf`, sai nas informações complementares da NF) — configuráveis por empresa |
| Data de entrega do cliente | Extraída **por item** e exibida como informação para decidir a composição dos envios — a data que manda é a data de envio de cada envio |

## Abordagem escolhida (A)

Pipeline completo reaproveitando a infra existente: Storage → edge de extração (LLM) →
tela de conferência → cron canônico → action `criar_pedido` do `omie-vendas-sync`
(idempotência `PV_${sales_order_id}`, guards de preço/produto ativo, credenciais por
empresa — já batalhados em produção).

Rejeitadas: **B** cadastro manual sem PDF (mantém o trabalho braçal que motivou o pedido;
vira fallback se a extração decepcionar) e **C** parser genérico multi-cliente (YAGNI —
1 cliente real hoje).

## Fluxo

1. Upload do PDF numa página nova em `/sales` (staff-only).
2. Edge `pedido-programado-extrair` baixa o PDF do Storage e extrai via Anthropic
   (`claude-sonnet-4-6`, PDF como documento, **forced tool-use** com schema estrito):
   `numero_pedido_compra` (topo), `data_emissao`, e itens
   (`codigo_item_cliente`, `num_ordem_cliente`, `descricao_cliente`, `quantidade`,
   `unidade`, `preco_pdf`, `cod_forn` — nosso código impresso pelo cliente,
   `data_entrega_cliente`). Campo ilegível/ausente → `null` (**nunca** inventar valor).
3. Tela do pedido: **listagem de todos os itens**, cada um com sua data de entrega,
   traduzido pelo de-para → **nossa descrição + código + empresa**; quantidade editável;
   **preço final pré-preenchido com o último ajustado**; item sem de-para destacado,
   com **sugestão automática via `cod_forn`** e busca account-aware em `omie_products`.
4. Founder **marca itens** na listagem → **"Criar envio"** → escolhe a **data de envio**
   daquele grupo. A seleção é dividida automaticamente por empresa (via de-para).
   Repete ao longo das semanas até esgotar o pool; item não selecionado fica `pendente`.
5. Cron diário: envios `agendado` com `data_envio <= hoje` e 100% resolvidos → separa
   itens por account → cria `sales_orders` (modelo existente) → chama `criar_pedido`
   do `omie-vendas-sync` por pedido (até 2 por envio). `data_previsao` = data de envio.
6. Pedido entra no Omie como ordem de venda **aberta (etapa 10)** — o envio programado
   **não fatura**; a NF continua sendo emitida manualmente no Omie, já com as
   informações complementares prontas.

## Campos Omie (conferidos contra pedido real 11691 + exigência no anexo do PDF:
## "FAVOR INFORMAR O NUMERO DO PEDIDO DA LIDER NA NOTA FISCAL")

- **`informacoes_adicionais.dados_adicionais_nf`** (aba "Informações Adicionais → Dados
  Adicionais para a Nota Fiscal" — sai nas informações complementares da NF):
  mensagem fixa da empresa + linha com o nº do pedido do cliente
  (formato exato validado no primeiro envio de teste). Hoje `criarPedidoVenda` NÃO
  preenche esse campo → adicionar **parâmetro opcional** `dados_adicionais_nf` à action
  `criar_pedido` (mudança mínima e aditiva; `omie-vendas-sync/index.ts` é arquivo
  QUENTE — coordenar multi-sessão antes de tocar).
- **`informacoes_adicionais.numero_pedido_cliente`** (campo dedicado "Nº do Pedido do
  Cliente" no Omie): preencher com o nº do PC — cinto e suspensório com a linha acima.
- **`observacoes.obs_venda`** (aba Observações — NÃO sai na NF): mensagem fixa
  "RECIBO DE ENTREGA..." — já suportado via parâmetro `observacao` existente.
- **`inf_adic.numero_pedido_compra` por item**: já suportado via parâmetro
  `ordem_compra` — manter.
- **`cabecalho.data_previsao`** = data de envio do envio.
- Quando um envio mistura empresas, **os dois pedidos Omie carregam o mesmo nº de PC**,
  cada um com as mensagens fixas **da sua empresa**.

### Textos iniciais das mensagens (config Oben — fornecidos pelo founder, editáveis na UI)

`obs_venda` (Observações):

```text
RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL
E-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA.
TRANSPORTADORA: Transporte próprio: Oben Comercio
Declaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se
destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no
âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim
no local indicado acima.
CPF/CNPJ:___________________________________
DATA DA ENTREGA:___/__/____
Nome/ASSINATURA:_________________________________________________
```

`dados_adicionais_nf` (Dados Adicionais para a NF):

```text
FORMA DE PGTO BOLETO

-- --
Operação contratada no âmbito do comércio eletrônico ou do telemarketing. As mercadorias
comercializadas no âmbito do comércio eletrônico ou do telemarketing pelo E-Commerce não
Vinculado deverão ser destinadas exclusivamente a consumidor final, ainda que
contribuinte do imposto, não sendo aplicável às referidas operações o regime de
substituição tributária. MERCADORIA DESTINADA A USO E CONSUMO, vedado o aproveitamento
do crédito nos termos do inciso III do art. 70 do RICMS". E-PTA-RE Nº: 45.000035717-51.
Entrega por ordem do destinatário descrita acima.
```

Textos da **Colacor**: pendência do founder (só bloqueiam envio de item Colacor).

## Dados (novas tabelas — todas com RLS staff-only, padrão do repo)

```text
pedidos_programados            -- 1 linha por PDF (o "pool" de itens)
  id uuid pk
  arquivo_path text            -- Supabase Storage (bucket privado)
  numero_pedido_compra text        -- nº no topo do PDF (ex.: 213294)
  versao text null                 -- "VERSAO.: 2" do PDF, quando presente
  data_emissao_cliente date null   -- informativo
  status text                      -- 'extraindo' | 'ativo' | 'concluido' | 'cancelado'
  extracao_bruta jsonb             -- auditoria do que o LLM devolveu
  created_by uuid / timestamps

pedidos_programados_envios     -- grupo de itens marcado pelo founder p/ envio numa data
  id uuid pk
  pedido_programado_id fk
  data_envio date                  -- escolhida pelo founder
  status text                      -- 'agendado' | 'enviado' | 'erro' | 'cancelado'
  erro_motivo text
  sales_orders_map jsonb           -- account → sales_order_id (retry idempotente:
                                   -- reusa o MESMO sales_order → mesma chave PV_ no Omie)
  timestamps

pedidos_programados_itens      -- 1 linha por item extraído do PDF
  id uuid pk
  pedido_programado_id fk
  envio_id fk null → pedidos_programados_envios   -- NULL = pendente no pool
  codigo_item_cliente text         -- ex.: 3FLA0003M01
  num_ordem_cliente text null      -- ex.: 50072329 (auditoria)
  descricao_cliente text
  quantidade numeric
  unidade text null
  data_entrega_cliente date null   -- POR ITEM (informativo, guia a seleção)
  cod_forn text null               -- nosso código impresso no PDF (semente de sugestão)
  preco_pdf numeric null           -- só referência
  preco_final numeric null         -- o que vale; NULL bloqueia envio (ausente ≠ zero)
  mapa_id fk null → cliente_item_mapa

cliente_item_mapa              -- de-para memorizado + memória de preço
  id uuid pk
  cliente_ref text                 -- identificador do cliente (hoje 1; extensível)
  codigo_item_cliente text         -- UNIQUE (cliente_ref, codigo_item_cliente)
  omie_product_id fk → omie_products(id)   -- carrega account/código/descrição
  ultimo_preco numeric             -- atualizado a cada envio agendado
  timestamps

pedidos_programados_config     -- config (founder edita na UI)
  account text pk ('oben'|'colacor')
  codigo_cliente_omie bigint       -- Oben: 8689689628 (Lider, confirmado por 198
                                   -- títulos em fin_contas_receber até 30/06/2026);
                                   -- Colacor: NULL (cliente não cadastrado lá hoje)
  obs_venda text                   -- mensagem fixa das Observações
  dados_adicionais_nf text         -- mensagem fixa dos Dados Adicionais da NF
```

## Envio automático

- Cron **diário** (padrão canônico: `net.http_post` com `timeout_milliseconds := 150000`
  explícito, secret `x-cron-secret`) → edge processadora (`authorizeCronOrStaff`).
- Sequência por **envio**: revalidar 100% resolvido → separar itens por account →
  criar `sales_orders` → `criar_pedido` (idempotente) → write-back
  (`sales_orders_map`, `status = 'enviado'`); pedido pai vira `concluido` quando todos
  os itens estiverem em envios enviados.
- Retry natural: falha deixa `status = 'erro'` + motivo; o cron do dia seguinte
  reprocessa com segurança (chave determinística `PV_${sales_order_id}` não duplica
  pedido no Omie; reconciliação via `ConsultarPedido` já existe).

## Guard-rails (money-path: precisão > recall)

1. **Só envia envio 100% resolvido**: header sem nº de pedido de compra, item sem
   `mapa_id`, `preco_final` NULL/≤0, quantidade inválida ou config incompleta
   (mensagens fixas vazias, `codigo_cliente_omie` faltando para uma account envolvida)
   → **não envia**, `status='erro'` + motivo na tela. Nada de envio parcial silencioso,
   nada de `String(null)` virando texto de NF.
   Item `pendente` (fora de envio) não bloqueia nada — só fica visível no pool.
2. **Ausente ≠ zero**: extração e preço degradam para `null`, nunca para 0.
3. **Versão/duplicata de PDF**: upload com `numero_pedido_compra` já ativo → avisar e
   oferecer substituir (cancela envios ainda não enviados do antigo); o cliente emite
   revisões ("VERSAO.: 2") e pede aviso de alteração antes do faturamento.
4. Guards existentes na fronteira (`assertOmieItemPricesValid`,
   `assertOmieItemsAtivos`) continuam valendo — o caminho novo passa pela mesma porta.
5. Escrita staff-only ponta a ponta (RLS + `authorizeCronOrStaff` nas edges).
6. `sonner` toast + badge de pendência na lista; integração com Sentinela/e-mail fica
   fora do MVP (status visível na tela é o alarme).

## Testes

- **Extração**: golden test com o PDF real 213294 (5 itens, datas de entrega
  distintas, COD.FORN presente) — resultado esperado conferido a olho uma vez e
  congelado como fixture.
- **SQL/RLS**: harness PG17 local com falsificação (`prove-sql-money-path`) antes do
  apply — inclui prova de RLS sob `SET ROLE authenticated`.
- **Helpers TS** (montagem de payload, agrupamento por account, validação de prontidão):
  vitest (`bun run test`).
- **Ponta a ponta**: primeiro envio real acompanhado — conferir no Omie o pedido, o nº
  do PC e as informações complementares antes de confiar no automático.

## Deploy (Lovable — 3 camadas MANUAIS)

1. Migrations no SQL Editor (skill `lovable-db-operator`).
2. Edges novas + `omie-vendas-sync` alterada via chat do Lovable.
3. Publish do frontend. Verificação via skill `lovable-deploy-verify`.

## Pendências (não bloqueiam o início)

1. ~~Mensagens fixas~~ ✅ fornecidas (Oben) — ver seção de textos. **Colacor pendente.**
2. ~~PDF exemplar~~ ✅ `~/Downloads/LUCAS213294.10375.pdf` (pedido 213294, 2 páginas,
   5 itens) — copiar para fixture de teste na implementação.
3. ~~Cliente~~ ✅ Lider, CNPJ 64.422.892/0001-00; código Omie **Oben 8689689628**
   (confirmado no banco). **Colacor: cliente não cadastrado** — cadastro no Omie é do
   founder, e o código entra na config quando existir.
4. Formato exato da linha do nº do PC dentro de `dados_adicionais_nf` — validar no
   primeiro envio de teste.
