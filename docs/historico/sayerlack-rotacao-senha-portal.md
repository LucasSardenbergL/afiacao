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

## 1ª troca real — recusada (2026-11-20, rodada `c36305cb`)

- Disparo manual às 01:15 UTC: o POST saiu (`cliqueFeito: true`), e o TOTVS devolveu a tela de troca com termo de recusa. A rotacionadora seguiu o previsto: descartou a candidata, mandou o alerta urgente, não mandou e-mail e pôs 6 h de quarentena.
- **Prova de que não houve lockout:** um único login com a senha do env (`adotar_env`) devolveu `troca_de_senha`. A senha antiga segue valendo e só está vencida, então a candidata descartada nunca virou a senha ativa.
- **Lacuna:** o texto da tela não era gravado, e o motivo exato ficou desconhecido. A página pública de troca não expõe regra nenhuma (só `maxlength=50`). A hipótese é exigência de caractere especial, porque a senha gerada só tinha letras e dígitos.
- **v1.1-especial-e-motivo-da-recusa:** a senha gerada passa a ter ≥1 especial de `@#$%*!`. O texto da tela pós-troca vai para o diagnóstico e para o alerta como `texto_tela`, com toda ocorrência das duas senhas trocada por `[senha]`. Na 2ª recusa o motivo fica escrito.

## 2ª troca real — concluída (2026-11-20 11:16 UTC, v1.1)

- Disparada depois da quarentena, já com a v1.1 (#4006). Ela trocou a senha, provou com login real até o dashboard, promoveu no Vault, mandou o e-mail às 11:16:53 e reenfileirou o **#4505** (`erro_nao_retentavel` → `pendente_envio_portal`).
- Isso confirma a hipótese da 1ª recusa: o TOTVS exige **caractere especial**.
- A partir daqui a fonte da verdade da senha é o Vault. O env `SAYERLACK_PORTAL_PASS` ficou velho, e só serve de bootstrap se o Vault for esvaziado.

## Botão "Copiar senha do portal" (só master) — migration `20261120160000`

- **Por quê:** o founder às vezes entra no portal à mão pelo Chrome. Com a senha só no Vault, ele precisava de um jeito de colar a ATIVA (e o Chrome oferece atualizar a senha salva). Gerenciador de senhas foi descartado: o Chrome não tem API de escrita, o Bitwarden grátis é frágil para gravar do servidor e o 1Password é pago.
- **Onde:** card "Pedidos do portal Sayerlack" (`PedidosPortalCard`), botão `CopiarSenhaPortalButton`, visível só com `isMaster`.
- **Fronteira:** RPC `sayerlack_senha_portal_copiar()` (SECDEF, `has_role(uid,'master')` no corpo, EXECUTE só `authenticated`; anon, PUBLIC e service_role revogados). Vault sem ativa → `SEM_SENHA_NO_VAULT` (P0002), nunca o env. Rotação aberta → `TROCA_EM_ANDAMENTO` (55000).
- **Auditoria / sensor de uso:** cada cópia grava `sayerlack_senha_portal_leituras` (user_id, versão do segredo = id da rodada, lido_em; sem senha), escritor único = a RPC, SELECT só master. "Está sendo usado?" = `SELECT count(*), max(lido_em) FROM sayerlack_senha_portal_leituras`.
- **Prova:** `db/test-sayerlack-senha-portal.sh` K1–K8 (54 asserts nos 2 locales); `--falsificar` com 16 sabotagens, todas mortas (6 novas: gate de master aberto, Vault vazio copiando nada, cópia durante rotação, sem auditoria, anon executa, log aberto a staff).

## v1.2 — cópia do e-mail para o comercial da Colacor (2026-11-20, #4015)

A pedido do founder, o e-mail com a senha nova também vai para o comercial da Colacor (`EMAIL_SENHA_COPIAS` em `logica.ts`). O secret `SAYERLACK_SENHA_EMAIL_PARA` continua sendo o destinatário principal e agora aceita uma lista separada por `,`/`;`.

O envio é **um por destinatário**, porque o remetente `onboarding@resend.dev` não tem domínio verificado e o Resend pode devolver 403 para um endereço que não seja o dono da conta. Recusa num destinatário não impede os outros. Só "nenhum saiu" deixa o e-mail pendente para repetir; se repetisse com um já entregue, a senha seria enviada de novo. Envio parcial vai para o alerta `info`, com o endereço e o status HTTP.

Deploy: 17:35Z, 8/8 sha256 conferidos pelo agente do Lovable. Sonda (tentativa #1230, request 29028): **DEPLOY CONFIRMADO** com `v1.2-email-copia-colacor`, e `pendencias:deploy` deu exit 0. O commit do bot que veio junto (`c771d4bc`) só regenerou `types.ts` (+54 linhas) e não tocou `bun.lock`/`package.json`; não houve revert.

**Sinal a observar:** na próxima rotação real, o alerta `info` deve dizer "enviada por e-mail" sem "NAO chegou a todos". Se aparecer `enviado_parcial … HTTP 403` para a Colacor, o remédio é verificar um domínio próprio no Resend e trocar o `FROM_EMAIL`.
