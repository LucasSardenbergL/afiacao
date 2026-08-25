# Verificar a sonda de versão sem pagar o efeito caro (#1766)

Registro do ciclo de verificação das 4 edges que o #1766 instrumentou com
`{"probe":true}` — `omie-nfe-recebimento`, `process-nfe`, `sayerlack-captura-precos` e
`reposicao-depara-sayerlack-auto`, todas em `VERSAO = "v1.0-sensor-inicial"`.

O que torna essas 4 diferentes das sondas anteriores: **o bundle ANTERIOR à sonda ignora o `probe` e
roda o fluxo real**. Sondar para *descobrir* se o deploy aconteceu inverte a ordem e paga o efeito —
efetivar NF-e no Omie (entrada de estoque + fiscal, desfazer é trabalho do contábil), abrir sessão no
portal do fornecedor, gravar de-para. A ordem "confirmar o deploy → só então sondar" **é** a proteção.

## 1. A sonda não é o único caminho — existe verificação PASSIVA e de graça

As 4 edges emitem `versao` em **toda** resposta, não só no caminho `probe` (helpers em
`omie-nfe-recebimento/index.ts:36`, `sayerlack-captura-precos/index.ts:701`,
`reposicao-depara-sayerlack-auto/index.ts:74`; em `process-nfe`, todos os returns). Consequência
operacional: **uma execução de cron já prova a versão** — sem chamar nada, numa corrida que ia
acontecer de qualquer jeito.

Controle do método (provado antes de usar): `versao` tem **0** ocorrências no commit pai do #1766 e
**5** no HEAD. É discriminante perfeito entre bundle novo e velho — resposta sem o campo é bundle
velho, não é ruído.

**Condição de validade — confira no código antes de usar.** O método só vale onde a edge carimba
`versao` em **toda** resposta (um helper que embrulha os returns). Não é universal entre as edges com
sonda: em `enviar-pedido-portal-sayerlack`, `versao` aparece **só** no erro de sonda ambígua, então a
resposta do cron watchdog (`{"modo":"watchdog",...}`) não traria `versao` **nem com o bundle novo** —
ler aquela ausência como "bundle velho" é falso positivo. Nas 4 do #1766 o helper carimba tudo
(verificado), então nelas o método vale.

**Regra:** antes de sondar edge com efeito caro, verifique (a) que ela carimba `versao` no fluxo
normal e (b) se algum cron dela roda; então leia `net._http_response`. Sondar é o último recurso.

## 2. Nome de cron job ≠ edge que ele chama (quase virou achado falso)

`omie-nfe-recebimento-import-1h` (jobid 157) chama `omie-nfe-recebimento-**sync**`, e
`omie-nfe-reconcile-1h` (162) chama `omie-nfe-**reconcile**` — edges **distintas** das do #1766. Ler o
`jobname` levaria à conclusão errada de que `omie-nfe-recebimento` roda de hora em hora e que a
resposta mais recente já provava a versão.

**Sempre extraia a URL do `command`**, nunca infira pelo `jobname`:

```sql
SELECT jobid, jobname, substring(command from 'functions/v1/[a-z0-9-]+') AS edge FROM cron.job;
```

Das 4 edges do #1766, só **duas** têm cron: `reposicao-depara-sayerlack-auto` (jobid 146, 04:00 UTC
diário) e `sayerlack-captura-precos` (jobid 161, dias 10-12). **`omie-nfe-recebimento` e `process-nfe`
não têm cron nenhum** — só são chamadas por staff logado, então para elas a sonda é mesmo o único
caminho.

## 3. O `versao.ts` é arquivo NOVO — deploy parcial QUEBRA a edge

O #1766 criou um `versao.ts` por edge (23/22/25/27 linhas), importado pelo `index.ts`. Se o deploy no
chat do Lovable levar **só o `index.ts`**, o módulo falha no boot por import inexistente — e uma edge
de money-path que **hoje funciona** passa a falhar. Isso é pior que bundle velho.

O prompt de deploy precisa citar os dois arquivos explicitamente. Sinal barato de que não quebrou:
`verify-edge.sh <nome>` (N1/OPTIONS) — se o módulo não carregasse, o boot falharia e o N1 não daria 200.

## 4. A ordem gate↔sonda difere entre as 4 — muda como se lê um 401

Não é uniforme, e isso importa para o veredito:

