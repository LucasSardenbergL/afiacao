# O motor de compras desconta o vendido em pedido aberto no Omie (2026-10-10)

Migration `20261010210000_motor_desconta_comprometido.sql` · prova `db/test-motor-desconta-comprometido.sh` ·
validador `db/valida-motor-desconta-comprometido.sql` · regra viva em [reposicao.md](../agent/reposicao.md).

## O defeito

O Omie da Oben **não reserva** estoque: `sku_estoque_atual.estoque_disponivel = físico` em 500/500 SKUs, e o
físico só baixa na NF. O motor (`gerar_pedidos_sugeridos_ciclo`) não lia `sales_orders`, então via como livre o que
já tinha dono. Caso medido: CATALISADOR FC.7074QT, pp 9, máx 16, efetivo 12 com 4 vendidos em aberto — o motor não
comprava; o certo era 8 de efetivo e compra de 8.

## O que foi medido antes de desenhar (psql-ro)

- **Status.** Mapa da etapa Omie (`omie-vendas-sync`): 10→`importado`, 20 (Separar estoque)→`enviado`, 50
  (Faturar)→`separacao`, 60/70→`faturado`. Os três "abertos" são todos **pré-NF** — descontá-los não é dupla
  contagem com o físico.
- **Frescor.** `omie_reconciliado_em` é carimbado quando o pedido volta num `ListarPedidos` por inclusão OU alteração
  (2/2h janela 7d; 1×/dia 30d). Há ~2.500 abertos velhos (desde 2025-07) sem releitura: lixo. Idade da releitura dos
  abertos: <3h 31 · 6-12h 66 · 26-36h 13 · 50-100h 7 · >170h 81.
- **Identidade.** 0 `omie_pedido_id` duplicado entre importados; os 19 push abertos ficam fora pelo hash.
- **Unidade.** Fora de grupo, os SKUs com comprometido são 125 UN, 2 CX, 1 KG, 1 PCT (quantidade inteira, mesma
  unidade do estoque). Dentro de grupo (WP, estoque em L) a venda vem **ora em litro (múltiplo de 0,81), ora inteira**
  — ambígua. Só 2 SKUs de grupo tinham comprometido.
- **Parcial.** Em 180 dias, 2.323 pedidos e **1** número repetido (12580): origem `importado` e irmão `faturado` com
  itens e quantidades idênticos (inclusive um item ×2 — não é o `quantidade || 1` do produtor). A origem segue aberta
  com a quantidade ORIGINAL depois que o conteúdo foi faturado por outro pedido.
- **Permissão.** O motor é INVOKER e o "Recalcular" roda como o staff (master — `cap_compras_ler`). `authenticated`
  **não** tinha SELECT em `sales_orders.omie_reconciliado_em` (o hardening por coluna da 20260709163500): sem GRANT, o
  recálculo manual INTEIRO cairia com 42501; o cron (service_role) passaria — falha só de um lado.
- **Impacto (réplica do gatilho, janela 36h):** 21 SKUs viram de "não compra" para "compra" (7d: 23).

## Desenho (Codex, 2 consultas)

Desenho: **aprovar com mudanças, sem P0**. Os P1 que entraram: o desconto no SELECT **e** no WHERE do gatilho (provado
por sabotagens separadas); o GRANT da coluna (confirmado em prod); cast sob `CASE` (a ordem do WHERE não é garantida);
a tela mostrar o desconto (a conta "físico + a caminho" ficaria falsa); o parcial (virou a regra do número repetido,
medida). Janela 36h **constante** — config livre transformaria 36h em 7d sem análise; o que a config faz é desligar.
Efetivo negativo sem clamp (clampar esconderia o que falta para atender o pedido). Grupos WP fora no v1.

## A prova

38 asserts com o motor executado sobre schema + ACL de prod (`db/lib/corpo-vivo-acl.sql`): positivos, cada filtro
violado, fronteira 35h×37h, grupo WP byte-idêntico, efetivo negativo, teto com piso de serviço, mínimo forçado, gate
de estoque não confirmado (loga o efetivo descontado), desligador, o motor como master autenticado, e todo o resto
byte-idêntico ao antigo. Falsificação: controle verde + 19 sabotagens no assert declarado, em `C` e `pt_BR.UTF-8`.

**O que a falsificação ensinou:** o guard `AND ea.grupo_id IS NULL` no JOIN do comprometido ficou **verde** sabotado —
é redundante por construção (no grupo, efetivo e gatilho vêm de `ge.estoque_grupo`, que não lê `cp`). A propriedade
segue provada (W1); a sabotagem passou a mirar o `CASE` do rastro, que é a camada que decide. E três sabotagens do
1º laço eram do arnês, não do código: troca em 2 chamadas não acumulava, um padrão casava 2× (o do teto), um "verde
esperado" lia a coluna sabotada.

## Limites aceitos (freio = aprovação humana; auto-aprovação desligada)

- NF emitida entre a releitura do pedido e o sync do físico conta 2× por até ~2h; com a reconciliação parada, até 36h.
- Pedido EXCLUÍDO no Omie não volta na listagem: conta até 36h.
- O produtor grava `quantidade || 1` (0/ausente vira 1) — sem efeito medido.
- "Sincronizar e recalcular" ressincroniza estoque e status de produto, **não** pedidos de venda.
- As views de exibição `v_reposicao_sku_sem_fornecedor` e `v_sugestao_negociacao_ativa` calculam um "efetivo" próprio
  sem o desconto (fora do escopo; não decidem compra).

## Revisão adversarial e apply

Codex no diff: **aprovar com mudanças, sem P0/P1**; 4 P2, todos corrigidos — a tela arredondava (0,6 − 0,4 virava
"1 − 0", −0,2 virava "−0") → formatador com fração; a re-medição do ACL deixaria a sabotagem `sem_grant` sem dente → a
prova REVOGA e AFIRMA (P03) o estado predecessor; a prova fora do CI → entrou no núcleo (`falsificar=fora-do-ci`,
≈ +5 min); o validador podia sair verde com o motor ausente → bloco `DO` que exige 4/4 e aborta (medido: `exit 3`
antes do apply, nomeando corpo/coluna/grant).

Apply: `db:aplicar --ensaio` exit 0 → `db:aplicar` exit 0 (recibo #320) → `db/valida-motor-desconta-comprometido.sql`
por psql-ro: 4/4, exit 0. ACL de prod re-medido (`corpo-vivo-acl.sql`) e carimbo authz gravado; a `deriva:corpo:prod`
acusa o motor até o merge (DDL aplicada antes do merge — esperado).

Decisão esperada no 1º ciclo (09:15 UTC de 2026-10-11), pela mesma conta do motor: FC.7074QT 12→8 ≤ 9 entra (8);
DEZ.8014QT 8→5 ≤ 6 entra (8 antes do teto B); FCA.6888LT 7→2 ≤ 4 entra (4); **FCA.7090QT 15→9 > 4 NÃO entra** — já há
11 a caminho (6 pendentes no Omie + 5 em trânsito no app) cobrindo os 6 vendidos. Estimativa bruta do desconto no
universo: 21 SKUs viram compra (≈ R$ 29,6 mil antes de teto/mínimo/arredondamento) e +R$ 6,5 mil em 8 que já compravam.

Lição de processo: editar um arquivo que a falsificação em voo LÊ (`corpo-vivo-acl.sql`) produziu um vermelho de
SINTAXE numa sabotagem — leitura no meio da escrita. A rodada inteira foi refeita sem tocar em nada.
