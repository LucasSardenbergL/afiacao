# O `request_id` copiado à mão: a leitura fabricou veredito a partir de dado que não era o medido (2026-08-24)

Mesma família de [`evidencia-positiva-shell.md`](evidencia-positiva-shell.md). Lá, o aparelho de medição
troca o valor em silêncio (`| tail` engole o exit code, `$?` sobrescrito por um `echo` no meio). Aqui o
aparelho está correto e é o **transporte do identificador entre dois passos** que troca o valor — com o
mesmo desfecho: um número real, de um emissor real, lido com toda a confiança como se fosse a medição
pedida. **Ausência de erro não é ausência de troca.**

## O que aconteceu

Receita canônica da sonda de versão (`docs/agent/deploy.md`), então em dois passos: (1) `SELECT
net.http_post(…) AS request_id`; (2) `SELECT … FROM net._http_response WHERE id = <o número>`, com o
founder carregando o número de um passo ao outro.

Numa rodada de verificação de deploys, dos **quatro** `request_id` reportados, **três não eram sondas**:

| id | corpo lido | o que era de fato |
|---|---|---|
| 59102 | `{"success":true,"data":{"updated":2477}}` | run de cron |
| 59103 | `{"modo":"watchdog",…}` | o tick do watchdog — literalmente o falso-negativo do #1915 |
| 59283 | `{"success":true,"imported":0,"skipped":3}` | import de cron |

