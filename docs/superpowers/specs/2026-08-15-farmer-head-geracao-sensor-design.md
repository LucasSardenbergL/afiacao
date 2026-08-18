# Head de geração do farmer — o SENSOR antes da decisão

> Follow-up da limitação declarada no #1756 (`20260814223445_farmer_recomendacoes_geracao_vigente.sql`):
> o recálculo aposenta a geração anterior, mas **só quando produz linha**. A geração
> legitimamente VAZIA não avança nada, e o banco segue servindo exatamente as
> recomendações que o novo cálculo decidiu que não deveriam existir.

## 1. A medição (prod, 2026-08-15 ~17:30 UTC, via `psql-ro`)

**O denominador é 3 farmers** — não os 473 grupos do #1756, que eram `(farmer, cliente)`.
O escopo da RPC de substituição é o farmer.

| farmer | `farmer_client_scores` | c/ pedido | pendentes | geração vigente |
|---|--:|--:|--:|---|
| `414a9727` | 3.858 | 171 | 671 | `run_id=71946f20` — recalculado hoje 17:31 UTC |
| `33f59dc7` | 1.245 | 294 | 690 | **`run_id` NULL**, de 2026-04-10 (**127 dias**) |
| `700657a1` | 1.530 | 396 | **0** | **nenhuma — nunca rodou** |

**O #1756 está vivo e fez efeito real.** O run `71946f20` inseriu 671 linhas e **expirou
5.325** no mesmo instante (`expired_at = 17:31:29.702`). A trigger `trg_frec_exige_run_id`
está ativa (`tgenabled='O'`) e recusa `pendente` sem `run_id` (FG008).

### 1.1 A frequência de recálculo vazio é estruturalmente NÃO-MENSURÁVEL hoje

Um recálculo que produz zero linhas **não deixa rastro nenhum**:

- sai por `return` mudo em `useCrossSellEngine.ts:225` (sem `clientScores`) e `:296`
  (nenhum cliente com pedido) — sem exceção, sem toast, sem escrita;
- não grava linha (é o que "vazio" significa);
- `acoes_execucoes` não tem **nenhum** slug de farmer/cross/bundle (medido: 0 linhas).

Existem **28 execuções com linha** entre 2026-03-02 e 2026-08-15 (agrupando por
`(farmer_id, minuto)`). Esse é o numerador. O denominador — quantas vezes o motor rodou —
**não existe em lugar nenhum**. Se a tela tivesse sido aberta 500 vezes e 472 devolvessem
zero, o rastro no banco seria **idêntico** ao de hoje.

É o `Number(null) === 0` da adoção, e é a regra do CLAUDE.md em forma pura: *"superfície de
uso nasce COM o sensor; sem sensor, a fase N+1 é instalá-lo"*. **Esta entrega é o sensor.**

O que se pode afirmar com denominador: **nenhum dos 3 farmers está perto do zero-por-dado-faltando**
(1.245–3.858 scores; 171–396 clientes com pedido). Os dois caminhos de zero silencioso estão
longe de disparar. O zero que aconteceria hoje seria o do FIM do funil — o "zero de verdade".

### 1.2 O achado que a medição revelou sem ser procurado

`700657a1` tem insumos fartos (1.530 scores, 396 clientes com pedido) e **zero recomendação**.
No banco de hoje, **"nunca rodou" e "rodou e deu vazio" são o mesmo estado**: ausência de linha.
Essa indistinguibilidade é o custo real e já visível do desenho atual — independente de a
expiração-por-vazio ser ligada ou não.

O recálculo dispara **sozinho ao abrir a tela** (`FarmerRecommendations.tsx:40`, `useEffect`),
não por botão. Logo `33f59dc7` serve oferta de 127 dias simplesmente porque essa vendedora não
abre a tela — e o #1756 a corrige automaticamente na próxima abertura. **Decisão do founder
(2026-08-15): deixar como está**, sem escrita manual em prod.

