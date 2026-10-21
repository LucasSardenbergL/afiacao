# DRE consolidado intercompany: venda intragrupo SEM COBRANÇA elimina só do CMV (2026-10-21)

**O caso (psql-ro 2026-10-21):** a oben tem 3 CP intragrupo sem CR do lado vendedor. São colacor→oben
90.000,00 (jan/26, cat 2.01.01), colacor→oben 90.000,00 (fev/26, 2.01.01) e colacor_sc→oben 21.597,61
(fev/26, 2.01.04). O `fin-ic-reconcile` os gravou como `sem_contrapartida` CP-only. O founder confirmou
que são vendas reais que ele decidiu não cobrar. A mercadoria já está no CMV de quem vendeu (compra ao
fornecedor), e o CMV da oben a conta de novo. Não há receita a eliminar, então o consolidado
**subestimava** o resultado em 90.000,00 (jan) e 111.597,61 (fev). O desenho do par CR↔CP (#3292) não
cobria o caso, porque só elimina receita e CMV juntos.

Os 3 CP estão `PAGO` com `valor_pago` 0, `saldo` cheio e sem `data_pagamento`. O status do Omie não
reflete dinheiro movido. A RPC usa `valor_documento` (competência).

## O conserto (migration `20261021190000_fin_ic_venda_sem_cobranca.sql`)

- **Status novo** `intragrupo_sem_cobranca` em `fin_ic_matches` (CHECK ampliado). Ele está fora dos
  informativos do reconcile, que só apaga `divergencia_*`, `sem_contrapartida` e `duplicidade_possivel`
  não resolvidos. Por isso a edge nunca desfaz a marcação e trava o CP fora do pool (`separarExistentes`
  trata qualquer outro status como travado). A edge não mudou.
- **Trigger** `fin_ic_matches_guarda_sem_cobranca` (BEFORE INSERT/UPDATE/DELETE) fecha a classe, para
  PostgREST cru e SQL futuro:
  - só o **master** entra e sai do status, e employee e service_role levam 42501;
  - só se entra a partir de `sem_contrapartida` com CP e sem CR, sem mudar títulos;
  - só se sai para `sem_contrapartida` não resolvido, e a próxima rodada da edge refaz a linha e pode casar
    o CP com um CR que tenha aparecido;
  - INSERT direto no status e DELETE da linha marcada são recusados;
  - títulos, empresas e carimbo ficam imutáveis enquanto a linha estiver marcada;
  - o carimbo `resolvido_por/em` é do trigger, não do cliente.
  - o papel só é lido nas transições do status: as escritas normais da edge (INSERT/DELETE como
    service_role) não chamam `auth.uid()` nem `has_role` (T15/T16).
- **RPC**: a linha marcada elimina o CP só do CMV do destino, quando PROVADA como o par. Exige:
  - CP do destino, emitido no mês, não CANCELADO nem sem status, valor > 0 e uso único entre tudo o que
    elimina (par ou sem cobrança);
  - categoria que compôs SÓ `cmv` no snapshot do destino, com a soma atual da categoria igual à composição;
  - origem e destino na soma (senão é compra de quem está fora, e não elimina nem pende);
  - nenhum **"CR aparecido"**: linha informativa da edge, na mesma direção, com CR de mesmo valor ou
    emitido a até 30 dias do CP (ou sem data), contradiz a marcação, e o mês pende até o founder
    desconsiderar o CR ou desfazer.

  O teto por categoria do destino soma o par e a venda sem cobrança. Linhas: receita −E_par,
  cmv −(E_par + E_sc), despesas 0, resultado **+E_sc** (o motor é linear em `cmv`). Marcada e não provada,
  as 4 linhas saem NULL ("eliminação pendente"), como no par.
- **Fila**: o botão "Sem cobrança" aparece só para o master e só em CP sem CR. "Desfazer" aparece na linha
  marcada. "Aprovar" some das linhas de um lado só, porque confirmar um lado só deixava o mês inteiro
  pendente. A gravação só conta como sucesso se o banco devolver a linha: 0 linhas (RLS, ou a edge refez a
  linha entre a leitura e o clique) antes virava toast de sucesso sobre decisão não gravada.
- **Tela**: avisa "inclui R$ X de venda intragrupo sem cobrança". O valor é a eliminação do
  `resultado_liquido`, e a eliminação positiva sai verde, não vermelha.
- **Descongelamento**: `/financeiro/intercompany` estava 🧊 (M-41, motivo "0 linha em fin_ic_matches"),
  com a rota voltando para `/`. O reconcile gravou 21 linhas hoje e a fila é onde o founder decide, então
  o prefixo saiu de `rotasCongeladas` no manifesto.

## Medição na prod (psql-ro, corpo como SELECT, 46 meses com snapshot competência)

- O corpo novo dá o mesmo resultado que o vivo (md5 11832f17…) nos 46 meses: 184 linhas iguais e nenhum
  mês pendente.
- Simulando os 3 CP marcados, só mudam jan/26 (CMV −90.000,00 e resultado +90.000,00, de −71.043,00
  para 18.957,00) e fev/26 (CMV −111.597,61 e resultado +111.597,61, de −121.983,22 para −10.385,61).
  A receita fica igual.
- As categorias 2.01.01 e 2.01.04 da oben compõem só `cmv` em jan e fev, e a soma atual bate com a
  composição.

## Prova

`db/test-fin-consolidado-ic.sh` aplica a migration REAL sobre o predecessor REAL (o corpo vivo
11832f17…). Os cenários A–P da versão anterior são re-exercidos sob a versão nova, mais U (venda sem
cobrança), T (trigger) e MIG5/MIG7: 79 asserts, nos locales `C` e `pt_BR.UTF-8`, com `--falsificar`.

**Achado da falsificação:** `sc_marca_cr` e `sc_empresa` ficaram VERDES na 1ª rodada. O cenário S1
deixava uma linha informativa oben→colacor de 100, que é "CR aparecido" para qualquer sem cobrança
oben→colacor de 100. U14 e U16 pendiam pela trava errada (duas defesas no mesmo assert). Eles passaram
para colacor_sc→colacor.

**2º achado:** com o ramo DELETE do trigger desligado (`trg_delete`), o T10 seguiu VERDE. O DELETE caía no
ramo SAI (`NEW` é NULL, então `NEW.status IS DISTINCT FROM 'intragrupo_sem_cobranca'`), que também levanta
42501 ("so o master desfaz"). O T10 casava só a SQLSTATE, e dois ramos davam o mesmo código. Agora ele casa
também a marca do ramo ("nao se apaga"). Final: 51 sabotagens vermelhas, 0 falhas, controle verde, nos dois
locales.

## Lições

- **Rota congelada é estado de PRODUTO a conferir antes de pedir ação ao founder.** As sessões anteriores
  pediam "confirme na fila", e a rota ia para `/`. O critério do congelamento (tabela vazia) tinha
  deixado de valer no mesmo dia.
- **Escrita via PostgREST que devolve 0 linhas não é sucesso.** Com RLS, ou com a linha refeita por outro
  writer, `update().eq()` não dá erro. Peça `.select('id')` e exija a linha.
- **Mesma SQLSTATE em dois ramos mascara um deles.** O assert negativo precisa casar a marca do ramo,
  não só o código.
- **Semente global contamina predicados por existência.** Um "existe linha X na mesma direção" vê todas
  as linhas da semente, não só as do cenário. A falsificação foi o que mostrou isso.
