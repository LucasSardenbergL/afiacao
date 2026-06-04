# Crítica da Fila — v1 determinístico (design)

> Data: 2026-06-04 · Status: spec aprovada em brainstorm, aguardando review do founder antes do plano
> Programa: **"Buddy" (inspirado na UPOPS/PMBuddy do Itaú)** — 1ª entrega.
> Consult codex salvo em `.context/codex-session-id` (`019e9371-b4fd-76d0-b9ab-3d6196e69dbf`).

## 1. Contexto estratégico (por que esta é a 1ª peça)

O Itaú apresentou a **UPOPS** (plataforma agêntica única) + **PMBuddy** (copiloto crítico de produto). A dor deles era **fragmentação** (50+ ferramentas, milhares de PMs). A nossa é **invertida**: o Afiação **já é** o OS consolidado. Logo, "copiar a UPOPS" **não** é construir um chat-sobre-tudo (seria teatro para <20 usuários e morre em 60 dias no 1º erro factual de money-path).

O que **é** transferível (consult codex, 2026-06-04): **"evidence-backed contradiction"** — *"a fila diz X, mas os sinais do cliente dizem Y; aja aqui."* A propriedade "PMBuddy é crítico, mostra o que você não vê" **não é um prompt** — é um **motor determinístico de contradição**. Decisões tomadas no brainstorm:

- **1º Buddy = VendedoraBuddy** (não GestorBuddy): tem **loop mensurável** (mostrado → aberto → contatado → convertido) que prova ou mata a tese barato. O GestorBuddy (brief de exceção agregado) sai **depois**, do **mesmo motor de evidência**.
- **v1 = determinístico-puro** (sem LLM): o núcleo (contradição + voz-do-cliente via timeline de fricção) já é determinístico; o LLM só adicionaria a *linha de abordagem* e o *resumo de transcrição* (polimento). Determinístico-puro mata o death-mode "1 erro factual destrói a confiança" e zera custo de IA.
- **Provider do LLM (quando entrar, v1.5)**: **Anthropic** — consolida o stack num provider só, casa com o caminho do WhatsApp (já Anthropic), honra a preferência declarada. Hoje o `copilot-analyze` usa `google/gemini-2.5-flash` via gateway Lovable (`copilot-analyze/index.ts:91`) — a preferência "single-provider Anthropic" **não é verdade hoje**; v1.5 é a chance de consolidar. Travar com consult codex focado na hora.

## 2. Objetivo

Enriquecer as ações do topo do **Meu Dia** da vendedora com um bloco **"Por que agora"** que mostra:
- (a) **timeline de fricção do cliente** — fatos determinísticos do nosso exhaust operacional;
- (b) **badges de contradição** — "o que você não está vendo";
- (c) **feedback** (útil · errado · já resolvi · falta dado) instrumentado, para medir o piloto.

Sem chat, sem IA, sem superfície nova, sem backend novo.

## 3. Não-objetivos (YAGNI explícito — v1.5+ condicionado a passar no teste)

- Linha de abordagem gerada por LLM.
- Resumo de transcrição de ligação por LLM.
- Voz-do-cliente via WhatsApp (bloqueado pelo bug de fonte de pendentes — ver §6).
- GestorBuddy / brief de exceção agregado.
- Qualquer tabela, view, RPC, edge function ou cron novos.
- Chat / `/ask` / diagnóstico conversacional.

## 4. Arquitetura — 100% frontend, zero tax do Lovable

```
useFilaAcoes()  →  AcaoSugerida[] (rankeada)         [já existe]
        │
        ▼
useCriticaFila(acoes)                                 [novo hook]
        │   costura sinais determinísticos por cliente do topo-N:
        │     • order-delta     ← customer_metrics_mv (client-readable)
        │     • rota outcomes   ← RouteContactItem (já carregado por useRouteContactList)
        │     • tarefa estado   ← v_tarefas_estado + tarefa_satisfacao_candidatos
        ▼
montarEvidencePack(...)  →  EvidencePack por ação      [helper PURO, TDD]
        │
        ▼
FilaDoDia (bloco "Por que agora" expansível + feedback)   [UI estendida]
        │
        ▼
track('fila.critica_*')  →  PostHog                    [medição, já fiado]
```

