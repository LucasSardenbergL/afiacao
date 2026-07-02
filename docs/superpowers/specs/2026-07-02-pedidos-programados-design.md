# Pedidos Programados — upload de PDF do cliente → envio agendado ao Omie

**Data:** 2026-07-02 · **Status:** aprovado pelo founder (brainstorm nesta sessão)
**Módulo:** Vendas (`/sales`) · **Money-path:** SIM (gera pedido de venda no Omie)

## Problema

Um cliente específico envia pedidos de compra em PDF com faturamento programado. Hoje o
fluxo é braçal: ler o PDF, traduzir cada item para o produto interno (Oben ou Colacor),
digitar o pedido no Omie na data certa, lembrar de colocar o número do pedido de compra
do cliente nas informações complementares da NF e repetir uma mensagem fixa exigida por
ele. Qualquer esquecimento gera NF recusada/retrabalho.

## Decisões de produto (respostas do founder no brainstorm)

| Pergunta | Decisão |
|---|---|
| Estrutura do PDF | **1 PDF = 1 pedido de compra** (um nº no topo, uma data de faturamento, N itens) |
| Clientes | **Um cliente específico**, layout de PDF estável (de-para por cliente deixa porta aberta p/ futuros) |
| Empresas | Um PDF **pode misturar** itens Oben e Colacor → vira **2 pedidos Omie** (um por empresa), ambos com o mesmo nº de PC |
| De-para | **Memorizado**: 1ª vez mapeia manual, sistema memoriza pelo código do item do cliente; item novo **bloqueia** até mapear |
| Preço | O preço do PDF **sempre vem errado** → campo pré-preenchido com o **último preço ajustado** daquele item (memorizado); PDF fica só como referência visual |
| Envio | **100% automático na data escolhida** (cron); só envia se o pedido estiver 100% resolvido, senão segura e avisa |
| Mensagem fixa | Sai **na NF** (informações complementares), junto com o nº do pedido de compra; texto será fornecido pelo founder → **configurável**, nada hardcoded |
| Data de faturamento do cliente | Extraída do PDF e exibida **apenas como informação** — a data que manda é a data de envio escolhida pelo founder |

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
   `numero_pedido_compra`, `data_faturamento_cliente`, itens
   (`codigo_cliente`, `descricao_cliente`, `quantidade`, `preco_pdf`).
   Campo ilegível/ausente → `null` (**nunca** inventar valor).
3. Tela de conferência: cada item traduzido pelo de-para → **nossa descrição + código +
   empresa**; quantidade editável; **preço final pré-preenchido com o último ajustado**;
   item sem de-para destacado com busca account-aware em `omie_products`.
4. Founder confere, ajusta, escolhe **data de envio** → **Agendar**.
5. Cron diário: pedidos `agendado` com `data_envio <= hoje` e 100% resolvidos → separa
   itens por account → cria `sales_orders` (modelo existente) → chama `criar_pedido`
   do `omie-vendas-sync` por pedido.
6. Pedido entra no Omie como ordem de venda **aberta (etapa 10)** — o envio programado
   **não fatura**; a NF continua sendo emitida manualmente no Omie, já com as
   informações complementares prontas.

## Campos Omie (o que a NF precisa mostrar)

- **`informacoes_adicionais.dados_adicionais_nf`** (cabeçalho do pedido — é o campo que
  o Omie leva para as informações complementares da NF): `"<mensagem fixa>\nPedido de
  Compra: <numero>"`. Hoje `criarPedidoVenda` NÃO preenche esse campo → adicionar
  **parâmetro opcional** `dados_adicionais_nf` à action `criar_pedido`
  (mudança mínima e aditiva; `omie-vendas-sync/index.ts` é arquivo QUENTE —
  coordenar multi-sessão antes de tocar).
- **`inf_adic.numero_pedido_compra` por item**: já suportado via parâmetro
  `ordem_compra` — manter.