## 2. Escopo desta entrega — SENSOR, sem expirar

**Decisão do founder (2026-08-15):** instalar o head como sensor; **não** ligar a
expiração-por-vazio agora.

O motivo é o §2 aplicado à própria decisão de produto: sem um único `vazio` medido, ligar a
expiração é assumir o risco de zerar a carteira de uma vendedora **sem contrapartida medida**.
A expiração vira o passo que se liga quando o sensor mostrar o primeiro `vazio` + `completo` real.

**Fora de escopo, declarado:** expirar por vazio; TTL/frescor por idade; backfill do head para
os farmers atuais; loop de feedback de desfecho.

## 3. Desenho

### 3.1 Tabela `public.farmer_geracao_vigente`

Uma linha por `(motor, farmer_id)` — UNIQUE — que **avança sempre**, inclusive quando a
geração é vazia. É isto que a existência-de-linha não consegue representar.

| coluna | tipo | papel |
|---|---|---|
| `motor` | text | `'cross_sell'` \| `'bundle'` |
| `farmer_id` | uuid | com `motor`, a chave que avança |
| `run_id` | uuid NOT NULL | a geração vigente — **existe mesmo quando não há linha** |
| `resultado` | text | `'linhas'` \| `'vazio'` |
| `linhas_geradas` | integer | quantas (0 exatamente quando `vazio`) |
| `completude` | text | `'completo'` \| `'degradado'` \| `'desconhecido'` |
| `motivo` | text | **obrigatório** quando `degradado` (CHECK) |
| `insumos` | jsonb | por insumo: `{ok, n}` — a EVIDÊNCIA por trás do rótulo |
| `calculado_em` / `atualizado_em` | timestamptz | `clock_timestamp()`, não `now()` |

**Invariantes na TABELA, não só no writer** (money-path §2):

- `(resultado = 'linhas') = (linhas_geradas > 0)` — impede o head mentiroso
  *"resultado=linhas com 0 linhas"*, que é como uma medição se corrompe sem ninguém ver.
- `completude <> 'degradado' OR motivo IS NOT NULL` — degradado sem motivo é um rótulo
  sem conteúdo, e a fase 2 precisaria justamente do motivo para decidir.
- `linhas_geradas >= 0`.

Todas as colunas do predicado são `NOT NULL`, então não há o three-valued logic que obrigou
o `status IS NOT NULL AND` do #1756 — o CHECK aqui não pode devolver NULL.

**Sem backfill, de propósito.** Head ausente significa *"não houve execução observada desde o
sensor"* — que é uma verdade, não uma fabricação. Semear head para os farmers atuais exigiria
inventar um `run_id` para a geração legada (`run_id` NULL) ou tornar a coluna nullable; as duas
opções pioram a leitura em troca de nada, já que o head nasce na primeira execução real.

### 3.2 `insumos` é jsonb — e por que isso não viola a regra do CLAUDE.md

*"Sinal money-path nunca em coluna jsonb multi-writer (upsert destrutivo) → coluna dedicada + 1 writer."*

Aqui: **os sinais de decisão (`resultado`, `completude`, `linhas_geradas`) são colunas
dedicadas**, e o jsonb carrega só o detalhe diagnóstico. Há **1 writer** (as RPCs desta
migration; a tabela não recebe grant de escrita direta). A regra é respeitada.

O papel do `insumos` é o inverso do que parece: **o rótulo `completude` é a DECLARAÇÃO do
motor, e as contagens em `insumos` são a evidência que permite auditá-la.** Se a fase 2
confiar só no rótulo para expirar, repete o *"rótulo com DEFAULT constante não é fato"* (§5)
— por isso a decisão de expirar exigirá contagens plausíveis (`n_scores > 0`, `n_vendaveis > 0`),
não a string `'completo'`.

### 3.3 `desconhecido` é estado de primeira classe

