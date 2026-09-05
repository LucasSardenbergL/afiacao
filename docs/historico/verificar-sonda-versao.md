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

**O número não é só observação — é GUC, e dá para ler (2026-08-26):** `pg_net.ttl = 6 hours`. A medida
do dia bateu com a configuração: 208 linhas cobrindo 5h55. Vale conferir em vez de estimar pela janela
observada, porque a janela observada encolhe sozinha quando o tráfego de cron cai.

```bash
~/.config/afiacao/psql-ro -Atc "SELECT name, setting FROM pg_settings WHERE name LIKE 'pg_net%';"
# pg_net.batch_size=200 · pg_net.database_name=postgres · pg_net.ttl=6 hours · pg_net.username=postgres
```

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

## 10. A varredura da §9: 7 irmãos vivos, e o suspeito nomeado não existia (2026-08-25)

Assinatura rodada em `src/**/*.test.ts(x)`, `supabase/functions/**/*_test.ts` e `scripts/`: regex ou
`includes` que casa `<identificador>(` contra código lido como TEXTO. 63 arquivos leem fonte com
`readFileSync`/`Deno.readTextFileSync`; a assinatura casou 5 deles.

**Triagem — o critério é "o valor de RETORNO da função casada é o produto que o teste afirma?"**, não
a forma do assert. `classificarSonda(`/`avaliarPagina(` são assert de FORMA; `escritaCritica(` e
`await deriveOmieAccountIdentity(...)` solto são a chamada COMO efeito (não há retorno-produto).
Esses são falso-positivo da assinatura e ficaram como estão.

**7 afetados, todos no `edge-money-path-invariants.test.ts`** — medidos, não deduzidos: montada a
forma "calcula e descarta" em código REAL das edges, o gate deu **237 passed, exit 0**.

| Helper | Edge | O que o gate deixava passar |
| --- | --- | --- |
| `decidirIdentidadeSelfService` | `omie-sync` | identidade self-service decidida e jogada fora |
| `docsComCodigoAmbiguoNoOmie` | `omie-analytics-sync` | fail-closed do P1b evapora → last-write-wins |
| `classificarLoteProof` | `omie-analytics-sync` | lote cru no upsert (23505 derruba o run) |
| `buildOwnerMap` | `ai-ops-agent` | `farmer_id` saindo de mapa vazio |
| `skuItemsElegivel` | `omie-sync-sku-items` | filtro sempre-true → poison entope a fila |
| `skuItemsCompararFila` | `omie-sync-sku-items` | `sort` vira no-op → antigas nunca alcançadas |
| `acumularUsoCache` | `analyze-unified-order` | alerta de escrita-paga-sem-leitura nunca dispara |

Já-corretos, e é deles que saiu o formato do conserto: `farmer_id: resolveOwner(...)` e
`criarPedidoVenda(supabaseAdmin, sales_order_id, ident.codigo_cliente, ...)` — asserts POSICIONAIS.
`agregarItensRecebimento` reprovou a sabotagem por ACIDENTE de âncora textual (`expected '' not to
be ''`), não pelo mérito: pega, mas não explica.

**O suspeito que a §9 nomeou — `track(` presente ⇒ "evento gravado" — NÃO existe.** Zero gates
textuais sobre `track(` no repo. Era hipótese, não medição; fica registrado para ninguém re-varrer.
De quebra, o #1984 mostrou que o canal PostHog é censurado por bloqueador de rastreador no cliente, e
um gate assim seria cego **duas vezes**: no texto, porque `track(` presente prova chamada e não
gravação; e no dado, porque DENTRO do PostHog o cliente bloqueado e o que nunca usou produzem o mesmo
zero.

**A segunda cegueira tem antídoto MEDIDO** — registrado aqui porque a frase acima, sozinha, sugere que
a censura é inescapável, e ela só é inescapável para quem olha um cano só. Os dois zeros separam-se de
FORA, pelo par tabela×evento decomposto por APARELHO. Medição do #1997, mesmo usuário, dois aparelhos:

| Janela (Z) | `dashboard_visits` | eventos | Leitura |
| --- | --- | --- | --- |
| 01:04→03:30 | 11 visitas | 0 | Mac/Chrome com bloqueador |
| 09:39→09:51 | 1 visita (09:46:31) | 14 (iOS) | iPhone livre — os canos concordam |

Linha na tabela **sem** evento = bloqueado. Nenhuma linha **e** nenhum evento = não usou. Nenhum dos
dois eixos sozinho separa. O princípio de que o controle vem de FORA do cano é do #1977 (está em
`fase-sem-sinal.md`); o #1997 é a aplicação que o mediu por aparelho.

### Classe-irmã, não medida aqui: o CONTADOR prova a cobertura

