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

## Achados do Codex adversarial (2026-10-26) e o conserto

O 1º desenho só via o "CR aparecido" pelas linhas informativas da edge. O Codex mostrou que isso fazia
de linhas DESCARTÁVEIS uma evidência de dinheiro:

1. **P0:** a edge apaga as informativas e reinsere em outra requisição (`publicarMatches`). Na janela, ou
   se o INSERT falha (UNIQUE, 500, "nada novo gravado"), o CR que contradiz a marcação some, e a RPC
   eliminava o CP.
2. **P0:** `vivo()` descarta CR sem `data_emissao`, que nunca vira linha. Na prod são 37 CR assim (de
   45.470).
3. **P1:** um 2º "Desfazer" (outra aba) regravava `sem_contrapartida` JÁ resolvido. A edge trata linha
   resolvida como travada, e o CP nunca mais casaria.
4. **P2:** o T15 reusava o CP de outra linha, o que o UNIQUE parcial da prod recusaria.

**Conserto, sem mexer na edge:** o "CR aparecido" parte de `fin_contas_receber` (CR da origem, não
cancelado, mesmo valor, sem emissão ou a ≤30 dias) e conta se:
- (a) há informativa da edge na mesma direção, ou
- (b) o mapa de identidade (`omie_customer_account_map` por documento + `company_cnpjs`, que a edge
  confere contra o Omie) diz que o cliente é o destino, e o CR não está num par confirmado nem
  desconsiderado.

Na prod, o mapa cobre os 15 CR que já estão em linhas da fila. O "Desfazer" grava com
`.eq('status', <lido>)`, e o 2º clique atualiza 0 linhas e vira erro. A prova ganhou U19–U24 e U10c
(CR só na tabela, sem linha na fila), e o T15 passou a usar um CP próprio. Resíduo conhecido: par de
empresas sem código no mapa (hoje colacor→colacor_sc) só bloqueia por (a).

**2ª rodada do Codex (mesmo dia):**
- **P0, cobertura:** o mapa de identidade depende de um usuário vinculado ao cadastro, e o
  `omie-analytics-sync` apaga o vínculo quando acha 2 códigos para o mesmo documento. "15/15 da fila"
  não prova completude.
- **P1, par órfão:** um par auto/manual com `cp_id` NULL tirava o CR de cena.
- **P2, bloqueio sem botão:** um CR do grupo sem emissão pendura o mês e não aparece na fila. Ficou
  como resíduo, porque falha para o lado seguro, e a prod não tem nenhum caso.

**Conserto, por decisão do founder (a edge muda):**
- Tabela `fin_ic_contrapartes` (empresa, código Omie, empresa alvo), só-acrescenta. A ACL dá à edge
  SELECT e INSERT, ao `claude_ro` SELECT, e mais nada. O REVOKE vale para todo grantee não-dono,
  porque o default privileges da prod dá ALL a anon/authenticated e SELECT+INSERT ao `sandbox_exec`.
- A `fin-ic-reconcile` v1.3 grava ali o mapa que já monta do Omie (ListarClientes por CNPJ, fail-closed),
  antes de publicar. Se a gravação falha, a edge devolve 500 sem tocar a fila.
- A RPC aceita esse mapa ou o de identidade.
- Um par só tira o CR de cena com um CP de verdade e diferente do marcado.

Na implantação, a ordem é: migration, merge, deploy da edge, uma rodada da edge, e conferir o mapa
populado antes do founder marcar.

**3ª rodada do Codex:**
- Um código intragrupo novo, ainda não gravado, ficava invisível até a próxima rodada.
- No bootstrap, um código que só uma informativa antiga conhecia podia sumir.
- Havia defeitos de falsificação e o P7 não conferia o default.

O conserto trouxe:
- a semente do mapa no apply, com os códigos das linhas da fila;
- o marco de rodada `fin_ic_reconcile_rodadas`, gravado pela edge depois do mapa;
- um ramo (c) de "contraparte desconhecida": CR criado depois do marco, com código fora dos mapas, pendia.

**4ª rodada e decisão do founder (2026-10-27): parar a escalada.**

O ramo (c) tinha brechas próprias:
- um CR sem código deixava de bloquear quando o marco avançava;
- um CR antigo que troca de cadastro passava.

E criava um problema operacional: um CR de terceiro com o mesmo valor, ou sem emissão, pendurava o mês
sem aparecer na fila. O ramo (c) saiu. O marco ficou só como **trava de bootstrap**: sem nenhuma rodada
da v1.3, nada elimina.

**Resíduo aceito:** um CR que contradiz a marcação, de cadastro que nenhum mapa conhece ainda, só é
visto na rodada seguinte da edge. É a mesma latência que o par CR↔CP já tem. CR sem código de cliente
não é classificado, e a prod tinha 0 em 2026-10-27.

