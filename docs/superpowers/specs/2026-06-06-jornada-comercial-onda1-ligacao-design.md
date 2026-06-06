# Jornada Comercial do Vendedor — Onda 1: a LIGAÇÃO (co-piloto de venda ao vivo)

> **Data:** 2026-06-06 · **Status:** spec aprovado em brainstorm (esqueleto), aguardando review do founder antes do plano de implementação · **Origem:** brainstorming com o Lucas (founder) sobre redesenhar toda a jornada comercial do vendedor.
>
> **Idioma:** pt-BR (preferência do projeto). **Escopo deste documento:** a Onda 1 (ligação). As Ondas 2 (WhatsApp) e 3 (balcão) terão specs próprios.

---

## 1. Contexto e problema

A jornada comercial do vendedor está **fragmentada**. As peças existem, mas não conversam:

- O vendedor descobre **quem ligar** numa fila priorizada (`/rota/ligacoes`, motor `buildContactList`), liga pelo **dialer WebRTC**, e a ligação é **transcrita ao vivo** (Deepgram) com **análise SPIN** e **extração de entidades** rodando em tempo real (`claude-spin-analyze`).
- Mas, na hora de **tirar o pedido**, ele cai num `/sales/new` **vazio** e **re-busca o cliente do zero** — perdendo todo o contexto da ligação. O parâmetro `?customer=<user_id>` existe e funciona, mas a ligação não o passa.
- A transcrição ao vivo **já entende** o que o cliente fala (inclusive entidades `type:'product'` e gatilhos de cross-sell), mas isso **não vira item no pedido** nem **sugestão acionável** — o "produto falado" é apenas exibido como badge (`SpinSuggestionCard.tsx:220` literalmente comenta que a resolução para SKU ficou para depois).
- **Nada registra a origem** do pedido (não há coluna de canal em `sales_orders`), então não há como medir conversão por canal nem personalizar a tela por origem.
- **Nada compara** o preço praticado com a tabela atual — quando a tabela sobe, o cliente fica defasado e o vendedor **não sabe** que deveria repassar o aumento (perda de margem direta).

**Personas:** duas farmers — **Regina** e **Tatiana** — fazem a ligação ativa, sentadas no **escritório**, no **desktop/navegador**. Gente treinada, fluxo repetível. Base de design: **monitor único Full HD** (dois monitores = bônus, nunca requisito).

**Objetivo de negócio (founder, verbatim):** "misturar tudo o que criamos até hoje para potencializar o **aumento do ticket** e o **aumento do lucro** naquele pedido." A ligação é "o momento mais fácil de convencimento" — a maior alavanca.

---

## 2. Visão

Uma **Tela de Atendimento** onde a ligação e o pedido vivem **lado a lado**, e um **co-piloto ativo** que:

1. **Municia** o vendedor *antes* de discar (por que ligar, o que o cliente costuma comprar, o que oferecer, que aumento repassar);
2. **Ouve** a conversa (transcrição que já existe), **entende** "me vê 50 do verniz X", e **propõe** o item no carrinho;
3. A vendedora **confirma com um toque** e o pedido **cresce sozinho** enquanto ela fala;
4. **Sugere cross-sell** na hora ("quem leva X costuma levar Y", de maior margem) — para **subir o ticket**;
5. **Protege o lucro** com um **cockpit de preço por linha** (Δ vs tabela · margem/contribuição · repasse de aumento).

O pedido **nasce dentro do palco** e é enviado pelo **mesmo `submitOrder`** que o `/sales/new` já usa — é o mesmo pedido, não uma cópia.

---

## 3. Escopo: as duas vertentes e o foco da Onda 1

A jornada se separa em **duas vertentes**, com comportamentos opostos:

- **Proativa** (nós provocamos): ligação sainte + abordagem no WhatsApp. A tela precisa entregar **munição**.
- **Reativa** (o cliente nos procura): ligação entrante + WhatsApp inbound + balcão. A tela precisa de **velocidade**.

**Ordem de ataque (priorização do founder, por dor × frequência):**

