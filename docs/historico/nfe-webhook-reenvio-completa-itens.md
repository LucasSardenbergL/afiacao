# omie-nfe-webhook: o reenvio do webhook passa a COMPLETAR o recebimento que ficou sem itens

**Origem:** plano-melhoria-v2, item 1 do Top 5 (achado do Codex sobre o repo). **Money-path:** entrada de mercadoria.

## O defeito (confirmado em `index.ts`, não só na hipótese)

Cabeçalho inserido em `nfe_recebimentos` ANTES dos itens, sem transação (PostgREST = transação por REQUISIÇÃO). Se o lote de `nfe_recebimento_itens` falhasse: 500 e o cabeçalho ficava. O reenvio do Omie caía no guard de duplicata — `select id … eq(chave_acesso)` — e respondia 200 "já importada" sem reinserir nada. O próprio `versao.ts` já descrevia isso como "desfazer é trabalho manual no banco".

**Prod (psql-ro, 2026-10-18):** 72 recebimentos, 57 sem itens — mas **0/72** têm `xml_completo`/`omie_nfe_id` e todos têm `omie_id_receb` no horário do cron da **sync**: os 4 `pendente` sem itens vêm do incidente de NCM da `omie-nfe-recebimento-sync` (2026-09-26), não deste webhook. O webhook aparentemente **não recebe tráfego real hoje** (sem chamador conhecido desde 2026-10-01). A correção é defensiva: a porta existe e está apontada para o nosso banco.

## O desenho (2 pareceres Codex; o 1º REPROVOU a versão inicial)

A 1ª versão era "idempotência de retry" ingênua: guard lê `count(itens)`, repara se zero. O Codex mostrou com contramodelo que **dois webhooks simultâneos produzem 2N itens** (o UNIQUE do pai não protege os filhos) e que `pendente + zero` também é "outro writer trabalhando". Redesenho, sem migration:

- **`id` determinístico dos itens** (UUID v8 de SHA-256 de `cabeçalho|sequência|posição`): o 2º lote colide na PK, lote inteiro rejeitado (0 ou N, nunca 2N); quem perde relê e responde "já importada". A posição entra porque `nItem` pode repetir no payload.
- **Reparável** = `pendente` + count 0 **comprovado** (inteiro ≥ 0; string/NaN/ausente é ERRO, nunca zero) + `conferente_id`/`conferido_at`/`efetivado_at`/`efetivacao_lock_at` NULL **comprovados** (campo ausente da resposta = "em uso") + payload com itens.
- **23505 no cabeçalho** (corrida no UNIQUE) relê UMA vez e segue pelo caminho do existente.
- **NCM normalizado** (`normalizarNcm` da sync): erro determinístico no lote repetiria a mesma falha a cada reenvio — o retry nunca consertaria.
- `porta.ts` separa o adaptador do supabase-js (testável sob `--no-remote`); `importacao.ts` só conhece a porta estreita.

**Fica aberto, de propósito** (só fecha com RPC + `pg_advisory_xact_lock` por chave + `UNIQUE(nfe_recebimento_id, sequencia)` — migration manual no Lovable, PR próprio): webhook×sync (a sync gera ids aleatórios) e `reconcile` promovendo `pendente→efetivado` entre a leitura e o insert. Sem migration não há lock.

## A prova

25 testes Deno (`importacao_test.ts` + `porta_test.ts`), banco falso que **guarda estado** e modela só a atomicidade real do PostgREST (um insert = uma transação; PK barra com 23505). Corridas por **barreiras explícitas** (não `Promise.all`, que cai na ordem favorável). Falsificação em laço com controle verde na mesma invocação: 5 sabotagens (reparo desligado · id aleatório · contagem desconhecida→0 · gate de estado removido · 23505 nos itens aprovado às cegas), cada uma derrubando os testes **específicos** (não compilação), restauro verde.

Armadilha de teste que custou 2 rodadas: gancho de barreira que lia `vez` **depois** do `await` — o 1º chamador também caía na barreira do 2º. Capture o número da vez numa variável local.

## Achados laterais (fora do escopo, registrados)

- `RecebimentoConferencia.tsx` renderiza `item.descricao_produto`, mas a coluna é `descricao` (select `nfe_recebimento_itens(*)`, sem alias) → descrição em branco na conferência para TODOS os itens, dos dois writers.
- Sem coluna de origem no cabeçalho, o denominador "cabeçalhos criados pelo webhook" não existe; vai junto da RPC.
