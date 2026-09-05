# A ausência FABRICADA por filtro de forma — 7 edges sondadas viraram "não observei nada" (2026-09-05)

> **A classe:** um filtro de FORMA aplicado **antes** da classificação não estreita o resultado — ele
> apaga a evidência e a substitui por *ausência de dado*. E ausência de dado, num script fail-closed,
> tem o **mesmo desfecho** do sinal (chip) com **zero** do valor dele: o veredito deixa de dizer o
> que foi observado. "Na dúvida, chip" não autoriza **inventar** a dúvida.

## O desfecho, primeiro

`.claude/skills/fecho/scripts/edges-pendentes.sh` (Passo 3 do `/fecho`) imprimia, para 7 das 40
edges do mapa de fingerprints:

```
SEM_PROVA      ai-ops-agent    nenhuma sonda em 6 hours (ausência ≠ pendência: INDETERMINADO)
```

Não era verdade. As 7 — `ai-ops-agent`, `fin-cashflow-engine`, `fin-funding`,
`generate-tactical-plan`, `omie-cliente`, `omie-financeiro`, `recommend` — **foram sondadas**
(request_ids 69305–69314) e **responderam 200**, com eco de `probe` e `versao`. O que a resposta não
trazia era o campo `fonte`. Depois do fix, a mesma janela, o mesmo banco:

```
PRE_SONDA_FONTE ai-ops-agent    respondeu a sonda SEM o campo `fonte` — bundle anterior ao #1998, PRECISA DEPLOY
```

Medido em prod sobre as 40 edges do mapa, com a correção no ar: **8 `NO_AR` · 7 `PRE_SONDA_FONTE` ·
25 `SEM_PROVA`**. As 7 saíram da coluna "não sei" para a coluna "sei, e é pendência **provada**".

## A causa: uma linha de CTE

```sql
), sondas AS (
  SELECT created, (content::jsonb) ->> 'edge' AS edge, (content::jsonb) ->> 'fonte' AS fonte
  FROM bruto WHERE (content::jsonb) ? 'fonte'      -- ← aqui
)
```

`criarRespostaSonda` (`_shared/sonda-versao.ts`) só passou a servir `fonte` no **#1998**
(~2026-08-25). Um bundle anterior responde `{ok, probe, versao, edge}` e mais nada. O `? 'fonte'`
descartava essas linhas **antes** de qualquer classificação, e a edge caía no ramo seguinte, que
supõe que nada foi observado: *"nenhuma sonda na janela"*.

## Por que isso é prova POSITIVA, e não ausência

A direção do script é `presença PROVA, ausência NÃO reprova` — e é justamente por isso que a
confusão custa caro. Um 200 que ecoa `probe` **é** presença. E o que essa presença prova é forte:

- a edge está no mapa da main ⇒ o código mergeado passa por `criarRespostaSonda` ⇒ **a main serve
  `fonte`**;
- o ar respondeu sem `fonte` ⇒ **o ar não é a main**, e é anterior ao #1998.

Isso é do mesmo tipo do `DESATUALIZADA` (fingerprint que não bate), não do `SEM_PROVA`. O script já
tinha o ramo irmão para `fonte = 'nao-mapeada'` — *"a prova nasceu cega"*, que é o bundle **novo**
servindo uma prova vazia. Faltava o ramo do bundle **velho**, que é o caso mais forte dos dois.

## O custo de chamar prova de ausência

Não é "só" um rótulo errado. O `edges-pendentes.sh` existe para **cortar chip redundante** — o
gatilho velho (`git log -- supabase/functions/`) era quase sempre verdadeiro e enterrava o chip que
importava. Um veredito que diz `INDETERMINADO` sobre 7 edges devolve exatamente o problema que o
script foi escrito para resolver: a lista volta a ser "tudo", e o leitor perde a única informação
que faria diferença — **estas 7 estão com bundle velho no ar, agora**.

E há o segundo custo, o do #2148: quem lê `nenhuma sonda na janela` conclui que **a sonda** está
quebrada e vai investigar o sensor, não o deploy.

## Parentesco — e a fronteira que ficou de PÉ

