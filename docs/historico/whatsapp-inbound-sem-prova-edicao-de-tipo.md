# `whatsapp-inbound` saiu `SEM_PROVA` — a edição do agente do Lovable era só de TIPO, e a edge nunca teve tráfego

> 2026-09-26. Anomalia do `/fecho` de 2026-09-26, investigada em sessão própria. Nenhum deploy feito.

## O alarme

`bash .claude/skills/fecho/scripts/edges-pendentes.sh` listou `whatsapp-inbound` como `SEM_PROVA —
fora do mapa de sondas`. Contexto: em 2026-09-24 ~17:37Z, no turno em que deployou a
`omie-sync-sku-items` (#2539), o agente do Lovable editou a `whatsapp-inbound` sem pedido (3 commits do
bot: `de48dff0a`, `a20f2fe30`, `5c9ddaff2`), e o #2541 (`1460ea5e7`) reverteu no repo. O revert afirmava
"a edge em produção não foi redeployada", sem citar a prova.

## O que foi medido

1. **A edição era só de TIPO, runtime idêntico.** O diff do bot troca `ReturnType<typeof createClient>`
   por `type Db = SupabaseClient<any>` (import `type`), mais um comentário. Tipo some no runtime:
   nenhuma sonda de comportamento distingue a versão editada da revertida.
2. **Mudança líquida ZERO.** O blob da main depois do revert (`dc41df758`) é byte-idêntico ao do #1316
   (2026-07-12), que foi o último PR a mudar a edge.
3. **Não houve deploy da edição no trace.** O histórico do chat (`mcp__lovable__list_messages`, leitura)
   mostra, no turno de 17:38:15Z, UMA chamada `supabase--deploy_edge_functions` com
   `function_names: ["omie-sync-sku-items"]`. A edição da `whatsapp-inbound` veio DEPOIS (`line_replace` +
   `sed` + `deno check`) e não teve deploy. Os dois turnos seguintes do chat (25/09 23:44Z, 26/09 01:00Z)
   não citam a edge. O deploy sai do sandbox por essa tool, visível no trace
   ([piloto-deploy-mcp-lovable.md](piloto-deploy-mcp-lovable.md)).
4. **O canal está DORMENTE.** `whatsapp_webhook_events` tem 1 linha na vida inteira (2026-05-30 18:33Z, dia
   do #479, processada pela v0 e com o dado de teste apagado depois: contadores de `pg_stat` mostram 1
   insert/1 delete em conversas e mensagens). `whatsapp_messages`, `whatsapp_conversations` e
   `whatsapp_template_sends` estão com 0 linhas.
5. **Nenhuma via discrimina a versão servida.** A edge tem `verify_jwt = false` e o gate `x-whatsapp-secret`
   responde o MESMO 401 `{"error":"Unauthorized"}` nas três versões históricas (v0 #479/#513 aceitava
   `?token=`; v1 #1123 só header; v2 #1316 processa `statuses[]`). Sem chamada autorizada não há escrita
   a observar ([deploy.md](../agent/deploy.md) §Assinatura no PRÓPRIO log: presença prova, ausência não
   reprova).

## Veredito

A versão servida é **INDETERMINADA** entre v0, v1 e v2 desde julho, e **não por causa de 24/09**: o
deploy do #1316 ("2 edges pelo chat do Lovable", [programa-canal-whatsapp.md](programa-canal-whatsapp.md)
§Ações externas) nunca teve confirmação registrada. A suspeita específica do alarme (a versão editada
no ar) é irrelevante no runtime.

## Por que o `/fecho` pegou uma mudança líquida zero, e por que estava certo

A via (b) do `edges-pendentes.sh` é `git log base..REF --name-only`: é POR COMMIT, não diff líquido, então
edição + revert na janela entra na lista. Não é defeito. Diff líquido zero na main não prova que o bot não
deployou a cópia editada. O que fechou a dúvida foi o trace do chat e a natureza da edição, que o script
não tem como ler.

## O que falta, e por que não é deploy agora

