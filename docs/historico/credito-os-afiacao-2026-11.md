# OS da Afiação no gate v2: adiada até o canal ter uso (crédito-IA, PR 7 — 2026-11-26)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` §10 ("OS da Afiação entra nesta entrega") · plano detalhado `docs/superpowers/plans/2026-11-25-credito-ia-pr7-os.md`.

**Decisão:** o PR 7 sai só como documento. Não tem migration, edge nem Publish. O gate da OS fica desenhado e espera o canal de OS do app ter uso. Decisão da sessão-mãe do programa, sob a delegação do Lucas ("implementar até o PR 8 assumindo premissas"): não vale gastar migration e deploy medindo um canal parado.

## O que o banco mostrou (psql-ro, 2026-11-26)

Query versionada: `db/medir-credito-os-canal.sql`.

| Medida | Valor |
|---|---|
| OS enviadas pelo app desde o #4051 (`afiacao_os_envio`) | **0** |
| `orders` (pedido de serviço do app) em 180 d | **0** |
| Espelho `omie_ordens_servico` | 7 na vida, de 07/02 a 26/02/2026 |
| Títulos da Colacor SC em 90 d | 165, R$ ~55 mil, 88 clientes |
| Origem desses títulos no Omie | `MANR` 96 · `APIR` 53 · `RPTR` 16. Nenhum vem do app |
| Categoria `1.01.03` (a da OS do app) | 8 títulos, todos `MANR` |
| Títulos com `numero_pedido` | 0, ou seja, não há elo OS → título |
| Prazo (vencimento − emissão) | 28 d (41) · 0 d (25) · 42 d (12) · 30 d (8) … |

O prazo da Colacor SC é concedido **no Omie**, fora do app. Essa exposição já é medida: `private.credito_sombra_avaliar` (PR 5) soma os títulos de todos os pares do grupo, inclusive os da `colacor_sc`. Uma sombra no caminho da OS do app mediria ~0 indefinidamente (a mesma lição do PR 5: "o app cria ~0").

## Desenho pronto para quando o canal tiver uso

- **Ponto de inserção:** edge `omie-sync`, `case "sync_order"` (`supabase/functions/omie-sync/index.ts`), depois de resolver o cliente (`const orderUserId = …`, :1098) e antes de `criarOrdemServicoOmie(...)` (:1104). Correção do Codex P0-1: o gate fica **dentro** do orquestrador do #4051 (`os-idempotente.ts`), só no ramo de **nova inclusão**. O ramo que recompõe a mesma OS já ativa não reavalia. É o servidor que concede o prazo; o front (`submitOrder.ts:615-759`) só trata `blocked: 'credito'`.
- **Avaliador:** `private.credito_sombra_avaliar(orders.id, 'colacor_sc', nCodCli, valor, prazo_dias)` serve sem edição. Um id fora de `sales_orders` só zera o "título do próprio PV". Lacuna: a soma de reservas faz JOIN em `sales_orders`, então reservas de **outra OS** não entram. Resolver com identidade `(canal, empresa, id_origem)` (Codex P1-3).
- **Revisão:** a assinatura do #4051 (`montarAssinaturaOS`), a mesma que entra no `cCodIntOS`.
- **Prazo:** `a_vista` fica fora do teste de prazo (premissa do Lucas). Mesmo assim o valor conta como exposição até o título chegar (Codex P1-2). Método conhecido → `max(PRAZOS[m])`. Método desconhecido → `NULL` → 🟡 `prazo_ilegivel`. Hoje `parcelas-os.ts:25` manda esse caso ao Omie como à vista, sem avisar (achado, sem conserto aqui).
- **Valor:** `total ≤ 0` ou não finito (serviço "a orçar") → tentativa `valor_ausente`, sem decisão. O avaliador lança `22023` com valor nulo (Codex P1-1).
- **Condições para ligar o bloqueio** (Codex desenho, 4 P0, todos acatados):
  - revisão persistida no servidor (preço por linha, centavos, vencimentos), com reavaliação em `update_order` quando valor ou prazo sobem;
  - modo e decisão resolvidos na MESMA RPC, e estado desconhecido segura a nova concessão;
  - elo OS → título comprovado em `colacor_sc`, com transferência parcial atômica;
  - carga das OS expostas antes de ligar.
- O bloqueio vai atrás do flag de enforcement do PR 6 (#4191), num canal `os` próprio, desligado.

## Condição de retomada (query, não recado)

Seção 0 de `db/medir-credito-os-canal.sql`: `retomar_pr7 = true` ⇔ **≥ 5 OS do app em 30 d** (`afiacao_os_envio.reservado_em`). Em 26/11/2026: `os_app_30d = 0`, `retomar_pr7 = f`.

## Alternativa C, registrada e não feita: sombra sobre as OS do Omie

É onde o prazo da Colacor SC é concedido de fato. Pede:
- um sync novo de `servicos/os/ListarOS` da `colacor_sc` (edge + tabela-espelho + cron, paginando até página vazia);
- um lote de sombra das OS no molde do `credito_sombra_lote` (com o elo OS → título a descobrir, porque hoje `numero_pedido` vem vazio);
- a prova PG17.

**Tamanho estimado:** 2 PRs (sync, depois sombra), cada um com migration + edge, de 1 a 2 sessões no total. Ganho marginal pequeno: a exposição desses títulos já entra na sombra do PR 5. O que a opção C acrescenta é a OS **aberta ainda não faturada**.

**Codex:** desenho = gpt-6.2-astra · max · 362s · 112.923 tokens (4 P0 + 3 P1 + 1 P2, acatados como condições acima) · código = n/a (sem código) · extra = nenhum.
