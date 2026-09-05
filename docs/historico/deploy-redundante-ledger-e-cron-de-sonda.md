# Deploy redundante de edge — o veredito evaporava em 6h, e o founder era o sensor

> 2026-09-05. Pedido do founder: *"estamos fazendo o deploy das mesmas edges várias vezes, o código
> está pedindo para eu sondá-las todas as vezes — não sei por que devemos manter isso"*. Desfecho:
> ledger `public.deploy_atestacoes` + coletor por cron, `pendencias:deploy` julgando o par
> `(versao, fonte)` contra a main com memória, fila P1/P2, e **um cron de sonda ativa desenhado e
> derrubado pelo Codex** antes de nascer. Regra que fica: **edge precisa de deploy ⇔ `(versao, fonte)`
> servido ≠ `(versao, fonte)` da main. Nada mais é motivo.**

## 1. O que estava acontecendo (medido, não suposto)

O Lovable não dá Management API. A única prova de qual bundle está em produção é a resposta da
sonda (`{"probe":true}` → `{versao, edge, fonte}`) ou o eco passivo em toda resposta de cron. As
duas caem em `net._http_response` — e `pg_net.ttl = 6h` as apaga.

| medição (2026-09-05) | valor |
|---|---|
| edges instrumentadas | 54 |
| vistas na janela de 6h ao rodar `pendencias:deploy` | 7 (só as de cron ou as que o founder sondou às 14:25/14:34) |
| "sem sonda na janela" | 47 |
| crons de sonda em prod | 0 (de 93 jobs) |
| tabela que guardasse o veredito | nenhuma |

Três amplificadores, nenhum deles no deploy em si:

1. **A evidência evaporava em 6h e ninguém guardava o veredito.** O script exigia 50% de cobertura
   na janela e, abaixo disso, mandava "dispare a leva e rode de novo". Toda sessão que verificava
   deploy pedia ao founder para colar o SQL de sonda outra vez. Ele era o sensor de 47 edges.
