# O sensor de desfecho do motor Farmer — instalar antes de calibrar

> 2026-08-21. Instala a superfície que registra se uma recomendação virou venda.
> Não calibra nada: sem histórico de desfecho não há contra o que calibrar.
> Migration `20260821194411_farmer_recomendacao_desfecho.sql` · prova em
> `db/test-farmer-desfecho.sh`.

## O estado que motivou

Medido em produção com `psql-ro` em 2026-08-21:

```
status=expirado n=16233
status=pendente n=1083
offered=0 accepted=0 rejected=0 margin=0 tempo=0
```

**17.316 recomendações e ZERO desfecho em todas as cinco colunas que existiam para
registrá-lo.** O vocabulário `'ofertado'|'aceito'|'rejeitado'` está no CHECK de
`status` desde fev/2026 e nunca foi escrito: `markAsOffered/Accepted/Rejected` foram
removidos em 2026-07-21 por não terem chamador, e a tela nunca ofereceu ação de
resultado. `farmer_category_conversion` tem 0 linhas pelo mesmo motivo, e é por isso
que `TAXA_CONVERSAO_CROSS_SELL/UP_SELL` e `FATOR_COMPLEXIDADE` seguem ARBITRADOS.

É o padrão de [`fase-sem-sinal.md`](fase-sem-sinal.md) na forma mais pura: a fase
N+1 (calibrar o gate `clusterAdherence < 0.03` e os pesos do ranking, corrigidos em
#1841) exige um sinal que a fase N nunca produziu.

## A descoberta que mudou o desenho

**A UI não tem o `id` da linha.** O motor calcula as recomendações em memória e a
`farmer_recomendacoes_substituir` as insere separadamente; os ids gerados nunca
voltam ao browser (`Recommendation.id` é opcional e não é preenchido nesse fluxo).
Não existe handle para um `UPDATE by id` — o writer precisa localizar a linha pela
**chave de negócio** `(farmer_id, customer_user_id, product_id, recommendation_type)`.

Medido: entre as 1.083 pendentes essa chave é única (1.083 grupos, 0 duplicatas).

## O que o `/codex` xhigh derrubou

O desenho original tinha três botões — "Ofertei" / "Aceitou" / "Recusou" — com a
RPC aceitando `pendente` e `ofertado` como origem e desempatando por
`ORDER BY created_at DESC LIMIT 1`. O parecer adversário matou o primeiro botão com
um cenário concreto:

1. R1 nasce `pendente`; a vendedora marca "Ofertei" → R1 vira `ofertado`.
2. O recompute expira só as `pendente` — R1 **sobrevive** (é o que queremos).
3. O motor recomenda a mesma chave e insere R2 `pendente`.
4. A vendedora marca "Aceitou" pensando em R1 → há **duas** linhas elegíveis, e a
   RPC carimba a errada.

O aceite ficaria colado ao `run_id`, `p_ij` e afinidade de **R2** — um cálculo que
ela nunca viu. `ORDER BY` não transforma a chave em identidade: só torna a
atribuição errada determinística.

> **A lição transferível:** o dado errado é pior que dado nenhum. Contra dado
> ausente ninguém calibra; contra dado errado alguém calibra **com confiança**.

Três correções entraram por causa do parecer:

| Achado | Correção |
|---|---|
| Estado intermediário cria a ambiguidade | `'ofertado'` fica **fora** do escopo. Com só `pendente` elegível, e a RPC de substituição expirando todas as pendentes antes de inserir, a chave volta a ser identidade. |
| Nada garante unicidade da chave | Guard **FD006**: mais de uma linha elegível ⇒ **recusa**, nunca escolha (precisão > recall). Índice único parcial foi recusado — derrubaria o recompute no dia em que o motor emitisse duas linhas iguais no mesmo lote. |
| CHECK valida estado, não transição | Trigger `trg_frec_desfecho_imutavel`. `authenticated` tem `w` direto na tabela (`relacl` medido em prod), então um UPDATE podia reescrever um desfecho deixando o estado final coerente. |

E um achado de UX no mesmo parecer: a tela lê o resultado do motor **em memória**;
uma linha `ofertado` sumiria do próximo cálculo e a vendedora nunca mais alcançaria
o card para registrar o desfecho que interessa.

## O bug que só o teste executando pegou

A primeira correção do CHECK de motivo era:

```sql
(status = 'rejeitado' AND rejection_reason IN ('preco', ...))
OR (status <> 'rejeitado' AND rejection_reason IS NULL)
```

Com `status='rejeitado'` e `rejection_reason IS NULL`: `NULL IN (...)` devolve
**NULL**, o ramo inteiro vira NULL, e **um CHECK que resulta em NULL é considerado
SATISFEITO pelo Postgres**. A constraint deixava passar exatamente o caso que
existia para barrar — recusa sem porquê. Corrigido com `rejection_reason IS NOT NULL`
antes do `IN`.

Não foi pego por leitura: foi o assert 18 do harness PG17 ficando vermelho. É o
motivo nº 1 da skill `prove-sql-money-path` — PL/pgSQL e CHECKs são late-bound.

## A prova

`db/test-farmer-desfecho.sh` — **29 asserts, 0 falhos, 4 falsificações com dente**:

- **controle positivo** — a fixture produz ofertas e o zero de partida é real;
- o desfecho **sobrevive ao recompute** (statement verbatim da RPC de prod), e o
  complemento: nenhuma linha com desfecho pertence ao conjunto que ela expira;
- `actual_margin`/`time_spent_seconds`/`offered_at` seguem **NULL**, não 0;
- o **gestor** não registra na carteira alheia, e a oferta da vendedora fica intacta;
- as falsificações removem o gate `auth.uid()`, o CHECK, a trigger e o guard de
  ambiguidade — cada assert correspondente fica vermelho.

## A falsificação do vitest encontrou DOIS asserts de teatro

O harness SQL já falsificava. Ao aplicar a mesma disciplina aos testes de
componente, duas sabotagens saíram **verdes** — ou seja, dois asserts não provavam
o que o nome deles dizia:

| Sabotagem | Por que ficou verde |
|---|---|
| Remover o guard `isImpersonating` do **hook** | `fireEvent.click` num botão `disabled` **não dispara o handler**. O assert provava o `disabled` do COMPONENTE e nada sobre o hook — justamente a camada que um POST direto alcançaria. |
| Trocar a trava `useRef` por `useState` | O `fireEvent` do RTL passa por `act()`, então o `setState` já fez flush quando o segundo clique chega. O teste nunca reproduziu o "mesmo tick" que a ref existe para cobrir. |

> **A classe:** testar defesa em profundidade **através da UI** só prova a camada de
> cima. Se a camada de baixo tem razão de existir, ela precisa de um teste que
> **pule a de cima** — aqui, uma sonda que chama o hook direto, sem botão no meio.

É a irmã em TypeScript do `WHEN OTHERS THEN 'OK'` do SQL: o teste passa, e o que ele
mede não é o que o nome promete. As seis sabotagens finais (guard da lente, motivo
fabricado, erro do banco ignorado, `ref`→`useState`, recusa sem porquê, e `FD004`
sugerindo retry) derrubam testes **nomeados**, não "algum teste".

## Fora de escopo (deliberado)

- **`'ofertado'`** volta quando a UI tiver o `id`, o que exige a
  `farmer_recomendacoes_substituir` devolver os ids e o hook renderizar as linhas
  persistidas. Entrega própria, sobre o arquivo mais quente do domínio.
- **Margem realizada.** `actual_margin` fica NULL: ninguém sabe a margem no
  momento do clique, e 0 entraria nas médias como resultado apurado.
- **Calibrar o gate e os pesos.** É a fase seguinte, e só começa quando esta query
  tiver linhas.

## Quando medir (é query, não recado)

```sql
SELECT
  count(*)                                                        AS geradas,
  count(*) FILTER (WHERE accepted_at IS NOT NULL)                 AS aceitas,
  count(*) FILTER (WHERE rejected_at IS NOT NULL)                 AS recusadas,
  count(*) FILTER (WHERE status='expirado'
                     AND accepted_at IS NULL AND rejected_at IS NULL) AS expiradas_sem_interacao,
  count(*) FILTER (WHERE status='pendente')                       AS pendentes_sem_interacao
FROM farmer_recommendations
WHERE created_at >= '<data do Publish>';   -- antes disso o sensor não existia
```

As cinco categorias são **distintas**: `expirado` significa "substituída sem
interação registrada", nunca "rejeitada" — ausente ≠ zero.

`aceitas/(aceitas+recusadas)` chama-se **"aceitação entre desfechos registrados"** —
não é conversão nem precisão do motor. O denominador de adoção é
`(aceitas+recusadas)/geradas` na coorte, e mesmo ele é um **proxy**: mede cobertura
entre recomendações GERADAS, não entre as VISTAS. Não há evento de impressão.

Vieses conhecidos, a carregar para a calibração: quem registra aceite e omite recusa
infla a taxa; `sem_estoque` e `prazo_entrega` são falha **operacional**, não erro do
motor, e penalizariam a afinidade se contados junto.

### Medição 1 — 2026-08-22 03:02 UTC · janela de 83 min · **coorte VAZIA (`geradas=0`)**

```
geradas | aceitas | recusadas | expiradas_sem_interacao | pendentes_sem_interacao
      0 |       0 |         0 |                       0 |                       0
rejection_reason: (0 linhas)
```

**Isto NÃO é "adoção 0%".** `(aceitas+recusadas)/geradas` = `0/0` — **indefinido, não zero**.
O denominador está AUSENTE, e reportar "0%" seria fabricar o número que o money-path
proíbe: é o `Number(null)===0` aplicado ao próprio instrumento de medição. A leitura
honesta da coorte é **"ainda não há o que medir"**.

Mas a pergunta seguinte — *por que* não há — tem resposta, e ela é dura.

#### Camada 1: o motor não rodou desde o Publish

| Sonda | Leitura | Conclusão |
|---|---|---|
| `farmer_recommendations` | total **17.316** (idêntico ao marco zero), `max(created_at)` = **2026-08-21 20:16 UTC** | nenhuma linha nova desde o Publish (01:40 UTC) |
| `farmer_geracao_execucoes` (`cross_sell`) | 13 execuções, **0 desde o Publish**, última **2026-08-21 20:16 UTC** | a página não CARREGOU nenhuma vez |

A segunda sonda é a decisiva e já existia: `useCrossSellEngine` registra **toda**
execução — inclusive a de resultado vazio, via `registrarVazio` — então "nenhuma linha
nova" e "nenhum carregamento" são fatos **separados**, e os dois foram medidos.

#### Camada 2: a tela não tem usuário — e nunca teve

O denominador humano **não é "1 farmer"**. Medido:

```
farmers_com_carteira=3 · farmers_que_executaram=1 · nunca_abriram=2
o único executor é o FOUNDER (conferido contra auth.users)
```

E o histórico inteiro da tabela, desde fev/2026, separa os atores sem ambiguidade:

| Ator | Linhas | Execuções | Primeira | Última |
|---|---|---|---|---|
| **founder** (verificando) | 16.626 (96%) | 37 | 2026-03-02 | **2026-08-21** |
| **vendedora** | 690 (4%) | 4 | 2026-04-10 | **2026-04-10** |

**A única vendedora que já abriu a tela abriu num único dia — 10/04/2026 — e nunca
mais voltou.** As 1.083 pendentes do marco zero são de sessão do founder, não de
carteira em uso. Das 3 carteiras, 2 nunca abriram a tela uma vez sequer.

> **A regra transferível: a janela de adoção conta SESSÕES DO USUÁRIO-ALVO, não horas
> de relógio nem execuções de qualquer ator.** 83 minutos de sexta à noite não contêm
> oportunidade de uso; e 41 execuções não são adoção quando 37 são de quem foi
> conferir. É a mesma ausência de dado de [`fase-sem-sinal.md`](fase-sem-sinal.md),
> agora na hora de LER o sensor — e a razão de o gatilho da fase 2 ter ganho o ramo
> `MONOUSUARIO` (#1865): **um ator não é população.**

Corolário operacional: **antes de reler a query de coorte, cheque
`farmer_geracao_execucoes`** — sem execução nova a coorte não pode ter mudado, e reler
é ruído. E **cheque de quem** é a execução: renovar o contador indo olhar a tela é o
defeito que o #1865 corrigiu. Medir por `psql-ro` **não contamina**; abrir a tela sim.

#### A superfície ESTÁ no ar — provado, não presumido

Contra a armadilha "merge ≠ produção", as três camadas do deploy Lovable:

- **Banco** — `pg_get_functiondef` em PROD: 4 colunas (`accepted_at`/`rejected_at`/
  `rejection_reason`/`offered_at`), RPC `farmer_recomendacao_registrar_desfecho`,
  trigger `trg_frec_desfecho_imutavel`, e o guard **FD006** na definição real.
- **Frontend** — varredura por BYTES do bundle publicado (332 chunks, 6,1 MB,
  332/332 baixados não-vazios): `recomendacao.desfecho_clicado`, `ja_compra_concorrente`
  e `farmer_recomendacao_registrar_desfecho` estão em
  `assets/FarmerRecommendations-*.js`. **Controle positivo** (`carteira.mixgap_visto`,
  feature antiga) achado; **controle negativo** zero — a varredura enxerga.
- **Edge** — não aplicável: o sensor não tem edge.

O botão está lá e o banco aceita. **Não falta código: falta usuário.**

#### O que isto decide

Não é a fase de calibração (não há desfecho contra o que calibrar) e **não é esperar**
(esperar não produz sinal numa tela sem usuário — é a definição de `fase-sem-sinal`).
A fase seguinte é **instalar o uso** nas 2 carteiras que nunca abriram — ou **encerrar
a linha**. Só depois de existirem sessões de vendedora a coorte acumula, e só então
calibrar o gate `clusterAdherence < 0.03`, os pesos do `relevance` e as constantes
`TAXA_CONVERSAO_*`/`FATOR_COMPLEXIDADE` passa a ser uma pergunta respondível.

## Se a query continuar vazia

A pergunta passa a ser de **adoção**, não de código — mas **na ordem certa**, porque a
query de coorte não distingue "ninguém clicou" de "ninguém abriu a tela":

1. **Primeiro `farmer_geracao_execucoes`** (motor `cross_sell`, `calculado_em >= Publish`).
   **Zero execução ⇒ pare aqui:** não houve carregamento, logo não houve clique, logo o
   banco não pode ter recusado nada. Nenhuma outra sonda desempata isso, e nenhuma
   conclusão sobre desenho, motor ou UI é possível. É o estado da Medição 1.
2. **Depois, de QUEM é a execução.** Execução > 0 do próprio verificador não é adoção —
   compare `farmer_id` contra as carteiras (`farmer_client_scores`) e contra quem foi
   olhar. Enquanto o executor for o founder, o veredito é `MONOUSUARIO` (#1865), e a
   pergunta continua sendo instalar uso, não medir de novo.
3. **Só com execução de VENDEDORA > 0 e linha zero** o evento `recomendacao.desfecho_clicado` (PostHog)
   vira o desempate que ele foi feito para ser: ele mede a **tentativa**, então tentativa
   alta com linha zero significa que o banco está recusando (códigos FD001–FD007), e
   tentativa zero significa que a tela abriu e ninguém clicou — e aí, sim, é conversa com
   a vendedora.

⚠️ **O PostHog não é lido daqui.** Não há credencial nem script de leitura no repo, e
silêncio que não se consegue observar **não é dado** — a etapa 3 depende do founder ou de
uma sonda que ainda não existe. As etapas 1 e 2 respondem no mesmo `psql-ro`, sem
depender de ninguém: foi por isso que elas vieram primeiro.
---

# O adversarial no CÓDIGO — o passo que faltava (2026-08-22)

O ritual `/codex` do money-path é metodologia → spec → plano → **adversarial no código**.
No #1851 os três primeiros rodaram (e o primeiro derrubou o botão "Ofertei"); o quarto
não. O PR foi mergeado com "REVISÃO INDEPENDENTE PENDENTE" no corpo, pelo Caminho B.
Esta seção fecha a lacuna: `gpt-5.6-luna`, reasoning `xhigh`, sobre os quatro arquivos
TypeScript, com o SQL fora de escopo (ele já tinha o harness PG17 como oráculo).

## O diagnóstico anterior estava errado — não era cota

O registro dizia `COTA_ESGOTADA` (janela rolante de 7 dias do ChatGPT Plus). Ao re-rodar,
o erro real apareceu:

```
status 400 invalid_request_error
"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
```

`gpt-5.6` e `gpt-5.1-codex-max` dão o mesmo 400; `gpt-5.6-luna` responde. O default do
`scripts/codex-async.sh` é `gpt-5.6-sol` — **o transporte do ritual está quebrado para
todo o repo**, não só para esta sessão.

E ele mente sobre o motivo: o classificador de transitório roda `grep -E '…|5[0-9][0-9]'`
sobre um stderr que contém o **prompt ecoado**. O prompt trazia saída de `cat -n`, então
um número de linha entre 500 e 599 casou com o padrão de erro 5xx e um 400 permanente
virou "transitório" — 3 tentativas e 80s de backoff atrás de algo que nunca ia mudar.

> **A classe:** um classificador de erro que lê o stderr INTEIRO está lendo a própria
> entrada de volta. O padrão precisa casar na linha de ERRO, não no eco do que foi
> enviado — senão o conteúdo do prompt decide a política de retry.

## O achado P1: a chave de negócio é identidade DENTRO de uma geração

O parecer e a auto-revisão chegaram nele por caminhos independentes.

`useFarmerDesfecho` memoriza os desfechos da sessão num mapa por chave de negócio
(`cliente|produto|tipo`) — porque o browser não tem o id da linha. O botão **"Recalcular"**
chama `farmer_recomendacoes_substituir`, que expira as pendentes e insere linhas NOVAS
com a **mesma chave**. O mapa sobrevive: a página não desmonta.

1. R1 nasce `pendente`; a vendedora marca "Comprou" → R1 vira `aceito`, mapa guarda a chave.
2. Ela clica em "Recalcular" → R1 (já com desfecho) sobrevive, e R2 nasce `pendente`.
3. O card de R2 lê o mapa pela chave e mostra **"Venda registrada"** — sobre uma linha
   que está `pendente` no banco — **e esconde os botões**.

O segundo efeito é o pior: o desfecho de R2 fica impossível de registrar, e R2 morre como
`expirado`, que a query de medição lê como "substituída sem interação". É **perda
silenciosa do sinal que este sensor existe para produzir** — o zero volta, indistinguível
do zero real.

> **A lição transferível:** o SQL gastou três guardas (derrubar `ofertado`, FD006, a
> trigger de imutabilidade) para tornar a chave de negócio uma **identidade** — e ela só
> é identidade **dentro de uma geração**. Um cache do cliente indexado pela MESMA chave
> **herda o escopo do invariante**; se ele vive mais que a geração, quebra em silêncio a
> garantia que o banco comprou caro. O guard ficou de um lado do fio e a violação do outro.

**A correção** é `esquecerRegistros()`, chamado no "Recalcular". Ele esquece em TODO
recálculo, **inclusive nos que falham ao persistir** — ali as linhas antigas seguem
valendo e a memória era boa. É o lado seguro do trade-off: o pior caso vira um clique que
o banco recusa com FD007 ("já tem desfecho"), mensagem honesta e zero dado corrompido;
o outro lado perde sinal sem avisar. Distinguir os casos exigiria acoplar o hook às
SQLSTATEs `FG005`/`FG006` do engine para comprar precisão numa direção que já é segura.

O mesmo achado trouxe a corrida: "Recalcular" **com uma gravação em voo** faz a
substituição correr contra a RPC de desfecho pela mesma chave — se a substituição vencer,
o aceite cai na geração nova. O banco não tem como distinguir (a chave é a única
identidade que o browser tem), então a serialização é do cliente: o botão fica travado
enquanto `registrando`.

## Falsificar contra a PROMESSA DO NOME, não contra a funcionalidade

O #1851 já tinha falsificado os testes com seis sabotagens, e duas revelaram teatro. Ainda
assim, o adversarial achou mais — e o padrão do que **escapou** é o achado metodológico:

| Teste | O que o nome prometia | O que o assert media |
|---|---|---|
| `o evento sai antes do await` | uma **ordem** | que o evento existe em algum momento (o mock resolvia na hora) |
| `o vocabulário é EXATAMENTE o do CHECK da tabela` | acordo **TS↔SQL** | acordo da constante TS com um literal TS |

As seis sabotagens anteriores miravam a **funcionalidade** (o desfecho grava? a lente
barra?) e por isso passaram ao largo: nenhuma delas mexia na ORDEM nem no CHECK.

> **A classe (irmã de "falsificar pela UI só prova a camada de cima"):** quando o nome do
> teste afirma uma **ordem**, um **acordo entre camadas** ou uma **negativa**, a sabotagem
> tem de mirar essa afirmação específica. Sabotar a feature deixa esses asserts verdes,
> porque não é a feature que eles prometem medir.

O de ordem agora segura a RPC pendente e exige o evento **antes** de resolver. O de
vocabulário **lê a migration** e compara com a constante: não prova a prod (apply manual
diverge do repo), mas fecha a corrente com o outro elo — `db/test-farmer-desfecho.sh`
executa esse mesmo CHECK num PG17 de verdade. TS↔arquivo aqui, arquivo↔Postgres lá. E o
extrator tem controle positivo: regex que não casa **falha nomeando o motivo**, em vez de
devolver lista vazia e passar.

Outras quatro lacunas fechadas, todas com a mesma assinatura — sabotagem que ficava verde:
o ramo `catch` (falha de transporte) não tinha teste **nenhum**; a recusa bem-sucedida
nunca era confirmada na tela (renderizar "Venda registrada" numa recusa passava); a recusa
não conferia a chave de negócio; e `FD002`/`FD007` nunca eram exercitados.

## O achado recusado, com o porquê

**"Exceção do analytics deixa a trava presa"** — o parecer notou que `track()` roda depois
de `gravandoRef.current = true` e **fora** do `try`, e concluiu que um throw síncrono
travaria o hook para sempre.

Recusado com evidência: `track()` delega a `withPosthog`, que invoca o callback dentro de
um `try/catch` próprio (`src/lib/analytics.ts`). Não há caminho de throw síncrono.

E a "correção" seria **pior que o bug**: mover o `track()` para dentro do `try` faria uma
falha de analytics cair no `catch` de transporte e mostrar *"Não consegui falar com o
servidor — o desfecho NÃO foi registrado"* — uma mensagem **falsa**, sobre uma gravação
que teria acontecido. Achado sem trigger não vira código; e defesa em profundidade que
mente na degradação não é defesa.

## E a falsificação desta rodada pegou um teatro MEU

Seis sabotagens, seis vermelhos — mas **dois** dos asserts que eu esperava derrubar
ficaram verdes. Um era alvo errado meu; o outro era teatro de verdade:

```ts
fireEvent.click(recalcular());
await waitFor(() => expect(screen.queryByText('Venda registrada')).toBeNull());
```

`waitFor` passa no **primeiro poll** em que a condição vale — e a lista some sozinha
enquanto remonta o recálculo. O assert media a remontagem, não a invalidação da memória:
ficava **verde com a sabotagem aplicada**. O teste irmão ("os botões VOLTAM") usava
`findByRole`, que espera algo **aparecer**, e ficou vermelho como devia.

Corrigido ancorando a ausência num instante em que o card comprovadamente existe:

```ts
await screen.findByRole('button', { name: 'Cliente comprou' });  // a geração nova está na tela
expect(screen.queryByText('Venda registrada')).toBeNull();       // e não afirma nada
```

> **A classe:** **ausência só é evidência quando medida sobre algo que está lá.** É a irmã
> em RTL do "`grep` sem ocorrência é ausência de dado" do CLAUDE.md — e a assinatura é
> `waitFor` + assert NEGATIVO, que se satisfaz com qualquer janela em que o alvo não
> exista, inclusive as que o bug não causa. Para negativa, ancore num positivo primeiro.

O outro verde (`o dialog RENDERIZA os seis motivos`) **não** era teatro: a sabotagem
mexeu na constante `MOTIVOS_RECUSA`, e esse dano é o que o teste de vocabulário pega
(ficou vermelho). O alvo dele é o componente renderizar um SUBCONJUNTO da constante —
sabotado corretamente na segunda rodada, vermelho. Falsificação com alvo errado não
condena o assert; só não o absolve.
