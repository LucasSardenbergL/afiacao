# Rotação automática da senha do portal Sayerlack (2026-11-19)

**Incidente:** pedido 4505 parou às 03:00 de 2026-11-19 com `PASSWORD_CHANGE_REQUIRED`: a senha do usuário do portal
expirou no SSO TOTVS (`pedidos1.sayerlack.com.br:8092/totvs-login`, para onde o login do `:9092` redireciona). A senha
vivia só no env `SAYERLACK_PORTAL_PASS`, que nenhuma edge regrava, então toda expiração parava os pedidos até o founder agir.

**Entrega:** a senha passou para o Vault (migration `20261120130000`), e a edge `sayerlack-rotacionar-senha` é o escritor
único dela. As 4 edges que logam no portal leem a senha por `_shared/sayerlack-credencial.ts` (fail-closed) e pedem
a rotação quando veem a senha expirada.

## Invariantes (revisão Codex challenge — P0/P1)
- **A candidata é gravada antes do POST** e fica presa à rodada dona (`description` do segredo = id da rodada). Rodada
  atrasada nunca promove ou descarta a candidata de outra.
- **`post_pode_ter_saido` é gravado antes do clique.** Daí em diante, a rodada nunca faz outro POST: órfã vira
  `ambigua` e só reconcilia por login com a candidata (no máximo 3 tentativas). O TTL nunca autoriza um 2º POST.
- **Descartar só com recusa inequívoca** (formulário de troca de volta na tela + termo de recusa), ou com prova de que
  não houve POST (`cliqueFeito=false`). "Sua senha expirou" na tela não conta como recusa.
- **Promover só com login real que chega ao dashboard.** Promoção, e-mail pendente e reenfileiramento acontecem numa
  transação só. Reenfileira apenas pedido cuja ÚLTIMA tentativa foi `PASSWORD_CHANGE_REQUIRED` com
  `efetivarAttempted=false` e sem protocolo (CAS em `erro_nao_retentavel`).
- **Rodada aberta ⇒ as 4 edges não logam:** sem rajada de login com senha velha e sem consumir tentativa de pedido.
- **Quarentena de 6h depois de uma troca recusada:** cada rodada autentica com a senha atual, e repetir em laço leva ao bloqueio.
- **E-mail só com a senha confirmada**, e só se a ativa ainda for a versão daquela rodada. Rodada ambígua manda alerta sem senha.
- A senha nunca vai para log, diagnóstico ou alerta (`fornecedor_alerta` é notificado por e-mail a terceiros).

## Risco que já existia (não piorou)
O portal e o SSO são **HTTP puro**: as edges já mandavam a senha em claro a cada login. A rotação acrescenta um envio
a cada expiração. Cobrar HTTPS da Sayerlack.

## Provas
- `db/test-sayerlack-senha-portal.sh`: 41 asserts em PG17 (Vault simulado com as assinaturas da PROD), nos dois locales.
  `--falsificar` derruba 10 sabotagens, cada uma pelo assert certo, com controle verde.
- Deno: lógica pura (`logica_test.ts`), helper de credencial e handlers de importar/varrer com credencial bloqueada ou
  ilegível. A sabotagem "erro na RPC cai no env" é pega por 3 testes.
- **Não provado em produção até a 1ª expiração real:** o texto exato de sucesso/recusa do TOTVS. Por isso a classificação
  é conservadora (o que não for inequívoco é ambíguo e para tudo).
