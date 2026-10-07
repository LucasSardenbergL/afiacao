# O sensor media "mudou", e a pergunta era "virou NULL"

**2026-10-06** · apply `db/2026-10-06-desconto-corrigido-para-null.sql` · edge `sync-reprocess` v1.16

## O que me pediram, e por que a premissa já não valia

O briefing dizia: os contadores `v_desc_apur`/`v_desc_corr` existem no corpo da
`reconciliar_pedidos_omie` e **não chegam** ao `metadata` do `sync_reprocess_log`. A justificativa
era boa e específica: em 2026-09-20 reportei ao founder uma regressão que não existia (o reprocesso
nulificando `desconto_valor` na oben); eram só a janela transitória entre a reescrita dos itens e a
reconciliação. Dois dias de investigação, e a hipótese só caiu 15 dias depois, pelo `updated_at`.

**O pré-flight derrubou a premissa.** As duas chaves já chegavam ao `metadata`, em produção, desde
**2026-09-20 23:15** — isto é, desde o próprio dia do falso alarme:

| Camada | Evidência |
| --- | --- |
| Função em prod | `pg_get_functiondef`: `'desconto_apurado', v_desc_apur, 'desconto_corrigido', v_desc_corr` no `jsonb_build_object` de retorno |
| Apply commitado | `db/aplicar-reconciliar-desconto-e-coerencia.sql`, com pós-condição exigindo as duas chaves |
| Edge (escritor ÚNICO) | `metadataPedidos` em `apuracao-pedidos.ts` — não era jsonb multi-writer |
| Edge servida | `pendencias:deploy` → `v1.15-zero-confirmado`, atestada |
| Dado real | 195 runs com a chave; 1ª **com** 20/09 23:15, última **sem** 20/09 21:15 |
| Sinal com denominador | 30d: `apurado=87`, `corrigido=6`, `itens_lidos` 351–413 por run |

E o estado do acervo matou a hipótese de vez: 1.106 linhas na janela, **2** com `desconto_valor`
NULL. O comentário da própria função registra 1.024 NULL em 2026-09-14 — convergiu, não corroeu.

> **A lição de processo:** "procure o ARTEFATO antes de implementar" não é só sobre colisão de
> arquivo. Aqui não havia PR concorrente nem arquivo disputado — a entrega simplesmente já existia,
> e o briefing (meu, de 15 dias antes) envelheceu sem avisar. O que pegou isso foi o pré-flight
> obrigatório na PROD, não a leitura do repo.

## O defeito que sobrou — e que era a pergunta o tempo todo

`desc_corrigido` é verdadeiro em **dois eventos distintos**:

```sql
(d.traz_desconto AND a.desconto_valor IS NOT NULL
 AND (d.desconto_valor IS NULL                               -- ← nulificação
      OR abs(a.desconto_valor - d.desconto_valor) >= 1e-6))  -- ← troca de valor
```

A declaração sempre avisou — "inclusive para NULL". Então `desconto_corrigido = 6` **não diz se
alguma das 6 foi nulificação**. O sensor respondia "mudou?", e a pergunta que custou os dois dias
era "virou NULL?". Levar os contadores ao log, sozinho, nunca teria resolvido o caso que motivou
levá-los.

## SUBCONJUNTO, não partição

`desconto_corrigido` fica **idêntico** (os dois ramos) e nasce `desconto_corrigido_para_null` com só
o ramo do NULL. Reparticionar seria mais limpo semanticamente e **errado na prática**: as 195 runs
já logadas dizem "ambos", e as novas diriam "só troca" — série histórica que muda de significado sem
mudar de nome. O NOME carrega a contenção: `corrigido_para_null` ⊆ `corrigido`, e quem somar as duas
conta a nulificação duas vezes.

A contenção é **estrutural**, não asserida: o predicado novo é o primeiro disjunto do antigo, com o
mesmo `traz_desconto`. Tirar o `traz_desconto` quebraria a contenção — e a falsificação FJ2 prova
isso ficando `para_null=1` com `corrigido=0`.

## A fronteira que o contador NÃO conta, de propósito

