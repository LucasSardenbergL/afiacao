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
antes de pedir deploy redundante — e a confirmação desmontou as duas pendências:

| hora (UTC) | fato | fonte |
|---|---|---|
| 22:52:16 | #2201 mergeado (`82f4fd40d`) | `gh pr view 2201` |
| ~01:20 | `bun run pendencias:deploy` → `omie-nfe-recebimento` ⚪ **NUNCA atestada** (uma de 14) | ledger ∪ janela viva |
| 01:21:45 | leva de 6 sondas (ids 70346–70351): a edge ecoa `probe:true` · `v1.1-falha-sai-nao-2xx` · `fonte e69f5f4f…f49cdb4c` (= mapa da main) | `net._http_response` |
| 01:24:18 | **2ª sonda, só desta edge** (id 70352), mesma resposta — outro ator, 2,5 min depois | idem |
| ~01:25 | `verify-frontend.sh --pai 82f4fd40d^ 'Reprocesse na lista'` → **exit 0**, alvo em `RecebimentoConferencia-D4RXa_wS.js`, controle negativo OK | bytes do bundle |
| 01:30:00 | cron `deploy-atestacoes-colher` grava as 7 respostas (2 desta edge) no ledger | `deploy_atestacoes` |
| ~01:31 | `pendencias:deploy` re-rodado → ✅ confere, "visto há 2 min via sonda"; NUNCA caiu de 14 para 8 | ledger |

Nada a pedir ao founder. As seis sondas da leva ecoaram `probe:true` — nenhum fluxo real disparou.

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
- Nenhum pedido de deploy foi entregue — era o desfecho certo, e o chip existiu para isso.
