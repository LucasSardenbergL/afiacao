# Controle POPULACIONAL não prova a TENTATIVA — e "2xx" não é testemunha

> 2026-09-09. Gerador `scripts/sonda-versao-sql.ts` (money-path: o SQL dele decide se uma edge está
> no ar). Fecha a limitação que o parecer Codex do #2424 nomeou e que a docstring do CTE já
> descrevia no SQL emitido, sem ter como resolver.

## A classe

Um controle que responde **"a credencial está boa?"** contando **população** — tráfego recente, de
outros chamadores — responde a uma pergunta parecida e diferente: *"alguma credencial funcionou
recentemente?"*. Ele não sabe **qual** credencial autenticou o que contou, nem se **esta tentativa**
mandou a certa. As duas perguntas divergem exatamente quando importa.

O `controle_credencial` desambiguava o HTTP 401 (bundle pré-sonda × `CRON_SECRET` inválido) assim:

```sql
count(*) FILTER (WHERE r.status_code BETWEEN 200 AND 299) AS ok_recentes,
count(*) FILTER (WHERE r.status_code = 401)               AS recusas_recentes
FROM net._http_response r
WHERE r.created > now() - interval '6 hours'
  AND NOT EXISTS (SELECT 1 FROM ids id_leva WHERE id_leva.request_id = r.id)
```

Com `ok_recentes >= 10 AND recusas_recentes = 0`, o 401 saía **DETERMINADO**. Duas manifestações do
buraco, com destinos opostos:

| | o que acontece | se corrige sozinha? |
|---|---|---|
| **(a)** `CRON_SECRET` rotacionado há minutos, nenhum cron desde | os 2xx da janela usaram o secret ANTIGO e avalizam | **sim** — no próximo cron vira 401 |
| **(b)** o próprio disparo mandando header errado | a leva toma 401, seus ids ficam FORA da contagem (pelo `NOT EXISTS`), o controle segue VERDE | **não** |

O `NOT EXISTS` — que existe para o controle não se auto-envenenar — é o que torna (b) invisível:
quanto mais quebrada a leva, mais limpa a contagem. O desfecho é redeploy à toa de uma edge que já
estava no ar, com o veredito escrito em letras confiantes.

**O #2424 mitigou (b) pelo lado errado do problema.** Unificar os headers numa função só
(`httpPost`) + asserções + 3 mutações protege contra **drift no código**. Não alcança o caso em que
o código está intacto e o segredo no vault está errado no instante do disparo.

## O conserto: prova da TENTATIVA ATUAL

`controle_ativo` conta, entre os `request_id` **desta leva** (o mapa que o disparo já embute), as
respostas que **testemunham**. Ativo, autenticado e atribuído — não populacional, não histórico.
O veredito determinado do 401 passou a exigi-lo; o histórico virou **contexto exibido**.

Manter o histórico como condição adicional (`AND`) foi considerado e descartado: o ativo o
**subsume** — se a credencial foi aceita agora por um request desta leva, o que 52 crons fizeram em
6h não acrescenta prova —, então o `AND` cobraria recall sem comprar precisão.

## A armadilha dentro do conserto: 2xx CRU é fail-OPEN

A primeira versão contava **qualquer 2xx da leva**. Parecia sólida, e estava apoiada numa medição
minha: *nas 60 edges sondáveis, o gate `authorizeCron*` roda antes de emitir a resposta de sonda —
60/60*. O parecer Codex derrubou com um contraexemplo do próprio repo:

> `monthly-report@ef08dddd2` — bundle **histórico** que ignora a credencial e manda e-mail para
> QUALQUER POST. Responde **200** sem autenticar nada. E `resolverLeva()` aceita `monthly-report`.

**O erro de raciocínio, que é a lição mais transferível daqui:** medi o gate no **código da main**
para afirmar uma propriedade do **bundle que está no ar** — quando a razão de existir deste gerador
é precisamente que os dois divergem. A medição estava certa; a **passagem** dela para a conclusão é
que não valia. `resolverLeva()` restringe quais *nomes* de edge são alcançáveis; não restringe qual
*implementação* está servindo aquele nome.

**Testemunha é IDENTIDADE, não status.** A resposta tem de se identificar:

