# G1 — Fase 3: Fluidez de execução no Meu Dia (painel de contexto + pedido com retorno) — Design

- **Data:** 2026-06-04
- **Status:** Em revisão (saída do brainstorming, antes do plano)
- **Programa:** G1 "Waze comercial interno" (Frente A). Fase 1 (motor `useFilaAcoes` + render) e Fase 2 (loop de feedback) **em produção**. Piloto da fila começa **segunda** (5-10 dias úteis).
- **Decisão de formato:** founder delegou a mim + **Codex** (challenge, 2026-06-04). Veredito incorporado (§2 e Anexo).
- **Idioma/contexto:** ver `CLAUDE.md`.

---

## 1. Contexto & motivação

A visão do founder pra a Fase 3 (textual): tela **dividida "metade Meu Dia | metade WhatsApp"**, **"fazer pedido sem sair da tela"**, **"fluidez, ir e voltar sem perder o estado"**. Device: **desktop/escritório**.

A dor real é **fluidez de execução**: hoje, o "Fazer" de um item da fila joga a vendedora pra outra tela (`tel:`, `wa.me`, `/sales/new`, 360) — ela **sai do Meu Dia e perde o lugar**. O loop (Fase 2) registra o resultado, mas o ato de **agir** ainda quebra o fluxo.

## 2. Decisão de formato (pós-Codex)

**"Ir e voltar sem perder estado" ≠ duas telas simultâneas.** É **retorno de estado preservado** (item ativo, scroll da fila, ação retomável, contexto pré-carregado). Três formatos foram pesados:

- **A — Split 50/50 fixo (Meu Dia | WhatsApp).** Rejeitado como default: a piloto é **farmer** (vive de **ligação**; WhatsApp é **um** canal). Reservar metade fixa da tela pro WhatsApp desperdiça essa metade nas ações de ligar/pedido (a maioria), aperta as duas telas e **rouba o foco da fila** (o que o piloto quer medir).
- **B — Painel de contexto SOB DEMANDA.** ✅ **Escolhido.** A fila ocupa a tela; abrir um item revela um painel lateral com o **contexto certo daquele item** (ficha+telefone / conversa / oferta+pedido / detalhe da tarefa) e fecha de volta no **mesmo lugar**.
- **C — Híbrido (pin/split).** **Evolução.** A arquitetura do painel já nasce compatível com "fixar" (pin) → vira o split do founder. **Só construímos o pin se o piloto mostrar que ela vive no WhatsApp** (= WhatsApp é ambiente contínuo, não só canal de execução). A visão original do founder não morre — fica como destino guiado por dado.

## 3. Escopo do v1 (a "casca", fiel a núcleo→piloto→refina)

**Entra:**
- `FilaContextPanel` — painel lateral (shadcn `Sheet`) que abre a partir de um item da fila.
- **Roteamento por tipo de ação** (`acao.payload.kind`): conteúdo certo por fonte.
- **Estado de item ativo** + **preservação de scroll/posição** da fila ao abrir/fechar o painel.
- **Pedido com retorno preservado**: `/sales/new` full-page com `returnTo` + volta pra fila na mesma posição, item destacado, outcome sugerido.
- **Atrás de feature flag** `useFeatureFlag('filaContextPanel', false)` — **NÃO publicado/ligado durante o piloto** (não trocar a tela testada no meio). Toggle em `/settings`.

**Não entra (espera o sinal do piloto):**
- Pin/split persistente (C), resize avançado, múltiplos painéis.
- Inbox WhatsApp completa dentro do dashboard.
- **Mini-pedido real** (fechar o pedido dentro do painel) — o painel só **prepara a intenção**; o fechamento fica no `UnifiedOrder`.
- Otimizações de fluxo guiadas por padrão de uso.

## 4. Componentes & arquitetura

### 4.1 `FilaContextPanel` (novo — `src/components/fila/FilaContextPanel.tsx`)
Um `Sheet` lateral (overlay, não desmonta a fila → scroll preservado naturalmente). Recebe a `AcaoSugerida` ativa e despacha por `payload.kind`:

- **`rota`** (ligar): ficha curta do cliente (nome, telefone com `tel:`, últimos contatos/eventos) + **`OutcomeMenu`** já pronto (registrar resultado da ligação).
- **`whatsapp`** (desligado no v1 da fila, mas o painel já suporta): a **conversa daquele cliente** (reusa `useWhatsappThread` por `customer_user_id`/`phone`) + campo de resposta. ⚠️ **SÓ a conversa contextual, não a inbox** (risco de lifecycle realtime — §7). Carrega quando o painel abre p/ item whatsapp; cleanup no fechar.
- **`mixgap`** (oferta): contexto comercial (família a oferecer + "clientes parecidos compram X") + botão **"Continuar pedido"** (→ §5) + o outcome de mix-gap (Ofertei/Comprou/Sem fit).
- **`tarefa`**: descrição da tarefa + **Concluir** (`useTarefaMutations.concluir`).

### 4.2 `FilaDoDia` (modificar)
- Ganha estado `itemAtivo: AcaoSugerida | null`. Abrir um item (clique no corpo do item, ou um affordance "ver contexto") seta `itemAtivo` → o `Sheet` abre. Fechar → `itemAtivo = null`, fila no mesmo scroll.
- **Sob a flag**: com `filaContextPanel` OFF, o comportamento atual (CTA "Fazer" + menu de outcome) permanece **intacto** (é o que está no piloto). Com ON, o item abre o painel.