As sondas reais eram **59281** e **59286**. O erro só apareceu porque a resposta da sonda carrega
`edge`/`versao`/`contrato` no corpo, o que permitiu **localizá-la por conteúdo**. Uma sonda sem campo de
identidade teria sido indistinguível de um cron, e o deploy teria sido dado como provado sem prova —
ou, na direção oposta e mais cara, um deploy correto seria lido como ausente e uma edge money-path
seria redeployada à toa (o desfecho já registrado do #1915).

## Por que o número é estruturalmente inseguro na mão

- **Vizinho de id é tick alheio por padrão.** Medido nesta tabela em 2026-08-24: **159 respostas em
  355 min** — uma a cada ~2,2 min — e **ZERO delas emitindo `edge`**. Não é azar; é a taxa de fundo.
- **Cron mudo projeta a assinatura do bundle velho.** `{"modo":"watchdog",…}` lido pela receita antiga
  devolve `status_code 200, edge NULL, versao NULL`, que é **byte a byte** o que um bundle pré-sensor
  produziria. Nada na saída denuncia a troca.
- **A janela de auditoria é curta.** `net._http_response` retém ~6h: ao investigar este caso, os cinco
  ids já haviam expirado da tabela. O erro de leitura **não é re-auditável depois** — só o corpo que o
  founder tiver copiado sobrevive.

## Por que não dá para fundir os dois passos (verificado, não suposto)

O pedido natural — "faça o POST e a leitura no mesmo bloco" — **não tem solução no SQL Editor**, e a razão
é de arquitetura, não de sintaxe:

- `net.http_post` apenas **enfileira** (`INSERT INTO net.http_request_queue … RETURNING id`); quem despacha
  é um **worker de fundo em outra conexão**, que só enxerga linha **COMMITADA**.
- O SQL Editor do Lovable executa o conteúdo colado como **UMA transação** (evidência independente já
  registrada: um erro de sintaxe faz rollback do batch inteiro, e com o batch abortado a
  `http_request_queue` fica vazia).

Disso decorre que **todo** truque de bloco único falha, e falha do jeito pior — devolvendo zero linhas,
que se lê como "ainda não chegou":

| tentativa | por que não funciona |
|---|---|
| `DO … PERFORM pg_sleep(20)` + `SELECT … INTO` | dorme **antes** do envio: a requisição só sai no COMMIT, depois do bloco |
| CTE gravando o id em temp table | mesmo batch = mesma transação (idem acima); batch novo = a temp table já morreu com a sessão |
| `\gset` | sintaxe do **cliente psql**; não existe em editor web |
| extensão `http` (síncrona) ou `dblink` (commit autônomo) | **resolveriam de fato** — mas estão disponíveis e **não instaladas**, e instalar é mudança de banco em prod money-path |

## A correção: eliminar o campo, não sinalizá-lo

A receita anterior já vinha endurecendo o **placeholder** — de número de exemplo para
`COLE_AQUI_O_REQUEST_ID`, que falha ruidoso quando esquecido. Isso protege contra o **esquecimento**, e
não contra a **substituição errada**: o número plausível continua entrando, e foi o que entrou.

O passo 1 agora **dispara e escreve o passo 2 já pronto**, com o id embutido por `format()`, numa célula
única para copiar. O id nunca vira texto que um humano lê ou redigita. Continuam explícitos o
`timeout_milliseconds` (o default de 5s mata silencioso) e o `COALESCE` do envelope `data`; o `LEFT JOIN`
garante uma linha sempre; e **em nenhum momento** existe fallback por `ORDER BY id DESC LIMIT 1`.

> **Regra:** campo que o operador preenche à mão é defeito a **remover**, não a anotar. Quando o valor pode
> ser carregado pelo próprio sistema, carregue — some-se a classe inteira em vez de sinalizá-la. Placeholder
> inválido é a segunda melhor opção, para quando a eliminação é impossível.

## O que o campo de identidade recupera — e o que ele não consegue

Com o id vindo do banco, a linha lida **é** a do request por construção. Só então `edge NULL` volta a ter
**um** significado ("meu request, bundle pré-sensor") em vez de dois, e o veredito pode ser projetado em
ramos disjuntos: `AGUARDE` · `SONDA` · `ID TROCADO A MAO` · `BUNDLE VELHO recusou na borda` (≥400, nada
executou) · `BUNDLE PRE-SENSOR` (200 sem `versao` — ignorou o probe e **rodou o fluxo real**).

O limite honesto: a proteção é **estrutural**, não um check na saída. Nenhuma coluna consegue acusar "você
leu a linha errada" quando a linha errada é um cron mudo — foi essa a lacuna. O `CASE` só distingue os
ramos porque o humano saiu do caminho do id.

## Falsificação

Os cinco ramos foram exercitados contra fixtures (sonda verde · sonda com envelope `data` · os dois
corpos de cron REAIS do incidente · 400 de bundle velho · resposta de outra edge), e o gerador foi rodado
ponta a ponta no banco de produção em modo leitura: o `format()` produz SQL válido, e a leitura de um id
inexistente devolve **uma** linha `AGUARDE` em vez de zero. Os dois corpos de cron do incidente, lidos com
id vindo do banco, caem em `BUNDLE PRE-SENSOR` — o veredito correto para *aquele request*; lidos com id
trocado à mão, era o veredito de um request que ninguém fez.

## O mesmo defeito no bloco do LOTE — migrado (2026-09-06, #2278)

A seção irmã do `deploy.md` ("Sondar VÁRIAS edges numa tacada") tinha a variante coletiva: o passo de
disparo terminava em `SELECT jsonb_object_agg(edge, request_id)::text AS ids_opcionais_passo_2`, e o de
leitura abria com um `jsonb_each_text('{}'::jsonb)` onde alguém colava aquele blob. O SQL do lote não é
digitado — sai de `bun run sonda:sql` (`scripts/sonda-versao-sql.ts`) —, então a migração é lá, e o
`deploy.md` a descreve. Hoje o passo 1 (e o 3, das caras) termina em
`format($sonda$…$sonda$, m.ids)`: **devolve o passo 2 (e o 4) já escrito, com o mapa `edge→id` dentro**.
Continuam sendo dois blocos pela mesma imposição do `pg_net` verificada acima — nada aqui contorna o
COMMIT.

**O que a migração fecha e o que ela NÃO fecha.** No bloco de uma edge, o campo desapareceu: não há mais
nada para o humano preencher. No lote, a **célula** ainda é copiada por uma pessoa — o que sumiu é o
dígito, não o transporte. Uma célula de OUTRA leva tem mapa sintaticamente VÁLIDO com os nomes errados, e
contra isso o guard continua sendo o `FROM esperado LEFT JOIN ids` (nunca `FROM ids JOIN esperado`):
falsificado contra prod trocando o mapa por `{"edge-de-outra-leva": 71275}`, a leitura devolveu **as 2
edges esperadas** com `INDETERMINADO`, não zero linhas — e zero linhas se leria como "nada a reportar".
São classes diferentes com guards diferentes; a migração não dispensa o `LEFT JOIN`.

**O que a migração ganha, além da ergonomia:** o mapa embutido é o que o **eco não alcança**. Bundle
PRE-SENSOR e recusa HTTP respondem sem ecoar o slug e, no caminho do eco, caem em `INDETERMINADO` junto
com "não disparou"; com o id do próprio disparo em mãos, saem determinados. O `ids` vazio também
desqualificava o controle de credencial do 401 (o `NOT EXISTS` não excluía a própria leva) — embutido, o
401 volta a ser determinável.

**Achado da falsificação: um ramo do `CASE` não era disjunto.** Apontado o mapa para a resposta **71275**
— o cron da `analytics-outbox-drain`, que ecoa `edge`/`versao`/`fonte` e **não** ecoa `probe` —, a
leitura caía no `ELSE` e imprimia `BUNDLE VELHO — respondeu versao=v1.1-… (esperado v1.1-…)`, com versão
e fonte **idênticas** às esperadas: o falso negativo da armadilha do casamento só-por-slug, entrando pelo
caminho dos `ids` (o `LATERAL` do eco já filtra `probe = 'true'`; o `LEFT JOIN` por id não filtrava
nada). O ramo `NAO E RESPOSTA DE SONDA` fecha isso e vem **antes** do `? 'fonte'` — um cron que ecoe
`versao` sem `fonte` sairia como `PRE_SONDA_FONTE`, que nomeia "bundle anterior ao #1998": causa errada,
mesma classe. O defeito era anterior à migração e só aparecia para quem colasse o blob; foi a
falsificação da migração que o exibiu.

**Duas armadilhas do `format()` que o corpus não exercita.** `%` no corpo vira diretiva, e a tag do
dollar-quoting dentro do corpo encerraria a string no meio (passo seguinte emitido pela metade, sem erro
visível). O SQL de hoje não tem nenhum dos dois caracteres — medido —, então um teste que só olhasse o
SQL emitido ficaria verde por **acidente do corpus** ([gates-textuais-cegos.md](gates-textuais-cegos.md)).
Daí `escaparParaFormat()` ser exportada e testada direto: escapa `%` **antes** de plantar o `%1$L` (na
ordem inversa o próprio placeholder viraria `%%1$L` e o mapa sairia literal) e lança quando a tag aparece.

**Falsificação (prod, leitura, `psql-ro -v ON_ERROR_STOP=1`, com as chamadas `net.http_post` trocadas por
ids literais — `claude_ro` não dispara POST):** o passo 1 rodou no banco e devolveu o passo 2 escrito com
`jsonb_each_text('{"fin-valor-cockpit": 999999999, "analytics-outbox-drain": 71275}'::jsonb)`; executado,
devolveu **2 linhas** — id inexistente ⇒ `AGUARDE` (não zero linhas), id de cron ⇒ `NAO E RESPOSTA DE
SONDA` (antes: `BUNDLE VELHO`). Mapa de outra leva ⇒ 2 linhas `INDETERMINADO`. Passo 3 com a trava
FECHADA ⇒ mapa `{"fin-valor-cockpit": null}` e **1 linha** dizendo que a trava do passo 3 ficou fechada —
a trava continua sendo `CASE`, nunca `WHERE`, e nenhum POST sai dela.