O pacote sai (`bun scripts/pendencias-pacote.ts whatsapp-inbound`, 2 arquivos), mas a pós-condição dele
(`sonda:sql` + `pendencias:deploy`) **não fecha para edge fora do mapa**: sem `versao.ts` a sonda cai no
gate do webhook, e o ledger não enxerga a edge. Um deploy hoje seria inatestável. O caminho que prova é
instrumentar no molde da `omie-webhook` (sonda com gate próprio ANTES do gate do webhook, `versao.ts`,
entrada no mapa e no contrato; allowlist do cron só se `sonda:cron-prova` der 100% `PASSA`) e deployar
uma vez. A decisão de instrumentar, e de quando, é do founder. Com o canal dormente, o custo de esperar
é nulo até o go-live.

## Desfecho (mesma sessão)

O founder escolheu instrumentar agora. A edge ganhou `versao.ts` (`v1.0-sensor-inicial`, 13ª leva)
no molde da `omie-webhook`. Antes do PR, um harness local capturou o handler do `Deno.serve`, com
segredos falsos e `SUPABASE_URL` numa porta fechada, e executou 10 caminhos nos dois bundles:

- no novo, a sonda responde `{probe:true, versao, edge, fonte}` com `x-cron-secret`, 401 sem
  credencial e 400 quando o `probe` é ambíguo;
- os 6 caminhos que não são sonda respondem byte a byte igual ao bundle anterior;
- no bundle anterior, toda sonda dá 401 antes de qualquer I/O.

O gate de contrato foi falsificado: sem o `authorizeCronOrStaff` da sonda ele reprova nomeando a
edge, e restaurado volta ao verde. O deploy continua dependendo do OK do founder: depois do merge,
pacote pelo ledger e uma sonda para a 1ª atestação.

**No ar (2026-09-26, com OK do founder).** Pacote `07d72dbb0bc1` enviado pela sessão via MCP (1,1
crédito). O agente conferiu os 5 `sha256` contra `origin/main@d65247058` e o workspace, chamou
`deploy_edge_functions(["whatsapp-inbound"])` e **não editou nada**. O prompt ganhou uma frase além
do gerado, proibindo edição neste turno, por causa de 24/09. A 1ª atestação saiu pelo `db:aplicar`
(`db/sonda-pos-deploy-whatsapp-inbound-2026-09-26.sql`, tentativa #165). O `request_id` 93703
respondeu 200 com `edge` e `versao v1.0-sensor-inicial`, e com `fonte e2386801…c315`, idêntico ao
mapa da main: **DEPLOY CONFIRMADO**, com o grafo inteiro deployado verbatim.

**A/B natural no mesmo dia (sinal, não prova: n=1 de cada lado).** Às 10:02Z outra sessão deployou a
`omie-sync-estoque` (#2573) com o prompt do gerador, que não tem a frase. O agente repetiu a edição
não pedida na `whatsapp-inbound` (`SupabaseClient<any>`) e editou também a `sync-reprocess`
(`f84d7772e`/`eec8598d7`, revertidos no #2579; a main ficou vermelha no `sonda:fingerprint`). Com a
frase, zero edição; sem ela, duas. O conserto de CLASSE é o chip "Blindar o prompt de deploy contra
edições do agente": a frase entra no texto do Passo 2 do `pendencias-pacote.ts`.

Dois atritos do caminho, para o próximo:

- O log do `db:aplicar` guarda só o marcador, não a célula do PASSO 2. Serviu o PASSO 2 sem mapa
  (`sonda:sql --so-leitura`), porque o bundle novo ecoa o slug.
- O `--so-leitura` recusa enquanto o `sonda-fingerprints.ts` do disco difere da `origin/main`. Aqui
  outra sessão tinha mudado a entrada da `omie-sync-estoque` no meio do caminho. Rebase e repete.

**Checklist do go-live do canal** (fora deste deploy):

- conferir que `WHATSAPP_WEBHOOK_SECRET` existe (a edge o lê desde o #479; sem ele, tudo 401);
- rotacioná-lo, como pede o #1123;
- configurar a 360dialog para mandar o segredo no HEADER `x-whatsapp-secret`: a v0 aceitava
  `?token=`, e a versão no ar não aceita mais.
