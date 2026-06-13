# Jornada Comercial do Vendedor — Onda 1: a LIGAÇÃO (co-piloto de venda ao vivo)

> **Data:** 2026-06-06 · **Status:** spec revisado com 1 passe adversário do Codex (achados incorporados — ver §18); aguardando review final do founder antes do plano da Fase 0 · **Origem:** brainstorming com o Lucas (founder).
>
> **Idioma:** pt-BR. **Escopo:** a Onda 1 (ligação). As Ondas 2 (WhatsApp) e 3 (balcão) terão specs próprios.

---

## 1. Contexto e problema

A jornada comercial do vendedor está **fragmentada**. As peças existem, mas não conversam:

- O vendedor descobre **quem ligar** numa fila priorizada (`/rota/ligacoes`, motor `buildContactList`), liga pelo **dialer WebRTC**, e a ligação é **transcrita ao vivo** (Deepgram) com **análise SPIN** e **extração de entidades** rodando em tempo real (`claude-spin-analyze`).
- Mas, na hora de **tirar o pedido**, ele cai num `/sales/new` **vazio** e **re-busca o cliente do zero** — perdendo o contexto da ligação. O parâmetro `?customer=<user_id>` existe e funciona, mas a ligação não o passa.
- A transcrição ao vivo **já entende** o que o cliente fala (entidades + gatilhos de cross-sell), mas isso **não vira item no pedido** nem **sugestão acionável** — o "produto falado" é só um badge (`SpinSuggestionCard.tsx:220`).
- **Nada registra a origem** do pedido (sem coluna de canal em `sales_orders`) → sem medir conversão por canal nem personalizar por origem.
- **Nada compara** preço praticado × tabela atual → o vendedor não sabe quando o cliente está defasado (perda de margem direta).

**Personas:** duas farmers — **Regina** e **Tatiana** — fazem a ligação ativa, no **escritório**, **desktop/navegador**. Base de design: **monitor único Full HD** (dois = bônus, nunca requisito).

**Objetivo de negócio (founder):** "potencializar o **aumento do ticket** e o **aumento do lucro** naquele pedido." A ligação é "o momento mais fácil de convencimento" — a maior alavanca.

---

## 2. Visão

Uma experiência onde a ligação e o pedido vivem **lado a lado**, e um **co-piloto** que:

1. **Municia** o vendedor *antes* de discar (por que ligar, recompra provável, o que oferecer, defasagem de preço) — **em modo leitura**;
2. **Ouve** a conversa (transcrição que já existe), **entende** "me vê 50 do verniz X", e **propõe** o item;
3. A vendedora **confirma com um toque** e o pedido cresce enquanto ela fala;
4. **Sugere cross-sell** na hora — para **subir o ticket**;
5. **Protege o lucro** com um **cockpit de preço por linha** (Δ vs tabela · margem sobre o custo · defasagem).

> **Como chegamos ao "pedido lado a lado":** em duas etapas. Primeiro uma **ponte barata** (co-piloto flutuante global + abrir o `/sales/new` já com o contexto da ligação). Depois, quando extrairmos um **núcleo de pedido compartilhado** (`OrderWorkspace`), um **palco dedicado** com as duas zonas de verdade. O envio sempre passa pelo `submitOrder` existente, com **idempotência** garantida.

---

## 3. Escopo: as duas vertentes e o foco da Onda 1

- **Proativa** (nós provocamos): ligação sainte + abordagem no WhatsApp → a tela entrega **munição**.
- **Reativa** (o cliente nos procura): ligação entrante + WhatsApp inbound + balcão → a tela entrega **velocidade**.

**Ordem (priorização do founder, dor × frequência):**
1. **Onda 1 — a LIGAÇÃO** (este spec). Cobre **as duas faces** (entrante + sainte): mesma máquina, muda o **modo de abertura** (entrante = velocidade; sainte = munição). Maior alavanca na **sainte**.
2. Onda 2 — WhatsApp. 3. Onda 3 — Balcão.

---

## 4. Decisões (âncoras do design)

