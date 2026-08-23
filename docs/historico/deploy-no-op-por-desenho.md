# Deploy no-op por DESENHO — a mudança que nenhuma canária consegue provar

> **A classe (2026-08-23):** um PR cujo ganho é *proteção contra mudança futura* não altera
> comportamento nenhum hoje — por desenho, não por acaso. Bundle novo e bundle velho produzem
> **bytes idênticos** sobre os dados de produção. Logo **nenhuma canária de comportamento pode
> discriminar o deploy**, e a verificação inteira do ritual (`lovable-deploy-verify`, N3) fica sem
> chão. Sobra o **marcador de versão** — e ele só prova alguma coisa se for **bumpado ANTES** do
> deploy. Se o marcador na `main` for igual ao de produção, a sonda responde a mesma string tendo
> o deploy acontecido ou não: verificação que **mente verde**.
>
> A regra: **mudança no-op por desenho prova-se só por marcador, e o bump é PRÉ-REQUISITO do
> deploy, não consequência dele.** Antes de pedir o deploy, compare o marcador da `main` com o de
> produção — iguais, a viagem é inverificável.

## O caso

O **#1889** mudou `supabase/functions/_shared/paginate.ts`: `fetchAll`/`fetchAllKeyset` deixaram de
tratar página **CURTA** como fim de tabela (o EOF passou a ser página **VAZIA**) e o offset passou
a avançar pelas linhas **REAIS** devolvidas (`from += rows.length`, não `from += PAGE`). Isso
desacopla os helpers do `max-rows` do PostgREST.

O ganho é real, mas **futuro**: o `max-rows` de prod é 1000, exatamente igual ao `PAGE` do helper.
O laço antigo funcionava — por **coincidência numérica** que nada vigiava. Se o cap baixasse para
500, a 1ª página viria com 500 linhas, `500 < 1000` seria lido como "acabou", e toda leitura
truncaria em silêncio.

Pedido: deployar nas 3 edges money-path que leem tabelas grandes (`recommend`,
`omie-analytics-sync`, `fin-cashflow-engine`), **com verificação** — porque no dia anterior um
deploy da `recommend` foi reportado como feito e **não tinha subido**.

## O diagnóstico, que veio ANTES do deploy

Ao montar a verificação, o problema apareceu antes de qualquer prompt ser entregue: **nenhuma das
três tinha como provar o próprio deploy.**

| edge | marcador na `main` | em produção | discrimina? |
|---|---|---|---|
| `recommend` | `v1.4-sonda-antes-do-gate` | `v1.4-sonda-antes-do-gate` | ❌ mesma string dos dois lados |
| `fin-cashflow-engine` | `v1.0-sensor-inicial` | idem | ❌ |
| `omie-analytics-sync` | *sem `versao.ts`* | — | ❌ sem prova nenhuma |

A `omie-analytics-sync` era o caso mais sutil: ela **tinha** canária (`doc_ambiguo_probe`), mas
**NÃO-VERSIONADA**. Ela responde `probe_no_ar:true` igual num bundle de hoje e num de três fatias
atrás — é literalmente a ⚠️ #2 de `docs/agent/deploy.md` ("deploy integralmente velho carrega o
`expected` VELHO junto e compara velho×velho → responde `ok:true` e mente verde"), que já
classificava versionar essas canárias como **dívida aberta**.

## Por que este caso NÃO é o `#1397` (a armadilha irmã, e a diferença que importa)

O `deploy.md` já avisava: *"canária que não discrimina é teatro verde"*. Mas o caso de lá é
**no-op por acaso dos dados** — o #1397 mudou o tratamento de conflitos e prod tinha **zero
conflitos**, então a resposta do fluxo real saía byte-idêntica. A correção de lá é **achar uma
fixture que exercite o comportamento que mudou**.

Aqui isso **não existe**. O #1889 foi feito para não mudar comportamento nenhum enquanto o cap for
1000. Procurar fixture melhor é procurar o que o PR garante não haver. A conclusão operacional é
outra, e é o que este documento acrescenta:

- no-op **por acaso dos dados** → conserta-se com **fixture melhor** (canária de comportamento);
- no-op **por desenho** → só o **marcador** prova, e ele tem de ser **bumpado antes**.

Corolário incômodo: a mesma propriedade que torna o #1889 seguro de deployar (não muda nada hoje)
é a que o torna **impossível de verificar** pelos meios normais. Segurança e verificabilidade
apontam para lados opostos aqui.

