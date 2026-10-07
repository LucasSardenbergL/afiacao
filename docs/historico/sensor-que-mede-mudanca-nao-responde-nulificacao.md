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

## Caminho B — o Codex não foi consultado

`scripts/codex-async.sh` saiu **79** no preflight: cota em **92,0%** (teto 85%), janela de 7 dias
reabrindo em 09/10 19:30. Não gastou a chamada. Cota alta não é gatilho de pular, é gatilho de
**DRAFT** — e foi assim que o PR nasceu. As decisões que teriam ido ao challenge (subconjunto vs.
partição; `traz_desconto` dentro do predicado; as quatro combinações) estão argumentadas acima e
cobertas por falsificação, que é o substituto disponível, não um equivalente.

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

`virou_null` ausente = a RPC no ar ainda não separa (ou a edge é anterior à v1.16). `virou_null` 0
com `corrigido` > 0 = houve correção e **nenhuma** foi perda do dado — que é a resposta que levou
dois dias para ser dada à mão.