Payload **sem** a chave (edge anterior) também grava NULL por cima de um valor conhecido — é a
invalidação legada, `traz_desconto = false`. Ela **não** entra no contador. Duas razões, nessa
ordem: (1) incluí-la quebraria a contenção, porque `desconto_corrigido` também exige
`traz_desconto`; (2) toda run da edge velha pareceria nulificação em massa — exatamente o falso
alarme que esta entrega existe para evitar. O contador mede nulificação **com a chave na mão**. A
fronteira está testada (J4), não é acidente.

## As quatro combinações (RPC × edge), e a única perigosa

| RPC | Edge | Resultado |
| --- | --- | --- |
| nova | nova | número correto |
| nova | velha | chave ignorada → **ausente** no metadata |
| **velha** | **nova** | chave não vem → **tem de virar `null`**; gravar 0 afirmaria "zero nulificações" sobre o que ninguém mediu |
| velha | velha | ausente |

Só a terceira produz número **errado** em vez de ausente — daí o `null` grudento, o mesmo contrato
das duas chaves irmãs. E ela é **legível no próprio log**: `desconto_corrigido` presente com
`desconto_corrigido_para_null` ausente é a assinatura de "RPC velha com edge nova".

Por isso a ORDEM desta entrega foi SQL primeiro: RPC nova + edge velha é a combinação inócua.

## Prova

`db/test-desconto-valor-escritores.sh` (PG17, **executando** — plpgsql é late-bound): **123 ok / 0
fail**. O par que importa:

- **J1** nulificação → `corrections/corrigido/para_null/apurado` = `1/1/1/0`
- **J2** troca de valor → `1/1/0/0`

Antes desta entrega os dois davam o mesmo número. J4 fixa a fronteira (`NULO|1/0/0/0`), J5 prova
idempotência, e a pós-condição (b) do apply **executa** a função com payload vazio — `CREATE` passar
não prova nada em plpgsql.

Falsificação com **controle verde na mesma invocação** (J1/J2/J4 acima, com o apply verdadeiro):

- **FJ1** inverte o predicado → J2 vira `1/1/1/0` (troca de valor contaria como nulificação)
- **FJ2** remove `traz_desconto` → J4 vira `1/0/1/0` (a contenção quebra)

## Os dois portões meta que me pegaram — os dois com razão

Sem o Codex, quem fez o papel de cético foram dois gates do CI. Vale registrar porque **um deles
achou defeito de verdade na MINHA prova**, não falso positivo:

1. **`assert-verde-por-ausencia`** — a pós-condição (b) do apply usava `<> '0'` sobre chaves do jsonb
   de retorno. Em PL/pgSQL `IF NULL <> '0'` **não dispara**: se uma das chaves sumisse, o assert
   passaria verde sem medir nada. Eu havia guardado só `desconto_corrigido_para_null` com um
   `IS NULL` explícito — `desconto_corrigido` e `desconto_apurado`, no mesmo `OR`, ficavam
   desprotegidos. Conserto no idioma canônico do repo: `IS DISTINCT FROM` nos 10 sítios.
   **A lição:** eu estava escrevendo uma pós-condição para provar um sensor de "ausente ≠ zero" e
   cometi "ausente ≠ zero" na própria pós-condição. O gate viu o que eu não vi.

2. **`limpeza-fonte`** — `versao.ts` estava **exatamente** no piso (9/90 = 0,1), então qualquer linha
   de comentário o afundava. Afrouxar o piso enfraqueceria a sentinela para todo o repo; a saída foi
   a do CLAUDE.md — prosa vai para `docs/historico/`, e o marcador de versão fica com 2 linhas e um
   ponteiro. Não é falso positivo: é um arquivo no teto avisando que a prosa tem outro lugar.

## O furo de método que o CI pegou: revalidação SELETIVA

Depois de consertar os dois portões acima, eu reexecutei **só os dois que haviam falhado** — e um
deles me fez editar `versao.ts`, isto é, a FONTE de uma edge. O `sonda:fingerprint` já havia passado
antes dessa edição, então saiu da minha lista mental; o mapa commitado ficou sendo o de antes. O CI
reprovou com a mensagem exata: *"sync-reprocess: fonte mudou e o mapa não"*.

