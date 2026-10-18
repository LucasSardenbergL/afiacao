# Recebimento de NF-e: cabeçalho + itens numa TRANSAÇÃO (RPC `importar_nfe_recebimento`)

**Origem:** follow-up deliberado do #3142 (`omie-nfe-webhook` v1.3, [nfe-webhook-reenvio-completa-itens.md](nfe-webhook-reenvio-completa-itens.md)). **Money-path:** entrada de mercadoria. **Runbook de aplicação:** [`docs/runbooks/importar-nfe-recebimento-rpc.md`](../runbooks/importar-nfe-recebimento-rpc.md).

## O que ficava aberto sem migration

Webhook e sync materializavam NF-e em DUAS requisições PostgREST (cabeçalho, depois itens). O #3142 fechou webhook×webhook com ids determinísticos, mas (1) a **sync gravava itens com id aleatório** — a PK determinística não a barrava: webhook×sync na mesma chave podia dar 2N; e (2) o **`omie-nfe-reconcile`** podia promover `pendente→efetivado` entre a leitura do guard e o insert — itens injetados em recebimento efetivado. Sem lock no banco não há como fechar.

**Prod (psql-ro, 2026-10-18 ~21:00 UTC):** 72 cabeçalhos / 133 itens; **0 duplicatas** em `(nfe_recebimento_id, sequencia)`; 57 sem itens (52 efetivado · 4 pendente · 1 falha_efetivacao); os **4 `pendente` têm os 4 sinais de uso NULL** → reparáveis; webhook sem tráfego (0/72 com xml/omie_nfe_id).

## O desenho — e o que o Codex mudou nele

Parecer de DESENHO (gpt-6-astra · max · 251s · 107k tokens): **REPROVADO na forma proposta, sem P0**. O núcleo (advisory lock por chave + `FOR UPDATE` no cabeçalho + cabeçalho e lote no mesmo commit, SECURITY INVOKER pela service_role, RPC-only sem fallback) foi confirmado com contramodelo; os P1 mudaram régua e fronteira:

| Codex (P1) | O que entrou |
|---|---|
| Cardinalidade igual não é certificado (`{1,2}` × `{1,3}`; mesma sequência com quantidade 10× maior) | "já importada" exige o MESMO CONJUNTO `(sequencia, codigo_produto, quantidade_nfe)`; diferença = `divergente` com motivo `cardinalidade`/`conteudo dos itens` |
| Lote vazio em cabeçalho novo era "importada" — o órfão que o próprio contrato aceita | `NFE03`: nada gravado. Vazio sobre cabeçalho vazio = `bloqueada` (nunca 2xx sem itens) |
| Reparo inalcançável: a triagem do cron pulava pela existência do cabeçalho e o botão respondia "já importada" | triagem compartilhada `triarCabecalho`: `pendente` + 0 itens comprovados + 4 sinais NULL = **reparável** → segue à consulta/RPC; o resto é completo |
| Rollback total reabre a fome da fila (NF-e inválida volta a parecer inédita e disputa a única consulta da rodada) | `nfe_importacao_falhas` escrita pelas edges FORA da transação abortada (RPC `…_falha_registrar`, `tentativas+1` atômico); a RPC apaga no sucesso; ≥3 estaciona a chave na triagem; o botão ignora o estacionamento |
| "Retry eterno até alguém olhar" é premissa falsa (Omie: 3 tentativas + DLQ 5 dias em QUALQUER não-2xx) | erro de dado = 422 + registro durável; `bloqueada`/`divergente` = 409 |
| Ordem migration→edges precisa considerar versões mistas: botão ANTIGO com DELETE de compensação apaga em cascata itens que a RPC reparou | DELETE de compensação removido; as duas edges na MESMA leva, logo após a migration; janela documentada no runbook |
| `origem` deve significar quem CRIOU; reparo registra à parte | `reparada_origem`/`reparada_em`; `origem` intacta (NULL de legado segue NULL) |
| Reparo entre origens ok, mas metadados conflitantes = divergência, não escolha | reparo exige mesmo `warehouse_id` e `omie_id_receb` compatível; metadados AUSENTES são preenchidos sob o mesmo lock |

Decisões minhas (não do Codex): `importacao_chave` como 3ª origem (o botão é um writer distinto da sync); sequência numérica em string vale (`"01"` ≡ `1`); o id determinístico do TS saiu — UNIQUE + lock o substituem.

## A prova (`db/test-importar-nfe-recebimento.sh`, no núcleo CI com `falsificar=8`)

PG17 descartável aplica o SQL REAL 2× (idempotência + PRE md5). **65 asserts**: os 5 desfechos, NFE01/02/03 e 22001 por SQLSTATE (WHEN OTHERS re-lança), rollback total (nenhum cabeçalho órfão; reparo falho preserva o anterior), UNIQUE por fora da RPC, ACL por `has_function_privilege` E 42501, PRE anti-deriva abortando em A2, e **duas conexões com barreira observada** (`pg_blocking_pids`, nunca sleep): webhook×sync na chave NOVA (a 2ª fica presa no advisory e sai `ja_importada`, N itens), reconcile depois da RPC (espera o `FOR UPDATE`, promove cabeçalho COM itens) e reconcile ANTES segurando a linha (a RPC espera, relê a tupla promovida, `bloqueada`, 0 itens).

**Falsificação, 8/8 vermelhas no assert certo**, com três lições de dente:
- **Sem `FOR UPDATE` a RPC ainda bloqueia** — no UPDATE do reparo. "B preso" fica verde; o que fica vermelho é **itens injetados num cabeçalho efetivado** (a janela SELECT→UPDATE). Teste de lock precisa do adversário segurando a linha ANTES.
- **`REVOKE … FROM anon` é redundante com o de PUBLIC**: deletá-lo não muda nada. Só CONCEDER expõe — e aí o **42501 continua vindo da TABELA** (INVOKER): a testemunha é `has_function_privilege`, nunca só o SQLSTATE (exatamente o aviso do Codex).
- Seed com `status='efetivado'` E `efetivado_at` tem DUAS camadas; sabotar o gate de status ficava verde pela 2ª. O caso de uma camada só é `falha_efetivacao` (o 1 de prod).

Edges: 74 testes Deno (`--no-remote`): interpretação fail-closed do jsonb, classificação de erro, triagem, tradução HTTP do webhook, laço real do cron com os desfechos novos.

## Deploy (manual, 3 camadas) e o que fica

Migration (founder no SQL Editor com `BEGIN/COMMIT`, ou `bun run db:aplicar` após o merge) → validação psql-ro → `NOTIFY pgrst` → `pendencias:deploy` das duas edges na mesma leva. **Passivo visível, não resolvido:** 52 `efetivado` + 1 `falha_efetivacao` sem itens (a RPC responde `bloqueada`); os 4 `pendente` o cron deve reparar sozinho em 1–2 dias (o denominador `origem`/`reparada_origem` nasce aqui). Webhook segue sem tráfego: a correção é para o dia em que for apontado.
