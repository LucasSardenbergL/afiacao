# A pendência escrita no PR não é medição — e a medição também envelhece

> 2026-09-06, fechando o chip "edge `omie-nfe-recebimento` (#2201) SEM_PROVA" que o `/fecho` do
> #2207 abriu por fail-closed. Alvo: Passos 2 e 4 da skill `lovable-deploy-verify` e o Passo 3 do
> `/fecho`. Irmão de [`fatia-de-deploy-envelhece.md`](fatia-de-deploy-envelhece.md): lá a **fatia**
> tem eixo TEMPO; aqui é a **pendência** — e a própria medição.

## 1. O que a tarefa dizia, e o que a medição disse

O pedido chegou bem-formado: o corpo do #2201 (mergeado às 22:52Z) listava na seção "Deploy" duas
pendências manuais — (1) deploy da edge pelo chat do Lovable, sonda devendo responder
`v1.1-falha-sai-nao-2xx`; (2) Publish do front. O `edges-pendentes.sh` do `/fecho` tinha
classificado a edge como SEM_PROVA (nenhuma sonda na janela do `pg_net`). O chip mandava CONFIRMAR
antes de pedir deploy redundante — e a confirmação mostrou que, **naquele instante**, não havia o
que pedir. Mas por um motivo diferente do que esta seção afirmou na 1ª versão: a pendência da edge
não era falsa — **ela já tinha sido atendida**, 1h43 antes desta medição (linha em negrito abaixo):

| hora (UTC) | fato | fonte |
|---|---|---|
| 22:52:16 | #2201 mergeado (`82f4fd40d`) | `gh pr view 2201` |
| **23:38:10** | **sonda id 70287 desta edge: 200 + eco de `probe`, `versao v1.0-sensor-inicial`, SEM `fonte` e SEM eco de `edge`** ⇒ bundle anterior aos #1789/#1998. **`PRE_SONDA_FONTE`: a pendência do #2201 era REAL neste instante** | `net._http_response` |
| 23:40 – 01:21 | outra sessão entrega ao founder o prompt de deploy (6 arquivos da fatia) e **o deploy é feito** — é a sessão que produziu [`lista-de-fatia-nao-e-fatia.md`](lista-de-fatia-nao-e-fatia.md) | PR #2216 |
| ~01:20 | `bun run pendencias:deploy` → `omie-nfe-recebimento` ⚪ **NUNCA atestada** (uma de 14) | ledger ∪ janela viva |
| 01:21:45 | leva de 6 sondas (ids 70346–70351): a edge ecoa `probe:true` · `v1.1-falha-sai-nao-2xx` · `fonte e69f5f4f…f49cdb4c` (= mapa da main) | `net._http_response` |
| 01:24:18 | **2ª sonda, só desta edge** (id 70352), mesma resposta — outro ator, 2,5 min depois | idem |
| ~01:25 | `verify-frontend.sh --pai 82f4fd40d^ 'Reprocesse na lista'` → **exit 0**, alvo em `RecebimentoConferencia-D4RXa_wS.js`, controle negativo OK | bytes do bundle |
| 01:30:00 | cron `deploy-atestacoes-colher` grava as 7 respostas (2 desta edge) no ledger | `deploy_atestacoes` |
| ~01:31 | `pendencias:deploy` re-rodado → ✅ confere, "visto há 2 min via sonda"; NUNCA caiu de 14 para 8 | ledger |

Nada a pedir ao founder **às 01:20** — a decisão de não pedir estava certa. O que não se sustenta é
a inferência sobre o PASSADO: a leitura de 01:21 mede o estado DEPOIS do conserto, e dela não se
deduz que nunca houve o que consertar. As seis sondas da leva ecoaram `probe:true` — nenhum fluxo
real disparou.

## 2. A classe

