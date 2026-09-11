# A conciliação que nunca rodou: a ótica bancária entra como DEFESA — e "dormente" foi medido, não suposto

**2026-09-10** · `src/services/financeiroConciliacao.ts` (extraído de `src/pages/FinanceiroConciliacao.tsx`) ·
money-path · consumidor 1 do [fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md](fin-movimentacoes-duas-oticas-do-mesmo-pagamento.md)

## O que o briefing supunha e o que a PROD respondeu

O briefing trazia a conciliação como "o consumidor mais grave": `gerarConciliacao` lê `fin_movimentacoes`
sem escolher a ótica, então o mesmo pagamento viraria dois itens do mesmo título na fila
`fin_conciliacao`. Antes de corrigir, medi se a fila existe:

| fato (psql-ro, 2026-09-10) | valor |
|---|---|
| `fin_conciliacao` — linhas / `n_tup_ins` desde a criação | **0 / 0** |
| `fin_permissoes` — linhas (e UI que a grave) | **0** (nenhuma) |
| policy de escrita `fin_conc_write` | exige `pode_conciliar` em `fin_permissoes` |

Toda gravação vinda do app é recusada pela RLS. O botão "Gerar Fila" funcionava assim: lia um recorte
arbitrário de 1.000 movimentos, fazia até 2.000 idas ao banco, via toda gravação ser recusada — e
anunciava **"0 itens gerados"** como sucesso, porque o `if (!error) criados++` engolia a recusa.

O defeito da ótica é real, mas **latente**. Com o dado na mão, o Lucas escolheu **defesa, só a ótica**
(entre defesa, defesa + idempotência, aposentar a página e só documentar).

## Por que a ótica bancária

Conciliação é extrato contra título: a pergunta é "cada movimento do BANCO está explicado?". A linha da
ótica do título é **derivada do próprio título**, então casa com ele por construção — um "conciliado"
que não pode falhar não é evidência de nada. E, com o título aberto (valor 0), vira "divergência". A
simulação da fila que o código antigo geraria sobre a população inteira:

| | itens |
|---|--:|
| sem filtro de ótica | 56.962 |
| só a ótica bancária | **31.160** |
| da ótica do título: "conciliado" falso (casa consigo mesmo) | 18.409 |
| da ótica do título: "divergência" falsa (título aberto) | 6.811 |
| de previsão | 580 |

O extrato **sem** título (transferência/tarifa) continua entrando como pendente: ao contrário do fluxo de
caixa operacional, que o descarta, aqui ele é justamente o que precisa de olho humano.

## O que mudou

- `gerarConciliacao` saiu da página para `gerarFilaConciliacao` (service), com a allowlist **positiva** e
  **na query** (`.in('categoria_descricao', ['CONTA_CORRENTE_REC','CONTA_CORRENTE_PAG'])` — o `.select()`
  não traz a coluna, e filtrar em JS por ela zeraria a fila).
- A leitura dos movimentos que falha **rejeita** — antes, um timeout virava "0 itens gerados". A busca
  de título que falha e a gravação recusada são **contadas** como itens não gerados (a busca não vira
  "sem match", que gravaria o item pendente com o título lá), e o toast diz "N de M itens não gerados"
  com o motivo. Contar, e não abortar, na busca: um timeout no item 500 não pode esconder quantos
  ficaram de fora nem deixar 499 gravados atrás de um "Erro" genérico.
- Todo o resto ficou como estava, de propósito (abaixo). Conferido na PROD que a busca CR→CP sem olhar
  o tipo não erra: todo `CONTA_CORRENTE_PAG` casa só com CP (5.203) e todo `REC` só com CR (19.905).

## A prova

`src/services/__tests__/gerarFilaConciliacao.test.ts` — **11 testes**, fixture com as SEIS óticas mais
categoria nula e desconhecida, e o mock projeta só as colunas do `.select()` (a lição do #2443).

| sabotagem no service | caem |
|---|---|
| F1 sem a allowlist | 6 (ótica + contagens) |
| F2 filtro em JS sobre coluna não selecionada | 6 (a fila zera) |
| F3 negação `NOT LIKE 'CONTA_A_%'` | 4 (previsão e ótica desconhecida entram) |
| F4 engolir a gravação recusada | 1 — o da contagem |
| F5 leitura que falha vira vazio | 1 — o dela |
| F6 busca que falha vira "sem match" | 1 — o dela |
| F7 sem o filtro `conciliado = false` | 4 (o já-conciliado volta à fila) |

Controle 11/11 antes e depois, na mesma invocação; a suíte roda inteira em toda sabotagem (o total é o
sinal de que rodou). A suíte **não** afirma o status das baixas parciais: hoje elas saem "divergência"
contra o `valor_documento`, e um assert disso canonizaria o defeito (f).

**Revisão independente: PENDENTE.** A cota do Codex esgotou nesta sessão (`COTA_ESGOTADA`, exit 75,
depois de revisar o consumidor 3). Caminho B: a falsificação acima + um auto-challenge, que achou três
coisas no meu próprio código antes do PR — o `throw` na busca de título deixava fila parcial sem
contagem (virou contagem), nenhuma fixture pegava a remoção do filtro `conciliado` (F7 novo), e faltava
o pré-requisito (g). Rodar o Codex retroativo quando a cota voltar.

## Pré-requisitos para LIGAR a conciliação (fora do escopo, decisão do Lucas)

Esta entrega não torna a feature pronta. Antes de conceder `pode_conciliar` a alguém:

- **(a)** idempotência: `onConflict: 'id'` sem `id` no payload insere de novo a cada clique — precisa de
  `UNIQUE(mov_id)` + ignorar duplicata (sobrescrever apagaria item já resolvido);
- **(b)** `fin_movimentacoes.conciliado` nunca é atualizado pelo resolver, e **(c)** o sync regrava
  `conciliado:false` a cada carga — o estado tem de morar em `fin_conciliacao`, com um escritor só;
- **(d)** o `resolver` da página descarta o `error` do UPDATE (toast de sucesso na recusa — é a 1 dívida
  da página na baseline do `escrita-critica-gate`);
- **(e)** a leitura não pagina (capa de 1.000 sobre ~31 mil movimentos bancários) e faz N+1;
- **(f)** a regra de valor compara a baixa com o `valor_documento` — baixa parcial, juros e desconto viram
  "divergência" (8.678 itens na simulação);
- **(g)** a tela: o `load()` descarta o `error` das três leituras e conta os status sobre uma leitura com
  capa de 1.000 — acima disso o total e o "% conciliado" mentem.

## Lições

1. **"O mais grave" é premissa até medir se RODA.** Tabela com `n_tup_ins = 0` e policy de escrita que
   ninguém satisfaz dizem mais sobre a gravidade do que a leitura do código. Duas queries viraram a
   prioridade do briefing — e a decisão voltou para o dono com o número na mão.
2. **Defesa inerte é legítima — desde que se diga que é defesa.** O código, o teste e este registro dizem
   "inerte hoje" e listam o que falta; senão a correção passa a impressão de que a feature funciona.
3. **Um casamento que não pode falhar não é evidência.** A linha da ótica do título casa com o próprio
   título por construção. Um "conciliado" produzido assim infla a taxa de conciliação sem conciliar nada.