1. **Onda 1 = a ligação inteira** (entrante + sainte), uma experiência com dois modos de abertura.
2. **O pedido vive lado a lado com a ligação — alcançado em duas etapas.** A premissa "reusar o motor de pedido sem tocar o `/sales/new`" foi **descartada** (ver §18-A): cada montagem de `useUnifiedOrder` cria um pedido **separado** e a lógica de rascunho/offline/URL vive só na página. Caminho: **(etapa 1)** ponte = co-piloto flutuante global + `/sales/new?customer=…&atendimento=…`; **(etapa 2)** extrair um `OrderWorkspace` compartilhado (toca o `/sales/new` **conscientemente**) e montar o palco dedicado.
3. **Preparação é READ-ONLY.** A tela de munição **nunca monta o motor de pedido** — `selectCustomer` dispara **criação de cadastro no Omie** (`useCustomerSelection.ts:253,509`) e montar o catálogo inicia **sync de estoque** (`useProductCatalog.ts:109`). A munição vem de **leituras diretas / RPC**, sem efeitos colaterais no Omie.
4. **Co-piloto PROPÕE; vendedora CONFIRMA** — via um **estado de proposta separado do carrinho** (`proposed`/`accepted`/`rejected`, com trecho da fala, turno, qtd, conta, confiança, candidatos). Só `accepted` chama o comando de carrinho. Hoje `handleUnifiedAIResult` adiciona **direto** ao carrinho (`useUnifiedOrder.ts:482`) — esse modelo de proposta **não existe** e precisa ser criado (§18-A7).
5. **Cockpit — régua = margem sobre o custo (CMC) ≥ 0.** Não é "contribuição" (ignora imposto, comissão, frete, prazo) — é **margem bruta sobre o CMC**, uma aproximação **honesta**. Custo = `cmc` de `inventory_position`, casado **por conta + código** (não `product_id`), com tratamento de **fracionamento** (unidade de venda × unidade de estoque) e **tinta** (custo de corante variável). Sem `cmc` confiável → **neutro** (⚪). Cálculo via **RPC staff-gated** (não expor `cmc` cru no client). Faixas: 🟢 ok · 🟡 defasado/margem baixa · 🔴 margem negativa · ⚪ sem dado.
6. **Repasse de aumento — sugere, não fabrica.** Quando o preço praticado está abaixo da tabela atual, o cockpit mostra **praticado · tabela · delta · proveniência** e **sugere a tabela cheia como default** — a vendedora **confirma** (não auto-preenche cego). **Não inventa** o argumento "houve reajuste do fornecedor": não temos o evento de aumento datado, e fabricá-lo viola o princípio de honestidade (§18-A6). Praticado abaixo da tabela pode ser contrato/volume/pagamento/desconto estratégico — só alegamos "aumento" com histórico comparável e datado.
7. **Identidade de atendimento + idempotência (fundação).** Hoje `callId` é `null` (`WebRTCCallContext.tsx:568`), a chave do pedido no Omie usa `Date.now()` (`omie-vendas-sync:1265`) → **retry pode duplicar pedido**, e `farmer_calls` liga a **um** `linked_sales_order_id` (mas uma venda pode virar N pedidos multi-conta). Criar **`atendimento_id`** (liga ligação ↔ pedidos) + **`checkout_id`** + **chave Omie determinística** + unicidade `(checkout_id, account)`.
8. **Extração fala→item: matcher novo + shadow mode.** O matcher atual (`analyze-unified-order`) tem heurísticas perigosas (assume `LT` sem tamanho `:1013`; troca conta pela de menor estoque `:1032`) → **não reusar como está**. Construir: extrator **Anthropic** (só menção crua + qtd + embalagem + evidência) + **matcher determinístico novo, account-aware**, com candidatos ranqueados (ambiguidade → escolha manual, não proposta automática). Rodar em **shadow mode** (mede precisão por SKU/qtd/embalagem) **antes** de virar proposta ativa.
9. **Origem do pedido gravada** (`ligacao_sainte`/`ligacao_entrante`/`whatsapp`/`balcao`/`web_staff`/`web_customer`…).

---

## 5. O que já existe (reuso) — com os caveats que o Codex levantou