As RPCs de substituição ganham os parâmetros novos **com `DEFAULT NULL`**. Isso importa por um
motivo operacional concreto: no Lovable o **Publish do frontend é manual e não é instantâneo**,
então existe uma janela em que a migration já está aplicada e o browser ainda roda o bundle
velho, chamando a assinatura de 4 argumentos.

Nessa janela o head grava `completude='desconhecido'` — **nunca `'completo'`**. É o §2 aplicado
à própria instrumentação: ausente ≠ completo. Sem isso, a janela de deploy envenena a medição
com falsos `completo`, e a fase 2 decidiria em cima deles.

### 3.4 Atomicidade: o head é gravado DENTRO da transação que substitui as linhas

`farmer_recomendacoes_substituir` e `farmer_bundle_recomendacoes_substituir` passam a gravar o
head no mesmo `BEGIN`, depois do UPDATE+INSERT. Uma RPC nova cobre só o caminho que não toca
linha:

```
farmer_geracao_registrar(p_motor, p_farmer_id, p_run_id, p_resultado,
                         p_linhas_geradas, p_completude, p_motivo,
                         p_insumos, p_head_visto)
```

Duas transações separadas deixariam head e linhas divergentes — e head divergente é
**medição corrompida**, que é exatamente o insumo com que a fase 2 decidiria ligar a expiração.

**Serialização.** A RPC de registro toma o **mesmo** advisory lock da RPC de substituição do
motor correspondente (`hashtext('farmer_recomendacoes_substituir')` ou
`hashtext('farmer_bundle_recomendacoes_substituir')`, com `hashtext(farmer_id::text)`), para
que um registro de "vazio" não corra em paralelo com uma substituição com linhas. Locks
diferentes serializariam cada caminho consigo mesmo e com mais ninguém — que é o mesmo que
não serializar.

**CAS do head (`p_head_visto`).** O caminho vazio compara a geração de head que leu com a
vigente; divergiu, recusa (FG106) sem escrever. É o mesmo raciocínio do §10 (o run mais lento
é o degradado, e "terminar depois" é o desfecho esperado, não o azar) — aplicado ao registro:
sem isso, um run vazio lento sobrescreveria o head de um run com linhas que terminou antes, e a
medição registraria `vazio` para um estado que é `linhas`. **Não depende de relógio nenhum** —
nem do browser, nem do servidor.

A RPC de substituição **não** precisa de CAS próprio para o head: ela já detém o advisory lock
e já fez o CAS contra a linha, então dentro do lock ler-e-escrever o head é seguro.

### 3.4.1 O que o head representa (a sutileza que decide a fase 2)

**O head registra a última execução CONCLUÍDA do motor — não o conteúdo de
`farmer_recommendations`.** Com `resultado='vazio'` as linhas pendentes anteriores
**continuam lá**: é exatamente o buraco que o sensor existe para medir. Os dois só
convergem quando a fase 2 ligar a expiração.

Duas consequências, ambas escritas no `COMMENT` da tabela para não se perderem:

1. Até a fase 2, **nenhum leitor de oferta pode usar o head como fonte** — a autoridade
   sobre o que a vendedora vê continua sendo a tabela de linhas.
2. Uma execução que **não conclui** não move o head. Por isso o caminho em que a leitura
   das regras de associação falha (que lança **sem** limpar a tela, deixando o resultado
   anterior visível) **não** registra: mover o head ali afirmaria um desfecho que não
   houve. Já o caminho de `get_skus_margem_positiva` limpa a tela antes de lançar — ali o
   resultado exibido é de fato vazio, e o head registra `degradado`.

### 3.5 Os três caminhos de zero passam a se declarar

| caminho no motor | hoje | passa a ser |
|---|---|---|
| `:225` sem `clientScores` | `return` mudo | `vazio` + `degradado` + motivo |
| `:296` nenhum cliente com pedido | `return` mudo | `vazio` + `degradado` + motivo |
| `get_skus_margem_positiva` falha | lança (fail-closed) | registra `degradado` **antes** de lançar |
| fim do funil com 0 linhas | `return` mudo | **`vazio` + `completo`** ← o "zero de verdade" |
| geração com linhas | RPC | `linhas` + `completo`, na mesma transação |