1. **Onda 1 — a LIGAÇÃO** (foco deste spec). Cobre **as duas faces**: entrante (cliente liga) e sainte (nós ligamos). Elas usam a **mesma máquina** (mesma tela de co-piloto + pedido) — muda só o **modo de abertura**: entrante abre em *velocidade* (cliente já quer), sainte abre em *munição* (nós provocamos). A maior alavanca está na **sainte** (proativa).
2. Onda 2 — WhatsApp (spec próprio).
3. Onda 3 — Balcão (spec próprio).

---

## 4. Decisões (âncoras do design)

Decisões fechadas no brainstorm, que governam todo o resto:

1. **Onda 1 = a ligação inteira** (entrante + sainte), uma única tela de trabalho com dois modos de abertura.
2. **Palco = Tela de Atendimento dedicada** (layout A): co-piloto à esquerda, pedido à direita, num layout próprio. **Não** se mexe no `/sales/new` atual (que é money-path com trabalho em voo). O pedido é **embutido** na tela, reusando o motor existente.
3. **O pedido nasce dentro do palco** — reusa `useUnifiedOrder` + os blocos de item/carrinho + o `submitOrder`. É o **mesmo pedido**; o `/sales/new` standalone segue existindo para os demais fluxos (balcão, edição avulsa, cliente que entra direto).
4. **Preparar antes de discar.** Ao escolher o cliente na fila, a tela abre em **modo preparação** com a munição **pré-carregada** (a fila já sabe quem é) e **enxuta** (escaneável em segundos) + o pedido **já adiantado com a recompra provável** (em rascunho). Ela lê, clica "Ligar", e a tela vira o **modo ao vivo**. A munição não some — vira pano de fundo do co-piloto.
5. **O co-piloto PROPÕE; a vendedora CONFIRMA** (1 toque). A IA **nunca** adiciona item ao pedido firme sozinha — transcrição erra, e pedido é dinheiro. Espelha o princípio do projeto (a IA monta a cesta; o humano dá o gate no que vira pedido/preço).
6. **Cockpit de preço — régua = contribuição.** Não há margem mínima formal; o único piso é **não dar contribuição negativa** (não vender abaixo do custo). Faixas: 🟢 pode fechar · 🟡 defasado/repassar ou margem baixa · 🔴 contribuição negativa · ⚪ sem dado confiável.
7. **Custo = `cmc` (Custo Médio Contábil do Omie)**, lido de `inventory_position.cmc` — **não** `product_costs.cost_price` (proxy `DEFAULT_PROXY`, infla ~2×). Sem `cmc` confiável → cockpit fica **neutro** (⚪), nunca inventa "prejuízo".
8. **Repasse de aumento — cheio, de uma vez.** Quando o preço praticado do cliente está abaixo da tabela atual, o co-piloto já preenche o **preço novo de tabela cheio** + um **argumento** pronto para sustentar ("houve reajuste do fornecedor em tal mês; este é o preço atualizado"). Sem suavização gradual.
9. **Origem do pedido é gravada** (fundação) — toda venda registra de qual origem nasceu (`ligacao_sainte`, `ligacao_entrante`, `whatsapp`, `balcao`, `web_staff`, `web_customer`…).

---

## 5. O que já existe (reuso) — mapa de conexão

O loop que o founder descreveu **já existe em pedaços**; o trabalho é **conectar + adicionar o cockpit**, não construir do zero.

