# Crédito-IA PR 7 — OS da Afiação no gate v2 (plano detalhado)

> Programa: `docs/superpowers/plans/2026-11-20-credito-ia.md` (linha 47). Spec: `docs/superpowers/specs/2026-11-20-credito-ia-design.md` §9/§10.
> Dependências duras: **PR 5** (gate v2 em sombra — RPC service_role sobre `private.credito_avaliar_reservar`) e **PR 6** (fila 🟡 + flag de enforcement dormente). Este PR **não edita** as funções do gate nem `omie-vendas-sync`.

## 1. Mapa do fluxo de hoje (main `37000803f`)

| Passo | Onde | Fato |
|---|---|---|
| Front monta a OS | `src/services/orderSubmission/submitOrder.ts:615-759` | bloco Afiação; `orderId = checkoutId` (:652); `payment_method: payment.afiacaoMethod` (:682); assinatura de idempotência inclui o pagamento (:620-623) |
| Vocabulário do prazo | `src/hooks/useUnifiedOrder.ts:88-96` | `a_vista` (default) · `28dd` · `28_56dd` · `28_56_84dd` · `30dd` · `30_60dd` · `30_60_90dd` |
| Chamada | `src/services/omieService.ts:53-84` | `omie-sync` `action: sync_order` |
| Edge | `supabase/functions/omie-sync/index.ts:1030-1117` | resolve cliente (staff → `customerOmieCode`; cliente → `syncClienteOmie`) e chama `criarOrdemServicoOmie` (:1104) com `montarAssinaturaOS(...)` (:1110) |
| Idempotência #4051 | `afiacao_os_envio` (migration `20261121120002`), `omie-sync/os-idempotente.ts`, `chave-os.ts` | reserva da linha por `order_id` ANTES do `IncluirOS`; `cCodIntOS` = hash(checkoutId, cliente, assinatura) |
| Parcelas | `omie-sync/parcelas-os.ts:10-25` | `PRAZOS[metodo] ?? [0]` — **método desconhecido vira à vista em silêncio**; Parcelas só se `total > 0` (`index.ts:581-586`) |
| Empresa | `omie-sync/index.ts:104-115` | OS é sempre **`colacor_sc`** |
| Título | — | o app **não** cria título; a OS nasce na etapa 10 com parcelas embutidas; o título nasce quando a OS é **faturada no Omie** (fora do app) |
| Crédito hoje | — | **nenhum gate** no caminho da OS (nem o piso 60 d da venda). `payment_method` não é persistido em `orders` |

## 2. Desenho

**Ponto de concessão = edge, não o front.** O front é contornável; quem concede o prazo é o `IncluirOS`. O gate entra em `omie-sync/index.ts` **depois** de resolver o cliente (:1098) e **antes** de `criarOrdemServicoOmie` (:1104). O `submitOrder.ts:615` só ganha o tratamento da resposta `blocked: 'credito'` (dormente).

**Chave da operação.** `credito_decisao_pedido/reserva/solicitacao.sales_order_id` é `uuid` **sem FK** (PR 2) → a OS usa `orders.id = checkoutId`. Para não misturar canais na trilha: coluna/argumento `canal ∈ {'pv','os'}` (a combinar com o PR 5 — ele inclui o parâmetro, ou eu crio um wrapper `credito_gate_os_v2` que chama o núcleo).

**Revisão = assinatura do #4051.** `revisao = montarAssinaturaOS(...)` — a MESMA que entra no `cCodIntOS`. "O que é avaliado é o que é enviado" sai de graça: outro carrinho no mesmo checkout tem outra assinatura → outra revisão.

**Prazo em dias (função pura nova, `omie-sync/prazo-os.ts`).**
- `a_vista` → **não passa pelo gate de prazo** (premissa 4) — retorna `{ gate: false }` e o fluxo segue idêntico a hoje.
- método conhecido → `prazo_dias = max(PRAZOS[m])` (28/56/84/30/60/90).
- método **desconhecido** → `prazo_dias = NULL` → 🟡 `prazo_ilegivel` (ausente ≠ zero). Hoje esse caso vira à vista no Omie (`parcelas-os.ts:25`) — registrado como achado; **não** mudo o comportamento do Omie neste PR.

**Valor.** `orderData.total` — o mesmo número que vira Parcelas. `total` não-finito ou `≤ 0` → `valor = NULL` → 🟡 `valor_indeterminado` (OS sem preço não tem exposição conhecida; medir a frequência na sombra antes de ligar).

**Retry de OS já criada.** Se `afiacao_os_envio.omie_codigo_os` já existe para este `order_id`+chave, o crédito **já foi concedido**: o gate **não** roda de novo (nem em efetivo) — senão um reenvio após resposta perdida bloquearia uma OS que existe. Na sombra, o retry reusa a reserva (`reserva_existente`).

**Modos (flag do PR 6, canal `os`).**
| Flag OS | Comportamento |
|---|---|
| desligado (default) | chama o gate em `modo='sombra'`; **qualquer** desfecho (🟢/🟡/🔴, erro, timeout) só é registrado; a OS segue exatamente o caminho de hoje |
| ligado (ato do Lucas) | `modo='efetivo'`; 🟢 segue; 🔴 → `{ success:false, blocked:'credito', motivo }`; 🟡 → solicitação na fila do PR 6 + `blocked:'credito'`; erro/indeterminado → **fail-closed** (não cria OS) |