- **Helper puro TDD** em `src/lib/fila/critica/` (oráculo testável — padrão da casa). Recebe os sinais já normalizados e produz o `EvidencePack`. Toda a sutileza (thresholds, contradições, degradação) vive aqui, testada isolada. Nenhum acesso a rede no helper.
- **Hook** `useCriticaFila(acoes: AcaoSugerida[])` — só para o **topo-N** (N=5 no v1). Carrega/reusa os sinais determinísticos e chama o helper. Reusa o que já desce: `useRouteContactList` (RouteContactItem traz os sinais de rota), `customer_metrics_mv` (read direto, mesmo padrão do `useRouteContactList:150`), `v_tarefas_estado`/`tarefa_satisfacao_candidatos` (via `useTarefas`).
- **UI**: estende `src/components/fila/FilaDoDia.tsx`. Cada card do topo-N ganha um bloco **"Por que agora"** expansível (badges de contradição visíveis sem expandir; timeline ao expandir) + linha de feedback.
- **Medição**: eventos PostHog via `track()` de `@/lib/analytics` (convenção `fila.critica_*`). **Sem tabela nova.** O cruzamento "acionou → gerou contato/pedido/tarefa" usa o que já é logado (`route_contact_log`, `sales_orders`, `tarefa_eventos`).
- **Único deploy**: o **Publish** do frontend no Lovable. Sem migration, sem edge, sem cron.

### Confirmações de acesso a dados (feitas no brainstorm)
- `customer_metrics_mv` é **client-readable** pela carteira da rep (RLS ok — lido por `useRouteContactList` e `customer360/hooks`). Colunas: `dias_desde_ultima_compra`, `intervalo_medio_dias`, `atraso_relativo`, `faturamento_90d`, `faturamento_prev_90d`, `ticket_medio_90d`, `is_cold_start`, `ultima_compra_data`.
- `RouteContactItem` já expõe `ultimoContatoRealHaDias`, `semRespostaRecenteN`, `cadenciaBloqueadaPor`, `jaConvertidoNaRota`, `faturamento`/score, `customer_user_id`, `name`, `phone`.
- Tarefa: `v_tarefas_estado` (estado efetivo, fuso SP) + `tarefa_satisfacao_candidatos` (indício inferido não-confirmado = a escada de certeza).

## 5. Schema do EvidencePack (claims atados a evidência — padrão codex/`ai-ops-agent`)

```ts
// src/lib/fila/critica/types.ts
export type SeveridadeSinal = 'info' | 'atencao' | 'critico';
export type TipoSinal = 'order_delta' | 'rota_outcome' | 'tarefa_estado' | 'carteira_score';
export type Confianca = 'alta' | 'media' | 'baixa';

export interface SinalVoz {
  tipo: TipoSinal;
  texto: string;                       // pt-BR, pronto pra render. Ex.: "Comprava a cada 15d; 28d sem comprar (1,9×)"
  fonte: { tabela: string; id: string; observadoEm: string | null }; // source_type / source_id / observed_at
  severidade: SeveridadeSinal;
}

export interface Contradicao {
  chave: 'recorrente_sumiu' | 'tarefa_feita_sem_prova' | 'sem_resposta_repetido' | 'alto_valor_fora_rota';
  texto: string;                       // a frase do badge
  evidencias: SinalVoz[];              // ≥1 SEMPRE. Contradição sem evidência é DESCARTADA.
  confianca: Confianca;
}

export interface EvidencePack {
  clienteUserId: string;
  clienteNome: string | null;
  sinais: SinalVoz[];                  // timeline de fricção (todos os sinais determinísticos achados)
  contradicoes: Contradicao[];         // subconjunto que dispara badge
  faltaDado: string[];                 // degradação honesta — o que NÃO deu pra checar
}
```

**Regra dura**: `montarEvidencePack` **descarta** qualquer `Contradicao` cujo `evidencias.length === 0`. Nenhum número é fabricado; tudo vem dos sinais lidos.

## 6. Conjunto de contradições do v1 (4 checks determinísticos)

Thresholds **reusam o motor existente** (`useAiOps.ts:112-123`) — não inventar novos.

