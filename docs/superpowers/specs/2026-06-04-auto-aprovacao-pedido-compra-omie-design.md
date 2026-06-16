# Auto-aprovação do pedido de compra no Omie

**Data:** 2026-06-04
**Status:** desenho aprovado pelo founder (aguardando implementação)

## Problema

Quando o app dispara um pedido de compra ao Omie (`disparar-pedidos-aprovados` → `IncluirPedCompra`), ele entra na etapa **pendente/cotação** do Omie. O founder precisa abrir o Omie e clicar "Aprovar Pedido" pra mover o card pra a coluna "aprovados" do kanban do Omie — um passo manual repetido, **independente do fornecedor**.

⚠️ **Não confundir** com a aprovação no NOSSO app (Reposição): essa continua existindo (o gate humano `pendente_aprovacao → aprovado_aguardando_disparo` antes do disparo). Esta feature elimina a **segunda** aprovação, a que acontece **dentro do Omie**.

## Decisão (mecanismo)

A API do Omie expõe, no `IncluirPedCompra`/`UpsertPedCompra`, o campo opcional **`cEmailAprovador`**. Doc oficial: quando preenchido, *"o pedido de compra será atribuído à etapa de aprovação com o status de aprovado"*. É o caminho oficial e granular pra criar o pedido **já aprovado**, em nome de um usuário.

Por que o email: no Omie, aprovação tem responsável (trava de auditoria/permissão). `cEmailAprovador` informa **quem aprovou** — equivalente a clicar "Aprovar" logado como aquele usuário. Tem que ser um usuário **real do Omie com permissão de aprovar** naquela conta.

**Alternativa descartada:** desligar a exigência de aprovação na config do Omie — afeta TODOS os pedidos da conta (não só os do app) e remove o controle. Pior.

## Design

Adicionar `cEmailAprovador` ao `cabecalho_incluir` do `IncluirPedCompra` em
`supabase/functions/disparar-pedidos-aprovados/index.ts` (~linha 652).

- **Fonte do email:** env var, lida por empresa com fallback global:
  `OMIE_<EMPRESA>_EMAIL_APROVADOR` (ex.: `OMIE_OBEN_EMAIL_APROVADOR`) **ou** `OMIE_EMAIL_APROVADOR`.
  Segue o padrão de `getOmieCreds` (credenciais do Omie já são env var por empresa). O founder
  seta **uma** env var global (`OMIE_EMAIL_APROVADOR = lucascoelhosardenberg@gmail.com`) e vale
  pra todas; se uma conta precisar de outro aprovador, seta a específica.
- **Escopo:** TODOS os fornecedores. `disparar-pedidos-aprovados` é o **único** ponto que cria
  PC no Omie (`IncluirPedCompra`, único `grep`), então o campo no cabeçalho cobre tudo.
- **Incluído em produção e dry-run** (o dry-run também cria o pedido no Omie; deve refletir o
  comportamento real).
- **Degradação honesta:** se NENHUMA env var estiver setada, o campo **não** é adicionado e o
  pedido entra como hoje (pendente). Não quebra o disparo — só não auto-aprova até a env var existir.

## Validação

A doc confirma o campo e o comportamento, mas **não mostra um exemplo de payload** com ele. Então,
após implementar e deployar:

1. Disparar **1 pedido real** (ou dry-run que cria no Omie).
2. Conferir no Omie que o pedido entrou na coluna **"aprovados"** do kanban (não "pendente").
3. Se o Omie **recusar** o campo ou ignorá-lo: plano B — checar formato/nome exato do campo,
   testar via `UpsertPedCompra`, ou capturar a resposta do Omie pra ajustar. **Não dar como
   certo sem essa confirmação visual no Omie.**

## Não-objetivos

- Não mexe no gate de aprovação do nosso app (Reposição) — continua igual.
- Não mexe na config de permissões/etapas do Omie.
- Não faz 2ª chamada de API (não há método dedicado de aprovação; o `cEmailAprovador` no Incluir resolve).

## Riscos

- **Omie rejeitar/ignorar o campo** (doc sem exemplo de payload) → mitigado pela validação com
  pedido real antes de dar como pronto + degradação honesta (sem env var = comportamento atual).
- **Email inválido na conta Omie** → o Omie pode recusar a criação. O founder confirma que o
  email é um usuário real com permissão de aprovar.

## Apply (founder)

- **Setar a env var** no Lovable: `OMIE_EMAIL_APROVADOR = lucascoelhosardenberg@gmail.com`.
- **Redeploy** da edge `disparar-pedidos-aprovados` (verbatim da main, após merge).
- **Sem migration** (mudança só de edge).