| # | Etapa | Estado | Caveat (do passe adversário) |
|---|---|---|---|
| 1 | Transcrição ao vivo separada por speaker | ✅ `src/lib/transcription/*`, `useTranscription.ts` | Deepgram sem keyterms/vocabulário e descarta alternativas/confiança (`deepgram-client.ts:31`) → códigos tipo `FI.6197QT` exigem corpus + normalização |
| 2 | LLM ao vivo (debounce ~3s) extrai entidades + `crossSellTriggers` | ✅ `useSpinAnalysis.ts` → `claude-spin-analyze` (Anthropic) | entidade `product` = **concorrente**, não intenção de compra (`claude-spin-analyze:87`) — **não reusar como item**; `useSpinAnalysis` manda histórico acumulado e não descarta resposta antiga (`:75`) → análise obsoleta pode sobrescrever |
| 3 | Matcher texto→SKU (fuzzy, rescue, dedup, multi-conta) | ⚠️ `analyze-unified-order` (Gemini legado) | heurísticas perigosas (`:1013` assume LT; `:1032` troca conta por estoque) — **não extrair as-is** |
| 4 | Empurrar item no carrinho | ⚠️ `addProductToCart` (`useCart.ts:79`); `handleUnifiedAIResult` (`useUnifiedOrder.ts:482`) | adiciona **direto** ao carrinho — não há camada de "proposta" |
| 5 | Preço-cliente | ✅ `getProductPrice` (`useUnifiedOrder.ts:236-241`) ← `sales_price_history` | praticado pode embutir desconto antigo negociado |
| 6 | `?customer=<user_id>` pré-seleciona cliente | ✅ `UnifiedOrder.tsx:52-70` → `selectCustomerByUserId` | `selectCustomer` tem efeito colateral: cria cadastro no Omie (`useCustomerSelection.ts:253,509`) |
| 7 | Provider de ligação global (sobrevive à navegação) | ✅ `App.tsx:199`; contrato `WebRTCCallContext.tsx:36-83` | **não expõe** o cliente resolvido reativamente; `callId` sempre `null` (`:568`) |
| 8 | Cliente identificado pelo telefone | ✅ `resolveCallParty` / `resolveCustomerByPhone` | fica só em refs locais |
| 9 | Custo real | ✅ `inventory_position.cmc` | RLS `USING(true)` (`migration:84`) — exposto a qualquer autenticado; alguns lookups históricos sem conta (`omie-analytics-sync:723`) |
| 10 | Carrinho 1 linha/conta + submit | ✅ `submitOrder.ts:103` | chave Omie `Date.now()` (`omie-vendas-sync:1265`) → sem idempotência |

---

## 6. O que falta (gaps)

1. **Fundação de identidade/idempotência:** `atendimento_id` + `checkout_id` + chave Omie determinística + unicidade `(checkout_id, account)`.
2. **Coluna `origem`** em `sales_orders` + gravar no `submitOrder` (`:104,192`).
3. **Expor o cliente da ligação no contexto** (`currentParty`/`currentCustomerUserId` no `WebRTCCallContext`).
4. **CMC account-aware + via RPC staff-gated** (join por conta+código; tratar unidade/fração/corante; zero/stale = indisponível).
5. **Co-piloto flutuante global** (HUD que persiste na navegação) — hoje a UI de transcrição vive só em `/farmer/calls`.
6. **Munição read-only** (leituras/RPC, sem montar o motor de pedido).
7. **`OrderWorkspace`** (núcleo de pedido compartilhado) + o **palco dedicado**.
8. **Estado de proposta** (`proposed/accepted/rejected`) separado do carrinho.
9. **Extrator Anthropic + matcher novo account-aware** + harness de **shadow mode**.
10. **Cockpit de preço** (margem sobre CMC, Δ tabela, defasagem — honesto).
11. **Política de retenção/LGPD** da transcrição estruturada (§15).

---

## 7. Arquitetura por unidade

### 7.1 Fundação (Fase 0)
- **Migração:** `sales_orders.origem`; `atendimento_id`/`checkout_id` + unicidade `(checkout_id, account)`; chave Omie determinística (substituir `Date.now()`). **Money-path** — coordenar com o `submitOrder`/`omie-vendas-sync`.
- **Context:** `currentParty`/`currentCustomerUserId` no `WebRTCCallContext`, setado onde `resolveCallParty` já roda (`makeCall:347`, inbound `:209`).
- **RPC de custo/preço staff-gated** (read): retorna `cmc` por conta+código + tabela + preço praticado, sem expor `cmc` cru no client.

### 7.2 Co-piloto flutuante (HUD global — Fase 1)
- **O que faz:** painel global (montado no `AppShellLayout`, junto dos overlays) que aparece quando `callState==='established'`, consumindo `transcriptionTurns`/`spinAnalysis`/controles do contexto. Persiste na navegação. CTA "Montar pedido" → `/sales/new?customer=…&atendimento=…`.
- **Reuso:** `TranscriptionPanel`/`SpinSuggestionCard` (inline no HUD).

