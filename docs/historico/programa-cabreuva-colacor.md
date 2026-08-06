# Programa Cabreúva-Colacor (benchmark: CD da Renner)

> Fonte: [Brazil Journal — "Cabreúva: o mega CD que vai colocar a Renner 'sete anos à frente da concorrência'"](https://braziljournal.com/cabreuva-o-mega-cd-que-vai-colocar-a-renner-sete-anos-a-frente-da-concorrencia/) (14/07/2026).
> Processo: skill `benchmark-externo` (tabela de gaps com evidência → priorização Codex → fases-PR). Sessão 2026-08-03.

## Leitura do benchmark

CD de R$ 1,3 bi que mudou a operação da Renner: abastecimento por SKU conforme demanda do ponto de venda (fim do pack fixo), estoque único omnicanal ("quem compra primeiro"), e-commerce tão rentável quanto loja (economia POR CANAL medida), margem via menos remarcação/estoque enxuto, picking unitário numa esteira só, entrega consolidada multi-marca, plataforma que dá "day zero" a marca nova, ROIC como bússola (14,7%→20% até 2030).

**Padrão do gap aqui:** a Renner dos DIAGNÓSTICOS nós já somos (motor de reposição por SKU, baixo-giro, venda-perdida, picking mobile, 3 empresas numa plataforma). O que falta é a Renner das AÇÕES e da PONTA: reservar (ATP), sugerir (reabastecimento por cliente), desovar (excesso→campanha), expedir (romaneio/consolidação), medir por canal.

**Achado de dado que reordenou o programa (psql-ro 2026-08-03):** `sales_orders.origem` é ~100% NULL — 30.650 pedidos, **1** classificado; 12 meses com ZERO pedido real nascido no app (1 teste em jun/2026). Toda a venda entra pelo ERP (Omie). Logo "margem por canal" nasce como **espelho de digitalização da venda**, e a adoção do canal digital (pedido sugerido staff → cliente) é A alavanca, não um nice-to-have.

## Tabela de gaps (evidência da varredura, 2026-08-03)

| Prática Renner | Estado | Evidência |
|---|---|---|
| Estoque único com reserva/ATP | 🔴 gap | `submitOrder.ts` não checa nem reserva saldo |
| Expedição/entrega consolidada | 🔴 gap | zero arquivos `expedic`; picking termina em `concluido` (`picking_bridge.sql`) |
| Consolidação do grupo na ponta | 🔴 gap | nada cross-company; grupos financeiros existem (`useGrupoFinanceiro.ts`) |
| Pedido sugerido por consumo | 🟡 parcial | `RecommendationsPanel` é contextual (pedido/Customer360); nada calcula reabastecimento |
| Rentabilidade por canal | 🟡 parcial | `origem.ts:31` grava; financeiro não consumia (**PR1 fecha**) |
| Excesso com AÇÃO de desova | 🟡 parcial | baixo-giro diagnostica; "Resolver" era stub `toast.info` (**PR2 fecha**) |
| GMROI/capital em estoque exec. | 🟡 parcial | `capital_excedente_rs` no baixo-giro; Cockpit de Valor tem capital por SKU (**PR3**) |
| Linha nova "day zero" | 🟡 parcial | cadeia-logistica + sla-fornecedor + grupos-producao (parametrização espalhada) |
| Reposição por SKU (compra) | 🟢 tem | `admin/reposicao/sessao/*` |
| Picking unitário esteira única | 🟢 tem | `admin/estoque/picking` + `TouchPickingView` + `picking_tasks` |
| Plataforma multi-empresa | 🟢 tem | `CompanyContext` (colacor/oben/colacor_sc) |

## Fases (prioridade Codex 2026-08-03: duas pistas)

**Pista A — quick-wins:**
- 🔄 **PR1 — Margem por canal + espelho de digitalização** no Cockpit de Valor (aba "Por canal"; edge `fin-valor-cockpit` devolve `porCanal`; helpers espelhados + vitest). 💬 redeploy da edge · 🖱️ Publish.
- ⏳ **PR2 — Desova acionável:** "Resolver" do baixo-giro → criar campanha (reuso de Promoções/Negociação), rascunho + piso de preço + aprovação humana. money-path preço.
- ⏳ **PR3 — Giro executivo no Cockpit:** capital em estoque + margem TTM + retorno-sobre-estoque rotulado proxy (CMC ausente = indisponível).

**Pista B — épicos (ordem de dependência):**
- ⏳ **ATP/reserva (P0, 3 fases):** pool por conta/depósito + reserva atômica → checkout idempotente → reconciliação Omie + órfãs. prove-sql + Codex por fase.
- ⏳ **Pedido sugerido (3 fases, após ATP):** perfil cliente×SKU → sugestão explicável staff → opt-in do cliente. Sem autoenvio.
- ⏳ **GMROI completo (2 fases):** estoque médio histórico + metas por classe com link pra desova.
- ⏳ **Expedição (3 fases):** remessa/romaneio → ondas por cliente/rota → rastreio/POD.
- ⏳ **Consolidação do grupo (3 fases, por último):** identidade canônica → plano único de entrega (docs fiscais separados por CNPJ) → SLA único. Crítico fiscal (aliases, CLAUDE.md §5).

Riscos money-path por item e fases detalhadas: parecer Codex na sessão de origem. Status vive no PR de cada fase.