2. **Fan-out de `_shared/`.** O `fonte` é o hash do fecho transitivo, `_shared/` incluso. Em 11 dias:
   24 PRs tocaram edges, 42 bumps legítimos de `versao.ts`, 66 mudanças de `fonte` → **22 pedidos de
   deploy sem a edge mudar, 18 de um único PR (#2132)**. O cabeçalho do gerador diz que o fan-out "é
   de graça porque o CI regenera" — de graça para o CI; para o founder, cada um é um prompt no
   Lovable, crédito e uma sonda.
3. **Eixo tempo com ~30 sessões.** O PR seguinte toca o mesmo fecho, "a fatia envelhece", vem outra
   rodada. E [`fatia-de-deploy-envelhece.md`](fatia-de-deploy-envelhece.md) §2.1 previa que o merge
   do #2134 mudaria o `fonte` de **7** edges. Medido no merge real (`c94c3a9c2`): mudou **1**. O mapa
   é excluído do hash de propósito, então "o mapa mudou" nunca é motivo de redeploy. Errata datada
   deixada no doc.

## 2. O que entrou

- **`public.deploy_atestacoes`** (migration `20260905183314_…`): ledger append-only, 1 linha por
  resposta observada, PK `(request_id, observado_em)`, RLS + fechada por privilégio (anon nada,
  authenticated SELECT por policy de staff; só o cron escreve). Registrada em
  `AUTHZ_TABELAS_FECHADAS`; o coletor em `AUTHZ_FUNCOES_FECHADAS`.
- **`deploy_atestacoes_janela_viva()`**: a ÚNICA definição de "observação válida" sobre
  `net._http_response` — o coletor e o leitor usam a mesma (duas cópias do filtro já divergiram em
  silêncio uma vez, #2103). Exige a FORMA de cada campo (achado do Codex): `edge`/`versao` strings,
  slug `^[a-z0-9-]{1,80}$`, `fonte` SHA-256 ou sentinela, `probe` **booleano** true. `{"edge":null}`
  passava no `?`, morreria no `NOT NULL` e derrubaria a cópia inteira por 6h. O cast para jsonb vive
  num `CASE` — filtro textual antes do cast é ordem de PLANO, não da linguagem.
- **`deploy_atestacoes_colher()` + cron `deploy-atestacoes-colher`** (15/15 min): varre a janela
  inteira e insere com `ON CONFLICT DO NOTHING` (respostas chegam fora da ordem de id; watermark
  pularia a atrasada). A migration semeia o ledger com a janela atual no próprio Run.
- **`bun run pendencias:deploy`** reescrito: lê ledger ∪ janela viva (`DISTINCT ON (edge)`, desempate
  por `request_id`), esperado = mapa commitado + `VERSAO` de cada `versao.ts`, e julga a **matriz
  do par**:

  | fonte | versao | estado |
  |---|---|---|
  | = | = | `CONFERE` |
  | = | ≠ | `INCOERENTE` (impossível num bundle coerente — `versao.ts` está no closure) |
  | ≠ | ≠ | `DIVERGE_P1` — bump declarado, deploy no PR |
  | ≠ | = | `DIVERGE_P2` se o par observado existiu junto em algum commit da main (`git log -S` no mapa, 30 ms); `INCOERENTE` se nunca existiu (deploy PARCIAL) |
  | `nao-mapeada` | — | `SEM_MAPA_NO_BUNDLE` |
  | `sem-campo` | — | `SEM_FONTE_NO_ECO` — sonde-a |
  | ausente | — | `NUNCA_ATESTADA` — a 1ª sonda, **pendência** (exit 1) |

  Mecânica (exit 2): psql falhou · ledger inexistente (diz qual migration colar) · coletor sem
  execução bem-sucedida há > 45 min (`cron.job_run_details`) · mapa ≠ fonte recalculada ·
  `versao.ts` ilegível · **qualquer linha da saída fora do formato** · zero observações.
  `FORA_DO_MAPA` só com observação < 7 dias; a histórica vai para o rodapé, sem veredito.

## 3. O que o Codex derrubou — e por quê isso é o coração da entrega

O desenho inicial tinha um cron de sonda ativa (6/6h) sobre uma allowlist de edges que já tinham
respondido `probe:true`. Parecia seguro: a sonda responde antes do `createClient` (gate estrutural
do CI). O parecer (`gpt-5.6-sol`, xhigh) marcou **[P1]**:

> `via='sonda'` histórica prova que aquela edge honrou o probe em algum momento, não que o bundle
> atual ainda honra. Rollback pelo Lovable, republicação de branch antiga, restauração de projeto,
> deploy parcial que retire o classificador, recriação manual com fonte antiga — nesse estado o cron
> continua autorizado pela linha histórica e executa o fluxo real. A própria `monthly-report`
> documenta o envio para toda a base nesse cenário.

E o corolário que fecha a porta: *sondar para descobrir se o sensor existe é executar o request que
o bundle pré-sensor lê como fluxo real* — só um mecanismo que o bundle velho **rejeite antes de
qualquer efeito** (credencial exclusiva de probe, ou a atestação por `OPTIONS` já esboçada em
[`verificabilidade-do-conjunto-orquestrado.md`](verificabilidade-do-conjunto-orquestrado.md) §2)
tornaria a automação segura, e ela exige um teste que hoje não passa: *edge respondeu sonda, sofre
rollback para bundle pré-sensor, e o contador de efeito real fica em zero*. O cron saiu. A sonda
continua humana — **uma colagem por leva de deploy, e a 1ª de edge nova** —, e o ledger faz o
veredito durar até o `fonte` da main mudar. Era isso que o founder pedia: não sondar *toda vez*, e
não "nunca sondar".

Outros achados aceitos: `NUNCA_ATESTADA` tinha de ser pendência (com piso de 50%, 27 de 54 nunca
atestadas saíam em exit 0); linha ignorada como aviso é o mesmo que não medir; `fonte` igual com
`versao` diferente virava `CONFERE`; `FORA_DO_MAPA` sobre ledger eterno fabricaria "prod serve X"
para sempre; P2 é política de fila, não veredito — continua deploy pendente, e escala após 7 dias.

Calibração (o que o Codex errou, medido): "`claude_ro` não lê tabela com RLS sem policy" — o role
tem `BYPASSRLS` em prod (`pg_roles`, 2026-09-05), e o default ACL já lhe dá SELECT.

## 4. Evidência

- `bun run test` (vitest) — 37 casos: matriz do par, escalada de P2, válvula do bootstrap, marcas do
  SQL do CLI e da migration como texto (o cão de guarda que roda no CI).
- `bash db/test-deploy-atestacoes.sh` (PG17 local) — **24/24**: janela viva = exatamente as válidas
  entre 17 fixtures (7 formas de envenenamento lado a lado), coletor idempotente, RLS/ACL por role
  (anon 42501, customer 0, staff tudo, authenticated não escreve nem executa, service_role bypassa),
  query do CLI com desempate por `request_id` em `created` idêntico, saúde do coletor, re-apply sem
  duplicar cron.
- `--falsificar` — **4/4 sabotagens vermelhas** nomeando o assert: probe tipado → texto (a string
  `"true"` entra); sem `REVOKE … FROM anon` (a postcondição aborta o apply); sem tipo de `edge` e
  sem tipo de `versao` (`12345`/`7` entram). A primeira rodada mostrou que sabotar o tipo de `edge`
  com `{"edge":null}` ficava **verde** — a regex já o barrava (camada redundante para esse caso);
  o fixture certo é o NÚMERO, que a regex aceita como texto. Sabote uma camada por vez.
- `bun scripts/pendencias-deploy.ts` contra prod antes do apply: exit 2 dizendo qual migration
  falta — o ramo do 42P01 provado ponta a ponta.

## 5. O que fica para depois (nomeado, não esquecido)

- **Sonda automática segura**: atestação por `OPTIONS` autenticado (bundle pré-sensor devolve só
  CORS) ou credencial exclusiva de probe, com o teste de rollback. Entrega própria.
- **Fan-out no CI como sinal**: o `sonda:fingerprint` imprimir, no PR, quais consumidores tiveram o
  `fonte` alterado por `_shared/` e quais bumparam — para o autor decidir P1 ali, não depois.
- **Experimento do founder**: um prompt do Lovable com N edges (mede conveniência, não prova de
  deploy — o ledger continua sendo a prova).
- Limites conhecidos: `fonte` é identidade autorrelatada da FONTE, não hash do bundle; o corpo diz
  qual edge respondeu (o gate de contrato cobre "edge que se identifica errado"); pg_net é UNLOGGED —
  coletor parado por > 6h ou restart perde a janela, e o CLI trata isso como mecânica.
