# Fase 2 — Fatia 2: Captura Inteligente (o loop que se retroalimenta) — Design

> **Objetivo principal da Fase 2** (handoff `2026-06-15-fase2-LEIA-PRIMEIRO-handoff.md`): *"o comercial se retroalimenta a cada ligação"*. A **Fatia 1** (oferta viva na ligação) é o primeiro passo visível e já está entregue (PR #896). Esta é a **Fatia 2**: a IA ouve a gravação e extrai sinais estruturados que retroalimentam a próxima oferta — **sem registro manual** pela vendedora.
>
> **Founder (verbatim):** *"eu queria que a IA percebesse o que ela fizesse… ela mesma preenche isso… dados referentes a preço, marca que o cliente tá utilizando, produto que ofertamos e não temos, novos produtos."*

## 1. Problema

A Fatia 1 mostra a oferta certa **antes** da ligação. Falta o outro lado do loop: a IA captar o que aconteceu **na** ligação e devolver isso na próxima. Hoje esse loop existe no papel mas nunca rodou — não há a análise pós-call que extrai os 4 sinais.

## 2. Estado atual (empírico — `psql-ro`, produção, 2026-06-16)

A fiação do loop **já existe e está construída**:
`transcrição (ElevenLabs ao vivo)` → `farmer_calls.transcript` → análise tática *durante* a ligação (`copilot-analyze`, `claude-spin-analyze`) → `entities_extracted` → **`scoring-recalc-client`** gera `farmer_client_scores.signal_modifiers` (jsonb, 1 writer, decay half-life ~30d) → **`visit-score-recalc-client`** faz nudge de churn/expansion → **agenda** (`priority_score`).

**Mas a matéria-prima nunca existiu:**

| Tabela | Realidade |
|---|---|
| `farmer_calls` | **0 linhas** — telefonia é spike, nenhuma ligação fluiu |
| `farmer_client_scores` | 6389 linhas, **0** com `signal_modifiers`, **0** com `last_signal_recalc_at` |

**Dois gaps, não um:** (1) nenhuma ligação chega ao sistema (telefonia spike); (2) não existe a extração pós-call dos 4 sinais. A Fatia 2 ataca o (2) de forma **desacoplada da origem** do transcript, e prova-se com um **piloto real** (não depende do rollout completo da telefonia).

## 3. Decisões (founder 2026-06-16 + 2ª opinião Codex)

| Decisão | Escolha |
|---|---|
| Escopo | **Cérebro desacoplado + piloto real**: extrai os 4 sinais de 1 ligação real (qualquer origem), prova precisão com 1 farmer |
| Loops | **Oferta agora; Compra/catálogo na Fatia 3.** Extrai os 4 sinais de uma vez; produto-gap/demanda ficam **persistidos**, sem consumo ainda |
| Arquitetura | **2 estágios desacoplados + trigger híbrido** (extração ≠ scoring) |
| **Ativação no scoring** | **Shadow-mode → ativação por classe de sinal** (firewall de ativação — Codex). Extrai/persiste/computa deltas **hipotéticos**; só afeta oferta/agenda após eval passar, ligando classe a classe |
| Modelo LLM | **Claude Sonnet 4.6** direto (Anthropic, forced tool-use, prompt caching) — padrão novo do projeto |
| Hardening | **Núcleo money-path + v1 enxuto**: audit metadata, contrato estrito de preço, trigger-fix. State-machine/gates em forma simples (não 5 estados/4 gates) |

## 4. Desenho — 2 estágios desacoplados

### 4.1 Estágio 1 — `extrair-sinais-ligacao` (edge nova)
- Recebe `{ call_id }` (ou varre, ver §7). Lê `farmer_calls.{transcript, customer_user_id, farmer_id}`.
- **Claude Sonnet 4.6** (Anthropic direto, `ANTHROPIC_API_KEY`, **forced tool-use**, prompt caching), gate `authorizeCronOrStaff`.
- Extrai os 4 sinais (§5) → grava em **coluna dedicada** `farmer_calls.sinais_ligacao` (jsonb, **1 writer** = esta edge; money-path: não reusa `entities_extracted`, que tem outro writer no front `build-session-payload.ts:53`).
- **Idempotente por conteúdo:** re-extrai só se `source_transcript_hash` mudou OU `status='erro'`. Não re-processa transcript inalterado.

### 4.2 Estágio 2 — estende `scoring-recalc-client` (já existe)
- **Mudança de input contract** (Codex): hoje a função só lê `entities_extracted, analyses` (`index.ts:232`). Passa a ler **também** `sinais_ligacao`.
- Novo conversor `modifiersFromSinaisLigacao()` → `SignalModifier[]` → entra na agregação/decay que **já roda** (não duplica).
- **Shadow-mode (§6):** os modifiers de `sinais_ligacao` são computados e **persistidos com marca `shadow`**, mas só entram no efeito real (oferta/agenda) por **classe ativada**.

### 4.3 Coluna `sinais_ligacao` — envelope com auditoria (Codex #2)
Não é um blob. Envelope jsonb:
```
{
  schema_version: int,            // versão do schema dos sinais
  extractor_model: text,          // ex. claude-sonnet-4-6
  prompt_version: text,           // versiona o prompt → invalidação/reprocesso
  source_transcript_hash: text,   // sha do transcript usado → idempotência + auditoria
  extracted_at: timestamptz,
  status: 'extraido'|'erro'|'sem_transcript',
  error: text|null,
  sinais: { precos[], marcas_em_uso[], produtos_gap[], demandas_novas[], houve_sinal }
}
```
Sem esses metadados não dá pra auditar, reprocessar nem comparar o piloto honestamente.

## 5. Contrato de extração (forced tool-use)

Cada sinal carrega **`confianca` (0-1)** e **`evidencia`** (trecho literal do transcript). `houve_sinal: bool` é a honestidade — ligação sem sinal marca `false`, **nunca fabrica**.

```
💰 precos[]        { tipo: cliente_paga|concorrente_cobra, produto, valor|null, moeda|null,
                     unidade_base|null, concorrente|null, speaker_is_customer: bool,
                     confianca, evidencia }
🏷️ marcas_em_uso[] { marca, produto|null, e_concorrente|null, speaker_is_customer: bool, confianca, evidencia }
📦 produtos_gap[]  { descricao, familia|null, material|null, dimensao|null, recorrente|null, confianca, evidencia }
🆕 demandas_novas[]{ descricao, contexto|null, urgencia|null, recorrente|null, confianca, evidencia }
   houve_sinal: bool
```

**Regras money-path (precisão > recall):**
- **Evidência obrigatória** — sem trecho literal, descarta o sinal.
- **Ausente ≠ zero** — sem menção de preço → `precos: []`. Nunca inventa número (`Number(null)` é fabricação).
- **Contrato ESTRITO de preço (Codex #1):** um preço só vira ajuste de score se tiver `produto` + `tipo` + `valor` + `moeda` + `unidade_base` + `speaker_is_customer=true`. Faltou unidade comparável (ex.: "ele cobra mais barato" sem número/unidade)? → persiste como **inteligência crua**, mas **não pontua**.
- Campos opcionais tipados em `produtos_gap`/`demandas_novas` (família/material/urgência/recorrente) **agora** evitam virar projeto de re-extração na Fatia 3 (Codex #5) — preenchidos quando a ligação der; ausentes degradam sem quebrar.

> **O pior modo de falha (Codex):** não é o preço alucinado — é o sinal *plausível, com evidência, alta-confiança, mas semanticamente errado* (erro de ASR em jargão pt-BR, unidade ambígua, falante trocado, negação, preço velho) entrando no score e mudando a oferta por 30 dias silenciosamente. A citação prova que o texto existiu, não que a interpretação está certa. Por isso: contrato estrito de preço **+** shadow-mode (§6).

## 6. Fechamento do loop — shadow-mode → ativação por classe (firewall)

A peça que torna a Fatia 2 money-path-safe. Mecanismo único: cada modifier gerado de `sinais_ligacao` carrega sua **classe** (`preco`/`marca`/`demanda`); o consumo aplica só as classes com **flag de ativação ligado** (config). Classe não-ativada = **shadow**: o delta é computado e persistido, mas **não** entra no efeito.

1. **Shadow (estado inicial — todas as classes off):** `modifiersFromSinaisLigacao` computa os deltas e persiste-os com a classe. O `visit-score-recalc-client` (que multiplica churn×0.1, expansion×0.2 — `index.ts:76`) **só aplica** modifiers de classe ativada; os demais ficam visíveis para auditoria mas **não** mudam oferta/agenda.
2. **Eval (§8):** mede precisão **por classe** em calls frescas.
3. **Ativação por classe** (vira o flag, não escreve código novo) — uma classe por vez conforme a precisão dela passa o corte:
   - **`demandas_novas` → expansion** primeiro (erro barato: no máximo uma dica de upsell perdida).
   - **`marcas_em_uso` → contexto/churn** depois.
   - **`precos` (concorrente, numérico) → churn** **por último** (erro caro: muda margem real).

## 7. Trigger híbrido + enqueue (Codex #3)

- **Ao fim da ligação:** o front (após `persistCallSession` inserir `farmer_calls`) dispara `extrair-sinais-ligacao` (fire-and-forget).
- **Cron de varredura (rede de segurança):** pega `farmer_calls` com `transcript` não-nulo e sem extração válida (`sinais_ligacao IS NULL OR status='erro'`). `net.http_post` com **`timeout_milliseconds` explícito** (lição do projeto: default 5s mata silencioso).
- **Enqueue explícito do recalc:** o trigger de scoring hoje dispara em `entities_extracted`, **não** em `sinais_ligacao`. A extração tem que **enfileirar explicitamente** o `scoring-recalc-client` daquele cliente (senão o sinal extrai mas nada recalcula — falha silenciosa). v1: a própria edge de extração chama/enfileira o recalc ao terminar.
- **v1 enxuto de estado:** `status` no envelope (`extraido`/`erro`/`sem_transcript`) + idempotência por `source_transcript_hash + prompt_version`. A state-machine de 5 estados + dead-letter do Codex fica para escala, se o piloto pedir.

## 8. Piloto + eval (rigor — Codex #6)

Money-path: **precisão > recall**, e a prova tem que ser honesta (o builder não define a verdade sozinho).

- **Guia de rotulação predefinido** antes de ver resultados.
- **Blind-review** de cada sinal contra transcript/áudio; **adjudicação founder/farmer** nos desacordos.
- **Precisão por classe de sinal** separada — preço tem a barra mais alta.
- **"Citação certa, interpretação errada" conta como falso positivo.**
- Inclui **calls negativas** (sem sinal comercial) — `houve_sinal=false` tem que acertar.
- **Calibração de confiança** por faixa (0.6-0.7 / 0.7-0.85 / >0.85).
- **Scoring fica off** até o review passar em **calls frescas** (não as usadas pra tunar o prompt). Ativa **classe a classe** (§6.3).

## 9. Escopo — o que **não** entra na Fatia 2

- Consumo de compra/catálogo (produto-gap/demanda → decisão de compra) → **Fatia 3**.
- Gerar pedido de compra automático → Fatia 3 (money-path de compra, exige prove-sql + gate).
- Rollout amplo da telefonia → frente paralela do founder.
- Registro manual estruturado pela farmer → **rejeitado** (a IA capta).
- State-machine de 5 estados / dead-letter / 4 gates separados → só se a escala pedir.

## 10. Riscos / money-path

1. **Sinal plausível-mas-errado** (o pior caso) → mitigado por contrato estrito de preço + shadow-mode + ativação por classe + eval cego.
2. **Transcrição pt-BR com erro de ASR** em jargão industrial → evidência obrigatória + `speaker_is_customer` + revisão contra áudio no piloto.
3. **Trigger não enfileira recalc** → enqueue explícito (§7); a extração sem recalc é falha silenciosa.
4. **Sinal de catálogo apodrece** antes da Fatia 3 → schema tipado versionado agora (§5).
5. **Calibração dos deltas errada** → shadow-mode adia a calibração; só liga após medir distribuição de erro.

## 11. Rollout (Lovable, manual — `lovable-db-operator`/`deploy.md`)

- **Migration:** `ALTER TABLE farmer_calls ADD COLUMN sinais_ligacao jsonb` (+ índice parcial p/ a varredura). Manual no SQL Editor.
- **Edges:** deploy `extrair-sinais-ligacao` (nova) + `scoring-recalc-client` (estendida) via chat do Lovable. **Secret `ANTHROPIC_API_KEY`** no Supabase.
- **Cron:** varredura com `timeout_milliseconds` explícito.
- **Front:** disparo fire-and-forget ao fim da ligação (Publish).
- **Flags de ativação por classe** (config) — começam todas `off` (shadow).
- **Prova:** `prove-sql-money-path` no conversor/migration de risco antes do apply.

## 12. Fatia 3 (esboço — próximo ciclo)
Consumir `produtos_gap`/`demandas_novas` → inteligência de compra/catálogo (agregação "o que o mercado pede que não temos" → input pro otimizador de compras/portal Sayerlack). O schema tipado da §5 é o contrato de entrada.