**A regra que faltava, e que vale sempre:** mexer na fonte de uma edge invalida o LOTE de sondas,
não só a que falhou antes. "Já passou" é um fato sobre a árvore de ANTES da edição.

E o furo irmão, do mesmo turno: declarei "6 portões de edge verdes" contando pela tabela do
CLAUDE.md, quando o job `edges-e-build` do `ci.yml` tem **13 passos**. A tabela é um resumo; o
autoritativo é o workflow. Dos 13, eu nunca havia rodado `test:sonda-rollback`,
`sonda:cron-prova --gate`, `sonda:nova`, `sonda:autentica`, `canaria:bump` e `build` — todos verdes
quando finalmente rodaram, mas eram seis passos sobre os quais eu havia afirmado verificação sem ter
medido. Evidência positiva é do comando autoritativo, e aqui ele era o `.github/workflows/ci.yml`.

## O apply que travou sem escrever nada

A reaplicação (bytes corrigidos) pendurou 18 minutos sem progresso. Diagnóstico antes de reflexo:
`pg_stat_activity` não mostrava **nenhuma** sessão ativa em prod, e o ledger não tinha a tentativa —
ou seja, travou na sonda de preflight, **antes** de escrever. Sem estado parcial e sem cicatriz, o
que tornou seguro matar o processo (conexão morta no pooler; `psql` bloqueado num read que nunca
voltaria). A regra do envelope — *nunca reaplicar resultado DESCONHECIDO* — vale porque o
desconhecido é o caso em que a tentativa JÁ está gravada; aqui o ledger provou que não estava.

⚠️ E o `APPLY_EXIT` do wrapper veio **143** (meu SIGTERM), mas o harness anunciou "exited with
code 0": o compound depois do `kill` fabricou o veredito. O ledger, não o exit, foi a autoridade.

## O desfecho: a janela fechou antes do challenge

A cota do Codex foi medida **duas vezes na mesma janela de 7 dias**, e a trajetória é o dado, não
cada ponta: **92,0%** quando o PR nasceu DRAFT (exit 79 do preflight, sem gastar a chamada) e
**100,0%** poucas horas depois, com a janela reabrindo só em 09/10 19:30. Não houve contradição
entre as leituras — houve consumo entre elas. A consequência operacional é mais forte do que
"a cota estava alta": **esperar não era caminho**, porque a janela esgotou dentro do próprio dia da
entrega. O founder tirou do draft por decisão própria, com o Caminho B registrado.

Então registre sem rodeio: as três decisões — subconjunto vs. partição, `traz_desconto` dentro do
predicado novo, as quatro combinações RPC × edge — **entraram em produção sem segunda opinião**.
A falsificação cobre cada uma, e é o substituto disponível, não um equivalente. Um challenge
retroativo depois de 09/10 é melhoria, e deve nascer como PR próprio: a branch da entrega tinha um
escritor só, e commit de prosa em branch com auto-merge em voo só reinicia o CI.

## O marcador de versão de edge é recurso DISPUTADO

