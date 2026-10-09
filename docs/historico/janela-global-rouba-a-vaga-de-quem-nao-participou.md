# A janela do juiz era GLOBAL — e um evento parcial legítimo consumia a vaga de todos os outros

**2026-10-09** · `scripts/lib/sonda-cron-testemunha.ts` + `scripts/pendencias-deploy.ts` · fecha o "em
aberto" de [resumo-universal-herda-o-pulo-do-juiz.md](resumo-universal-herda-o-pulo-do-juiz.md) (PR
#2862) · mecanismo em [sonda-por-cron-fail-closed.md](sonda-por-cron-fail-closed.md)

## O que aconteceu

A sonda por cron julga o silêncio de uma edge nos "2 ticks recentes", e esses 2 ticks eram escolhidos
**globalmente**:

```sql
SELECT tick_id, max(enfileirado_em) AS quando
FROM public.deploy_sonda_disparos GROUP BY tick_id ORDER BY quando DESC LIMIT 2
```

Só que existe **tick parcial legítimo e documentado**: o one-liner `deploy_sonda_disparar(ARRAY['<edge>'])`
que o `bun run sonda:sql` oferece a quem já tem o relé (§7.1 do doc do mecanismo). Medido em prod: às
**2026-09-10 23:14:15Z** um tick com **1 disparo só** (`sonda-relay`) caiu entre os ticks cheios das
22:37Z (15 edges) e 00:37Z (16 edges).

Contagem do recorte naquele instante, lida contra a prod com âncora `2026-09-10 23:20Z`:

| janela | edges com 2 disparos | edges com 1 disparo |
|---|---|---|
| global (2 ticks) | 1 | **14** |
| por edge (`row_number`) | **15** | 0 |

O juiz só acusa `SONDA_CRON_SILENCIOSA` quando os **dois** disparos que julgam ficaram mudos (precisão >
recall: timeout e 429 acontecem). Com 1 disparo na janela, por ~2 h o silêncio das 14 só podia virar
AVISO — *"1 de 1 tick(s) recentes sem resposta"* — e **nunca** a acusação de rollback, que é a única
pergunta que o mecanismo inteiro existe para responder: *o bundle que o ledger jura estar no ar continua
lá?* Dois parciais em sequência (retry depois de corrigir um secret) zeravam a janela das demais.

## A forma generalizável

> **Janela de julgamento compartilhada é uma vaga que qualquer participante pode gastar pelos outros.**
> Quando o recorte é "os N eventos mais recentes do SISTEMA" mas a decisão é "esta unidade está muda?",
> um evento legítimo que envolve UMA unidade expulsa as outras da própria janela delas. O eixo do
> `LIMIT` tem de ser o eixo da DECISÃO — `PARTITION BY <unidade>`, não `ORDER BY tempo LIMIT n` sobre o
> todo. É o irmão do [corte por ranking no eixo errado](roteirizador-corte-cidades.md): lá aumentar o
> `n` só adiava; aqui aumentar o `n` traria ticks velhos para dentro do veredito, que é pior.

Isto **não** era desonestidade do resumo — 1 disparo respondido É atestação, e o #2862 já fazia a tela
contar a população examinada (`15/16 edge(s) ativa(s) perguntada(s)`) e só dar o ✅ quando toda ativa
fosse perguntada e atestada. O que faltava era **poder de detecção num intervalo conhecido**: a tela
dizia a verdade sobre um exame que não podia concluir nada.

## O teto que o `LIMIT` dava de graça

Trocar o recorte por `PARTITION BY edge` **perde** uma garantia que ninguém havia escrito: com 2 ticks
globais recentes, os disparos eram recentes por construção. Por edge, "os 2 últimos dela" podem ser de
duas semanas atrás — uma edge desligada pelo kill switch e religada formaria acusação de rollback com
dois disparos antigos.

O teto é a **mesma** `toleranciaDoCronMin()` que já governava `cronSondaParado` e a espera por uma
pergunta (2 períodos do cron + 15 min = 255 min): uma definição só, e a razão de ser o mesmo número é
que todas as três medem pelo mesmo relógio. Medido em prod em 2026-10-09, com o cron de 2 h saudável:
os 2 disparos de cada edge estavam a **93,1 e 213,1 min** — dentro do teto, com a folga de 15 min
absorvendo o jitter. Cron irregular empurra o segundo disparo para fora e a edge cai para AVISO; é
precisão > recall, de propósito.