O motor já **sabe** por qual caminho saiu — ele só nunca transmitiu essa informação. É por isso
que a completude é uma declaração do produtor, e não algo que se possa inferir do resultado.

**A completude é do SNAPSHOT, não do resultado**: `completo` significa *"li todos os insumos
com sucesso e nenhum insumo estruturalmente obrigatório veio vazio"*. Com `fetchAllPages` já
lançando em falha de página (§6/§7), leitura parcial não chega mais como lista vazia — o que
resta é a semântica, e é isso que o motor declara.

A regra vive em `src/lib/farmer/completude-snapshot.ts` (helper puro, testado isoladamente),
com duas formas distintas de degradar:

- **`ok: false`** (não consegui ler) degrada para **qualquer** insumo, obrigatório ou não —
  um universo lido pela metade produz resultado que parece completo e não é;
- **`n === 0`** (li e veio vazio) degrada só nos **obrigatórios** — é a diferença entre "a
  base não tem esse padrão" (legítimo) e "esse insumo não existe" (falta).

**`carteira_ativa` é um insumo separado de `pedidos`, e a distinção importa.** `pedidos` é
global (a base tem histórico?); `carteira_ativa` é a interseção carteira × clientes com
pedido — o universo REAL do cálculo. Um farmer cujos clientes nunca compraram tem `pedidos`
farto e `carteira_ativa` zero, e aí o zero final não julga o portfólio: só diz que não há
coocorrência de onde tirar recomendação. Sem separar os dois, esse caso sairia rotulado
`completo` e viraria licença para expirar.

**Insumo obrigatório não declarado também degrada** — ausente ≠ zero aplicado à própria
medição. Se um caminho novo esquecer de declarar um insumo, o head sai `degradado`, nunca
`completo` por omissão: licença de expirar concedida por descuido é o pior modo de falha
deste desenho.

### 3.6 O registro do head é FAIL-OPEN — e isso limita o que ele pode decidir

Falha ao gravar o head **não pode** derrubar a tela da vendedora: o cálculo é válido e já foi
exibido. Consequência declarada, herdada do §11 (`acoes_execucoes`): **sendo fail-open, o head
não pode ser a fonte de completude**. Ele mede o que o motor conseguiu declarar; a completude
de verdade se mede contra o **esperado**, não contra o que o próprio registro julgou.

Na fase 1 isso é inofensivo (o head não decide nada). Na fase 2 é a restrição central, e está
escrita aqui para não se perder.

### 3.7 RLS

Tabela nova nasce com RLS (regra do CLAUDE.md). Policies espelhando as de
`farmer_recommendations`: SELECT para o próprio farmer ou `cap_carteira_ler`; INSERT/UPDATE
para o próprio farmer ou `cap_carteira_escrever`. As RPCs são SECURITY INVOKER — **a RLS é
quem autoriza**, o gate na RPC é de MENSAGEM — igual ao #1756, e fechando em `IS NOT TRUE`
pelo mesmo motivo (numa sessão sem JWT, `auth.uid()` é NULL e `NOT (…)` devolve NULL, que
não dispara o `IF`).

## 4. Códigos de erro (faixa FG1xx, para não colidir com FG0xx do #1756)

| código | significado |
|---|---|
| FG101 | `p_motor`/`p_farmer_id`/`p_run_id` obrigatórios |
| FG102 | `p_motor` fora de `('cross_sell','bundle')` |
| FG103 | `p_resultado`/`p_completude` inválidos, ou `linhas_geradas` incoerente |
| FG104 | `degradado` sem motivo |
| FG105 | outro recálculo deste farmer em andamento (advisory lock) |
| FG106 | head mudou durante o cálculo (CAS) |
| FG107 | `resultado=linhas` sem nenhuma linha gravada para aquele `run_id` |