| # | Etapa | Estado | Onde |
|---|---|---|---|
| 1 | Transcrição ao vivo (vendedor + cliente, separados) | ✅ existe | `src/lib/transcription/{transcription-engine,deepgram-client}.ts`, `src/hooks/useTranscription.ts`; shape `TranscriptTurn` em `src/lib/transcription/types.ts:3-15` |
| 2 | LLM ao vivo a cada fala-final do cliente (debounce 3s) — já extrai entidades `type:'product'` + `crossSellTriggers` | ✅ existe (mira concorrente; `productHint` vira badge, não SKU) | `src/hooks/useSpinAnalysis.ts` → edge `supabase/functions/claude-spin-analyze/index.ts` (Anthropic `claude-sonnet-4-6`, forced tool); shapes em `src/lib/spin/types.ts:33-89` |
| 3 | Resolver "nome falado" → SKU do catálogo (fuzzy + correção de código + dedup de embalagem + multi-conta) | ✅ existe (não plugado na ligação; usa gateway Gemini legado) | edge `supabase/functions/analyze-unified-order/index.ts` |
| 4 | Empurrar item no carrinho com preço-cliente | ✅ existe (`handleUnifiedAIResult` já é "a IA empurrando item") | `addProductToCart(product, qty)` em `src/hooks/unifiedOrder/useCart.ts:79`; handler em `src/hooks/useUnifiedOrder.ts:482-509`; preço via `getProductPrice` (`useUnifiedOrder.ts:236-241`) |
| 5 | Confirmar item com 1 toque | ✅ existe (fora da ligação hoje) | `UnifiedAIAssistant` / `AIResultPanel` / `confirmItems` |
| 6 | Abrir o pedido já com o cliente carregado | ✅ `?customer=<user_id>` funciona | `src/pages/UnifiedOrder.tsx:52-70` → `selectCustomerByUserId` (`useUnifiedOrder.ts:463`); aceita objeto via `selectCustomer` (`useCustomerSelection.ts:346`) |
| 7 | Motor da ligação sobrevive à navegação (provider global) | ✅ existe | `WebRTCCallProvider` em `src/App.tsx:199` (acima das rotas); contrato em `WebRTCCallContext.tsx:36-83` |
| 8 | Cliente identificado pelo telefone (entrante e sainte) | ✅ existe (mas só em refs locais — **não exposto reativamente**) | `resolveCallParty` (`src/lib/call-log/recording-policy.ts:24`) → `resolveCustomerByPhone` (`src/lib/call-session/resolve-customer.ts:24`) |

**Insumos de dados para o cockpit (já presentes):** preço praticado + data (`sales_price_history`), preço de tabela (`omie_products.valor_unitario`), custo real (`inventory_position.cmc`), recência/intervalo (`customer_metrics_mv`), última qtde (`customer_preferred_items`).

---

## 6. O que falta (gaps)

1. **Coluna `origem`** em `sales_orders` + gravar no `submitOrder` (`src/services/orderSubmission/submitOrder.ts:104,192`). Hoje não existe.
2. **Expor o cliente da ligação no contexto** — adicionar `currentParty`/`currentCustomerUserId` ao `WebRTCCallContextValue`, setado onde `resolveCallParty` já roda (`makeCall:347` e handler inbound `:209`). É a peça que falta para a ponte.
3. **A Tela de Atendimento** (layout A): rota e layout novos, reusando o motor do pedido + os painéis de transcrição/SPIN (hoje `TranscriptionPanel` vive só em `/farmer/calls`, `fixed right-0`; precisa virar inline no palco).
4. **Extração fala→item plugada na ligação** (Fase 2): a partir dos `transcriptionTurns`, extrair produto+qtd e propor no carrinho.
5. **Resolver `crossSellTriggers`/`entitiesExtracted(type:'product')` → SKU** (Fase 2): reusar o matcher para transformar os hints que o `claude-spin-analyze` já produz em sugestões acionáveis.
6. **O cockpit de preço** (Fase 3): cálculos novos (Δ vs tabela, contribuição via `cmc`, detecção de defasagem e repasse) — os insumos existem, a derivação não.

---

## 7. Arquitetura por unidade

Cada unidade tem um propósito único, interface clara, e pode ser entendida/testada isolada.

### 7.1 Tela de Atendimento (palco)
- **O que faz:** orquestra os dois modos (preparação → ao vivo), com co-piloto à esquerda e pedido à direita.
- **Como se usa:** rota nova (ex. `/atendimento/:customerUserId` ou `/rota/atender/:userId`), aberta a partir da fila. Renderiza dentro do `AppShellLayout` (herda shell/auth/provider).
- **Depende de:** `useWebRTCCall()` (estado da ligação), `useUnifiedOrder` (o pedido), a fila (para a munição).
- **Layout:** grid de duas zonas (ex. `lg:grid-cols-[minmax(380px,40%)_1fr]`), larguras sob controle. Em monitor estreito, vira abas/empilhado (degrada para mobile, mas o caso-base é desktop).