- `reposicao-depara-sayerlack-auto`: `authorizeCronOrStaff` vem **antes** da sonda (`index.ts:39-40`).
  Um 401 aqui **não** discrimina bundle velho — pode ser credencial. Mitigação: sondar com o **header
  idêntico ao do cron** que já roda com sucesso (`SELECT command FROM cron.job WHERE jobid=146`), o que
  remove a ambiguidade.
- `omie-nfe-recebimento` / `process-nfe`: a sonda responde **antes** do gate de JWT de staff (é o que
  torna a sonda via `net.http_post` viável nelas). Aí sim **401 = bundle velho**.

## 5. Janela de leitura do resultado: ~6h

`net._http_response` é purgado continuamente — medido em 2026-08-18: 180 linhas cobrindo 09:20→15:15
UTC. Dá folga para ler depois da sonda, mas a resposta de um cron da madrugada **já não está lá**.

Leitura (role `claude_ro`, não depende do founder copiar nada):

```bash
~/.config/afiacao/psql-ro -c "SELECT status_code, content::jsonb->'probe' AS probe, content::jsonb->'versao' AS versao FROM net._http_response ORDER BY id DESC LIMIT 5;"
```

## 6. N2 (Management API) é estruturalmente indisponível neste projeto

O Supabase é da org do Lovable; o founder não tem conta com acesso ao ref `fzvklzpomgnyikkfkzai`.
`~/.config/afiacao/supabase-pat` existe **vazio** desde 2026-07-27. Não peça o PAT — a escada de
verificação de edge aqui é N1 (existência) → N3 (comportamento/sonda), pulando o N2.

## 7. A `VERSAO` compartilhada torna a sonda em LOTE irrecuperavelmente ambígua

O achado mais caro do ciclo. `respostaSonda(VERSAO)` devolve `{"ok":true,"probe":true,"versao":"..."}`
— **sem o nome da edge**. E `v1.0-sensor-inicial` não é do #1766: **13 edges** da main carregam essa
mesma string (`conciliar-pedido-portal`, `enviar-pedido-portal-sayerlack`, `fin-cashflow-engine`,
`gerar-pedidos-diario`, `omie-cliente`, `omie-nfe-recebimento`, `omie-nfe-webhook`,
`omie-sync-estoque`, `omie-sync-nfes-recebidas`, `pedido-programado-enviar`, `process-nfe`,
`reposicao-depara-sayerlack-auto`, `sayerlack-captura-precos`).

Duas respostas de sonda de edges **diferentes** são, byte a byte, **idênticas**. E nada no banco
desfaz o empate:

| fonte | por que não resolve |
| --- | --- |
| `net._http_response` | não tem coluna de URL (só `id, status_code, content_type, headers, content, timed_out, error_msg, created`) |
| `net.http_request_queue` | tem a `url`, mas é **esvaziada** ao processar (medida vazia: 0 linhas) |
| `headers` da resposta | só Cloudflare (`cf-ray`, `set-cookie`, `server`) — nada identifica a função |
| `created` | é o **ciclo de coleta do worker** do pg_net, não o instante da resposta: respostas de edges diferentes compartilham timestamp ao microssegundo |

**Caso real (2026-08-18):** 10 sondas às 23:13 UTC, todas 200 + `probe:true` + `v1.0-sensor-inicial`,
zero erro. Impossível dizer quais edges responderam — logo, **impossível emitir veredito por edge**.
Ler aquilo como "as 4 do #1766 estão no ar" seria falso positivo: as respostas cabem em qualquer
subconjunto das 13.

**O que o lote AINDA prova (e é o que mais importa):** zero respostas sem `probe`, zero 401 e zero
timeout ⇒ **nenhuma edge de bundle velho foi atingida** — nenhum efeito caro disparou. A garantia de
segurança sobrevive à ambiguidade; só o veredito por edge se perde.

**Conserto (por ordem de preferência):**
1. **A resposta se auto-identificar** — `respostaSonda` passar a incluir a edge:
   `{"ok":true,"probe":true,"versao":"...","edge":"<nome>"}`. Fecha a classe para sempre e é uma
   mudança pequena no `_shared/sonda-versao.ts`.
2. **`VERSAO` única por edge** (ex.: `v1.0-sensor-inicial/process-nfe`) — mesmo efeito, sem mexer no
   contrato.