Leitura do flag falhou → trata como **desligado** para o bloqueio (premissa 3: sem prova de que ligou, caminho de hoje) — mas registra a falha. *Ponto a validar no Codex.*

**Transferência reserva→título.** O título da OS nasce no faturamento do Omie. A transferência comprovada (PR 5, §9.2) precisa casar `nCodOS`/`cNumOS` → título de `colacor_sc`. Se o PR 5 só casa por PV, a reserva da OS fica **ativa** até um casamento por OS existir → este PR declara o casamento por OS como entrega própria ou pendência explícita (reserva em sombra não afeta nada; em efetivo, sem transferência a exposição contaria em dobro após o faturamento → **condição de ligar o flag da OS**).

## 3. Entregas

1. Migration (se o PR 5 não trouxer o canal): wrapper `public.credito_gate_os_v2(p_order_id uuid, p_codigo bigint, p_revisao text, p_valor numeric, p_prazo_dias int, p_modo text)` service_role, `SECURITY DEFINER`, `search_path=public`, REVOKE PUBLIC/anon/authenticated, `company` fixo `colacor_sc`.
2. Edge `omie-sync` v1.17: `prazo-os.ts` (puro + teste Deno), chamada do gate entre :1098 e :1104, resposta `blocked:'credito'` só com flag ligado. `sonda:bump` + `sonda:fingerprint`.
3. Front `submitOrder.ts` bloco Afiação: trata `blocked:'credito'` (mensagem) — dormente até o flag.
4. Prova PG17 `db/test-credito-gate-os.sh` (LC_ALL=C e pt_BR.UTF-8, falsificação com controle verde): 3 faixas para OS com prazo (🟢 dentro do limite, 🟡 estoura limite/prazo acima/prazo ilegível, 🔴 piso 60 d); à vista não chama; retry reusa reserva; modo sombra não toca reserva efetiva.
5. Prova "flag desligado = caminho de hoje": teste Deno do orquestrador com o gate injetado — flag off e gate devolvendo 🔴/erro → `criarOrdemServicoOmie` chamado com os MESMOS argumentos; flag on + 🔴 → não chamado.

## 4. Premissas (registrar no corpo do PR)

1. Sombra primeiro: grava decisão e reserva simuladas, nunca bloqueia.
2. Bloqueio atrás do flag do PR 6 (canal `os`), dormente; ligar é ato do Lucas.
3. Flag desligado = caminho de hoje (provado no teste do orquestrador).
4. À vista não passa pelo gate de prazo (`afiacaoMethod === 'a_vista'`).
5. Empresa da OS = `colacor_sc`; limite único do grupo (Oben + Colacor + Colacor SC).

## 5. Codex — desenho (2026-11-25, gpt-6.2-astra · max · 362s · 112.923 tokens): 4 P0 + 3 P1 + 1 P2, acatados

| # | Achado | Efeito no plano |
|---|---|---|
| P0-1 | `IncluirOS` ok + `vincular` falha → `omie_codigo_os` NULL; "pular o gate se já tem OS" não cobre, e outra revisão do mesmo checkout pode deslocar a reserva | gate roda **dentro** do orquestrador do #4051, só no ramo de **nova inclusão** (após adquirir a chave); o ramo que recompõe a MESMA OS ativa não reavalia |
| P0-2 | `total` vem do front (serviço "a orçar" soma 0); `update_order` sobe a OS fora do gate | **condição de ligar**: revisão persistida no servidor (preço por linha, centavos, vencimentos) e reavaliação em `update_order` quando valor/prazo sobem |
| P0-3 | flag ilegível → sombra → libera OS 🔴 depois de ligado | modo e decisão resolvidos na MESMA RPC; estado desconhecido com fase ≠ sombra **segura** nova concessão (reconciliar segue) |
| P0-4 | faturamento parcial: reserva inteira = dupla; soltar inteira = descoberto | **condição de ligar**: elo OS→título em `colacor_sc`, transferência parcial atômica; carga de todas as OS expostas antes de ligar |
| P1-1 | núcleo lança `22023` com valor NULL; `valor_indeterminado` fora do CHECK | pendência de precificação explícita (sombra registra sem reserva), piso mantém precedência |
| P1-2 | à vista: vencimento hoje ainda é exposição em trânsito | dispensa só o teste de **prazo** (premissa 4); o valor conta como exposição até o título — decidir com o PR 5 |
| P1-3 | PV e OS no mesmo `(uuid, company)` disputam reserva/exceção; OS 🟡 não tem `orders` para retomar | identidade `(canal, empresa, id_origem)` nos índices/exclusões; revisão persistida antes do gate |
| P2 | método legado: decisão diz ilegível, Omie recebe à vista | resolvedor único para calendário e prazo máximo; sombra registra método recebido e condição aplicada |

**Escopo resultante.** Este PR entrega a **sombra** da OS. O **bloqueio** só entra com P0-2/P0-3/P0-4 resolvidos (revisão server-side, RPC que resolve modo+decisão, transferência OS→título) — código de efetivo com P0 conhecido **não** vai para a main nem dormente.

## 6. Decisão (2026-11-26): caminho B — só documento

O banco de prod mostrou o canal de OS do app parado: 0 OS em 180 d, 0 linhas em `afiacao_os_envio`, 7 OS na vida. Os títulos da Colacor SC nascem no Omie e já entram na sombra do PR 5. As entregas 1–5 acima **não** são feitas agora. Registro, números, condição de retomada (query) e a alternativa C estão em `docs/historico/credito-os-afiacao-2026-11.md`.