- **A seção "Deploy" do corpo do PR é RECADO escrito na hora do PR, não medição.** Envelhece no
  instante em que alguém age — o founder, a sessão dona do PR, outro chip. "Publish pendente" e
  "deploy pendente" são hipóteses a MEDIR antes de virarem pedido.
- **O veredito do ledger tem eixo TEMPO, como o closure.** Em 4 minutos ele foi de NUNCA atestada a
  ✅ confere. A regra do git ("sincronize antes de MEDIR **e** antes de ENTREGAR") vale igual:
  re-rode `bun run pendencias:deploy` (ou `bun run sonda:sql --so-leitura <edge> | psql-ro`) na
  hora de ENTREGAR o pedido, não só ao começar a sessão.
- **O front se mede ANTES de pedir Publish.** O Passo 4 da skill está escrito "após Publish", mas o
  `verify-frontend.sh` responde a mesma pergunta antes: exit 0 cancela a linha "Publish pendente";
  só exit 1 (com `CONTROLE_POSITIVO_OK`) a mantém. Custa ~1 min; um Publish redundante custa um
  clique do founder e um build que embarca tudo o mais que estiver na main.
- ⚠️ **A medição envelhece para os DOIS lados — e o lado esquecido é o que absolve.** O recado do PR
  envelhece porque alguém age; a medição que o confere envelhece pelo mesmo motivo, na direção
  oposta. Medir depois do conserto devolve ✅ e a leitura tentadora é "o recado era falso" — quando
  o que houve foi **recado ATENDIDO**. Os dois desfechos são idênticos no instante da medição e
  opostos no que ensinam: um diz que a pendência do PR é ruído, o outro que ela funcionou. Só um
  ponto ANTERIOR os separa, e aqui ele existia (o 70287, medido por outra sessão). **Regra: antes de
  concluir que uma pendência era falsa, procure medição anterior à sua** — `net._http_response` por
  `request_id`, ou o ledger `deploy_atestacoes`. Sem ponto anterior, o veredito honesto é "não há o
  que pedir agora", nunca "nunca houve".
- **Fan-out de chips = sondas duplicadas.** Dois atores sondaram a mesma edge com 2,5 min de
  diferença. Inócuo aqui (bundle com sensor: o probe é idempotente). Numa edge **cara** com bundle
  pré-sensor, cada colagem seria uma execução do fluxo real — e o `/fecho` abre um chip por sessão
  que fecha na janela. A mitigação é na fonte (chip: o `/fecho` consultar o ledger antes de abrir
  chip — hoje `edges-pendentes.sh` não cita `deploy_atestacoes`) e a ordem "deploy ANTES, sonda
  depois" para as caras.

## 3. O que mudou

- `docs/agent/deploy.md` §Verificação de deploy: bullet "a pendência do PR é recado — meça antes de
  pedir" (ledger + bytes, com a ordem de re-medição).
- `docs/agent/deploy.md` §custo da sonda: a linha da `omie-nfe-recebimento` na tabela das baratas
  ganhou a prova no pai da sonda (`a086cc60a^`: `Authorization` sem `Bearer ` → 401 nas linhas
  342-344, antes do `req.json()` da linha 378). O doc dizia que o rigor só tinha sido feito na
  `process-nfe`.
- Chip para o founder: `/fecho` consultar o ledger `deploy_atestacoes` antes de abrir chip de edge.

## 4. O que NÃO mudou, de propósito

- Gates de sonda (`sonda:bump`, `sonda:fingerprint`, `sonda:fanout`): intocados.
- `SKILL.md` da `lovable-deploy-verify`: intocada (arquivo quente, várias worktrees); a regra vive
  no `deploy.md`, que a skill já manda ler.
- Nenhum pedido de deploy foi entregue POR ESTA SESSÃO, e às 01:20 era o desfecho certo — o deploy
  já tinha sido feito a pedido de outra. O chip existiu para isso e funcionou: ele mandou CONFIRMAR
  antes de pedir, e a confirmação evitou o pedido redundante.