A assinatura desta varredura é "o NOME prova o efeito". A vizinha é **"o número prova a cobertura"** —
um gate que reporta `N verificadas` sem dizer o que ficou de FORA. Não é a mesma coisa que gate cego:
o `docs:citacoes` exclui `docs/historico/`, `docs/superpowers/` e `docs/ux-audit/` por PRECISÃO
deliberada e documentada no próprio arquivo (553 das 580 citações do repo vivem lá, e cobrar história
para acompanhar a `main` é churn e falso-positivo permanente). O que falta não é o escopo, é o
RELATO: a mensagem idêntica antes e depois faz o corte deliberado ler como cobertura total ("no silent
caps", `matar-classe` passo 4). Consequência direta para este documento: **§10 vive em
`docs/historico/`, então as citações dele não são verificadas por gate nenhum** — as deste parágrafo
foram conferidas à mão (#1997 e #1977 mergeados em 2026-08-25, 10:12:06Z e 02:09:43Z).

### O critério fraco tinha um buraco, e a falsificação o encontrou

Primeira versão do gate exigia "≥1 chamada consome o retorno". Na falsificação, **5 de 7** acusaram:
`decidirIdentidadeSelfService` é chamado 2x em `omie-sync`, e sabotar só a primeira passava. Medição
dos 9 helpers puros na `main`: **0 descartes em todos** ⇒ o critério virou "NENHUMA chamada descarta",
sem custo de falso-positivo. Falsificação final: **7/7 vermelhas**, cada uma citando a marca do ramo
("N de M chamada(s) DESCARTAM o retorno"). Suíte canônica na árvore restaurada: 740 arquivos,
7176 passed, exit 0.

**A armadilha se repetiu DENTRO do conserto, duas vezes** — vale mais que o conserto:
1. A primeira calibração negativa extraía o nome do alvo por regex do próprio fixture. Nome errado ⇒
   zero chamadas ⇒ zero consumos ⇒ **verde por cegueira**. Nome agora vai explícito, com sentinela.
2. `expect(descartes).toBe(0)` aprova zero chamadas. O assert virou um VEREDITO em string, em que
   "NENHUMA chamada encontrada" é vermelho — senão renomear o helper apaga o guard em silêncio.

Gate: `src/lib/gates/retorno-consumido.ts`, calibrado nos dois sentidos em
`src/lib/gates/__tests__/retorno-consumido.test.ts` (28 casos: 7 formas de descarte que reprovam, 6
formas legítimas REAIS + 1 inventada que aprovam, cegueira, 1-de-2, definição≠chamada, e as 9 edges
de hoje).

## 11. A varredura da §10 nos gates de SQL: o suspeito de novo não existia, e o furo era a GRAFIA (2026-08-25)

Briefing em `db/diagnostico/BRIEFING-varredura-gates-sql.md`, queries em
`db/diagnostico/authz-funcoes-acl-real.sql`. Alvo: `scripts/authz-funcoes.test.ts` + o manifesto
(`AUTHZ_MANIFEST`/`ACKNOWLEDGED_SENSITIVE`/`ACL_ONLY_INTERNAL`), secundário
`scripts/sonda-versao-sql.test.ts`.

**O suspeito nomeado não existe — medido, não deduzido.** O briefing apostava no vetor
`DROP FUNCTION`+`CREATE` reabrindo função em prod sem nenhum `GRANT` no repo. Prod diz que não:
`bun run authz:funcoes:prod` sai **0** ("o EXECUTE de prod bate com o contrato nas 43"), e a query 4
(`proacl IS NULL`, o rastro do reset) devolve **0 linhas** — toda função de `public` tem ACL
explícito. Panorama das 454 de `public`: 196 INVOKER (RLS aplica), 189 SECURITY DEFINER com
**1 só** alcançável por `anon` — `public.get_public_tool_history(uuid)`, deliberada
(`20260604180000_public_tool_history_rpc.sql`, consumida por `src/queries/useUserTools.ts`) — e 69
de trigger, que a query 3 acusa mas o PostgREST não expõe como RPC. Nada a revogar.

**O furo estava no GATE, e a assinatura com controle o achou em dois pontos.** A forma errada do
briefing REPROVA (`FUNCAO_RECRIADA_SEM_FECHO`). Sondadas as grafias VIZINHAS, 18 no total contra as
666 migrations reais: **7 passavam caladas**.

| # | Grafia | Por quê passava |
| --- | --- | --- |
| 1 | `DROP FUNCTION IF EXISTS public.f;` | `alvosDrop` exigia `nome(` |
| 2 | idem + `CASCADE` | idem |
| 3 | idem com aspas / 4 sem schema / 5 sem `IF EXISTS` | idem |
| 6 | `DROP ROUTINE …` (com ou sem args) | o statement casava só `^DROP FUNCTION` |
| 7 | lista MISTA (`public.a(uuid), public.f`) | o elemento sem parêntese sumia |

Não é grafia exótica: a lista de argumentos é **opcional desde o PG10** quando o nome é único no
schema, e `ROUTINE` é sinônimo. Provado em PG17 descartável: `DROP FUNCTION public.f;` + `CREATE`
deixa `proacl` NULL e devolve `EXECUTE` a `anon` **igual** à forma com args; `DROP ROUTINE`, idem;
`CREATE OR REPLACE` preserva o ACL (o controle); e com overload o PG **recusa** omitir os args — a
fronteira do furo é "nome único", medida, não suposta.

**O segundo ponto é pior que o primeiro, e apareceu por sondar o ramo vizinho.**
`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO anon;` reabre as **43 de uma vez, sem citar
nenhuma pelo nome** — e passava calado, porque `parseAcl` lia só a palavra `FUNCTION(S)`. Mesma
cegueira no aviso de `ALTER DEFAULT PRIVILEGES … ON ROUTINES`. E `GRANT … ON ROUTINE public.f(uuid)
TO service_role` — legítimo — caía no fail-closed: o gate reprovava código correto, que é o começo
de todo afrouxamento.

**Conserto POSICIONAL, no padrão do #2001:** o corte é o NOME que ABRE cada elemento da lista do
`DROP` (args opcionais, vírgula de topo, `CASCADE`/`RESTRICT` fora), e `ROUTINE(S)` entra como
sinônimo em `parseAcl`. `PROCEDURES` fica de fora **de propósito** — o PG não derruba função por
`DROP PROCEDURE` nem alcança função com `ALL PROCEDURES`, então incluí-la seria falso-positivo.
De quebra, o ramo do `DROP` ganhou o fail-closed que o ramo do `GRANT` já tinha
(`FUNCAO_DROP_NAO_PARSEAVEL`): **os dois ramos do mesmo arquivo divergiam, e só um não podia afirmar
que estava tudo bem.**

Calibração nos dois sentidos: 18/18 grafias erradas reprovam (era 11/18) e as formas legítimas
seguem caladas — inclusive `REVOKE … ON ALL ROUTINES`, `GRANT ON ROUTINE` a role permitida e
`ALL PROCEDURES`. Contra o repo real, o conjunto de achados é **byte-idêntico ao da `main`**
(666 migrations, 0 achados): zero falso-positivo. Falsificação em código real, 3 sabotagens:
tirar o corte posicional = **15 vermelhas**; tirar o `ROUTINE` = **5**; tirar o fail-closed = **1**.

### A varredura completa — 16 sites, 1 afetado

Critério (o da §10, traduzido para SQL): *o gate casa uma GRAFIA e conclui o EFEITO?* Varridos os
gates que leem SQL como texto:

- **Afetado (1):** `scripts/lib/authz-funcoes.ts` (+ a calibração em `scripts/authz-funcoes.test.ts`).
- **Imunes por construção (5):** `scripts/lib/authz-contract.ts`, `scripts/lib/migration-objects.ts`,
  `src/__tests__/import-tint-formulas-aposentada-gate.test.ts` casam `CREATE … FUNCTION` — e
  **`CREATE ROUTINE` não existe no PostgreSQL**, então a grafia é única e não há o que escapar;
  `scripts/lib/authz-reescrita.ts` exclui `EXECUTE FUNCTION|PROCEDURE`, que também esgota a sintaxe.
  `scripts/lib/authz-grants.ts` (Parte C, tabelas) já era **fail-closed** e nem depende de parsear
  `DROP`: julga o `CREATE TABLE` sozinho. Era o irmão bem-feito ao lado do furo.
- **Falso-positivo da assinatura (10):** `scripts/sonda-versao-sql.test.ts` (o alvo secundário do
  briefing — o valor de retorno de `gerarSqlDaLeva` **é** o SQL que o assert lê, então o assert já
  segue o valor até a fronteira), `scripts/audit-custom-migrations.ts` e
  `scripts/wt-preflight-migration.ts` (heurístico DECLARADO, e o que afirmam é inventário/colisão,
  não efeito), `scripts/sql-comentarios.test.ts` (é o stripper compartilhado, com sentinela),
  `scripts/docs-links-gate-check.ts`, `scripts/cep-aberto/importar-carteira.ts`,
  `scripts/authz-gate-check{,.test}.ts`, `scripts/lib/migration-objects.test.ts`, e os três gates de
  PARIDADE (`afinidade-nao-e-dinheiro`, `titulo-status-paridade`, `BotoesDesfechoRecomendacao`), que
  já trazem CONTROLE explícito contra regex que não casa.

**Cobertura fora de `supabase/migrations/` — medida, não presumida.** O gate estático só lê
`supabase/migrations/`, e o projeto tem um canal paralelo (`db/*.sql` aplicado à mão, como o #1090).
Varridos os 52 `db/*.sql` contra as 43 do contrato: **0 pares `DROP`+`CREATE`**. O único `CREATE OR
REPLACE` (`prod-sentinela-base-20260702.sql` → `_data_health_compute`) preserva o ACL, logo não é
vetor. O canal existe e hoje está vazio; quem o cobre de verdade é `authz:funcoes:prod`.

### A lição que generaliza

A §9 disse "o assert tem de seguir o valor até a fronteira". A §11 acrescenta o eixo que faltava:
**quando a fronteira é uma LINGUAGEM, seguir o valor não basta — é preciso cobrir as grafias que a
linguagem trata como equivalentes.** `FUNCTION`/`ROUTINE`, args opcionais, `ALL … IN SCHEMA`: o
gate media a palavra e afirmava o alcance. O teste barato que pega isso não é ler o regex, é
**montar a forma errada em N grafias e contar quantas o gate deixa passar** — 7 de 18 aqui, e
nenhuma delas visível na leitura.


## 12. N3 passivo pela FORMA do JSON — prova de versão em edge SEM canária (2026-08-26, #1992)

A §1 registrou a via passiva que existe **quando a edge carimba `versao` em toda resposta**. A §12
generaliza para o caso muito mais comum — **a edge não tem canária nenhuma** — e o preço da
generalização é uma pré-condição a mais, descrita abaixo.

Substrato: verificação do deploy de `omie-analytics-sync` (PR #1992, merge `c63820508`). Essa edge não
está entre as instrumentadas do #1766/#1772, então o `versao` da §1 não existe ali. A escada da skill
`lovable-deploy-verify` mandava, nesse caso, ir para o **N3 ativo** — "chamar com a assinatura da
mudança (gated → founder logado / cron secret)" —, o que custa um bloco `net.http_post` no SQL Editor
com o founder no teclado, ou o segredo.

### O achado

**O conjunto de chaves do corpo da resposta é assinatura estrutural do bundle.** Se as duas versões do
código retornam objetos de **forma diferente** (uma chave presente vs ausente), ler a resposta que o
cron **já produziu** prova a versão — sem invocar nada, sem founder, sem secret, e sem risco de pagar
efeito caro (a §1 do #1766 existe justamente porque sondar bundle velho *executa o fluxo real*).

O caso, byte a byte:

| fonte | conteúdo |
| --- | --- |
| `git show c63820508^:supabase/functions/omie-analytics-sync/index.ts` | `const products = await syncProducts(supabaseAdmin, acct);` … `return { products, inventory, costs, assocRules };` |
| `git show origin/main:…/index.ts` | `const inventory = await syncInventory(supabaseAdmin, acct);` … `return { inventory, costs, assocRules };` |
| response do cron em `net._http_response` | `assocRules, costs, inventory` |

`products` **ausente** ⇒ bundle novo. Conclusivo, e não estatístico.

### Bônus: a forma resolve o empate que a `VERSAO` compartilhada não resolve

A §7 mostrou que duas respostas de sonda de edges diferentes são idênticas byte a byte (13 edges com a
mesma string `v1.0-sensor-inicial`, e `net._http_response` sem coluna de URL) — o que torna o veredito
**por edge** impossível no lote. A forma do payload não tem esse problema: `inventory, costs,
assocRules` é o retorno de **uma ação de uma edge**, e não cabe em nenhuma das outras. Onde a §7
perde o emissor, a §12 o recupera — pelo conteúdo, não pelo metadado que o pg_net não guarda.

### Pré-condição: a chave discriminante tem de ser INCONDICIONAL no bundle velho

É o análogo da "condição de validade" da §1, e o único jeito de a via produzir falso positivo se for
ignorada. No caso acima, o velho fazia `const products = await syncProducts(...)` e montava o objeto
literal com a variável — **nem um resultado vazio suprimiria a chave**, logo a ausência só pode ser
código novo. Se o velho fizesse `if (algo) resultado.products = …`, a ausência seria **ambígua**:
bundle velho no ramo falso produz exatamente a mesma forma. Confira no código do commit pai
(`git show <sha-do-merge>^:<arquivo>`) **antes** de ler a forma, não depois.

### Achar o response: por JANELA DE TEMPO, nunca por id chutado

Mesma armadilha da Lei de Ferro #5 da skill de deploy — **valor de exemplo plausível é pior que um
placeholder ruidoso, porque falha CALADO**: em 2026-08-24 um `WHERE id = 58967` inventado leu o tick do
watchdog e reprovou um deploy money-path correto. Como `net._http_response` não tem coluna de URL
(§7), a linha se identifica pela **forma do corpo dentro da janela do cron**:

```bash
~/.config/afiacao/psql-ro -c "SELECT id, created, status_code, left(regexp_replace(content,'\s+',' ','g'),400) FROM net._http_response WHERE created BETWEEN '2026-08-26 14:00Z' AND '2026-08-26 14:08Z' ORDER BY created;"
```

Identificada a linha, lê-se a forma:

```bash
~/.config/afiacao/psql-ro -c "SELECT string_agg(k, ', ' ORDER BY k) AS chaves FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'data') k WHERE r.id = <ID lido acima>;"
```

### A armadilha que quase passou: a linha de TIMEOUT devolve exatamente o veredito do método

Escrevi primeiro que o cast pelado "aborta a query inteira" e **fui testar** — não aborta, e o motivo
importa. As duas formas ruins de `content` se comportam de maneira **oposta**:

| corpo | o que a query verbatim faz | risco |
| --- | --- | --- |
| **não-nulo e não-JSON** (página HTML de erro) | `ERROR: invalid input syntax for type json` — **aborta**, exit 1 | ruidoso, seguro |
| **`content IS NULL`** (timeout do `net.http_post`) | **exit 0, uma linha, valor vazio** | 🔴 **silencioso e fatal** |

O segundo caso é o perigoso e foi **medido**: 1 de 208 linhas na janela de 2026-08-26 (`id = 60712`,
`status_code` **NULL**, `error_msg` = `Timeout of 60000 ms reached…`). Rodando a query de forma sobre
ela, `jsonb_object_keys(NULL)` produz **zero linhas**, o `string_agg` sobre zero linhas devolve **NULL**,
e o psql imprime uma linha em branco com **exit 0** — indistinguível, a olho, de uma leitura legítima.

E o veredito do método é justamente **"a chave sumiu"**. Ou seja: uma execução que **nem devolveu corpo**
lê-se como "bundle novo". É o `ausente ≠ zero` do money-path na sua forma mais barata de cometer.

**Regra: exija leitura POSITIVA.** A forma só vale se as **outras** chaves esperadas voltarem —
`chaves` vazio/NULL não é "chave ausente", é **linha inutilizável**. Gate barato no predicado
(`status_code = 200` já elimina o timeout, que vem com status NULL):

```sql
WHERE r.status_code = 200
  AND r.content IS NOT NULL
  AND left(ltrim(r.content),1) = '{'
  AND (r.content::jsonb) ? 'data'
  AND jsonb_typeof((r.content::jsonb)->'data') = 'object'
```

Medido na mesma janela: o predicado guardado e o pelado devolvem **30** linhas cada — ou seja, o guard
**não custa recall aqui**; ele existe para o dia em que a linha ruim não for nula.

### Limite: a retenção é a vida inteira desta via

`pg_net.ttl = 6 hours` (§5). A via passiva **só existe dentro da janela** — ela não audita um run de
dias atrás, e não há como recuperá-lo. Fora da janela, resta o N3 ativo. Corolário operacional: ao
mergear uma edge com cron frequente, **verificar cedo é mais barato**, porque a prova de graça expira.

### Dois sinais que PARECEM discriminar deploy e NÃO discriminam

Os dois foram levantados neste mesmo ciclo, pareciam fortes, e reprovaram. Ficam registrados porque o
próximo agente vai tropeçar exatamente neles.

**(a) Duração da execução (`acoes_execucoes`) — variância maior que o efeito.** O run pós-mudança caiu
para **24,0 s** contra a faixa recente de **49,5–62,6 s**, o que sugeria que `syncProducts` tinha saído
do caminho. Mas **08-18 já havia feito 24,4 s COM `products` no caminho**. O sinal e o ruído têm a mesma
amplitude: **corrobora, não prova**. É a classe do "indício fraco" — usar como veredito é fabricar
conclusão a partir de uma amostra que a série histórica já contradiz.

**(b) `last_page` alto em `sync_state` — o chamador mascara o default do código.** `products/colacor_vendas`
apareceu com `last_page = 43`, e o teto default do bundle velho era **10**: parecia prova direta do teto
novo (`MAX_PAGINAS_PRODUTOS = 500`). Não prova nada — o cron **42** (`sync-colacor-vendas-products`) passa
`"max_pages": 50` **explícito no body**, então o bundle velho faria as mesmas 43 páginas.

```bash
~/.config/afiacao/psql-ro -Atc "SELECT jobid||' :: '||substring(regexp_replace(command,'\s+',' ','g') from 'body[^)]*') FROM cron.job WHERE jobid = 42;"
# 42 :: body:='{"action": "sync_products", "account": "colacor_vendas", "max_pages": 50}'::jsonb,timeout_milliseconds:=150000
```

**A lição, generalizada:** antes de ler um valor observado como evidência de um **default do código**,
leia o **body do chamador**. Parâmetro explícito no cron torna o default irrelevante — e o observado
passa a ser evidência do *chamador*, não do bundle. Vale para qualquer teto, janela ou limite que o
código define e o cron pode sobrescrever (`max_pages`, `window_days`, `timeout_milliseconds`).

## 13. A §12 é cega para o diff que só ACRESCENTA um early-return — e quem provou foi a sonda de OUTRA sessão (2026-08-27, #2049)

Substrato: verificar o deploy de `omie-nfe-reconcile` (PR #2049, merge `dfa6e99e1`, 08:12). A pergunta
era a de sempre — "o bundle novo subiu?" — e o interesse era **não pedir deploy redundante**, porque
com ~16 sessões vivas em worktrees paralelas outra sessão pode já ter feito. Três achados, e o mais
barato é o terceiro.

### 13.1 A segunda pré-condição da §12: a forma só discrimina se o diff MUDA a forma

A §12 registrou uma pré-condição (a chave discriminante tem de ser atribuída **incondicionalmente** no
bundle velho). Faltava outra, que só aparece quando o diff é de **instrumentação**: o diff precisa
alterar a forma **do caminho que o cron exercita**.

O #2049 não altera. Ele acrescenta o ramo da sonda, e esse ramo faz `return` **antes** do fluxo real —
logo o corpo que o cron produz é byte a byte o mesmo nos dois bundles. **Sonda que retorna cedo é, por
construção, invisível ao caminho que o cron percorre.** Generalizando: a §12 lê diffs que *modificam* o
fluxo e é cega para diffs que *adicionam um ramo antes* dele. Como instrumentação de deploy tem
exatamente essa forma, **a via passiva da §12 e a sonda são complementares, nunca substitutas** — e é
erro esperar que a §12 verifique o PR que instala a sonda.

Como se checa antes de tentar (o diff, não a memória):

```bash
git show --stat dfa6e99e1 -- supabase/functions/omie-nfe-reconcile/index.ts
# o ramo do probe retorna antes do fluxo real ⇒ resposta do cron INALTERADA ⇒ §12 não discrimina
```

### 13.2 O disfarce do `versao` do fluxo real, confirmado em produção

O `versao.ts` desta edge já advertia que o `versao: "v3.3-paginacao-janelas"` da resposta do fluxo real
é string **hardcoded e anterior à sonda**. A janela de retenção confirmou de fato, sem ambiguidade:

```
6 runs do fluxo real | 2026-08-27 16:10 -> 21:10 UTC | com probe: 0 | com o marcador de fatia: 6
```

Seis respostas carregando um campo chamado `versao`, e **zero** delas dizendo qualquer coisa sobre qual
bundle respondeu. Quem lesse esse campo concluiria "verificado" e teria verificado nada — é o mesmo
julgamento que o #2052 tirou do SQL de sondagem ("o bundle sem o mapa de fingerprints saía DEPLOY
CONFIRMADO"). **Um campo se chamar `versao` não o torna sensor de bundle.**

### 13.3 O achado operacional: a sonda de OUTRA sessão fica retida 6 h, e é evidência de primeira classe

O que provou o deploy não foi o cron — foi uma sonda ativa que **outra sessão** havia disparado 2
minutos antes, e que o `pg_net` reteve:

```
61653 | 2026-08-27 21:48:06.209343 | 200 | {"ok":true,"probe":true,"versao":"v1.0-sensor-inicial",
        "edge":"omie-nfe-reconcile","fonte":"844e96d1d018a01374951da346d5d3d267b12431ebab1f7b8f032d117414e3c0"}
```

Ela veio num lote de três (`omie-sync-nfes-recebidas`, `omie-vendas-sync`, `omie-nfe-reconcile`), no
mesmo tick de coleta do worker do pg_net.

**A regra que sai daqui, e que é barata a ponto de virar primeiro passo:** em repo multi-sessão, antes
de pedir deploy — e antes de sondar, o que num bundle pré-sensor **paga o efeito caro** — varra
`net._http_response` por `"probe"`. A sonda de qualquer sessão é evidência para todas as outras
enquanto durar o TTL:

```bash
~/.config/afiacao/psql-ro -c "SELECT id, created AT TIME ZONE 'UTC' AS utc, status_code, left(content,200) FROM net._http_response WHERE content ILIKE '%\"probe\"%' ORDER BY created DESC LIMIT 10;"
```

O canal de coordenação entre worktrees paralelas não é só `git`/`gh pr list`: **é também o rastro que
as sessões deixam em produção.** Ninguém estava lendo esse.

⚠️ O que a leitura estabelece é um **limite superior**, não o instante: prova que o bundle novo já
respondia às 21:48 UTC, não a hora em que o deploy rodou. Para "quando", o rastro do bot na `main` é o
que existe — e ele prova que **um** deploy rodou, nunca qual versão (§6).

### 13.3.1 O filtro `"probe"` só enxerga a sonda ATIVA — e o eco passivo é a via MAIOR (2026-08-29)

A regra da §13.3 está certa; a query dela está **estreita**. O snippet acima filtra
`content ILIKE '%"probe"%'`, que é o marcador da resposta de **sonda**. Só que desde o #2063/#2079 as
edges instrumentadas anexam `versao`/`edge`/`fonte` a **TODA** resposta, não só à da sonda — e essas
linhas **não contêm** o marcador. Varrer pelo marcador da sonda descarta justamente a via que não
depende de ninguém disparar nada, que é a mais barata das duas.

Medido no MESMO instante (2026-08-29 02:20Z), confirmando as 5 edges da janela 27-29/08: o filtro
`"probe"` devolveu **4** edges; a varredura pela IDENTIDADE devolveu **8** — as mesmas 4 mais
`omie-sync-ctes-recebidos`, `omie-sync-sku-items`, `omie-sync-vendas-items` e
`analytics-outbox-drain`. Essas quatro eram **4 das 5** que se queria confirmar: com a query estreita
a sessão concluiria "sem evidência" e pediria ao founder o deploy de edges money-path **já no ar** —
o falso negativo caro do #2079 entrando por outra porta.

Há ainda um segundo nível que nem a query estreita nem um `->>'edge'` de topo alcançam: nos **5 steps**
do `omie-cron-diario` quem responde é o ORQUESTRADOR, e o corpo do filho chega aninhado em
`resultados.<key>.body`. Uma leitura só da raiz é cega para os cinco. A varredura é a UNIÃO dos dois
níveis, e rotula de onde veio cada linha:

```bash
# ⌨️ seu terminal — varredura por IDENTIDADE: cobre sonda ativa + eco de topo + eco aninhado
~/.config/afiacao/psql-ro -c "
WITH resp AS (
  SELECT id, created, content::jsonb AS j, (content ILIKE '%\"probe\"%') AS via_sonda
    FROM net._http_response
   WHERE status_code = 200 AND content IS NOT NULL AND left(ltrim(content),1) = '{'
), plano AS (
  SELECT created, j->>'edge' AS edge, j->>'versao' AS versao, j->>'fonte' AS fonte,
         CASE WHEN via_sonda THEN 'sonda' ELSE 'eco' END AS via
    FROM resp WHERE j ? 'edge'
  UNION ALL
  SELECT r.created, r.j->'resultados'->k->'body'->>'edge', r.j->'resultados'->k->'body'->>'versao',
         r.j->'resultados'->k->'body'->>'fonte', 'eco-step'
    FROM resp r, jsonb_object_keys(r.j->'resultados') k
   WHERE r.j ? 'resultados' AND jsonb_typeof(r.j->'resultados') = 'object'
     AND r.j->'resultados'->k->'body' ? 'edge'
)
SELECT DISTINCT ON (edge) edge, versao, left(fonte,12) AS fonte12, via,
       to_char(created,'MM-DD HH24:MI') AS utc
  FROM plano WHERE edge IS NOT NULL
 ORDER BY edge, created DESC;"
```

O `jsonb_typeof(...) = 'object'` não é enfeite: outro emissor grava `resultados` como **array**, e o
`jsonb_object_keys` sobre ela **aborta a query inteira** — não é uma linha ruim ignorada, é o
resultado todo perdido (medido em 2026-08-28 09:00Z, registrado na `lovable-deploy-verify`). ⚠️ Essa
metade é **precaução ancorada em medição anterior, não falsificada aqui**: no TTL de 2026-08-29 02:40Z
só havia `resultados` como `object`, então remover o guard *não* abortou. Ausência do array na janela
não prova que o guard sobra — prova que ele **não foi exercitado**, e as duas leituras se parecem.

Duas coisas que esta query **não** dispensa. A primeira é o **guard temporal** do #2079: `utc` tem de
ser POSTERIOR ao merge que se verifica — tick anterior é história, não pendência, e lê-lo como
"pendente" é o falso negativo que manda redeployar à toa. Para o veredito já com esse guard embutido,
o caminho é `scripts/verify-edge-eco.sh` da `lovable-deploy-verify`, não esta leitura crua. A segunda
é o `fonte`: `versao` sozinho prova o `index.ts`, e só o `fonte` alcança o `_shared/` (§13.5) —
compare os **64** hex contra o mapa da `main`, programaticamente. Conferir hash de olho é como se
fabrica veredito.

### 13.4 O controle de exclusividade — o `--pai` do fingerprint

Um `fonte` que bate com a `main` só prova **este** deploy se ele não pudesse ter vindo de um PR
anterior. É a armadilha da sentinela não-exclusiva da `lovable-deploy-verify` (falso positivo, que
*encerra* a verificação) transposta para o fingerprint. Os dois lados, no commit pai:

```bash
git show dfa6e99e1^:supabase/functions/_shared/sonda-fingerprints.ts | grep -c '844e96d1'          # 0
git show dfa6e99e1^:supabase/functions/_shared/sonda-fingerprints.ts | grep -c 'omie-nfe-reconcile' # 0
git show dfa6e99e1^:supabase/functions/omie-nfe-reconcile/versao.ts                                 # não existe
```

Zero nos dois, e a edge **nem era instrumentada** antes — o hash é estritamente novo do #2049. Do lado
positivo, `bun run sonda:fingerprint` devolveu `✓ 35 edge(s) — mapa bate com a fonte`, que é o que
impede ler um mapa *stale* como prova. Sem essa segunda metade, o zero no pai seria ausência de dado.

### 13.5 Por que o `fonte`, e não o `versao`, fechou o veredito

Os quatro sinais da resposta cobrem coisas diferentes, e só o último alcança o `_shared/`:

| sinal | o que fecha |
| --- | --- |
| eco `probe:true` | bundle **novo** — o velho ignora o campo e roda a varredura (o efeito caro vem junto com o veredito) |
| `edge` | a identidade, que resolve o empate do lote da §7 |
| `versao` | o `VERSAO` do `versao.ts` **novo** ⇒ o arquivo de status `A` subiu (sem ele a função não bootaria) |
| `fonte` | o fecho transitivo de imports locais idêntico byte a byte ⇒ **verbatim, com o `_shared/` junto** |

É o complemento exato do #2054 ("o eco de `versao` na canária promete demais — `_shared/` só o `fonte`
cobre, e ele não viaja ali"): lá a canária da `omie-vendas-sync` ecoa `versao` **sem** o `fonte`, e por
isso não cobre `_shared/`; aqui a sonda ecoa o `fonte`, e é justamente ele que fecha o degrau. Ao
projetar uma sonda nova, **o `fonte` não é enfeite ao lado do `versao` — é o único campo que responde
"a fatia inteira subiu?"**.

---

## 14. Edge fora do mapa não REPROVA — ela some do denominador (2026-08-28)

A `analytics-outbox-drain` (#2035, `d5d79cf11`) nasceu **no mesmo dia** em que este doc já tinha 13
seções sobre sondar edge, e mesmo assim chegou sem `versao.ts` e fora de `_shared/sonda-fingerprints.ts`.
O interessante não é a omissão — é que **nenhum dos três gates de sonda reclamou**, e por desenho:

| gate | universo dele | o que ele fez com a edge ausente |
|---|---|---|
| `sonda:bump` | as edges **instrumentadas** que a fatia tocou | não a viu: sem `versao.ts` ela não é instrumentada |
| `sonda:fingerprint` | as edges **instrumentadas** | idem — o mapa e a lista nascem do mesmo `versao.ts` |
| `sonda:sql <edge>` | a leva que você **pediu** | recusou (exit 1, "Edge não sondável — sem sensor") |
| `pendencias:deploy` | o **mapa commitado** (`lerMapaCommitado`) | tirou 39 do denominador — a 40ª não existia para ele |

Os quatro estão certos. O buraco é de **classe**: quando o universo de um gate é uma lista derivada de
um artefato **opt-in**, quem nunca entrou na lista não reprova — desaparece. `cobertura: 39/39` era
`39/40`, e um denominador que se ajusta sozinho ao que já foi instrumentado **não pode** acusar o que
falta. É o gêmeo exato do #2089 (`cobertura: 2/39` saindo com o mesmo exit 0 de `39/39`), um degrau
acima: lá o numerador mentia, aqui o denominador.

O piso que existia — o gate "nenhuma edge que serve o `paginate.ts` fica SEM prova de deploy" — não a
alcança e **não é furo dele**: ele se declara piso e ancora no consumo de um helper específico, que
esta edge não importa. Um piso ancorado em helper cobre quem usa o helper; o resto é grafo que ele não
enxerga (a mesma lição de `enumerar-consumidores-de-helper.md`, §9ª leva).

### O custo real: a verificação do deploy virou arqueologia

Em 2026-08-28 provar que a edge estava no ar exigiu montar o caminho na hora — **N1** (`verify-edge.sh`:
OPTIONS 200 + controle negativo em 404, que separa "existe" de "qualquer nome responde") somado ao **N3
passivo** de `net._http_response`, onde o corpo trazia uma string literal exclusiva do `index.ts`.

Funcionou **por acaso**: a edge estava respondendo 500 com uma mensagem distintiva. Isto é a §12 (N3
passivo pela FORMA do JSON) com a pré-condição da §13.1 satisfeita por sorte e não por desenho — a
forma só discrimina se o diff **mudar a forma**, e uma fatia futura interna a esta edge (trocar o teto
do lote, mexer no backoff, mudar a partição) não mudaria campo nenhum. Da segunda vez não teria dado.

### O que a instrumentação trouxe, e por que o ECO aqui é mais barato que nos 5 steps do #2063

A edge entrou no padrão inteiro (`VERSAO`/`EFEITO`/`EDGE`/`FONTE`, `criarRespostaSonda`, sonda logo
após o `authorizeCronOrStaff` e antes do `createClient`). O que ela acrescenta ao padrão é a via do
**eco**: os 5 steps do cron diário dependem de o `omie-cron-diario` fazer `JSON.parse` do corpo deles e
devolvê-lo em `resultados.<key>.body` — a identidade passa pelo **pai**, e a amostra é o tick de 2 h.
Aqui o cron `analytics-outbox-drain` (`*/5`) faz `net.http_post` **direto na edge**, então o corpo que
cai em `net._http_response` já é o dela, sem intermediário, com **~72 amostras** dentro da janela de
~6 h do `pg_net.ttl`. É o N3 passivo mais barato do repo.

Por isso os 5 gates de eco do contrato deixaram de varrer `STEPS_CRON_DIARIO` e passaram a varrer
`ECOAM_VERSAO`: a propriedade exigida nunca foi "ser step do `omie-cron-diario`" — é **o corpo desta
edge chegar a `net._http_response`**. Lista extraída, e não um segundo bloco de asserts para a edge
nova: duas cópias do mesmo gate envelhecem separado, e a que não for mantida é a que deixa de valer.

### O custo de sondar aqui é COMPARATIVO — e é o que a separa da `carteira-rebuild`

Um `{"probe":true}` num bundle pré-sensor desta edge roda `drenar()`: claim de 200 linhas, envio ao
PostHog, marcação do desfecho (e quarentena no 400/413). Parece caro até se notar que **o cron chama
esse mesmo caminho, com os mesmos defaults, a cada 5 minutos**: sondar às cegas aqui **adianta um
tick**, não cria efeito de classe nova. Ou seja, esta edge não entrou pelo critério do efeito — entrou
pelo da sexta leva, o único que ainda vale sozinho: *barato de chamar* e *possível de verificar* são
propriedades diferentes, e só o marcador dá a segunda.

### Falsificação (as 5, cada uma nomeando a edge na mensagem)

Gate verde numa edge recém-adicionada é indistinguível de gate que não a varre. As sabotagens, todas
com vermelho e a edge citada no erro: eco sem `edge`/`fonte`; `EDGE` ≠ nome do diretório; sonda que
**classifica e não responde** (`console.log` no lugar do `return` — o furo da §9); `FONTE` transcrito à
mão em vez de derivado de `respostaSonda`; e a entrada removida do mapa (aí quem fica vermelho é o
`sonda:fingerprint`, "instrumentada mas AUSENTE do mapa"). Script: commitar **antes**, porque o
`restaurar()` é `git checkout --`.

### Assinatura para varredura futura

O que sobra como pergunta aberta é o denominador: **95 diretórios de edge, 40 instrumentadas**. Não é
dívida — a maioria é leitura pura, para quem a sonda não resolve problema nenhum (o critério da 3ª
leva). O que falta é o gate que force a **DECISÃO** no nascimento da edge: instrumentar, ou declarar
por que não. Enquanto ele não existir, a régua barata é conferir, ao criar edge com cron próprio, se
ela entra em `bun run pendencias:deploy` — edge que não aparece nem como pendência é edge fora do radar.

## 15. O gate de CONTRATO tinha o mesmo furo da §14 — e ele já tinha mordido, uma leva antes (2026-09-05)

A §14 fechou o denominador do **mapa de fingerprints**. O que ninguém refez foi a mesma pergunta
sobre o outro artefato opt-in do assunto: a lista `EDGES` de
`supabase/functions/_shared/sonda-versao-contrato_test.ts`.

**Medido**, ao instrumentar a 12ª leva: **45 pastas com `versao.ts`, 40 declaradas em `EDGES`**.
As 5 de fora eram exatamente a **11ª leva** (#2170 — `whatsapp-send`, `whatsapp-send-template`,
`enviar-push`, `nvoip-calls`, `dispatch-notifications`), instrumentadas no dia anterior. Elas
entraram no mapa de fingerprints e **não** neste arquivo.

O que isso significa na prática: **todo** teste do contrato varre `EDGES` ou uma sublista dela — o
formato do `VERSAO`, o `EFEITO` que nomeia o custo, "a sonda RESPONDE", "a sonda é IO-free", "não
volta o `=== true` cru", "duas edges nunca produzem respostas idênticas". As 5 estavam
instrumentadas e **sem gate de FORMA nenhum**. E os dois números eram verdes ao mesmo tempo:
`sonda:fingerprint` dizia `45/45`, o contrato dizia `40 passed | 0 failed`. Nenhum dos dois estava
errado — eles falavam de **universos diferentes**, e a diferença não tinha dono.

É a §14 de novo, com outro artefato: *quando o universo de um gate é lista derivada de artefato
OPT-IN, quem nunca entrou não reprova — some*. E é também a lição de
`uniao-de-vias-cegas-nao-e-cobertura.md`: dois gates verdes não somam cobertura enquanto ninguém
calcula a **interseção dos furos**.

### O conserto

Um teste de **completude** no próprio contrato, comparando `EDGES` contra a **ÁRVORE** — não contra
outra lista escrita à mão:

- `versao.ts` é o mesmo marcador que `edgesInstrumentadas()` do `scripts/sonda-fingerprint.ts` usa,
  então os dois gates passam a falar do **mesmo conjunto** — que era a divergência de origem.
- Ele reprova nos **dois sentidos**: pasta com `versao.ts` fora de `EDGES` (o caso medido), e
  `EDGES` apontando para pasta que não tem mais `versao.ts` (lista que aponta para o que não existe
  apodrece em silêncio).
- E tem **guard de controle positivo vazio**: se a varredura não achar pasta nenhuma, o gate
  REPROVA em vez de passar. Uma lista vazia por ERRO (cwd errado) é indistinguível de lista vazia
  por mérito — a regra de `sonda-ausente-em-script-que-apaga.md`.

Falsificado nas três direções, uma camada por vez: apontar `RAIZ_FUNCTIONS` para `_shared/` grita
"controle positivo vazio"; declarar uma `edge-fantasma` grita "sem `versao.ts` na árvore"; e o
controle positivo original — rodar o gate **antes** de acrescentar as 5 — nomeia as 5.

As 5 entraram com a forma que **já tinham** (medido: `classificarSonda` antes do `createClient`,
`respostaSonda` no handler, gate `authorizeCron*` que aceita `x-cron-secret`), então o conserto não
pediu mudança de código de produção nenhuma — só parou de deixá-las invisíveis. O contrato foi de
40 para **54** edges declaradas.