Prova final: 102 asserts, 70 sabotagens, 47 testes Deno.

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
cobrança), T (trigger) e MIG5/MIG7: 102 asserts e 70 sabotagens, nos locales `C` e `pt_BR.UTF-8`, com `--falsificar`.

**Achado da falsificação:** `sc_marca_cr` e `sc_empresa` ficaram VERDES na 1ª rodada. O cenário S1
deixava uma linha informativa oben→colacor de 100, que é "CR aparecido" para qualquer sem cobrança
oben→colacor de 100. U14 e U16 pendiam pela trava errada (duas defesas no mesmo assert). Eles passaram
para colacor_sc→colacor.

**2º achado:** com o ramo DELETE do trigger desligado (`trg_delete`), o T10 seguiu VERDE. O DELETE caía no
ramo SAI (`NEW` é NULL, então `NEW.status IS DISTINCT FROM 'intragrupo_sem_cobranca'`), que também levanta
42501 ("so o master desfaz"). O T10 casava só a SQLSTATE, e dois ramos davam o mesmo código. Agora ele casa
também a marca do ramo ("nao se apaga"). Final: 51 sabotagens vermelhas, 0 falhas, controle verde, nos dois
locales.

## Deploy (2026-10-27/28)

- **Migration:** aplicada pelo `db:aplicar`, recibo da tentativa #736. Postcondição por psql-ro:
  - md5 do RPC `b47040c0…` e do trigger `1a3a3cc9…`;
  - CHECK com o status novo, trigger tgtype 31 ligado;
  - as 2 tabelas com RLS e ACL `claude_ro=r`/`service_role=ar`;
  - semente com 5 linhas.
- **PR #3381:** mergeado em 2026-10-28 02:06Z.
- **Edge `fin-ic-reconcile` v1.3:** colada pelo MCP às 02:11Z, por outra sessão. O agente conferiu 17/17 hashes contra `0e15d81c`. Os commits do bot que vieram depois só tocaram `types.ts`.
  - Sonda `db/sonda-disparo-fin-ic-reconcile-v1.3.sql` (#739, request 135067): **DEPLOY CONFIRMADO**, fonte `ebc3e399…`. `pendencias:deploy` passou a sair 0.
- **Simular** (#740, request 135068): HTTP 200, 10 `sem_contrapartida`, 11 pares preservados. O mapa do Omie devolveu os mesmos 5 códigos da semente.
- **1ª escrita** (#741, request 135069): HTTP 200.
  - `fin_ic_reconcile_rodadas` ganhou o marco id=1 (`mapa_lido_em` 02:37:35Z), e a trava de bootstrap abriu.
  - O mapa segue com 5 linhas, porque o upsert só acrescenta e os códigos eram os mesmos.
  - A fila tem 11 `auto_matched` e 10 `sem_contrapartida`, e entre elas os 3 CP da oben.
- **Publish:** no ar em 2026-10-28; o build servido bate com a main `f03a8d89`.
- **Marcação (founder, 2026-10-31 17:14Z):** as 3 linhas passaram a `intragrupo_sem_cobranca`, com `resolvido_por`
  preenchido. A fila ficou com 11 `auto_matched`, 3 sem cobrança e 7 `sem_contrapartida`.
- **Conferência (psql-ro, corpo vivo da RPC como SELECT, `prosrc` md5 `83509e1a…`):** igual à simulação.
  - 2026-01: CMV 295.585,86 → 205.585,86 (−90.000,00); resultado −71.043,00 → 18.957,00.
  - 2026-02: CMV 244.033,03 → 132.435,42 (−111.597,61); resultado −121.983,22 → −10.385,61.
  - Receita e despesas com eliminação 0 nos dois meses.

## Lições

- **Rota congelada é estado de PRODUTO a conferir antes de pedir ação ao founder.** As sessões anteriores
  pediam "confirme na fila", e a rota ia para `/`. O critério do congelamento (tabela vazia) tinha
  deixado de valer no mesmo dia.
- **Escrita via PostgREST que devolve 0 linhas não é sucesso.** Com RLS, ou com a linha refeita por outro
  writer, `update().eq()` não dá erro. Peça `.select('id')` e exija a linha.
- **Mesma SQLSTATE em dois ramos mascara um deles.** O assert negativo precisa casar a marca do ramo,
  não só o código.
- **Evidência de dinheiro só cresce.** Se outro writer apaga e recria a fonte, ou ela depende de um
  vínculo que outra edge pode apagar, ela não serve. A fonte certa é uma tabela só-acrescenta, alimentada
  por quem tem a verdade (o Omie).
- **Linha que outro writer apaga e recria não é evidência de dinheiro.** Se a decisão depende da
  AUSÊNCIA de uma linha, a fonte tem de ser durável (a tabela de títulos), não o espelho descartável.
- **Semente global contamina predicados por existência.** Um "existe linha X na mesma direção" vê todas
  as linhas da semente, não só as do cenário. A falsificação foi o que mostrou isso.
