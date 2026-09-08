# Quanto do que é entregue chega a ser usado — medido, com denominador

> Medição de **2026-09-07**, a pedido do founder, para instruir (não tomar) a decisão sobre limitar
> trabalho simultâneo. Provocada por um parecer do Codex (gpt-6-astra) que citava duas medições
> datadas de 2026-09-05: "41 branches sem PR" e "cinco usuários ativos frente a 173 páginas".
> **As duas foram re-medidas aqui — e a segunda estava certa no número e errada na leitura.**
>
> ⚠️ Toda contagem deste doc é perecível. Os comandos de re-medição estão no fim.

## O que mudou a pergunta: o denominador

A pergunta era "quanto do entregue é usado?". A primeira medição do denominador reformulou tudo:

| Fato (psql-ro, `rolbypassrls=t` — RLS **não** cega estas leituras) | Valor |
|---|---|
| `profiles` cadastrados | **5.668** |
| …com `is_approved = true` | **4** (3 funcionários + 1 sem role) |
| …com `is_approved = false` | **5.664** — e **0 NULL** (o `false` é explícito, não default esquecido) |
| `user_roles`: customer / employee / master | 5.664 / 2 / 1 |
| Customers aprovados | **0** |

**Nenhum cliente pode entrar no app.** Os 5.664 customers são cadastros espelhados do ERP, não
usuários habilitados — `is_approved` é o gate (`CLAUDE.md` §Auth: "customers precisam de
`is_approved`; staff é auto-aprovado"). A população elegível do sistema é **4 pessoas**.

Isso não corrige o número do Codex ("cinco usuários ativos"), corrige o **significado** dele: não é
uma taxa de adoção baixa contra 5.668 possíveis. É a população inteira. "173 páginas para 5
usuários" descreve um app cuja base elegível nunca foi aberta — o que é uma decisão de produto
plausível (piloto interno antes de abrir), não um sintoma de excesso de entrega.

## Uso medido — dois canais independentes, e por que precisam ser dois

### Canal 1: PostHog (censurado — piso, nunca teto)

`docs/agent/analytics.md` exige o breakdown por aparelho **antes** de qualquer série, porque
`us.i.posthog.com` está em listas de bloqueio e o Chrome do founder está comprovadamente
bloqueado (#1984). Re-medido em 30 dias:

| `$os` / `$browser` | aparelhos | eventos | último |
|---|---|---|---|
| iOS / Mobile Safari | 1 | **735** | 2026-09-05 |
| Windows / Chrome | 2 | 16 | 2026-08-18 |
| Mac OS X / Chrome | 1 | 1 | 2026-08-25 |

**Um único iPhone = 97,7% dos eventos web** (735 de 752) — o mesmo 97,7% medido em 2026-08-25.
O padrão não mudou em duas semanas.

`$pageview` em 30 dias: **79 pageviews · 8 rotas distintas · 2 pessoas · 2 aparelhos.**
E o uso concentra num único domínio: **75 dos 79 pageviews são `/admin/reposicao/*`**.

### Canal 2: o banco (imune ao bloqueador)

Este é o par obrigatório: a escrita sai pelo domínio do app e nenhuma extensão a bloqueia.
Levantei as **57 tabelas** de `public` que têm coluna de autor humano (`user_id`, `created_by`,
`criado_por`, `usuario_id`) **e** coluna de tempo, e contei linhas totais e em 30 dias:

| Categoria | Tabelas |
|---|---|
| **Vazias desde sempre** | **35** de 57 (61%) |
| Com dado histórico, **zero em 30 dias** | 18 |
| Com linhas nos últimos 30 dias | **4** |

⚠️ **`orders` está entre as 35 vazias — e ler isso como "o app não tem pedido" seria erro.** Os
pedidos vivem em `sales_orders` (**31.248** linhas, 507 nos últimos 30 dias) e `order_items`
(70.860), populados pelo **sync do Omie**. `orders` é a tabela do pedido nativo do app, que nunca
recebeu um registro. A mesma armadilha já custou uma medição em
[a-forma-que-some-e-a-forma-que-mente.md](a-forma-que-some-e-a-forma-que-mente.md), onde a leitura
"quase inverteu" pelo mesmo motivo. A distinção que ela força é o eixo certo deste doc inteiro:
**dado espelhado do ERP** (farto) × **dado originado no app** (quase nulo).

E as 4 com movimento **não são ação humana**: `sales_orders` (507 — sync do Omie),
`analytics_outbox` (301 — telemetria), `telemetria_probes` (186 — sonda de cron),
`sku_preco_captura_run` (1 — captura automática).

O único eixo de ação humana explícita é `acoes_execucoes` (o registro do `useMutationComRegistro`):

| Origem | execuções 30d | humanos distintos |
|---|---|---|
| `automatica` (cron) | **3.660** | 0 |
| `manual` | **25** | **1** |

Em **90 dias**: 53 execuções manuais, **1 único humano**, de 2026-07-20 a 2026-09-07.

**Os dois canais concordam** — e é isso que dá confiança. O silêncio do PostHog poderia ser
censura; o silêncio do banco não pode. Duas fontes com modos de falha diferentes apontando ao
mesmo lugar é evidência, não coincidência.

### O que NÃO foi medido — e por que isso importa mais que o resto

**Uso somente-leitura é invisível nos dois canais.** Um aparelho com bloqueador que abre dez telas
e não salva nada não deixa rastro no PostHog (censurado) nem nas tabelas de escrita. Isso não é
detalhe: é a categoria mais provável de uso real deste app, que é majoritariamente **visor de dado
do ERP**.

Busquei um terceiro eixo para isso: `pg_stat_user_tables` conta scans, e scan não passa por RLS
nem por bloqueador. Das 14 tabelas de superfície do app que testei (incluindo as vazias),
**nenhuma tem zero scans** numa janela de ~68 dias (`pg_postmaster_start_time` = 2026-07-02;
`stats_reset` é NULL, então a janela é ≥ isso e de duração exata desconhecida).

**Conclusão do terceiro eixo: as telas SÃO abertas; nada é escrito nelas.** Isso derruba a leitura
fácil de "163 páginas mortas" e a substitui por uma mais precisa e menos confortável: *as telas são
consultadas, e o sistema quase não é usado como sistema de registro*. O scan não distingue humano
de cron, então ele **refuta** "tabela morta" sem **provar** "humano leu" — é o limite honesto do
que este eixo entrega.

## A taxonomia que impede o veredito fabricado

O pedido era explícito: não misturar "não usada" com "não medida". A separação real tem **quatro**
categorias, não duas:

| Categoria | Quantas | Como sei |
|---|---|---|
| **Medida e usada** | **8 rotas** de 164 (4,9%) | ≥1 `$pageview` em 30d |
| **Medida e sem uso no canal** | **156 rotas** | têm sensor (o `PageViewTracker` monta no `AppShell` e emite `$pageview` em **toda** rota — cobertura de pageview é ~100% **por construção**), mas o canal que as emitiria está censurado em todos os aparelhos menos 2 |
| **Não medível por escrita** | 35 tabelas vazias | a superfície existe, nunca recebeu um registro |
| **Usada de forma invisível** | desconhecido | leitura em aparelho censurado — sem sensor que a alcance |

Denominador das rotas: o `App.tsx` declara **180** `path=`, dos quais **164** apontam para um
arquivo de página e 16 são redirects (`Navigate`). Arquivos de página reais: **172** (fora de
`__tests__`).

A linha 2 é a que não pode virar "não usada". Não há sensor faltando nessas páginas — há **canal
faltando**. A correção não é instrumentar mais; é o proxy first-party que foi **recusado** em
2026-08-25 (#1984), cujo gatilho de reabertura este doc acaba de puxar: hoje a censura não degrada
uma métrica secundária, ela impede responder a pergunta central do founder.

## Quantas entregas têm sensor de uso — o cumprimento real da regra

A regra de `fase-sem-sinal.md` diz que superfície nova **nasce com o sensor**. Medido no HEAD
`84a115a43` sobre **172** arquivos de página (fora de `__tests__`):

| Medida | Valor |
|---|---|
| Páginas com `track(` **direto** | **11 / 172 = 6,4%** |
| Rotas cujo destino tem `track(` | 11 / 180 = 6,1% |
| Páginas sem `track(` direto, mas que importam um módulo que chama `track(` (indireto, 1 nível) | 19 |
| **Páginas sem sensor de domínio algum a ≤1 nível** | **142** |
| Páginas auxiliares / index / re-export (que inflariam o denominador) | **0** — as 161 sem `track` são telas de verdade |

**A tendência é o número que importa,** porque mede se a regra pegou:

| Janela de criação | Criadas | Com `track(` ao nascer | % |
|---|---|---|---|
| Últimos 60 dias | 3 | 1 | **33,3%** |
| Últimos 90 dias | 18 | 6 | **33,3%** |
| Antes disso | 154 | 5 | **3,2%** |

Por mês de criação (criadas / com sensor): fev 49/1 · mar 23/0 · abr 26/1 · **mai 44/3** ·
jun 13/3 · jul 11/3. **A regra pegou** — a taxa saiu de 3,2% e estabilizou em ~33%, um salto de
10×. E ainda assim: **2 em cada 3 páginas novas nascem sem sensor de domínio.**

⚠️ **Duas ressalvas que impedem ler esta tabela como vitória ou como derrota:**
- **n=3 em 60 dias.** Nenhuma página nasceu em agosto ou setembro — o que é coerente com as 0 telas
  novas em 30 dias medidas acima. A janela de 90 dias (n=18) é a única com amostra utilizável, e
  dá o mesmo 33,3%.
- **6,4% não é a cobertura de medição da tela**, é a de **sensor de desfecho**. O `$pageview`
  cobre ~100% por construção. As duas respondem perguntas diferentes: "a tela foi aberta?"
  (pageview, universal) e "a tela cumpriu seu propósito?" (`track`, 6,4%). É a segunda que a regra
  cobra, e é a segunda que falta.

## A fila de entrega, re-medida

| Sinal | 2026-09-05 (#2323) | **2026-09-07 (agora)** |
|---|---|---|
| Branches com commit e **sem PR** | 41 | **34** |
| …paradas ≥7 dias | 25 | **23** |
| …paradas ≥30 dias | — | **13** |
| Mais velha | 92 dias | **93 dias** |
| Commits represados | — | **128** |
| PRs abertos | 5 | **1** |
| PRs mergeados em 30 dias | 601 | **625** |

A fila caiu de 41 para 34 em dois dias, e os PRs abertos de 5 para 1 — **a drenagem funciona**.
Mas a idade não se moveu: a mais velha envelheceu exatamente 1 dia em 2 dias. Ou seja, o que drenou
foi o topo da pilha, não o fundo.

⚠️ **A Lei de Little do #2323 não se aplica a estas 34.** Aquele doc calculou WIP 41 ÷ 4 PRs/dia =
lead time 10 dias. A vazão real hoje é ~**21 PRs/dia** (625/30) — se as 34 estivessem em fluxo, o
lead time seria 1,6 dia. Elas não estão: são **estoque parado**, não trabalho em trânsito. 625 PRs
passaram por cima delas em 30 dias. Tratar estoque morto como WIP superestima o ganho de limitar
paralelismo — o limite não drena o que já parou.

## O mix: onde os 625 PRs foram parar

| Medida (30 dias, `origin/main`) | Valor |
|---|---|
| Commits | **651** |
| Commits que tocam `src/` | 151 |
| Commits que **não** tocam `src/` (docs, scripts, CI, db) | **500** |
| Razão maquinaria : produto | **3,31 : 1** |
| Commits que tocam uma **tela** (`src/pages/`, fora de `__tests__`) | **23 (3,5%)** |
| **Telas novas criadas** | **0** |
| Telas novas em 60 dias / 90 dias | 3 / 18 |

O parecer do Codex estimava 2,4:1. Re-medido, é **3,31:1** — a razão **subiu**.

⚠️ **Um erro meu, no meio da medição, que vale mais que o número:** a primeira contagem de "páginas
novas em 30 dias" devolveu **18**. As 18 eram arquivos em `src/pages/__tests__/` — **teste, não
tela**. O número certo é **zero**. Eu ia escrever "18 telas novas sem uso comprovado", que é a
conclusão oposta à verdadeira: em 30 dias e 625 PRs, o repo **não criou nenhuma superfície nova** —
gastou tudo endurecendo, testando e documentando o que já existia. `git log --diff-filter=A` sobre
um diretório que contém `__tests__` conta teste como entrega.

Isto é diretamente relevante à decisão: **o risco que o experimento do Codex quer conter — abrir
frentes novas antes de validar as antigas — não está ocorrendo na superfície de usuário.** Está
ocorrendo na maquinaria.

## O que isto significa para o experimento de 4 semanas

O Codex propôs: uma mudança ativa por agregado money-path, poucas entregas simultâneas até produção
verificada, e falsificação em 4 semanas comparando (a) entregas usadas, (b) tempo até produção,
(c) retrabalho de integração — recuando se a vazão cair sem melhorar os outros dois.

**A medição diz que o experimento, como desenhado, não é falsificável hoje** — por dois motivos
independentes, ambos corrigíveis:

1. **A métrica (a) não tem como se mover.** "Entregas usadas" tem teto estrutural em 1 usuário
   ativo e 4 elegíveis. Limitar paralelismo não cria usuário. Qualquer variação em (a) nas 4
   semanas seria ruído de um único operador — e um resultado que não pode variar não falsifica nada.
2. **A métrica (a) não tem sensor que a alcance.** Duas camadas faltam ao mesmo tempo: só **6,4%**
   das páginas têm sensor de desfecho (`track`), e o canal que carregaria até o `$pageview`
   universal está censurado em todos os aparelhos menos 2. "Usada", hoje, significa "usada por um
   iPhone" — e para 142 páginas nem isso é distinguível de "aberta e abandonada".

As outras duas métricas **já são mensuráveis, hoje, sem construir nada:**

- **(b) tempo até produção verificada** — o ledger `deploy_atestacoes` está vivo e correto: 816
  atestações, 59 edges, última hoje. Dá para medir merge → `(versao, fonte)` servida em produção.
- **(c) retrabalho de integração** — mensurável por re-merges e conflitos por PR, e o custo já foi
  demonstrado uma vez (#2093: 227h parado, 4 rodadas de re-merge, 4 defeitos latentes revelados).

**O pré-requisito que a medição revela:** antes de limitar frentes paralelas para aumentar "entregas
usadas", a alavanca com ordem de grandeza maior é o **denominador** — 5.664 customers cadastrados e
0 aprovados. Se a hipótese é "entregamos mais do que se usa", a variável dominante não é o número de
worktrees; é que ninguém foi habilitado a usar. É a mesma regra de `fase-sem-sinal.md` aplicada ao
próprio produto: *a fase N+1 (mais entrega) exige sinal da fase N (alguém usando)* — e o sinal não
existe porque a população não foi aberta, não porque a entrega foi excessiva.

**Isto é medição, não veredito.** Manter 14–30 worktrees, abrir ou não a base de clientes, e rodar
ou não o experimento são decisões do founder. O que esta sessão entrega é o número que faltava:
o experimento mede uma variável (a) que hoje não pode se mover, e duas (b, c) que já podem — e a
variável que domina o resultado está fora das três.

### O desenho, corrigido — e a baseline pré-registrada hoje

O experimento continua valendo a pena; o que muda é **quais métricas ele pode reivindicar**.
Pré-registro dos valores de **2026-09-07**, para que a comparação de 4 semanas não seja feita
contra um número lembrado:

| Métrica | Como medir (query, não recado) | **Baseline hoje** |
|---|---|---|
| **Vazão** (o que o recuo protege) | PRs mergeados / 30d | **625** (~21/dia) · 651 commits |
| **(b) tempo até produção verificada** | `bun run pendencias:deploy` — `(versao, fonte)` servida × main, via ledger `deploy_atestacoes` | **59/59 edges atestadas, 0 pendências** |
| **(c) retrabalho de integração** | PRs fechados sem merge; commits com marca de revert/conflito | **3 abandonados (0,5%)** · **10 commits** (1,5%) |
| Fila parada | branches com commit e sem PR | **34** (23 ≥7d · 13 ≥30d · mais velha 93d) |
| Mix | commits que não tocam `src/` ÷ que tocam | **3,31 : 1** |
| Superfície nova | telas criadas / 30d (fora de `__tests__`) | **0** |
| **(a) entregas usadas** | pageviews e escrita humana | **1 humano (90d)** · 8 rotas · 79 pageviews |

**O que o experimento pode rodar já:** (b) e (c) são mensuráveis hoje, sem construir nada, e têm
baseline. Mas note o que a baseline diz: **(b) já está em 0 pendências e (c) em 0,5%.** Nenhuma das
duas tem folga para melhorar de forma detectável em 4 semanas — um limite de WIP só pode
piorá-las. Um experimento cujas métricas de ganho estão saturadas e cuja métrica de custo (vazão)
tem toda a folga do mundo é um experimento que **só pode produzir o resultado "recuar"**.

**O que falta para (a) poder se mover** — e é aqui que o experimento vira útil:

1. **População.** Enquanto `is_approved = true` for 4, "entregas usadas" mede um operador. Abrir a
   base (ou um recorte dela) é o que dá denominador à métrica. **É decisão de produto do founder,
   não consequência técnica desta medição.**
2. **Canal.** Com o rastreador censurado, mesmo uma população aberta chegaria pela metade. O proxy
   first-party recusado em #1984 é a via conhecida; o gatilho que ele mesmo definiu para reabrir a
   discussão é exatamente esta situação — a censura deixou de degradar uma métrica secundária e
   passou a impedir a pergunta central.

**Critério de recuo, tornado operacional:** o Codex propôs "recuar se a vazão cair sem melhorar os
outros dois". Com (b) e (c) já saturados, esse critério dispara quase certamente. A versão que
preserva a intenção: **recuar se a vazão cair >20% (abaixo de ~500 PRs/30d) sem que a fila parada
(34) caia pela metade** — porque drenar estoque morto é o ganho que um limite de WIP realmente
pode entregar, e é o único dos quatro eixos com folga real.

## Lição

**Antes de perguntar "quanto do que entregamos é usado?", meça quantas pessoas podem usar.** Uma
razão entrega÷uso ruim tem dois numeradores possíveis e um denominador — e quando o denominador é
4, nenhuma mudança no processo de entrega move a razão. Otimizar a vazão de um sistema cuja saída
ninguém consome é o caso limite de medir a fila pelo que entra.

E o corolário de método: **cobertura de sensor ~100% não é cobertura de dado.** Toda rota deste app
emite `$pageview` por construção, e ainda assim 163 delas são invisíveis — porque o sensor existe e
o **canal** não chega. "Tem sensor?" e "o dado chega?" são perguntas diferentes, e só a segunda
decide.

## Como re-medir

```bash
# 1. Denominador — quem pode usar (o número que reformula a pergunta)
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "SELECT count(*) profiles, count(*) FILTER (WHERE is_approved) aprovados, count(*) FILTER (WHERE is_approved IS NULL) nulos, 'FIM_OK' m FROM profiles"

# 2. PostHog — SEMPRE o breakdown por aparelho ANTES da série (amostra é censurada, não esparsa)
bash scripts/posthog-query.sh "SELECT properties.\$os so, uniq(properties.\$device_id) aparelhos, count() n FROM events WHERE properties.\$lib='web' AND timestamp > now() - INTERVAL 30 DAY GROUP BY so ORDER BY n DESC"
bash scripts/posthog-query.sh "SELECT count() pageviews, uniq(properties.\$pathname) rotas, uniq(person_id) pessoas FROM events WHERE event='\$pageview' AND timestamp > now() - INTERVAL 30 DAY"

# 3. Ação humana no banco (imune ao bloqueador) — o par obrigatório do item 2
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "SELECT origem, count(*) n, count(DISTINCT executado_por) humanos FROM acoes_execucoes WHERE iniciado_em > now()-INTERVAL '30 days' GROUP BY origem"

# 4. Antes de crer em QUALQUER zero do banco: confirme o bypass de RLS
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -c "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname=current_user"

# 5. Telas novas — EXCLUINDO __tests__, senão teste conta como entrega
git log origin/main --since=30.days --diff-filter=A --name-only --format='' | grep '^src/pages/' | grep -v '__tests__' | sort -u | wc -l

# 6. Cobertura de sensor de desfecho (o $pageview NÃO conta — é universal por construção)
tot=$(find src/pages -name '*.tsx' -not -path '*/__tests__/*' | wc -l)
com=$(grep -rlE '(^|[^A-Za-z0-9_.$])track\(' src/pages --include='*.tsx' | grep -v __tests__ | wc -l)
echo "paginas=$tot com_track=$com"

# 7. Fila e vazão (o denominador da Lei de Little — confira se a fila FLUI antes de aplicá-la)
gh pr list --state merged --limit 1000 --search "merged:>=$(date -v-30d +%F)" --json number | jq length
```

⚠️ Duas armadilhas atingidas ao medir isto:
- **`awk -F'|' '$3>0'` compara como STRING quando o campo não é numérico** — a linha de cabeçalho
  `d30` passou no filtro `>0` e entrou na contagem. Force o número: `($3+0)>0`.
- **`git show ... | grep A | grep -qv B` sai 1 quando `grep A` vem vazio, mas o `-qv` inverte o
  sentido de quem sobrou** — a contagem saiu 633 de 651 em vez de 23. Contagem de commits por
  caminho: use `git log --name-only` com máquina de estado em `awk`, não pipeline de greps.
- **O eixo de confirmação por `from '@/lib/analytics'` (aspas simples) devolveu 9 em vez de 11.**
  As 2 faltantes importam com **aspas duplas**. O `grep` não errou: a sonda era estreita. Confirmar
  um número por um segundo eixo só vale se o segundo eixo não trouxer uma premissa nova e não
  declarada — aqui, a de que o repo usa um estilo de aspas só.