### 7.3 Munição (read-only — Fase 1)
- **O que faz:** gancho + recompra provável + oferta sugerida + flag de defasagem. **Só leitura** (RPC/queries), **sem** `selectCustomer`/`useProductCatalog` no mount.

### 7.4 Cockpit de preço (Fase 2)
- **Helper puro TDD** (`src/lib/...`): entrada = {praticado, tabela, cmc, unidade/fator, corante}; saída = {faixa, Δ%, margem sobre CMC, sugestão de repasse, proveniência}. **Modo informativo** primeiro. Custo via RPC staff-gated. Degradação honesta (sem cmc/tabela → ⚪).

### 7.5 OrderWorkspace + palco dedicado (Fase 3)
- **Refactor consciente:** extrair o estado/lógica de pedido (hoje espalhado entre `useUnifiedOrder` + a página) num `OrderWorkspace` usado pelo `/sales/new` **e** pelo palco → "o mesmo pedido" de verdade. O palco monta as duas zonas (co-piloto | pedido). Gate do 🔴 com **justificativa persistida** (não só cor) se a venda puder seguir.

### 7.6 Extração fala→item (shadow → ativo — Fase 4)
- **Extrator Anthropic** (canônico): só menção crua + qtd + embalagem + evidência. **Matcher determinístico novo, account-aware** (candidatos ranqueados; ambiguidade → manual). **Estado de proposta** separado. **Shadow mode** mede precisão antes de propor ativamente. Cross-sell ao vivo idem (não reusar a entidade `product` do SPIN como item).

---

## 8. Fluxo ponta a ponta (estado-alvo)

```
[Fila]  ──clica──▶  [Munição read-only]  ──"Ligar"──▶  [Ligação ao vivo]
                                                          ├─ co-piloto (HUD/painel): transcrição + sugestões + controles
                                                          └─ pedido (ponte → palco): IA PROPÕE → vendedora CONFIRMA
                                                             cockpit por linha (Δ tabela · margem s/ CMC · defasagem)
        │  "Enviar"  →  submitOrder (idempotente, atendimento_id+checkout_id)  →  grava `origem`
        ▼
[Pedido enviado · loop da fila fechado · outcome registrado]
```

---

## 9. O cockpit de preço (régua honesta)

| Faixa | Condição | Mostra |
|---|---|---|
| 🟢 | preço ≥ tabela **e** margem sobre CMC saudável | discreto |
| 🟡 | preço **abaixo da tabela** (defasado) **ou** margem baixa | praticado · tabela · delta · proveniência; **sugere** tabela cheia (confirma) |
| 🔴 | preço **abaixo do CMC** (margem negativa) | aviso forte; se puder seguir, exige **justificativa persistida** |
| ⚪ | sem `cmc`/tabela confiável, ou unidade não resolvida | "—" (não inventa) |

- **Margem sobre CMC**, não "contribuição" (não desconta imposto/comissão/frete) — rótulo honesto.
- **Repasse:** sugestão default (empurra pra tabela cheia, como decidido) **com gate humano**; **sem** fabricar "aumento".

---

## 10. Fatiamento em fases (reordenado pós-Codex)

Ordem otimizada para **menor risco** e **maior aprendizado** (§18 — sequência recomendada). Cada fase = plano + PR próprios.

- **Fase 0 — Fundação robusta.** `origem` + `atendimento_id`/`checkout_id` + chave Omie determinística + unicidade (idempotência) + `currentParty` no context + CMC account-aware via RPC staff-gated. **Backend/dados; sem UI de peso.** Destrava medir canal, a ponte, e fecha o risco de pedido duplicado.
- **Fase 1 — Ponte + co-piloto flutuante.** HUD global (transcrição/SPIN que já existem) persistindo na navegação + munição read-only + "Montar pedido" → `/sales/new?customer=…&atendimento=…`. **Já tira pedido na ligação com contexto, sem refactor pesado.** Instrumentado.
- **Fase 2 — Cockpit informativo.** Margem sobre CMC + Δ tabela + defasagem, **modo informativo** (mostra, não bloqueia), via RPC staff-gated. Repasse = sugestão + gate.
- **Fase 3 — Palco dedicado.** Extrair `OrderWorkspace` (toca `/sales/new` conscientemente) + montar a tela lado a lado de verdade. Gate do 🔴 com justificativa.
- **Fase 4 — IA propõe item (shadow → ativo).** Extrator Anthropic + matcher novo account-aware em **shadow mode** (mede precisão); vira proposta ativa (`proposed/accepted`) só após a precisão medida. Cross-sell ao vivo idem.