### 7.2 Co-piloto (coluna esquerda)
- **O que faz:** no modo preparação, mostra a **munição** (gancho + recompra provável + oferta sugerida + flag de aumento) + botão "Ligar". No modo ao vivo, mostra a **transcrição** (bolhas), as **sugestões** (item/cross-sell/objeção) e os **controles da call** (mudo, encerrar, timer).
- **Como se usa:** consome `transcriptionTurns`, `spinAnalysis`, `callState`, `callDuration` do contexto global; reusa `TranscriptionPanel`/`SpinSuggestionCard` (inline, não `fixed`).
- **Depende de:** `WebRTCCallContext` (já roda transcrição + SPIN quando `callState==='established'`).

### 7.3 Pedido embutido (coluna direita)
- **O que faz:** o pedido sendo montado — busca/adiciona item, lista do carrinho com cockpit por linha, total + margem, enviar.
- **Como se usa:** reusa `useUnifiedOrder` (lógica) + os blocos `ProductItemForm`/`CartItemList`/checkout, num layout próprio (sem o container `max-w-5xl` da página). Envio = `submitOrder` (mesmo de hoje), com `origem` preenchida.
- **Depende de:** `useUnifiedOrder`, catálogo, `sales_price_history` (preço-cliente).

### 7.4 Motor de extração fala→item (Fase 2)
- **O que faz:** dado o trecho recente da transcrição (ou o turno marcado), extrai `{produto_falado, quantidade, embalagem}` e resolve para SKU.
- **Como se usa:** **provider canônico = Anthropic direto** (edge nova `produto-extrair-voz` no molde do `tarefa-extrair-voz`: extrai **strings cruas**, não resolve SKU) **+** o **matcher determinístico** extraído de `analyze-unified-order` para um **helper puro** compartilhável (`src/lib/...`, com testes). Output no shape `AIOrderResult` → `handleUnifiedAIResult`. Alternativa de menor esforço: reusar `analyze-unified-order` direto (Gemini legado) — decidir no plano da Fase 2.
- **Depende de:** transcrição, catálogo do cliente já carregado.

### 7.5 Cockpit de preço (Fase 3)
- **O que faz:** por linha do pedido, calcula Δ vs tabela, contribuição (preço − `cmc`) e detecta defasagem; classifica 🟢🟡🔴⚪; no caso defasado, sugere o preço novo cheio + argumento.
- **Como se usa:** **helper puro TDD** (`src/lib/...`), entrada = {preço praticado, preço tabela, cmc}, saída = {faixa, Δ%, contribuição, sugestão de repasse}. Componente de UI por linha + um resumo no rodapé (ticket + margem).
- **Depende de:** `sales_price_history` (praticado), `omie_products.valor_unitario` (tabela), `inventory_position.cmc` (custo). Degradação honesta: sem `cmc`/tabela → ⚪.

### 7.6 Fundação
- **Migração:** coluna `origem text` em `sales_orders` (+ índice se necessário p/ analytics). Gravar em `submitOrder`.
- **Context:** `currentParty`/`currentCustomerUserId` no `WebRTCCallContext`.

---

## 8. Fluxo ponta a ponta

```
[Fila do dia / rota]  ──clica no cliente──▶  [Tela de Atendimento · modo PREPARAÇÃO]
                                              ├─ esquerda: munição (gancho, recompra, oferta, aumento) + "Ligar"
                                              └─ direita: pedido adiantado com recompra provável (rascunho)
        │
        │ clica "Ligar"  (sainte)   /   cliente liga → abre já aqui (entrante)
        ▼
[Tela de Atendimento · modo AO VIVO]
   ├─ esquerda: transcrição + sugestões (item/cross-sell/objeção) + controles da call
   └─ direita: pedido cresce — IA PROPÕE item da fala → vendedora CONFIRMA (1 toque)
                cockpit por linha (Δ tabela · contribuição · repasse de aumento)
        │
        │ "Enviar pedido"  →  submitOrder (mesmo de hoje)  →  grava `origem`
        ▼
[Pedido enviado · loop da fila fechado · outcome registrado]
```

---

## 9. O cockpit de preço (régua detalhada)

