# Radar: gestor/master atribui o lead a um vendedor (2026-11-06)

**Pedido do founder**, olhando a ficha de MARQUES PLANEJADOS LTDA no `/radar`: "como sou master, já quero atribuir ao
vendedor que eu quiser aqui também". Entrega 1 de 3. As outras duas (sucessor declarado e rateio do histórico de compras)
seguem em desenho, à espera do OK.

## O que mudou
- **Migration `20261106221000_radar_atribuir_atendimento.sql`** (manual, no SQL Editor). Reusa o dono temporário da
  `20261029201200`, sem reescrever `radar_definir_atendimento`:
  - `radar_atendimentos.atribuido_por uuid`: quem passou o lead. NULL quando o próprio dono assumiu. Um CHECK impede
    `atribuido_por = dono_user_id`.
  - motivo de encerramento `reatribuido`: a posse de outro vendedor fecha com `encerrado_por` igual a quem atribuiu.
  - `public.radar_atribuir_atendimento(p_cnpj, p_dono)` tem gate de Radar e de gestor (`pode_ver_carteira_completa`).
    Usa as mesmas travas do definir (advisory por CNPJ e depois por dono, aqui o de destino), a mesma definição de posse
    ativa, o teto de 100 do destino e recusa destino fora da capability (`destino_sem_acesso`) e lead já cliente.
  - `public.radar_vendedores_atribuiveis()`: só gestor/master lê; lista quem passa em `private.cap_radar_prospectar`.
- **Ficha** (`RadarAtendimentoLead.tsx`): o botão "Atribuir" abre uma busca de vendedor e só aparece para quem passa em
  `podeGerirRadar`. Fica desligado na lente "Ver como" e some em já-cliente. Evento `radar.lead_atribuido`.
- O lead atribuído expira como os outros: 7 dias depois do último toque do NOVO dono.

## Prova
`db/test-radar-atribuir-atendimento.sh` (núcleo do CI): 36 asserts e 8 sabotagens, todas vermelhas com controle verde
na mesma invocação. A negação casa a SQLSTATE **e** a mensagem do ramo (`42501:forbidden: gestor/master only` ≠
`42501:forbidden: radar_prospectar`). O harness irmão `db/test-radar-acesso-vendedor.sh` segue com 81/0 com esta
migration na cadeia. No vitest, o parser e o componente foram falsificados: sem o gate de UI e com o destino trocado, os
testes ficam vermelhos.

## Deploy
Migration manual (founder no SQL Editor, validada por psql-ro) **antes** do Publish. Sem a migration, o botão
"Atribuir" abre a lista com erro de função, e o erro aparece na própria lista, nunca uma lista vazia.

## De passagem
A main estava vermelha no typecheck e no `casts:stale`. O sync do Lovable `e313f7c55` ("Work in progress")
regenerou `types.ts` sem os args do pacote C (`p_municipio_codigo`, `p_com_telefone`, `p_ufs`), que existem em prod
(conferido por psql-ro). Este PR restaura as mesmas linhas que os #3679, #3680 e #3682 e tira o cast `as never`
obsoleto do `PedidosPortalCard`.