> **Primeira a implementar:** Fase 0. As fases 2-4 serão detalhadas em seus próprios specs/planos quando chegarmos nelas.

---

## 11. Decisões técnicas-chave

- **Provider de LLM = Anthropic direto** (canônico): `ANTHROPIC_API_KEY` + `@anthropic-ai/sdk` + `claude-sonnet-4-6` + prompt caching + forced tool-use + gate `authorizeCronOrStaff`. (O `analyze-unified-order`/Gemini é legado e **não** será reusado as-is.)
- **Custo = `cmc` account-aware** (`inventory_position`, join por conta+código), via RPC staff-gated; nunca `product_costs` (proxy).
- **Idempotência:** chave Omie determinística + `checkout_id` único por conta; `atendimento_id` liga ligação ↔ N pedidos.
- **Proposta ≠ carrinho:** estado `proposed/accepted/rejected` com evidência/confiança/origem; só `accepted` muta o carrinho.
- **Shadow mode** antes de propostas ativas; **matcher novo** account-aware (não reusar heurísticas do legado).
- **Helpers puros + TDD** (cockpit, matcher) — lógica testável isolada da UI/edge.
- **Degradação honesta** em todo dado ausente.

---

## 12. Não-objetivos (v1 / Onda 1)

- Vertente **reativa** rica (entrante usa o mesmo palco; refino depois). **WhatsApp** (Onda 2), **balcão** (Onda 3).
- **Suavização** de aumento (decidido: repasse cheio como sugestão default).
- **Margem mínima configurável** (piso = margem sobre CMC ≥ 0).
- Atender vendedores além de **Regina/Tatiana** / dispositivos além de **desktop**.
- **Reescrever** os syncs do Omie além do mínimo da idempotência (money-path — mudança cirúrgica e coordenada).

---

## 13. Riscos e mitigações