- Quando o PDF mistura empresas, **os dois pedidos Omie carregam o mesmo nº de PC** e a
  mesma mensagem fixa.

## Dados (novas tabelas — todas com RLS staff-only, padrão do repo)

```text
pedidos_programados            -- 1 linha por PDF
  id uuid pk
  arquivo_path text            -- Supabase Storage (bucket privado)
  numero_pedido_compra text
  data_faturamento_cliente date    -- informativo
  data_envio date                  -- escolhida pelo founder
  status text                      -- 'conferencia' | 'agendado' | 'enviado' | 'erro' | 'cancelado'
  erro_motivo text
  extracao_bruta jsonb             -- auditoria do que o LLM devolveu
  sales_order_ids uuid[]           -- write-back dos pedidos gerados (0..2)
  created_by uuid / timestamps

pedidos_programados_itens      -- 1 linha por item extraído
  id uuid pk
  pedido_programado_id fk
  codigo_item_cliente text
  descricao_cliente text
  quantidade numeric
  preco_pdf numeric null           -- só referência
  preco_final numeric null         -- o que vale; NULL bloqueia envio (ausente ≠ zero)
  mapa_id fk null → cliente_item_mapa

cliente_item_mapa              -- de-para memorizado + memória de preço
  id uuid pk
  cliente_ref text                 -- identificador do cliente (hoje 1; extensível)
  codigo_item_cliente text         -- UNIQUE (cliente_ref, codigo_item_cliente)
  omie_product_id fk → omie_products(id)   -- carrega account/código/descrição
  ultimo_preco numeric             -- atualizado a cada Agendar
  timestamps

pedidos_programados_config     -- config (founder edita na UI)
  account text pk ('oben'|'colacor')
  codigo_cliente_omie bigint       -- cadastro do cliente em cada empresa
  mensagem_fixa text               -- texto que o founder vai fornecer
```

## Envio automático

- Cron **diário** (padrão canônico: `net.http_post` com `timeout_milliseconds := 150000`
  explícito, secret `x-cron-secret`) → edge processadora (`authorizeCronOrStaff`).
- Sequência por pedido: revalidar 100% resolvido → criar `sales_orders` por account →
  `criar_pedido` (idempotente) → write-back (`sales_order_ids`, `status = 'enviado'`).
- Retry natural: falha deixa `status = 'erro'` + motivo; o cron do dia seguinte
  reprocessa com segurança (chave determinística `PV_${sales_order_id}` não duplica
  pedido no Omie; reconciliação via `ConsultarPedido` já existe).

## Guard-rails (money-path: precisão > recall)

1. **Só envia 100% resolvido**: item sem `mapa_id`, `preco_final` NULL/≤0, quantidade
   inválida ou config incompleta (mensagem fixa vazia, `codigo_cliente_omie` faltando
   para uma account envolvida) → **não envia**, `status='erro'` + motivo na tela.
   Nada de envio parcial silencioso.
2. **Ausente ≠ zero**: extração e preço degradam para `null`, nunca para 0.
3. Guards existentes na fronteira (`assertOmieItemPricesValid`,
   `assertOmieItemsAtivos`) continuam valendo — o caminho novo passa pela mesma porta.
4. Escrita staff-only ponta a ponta (RLS + `authorizeCronOrStaff` nas edges).
5. `sonner` toast + badge de pendência na lista; integração com Sentinela/e-mail fica
   fora do MVP (status visível na tela é o alarme).

## Testes

- **Extração**: golden test com PDF real do cliente (founder fornece exemplar).
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

## Pendências do founder (não bloqueiam o início)

1. Texto da **mensagem fixa** (formatação junto ao nº do PC será confirmada com ele).
2. **PDF exemplar** do cliente para calibrar/testar a extração.
3. **Nome do cliente** — os códigos Omie (Oben/Colacor) serão localizados via acesso
   read-only ao banco.