Duas decisões que merecem o nome explícito:

- **a idade vem do relógio do BANCO** (`extract(epoch FROM (now() - enfileirado_em))/60`), nunca
  comparada com o `now()` local: skew de relógio não entra em veredito;
- **a ligação resposta↔disparo continua sendo o `request_id`**. A idade só ORDENA a janela e aplica o
  teto. A razão (1) do mecanismo — *atribuição por tempo fabrica veredito* — é sobre casar resposta com
  disparo, e isso nenhuma hora chegou a decidir.

E o guard é `!(idade <= teto)`, não `idade > teto`: `NaN > teto` é `false` e deixaria um disparo de idade
ilegível **entrar** no exame. É o `ausente ≠ zero` nesta camada, e tem mutação própria.

## O resumo não pode recontar o recorte

O cabeçalho dizia `… em ${ticksRecentes.length} tick(s) recente(s)`, derivando N dos `tick_id` que
apareceram na leitura. Com a janela por edge esse número **deixa de medir a população examinada** —
manter o texto seria afirmar o que não se mede mais, que é a lição do doc irmão uma camada acima. O juiz
passou a devolver `exame: { disparos, atestados }` e o resumo lê DELE.

Duas sutilezas que só apareceram ao escrever a mutação:

1. o exame tem de ser contado **dentro do laço das ATIVAS**. Contado sobre a janela inteira, incluiria
   edge desligada pelo kill switch — que continua com disparos recentes no ledger — e o cabeçalho
   afirmaria um exame maior do que a população que o juiz examina;
2. `SQL_SONDA_CRON_ATESTACOES` filtrava pelos `request_id` dos mesmos 2 ticks globais e teve de seguir o
   recorte novo. As duas leituras **têm de concordar** sobre o conjunto examinado: um disparo que o juiz
   julga e cuja atestação não foi perguntada viraria silêncio fabricado.

## Como foi falsificado

Contrato novo [`sonda-cron-janela-por-edge.mut`](../../scripts/mutcheck.d/sonda-cron-janela-por-edge.mut)
(8 mutações) mais as camadas novas em `pendencias-deploy-resumo-cobertura.mut` (14) e o
`sonda-cron-fora-do-exame.mut` (6) seguindo verde — **28 mutações × 2 locales (`C` e `pt_BR.UTF-8`) =
56/56 pegas, 0 sobreviventes, 0 inválidas, `controle+ ✓` em todas**, com `baseline: ✓ verde` nas 6
invocações do harness (ele aborta se a suíte já está vermelha) e padrões perl em **ASCII de caixa fixa**
(lição #1483) — o único byte não-ASCII nos contratos está em RÓTULO, nunca em padrão.

O RED foi dirigido ao cenário medido — cheio → parcial de 1 edge → cheio, com a vítima muda nos dois
disparos DELA: `achados` saía `[]` e o AVISO ocupava o lugar da acusação. O **controle** na mesma
invocação (a mesma edge respondendo) já estava verde antes da correção, que é o que separa um cenário
discriminante de um sempre-vermelho.

Uma mutação escrita a princípio foi **descartada por não poder pegar**: `idadeMin: Number(idade) || 0`
é equivalente a `Number(idade)` sob o guard `/^\d+(\.\d+)?$/` (o único valor que o `||` mudaria seria
`0`, e `Number("0") || 0 === 0`). Mutação que nenhum teste pode distinguir é teatro no contrato, não
cobertura — entraram no lugar duas que pinam o TEXTO do cabeçalho.

A leitura nova foi executada contra a prod via `psql-ro` (`-v ON_ERROR_STOP=1` + marcador positivo de
fim): 32 linhas, 16 edges, `n` entre 1 e 2, **2 disparos para cada uma das 16 ativas**, e 32/32 com
atestação pelo mesmo recorte. Na segunda passada as duas constantes foram **importadas do código** e
rodadas byte a byte, para a prova não ser de um SQL parecido com o que ficou no repo.

E o marcador positivo pagou-se na hora: uma tentativa cujo gerador falhou produziu um `.sql` **vazio**,
e o `psql-ro` saiu **0** — ausência do marcador foi o único sinal de que nada havia executado
([base](psql-ro-exit-zero-em-sql-que-falhou.md)).