- **Pedido duplicado** (chave `Date.now()`): Fase 0 — chave determinística + unicidade.
- **Efeito colateral no Omie** ao abrir preparação (`selectCustomer` cria cadastro): preparação **read-only**.
- **Dois pedidos efêmeros** (palco × `/sales/new`): ponte primeiro; `OrderWorkspace` compartilhado antes do palco dedicado.
- **CMC errado** (conta/unidade/corante/stale): join account-aware + fração + corante + neutro quando indisponível.
- **Repasse fabricado**: nunca alegar "aumento" sem evento datado; sugerir + gate.
- **Item errado confirmado no automático** (transcrição PT-BR de códigos): matcher novo + **shadow mode** + ambiguidade → manual + nunca auto-confirmar.
- **Análise SPIN obsoleta** (`useSpinAnalysis:75` não descarta resposta antiga): descartar respostas fora de ordem na Fase 4.
- **Colisão com trabalho em voo:** telefonia ([#689](https://github.com/LucasSardenbergL/afiacao/pull/689)), Meu Dia ([#690](https://github.com/LucasSardenbergL/afiacao/pull/690)), preço/cor do pedido. A Fase 0 (context/idempotência) coordena com a telefonia; o palco evita tocar `/sales/new` até a Fase 3.

---

## 14. Métricas de sucesso

- **Ticket médio** e **margem média** dos pedidos originados em ligação (antes × depois).
- **Taxa de aplicação do repasse** (defasados que subiram para a tabela).
- **% de itens aceitos via proposta da IA** + **precisão da extração em shadow mode** (por SKU/qtd/embalagem) — gate para ativar a proposta.
- **Conversão por origem** (coluna `origem`).
- **Tempo de montagem** do pedido na ligação.
- **Zero pedidos duplicados** (idempotência).

---

## 15. LGPD e retenção

- A ligação já toca o **aviso LGPD** (preroll mixado no `localStream`). Mas a transcrição + entidades viram **dado estruturado persistido** (`farmer_calls`): definir **finalidade**, **prazo de retenção**, **exclusão**, e registrar os **subprocessadores** (Deepgram = transcrição; Anthropic = análise/extração).
- O pedido derivado é gerado **com gate humano** (a vendedora confirma) — não é decisão automatizada sobre o titular.

---

## 16. Coordenação e dependências

- **Migração manual (Lovable):** `origem` + identidade/idempotência (Fase 0) via SQL Editor (skill `lovable-db-operator`). Money-path → validar com cuidado.
- **Deploy de edge manual (Lovable):** o extrator Anthropic (Fase 4) + a RPC de custo (Fase 0/2, se for função SQL) via chat do Lovable / SQL Editor.
- **Publish do frontend manual (Lovable):** HUD/palco só vão ao ar após Publish.
- **PRs em voo:** coordenar com #689 (telefonia) e #690 (Meu Dia) — §14 do CLAUDE.md (uma sessão por worktree; `gh pr list` antes de implementar).

---

## 17. Arquivos-âncora (refs de código)

- **Ligação / contexto:** `src/contexts/WebRTCCallContext.tsx` (`:36-83`, `:347`, `:209`, `:568` callId null), `src/App.tsx:199`, `src/components/AppShellLayout.tsx:55-65`.
- **Transcrição / SPIN:** `src/lib/transcription/*`, `src/hooks/{useTranscription,useSpinAnalysis}.ts` (`:75`), `src/lib/spin/types.ts`, `supabase/functions/claude-spin-analyze/index.ts` (`:87`), `src/components/call/{TranscriptionPanel,SpinSuggestionCard}.tsx`, `src/pages/FarmerCalls.tsx:476-499`.
- **Matcher / pedido:** `supabase/functions/analyze-unified-order/index.ts` (`:1013`, `:1032`), `supabase/functions/tarefa-extrair-voz/index.ts` (molde Anthropic), `src/hooks/useUnifiedOrder.ts` (`:236-241`, `:463`, `:482`), `src/hooks/unifiedOrder/{useCart,useCustomerSelection,useProductCatalog,types}.ts` (`useCart:22`, `useCustomerSelection:253,509`, `useProductCatalog:109`), `src/pages/UnifiedOrder.tsx:52-70,85`, `src/services/orderSubmission/submitOrder.ts:103,192`, `supabase/functions/omie-vendas-sync/index.ts:1265`.
- **Custo:** `inventory_position.cmc` (`migration 20260225231517:84` RLS), `omie-analytics-sync/index.ts:723`.

---

## 18. Revisão adversária (Codex, 2026-06-06) — achados e como foram endereçados

Passe adversário (gpt-5.5, xhigh) sobre este spec. Veredito: "não pronto para virar plano" — corrigido nesta versão.

**P1 incorporados:**
- **A1** "reusar o hook sem tocar `/sales/new`" é falso (dois pedidos efêmeros) → §2/§4.2/§7.5: ponte primeiro, `OrderWorkspace` compartilhado antes do palco (Fase 3).
- **A2** montar o hook tem efeito colateral (cria cadastro no Omie; sync de estoque) → §4.3/§7.3: preparação **read-only**.
- **A3** sem identidade de atendimento / idempotência (`callId` null, chave `Date.now()`) → §4.7/§7.1: `atendimento_id`/`checkout_id`/chave determinística (Fase 0).
- **A4** "preço − CMC" não é contribuição; CMC precisa conta+código+unidade+corante → §4.5/§9: rótulo honesto "margem sobre CMC", join account-aware, fração/corante, neutro quando indisponível.
- **A5** CMC exposto (`USING(true)`) → §4.5/§7.1: cálculo via **RPC staff-gated**.
- **A6** "praticado < tabela = aumento" é fabricado → §4.6: sugerir tabela cheia **com gate**, sem inventar o motivo.
- **A7** modelo de proposta não existe (`handleUnifiedAIResult` adiciona direto) → §4.4/§7.6: estado `proposed/accepted/rejected`.
- **A8** matcher legado inadequado (assume LT; troca conta por estoque) → §4.8/§7.6: matcher **novo** account-aware + shadow mode.

**P2 incorporados:** entidade SPIN `product` = concorrente (não reusar como item); `useSpinAnalysis` não descarta resposta antiga (descartar fora-de-ordem); Deepgram sem keyterms (corpus/normalização para códigos); política de entrante durante pedido sujo (definir na Fase 1); **retenção/LGPD** da transcrição estruturada (§15); gate do 🔴 com justificativa persistida (§9).

**Sequência recomendada pelo Codex** → adotada em §10 (fundação robusta → ponte + HUD → cockpit informativo → palco dedicado → extração shadow→ativo).