## O que foi feito (#1905)

1. **`fin-cashflow-engine`**: bump `v1.0-sensor-inicial` → `v1.1-paginacao-eof-vazio`.
2. **`omie-analytics-sync`**: sonda instalada (`versao.ts` no padrão `_shared/sonda-versao.ts`),
   após o `authorizeCronOrStaff` (que já aceita `x-cron-secret`, logo sem gate próprio) e **antes
   do `createClient`**, como o gate estrutural da terceira leva exige.
3. **`recommend`**: resolvida **de graça** — o #1898, de outra sessão, bumpou para
   `v1.5-denominador-observados` e já carregava o #1889. Esperar 20 minutos por ele economizou um
   deploy manual e transformou a viagem em prova.

Registradas em `_shared/sonda-versao-contrato_test.ts` (`EDGES` + `ESCRITA_NOSSO_BANCO`).

### A propriedade que tornou a sonda da `omie-analytics-sync` barata

A edge roteia por `action`, então um corpo sem `action` conhecida cai no `default` com
`400 "Ação desconhecida"` — **sem tocar Omie nem banco**. Sondar um bundle pré-sensor ali é
inócuo, e o veredito fica binário:

```
{ok,probe:true,versao}   → bundle COM sensor
400 "Ação desconhecida"  → bundle PRÉ-sensor, o deploy não subiu
```

Contraste com a `fin-cashflow-engine`, onde mesmo o caminho read-only paga a projeção de 13
semanas inteira antes de responder. **Ao instrumentar, verifique qual é o custo do bundle VELHO
ignorando o parâmetro** — é ele que define se sondar às cegas é seguro.

## A falsificação (verde sozinho não provava cobertura da edge NOVA)

O gate de contrato passou em 23/23 assim que a edge foi registrada — e isso não valia nada: ele
já passava antes, pelas 17 edges antigas. Três sabotagens, cada uma exigindo vermelho **que nomeia
a edge**:

| sabotagem | exit | vermelho |
|---|---|---|
| apagar a linha que RESPONDE a sonda | 1 | `omie-analytics-sync: classifica a sonda mas nunca chama respostaSonda` |
| mover a sonda para depois do `createClient` | 1 | `omie-analytics-sync: a sonda desceu para depois do createClient` |
| quebrar o formato do marcador bumpado | 1 | `fin-cashflow-engine: VERSAO fora do formato` |

## O desfecho (evidência positiva, lida no banco)

As três sondas, lidas em `net._http_response` via `psql-ro` — **não** pelo relato "deployei":

| id | edge | versão respondida |
|---|---|---|
| 58577 | `recommend` | `v1.5-denominador-observados` |
| 58580 | `omie-analytics-sync` | `v1.0-sensor-inicial` |
| 58586 | `fin-cashflow-engine` | `v1.1-paginacao-eof-vazio` |

A terceira é a prova mais limpa: `v1.1-paginacao-eof-vazio` **não existia em lugar nenhum** até o
#1905 daquela manhã. Nenhum bundle anterior pode responder essa string.

Guard pós-deploy: `paginate.ts` intacto na `main` com #1889 e #1901, e nenhum commit de reversão
do bot do Lovable.

## Lições

1. **Mudança no-op por desenho prova-se só por marcador — e o bump é pré-requisito do deploy.**
   Comparar o marcador da `main` com o de prod é parte do **pré-flight**, não da verificação.
2. **Canária não-versionada é meia-canária.** Ela prova que a função responde, não que o bundle é
   o novo. Enquanto houver `contrato = —` na tabela do `deploy.md`, a dívida está aberta.
3. **PR concorrente pode ser aliado.** O #1898 (`recommend`) e o #1901 (bug ATIVO de duplicata
   silenciosa no mesmo `paginate.ts`) estavam com auto-merge armado. Deployar antes deles teria
   custado 3 viagens manuais desperdiçadas e publicado um helper com bug conhecido. **Antes de
   pedir deploy de edge, cheque `gh pr list` pelo arquivo — não pelo título.**
4. **Ao instrumentar, meça o custo do bundle VELHO ignorando o parâmetro.** É ele que decide se
   sondar às cegas é inócuo (`400` da `omie-analytics-sync`) ou caro (a projeção de 13 semanas).
