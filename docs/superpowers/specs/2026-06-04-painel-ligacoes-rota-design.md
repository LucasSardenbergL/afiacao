# Painel das Ligações da Rota — capacidade × eficácia (design)

> Data: 2026-06-04 · Módulo: Rota/Ligações (sobre o closed-loop PR2c) · eu + codex
> Status: design (decisões travadas eu+codex). Aguarda revisão do founder antes do plano.

## 1. Problema / objetivo

O programa de **ligações da rota** (`/rota/ligacoes`) já tem closed-loop: a vendedora vê a fila priorizada (cidades da rota de amanhã D-1 × valor) e registra o resultado (`route_contact_log`: respondido/convertido/sem_resposta/opt_out). O founder quer um **painel de decisão** pra responder, com dado, **"automatizar mais (WhatsApp) vs contratar mais vendedora"**.

**Reframe (codex) — a pergunta certa do painel:** *quanto valor esperado está ficando sem contato, qual o retorno reportado dos contatos atuais, e qual canal/pessoa/bucket rende mais pra expandir capacidade.*

## 2. A descoberta que define o escopo (P1 do codex)

Hoje **só os contatos** ficam gravados (`route_contact_log`). A **fila de elegíveis do dia** (quem *deveria* ser ligado) é computada **ao vivo** (`useRouteContactList`) e **não é persistida**. Sem esse **denominador histórico**, o painel mede "atividade registrada", não **capacidade vs demanda** — e engana a decisão (não dá pra ver cobertura nem o valor que ficou sem contato). Logo, **o v1 precisa persistir a fila**.

## 3. Decisões travadas (eu + codex)

1. **Valor = opção C:** conta `status='convertido'` + soma `valor_da_ligacao` das convertidas, **rotulado "valor esperado / score capturado" — NUNCA R$ realizado**. Atribuição ao PV real (opção B) → **v2** (métrica separada, com janela/regra explícita; não misturar agora pra não virar discussão de causalidade).
2. **Persistir a fila — snapshot on-open (não cron):** quando a vendedora abre `/rota/ligacoes`, grava (idempotente por `data_rota`+`farmer_id`+`customer_user_id`) a fila que ela **de fato viu**. Evita reescrever a lógica da fila em SQL (zero divergência: o denominador = exatamente o que foi mostrado). Trade-off: dia sem abertura → sem denominador (mostrado como "sem dado", honesto). Cron D-1 independente = **v2** (auditabilidade extra).
3. **Conversão = reportada:** `status='convertido'` é auto-declarado pela vendedora → rótulo explícito **"conversão reportada"**. Métrica de auditoria ("% convertidos com pedido em ≤X dias") = v2.
4. **Honestidade estatística:** taxa exibida normal só com **n ≥ 30**; abaixo → mostra a fração ("3/12") + selo **"amostra baixa"**. Banner global **"piloto / direcional"**.
5. **Opt-out = guardrail** (por canal/bucket), não rodapé — sinal de dano/fadiga central pra decisão de automação.
6. **Cortes:** por **vendedora** (com **aviso de mix** — Regina×Tatyana cru engana se o mix de bucket/cidade/valor difere); por **bucket** e por **canal**; **cidade só pra diagnóstico de cobertura** (N baixo no piloto, não conclui eficácia).
7. **Tempo:** dia da rota por **`data_rota`** (análise da rota); `created_at` só pra horário operacional. Fuso **America/Sao_Paulo** (`spBusinessDate`).
8. **Driver real = valor marginal** (não taxa média): o painel deve deixar ver "existe demanda valiosa não coberta?" + "o contato humano ainda rende o suficiente?". As métricas servem a isso (gap de valor + retorno reportado por canal/pessoa/bucket).

## 4. Métricas do painel (v1)

Sempre com **denominador visível** + gating de baixo volume:

- **Cobertura:** `contatados / elegíveis` — por **contagem** E por **Σ valor_da_ligacao**.
- **Gap (headline da capacidade):** **Σ valor_da_ligacao dos elegíveis NÃO contatados** = o valor esperado ficando sem contato.
- **Capacidade:** contatos por **vendedora/dia** e por **canal**.
- **Eficácia:** taxa de **resposta** (`(respondido+convertido)/contatados`), **conversão reportada** (`convertido/contatados`), **opt-out** — denominador visível, gating n≥30.
- **Valor:** Σ `valor_da_ligacao` das convertidas = **"valor esperado reportado como convertido"** (não R$).
- **Guardrail:** opt-out por **canal** e por **bucket**.