### 4.3 Reuso (não duplicar)
- WhatsApp: `useWhatsappThread`/`useWhatsappConversations` (realtime + janela 24h).
- Resultado de ligação: `OutcomeMenu` + `useRegistrarContato`.
- Mix-gap: `useMarkMixGapFeedback`.
- Tarefa: `useTarefaMutations`.

## 5. Pedido sem sair da tela (sem espremer o wizard)

**NÃO** embutir o `UnifiedOrder` (wizard pesado: cliente→endereço→pagamento→itens→Omie) num drawer estreito — quebraria ergonomia, validação, busca de produto e envio.

**Caminho mínimo correto:**
1. Do painel/fila, "Continuar pedido" navega pra `/sales/new` com estado de retorno: `returnTo=/meu-dia`, `filaItemId=<dedupeKey>`, `cliente=<customerUserId>` (pré-selecionado **se viável/seguro** — a confirmar no plano; senão só `returnTo`).
2. `UnifiedOrder` abre **full-page**, preservando o lugar da fila via URL/state.
3. Ao finalizar/cancelar/voltar, retorna ao `/meu-dia` com: a fila na **mesma posição**, o **item original destacado**, e **outcome sugerido** ("pedido criado" / "pedido iniciado").

O painel, no máximo, mostra um **resumo/pré-pedido** (cliente + itens sugeridos do mix-gap) e o botão "Continuar pedido" — o fechamento real é no wizard.

## 6. Feature flag & piloto

- `useFeatureFlag('filaContextPanel', false)` (default OFF, por-dispositivo via localStorage). Toggle em `/settings`.
- **Durante o piloto (5-10 dias): OFF.** O piloto mede Fase 1+2, não uma tela nova.
- Pós-piloto: ligar pra a vendedora (e calibrar o formato — se ela vive no WhatsApp, priorizar o painel WhatsApp / avaliar o pin C).
- Pode mergear na main com a flag OFF (código testado, desligado) — mais seguro que segurar a branch.

## 7. Riscos & mitigações (do Codex)

- **P2 — Realtime do WhatsApp no painel:** subscription duplicada, thread trocando ao chegar msg, input perdido ao fechar. **Mitigação:** carregar **só a conversa daquele cliente** sob demanda (não a inbox); cleanup do channel no fechar; o painel é **extensão da ação ativa, não uma segunda aplicação**.
- **P2 — Pedido pesado:** mitigado por full-page + retorno (§5), nunca drawer.
- **P3 — Trocar o piloto no meio:** flag OFF durante o piloto.
- **Painel sob demanda "perder ambiente"** que o split daria: aceitável no v1; o pin (C) resolve **se** o piloto pedir.
- **Pré-seleção de cliente no `UnifiedOrder`:** o `selectCustomer` é acoplado (multi-call). Se a pré-seleção via param for arriscada, o v1 passa **só `returnTo`** (ela seleciona o cliente no wizard) e a pré-seleção vira follow-up.

## 8. Não-objetivos (v1)

Split/pin persistente (C); inbox WhatsApp completa no dashboard; fechar pedido dentro do painel (mini-order real); resize avançado; otimizações por hábito; tudo guiado pelo sinal do piloto.

## 9. Decisões em aberto (pro plano)

1. **`Sheet` (lateral shadcn) vs `Drawer`** — `Sheet` é o padrão lateral; confirmar largura/responsivo no desktop.
2. **Pré-seleção de cliente no `UnifiedOrder`** via param — viável sem refatorar o `selectCustomer`? (medir; senão só `returnTo`).
3. **Conversa WhatsApp contextual** — `useWhatsappThread` carrega 1 thread por `customer_user_id`/`phone`? Como casar o cliente da fila com a conversa do inbox.
4. **Retorno do pedido** — como o `/meu-dia` (FarmerDashboardV2 → FilaDoDia) lê o state de retorno pra destacar o item + sugerir outcome (router state vs query param).
5. **Affordance de abertura** — o item inteiro abre o painel, ou um botão dedicado "ver contexto" (pra não conflitar com o link do título → 360)?

## 10. Telemetria (estende o `fila.*`)

- `fila.painel_aberto` { fonte, dedupeKey } — abriu o contexto.
- `fila.pedido_iniciado` { fonte, dedupeKey } / retorno do pedido (`fila.pedido_retornou` { criado:bool }).
- Reusa os `fila.outcome` / `fila.nao_util_agora` existentes.

---

## Anexo — síntese do Codex (challenge, 2026-06-04)

**Veredito:** **Fase 3 mínima = "fila com painel contextual + retorno preservado do pedido", NÃO "Meu Dia dividido com WhatsApp".** (1) Formato **B agora**, **C como evolução**, **A não é default** (split fixo só se o piloto mostrar WhatsApp como ambiente contínuo — argumento "farmer liga muito → WhatsApp não merece metade fixa" procede). (2) **Construir já só a casca** (painel contextual, item ativo, roteamento por ação, retorno preservado do pedido, ficha de ligação); **esperar o piloto** pra pin/split, inbox completa, mini-order real, otimizações. (3) **Pedido**: full-page com retorno explícito + cliente pré-selecionado (se seguro), **nunca** o wizard espremido num drawer. **Riscos:** realtime do WhatsApp em painel (lifecycle — só conversa contextual, não inbox); "fluidez" depende de retorno-de-estado, não de split; não mandar Fase 3 pra prod durante o piloto (flag/branch).
