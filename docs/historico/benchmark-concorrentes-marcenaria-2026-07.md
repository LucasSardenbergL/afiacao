# Benchmark competitivo — distribuidores de marcenaria (2026-07-11)

> Análise de gaps: o que copiar de **7 concorrentes** de distribuição para marcenaria/móveis para o app do cliente (Afiação/Colacor). Método: skill `benchmark-externo` (fonte externa → tabela de gaps com evidência → programa em fases-PR). 2ª opinião pelo **Codex** (`gpt-5.6-sol`, reasoning high). **Status: Onda 1 EM PRODUÇÃO (parcial).** Os 2 quick-wins de maior prioridade saíram (mergeados; Publish do frontend parcial): a aposta principal **#8 — Central da Ferramenta e Serviços v1** (PR #1323) e **#13 — recomendações consultivas determinísticas** (PR #1327 → movidas do dashboard para a Central em PR #1372 → 4ª regra `nunca_afiada`, que empurra a 1ª afiação do cliente novo, em PR #1389 — este também corrigiu o `PriorityCard` da home que dizia "Tudo em dia" a quem nunca afiou). **Ainda NÃO construído:** o resto da Onda 1 (PR3 recompensas próprias, PR4 treinamento contextual, PR5 PWA), as Ondas 2-4 e os itens ✂️ CORTAR / 🟥 deferido — o mapa abaixo segue válido para o que falta.

Concorrentes: **Leo Madeiras, GMAD, Rede PRÓ, Rede Sim, Rede W Brasil, Madeiranit, Gasômetro**. (A "Rede W Brasil" não tem presença digital rastreável — rede regional; modelo idêntico ao da PRÓ/Sim.)

## Tese central (Claude + Codex)

**Não copiar Leo/GMAD no terreno deles.** Copiar as 15 práticas viraria "mini-Leo + mini-TOTVS + mini-banco" e diluiria o único diferencial que os concorrentes **não conseguem copiar**: o ciclo da ferramenta — **afiação → serviço → status → recorrência → ROI comprovado** (`Tools` + `SavingsDashboard`). A aposta é reposicionar isso como o coração do app do cliente, não perseguir nesting/3D/marketplace/BNPL.

## As 15 práticas × app (tabela de gaps, evidência `arquivo:linha` de 2026-07-11)

| # | Prática (benchmark) | Estado | Persona | Evidência | Nota |
|---|---|---|---|---|---|
| 5 | Crédito/financiamento AO cliente (Leo) | 🔴 gap | cliente | só controle de risco: `UnifiedOrder.tsx:23` `AlertaCreditoCliente` (bloqueia, não oferta) | 🟥 money-path |
| 6 | BNPL B2B2C — cliente do marceneiro parcela, marceneiro recebe à vista (GMAIS/G+) | 🔴 gap | cliente | — | 🟥 deferido (perímetro regulatório) |
| 4 | Resgate por benefícios externos (vale-combustível/eletro — Amigo Leo) | 🔴 gap | cliente | `Loyalty.tsx:30` só 2 rewards internos | reposicionar (benefícios próprios) |
| 13 | Consultoria de melhoria de processo ao cliente | ✅ entregue · PR #1327/#1372/#1389 | cliente | Farmer é staff-side (`farmer/*`) | recomendações consultivas determinísticas no app do cliente (4 regras; `nunca_afiada` empurra a 1ª afiação) |
| 1 | Plano de corte / nesting self-service (LeoPlan) | 🔴 gap | cliente | grep vazio | ✂️ CORTAR (sem chapa em escala; integrar via CSV/BOM se houver demanda) |
| 2 | Projeto 3D + orçamento (LeoMob) | 🔴 gap | cliente | grep vazio | ✂️ CORTAR (outro negócio; integrar c/ Promob/LeoMob) |
| 11 | Marketplace multi-fornecedor (Rede PRÓ) | 🔴 gap | cliente | — | ✂️ CORTAR (somos fornecedor único do grupo) |
| 8 | Central de serviços (corte/beneficiamento) | ✅ entregue · PR #1323 | cliente | — | ⭐ Central da Ferramenta e Serviços v1 NO AR (aposta principal); corte/beneficiamento literal segue fora de escopo (foi reposicionamento) |
| 3 | Fidelidade: 1pt/R$ + tiers + resgate rico (Amigo Leo) | 🟡→🔴 mais raso que parece | cliente | `Loyalty.tsx:23` TIERS, `:30` REWARDS(2), ganho por ajuste manual (`loyalty/AdjustDialog.tsx:19`) | 🟥 money-path; Codex: "ajuste manual não é motor de fidelidade" |
| 9 | Rastreio de entrega ao cliente | 🟡→🔴 quase gap | cliente | `OrderDetail.tsx:44` STATUS_LABELS, mas `statusHistory:[]` hardcoded (`:107`) | Codex: fabricar evento inferido NÃO é quick-win |
| 7 | App mobile instalável | 🟡 parcial | cliente+staff | `main.tsx:47` service worker + VitePWA + `sw.js` | polir PWA (manifest/update/offline), não app nativo |
| 14 | Omnichannel integrado | 🟡 parcial | staff | `telefonia`/`whatsapp`/`sales`/`rota/ligacoes`, `Customer360` | falta cronologia única (identidade+dedup+autoria) |
| 10 | E-commerce self-service 24/7 | 🟢 tem | cliente | `new-order`→`UnifiedOrder.tsx:74` catálogo + fora-do-catálogo | validar: e-commerce real vs "pedido eletrônico" c/ retrabalho manual |
| 12 | Treinamento/conteúdo ao cliente | 🟢 tem | cliente | rota `training` (`App.tsx:250`), `admin/training` | tornar contextual (senão vira shelfware) |
| 15 | Indicação member-get-member | 🟢→🔴 gap funcional | cliente | `Gamification.tsx:30` referral_score | Codex: score de gamificação ≠ programa (falta atribuição/conversão/antifraude) |

