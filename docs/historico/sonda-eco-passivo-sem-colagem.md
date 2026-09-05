# A sonda que se acha sozinha — e a linha do CRON que quase virou veredito

> 2026-08-30, verificando `generate-bundle-argument` (#2101). Alvo:
> `scripts/sonda-versao-sql.ts`. Receita vigente: `docs/agent/deploy.md`
> §"Sondar VÁRIAS edges numa tacada (leva inteira)".

## 1. O passo manual que não acontece produz veredito que se lê como bug

O SQL de sondagem tinha dois blocos: o PASSO 1 disparava `net.http_post` e devolvia
`{"edge": request_id}`; o PASSO 2 tinha um `jsonb_each_text('{}')` onde o operador colava esse
JSON **à mão**. O founder rodou e voltou com:

```
veredito = "SEM ID — esta edge não saiu no JSON colado (bloco errado, ou trava fechada)"
```

O disparo tinha funcionado: 4 respostas HTTP 200 em `net._http_response` (ids 64012/64018/64019/64020).
Só a colagem não aconteceu. A mensagem é **honesta** — ela descreve exatamente o que a query viu —
mas na leitura rápida passa por problema de deploy, e o custo foi um round-trip inteiro com o
founder por um deploy que já estava no ar.

A lição não é "escreva mensagem melhor". É que **um passo manual entre dois blocos é um passo que
vai faltar**, e o veredito de um insumo faltante compete, na cabeça de quem lê, com o veredito do
sistema medido. Quando o dado necessário já existe em outro lugar, tirar o humano do meio vale mais
do que qualquer redação.

## 2. O dado já existia: a resposta carrega o próprio nome

`criarRespostaSonda` (`supabase/functions/_shared/sonda-versao.ts`) devolve
`{ok, probe, versao, edge, fonte}` — o **slug está no corpo**. Então o PASSO 2 acha a linha sozinho,
sem id nenhum: procura, na janela, a resposta que diz ser daquela edge. `--so-leitura` roda no
`psql-ro` e o agente lê o veredito sem intermediário.

## 3. ⚠️ Casar por identidade PARCIAL pega a linha de OUTRA execução

Casar só por `corpo ->> 'edge' = '<slug>'` **parece** suficiente e não é. Medido em prod no mesmo
dia:

| edge | `probe` | linhas em 6h |
|---|---|---|
| `analytics-outbox-drain` | *(ausente)* | **72** |
| `generate-bundle-argument` | `true` | 5 |

As 72 são o **cron** da `analytics-outbox-drain`, de 5 em 5 minutos: ele responde
`{"edge":…,"versao":…}` sem `probe`, porque é um run REAL, não uma sonda. Casando só pelo slug, o
`ORDER BY created DESC LIMIT 1` escolhe a linha do cron — e como o `probe` dela é nulo, o veredito
cai no `ELSE` e sai **`BUNDLE VELHO` citando a versão CERTA**. Falso NEGATIVO fabricado a partir da
linha de outra execução, cujo desfecho é redeployar edge à toa.

Provado com as duas consultas lado a lado, na mesma janela: `só-slug` devolveu a resposta 64047
(`probe` ausente); `slug+probe` devolveu **zero**.

**A regra:** o predicado de casamento tem de conter tudo que separa "resposta à MINHA pergunta" de
"resposta que por acaso fala do mesmo objeto". Aqui é o `probe:true`. Ele não é só critério de
julgamento — é critério de **identidade da linha**, e o lugar dele é o `WHERE` do casamento.

## 4. ⚠️ `ORDER BY created DESC` não é ordem total

Em prod, as respostas **64031 e 64032 têm `created` idêntico ao microssegundo** (duas edges da mesma
leva, disparadas na mesma execução). `ORDER BY created DESC` sozinho deixa a escolha do `LIMIT 1`
para o plano, não para o dado. Precisa de `, id DESC`. É a mesma família do `.order` estável do
PostgREST — e aqui o empate não é hipótese, é o caso NORMAL.

## 5. ⚠️ O que o eco NÃO alcança — e por que contar não resolve

Bundle **PRE-SENSOR** (HTTP 200 rodando o fluxo real) e **recusa HTTP** (>=400) respondem **sem** eco
do slug: são invisíveis para a busca por eco, e caem junto com "não disparou" e "ainda não chegou".
Ausência de linha ⇒ `INDETERMINADO` que **nomeia as três causas**, nunca "bundle velho" — é ausência
de dado.

A tentação é *contar* as respostas sem eco na janela e usar o número como sinal. **Não funciona:** a
janela é cheia de cron alheio (72 linhas de uma edge só, acima), então o contador mede ruído. Quem
separa a causa (c) é o `request_id` do disparo — e é só para isso que a colagem sobrevive, agora
**opcional**.

## 6. ⚠️ A asserção por substring solto cega quando o texto passa a existir em OUTRO lugar

Achado pelo `mutcheck` na própria entrega. O teste que protegia o `probe:true` do ramo
`DEPLOY CONFIRMADO` era:

```ts
expect(sql).toMatch(/corpo ->> 'probe' = 'true'/);
```

Verde antes e depois. Mas o casamento novo (§3) introduziu uma **segunda** ocorrência legítima da
mesma string, no `LATERAL`. A partir daí, o mutante que remove o `probe` do ramo `CONFIRMADO`
passou a **SOBREVIVER**: o regex continuava casando — na outra ocorrência. O conserto é escopar pelo
alias (`l.corpo ->> 'probe' = 'true'`).

**A regra:** acrescentar uma ocorrência legítima de um texto **desarma silenciosamente toda asserção
não-escopada sobre ele**. Nada fica vermelho; o gate só para de medir. É a família de
`gates-textuais-cegos.md`, com o gatilho invertido — lá o texto some da medição, aqui ele *aparece*
onde a medição não esperava. E é a razão de o `mutcheck` existir: a suíte estava verde, e verde não
é poder.

## 7. A divisão de trabalho certa: o founder dispara, o agente lê

Provado nesta sessão, no `psql-ro`: o disparo precisa do founder porque lê `vault.decrypted_secrets`
(`permission denied for schema vault`) e faz INSERT via `net.http_post`
(`cannot execute INSERT in a read-only transaction`). A **leitura** é `SELECT` em
`net._http_response`, que o wrapper read-only serve.

```bash
bun run sonda:sql --so-disparo <edge>…                               # cole ISTO no SQL Editor
bun run sonda:sql --so-leitura <edge>… | ~/.config/afiacao/psql-ro   # e leia você mesmo
```

A numeração dos passos é **absoluta** nos dois recortes: o founder vê 1 e 3, o agente vê 2 e 4, e
"PASSO 2" nomeia a mesma coisa nos dois lados da conversa.

## 8. ⚠️ `psql -f` devolve exit 0 COM erro de SQL

Colhido na validação desta entrega: um `UNION ALL` mal parentizado abortou com
`ERROR: syntax error at or near "UNION"` e o `psql` ainda assim saiu com **0**. Sem
`-v ON_ERROR_STOP=1`, o exit code do `psql` não é veredito — é a família das armadilhas de
`evidencia-positiva-shell.md`. Toda prova de SQL contra prod nesta entrega foi re-rodada com o flag.

## 9. ⚠️ `git add` durante uma falsificação COMMITA o mutante — e as checagens depois mentem

Cometido nesta entrega, pego pelo CI. O `mutcheck` muta o arquivo de produção no lugar e restaura
depois de cada mutação. Eu disparei o mutcheck em background e, **enquanto ele rodava**, fiz
`git add -A` + `git rebase --continue` — capturando no commit o mutante que estava aplicado naquele
instante (`interval '30 days'` no lugar de `interval '${janelaMin} minutes'`).

O que torna isso perigoso não é o erro, é o que veio DEPOIS: quando o mutcheck terminou, ele
restaurou o working tree. Então `bun run typecheck`, `bun run test` (7558 verdes) e o próprio
`mutcheck` (0 problemas) rodaram sobre o arquivo **correto** — e ficaram verdes — enquanto o
**commit** estava quebrado. Toda a evidência que eu tinha era verdadeira sobre o working tree e
irrelevante sobre o que eu ia publicar. O CI, que testa o COMMIT, reprovou os dois jobs.

O CLAUDE.md já diz "**COMMITE antes de falsificar** — `restaurar()` costuma ser `git checkout --`".
Esta é a variante em que a falsificação roda **concorrente** ao commit, e ela acrescenta uma regra:

- **Nunca `git add` enquanto um harness que muta o working tree estiver vivo.** Em background isso
  não é hipótese, é corrida.
- **A checagem que vale é sobre o CONTEÚDO COMMITADO.** Antes de `push`, exija
  `git diff HEAD --stat` **vazio** — e reconfira `git status --porcelain` DEPOIS de cada suíte, para
  provar que nada mutou a árvore durante a corrida. Suíte verde sobre um working tree que diverge do
  commit é medição do artefato errado: a família "evidência positiva do objeto ERRADO".

## 10. ⚠️ O ponto cego foi CORRIGIDO em doc e ficou de pé no código por 4 dias

O #2103 nomeou este documento inteiro: "o filtro `probe` da §13.3 só via a sonda ATIVA — o eco
passivo é a via maior, 4 → 8 edges". Foi um commit de **docs**. A query de
`scripts/pendencias-deploy.ts` continuou exigindo `probe:true`.

O custo veio em 2026-08-31 e de novo em 2026-09-04: a `analytics-outbox-drain` — cron de 5 em 5
minutos, **72 respostas na janela**, `versao`/`edge`/`fonte` completos e `fonte` idêntico ao mapa
commitado — saía classificada como `⚪ sem sonda na janela (ausência de dado)`. A cobertura caía
abaixo do piso, o script devolvia exit 1, e nasceu um chip inteiro de verificação de deploy sobre
uma edge que já estava provada no ar. O dado estava lá o tempo todo; quem estava cego era a query.

A regra: **doc não filtra linha.** Quando o achado é sobre um PREDICADO — uma query, um gate, um
`if` —, o resíduo durável é o predicado mudado com teste que falsifique; a nota é o acompanhamento,
não a entrega. Um documento que descreve o próprio ponto cego e não o fecha deixa o instrumento
exatamente tão cego quanto antes, e agora com a aparência de resolvido — que é pior, porque a
próxima sessão lê o doc, reconhece o problema e segue em frente.

Medido na correção (2026-09-04, mesma janela de 6h, `psql-ro`): a query antiga via **2** edges, a
nova vê **3**; das 76 linhas com corpo de edge instrumentada, **72 eram eco passivo** e ~4 sonda
ativa. E o teto estrutural é maior que o de uma janela: **6 das 40 edges do mapa** plantam
`{...body, versao, edge, fonte}` em TODA resposta (`analytics-outbox-drain`, `omie-sync-sku-items`,
`omie-sync-ctes-recebidos`, `omie-sync-nfes-recebidas`, `omie-sync-pedidos-compra`,
`omie-sync-vendas-items`) e eram 100% invisíveis sem alguém lembrar de colar a sonda.

### 10.1 ⚠️ A falsificação por `sed` no ARQUIVO acertou o COMENTÁRIO, e o guard aprovou

Cometido nesta entrega. Para provar que o gate do vitest era carga, sabotei o SQL com

```
perl -0pi -e "s/NOT \(r\.c \? 'probe'\)/(r.c ->> 'probe') <> 'true'/" scripts/pendencias-deploy.ts
```

e o guard anti-falsificação-vazia (`git diff --quiet` → "o alvo mudou?") **passou**: o arquivo
tinha mudado mesmo. Só que a primeira ocorrência daquele texto no arquivo não é o SQL — é o
comentário que **cita o SQL** para explicar por que `<> 'true'` seria NULL-blind. O `perl` reescreveu
a prosa e deixou a query intacta. A suíte ficou verde, e a leitura natural ("gate frouxo") estava
errada: o gate nunca tinha sido testado.

O que torna isto provável e não exótico é o estilo desta casa: os comentários **citam o código
verbatim**, então todo padrão que casa a linha casa também o parágrafo que a descreve — e o
parágrafo vem ANTES no arquivo.

- **Sabote o ALVO EXTRAÍDO, não o arquivo que o contém.** É o que
  `db/test-pendencias-deploy-eco-passivo.sh` faz: importa `SQL` do script para um `.sql` sem
  comentário nenhum e sabota ali — imune por construção.
- Quando a edição tiver de ser no arquivo, **ancore na região do código** (recorte entre
  `export const SQL = \`` e `` `.trim(); ``) e **falhe se o padrão não casar DENTRO dela**.
- **"O arquivo mudou" é guard fraco.** O guard forte é "**o alvo** mudou": `cmp` sobre o artefato
  extraído, ou substituição ancorada que sai não-zero quando não casa. Família
  `evidencia-positiva-shell.md`: sinal colhido do objeto errado.
