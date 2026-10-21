# DRE consolidado intercompany: a eliminação SOMAVA ao CMV (2026-10-21)

**Achado:** PR #3272 (remoção de casts no financeiro). A tela `/financeiro/intercompany` voltou a ler as
colunas reais da RPC `fin_consolidado_intercompany`, mas não podia mostrar o CMV consolidado: a RPC
fazia `cmv + valor_elim`, e o CMV é gravado **positivo** em `fin_dre_snapshots` (o motor faz
`lucro_bruto = receita_liquida - cmv`; prod 2026-10-20: 91 linhas > 0, 23 = 0, nenhuma < 0). O
consolidado do CMV saía inflado em 2×E em vez de reduzido. A borda mostrava "—" de propósito.

**Latente em prod:** `fin_ic_matches` tem **0 linhas**. O `fin-ic-reconcile` casa CR↔CP pelo CNPJ da
contraparte, e `cnpj_cpf` está vazio em 100% dos CR (45.386) e CP (16.248) — medido via psql-ro em
2026-10-21. Nenhum número errado chegou a ser exibido, e **eliminação 0 hoje quer dizer "nenhuma
eliminação identificada", não "não houve operação intercompany"**. Esse defeito do reconcile é separado.

## O conserto (migration `20261021120000_fin_consolidado_ic_sinal_cmv.sql`)

- Receita e CMV caem pelo **mesmo** valor E; despesas e resultado com eliminação 0 (resultado intacto).
- O desenho inicial era só trocar o sinal. O **Codex de DESENHO** confirmou o sinal e mostrou que
  "match confirmado + snapshot das duas empresas" não prova que o par compôs receita e CMV no mês:
  título classificado em despesa, CP no mês seguinte, `manual_matched` sem contrapartida ou com valor
  divergente, título cancelado (o motor o exclui), snapshot calculado antes do título. Em cada caso, a
  regra "só o sinal" passava no "resultado intacto" com linhas erradas.
- Elegibilidade **provada pelo próprio snapshot**, sem espelhar o classificador do motor: o snapshot
  guarda `detalhamento.composicao_receitas/despesas` por chave de categoria (`categoria_descricao`, senão
  `categoria_codigo`, senão `Sem categoria`), com a linha do DRE em que cada uma caiu. O par só elimina se
  a categoria do CR compôs **só** `receita_bruta` na origem e a do CP **só** `cmv` no destino, CR e CP no
  mês, mesma empresa do par, nenhum cancelado, `valor_documento` igual e > 0, títulos criados antes do
  cálculo do snapshot, cada título num par só, e o total eliminado de uma categoria ≤ o que ela compôs.
- Par confirmado que toca o mês e **não** é elegível ⇒ eliminação e consolidado **NULL nas 4 linhas**
  (precisão > recall). A tela mostra "—" e o aviso "eliminação pendente".
- Escopo da soma parcial: par com a origem ou o destino sem snapshot no mês é transação com quem está
  fora da soma — nem elimina, nem pende (a tela já avisa "soma parcial").
- Ausente ≠ zero: conta sem snapshot (ou com a coluna NULL em algum) ⇒ `total_bruto` NULL (era
  `COALESCE(SUM, 0)`). A borda lê com `anulavel(numero)` e a tela mostra "—".

**Fora do escopo (limitação do MODELO):** o CMV do motor é **compra por emissão**, não custo da mercadoria
vendida. Mercadoria IC ainda em estoque não tem o lucro não realizado eliminado (CPC 36 B86(c)); isso
pede outro motor de CMV, não esta RPC.

## Prova

`db/test-fin-consolidado-ic.sh` (no núcleo do CI): migration REAL sobre o predecessor REAL (md5 do
corpo vivo da prod conferido no próprio teste), 31 asserts, 17 sabotagens vermelhas com controle verde
na mesma invocação, nos locales `C` e `pt_BR.UTF-8`.

## Lições

- **"Resultado intacto" não prova eliminação certa.** A simetria esconde a conta errada: eliminar de CMV
  um custo que caiu em despesa mantém o resultado e erra duas linhas. O teste afirma as 4 linhas.
- **O snapshot que guarda a composição é a prova barata de elegibilidade.** Em vez de reclassificar em
  SQL (helper espelhado do TS), a RPC pergunta ao próprio snapshot em que linha a categoria caiu.
- **Tabela vazia em prod não é ausência de fenômeno:** 0 matches vinham de um writer que nunca casou,
  não de "não há intercompany".