Duas sessões reivindicaram **v1.16** para a mesma edge no mesmo dia: a `main` levou
`v1.16-catalogo-sem-estoque` (#2824) e esta entrega chegou com `v1.16-nulificacao-separada`. O
conflito não apareceu em nenhum gate — apareceu no **merge**, porque `sonda:bump` compara o bump com
a BASE, e nada compara dois PRs irmãos em voo entre si. Resolução: **`v1.17-nulificacao-e-catalogo`**,
as duas entregas no MESMO bundle, logo um deploy serve as duas.

A lição operacional é a que o CLAUDE.md já pede para arquivo quente, e vale citar o marcador por
nome: antes de bumpar `versao.ts`, `git fetch && git show origin/main:<edge>/versao.ts` — e de novo
imediatamente antes de entregar. Um número de versão não é propriedade de quem o escreveu primeiro
localmente; é de quem mergeou primeiro.

## O denominador não mente por acidente — a premissa dele envelheceu

Montando o prompt de deploy do founder, as edges do diff do #2824 e as do relatório não fecharam:
o #2824 removeu `quantidade_estoque || 0` de **cinco** edges e o `bun run pendencias:deploy` acusou
**quatro**. A quinta, `tint-omie-sync`, não aparecia em seção nenhuma — nem pendente, nem confere.
Ela não tem `versao.ts`.

O enquadramento fácil — "verde por ausência acidental" — está **errado**, e vale registrar porque foi
o meu primeiro. `scripts/sonda-edge-nova-gate.ts` (linhas 24-56) mostra que a omissão é **escopo
DECLARADO**: edge NOVA precisa de `versao.ts`+fingerprint **ou** de entrada em `DISPENSAS` com motivo
tipado e `porque` assinado, e as pré-existentes ficaram fora **de propósito** na terceira leva
(#1767). O arquivo até se defende do conserto preguiçoso: retro-preencher `DISPENSAS` "seria inventar
assinatura de decisão que ninguém tomou". Um gate que reprovasse as 35 quebraria a `main` por
condição pré-existente — e é o tipo de gate que alguém afrouxa no primeiro atrito.

O defeito real é mais estreito e pior: **a premissa que sustenta o grandfathering é contrariada pela
medição que o próprio arquivo carrega.** A vovó-cláusula se justifica com "a maioria é leitura pura",
e a linha 48, seis linhas abaixo, já registrava 31 de 56 escrevendo em 2026-08-28. Medição de hoje na
`origin/main`, reproduzida por dois detectores independentes (o do gate e um grep cru de
`.insert|.update|.upsert|.delete` e `.rpc(`):

```
97 pastas de edge (fora _shared) · 62 com versao.ts · 35 sem
das 35:  16 ESCREVEM por PostgREST · 4 só .rpc() (opaco) · 15 nenhum
```

**15 de 35 (43%)** são leitura pura: a "maioria" da justificativa não existe mais. E o relatório fecha
"cobertura: 62/62 edges mapeadas", um denominador que conta só as instrumentadas — a leitura honesta
é **62/97**, 64%. A `tint-omie-sync` é a prova viva: money-path do tintométrico, corpo alterado por
uma correção de dinheiro, e nenhuma máquina pediu o deploy. Sem ele, ela segue gravando `estoque = 0`,
que é exatamente o defeito que o #2824 foi corrigir.

O conserto não é máquina nova, é denominador honesto: imprimir "62/97 instrumentadas · 35 fora do
alcance (16 escrevem, 4 opacas)" em vez de "62/62 mapeadas". Instrumentar as 16 escritoras é leva
separada, com deploy por edge, porque marcador novo só vale depois de servido. Chip aberto com #2824
como incidente citável.

## A deriva que o apply programático CRIA — e que precisa ficar declarada

O envelope desta entrega (`db/2026-10-06-desconto-corrigido-para-null.sql`) faz substituição
**programática**: lê `pg_get_functiondef` do corpo vivo, exige 7 âncoras uma vez cada, `EXECUTE`.
Isso é o certo — corpo copiado diverge do repo e a última a recriar vence. Mas tem consequência
que precisa ser dita: **o corpo em prod deixa de ser derivável do repo sozinho.**

E o repo tem um sensor para exatamente isso. Horas depois do apply, `bun run deriva:corpo:prod`
virou vermelho (estava verde na véspera):

```
❌ [SEM_PAR] reconciliar_pedidos_omie(jsonb,text[],timestamp with time zone):
   corpo que nenhuma das 5 versões commitadas explica
   — último CREATE: 20260914180104_reconciliar_carrega_desconto_e_isola_coerencia.sql
```

Não é defeito do apply: é a **assinatura** dele. O `db/audit-deriva-corpo-prod.ts` lê apenas as
migrations de `supabase/migrations/` da `origin/main` e é estruturalmente cego a applies por
envelope de `db/`. O perigo real não é o vermelho — é que **o próximo `CREATE OR REPLACE` desta
função a partir do repo apaga a nulificação em silêncio**, e nada no repo avisa quem for fazê-lo.

A saída é a declarada: entrada na baseline `db/deriva-corpo-baseline.json`, que é onde o repo guarda
"o que alguém olhou e aceitou", com o `motivo` nomeando o envelope e mandando pré-flight de
`pg_get_functiondef` da PROD antes de qualquer replace. A classe `PATCH` **não** serve: ela concilia
por `patchesDepois`, que só enxerga patches em `supabase/migrations/`. A classe é `EDICAO_MANUAL`,
com `md5`/`md5Tokens` do corpo de prod — e a entrada é assinada pelo founder, não pelo agente.

Na mesma rodada apareceu um segundo achado, de outra entrega e por via independente:
`_data_health_compute` roda em prod o corpo de `20261005150000` enquanto o repo commitou
`20261005220100` depois, e `sales_orders_instante_envio` (migration `20261005220000`) **não existe**
em prod. Duas migrations da leva de 05/10 mergeadas e não aplicadas — a armadilha nº 1 na forma
silenciosa, agora com dois sensores apontando para ela.

## Resíduo

A pergunta "o reprocesso está nulificando?" virou **query**:

```sql
SELECT created_at, account,
       metadata->>'desconto_corrigido'           AS corrigido,
       metadata->>'desconto_corrigido_para_null' AS virou_null
  FROM public.sync_reprocess_log
 WHERE entity_type = 'orders'
 ORDER BY created_at DESC LIMIT 20;
```

`virou_null` ausente = a RPC no ar ainda não separa (ou a edge é anterior à v1.17). `virou_null` 0
com `corrigido` > 0 = houve correção e **nenhuma** foi perda do dado — que é a resposta que levou
dois dias para ser dada à mão.

## O primeiro tick com as duas pontas no ar — e o par que prova

Deploy da edge colado no Lovable em 06/10 à noite; o `sync-reprocess-operational` (`15 */2 * * *`)
rodou às 02:15Z. O par é que fala, não cada metade:

```
07 02:15 | ups=0 | apurado=0 | corrigido=0 | virou_null=number=0      ← edge v1.17 + RPC nova
07 00:16 | ups=0 | apurado=0 | corrigido=0 | virou_null=CHAVE_AUSENTE
06 22:15 | ups=0 | apurado=0 | corrigido=0 | virou_null=CHAVE_AUSENTE
06 20:15 | ups=5 | apurado=0 | corrigido=0 | virou_null=CHAVE_AUSENTE
```

A chave **existir** é a prova da ponta nova: nas três runs anteriores ela não estava no objeto, e na
de 02:15 está, valendo `0`. E a resposta substantiva à pergunta que custou dois dias de forense em
20/09 é a linha inteira: `corrigido=0` e `virou_null=0` ⇒ **nenhuma correção nesta janela, logo
nenhuma nulificação.** Antes, essa frase exigia um humano reconstruindo payload à mão.

## A armadilha que me pegou lendo o próprio sensor: `->>` não distingue ausente de null

O vigia que armei para esperar o tick reportou `virou_null=<AUSENTE>` **na mesma run** que a consulta
seguinte mostrou como `number=0`. Dois defeitos somados, e os dois valem registro porque são o
espelho da lição que esta entrega inteira persegue:

1. **`metadata->>'chave'` devolve SQL NULL tanto para chave AUSENTE quanto para chave presente com
   valor JSON `null`.** Envolver em `coalesce(..., '<AUSENTE>')` FABRICA o veredito "ausente" para um
   valor que está lá. A leitura correta usa `metadata ? 'chave'` para existência e
   `jsonb_typeof(metadata->'chave')` para o tipo — nunca `->>` sozinho quando a pergunta É sobre
   ausência. Esta entrega nasceu de "ausente ≠ zero" e quase morreu de "presente-com-null lido como
   ausente".
2. **A linha do log tem CICLO DE VIDA.** `duration_ms=12199` na run de 02:15, e a mesma linha
   (`created_at 02:15:04.611521`) devolveu conteúdos diferentes em duas leituras: ela é inserida com
   metadata parcial e atualizada no fecho. Um vigia que consulta por `created_at >` pega a linha no
   NASCIMENTO e lê metadata que ainda não existe. Quem espera resultado de run deve exigir
   `status='complete'` no predicado, não a existência da linha.