3. **Enquanto nenhum dos dois existir: sondar UMA edge por vez** e ler o `net._http_response` antes
   de disparar a próxima. Lote = veredito perdido.

## 8. O conserto (#1789) — e o deploy que ainda falta

O §7 foi fechado no #1789 (mergeado 2026-08-19, `ad43dd62`): `_shared/sonda-versao.ts` passou a
exportar `criarRespostaSonda(edge)`, e cada `versao.ts` declara
`export const respostaSonda = criarRespostaSonda("<nome-da-edge>")`. A resposta virou:

```json
{"ok":true,"probe":true,"versao":"v1.0-sensor-inicial","edge":"process-nfe"}
```

É **fábrica**, não parâmetro a mais, por dois motivos: a identidade fica declarada uma vez por edge
(nenhuma chamada nova pode esquecer de passá-la) e **nenhum `index.ts` mudou** — os arquivos grandes
de money-path ficaram fora da superfície tocada. A `respostaSonda` livre foi REMOVIDA do `_shared`
de propósito: quem não declarar identidade não compila. Dois gates novos no contrato: a sonda tem de
se identificar com o nome do **diretório** da function, e duas edges nunca podem produzir respostas
idênticas — esta última falha no desenho antigo, que é o ponto.

### ⏳ PENDENTE: as 16 edges precisam de deploy manual