- **sonda** — eco `probe:true` + `edge` do próprio id + **`versao` E `fonte` iguais às esperadas**;
- **canária** — `canary:true` + o **marcador** esperado, **sem exigir 2xx** (a
  `generate-tactical-plan` responde **500** quando a fixture reprova, e esse request já passou pelo
  gate para chegar a executar: `ok:false` é regressão de negócio, não desautenticação).

A cadeia fecha em três elos: o `fonte` é o sha256 do arquivo servido ⇒ o bundle no ar é VERBATIM o
do repo; **no repo o gate autentica antes de responder** ⇒ agora imposto por
`bun run sonda:autentica`, não mais uma medição datada; o `request_id` amarra a resposta a ESTE
disparo. O bundle anônimo do contraexemplo não passa pelo primeiro elo. A `recommend` histórica,
atrás de `Bearer`, recusa o nosso disparo — que não manda `Authorization`.

## O que mais o parecer pegou, e entrou junto

- **`COALESCE(s.id, i.request_id)` preferia o ECO ao id embutido.** Com o request desta leva em 401
  e um eco 200 de sondagem anterior ainda na janela, o veredito julgava a execução **velha**
  enquanto o controle contava a nova — controle e veredito falando de execuções diferentes na mesma
  linha. Pior: com a trava FECHADA (id NULL, nada disparado) um eco antigo fazia a linha sair
  julgada. No modo embutido o id passou a ser **autoritativo**; o eco sobrevive no `--so-leitura`.
  Como a recência vinha de graça pelo eco, o caminho por id ganhou **ramo próprio de janela** —
  senão a correção criaria a regressão "célula de outra sessão julgada como de agora".
- **Zero fundia estados diferentes.** `pendente` (sem resposta ainda) e `falha de transporte` não
  são recusa — no pg_net 0.19.5 o erro grava `error_msg` e deixa o `status_code` NULL, e
  `timed_out` fica NULL no estouro (#2015). São quatro contadores separados, e a mensagem diz
  **"nenhuma aceitação foi OBSERVADA"** com o denominador, nunca "nenhum disparo foi aceito":
  `ausente ≠ zero` aplicado ao próprio controle. O ramo `FALHA DE TRANSPORTE` vem **antes** do
  `AGUARDE` — mandar repetir a cada 10s uma requisição que morreu é laço de espera fail-OPEN.

## A troca aceita (precisão > recall)

Quando a leva **inteira** responde 401 não há testemunha, e o veredito é INDETERMINADO onde o
histórico determinava. Na prática é a leva de **uma** edge pré-sonda — e é exatamente onde (b)
morde. O que se perde em recall é o que se ganha em não mentir; a saída está escrita no próprio
ramo: acrescentar à leva uma edge que se sabe no ar.

A **âncora** (um disparo fixo contra alvo conhecido-bom, ex. `sonda-relay`) foi avaliada e ficou
fora: recupera esse recall ao custo de um alvo acoplado no gerador, +1 request, e um veredito
confuso no dia em que a própria âncora estiver velha. Se a perda aparecer na prática — com sinal, não
por suposição — ela vira um PR próprio.

## Provas

Executando SQL em **PG17** (`db/test-canaria-veredito.sh`, 24 ok / 0 fail; `--falsificar` verde nos
2 locales) — asserção textual não prova desfecho de `CASE`:

| caso | veredito |
|---|---|
| 401 com **testemunha ativa** na leva | `SEM CANARIA NO AR` (determinado) |
| **leva INTEIRA 401 com histórico VERDE** ← a manifestação (b) | `INDETERMINADO` |
| **2xx anônimo** na leva (o `monthly-report@ef08dddd2`) | `INDETERMINADO` |
| 2xx com marcador de **outra fatia** | `INDETERMINADO` |
| `error_msg` com status NULL | `FALHA DE TRANSPORTE` (não `AGUARDE`) |

O fake de `net._http_response` do teste **não tinha `error_msg`** — a coluna existe na tabela real e
outros testes já a declaravam. Fake incompleto torna o ramo **inexprimível**, e foi assim que ele
passou tanto tempo sem existir.

Mutação: `scripts/mutcheck.d/sonda-versao-sql.mut` (5 mutações novas; 3 do controle histórico
**reancoradas**, não perdidas — elas guardavam conjuntos que deixaram de decidir) +
`scripts/prova-consumidores-controle.sh`, agora com **dois** CTEs compartilhados, cada um obrigado a
morrer em CADA modo isolado — porque o mutcheck lê a suíte AGREGADA e `PEGA` só diz que *algum*
teste morreu.
