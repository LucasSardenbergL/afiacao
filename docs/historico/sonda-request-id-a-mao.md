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
