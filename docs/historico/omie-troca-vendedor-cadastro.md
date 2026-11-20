# Troca de vendedor no cadastro do Omie (2026-11-20)

**Contexto.** A carteira é derivada do vendedor do cadastro do cliente no Omie. A Tatyana saiu. O PR #4031 remapeou os
6 códigos dela para a Regina em `omie_vendedor_map`, o que corrige o app, mas não o ERP. A edge
`omie-cliente-trocar-vendedor` corrige a fonte. Ela é a única via do app que regrava cadastro de cliente no Omie, e
regrava só `recomendacoes.codigo_vendedor`.

## Medido antes de construir

- **O lote 1 tem 3.769 cadastros**: oben 1.277 · colacor 1.264 · colacor_sc 1.228, que somam 1.336 users distintos.
  O "~1.272" do briefing era só a oben.
- **Código da Regina por conta.** Na oben e na colacor há um código só, ativo. Na colacor_sc há 7 códigos "REGINA" no
  mapa. O alvo escolhido é o 3545068880, que tem 1.431 clientes. A edge confere no ListarVendedores que ele existe,
  está ativo e tem o nome certo, e recusa a conta inteira se não estiver.
- **O Omie recusa a MESMA chamada com o mesmo param repetida em menos de 60s** (`REDUNDANT`). Por isso a releitura
  imediata é feita com ListarClientes filtrado pelo código, e a prova completa vem de um ConsultarCliente pelo menos 61s
  depois.
- **`recomendacoes` traz mais que o vendedor** (transportadora, boletos). O AlterarCliente reenvia o objeto inteiro.
- **O espelho atrasa.** O `carteira-rebuild` lê `omie_customer_account_map_fresco`, e o import semanal pula linha
  fresca. Sem atualizar o espelho, a troca levaria mais de 7 dias para aparecer na carteira.
- **`register_carteira_member` zera `evidence_document_normalized`**, que está preenchido em 26.653 de 26.662 linhas.
  Por isso a edge faz um UPDATE estreito, só do vendedor, e não mexe nem no `updated_at`, que é o TTL da view fresca.

## Desenho

- **Modos:** `dry_run`, `aplicar` (exige a frase de confirmação) e `verificar`.
- **Lotes:** `saida_vendedora` e `orfaos`. No `orfaos`, os candidatos vêm do espelho FRESCO.
- **Constantes:** origem e alvo ficam em `decisao.ts`, nunca no body.
- **Por cliente:**
  1. ConsultarCliente. A resposta tem de ser do código pedido.
  2. Pré-condição. Vendedor ilegível não conta como vazio.
  3. Recibo `indeterminado`, com o `recomendacoes` de antes.
  4. AlterarCliente.
  5. Releitura, sempre, mesmo depois de fault.
  6. UPDATE do espelho.
  7. Hash do cadastro, sem vendedor e sem `info`, depois de 61s ou mais.
- **O bloco PARA** em divergência, em escrita indeterminada e quando o espelho não atualiza.
- **Recibo:** `omie_cliente_vendedor_troca`, sem PII. TRUNCATE e DELETE estão revogados de todos os papéis.
- **Gate:** `authorizeCronOrStaff`. A ação só roda para master, service_role ou cron-secret, e nos dois últimos exige
  `autor` no body. Não há cron agendado.

## Risco residual aceito

Se alguém editar o MESMO cadastro no Omie no ~1s entre o ConsultarCliente e o AlterarCliente, o `recomendacoes`
reenviado sobrescreve essa edição. O recibo guarda o `recomendacoes` de antes, então dá para conferir e desfazer.

Dentro de um bloco, uma perda que só o hash enxerga é detectada depois de até `limite` escritas. Por isso o canário
vem antes do lote.

## Codex

Rodada 1, no código: 9 P1 e 3 P2, todos corrigidos com teste e falsificados (sabotagem → vermelho, com controle verde
na mesma invocação).