1. **`recorrente_sumiu`** (order-delta) — cliente com `intervalo_medio_dias` definido E (`atraso_relativo ≥ 2.0` **OU** (`faturamento_prev_90d > 0` E `faturamento_90d < faturamento_prev_90d * 0.5`)). Texto: *"Comprava a cada Nd; Md sem comprar"* (e/ou *"faturamento caiu X%"*). Confiança `alta`. Fonte: `customer_metrics_mv`.
2. **`sem_resposta_repetido`** (rota) — `semRespostaRecenteN ≥ 3` (= `CADENCIA_DEFAULT.limiarSemResposta`). Texto: *"N tentativas de contato sem resposta"*. Confiança `alta`. Fonte: `route_contact_log` (já derivado em `RouteContactItem`).
3. **`tarefa_feita_sem_prova`** (escada de certeza) — tarefa **atrasada** (estado de `v_tarefas_estado`) com **indício inferido não-confirmado** em `tarefa_satisfacao_candidatos` e **sem** fechamento por prova determinística. Texto: *"Tarefa 'X' tem indício de cumprida, sem prova — confirme ou aja"*. Confiança `media`. (É o exemplo do codex: "o time se enganando.") *Semântica exata de v_tarefas_estado a fixar no plano.*
4. **`alto_valor_fora_rota`** (cruzamento) — `faturamento_90d` alto (relativo à carteira da própria rep) E o cliente **não** está na `callQueue` de amanhã E `ultimoContatoRealHaDias > cadencia_min`. Texto: *"Alto valor, fora da rota, sem contato há Xd"*. Confiança `media` (limiar de "alto valor" a **calibrar no piloto**). Fonte: `customer_metrics_mv` + `useRouteContactList`.

⏸️ **`wa_sem_resposta`** (WhatsApp inbound sem resposta na janela 24h) — **adiado**. O `useWhatsappPendentes` tem falso-negativo (cap 200 + proxy `last_message_at`, Codex P1, já documentado no `useFilaAcoes`). Entra quando a RPC de pendentes (sem cap, com `last_outbound_at` real) existir.

## 7. Degradação honesta (sagrado, igual ao financeiro)

- Cliente `is_cold_start` / sem histórico → **não fabrica** delta. Vai pra `faltaDado` ("cliente novo, sem histórico de compra").
- Fonte de rota ausente/`cadenciaIndisponivel` → **pula** as contradições de rota (não assume); registra em `faltaDado`.
- Card sem nenhuma contradição/sinal forte → mostra só o `motivo` determinístico que `AcaoSugerida` já tem. **Nunca** um card "vazio enfeitado".
- `EvidencePack.contradicoes` vazio é estado VÁLIDO (o card fica como hoje, sem badge).

## 8. Medição e critério de morte (piloto de 2 semanas)

Eventos PostHog (`track()`):
- `fila.critica_shown` — impressão de card do topo-N com ≥1 contradição (props: `chaves`, `clienteUserId` hasheado, `posicao`).
- `fila.critica_opened` — expandiu o "Por que agora".
- `fila.critica_acted` — clicou um CTA (`ligar`/`whatsapp`/`pedido`/`tarefa`/`abrir_cliente`).
- `fila.critica_feedback` — `util` | `errado` | `ja_resolvi` | `falta_dado`.

**Mata a tese (qualquer um):**
- <50% dos top-5 (com badge) abertos/acionados pelas reps;
- <30% das ações acionadas geram contato/pedido/tarefa logado (cruzar com `route_contact_log`/`sales_orders`/`tarefa_eventos`);
- o founder não nomeia 3 decisões/ações que mudaram;
- >1 erro factual sério em 50 cards (feedback `errado` validado);
- reps relatam "óbvio/velho".

**Passou** → v1.5: linha de abordagem LLM (Anthropic) + resumo de transcrição; e depois o GestorBuddy (agregação do mesmo motor). **Falhou** → a tese "LLM diagnóstico" cai; o trabalho real vira **melhor plumbing determinístico de fila/evidência**, não mais UI de agente (conclusão do codex).

## 9. Testes

- **TDD no helper puro** `montarEvidencePack` (`src/lib/fila/critica/__tests__/`): cada contradição (dispara / não dispara no limiar), descarte de claim sem evidência, degradação honesta (cold-start, rota ausente), ordenação/severidade, e o caso "nenhuma contradição → pack mínimo".
- Sem teste de rede (helper é puro). Hook fino testado por composição se necessário.
- `bun run test` (vitez) verde; `bun run typecheck` (strict) verde; `bun lint` verde.

## 10. Riscos / pontos a fixar no plano

- **Semântica de `v_tarefas_estado`** (o que conta como "atrasada com indício sem prova") — ler `useTarefas.ts` + a view no plano antes de codar a contradição 3.
- **Limiar de "alto valor"** da contradição 4 — definir relativo à carteira (ex.: acima da mediana×k OU top-N) e marcar pra calibrar no piloto.
- **Custo de carregar `customer_metrics_mv`** para os clientes do topo-N — restringir ao conjunto do topo-N (não a carteira inteira); usar `.in(customer_user_id, [...])` com chunk, padrão do `useRouteContactList`.
- **Hash de `clienteUserId`** nos eventos PostHog (sem PII), seguindo a convenção de analytics existente.