> Nota de taxa (codex P3): a taxa de resposta inclui `convertido` como atendimento (deixar explícito na UI).

## 5. Componentes

**Novo — backend (migration manual via Lovable):**
- Tabela **`route_queue_snapshot`**: `(id, data_rota date, farmer_id uuid, customer_user_id uuid, cidade text, bucket text, valor_da_ligacao numeric, rank int, snapshot_at timestamptz default now())`, **UNIQUE(data_rota, farmer_id, customer_user_id)** (idempotente). RLS: SELECT staff (employee/master, como `route_contact_log`); INSERT pelo próprio farmer (`farmer_id = auth.uid()`) ou master. Índices por `data_rota` e `(farmer_id, data_rota)`.

**Novo — frontend:**
- **Snapshot on-open:** em `useRouteContactList`/`RotaListaLigacao`, após a fila computar, **upsert best-effort** dos elegíveis no `route_queue_snapshot` (`onConflict` (data_rota,farmer_id,customer_user_id) `ignoreDuplicates`). Falha nunca quebra a lista.
- **Hook `useRoutePanel(periodo)`** — lê snapshot (denominador) + `route_contact_log` (numerador), junta por `(data_rota, farmer_id, customer_user_id)`, agrega as métricas §4. Helpers puros TDD pros cálculos (cobertura/gap/taxas/gating).
- **Página `/rota/ligacoes/painel`** (ou aba na `/rota/ligacoes`) — gate **master/gestor**. Headline (cobertura, gap de valor, capacidade) + eficácia (com gating) + guardrail opt-out + cortes (vendedora c/ aviso de mix, bucket, canal) + seletor de período + banner "piloto/direcional".

**Reuso:** `spBusinessDate` (`sp-day.ts`); o padrão de leitura de `route_contact_log` do PR2c; o gate `gestorComercialOuMaster`.

## 6. Helpers puros (TDD)

- `agregarPainel(snapshots, contatos, { hojeSP })` → `{ cobertura, gap_valor, capacidade[], eficacia, optout, porVendedora[], porBucket[], porCanal[] }`.
- `taxaComGating(num, den, min=30)` → `{ valor|null, exibivel: boolean, rotulo: 'taxa'|'amostra_baixa', fracao: 'x/y' }`.
- `coberturaPorValor(snapshots, contatos)` → contagem + Σvalor contatado/não-contatado.
- Junção contato↔elegível por `(data_rota, farmer_id, customer_user_id)`; contato sem snapshot correspondente (dia sem abertura) → conta no numerador mas marca o dia como **"denominador indisponível"** (não infla cobertura falsamente).

## 7. Degradação honesta

- Dia com contatos mas **sem snapshot** → cobertura daquele dia = **"sem dado"** (não 100%, não 0% — indisponível). O total do período exclui esses dias do cálculo de cobertura (e avisa quantos dias ficaram sem denominador).
- Período sem nenhum dado → estado vazio claro.
- Toda taxa < n mínimo → fração + "amostra baixa".

## 8. Não-objetivos (v1 → v2)

- **Atribuição ao PV real / R$ realizado** (opção B).
- **ROI financeiro completo** (valor marginal por hora × custo de automação/contratação — o painel *informa* a decisão, não a calcula).
- **Cron D-1 de snapshot** (on-open cobre o piloto de 2 vendedoras; cron = auditabilidade extra).
- **Comparações finas por cidade** (N baixo) e **modelagem causal WhatsApp×ligação**.
- Métrica de auditoria da conversão reportada (% com pedido em ≤X dias).

## 9. Passe do codex (2026-06-04) — incorporado

Consult adversário de metodologia. **P1:** (1) denominador de elegíveis é obrigatório → snapshot on-open [§2/§5]; (2) "valor capturado" ≠ receita → rótulo "valor esperado/score" [§3.1/§4]; (3) conversão auto-reportada → rótulo "reportada" [§3.3]; (4) decisão é valor marginal, não taxa média → gap de valor + retorno por canal/pessoa/bucket [§3.8/§4]. **P2:** corte por vendedora com aviso de mix [§3.6]; cidade só diagnóstico [§3.6]; gating n≥30 [§3.4]; **separar canal** (capacidade × eficácia por canal) [§4]. **P3:** taxa de atendimento inclui convertido (explicitar) [§4]; opt-out = guardrail [§3.5]; dia por `data_rota` [§3.7]. **Escopo v1** = o desta spec; v2 = §8.