**Diferencial que nenhum dos 7 tem:** `SavingsDashboard.tsx:55` mostra o **ROI da afiação** (economia vs. comprar ferramenta nova) + gestão de ferramentas (`Tools.tsx`). Ativo a *divulgar*, não gap.

## Correções do Codex à classificação inicial

- **#3, #9, #15 estão mais perto de GAP do que "parcial"** — apresentação (tiers/labels/score) não é a funcionalidade.
- **Money-path (#3):** não usar `loyalty_points` como saldo mutável sem **ledger auditável** (idempotência, unique-constraint anti-duplicação, atômico, pontos só após venda paga, estorno). "Funciona até o primeiro retry concorrente ou estorno retroativo."
- **Margem:** 1pt/R$ bruto destrói margem (Oben-revenda ≠ Colacor-indústria ≠ serviços) → ganho sobre **valor líquido pago, regra por categoria**.
- **Cortes secos:** #1, #2, #11. **Deferir:** #6.

## Programa em fases-PR (priorizado)

### 🎯 Onda 1 — Quick-wins que reusam infra (1 PR cada, sem risco financeiro) · **2/5 entregues (PR1, PR2)**
- ✅ **PR1 — Central da Ferramenta e Serviços v1** (#8) — **entregue (PR #1323)**: home do cliente agregando `Tools`+`Savings`+`recurring-schedules`+`orders`. Só orquestra dado existente.
- ✅ **PR2 — Recomendações consultivas determinísticas** (#13) — **entregue (PR #1327)**, refinado em **#1372** (movidas do dashboard para a Central) e **#1389** (4ª regra `nunca_afiada`, empurra a 1ª afiação do cliente novo; corrigiu o `PriorityCard` "Tudo em dia" a quem nunca afiou): cards determinísticos de `Tools`/`Savings`, nada de inferência.
- ⏳ **PR3 — Catálogo de recompensas próprias** (#3 parcial, SEM ganho automático): expandir `Loyalty` REWARDS (crédito de afiação, frete, treinamento, acessórios, inspeção). Reusa RPC de resgate atômico. 🟥 money-path leve. 🖱️ Publish.
- ⏳ **PR4 — Treinamento contextual** (#12): conteúdo dentro de `Tools`/pedido/`Savings`. 🖱️ Publish.
- ⏳ **PR5 — Polimento PWA** (#7): manifest, install, update de SW, cuidado com preço/estoque obsoleto no cache. 🖱️ Publish.

### 🏗️ Onda 2 — Fundação de dados (destrava #9 e #14)
- ⏳ **PR6 — Ledger canônico de eventos de pedido/serviço.** ⚠️ Codex: popular `statusHistory` com estado inferido é fabricar dado (proibido money-path). **Primeiro investigar se a fonte de eventos existe** — se não, #9 é backend multi-PR. 🟣 migration.
- ⏳ **PR7 — Linha do tempo real no `OrderDetail`** (#9) consumindo PR6. 🖱️ Publish.
- ⏳ **PR8 — Cronologia omnichannel no `Customer360`** (#14): identidade+dedup+autoria. Multi-PR.

### 💰 Onda 3 — Épicos money-path (prove-sql + Codex adversarial OBRIGATÓRIOS)
- ⏳ **PR9+ — Ledger de fidelidade auditável + ganho automático** (#3 completo): idempotência, unique-constraint, pontos só após venda paga, estorno, regra por categoria/margem. 🟥🟥 🟣 migration + 💬 edge/trigger.
- ⏳ **PR12+ — Programa de indicação real** (#15): link/código, atribuição, conversão, antifraude, recompensa no ledger. 🟥 money-path.

### 🔭 Onda 4 — Estratégico condicionado (discovery ANTES de código)
- 🧭 **#5 Crédito via parceiro:** só discovery — medir vendas perdidas por limite/prazo + margem incremental vs. risco. Nunca balanço próprio.
- ⏸️ **#6 BNPL, #1 nesting, #2 projeto 3D, #11 marketplace:** cortados/deferidos. Demanda de projeto → integrar via export CSV/BOM, não construir.

## Rigor money-path (para PR3/PR9/PR12 e qualquer crédito)

Checklist do Codex (prove-sql + review adversarial): identificador idempotente por evento financeiro · unique-constraint anti-duplicação · transação atômica no resgate/consumo · ledger imutável (correção por lançamento compensatório) · pontos só após venda elegível e paga · estorno em cancelamento/devolução/chargeback/desconto posterior · separação empresa/tenant/cliente · RLS anti-leitura-cruzada · reconciliação diária pedido↔pagamento↔ledger · testes de webhook duplicado/fora-de-ordem/concorrência/arredondamento.

## Procedência
- Fonte: busca web (2026-07-11) nos 7 concorrentes — sites oficiais + imprensa setorial (eMóbile, Exame, Mega Moveleiros).
- Parecer Codex completo: rodado via `scripts/codex-async.sh -r high` (background), `DONE_WITH_CONCERNS` (subconsulta ao Codex CLI bloqueada pelo sandbox read-only; análise independente íntegra).
- Método: skill `benchmark-externo`.
