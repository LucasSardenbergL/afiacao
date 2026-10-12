# Status dos pedidos da Colacor congelado (jun–out/2026)

**2026-10-11.** Achado ao investigar o aviso "Dados de venda parciais" do Master, a partir da régua de
cobertura pedidos ÷ DRE do card de crescimento comparável (`crescimento-base-comparavel.md`).

## O defeito

- `criar_pedidos_com_itens` é `ON CONFLICT DO NOTHING`: pedido que já existe e tem item é **no-op**. O
  status fica o da 1ª importação.
- Quem atualiza status a partir do Omie é o reconciliador (`sync-reprocess` → RPC
  `reconciliar_pedidos_omie`, desde 2026-08-30). Os crons dele passam `"account": "oben"` **fixo**. Para a
  Colacor, `orders` rodou 1x à mão em 2026-02-28, antes de a RPC existir; `omie_reconciliado_em` era NULL
  em todos os pedidos dela.
- Até mai/2026 isso não aparecia: os pedidos da Colacor nasciam já faturados. De jun em diante, só
  R$ 4–9k/mês apareciam "faturado" contra R$ 47–83k/mês de receita por competência (DRE).
- Total de receita no app **não** mudava (importado e faturado contam como venda); o que ficava errado
  era o estado do pedido, e qualquer cancelamento no Omie nunca chegaria.

## O conserto (decisão do founder: "só pedidos")

1. **Rodada única, escalonada** (Codex: a rodada não tem aborto global — página confirmada fica):
   - snapshot recuperável antes: 19.834 pedidos + 46.775 itens da Colacor;
   - pré-voo: edge v1.18 no ar (sonda), RPC viva md5 `4b16bbb4…` = `db/deriva-corpo-baseline.json`,
     cota `colacor/ListarPedidos` livre;
   - **canário 7 dias** (`db/2026-10-11-reconciliar-pedidos-colacor-canario.sql`, recibo #349): 1 página,
     0 falha; 11 → faturado, 3 → separação; 6 totais mudaram e **todos fecham no centavo** com edição
     real no Omie (item removido/adicionado, quantidade);
   - **165 dias** (`…-backlog.sql`, recibo #351): 7 páginas, 35 s, 0 falha/ambíguo/item sem código/
     desconto ilegível; 240 → faturado, 22 → separação, 1 → enviado; 70 totais mudaram, todos fechando
     com os itens; 1 preço unitário mudou (R$ 0,80 → R$ 368: pedido lançado provisório e editado no
     Omie — linha trocada de produto). 591 de 592 pedidos da janela reconciliados; 1 (R$ 900) o Omie
     não devolveu (provável exclusão lá). Cliente, data, conta, hash: nenhum alterado.
2. **Recorrente:** ação nova `reprocess_operational_orders` (edge v1.19) — SÓ pedidos, gravada como
   `operational`, sob o mesmo `operational_enabled`. Não usa `reprocess_operational` porque ele também
   roda `reprocessInventory`, que faz upsert em `product_costs`: para a Colacor seria um escritor a mais
   do CMC (o dono é o `syncInventory`). Guardrail em `src/__tests__/edge-money-path-invariants.test.ts`.
   Cron `sync-reprocess-pedidos-colacor-2h` ('40 */2 * * *') + chave VIGIADA
   ('colacor','operational','orders', 4h) no `sync_reprocess_saude`, por patch de âncora no corpo vivo
   (`db/2026-10-11-cron-reconciliar-pedidos-colacor.sql`).

## Lições

- **"Merge do reconciliador" ≠ "reconciliador rodando para todos":** o código suportava a Colacor desde
  sempre; a lacuna era UM literal no body do cron. Sensor de saúde por catálogo explícito não acusa a
  chave que ninguém catalogou nem criou — ausência de cron é invisível para ele.
- **A régua de cobertura do card de crescimento achou o defeito por acaso:** comparar pedidos com o DRE
  por empresa e mês é um sensor barato de sync que vale a pena ter (os dois sentidos apareceram: Colacor
  sub-faturada no status, Oben com pedido aberto no Omie sobrando).
- **Oben (dado do negócio, não bug):** ~90 pedidos/mês (~R$ 110k) ficam abertos no Omie e nunca viram
  nota — inclusive de um ano atrás; o faturado da Oben bate com o DRE. Decisão do founder: mostrar, não
  mudar a régua de receita.