**FG107 é o guard anti-forja.** `resultado` chega do browser, e o head é *medição* — medição
forjável é medição corrompida, e é sobre ela que a fase 2 decidiria ligar a expiração. Por
isso `'linhas'` é ancorado na realidade: a RPC exige que existam de fato pendentes com aquele
`run_id`. Funciona porque as RPCs de substituição inserem **antes** de chamar o registro, na
mesma transação. O caminho `'vazio'` não precisa do espelho — o run é novo, então "não há
linha com este `run_id`" é trivialmente verdade, e forjar `vazio` só prejudica o próprio
farmer (o único que o gate deixa passar), sem expirar nada nesta fase.

## 5. Prova

- `db/test-farmer-head-geracao.sh` — PG17 local, asserts positivos + negativos (SQLSTATE
  esperada + re-raise) + RLS sob `SET ROLE authenticated` + falsificações.
- `db/test-farmer-geracao-vigente.sh` (35 asserts + 5 falsificações do #1756) **tem de
  continuar verde** — as RPCs de substituição são alteradas, e a assinatura de 4 args
  precisa seguir funcionando.
- Falsificação rodada sob `LC_ALL=C` **e** `pt_BR.UTF-8`, com baseline verde explícito antes
  e conferência da CONTAGEM e dos NOMES dos vermelhos.

## 6. Quando medir (é query, não recado)

```sql
SELECT motor, resultado, completude, count(*) AS farmers,
       max(calculado_em) AS ultimo
FROM public.farmer_geracao_vigente
GROUP BY 1,2,3 ORDER BY 1,2,3;
```

**A fase 2 (ligar a expiração) exige ≥1 `resultado='vazio'` com `completude='completo'` e
`insumos` plausíveis.** Enquanto essa query não devolver essa linha, a expiração-por-vazio não
tem sinal que a justifique — e "está no ar e ninguém reclamou" continua sendo ausência de dado.

---

## 7. O que o challenge do Codex (xhigh) mudou no desenho

O parecer veio depois da 1ª implementação estar verde (49 asserts, 6 falsificações) e
derrubou três premissas. Registrado aqui porque **duas delas eram contradições entre o que
este spec afirmava e o que a migration fazia** — o tipo de erro que passa despercebido
justamente por estar escrito certo no documento.

### 7.1 A tabela tinha `GRANT INSERT, UPDATE` para `authenticated` (CRÍTICO)

O §3.2 dizia *"há 1 writer (as RPCs desta migration; a tabela não recebe grant de escrita
direta)"* — e a migration fazia `GRANT SELECT, INSERT, UPDATE ... TO authenticated`. Com
esse grant, o browser dispensa a RPC inteira:

```sql
UPDATE farmer_geracao_vigente SET resultado='vazio', completude='completo' WHERE ...
```

Isso pula FG105 (lock), FG106 (CAS) e FG107 (anti-forja) de uma vez. **Guard que se
contorna pela porta ao lado não é guard** — e aqui o contorno falsifica a *medição*, que é
o produto inteiro da entrega.

**Correção:** nenhum grant de escrita e nenhuma policy de INSERT/UPDATE para
`authenticated` (só `SELECT`); `farmer_geracao_registrar` passa a `SECURITY DEFINER`, o que
a torna a única porta. DEFINER bypassa RLS, então o gate da função é a autorização inteira
— ele já existia, já fecha em `IS NOT TRUE`, e `auth.uid()` continua sendo o do chamador
(lê o JWT, não o role do Postgres), então o DEFINER não o afrouxa.

### 7.2 O head não mede FREQUÊNCIA — e apaga o evento procurado (o mais importante)

`ON CONFLICT DO UPDATE` sobrescreve a única linha do par. Logo um `vazio+completo` pode
acontecer hoje e **sumir** no próximo run com linhas. O head responde *"qual é o último
estado dos até 6 pares"* — e a pergunta que originou esta entrega é *"com que frequência o
recálculo produz zero?"*. Sem histórico, a ausência de `vazio+completo` continuaria sendo
ausência de dado: exatamente o defeito que o sensor existe para curar.

