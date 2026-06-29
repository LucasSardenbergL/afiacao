# Ficha de 30s pré-contato — design

**Data:** 2026-06-29 · **Status:** aprovado no brainstorming, aguardando plano de implementação
**Origem:** Frente 3 do Programa UX da Farmer (ver `docs/runbooks/lovable-supabase.md` e `docs/roadmap-sessao.md`).

## Problema

A vendedora (farmer) trabalha a fila de ligação em `RotaListaLigacao`. No **celular** ela disca pelo aparelho (botão Ligar híbrido, #859) — **não** tem o co-piloto ao vivo da ligação WebRTC (`CallCopilotHud`, que só roda no softphone desktop). Hoje, tocar num cliente da lista **não abre nada**: ela liga sem contexto. A ficha de 30s é o dossiê **pré-discagem** que aparece num drawer ao tocar no cliente, pra ela se preparar antes de ligar.

## O que já existe (construir SOBRE, não do zero)

- `useMunicaoLigacao` + `derivarMunicao` (`src/lib/call/municao.ts`, testado): dias desde última compra, última compra, ticket médio dos 8 últimos pedidos **válidos**. READ-ONLY; mandato explícito de nunca criar cadastro.
- `CallCopilotHud` (`src/components/call/`): exibe a munição **ao vivo durante a ligação WebRTC**. Acoplado ao contexto de ligação ativa.

## Escopo (MVP)

**Blocos:**
1. **Munição** (reusada): última compra (há X dias) + ticket médio (n pedidos).
2. **Histórico de compras + preço praticado:** top 5 produtos por recência×frequência (nome · nº de compras · **último preço praticado**) + 3 últimos pedidos (data · valor · nº itens).

**Fora do MVP (decididos no brainstorming, com evidência):**
- **Cores / tintométrico — CORTADO por falta de fonte.** `tint_vendas` não tem nenhuma coluna de cliente (só `operador`/`origem`); a única tabela tint com campo `cliente` (`tint_staging_cores_personalizadas`, texto livre) está **vazia (0 linhas)**. Não há como atribuir cores a um cliente sem fabricar dado.
- **Títulos abertos (financeiro):** fora. Viável no futuro via `fin_contas_receber.omie_codigo_cliente` → `omie_clientes`, mas é dado sensível (inadimplência) — fica pra uma fase posterior, com decisão de permissão.
- **Última conversa (WhatsApp):** fora. Parte do sinal já aparece na própria fila ("contatado há Xd", "sem resposta Nx").

## Arquitetura (unidades isoladas, espelhando o padrão da munição)

1. **Lógica pura** — `src/lib/call/historico.ts` + `historico.test.ts` (TDD)
   `derivarHistorico({ itens, agora }): Historico`, sem banco nem relógio implícito.
   - Input `itens`: `{ codigo, nome, quantidade, precoUnit, dataPedido, statusPedido }[]`.
   - Exclui status inválidos (mesmo conjunto da munição: rascunho/orcamento/cancelado/cancelado_humano).
   - Output:
     - `topProdutos` (≤5): `{ nome, vezes, ultimoPreco, ultimaData }`, ordenado por score recência×frequência.
     - `ultimosPedidos` (≤3): `{ data, valor, nItens }`, mais recentes primeiro (por `dataPedido`).
   - "preço praticado" = `precoUnit` da **compra mais recente** daquele produto.

2. **Hook de dados** — `src/hooks/useHistoricoCompras.ts`
   `useHistoricoCompras(customerUserId): { historico, loading }`.
   - **Lazy:** `enabled: !!customerUserId` — só dispara quando o drawer abre.
   - Busca os itens dos **pedidos válidos** do cliente com a **data do pedido** (`sales_orders.order_date_kpi`, fallback `created_at`) e o **status** (pra excluir inválidos) — via embedding/2-queries, sem N+1.
   - Resolve nomes em **1 query** `omie_products` `in` pelos `omie_codigo_produto` distintos (por `account`). Sem N+1.
   - READ-ONLY. `staleTime: 60_000`. Limite recente generoso (ex. 200 itens) — alinhado ao "8 pedidos" da munição mas com folga pra agregação.

3. **Componente compartilhado** — `src/components/call/MunicaoResumo.tsx`
   Extrai a exibição da munição (hoje embutida no `CallCopilotHud`) → reusada pela ficha **e** pelo HUD (elimina duplicação).

4. **Ficha** — `src/components/call/FichaPreContato.tsx`
   `Sheet` (drawer) do shadcn. Props: `customerUserId`, `name`, `cityKey` (+ `children` como trigger).
   Usa `useMunicaoLigacao` + `useHistoricoCompras`; renderiza `MunicaoResumo` + histórico.
   `PageSkeleton`/skeleton enquanto carrega; `EmptyState` ("sem compras registradas") quando vazio — **nunca número fabricado**.

5. **Plug** — `src/pages/RotaListaLigacao.tsx`
   A área de texto (nome + cidade) do item da fila vira o **trigger** do drawer. Os botões Ligar/Outcome à direita mantêm seus próprios cliques (não viram trigger).

## Modelo de dados

| Campo | Fonte |
|---|---|
| itens (qtd, preço unit) | `order_items` (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) |
| status + data do pedido | `sales_orders` (status, order_date_kpi, created_at) via `sales_order_id` |
| nome do produto | `omie_products.descricao`, casado por `omie_codigo_produto` (+ `account`) |

⚠️ Implementação: casar por `omie_codigo_produto` (não `codigo`, que é `text`); conferir tipos na hora.

## Não-funcionais (invariantes)

- **READ-ONLY** absoluto (jamais `selectCustomer`/escrita) — herda o mandato da munição.
- **Lazy** — carrega 1 cliente por vez, ao abrir; não pesa a lista de ligação.
- **Sem N+1** — itens(+pedido) e nomes em poucas queries fixas.
- **Respeita a lente "Ver como"** — leitura escopada; sem write-path.
- **Derivação testável sem banco** (TDD), igual `derivarMunicao`.
- **Degradação honesta** — ausência de dados vira empty-state, nunca zero fabricado.

## Testes (TDD)

`historico.test.ts`:
- ordenação de `topProdutos` por recência×frequência;
- `ultimoPreco`/`ultimaData` = compra mais recente do produto;
- dedup por produto (soma vezes, não duplica);
- `ultimosPedidos` = 3 mais recentes por data do pedido;
- exclusão de itens de pedidos com status inválido;
- empty (cliente sem compras válidas).

## Não-objetivos

Não toca no motor da fila (`useRouteContactList`), no `CallCopilotHud` além de extrair o `MunicaoResumo`, nem em qualquer write-path. Sem cores, sem financeiro, sem WhatsApp neste MVP.

## Reuso futuro

O `FichaPreContato` é um drawer autônomo (recebe `customerUserId`) → plugável depois no Meu Dia/painel sem reescrever.