| Faixa | Condição | O que mostra |
|---|---|---|
| 🟢 Verde | preço ≥ tabela atual **e** contribuição saudável | discreto — "pode fechar" |
| 🟡 Amarelo | preço **abaixo da tabela atual** (defasado) **ou** margem/contribuição baixa | "Repassar: tabela subiu — sugira R$ X (cheio)" + argumento; ou "margem apertada" |
| 🔴 Vermelho | preço **abaixo do `cmc`** (contribuição negativa) | aviso forte — "está no prejuízo"; venda não deveria sair assim sem decisão consciente |
| ⚪ Cinza | sem `cmc` confiável **ou** sem tabela | "—" (neutro, não inventa) |

**Repasse de aumento:** detecção = `último preço praticado (sales_price_history) < tabela atual (omie_products.valor_unitario)`. Ação = preencher o **preço novo cheio** + argumento. (Decisão consciente: empurrar de uma vez, sem distinguir "defasado por aumento" de "desconto negociado" — ambos sobem para a tabela; o founder optou por repasse cheio.)

---

## 10. Fatiamento em fases

Cada fase entrega valor sozinha, em ordem crescente de risco. Cada uma vira seu próprio plano (writing-plans) e PR.

- **Fase 0 — Fundação.** Coluna `origem` em `sales_orders` + gravar no `submitOrder` + expor `currentParty` no `WebRTCCallContext`. Pequena; destrava medir canal e a ponte. (Migração manual via Lovable — ver §15.)
- **Fase 1 — Palco + ponte.** A Tela de Atendimento (layout A) reusando o motor do pedido; fila → preparação (munição + recompra adiantada) → ligar → pedido embutido. Co-piloto mostra a transcrição/SPIN que **já existem**. **Sem** IA-monta-da-fala ainda — a vendedora monta manual no palco, com o pedido já adiantado. **Já tira pedido na ligação, sem risco da IA.**
- **Fase 2 — Co-piloto ativo.** Extração fala→item (propõe/confirma) + cross-sell ao vivo (resolver `crossSellTriggers`→SKU). A "mágica", sobre a base sólida.
- **Fase 3 — Cockpit de preço.** Δ vs tabela · contribuição (`cmc`) · repasse de aumento cheio + argumento. Defender o lucro.

> **Primeira a implementar:** Fase 0 (+ início da Fase 1). As Fases 2 e 3 serão detalhadas em seus próprios specs/planos quando chegarmos nelas.

---

## 11. Decisões técnicas-chave

- **Provider de LLM ao vivo = Anthropic direto** (canônico do projeto, §"LLM em edge function" do CLAUDE.md): `ANTHROPIC_API_KEY` + `@anthropic-ai/sdk` + `claude-sonnet-4-6` + prompt caching + forced tool-use + gate `authorizeCronOrStaff`. Referências: `claude-spin-analyze`, `tarefa-extrair-voz`. (O `analyze-unified-order` usa o gateway Gemini legado; reusável, mas não o padrão para código novo.)
- **Custo = `cmc`** (`inventory_position.cmc`), não `product_costs` (proxy). Casar por `account`.
- **Pedido = mesmo `submitOrder`** (money-path intocado); só acrescenta `origem`.
- **Propõe/confirma** — nunca auto-add no pedido firme.
- **Helpers puros + TDD** para a lógica de matching (Fase 2) e do cockpit (Fase 3), espelhando o padrão do projeto (lógica testável isolada da UI/edge).
- **Degradação honesta** em todo dado ausente (sem `cmc`/tabela → ⚪; sem catálogo → não propõe; transcrição ruim → matcher com confiança baixa não propõe).
- **Reuso do `?customer=`** para a ponte (já em produção); a ligação passa a alimentar o `currentCustomerUserId`.

---

## 12. Não-objetivos (v1 / Onda 1)

- A vertente **reativa** detalhada (entrante tem o mesmo palco, mas o "modo velocidade" rico fica para refino posterior; balcão é Onda 3).
- **WhatsApp** (Onda 2) e **balcão** (Onda 3).
- **Suavização** de aumento (gradual) — decidido repasse cheio.
- **Margem mínima configurável** — o piso é contribuição zero, derivado do `cmc`.
- **Auto-adicionar item** sem confirmação humana.
- Atender vendedores além de **Regina e Tatiana** / dispositivos além de **desktop** (mobile é degradação, não foco).
- **Mexer no `/sales/new`** atual (preservado; o palco reusa o motor, não a página).

---

## 13. Riscos e mitigações