**Correção:** tabela append-only `farmer_geracao_execucoes`, escrita na mesma transação,
com `UNIQUE(motor, farmer_id, run_id)` para que um retry não conte como execução nova
(senão a "frequência" mede retries). Divisão de trabalho declarada: **head = estado + CAS;
log = medição.** As queries do §6 passam a sair do log. Volume não era objeção — 28
execuções em 5,5 meses.

### 7.3 O CAS era assimétrico (eu tinha chegado nisso; ele mostrou que dava para fechar)

Cenário: run L (linhas) e run E (vazio) leem o mesmo head. E termina primeiro e move o
head. L termina depois — e seu CAS da etapa 5 **passa**, porque ele compara *linhas* e E
não mexeu em linha nenhuma. L então sobrescreve um vazio mais novo.

O sistema misturava duas ordens: frescor causal para o vazio, ordem-de-commit para as
linhas. Eu ia declarar isso como limitação conhecida (o viés é conservador — subestima o
vazio, o que atrasa a fase 2 em vez de acelerá-la). O Codex está certo de que dá para
fechar barato.

**Correção:** as RPCs de substituição recebem `p_head_visto` — o head que o **browser** viu
antes do cálculo — em vez de lerem o head sob o próprio lock (o que satisfazia o CAS por
construção). `p_completude IS NULL` continua sendo o marcador de chamador anterior ao
sensor, e só nesse caso se cai no head corrente.

### 7.4 Correções menores

- **`EXISTS` não é contagem** (FG107): aceitava *"1 linha real, 999 declaradas"*, e
  `linhas_geradas` é o que a fase 2 leria para dimensionar. Agora conta no servidor e
  compara; `vazio` também é ancorado (declarar vazio num run que tem linhas é recusado).
- **`NOTIFY pgrst, 'reload schema'`** no fim: sem ele a janela entre apply e reload devolve
  PGRST202 para a RPC nova — e como o registro é fail-open, isso sairia só num
  `console.error`: o sensor nasceria cego sem ninguém perceber.
- **Cobertura de perfil** (§3.5): o motor faz `if (!profile) continue`, e a base tem 1.633
  usuários sem `profiles` (aliases fiscais, `database.md` §5). Contar o universo global
  (`n > 0`) não pega um farmer cujos clientes ativos caiam todos nesse grupo — contar a
  **interseção** pega. Novo insumo obrigatório `clientes_com_profile`.
- **Sobre a reentrância do lock:** o parecer confirmou o comportamento e corrigiu com razão
  a minha justificativa — `pg_locks = 1` mostra o lock *tag*, não todo o bookkeeping
  interno, então não "prova" ausência de refcount. O que vale é o documentado: lock
  transacional é reentrante e é liberado no fim da transação, sem dívida de unlock.

### 7.5 O que NÃO foi aceito, e por quê

- **RPCs versionadas (`*_v2`) em vez de DROP+CREATE.** Medido em prod: zero dependências em
  `pg_depend`, zero cron, nenhuma sobrecarga pré-existente, e o único chamador é o browser
  via PostgREST — que resolve pela aridade, preservada pelos DEFAULTs. Versionar deixaria
  duas funções money-path vivas fazendo a mesma coisa, que é a dívida que o repo
  historicamente paga caro.
- **Cobertura de "histórico utilizável" (itens mapeáveis por pedido).** Procede como
  crítica, mas exige percorrer os itens de todos os pedidos só para instrumentar. Fica
  **declarado como limitação**: `carteira_ativa` conta clientes com pedido, não clientes
  com pedido cujos itens resolvem para SKU do catálogo. A fase 2 precisa fechar isso antes
  de expirar — está anotado no §6 como pré-requisito, não como pendência vaga.