Este é o gêmeo de `fix-em-doc-nao-alcanca-a-ferramenta.md` (#2148), onde
`scripts/pendencias-deploy.ts` exigia `"probe"` e por isso perdia as **72** respostas do eco
passivo. Os dois defeitos são a mesma forma — filtro de marcador aplicado antes da leitura — em
sinais opostos. Por isso o fix aqui é **aditivo**, e não uma troca de filtro: a 1ª classe da CTE
(resposta **com** `fonte`) segue exatamente como estava, para não repetir o #2148 e derrubar o eco
passivo, que carrega `versao`/`edge`/`fonte` e **não** carrega `probe`.

O que o fix deliberadamente **não** faz, para não afrouxar o fail-closed:

| ainda `SEM_PROVA` / INDETERMINADO | por quê |
| --- | --- |
| HTTP 401 | não separa bundle pré-sonda de `CRON_SECRET` inválido (`docs/agent/deploy.md`) |
| 200 sem eco de `probe` (pré-sensor) | `edge`+`versao` sozinhos não distinguem resposta de sonda de um JSON qualquer — e uma linha espúria mais recente **sombrearia** uma prova real no `DISTINCT ON` |
| ausência real de linha | é o caso legítimo de ausência de dado |

O sentinela `sem-campo-fonte` não colide com valor servido nenhum: o mapa só aceita `[0-9a-f]{64}`
e a única outra resposta possível de `criarRespostaSonda` é `nao-mapeada` — então ele nunca casa
com `esperado` e **nunca absolve** ninguém.

## O que prende isso

`scripts/test-fecho-edges-pendentes.sh` (nos 2 locales, `bun run test:hooks` + `test:falsificacao`):

- caso **5b**: sonda sem `fonte` → ramo próprio, `exit 1`, e **nunca** a string `nenhuma sonda`;
- caso **12b**, guardrail de FORMA sobre o SQL (o stub não executa SQL): a consulta tem de admitir
  a resposta sem `fonte`, exigir o eco de `probe`, e emitir o **mesmo** sentinela que o
  classificador compara;
- 4 falsificações novas, todas exigindo vermelho nos 2 locales: ramo neutralizado · SQL voltando a
  filtrar por `? 'fonte'` cru · 2ª classe sem exigir `probe` · **deriva** entre o sentinela do SQL
  e o do classificador (a sabotagem que nenhuma das duas metades acusa sozinha).

A deriva é a que merece o nome: SQL e shell são dois arquivos-em-um, e o valor que os liga é uma
string literal repetida. Sem o par 5b+12b, trocar um dos lados deixa o ramo **inalcançável** e a
suíte **verde**.

---

## Reincidência no MESMO script, um campo atrás (2026-09-05)

O fix acima consertou o **filtro** (`? 'fonte'` descartando a linha antes de classificar). O
**casamento** continuou dependendo do eco do slug — `content->>'edge'` —, e esse campo é ainda mais
novo que o `fonte`: nasceu no **#1789**, enquanto o `fonte` nasceu no #1998. Existe bundle no ar
anterior aos dois, que responde `{ok,probe,versao}` e **nada mais**.

Medido no mesmo dia, request_ids 69377–69381, corpos lidos de `net._http_response`:

| request_id | edge | corpo | veredito ANTES |
| --- | --- | --- | --- |
| 69377 | `conciliar-pedido-portal` | `{ok,probe,versao}` | `SEM_PROVA — nenhuma sonda em 6 hours` |
| 69378 | `analyze-unified-order` | `{ok,probe,versao,edge}` | `PRE_SONDA_FONTE` ✅ |
| 69379 | `omie-nfe-recebimento` | `{ok,probe,versao}` | `SEM_PROVA — nenhuma sonda em 6 hours` |
| 69380 | `omie-nfe-webhook` | `{ok,probe,versao,edge}` | `PRE_SONDA_FONTE` ✅ |
| 69381 | `process-nfe` | `{ok,probe,versao}` | `SEM_PROVA — nenhuma sonda em 6 hours` |

Três de cinco pendências **provadas** (200 + `versao` batendo com a main) voltando a sair como
ausência de dado — o defeito deste doc, um campo atrás. Só não enganou porque quem sondou tinha os
`request_id` em mãos; o caminho normal do `/fecho` não tem.

### O que NÃO dava para fazer

Criar um ramo "200 com `probe` e `versao` mas sem `edge` ⇒ pendência" seria **presumir a
identidade**: a resposta não diz de qual edge é, e a única tabela do pg_net que guarda a URL é
`net.http_request_queue`, apagada quando a resposta chega (conferido em prod no mesmo dia — a fila
só tinha os ids ainda em voo, nenhum dos respondidos). Ausência de identidade não pode virar
identidade presumida; seria trocar um erro de leitura por um pior, com cara de prova.

### O que o fix faz — em duas metades que não se substituem

1. **`--request-ids slug=<id>`** traz o único vínculo determinístico que sobrevive, como o `ids` do
   `sonda:sql`. A 3ª classe da CTE exige o eco de `probe` (um id que aponte para resposta de CRON
   não vira prova de sonda) e **recusa linha que ecoe outro slug** — colagem trocada fabricaria
   identidade. Par malformado ou slug fora da leva é `exit 3`, nunca veredito: o typo aceito em
   silêncio deixaria a edge sem o vínculo que o operador acha que deu.
2. **Sem colagem, a saída para de alegar ausência.** A consulta conta as respostas de sonda sem eco
   de slug e a classificação diz `SONDA_ANONIMA: … N resposta(s) … nenhuma é atribuível → rode com
   --request-ids`. O veredito continua INDETERMINADO e o chip continua — **o desfecho não mudou, o
   diagnóstico parou de mentir**, que é a tese deste doc desde o começo.

Com os 5 ids colados, as 5 edges saíram `PRE_SONDA_FONTE`.

### O irmão no `sonda:sql`, mesma raiz

Para as MESMAS 5 respostas, `scripts/sonda-versao-sql.ts` emitia `DEPLOY PARCIAL — subiu
index.ts+versao.ts, mas _shared/sonda-fingerprints.ts NAO`. Um `COALESCE(fonte,'nao-mapeada')`
fundia duas causas **opostas**: campo **ausente** (bundle inteiro anterior ao #1998) e campo
**presente valendo `nao-mapeada`** (o bundle conhece o campo, o mapa que subiu não tem a edge). O
desfecho prático coincide — redeployar —, mas quem lê vai investigar um prompt de deploy que nomeou
poucos arquivos, e esse prompt não existiu. Agora são dois ramos, e o campo ausente usa o mesmo
nome do irmão passivo (`PRE_SONDA_FONTE`): dois nomes para um estado é como o operador conclui que
são dois problemas.

### O que prende isso

O SQL passou a ter CTE de vínculo, três classes em `UNION ALL`, `DISTINCT ON` e uma contagem que
viaja na mesma resposta — nada disso é legível por `grep`, e uma CTE quebrada derruba o script para
`exit 2`, que vira chip para **toda** a janela (o ruído que ele existe para cortar). Então a prova
virou execução:

- **eval novo** `.claude/skills/lovable-deploy-verify/evals/edges-pendentes-sql-eval.sh` — sobe
  Postgres efêmero e roda o SQL de verdade: **13 cenários** (inclusive vínculo apontando para
  resposta de cron, vínculo com slug contraditório, deploy no meio da janela, corpo não-JSON
  alheio) e **11 sabotagens**, amarrado ao `evals/run.sh` que o CI roda — eval fora do CI é
  falsificação que só roda à mão;
- `sonda-veredito-401-eval.sh`: +2 cenários (`fonte` ausente × `nao-mapeada`) e +2 sabotagens,
  também executando — ordem de `WHEN` e semântica de `?` sobre jsonb ficam verdes em teste textual;
- `scripts/test-fecho-edges-pendentes.sh`: +9 casos e +5 sabotagens, verde nos 2 locales.

Um achado do caminho: a trava nova de forma (`#anonimas` ausente ⇒ `exit 2`) passou a pegar
**também** o wrapper `psql-ro` mudo, e com isso a sabotagem que media a **sonda positiva** do
wrapper ficou VERDE. Cobertura redundante em prod, ausência de medição no teste — a asserção só
voltou a ter dente com um modo de stub que quebra **só** o `SELECT 1`. Trava nova pode cegar
falsificação velha: rodar `--falsificar` depois de mexer no alvo não é formalidade.