- **Transcrição imprecisa → item errado.** Mitigação: propõe/confirma (humano no gate) + matcher com nível de confiança (baixa confiança não propõe).
- **Colisão com trabalho em voo.** Telefonia ([#689](https://github.com/LucasSardenbergL/afiacao/pull/689) — modal de chamada entrante), Meu Dia ([#690](https://github.com/LucasSardenbergL/afiacao/pull/690)), preço/cor do pedido (worktrees ativas). Mitigação: o palco é tela nova e **não** toca `/sales/new`; a Fase 0 (context/migração) coordena com a telefonia.
- **`cmc` ausente em alguns SKUs.** Mitigação: degradação honesta (⚪), nunca alarme falso.
- **Latência/custo do LLM ao vivo.** Mitigação: o ciclo já existe com debounce 3s + prompt caching; a extração de item entra no mesmo gatilho.
- **Complexidade do layout A.** Mitigação: reuso máximo (motor do pedido + painéis de transcrição já prontos); o esforço real é o layout e a ponte, não os motores.

---

## 14. Métricas de sucesso

- **Ticket médio** dos pedidos originados em ligação (antes × depois).
- **Margem média** desses pedidos (e taxa de itens 🔴 evitados).
- **Taxa de aplicação do repasse de aumento** (itens defasados que subiram para a tabela).
- **% de itens aceitos via sugestão da IA** (proposta → confirmada).
- **Conversão por origem** (destravada pela coluna `origem`).
- **Tempo de montagem** do pedido na ligação (proxy de fricção).

---

## 15. Coordenação e dependências

- **Migração manual (Lovable):** a coluna `origem` (Fase 0) precisa ser aplicada via SQL Editor do Lovable (o Lovable não aplica migrations custom automaticamente). Usar a skill `lovable-db-operator`.
- **Deploy de edge manual (Lovable):** a edge da Fase 2 (`produto-extrair-voz`, se for o caminho Anthropic) precisa de deploy via chat do Lovable.
- **Publish do frontend manual (Lovable):** o palco (Fase 1) só vai ao ar após Publish no editor do Lovable.
- **PRs em voo:** coordenar com [#689](https://github.com/LucasSardenbergL/afiacao/pull/689) (telefonia) e [#690](https://github.com/LucasSardenbergL/afiacao/pull/690) (Meu Dia) — ver §14 do CLAUDE.md (uma sessão por worktree; checar `gh pr list` antes de implementar).

---

## 16. Arquivos-âncora (refs de código)

- **Ligação / contexto global:** `src/contexts/WebRTCCallContext.tsx` (contrato `:36-83`; `makeCall:347`, inbound `:209`), `src/App.tsx:199` (provider global), `src/components/AppShellLayout.tsx:55-65` (overlays globais).
- **Transcrição / SPIN ao vivo:** `src/lib/transcription/{types,transcription-engine,deepgram-client}.ts`, `src/hooks/{useTranscription,useSpinAnalysis}.ts`, `src/lib/spin/types.ts:33-89`, `supabase/functions/claude-spin-analyze/index.ts`, `src/components/call/{TranscriptionPanel,SpinSuggestionCard}.tsx`, `src/pages/FarmerCalls.tsx:476-499`.
- **Resolver fala→SKU (referências):** `supabase/functions/analyze-unified-order/index.ts` (matcher), `supabase/functions/tarefa-extrair-voz/index.ts` (molde Anthropic de extração crua).
- **Pedido:** `src/hooks/useUnifiedOrder.ts` (`:236-241` preço, `:463` `selectCustomerByUserId`, `:482-509` `handleUnifiedAIResult`), `src/hooks/unifiedOrder/{useCart,useCustomerSelection,types}.ts`, `src/pages/UnifiedOrder.tsx:52-70` (deep-link `?customer=`), `src/services/orderSubmission/submitOrder.ts:104,192` (insert em `sales_orders`).
- **Cliente da ligação:** `src/lib/call-log/recording-policy.ts:24`, `src/lib/call-session/resolve-customer.ts:24`.
- **Cockpit (insumos):** `sales_price_history`, `omie_products.valor_unitario`, `inventory_position.cmc`, `customer_metrics_mv`, `customer_preferred_items`.
