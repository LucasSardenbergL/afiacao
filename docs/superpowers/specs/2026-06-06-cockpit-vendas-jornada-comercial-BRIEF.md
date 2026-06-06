# BRIEF — Cockpit de Vendas / Jornada Comercial do Vendedor (sessão futura de brainstorming)

**Status:** VISÃO capturada (2026-06-06) — **NÃO implementar agora**; é tema de uma sessão dedicada com `brainstorming`. Pré-requisito entregue: preço-cliente já é o **último preço praticado** (local, rápido, estável — Fase 1, PR #682).

## A visão do founder (verbatim do intent)
Redesenhar **todo o caminho comercial** pra facilitar a vida do vendedor. Hoje o vendedor faz o pedido por **duas origens**:
1. **Liga pro cliente** e faz o pedido.
2. Vem pelo **WhatsApp** e faz o pedido.

> "Tudo que precisamos é **definir as origens dos pedidos** pra entregar o máximo de informação. Misturar isso com a **transcrição da IA em tempo real**, com **upsell, cross-sell**, com **aumento de preço** (aumentou o preço da tabela → o cliente está com preço defasado → ele tem que repassar o aumento). Precisamos redefinir todo esse caminho comercial."

## Eixos a explorar no brainstorming
1. **Origem do pedido (telemetria/contexto):** marcar cada pedido com a origem (ligação / WhatsApp / balcão) → personalizar a tela e medir conversão por canal. Conecta com o motor de rota/ligação (`/rota/ligacoes`) e o inbox WhatsApp já existentes.
2. **Transcrição IA em tempo real:** durante a ligação (WebRTC/Nvoip já existe — §5), transcrever e sugerir ao vivo (itens mencionados, objeções, oportunidades). Já há base: `tarefa-extrair-voz`, `@elevenlabs/react`.
3. **Cockpit na linha do preço** (minha sugestão, deferida): Δ vs tabela (desconto/margem na cara), recência ("há Xd"), última quantidade, trava de margem (anti-subprecificação), sinal de recompra/win-back.
4. **Repasse de aumento de preço (o ponto forte do founder):** quando a TABELA subiu desde a última compra do cliente, sinalizar "preço defasado — repassar aumento" + de quanto, e dar ao vendedor o argumento/cálculo. Money-path direto (recupera margem).
5. **Upsell / cross-sell:** já há engines (`useCrossSellEngine`, `FarmerBundles`) — integrar na jornada do pedido conforme a origem + o que o cliente comprou.

## Dados/infra que já temos (pontos de partida)
- `sales_price_history` (último preço praticado, com data) · `sales_orders.items` (qtd/histórico) · `order_date_kpi`.
- Tabela do produto (`omie_products.valor_unitario`) pra o Δ vs tabela.
- Motor de rota/ligação + inbox WhatsApp + WebRTC/Nvoip + cross-sell/bundles engines.
- ⚠️ Origem do pedido **ainda não é registrada** — provável 1ª fundação (coluna/telemetria).

## Não-objetivos desta nota
Não é um plano nem implementação — é o brief pra abrir a sessão de brainstorming. Quando for, começar pelo `brainstorming` (superpowers) pra desenhar a jornada antes de qualquer código.
