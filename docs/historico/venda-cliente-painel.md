# Venda por cliente — Task 7: painel do founder (2026-10-20)

**Entrega:** `/admin/venda-cliente` (master) — adoção por farmer × semana (na lista · mostrados · contatados ·
compraram · receita casada), conversão de recompra × linha de base (mesma semana do ano anterior e sombra),
estado das 3 ondas e a aba Repasses (aprovar/revogar, RPCs da Task 6). RPC `venda_painel(p_de, p_ate)`
(migration `20261020235000`, aplicada por `db:aplicar`, recibo #655). Sensor `venda.painel_aberto` no ledger.

**Decisões (detalhe no cabeçalho da migration):**
- Taxa = virou ÷ (virou + não virou), só `tipo='recompra'` (único tipo que a linha de base tem); `nao_medivel` e
  pendentes fora do denominador. A tela diz "não consegui medir" quando `nao_medivel` > 20% das avaliadas, e
  "aguardando janela" quando tudo ainda está aberto — nunca 0%.
- `base_confiavel` = existe `venda_onda_log` da Onda 1 (só o cron a liga, depois de 3 dias de lista idêntica).
  As colunas de base dizem "não consegui medir" até lá; a taxa ativa, que é medida, não depende disso.
- O painel não chama `venda_avaliar_ondas` (ela ESCREVE) nem `venda_lista_calc` (~8 s por dia, medido pela carga
  histórica): mostra os pré-requisitos baratos; o veredito da lista idêntica é do cron.

**Lição — a PRE anti-deriva pegou uma irmã no ENSAIO:** a 1ª versão deste PR recriava
`analytics_ledger_registrar` para acrescentar o evento. Entre o meu pré-voo e o ensaio, a sessão da Task 8
aplicou a dela (com o meu evento incluído). O `db:aplicar --ensaio` abortou na PRE (md5 vivo ≠ predecessor) —
sem a PRE, o `CREATE OR REPLACE` teria apagado os 3 eventos da Task 8 em silêncio. Resolução: retirar a minha e
levar o arquivo e o tipo da irmã **byte a byte** (mudança idêntica dos dois lados = merge limpo em qualquer ordem).
