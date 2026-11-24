# Clientes (/admin/customers e 360): onda B, a tela só afirma o que o dado sustenta (2026-11-24)

Saiu da revisão do Fable e do Codex nos 11 eixos, junto com as ondas A a E (todas aprovadas pelo
Lucas). A onda A (prioridade) e a D (escopo de PII) rodaram em paralelo. A C (hero e linha da lista)
vem depois, porque mexe nos mesmos arquivos. Cada item foi conferido na `origin/main` antes de mexer.

## O que mudou

1. **Um único dicionário de saúde** (`src/lib/farmer/saude-cliente.ts`, módulo plataforma, que os dois
   módulos podem importar). Antes eram dois mapas, e o da 360 não tinha `estavel`: 235 clientes
   "Estável" apareciam como "Sem score". A lista (`HEALTH_CLASSES`, `classeSaudeExibida`) e a 360
   (`healthTone`, chip do hero) agora derivam dele, todos com tokens `text-status-*`/`bg-status-*`.
   Os valores distintos medidos em prod são `saudavel` 18 · `estavel` 235 · `atencao` 97 · `critico`
   16.641, e o teste cobre os quatro. Um valor desconhecido vira "Não avaliado", neutro, e nunca usa a
   cor de outra classe.
2. **Crédito.**
   - A régua agora é ≥ 60 dias (`data_vencimento <= hoje_SP − 60`). Com `<`, o título no 60º dia ficava
     de fora e o rótulo "60+" errava por um dia. O corte agora é a data civil de SP (`hojeSP`).
   - O frescor é **por empresa**. Antes era o `completed_at` mais recente de qualquer empresa: o sync
     de uma "garantia" a outra. Agora cada empresa tem `ok`, `defasado` (mais de 24h), `erro` (falhou
     depois do último concluído) ou `nunca`.
   - Sem títulos, o frescor **sobrevive**. O "verde" (Nenhum título vencido) só aparece com todas as
     empresas `ok`. Com `erro` ou `nunca`, a ficha diz "Crédito não confirmado" e nomeia a empresa.
     Com `defasado`, diz "no último sync".
   - O gate da Fase 2 (`venda_gate_credito_grupo`) continuou > 60 d no #4149. Por um tempo, no 60º
     dia o alerta aparecia e o pedido não era bloqueado. **Alinhado no follow-up** (decisão do Lucas,
     "Banco bloqueia ≥60"): a migration `20261124170000_credito_gate_fronteira_60_inclusiva` troca só
     o operador (`<` → `<=`) nas 3 funções que leem o corte — `venda_gate_credito_grupo` (5),
     `private.credito_avaliar_reservar` (3) e a v1 `venda_gate_credito` (1, sem chamador). Os corpos
     são o `pg_get_functiondef` de prod, com guarda por md5 e pós-condição (0 estritas, 9 inclusivas,
     ACL igual). Prova: `db/test-credito-gate-fronteira-60.sh`, 31 asserts, com sabotagens.
3. **Empresa da tarefa.** O `empresa="oben"` fixo saiu do `CriarTarefaDialog` na 360. A empresa vem
   de `omie_customer_account_map_fresco`. Com uma conta, usa essa. Com várias, nenhuma ou leitura que
   falhou, o diálogo pergunta, mostra o motivo e trava o salvar até alguém escolher. O diálogo **por
   voz** não tem seletor: com conta única ele recebe a empresa provada; nos outros casos segue o
   default antigo. Isso fica como follow-up da onda C, que cuida das ações do topo da ficha.
4. **Estados honestos na 360.** Endereços e contatos que não foram lidos mostram aviso com "Tentar de
   novo", e não mais "nenhum". O score sai numa leitura só: `farmer_client_scores` é
   `UNIQUE(customer_user_id)` (16.991 linhas, 16.991 clientes), então o "do farmer atual, senão
   qualquer um" ia duas vezes buscar a mesma linha. O `CustomerBrief` (última ligação sem exigir
   transcrição e "nunca comprou" só com leitura ok) **já tinha sido corrigido na onda 1** (#4105).
5. **"calculado em DD/MM"** ao lado da saúde no hero e no card de score, vindo de
   `farmer_client_scores.calculated_at`. Sem data, a tela não mostra nada.
6. **`health_score ?? 0` → `null`** em `fetchScoresPorCustomer`. O tipo `ClientScore` aceita `null` e
   o card mostra "—".
7. **"Sem contato em 180d"** some quando o escopo inteiro não tem nenhum registro. As duas fontes
   (`venda_contato` e `route_contact_log`) estavam com 0 linhas em prod em 2026-11-24. Para quem não é
   master, a RLS de `venda_contato` (dono ou master) esconde o contato feito por outra pessoa, e a
   linha diz "sem contato visível para você em 180d". O `useAuth()` é o usuário real, como o banco.
8. **Timeline com o desfecho manual.** Migration `20261124150000_v_cliente_interacoes_desfecho_manual`:
   - parte do `pg_get_viewdef` de prod, mantém os 4 ramos verbatim e acrescenta o de `venda_contato`
     (canal `desfecho`);
   - as colunas continuam idênticas e o `WITH (security_invoker = true)` foi repetido como está em prod;
   - a autorização é a mesma dos ramos com autor, somada à RLS da tabela (view invoker → interseção);
   - tem guarda que aborta em drift e pós-condição.
   Prova: `db/test-v-cliente-interacoes-desfecho.sh`, 15 asserts. As 3 sabotagens rodam num espelho em
   tmpdir, com controle verde na mesma invocação: sem invoker, sem gate e a guarda de drift. Ela
   **pegou um bug real** na pós-condição (`= ANY ((subquery))` comparava texto com `text[]`), que só
   aparece EXECUTANDO.

## Lições

- **Gate redundante hoje ainda tem dente amanhã.** Com a RLS de prod, a sabotagem "ramo sem gate"
  fica VERDE no assert da vendedora sem carteira, porque a tabela já barra. O dente aparece com a RLS
  alargada (A4b). A camada fica, e o motivo está registrado na prova.
- **Régua de dinheiro tem dois donos** (alerta no front e gate no banco). Mexer num sem o outro cria
  uma janela de divergência. Isso precisa ser dito no PR, não descoberto depois.
