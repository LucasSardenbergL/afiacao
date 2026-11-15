# Rescan do scanner Lovable Security — lote 2 (2026-11-14/15)

Continuação do [lote 1](scanner-lovable-rescan-lote1.md). Foram três achados da triagem cruzada (Claude, Codex e Fable 5.2), e cada um foi conferido na PROD via `psql-ro` antes de qualquer código.

## O que entrou ([#3904](https://github.com/LucasSardenbergL/afiacao/pull/3904))

| Achado | Correção |
|---|---|
| 🔴 Token OAuth da Nvoip (access e refresh) em `company_config`, que qualquer employee lê pelo PostgREST | O cache foi para `nvoip_oauth_cache` (RLS sem policy, só service_role). As 3 linhas saíram, e a CHECK `company_config_sem_token_nvoip` barra a volta. `nvoip-calls` v1.2 |
| 🔴 O fallback SIP entregava a senha do ramal master a qualquer staff sem ramal, e ao cron | `nvoip-sip-creds` v1.0: sem ramal próprio, 403. Sem usuário, 403. Erro de leitura, 500. A edge ganhou `versao.ts` |
| 🟠 O staff desfazia o opt-out do WhatsApp (LGPD) | O trigger `trg_whatsapp_conversations_guarda_opt_in` é uma allowlist de papéis de servidor: o client não cria conversa, não troca telefone, não muda consentimento e não apaga conversa opt-out. Também saiu o TRUNCATE. O cliente volta mandando VOLTAR (`whatsapp-inbound` v1.4, em todas as variantes do número) |
| 🟠 Um retry concorrente postava o template pago 2×, e não havia teto diário | A RPC `whatsapp_template_reservar` faz numa transação a idempotência pela chave, o retry só de recusa provada (`retry_seguro`, como compare-and-set) e o teto diário (default 200), com rollback por savepoint e token por tentativa. `whatsapp-send-template` v1.2 |

Migration `20261114210026_seg_lote2_nvoip_optout_template.sql`, colada pelo founder e validada via psql-ro: ACLs, RLS, trigger `O`, `prosecdef`, `search_path`, colunas e 0 tokens em `company_config`.

## Lições

- **O retry seguro exige prova de não-aceite, não só o status HTTP.** A 1ª versão liberava retry em qualquer 4xx. O Codex apontou que um 4xx com corpo ilegível não prova recusa, e que um 2xx sem id de mensagem não prova envio. Hoje vale assim: recusa provada é 4xx com erro estruturado e sem `messages`. Tudo o mais fica `failed` sem retry, bloqueado para conciliação.
- **O consentimento é do TELEFONE, não da linha.** Guardar o opt-out na conversa e proteger só aquela linha deixava três atalhos: criar outra conversa com o mesmo número, mover o número de outra conversa ou apagar a conversa. A guarda cobre os três, e o envio confere o opt-out em toda variante do número.
- **Uma camada que a falsificação não derruba pede o caso que falta.** Na 1ª rodada, a sabotagem S7 (tirar `status = 'failed'` do claim) ficou verde, porque o `retry_seguro` zerado no claim já cobria o caminho feliz. O teste ganhou o estado inconsistente (`sent` com `retry_seguro`). Na 2ª rodada, as 15 sabotagens ficaram vermelhas nos dois locales.
- **A 1ª sonda de uma edge que nunca foi atestada pode vazar segredo.** A `nvoip-sip-creds` antiga, chamada pelo cron, devolveria a senha do ramal master na resposta da sonda (gravada em `net._http_response`). A saída foi o pacote por nome: `bun scripts/pendencias-pacote.ts <edges…>`. Ele colocou a edge na leva sem a 1ª sonda, e a sonda só rodou depois do deploy, contra a versão nova.

## Prova

`db/test-seg-lote2.sh` (PG17): 50 asserções, controle pré-migration verde e concorrência real (2 sessões no mesmo `failed` com COMMIT e com ROLLBACK, e 8 chamadas paralelas com teto 3 que dão exatamente 3). Codex em 3 rodadas: desenho aprovado com ajustes, código não aprovado (6 achados, incorporados) e conferência aprovada com ajustes (o VOLTAR nas variantes, incorporado).

## Deploy (4 edges, uma onda, 1,1 crédito)

- Migration aplicada pelo founder no SQL Editor antes das edges.
- O pacote por nome `23d7dfb91fb4` saiu contra `b2798eb91`, com 20/20 hashes. Ele deixou de fora a `fin-cashflow-engine` (#3903), de outra sessão. O bot respondeu "No files were edited.", e o sensor não achou commit dele depois do envio.
- Sonda pelo envelope, tentativa #1125: 4 DEPLOY CONFIRMADO (versão e fonte). Do lote 2, o `pendencias:deploy` não tem pendente. O rc=1 que sobra é de `fin-cashflow-engine` e `sayerlack-importar-pedido-portal`, de outros PRs.
- Publish: `AdminVendorSipCredentials`, `enviarProposta` e `src/lib/whatsapp/*`.

## Fica para o founder (opcional)

- Apagar os secrets `NVOIP_SIP_USER`/`NVOIP_SIP_PASS`, que ficaram sem uso.
- Rotacionar o usuário e o token da Nvoip, porque o refresh_token ficou legível por staff até 2026-11-15.
- Marcar no scanner os achados do lote 2 como corrigidos depois do próximo rescan.

## Fora do lote 2

- **Lote 3:** limites do webhook Gmail, cota de IA no extrator via vision, validação do número discado.