**Merge não publica edge.** Enquanto o deploy pelo chat do Lovable não acontecer, as sondas em
produção seguem respondendo o formato antigo, **sem** o campo `edge` — e o §7 continua valendo em
produção, ainda que esteja resolvido no repo. A degradação é limpa (campo ausente = bundle anterior
ao #1789, não erro), então não há urgência; mas enquanto não subir, um lote heterogêneo de sondas
volta a ser indecifrável.

As 16 com `versao.ts`: `conciliar-pedido-portal`, `disparar-pedidos-aprovados`,
`enviar-pedido-portal-sayerlack`, `fin-cashflow-engine`, `generate-bundle-argument`,
`generate-tactical-plan`, `gerar-pedidos-diario`, `omie-cliente`, `omie-nfe-recebimento`,
`omie-nfe-webhook`, `omie-sync-estoque`, `omie-sync-nfes-recebidas`, `pedido-programado-enviar`,
`process-nfe`, `reposicao-depara-sayerlack-auto`, `sayerlack-captura-precos`.

⚠️ O `_shared/sonda-versao.ts` **também** mudou e é dependência de todas: um deploy que leve só o
`index.ts` quebra o boot (§3). Prova de que subiu: sondar e ler `content::jsonb->'edge'` em
`net._http_response` — o nome certo ali é o veredito.

## Desfecho por edge (2026-08-18)

O lote de 10 sondas das 23:13 UTC **não** produz veredito por edge (§7). O que ficou:

| Edge | Deploy | Prova de versão | Veredito |
| --- | --- | --- | --- |
| `reposicao-depara-sayerlack-auto` | founder deployou 2026-08-18; guard anti-reversão limpo; N1 200 | **cron 146 às 04:00 UTC** carimba `versao` em toda resposta — prova não-ambígua, de graça, no dia seguinte | ⏳ aguardando o cron |
| `sayerlack-captura-precos` | **founder deployou 2026-08-19** | sonda 55521 → `{"ok":true,"probe":true,"versao":"v1.0-sensor-inicial"}` | ✅ no ar |
| `omie-nfe-recebimento` | **founder deployou 2026-08-19** | sonda 55519 → idem | ✅ no ar |
| `process-nfe` | **founder deployou 2026-08-19** | sonda 55520 → idem | ✅ no ar |

**Garantia de segurança do ciclo:** em nenhum momento uma edge de bundle velho foi atingida — zero
respostas sem `probe`, zero 401, zero timeout. Nenhum efeito irreversível disparou.

### Fecho do ciclo (2026-08-19) — as 4 do #1766 estão no ar

Depois de o founder confirmar o deploy, as 4 foram sondadas e as 4 responderam
`{"ok":true,"probe":true,"versao":"v1.0-sensor-inicial"}` (ids 55519, 55520, 55521, 55523).

**Por que este lote produziu veredito e o das 23:13 não** — e a resposta NÃO é "li por id": a query
de disparo devolve `nome × request_id` na mesma linha, o que dá o mapa, mas ele sozinho não
resolveria nada se as respostas divergissem, porque `_http_response` continua sem URL (§7 segue
valendo). O que fechou o veredito foi a **homogeneidade**: as respostas do lote foram byte a byte
iguais e todas verdes, então a atribuição individual é irrelevante — cada uma das N edges
disparadas respondeu sonda, qualquer que seja a permutação. **A leitura só é válida com o lote
inteiro verde.** Bastaria UMA divergir para o veredito por edge voltar a ser impossível, e aí a
regra do §7 (uma por vez) é a única saída. Ou seja: o lote é atalho para o caso feliz, não
substituto do sequencial.

**Reduzir o risco sem sondar às cegas:** antes de disparar, leia no bundle VELHO o que cada edge faz
com `{"probe":true}`. Das 4, três falhavam fechado sozinhas — `omie-nfe-recebimento` por gate JWT
que não aceita cron-secret (401), `process-nfe` por `nf_number` obrigatório (400), e
`sayerlack-captura-precos` pelo kill-switch `embalagem_captura_automatica_habilitada`, que estava
`false` em prod (verificado no banco, não presumido). Só `reposicao-depara-sayerlack-auto` rodaria
o fluxo real. Sondar as seguras primeiro converte a incerteza das perigosas em risco baixo.

**Ausência de escrita provada pelo banco, não pela resposta:** de-paras Sayerlack seguem em 250
automáticos / 301 total com carimbo de 31/07 — inalterados pela sonda de `reposicao-depara-sayerlack-auto`.
Mesma checagem nas 5 do #1772: `reposicao_estoque_full` parado em 18/08 19:40 e `fin_sync_log` em
00:20, ambos anteriores às sondas das 00:54. A resposta diz "o bundle novo está no ar"; só o banco
diz "e ele não fez nada".

## Lote do #1772 (2026-08-19/20) — `omie-cliente` no ar, e o `edge` do #1789 confirmado EM PRODUÇÃO

O founder colou os 5 prompts de deploy do #1772 em **2026-08-19 ~01:45 UTC**. A sonda da
`omie-cliente` (SQL Editor, `{"probe":true}` + `x-cron-secret`) devolveu, às 23:50 do mesmo dia:

```
status 200 · {"ok":true,"probe":true,"versao":"v1.0-sensor-inicial","edge":"omie-cliente"}
```

Dois vereditos numa resposta só: a edge está na versão nova, **e o campo `edge` do #1789 está no ar**
— a §"PENDENTE" acima previa o formato antigo (sem `edge`) enquanto o deploy não acontecesse, e para
esta edge ele já aconteceu. O campo veio porque o #1789 entrou na `main` às **01:45 UTC**, minutos
antes de o founder colar os prompts: o Lovable leu a main já corrigida.

⚠️ **Campo inesperado em produção é "a main andou" ANTES de ser "o Lovable melhorou o código".** O
`edge` não existia no worktree de quem sondou (18 commits atrás), e a primeira hipótese levantada foi
adulteração no deploy — que é a acusação cara, e estava errada. O desempate é uma linha:
`git log -S'edge' origin/main -- supabase/functions/_shared/sonda-versao.ts`. Worktree defasado
produz "achado" que não existe; sincronize antes de acusar.

⚠️ **O rastro do commit do bot NÃO serve como sinal de deploy pelo chat.** Esperei **22h** por um
commit `Deployed …`/`Redeployed …` que nunca veio — com **122 commits do tipo** no histórico, o que
tornava a ausência aparentemente informativa. O deploy tinha acontecido: a sonda provou. Rastro
ausente **não** degrada para "não deployou"; ele não é sinal de nada neste caminho, e tratá-lo como
sinal me fez reportar "provavelmente não executou" sobre algo que estava no ar. Só a sonda (ou a
verificação passiva do §1) decide.

### Segurança de sonda nas 5 do #1772 — lido no bundle velho (`77e46ab9^1`)

Mesma técnica da §"Reduzir o risco sem sondar às cegas", aplicada a este lote:

| edge | o bundle VELHO faz o quê com `{"probe":true}` | seguro? |
| --- | --- | --- |
| `omie-cliente` | `switch (action)`; sem `action` cai no `default:` → 400 "Ação não reconhecida" | ✅ provado em prod |
| `fin-cashflow-engine` | `save_snapshot ?? false`, e os 2 `insert` estão dentro de `if (save)` → calcula e devolve, não grava | ✅ |
| `omie-nfe-webhook` | exige `x-webhook-secret` (a sonda manda `x-cron-secret`) → 401 antes de qualquer escrita | ✅ |
| `omie-sync-estoque` | `authorizeCronOrStaff` **aceita** `x-cron-secret` → passa o gate e roda o sync, reescrevendo o saldo que o motor de reposição consome | ❌ |
| `omie-sync-nfes-recebidas` | idem — gate próprio que aceita `x-cron-secret`, sem parâmetro que barre | ❌ |

**O discriminante não é a edge ser "leve"** — é o bundle velho ter um **ponto de recusa antes da
primeira escrita**: dispatch por ação, segredo diferente, ou flag de escrita que nasce `false`.
Conferir só o dispatch não basta: as duas ❌ não têm `switch (action)` e ainda assim são perigosas,
porque o gate delas aceita exatamente a credencial com que a sonda é invocada. **Leia o gate junto
com o dispatch.**

Para as duas ❌ sobra a via passiva (§1): `omie-sync-estoque` tem cron (`0 9` + `40 9,11,13,15,17,19`),
então a próxima execução carimba `versao` de graça — dentro da janela de ~6h da §5.
`omie-sync-nfes-recebidas` **não tem cron**: só o painel do Lovable.

### Edge sem cron próprio: o orquestrador ecoa o corpo da filha (2026-08-20)

`omie-sync-nfes-recebidas` **não tem cron**. Pelo §1 a verificação passiva parecia não se aplicar, e
sobrava o painel ou uma sonda perigosa — o gate dela aceita `x-cron-secret`, então a sonda passaria e
rodaria o sync (tabela da seção anterior).

Só que ela **é chamada**: o `omie-cron-diario` (cron 52, `15 */2 * * *`) a invoca por `fetch` interno
(`{ key: "nfes", name: "omie-sync-nfes-recebidas", body: { empresa, dias } }`). Esse `fetch` não passa
pelo `net.http_post` e por isso **não gera linha própria** em `net._http_response` — mas o orquestrador
**ecoa o corpo de cada filha** em `resultados.<chave>.body`. Como o bundle novo carimba `versao` em
toda resposta (§1), a versão da filha viaja dentro da resposta do pai:

```sql
SELECT content::jsonb->'resultados'->'nfes'->>'status'          AS http,
       content::jsonb->'resultados'->'nfes'->'body'->>'versao'  AS versao_filha
FROM net._http_response
WHERE created > now() - interval '6 hours' AND content ~ '"nfes"'
ORDER BY id DESC LIMIT 1;
-- 200 | v1.0-sensor-inicial   (run das 10:15 UTC) -> no ar, sem disparar nada
```

**Generalização do §1:** a pergunta não é *"esta edge tem cron?"* — é ***"alguma coisa que produz linha
em `net._http_response` carrega a resposta dela dentro?"***. Um orquestrador que ecoa filhas estende a
verificação passiva a **toda** edge que ele chama, inclusive as sem cron e justamente as que seriam
perigosas de sondar. Vale olhar o orquestrador antes de concluir "só resta o painel".

⚠️ **Atribuir pelo corpo, não pelo horário** — o §2 de novo, e quase mordeu: às 09:40 (horário do cron
`omie-sync-estoque-intraday-oben`) as duas linhas de `net._http_response` eram
`{"success":true,"action":"sync_movimentacoes",…}` **sem** `versao`, o que lido de relance dá "o estoque
está com bundle velho". `sync_movimentacoes` é da `omie-financeiro`. A resposta real do estoque saiu
**1m42s depois** (o sync leva 47s) e trazia `versao` — o cron só marca o INÍCIO, e a linha aparece no
fim. Casar cron×resposta por horário é achado falso esperando acontecer; case por **chave exclusiva do
corpo** (aqui, `total_skus_esperados`/`paginas_omie`).

### Desfecho do lote do #1772 — 5/5 no ar (2026-08-20)

| Edge | Prova | Risco pago |
| --- | --- | --- |
| `omie-cliente` | sonda → `{"probe":true,…,"edge":"omie-cliente"}` | zero (dispatch por ação) |
| `omie-nfe-webhook` | sonda → idem | zero (exige `x-webhook-secret`) |
| `fin-cashflow-engine` | sonda → idem | zero (`save_snapshot ?? false`) |
| `omie-sync-estoque` | **passiva** — cron 09:40, `versao` + `total_skus_esperados: 371` | zero |
| `omie-sync-nfes-recebidas` | **passiva** — eco em `resultados.nfes.body` do orquestrador | zero |

Nenhuma escrita indevida e nenhum sync disparado à toa: as 2 edges perigosas foram provadas **sem**
serem invocadas. Quando a via passiva existe, ela é estritamente melhor que a sonda — não custa nada
e não pode errar para o lado caro.

## 9. O gate de contrato provava que a sonda é CHAMADA — não que ela RESPONDE (2026-08-24)

Achado ao falsificar uma sonda experimental na `omie-vendas-sync` (2026-08-23, worktree
zen-zhukovsky-29a5d9; aquela sonda **não** foi entregue — o #1937 declarou a edge
`VERIFICAVEL_POR_CANARIA` e a entrega virou estender a `identidade_probe`). Trocar

```ts
return new Response(JSON.stringify(respostaSondaX(...)), { ... })
// por
console.log(respostaSondaX(...));
return new Response(JSON.stringify({ ok: true }), { ... })
```

deixava **todos** os gates verdes. O teste "toda edge instrumentada RESPONDE à sonda" afirmava duas
coisas — que `respostaSonda\w*(` aparece e que a edge ramifica em `"sonda"` — e nenhuma das duas nota a
diferença entre montar o corpo e devolvê-lo. Medido no gate antigo: sabotando a
`disparar-pedidos-aprovados` assim, `bun run test:edges` = **893 passed | 0 failed, exit 0**.

O preço em produção é a pior leitura possível: a edge responde 200 **sem** o eco `probe:true`, e
ausência de `probe:true` é exatamente o corpo pelo qual a canária conclui *"bundle velho, e ele rodou o
efeito caro"* (`docs/agent/deploy.md` §Canárias, armadilha 1). Sonda muda não é sonda calada — é sonda
mentindo para o lado caro. O buraco **não** era de nenhuma edge: valia para as 32 instrumentadas.

### Por que o assert é POSICIONAL, e não uma lista de embrulhos

A medição das 32 (2026-08-24) achou **quatro** formas legítimas, não duas:

| Forma | n | Shape |
| --- | --- | --- |
| A | 21 | `return new Response(JSON.stringify(respostaSonda(VERSAO)), …)` |
| B | 5 | `return jsonRes(respostaSonda(VERSAO), 200)` |
| C | 4 | `return jsonResponse(respostaSonda(VERSAO), 200)` |
| D | 2 | **indireta** — `const corpo = … ? respostaSonda(VERSAO) : …` e o `return` embrulha a VARIÁVEL |

A forma D (`ai-ops-agent`, `omie-financeiro`) é a que mata a enumeração: ali não há embrulho nenhum
adjacente à chamada, então `(JSON\.stringify|jsonRes)\(respostaSonda\w*\(` reprovaria **edge correta** —
e o conserto de um gate que reprova código certo é sempre afrouxá-lo. O gate entregue exige que a
chamada esteja na **cadeia de um `return`** (prefixo da sentença desde o `;`/`{`/`}` mais próximo; na
forma indireta, que o PRÓXIMO `return` embrulhe a variável atribuída). Embrulho novo passa sem tocar no
teste; `console.log` não passa.

### Falsificação (exigida em código real, não só no texto da calibração)

Sabotadas 5 edges reais, uma por forma — `disparar-pedidos-aprovados` (A), `recommend` (B),
`fin-cashflow-engine` (C), `ai-ops-agent` e `omie-financeiro` (D): **5/5 vermelhas**, todas acusando o
gate certo (a mensagem cita a edge e "o corpo não alcança nenhum return"). A calibração no próprio teste
cobre os dois lados: 3 formas "calcula e descarta" que ele **tem** de reprovar (incluindo guardar numa
variável e retornar outra), as 4 formas reais + um embrulho inventado que ele **tem** de aprovar, e o
caso da resposta certa existindo só em **comentário**.

### Assinatura para varredura futura

Gate que casa o **nome** de uma função e conclui que o **efeito** dela aconteceu. `respostaSonda(`
presente prova montagem, não entrega; `track(` presente prova chamada, não evento gravado. Quando o
valor de retorno É o produto, o assert tem de seguir o valor até a fronteira (o `return`, o `await`, o
`INSERT`) — senão o gate mede o texto certo e afirma a coisa errada.
