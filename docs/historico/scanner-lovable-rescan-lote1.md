# Rescan do scanner Lovable Security — lote 1 (2026-11-13/14)

Segunda rodada do scanner Lovable Security. A primeira rodada foi o #3879. A triagem do rescan foi cruzada em três revisões independentes (Claude, Codex e Fable 5.2), e os achados de banco foram conferidos na PROD via `psql-ro`. O lote 1 juntou o que era falha real e barata. O resto ficou para os lotes 2 e 3, listados no fim.

## O que entrou (#3893)

| Achado | Correção |
|---|---|
| 🔴 `customer_visit_scores` gravável por qualquer JWT (item 5) | Migration `20261113214823_seg_cvs_fecha_escrita_cliente.sql`: `REVOKE INSERT/UPDATE/DELETE` de `PUBLIC, anon, authenticated` e `DROP` das 3 policies `cvs_*_own_or_gestor`. Edge `visit-score-recalc-client` v1.2: com staff chamando, o dono vem de `carteira_assignments`, não do body. |
| 🟡 IA paga sem papel no sales assistant (item 10) | `generate-bundle-argument` v1.4: o DISPARO também passa por `authorizeCronOrStaff`. Antes, só o ramo da sonda passava. |
| 🟡 Prompt injection via categorias (item 9) | `identify-tool` v1.1: exige staff ou `profiles.is_approved`, fail-closed. `name` e `description` das categorias passam a ter teto de 80 e 200 chars, sem quebra de linha. |
| 🟡 CPF/CNPJ em log (item 7) | `omie-sync` v1.13 e `omie-cliente` v1.10. |
| 🟡 E-mail em log (item 8) | `gerar-pedidos-diario` v1.6 e `disparar-pedidos-aprovados` v1.15. |

Os itens 1, 4 e 6 são por desenho ou falso positivo. O founder marca os três como aceitos no scanner.

O #3888 foi fechado sem merge e substituído pelo #3893: o push que reescreveria o branch foi negado, e a saída foi um branch novo, sem `--force`.

## Lições

- **`OR farmer_id = auth.uid()` sem checar papel é escrita aberta.** O cadastro em `/auth` é público, então "o dono da linha" inclui um customer não aprovado inserindo um score forjado para si mesmo. Provado com controle pré-migration em `db/test-seg-cvs-escrita.sh`: 8 ok, nos dois locales. Uma policy de escrita com "dono" precisa que o dono venha de uma fonte que o usuário não controla (aqui, a carteira) ou de um papel.
- **Exceção com PII logada inteira pelo `catch` é log de PII.** Esse achado foi do Codex. Tirar o documento do `console.log` não bastava, porque duas mensagens de `throw` no `omie-sync` carregavam o CPF/CNPJ e o `catch` as logava. Procure o dado também nas mensagens de erro, não só nos logs.
- **Gate aninhado num ramo guarda só aquele ramo.** O detector por AST (`ia-paga-sem-cota-gate`) passou a ver `generate-bundle-argument` e `identify-tool` como "gate dominante COM cota", e as duas viraram âncora desse lado.

## Deploy (7 edges, duas ondas, 4,7 créditos)

- **Onda 1** (09:31Z, 68/68 hashes contra `794718b9c`): as 6 edges sem predecessora. Sonda pelo envelope, tentativa #1121 ([#3895](https://github.com/LucasSardenbergL/afiacao/pull/3895)). Nessa sonda também foi a `enviar-pedido-portal-sayerlack`, predecessora da `disparar-pedidos-aprovados` no manifesto, cuja prova no ledger estava com 106,9h contra o teto de 6h.
- **Onda 2** (10:52Z, 17/17 hashes contra `aa0fc3c54`): só a `disparar-pedidos-aprovados`, depois dos 10 min mínimos de observação da predecessora. A 2ª onda foi segurada até o cron de sonda das 10:37 atestar a `generate-bundle-argument`. Sem essa espera, o pacote a incluiria de novo, e seria um deploy redundante. Sonda #1123 ([#3896](https://github.com/LucasSardenbergL/afiacao/pull/3896)).
- **Resultado:** todas as sondas com DEPLOY CONFIRMADO (versão e fonte). `pendencias:deploy` saiu com rc=0 e 0 pendentes. O bot do Lovable respondeu "No files were edited." nas duas ondas, e nenhum commit dele apareceu na main desde o 1º envio. A plataforma pediu duas vezes que ele corrigisse erros de build pré-existentes em outras edges, e ele só os reportou. Não houve Publish, porque nenhum arquivo de `src/` mudou.

**Lição de deploy:** quando o pacote retém uma edge por predecessora velha, ponha a predecessora na sonda da onda anterior. Essa sonda renova a prova e destrava a onda seguinte sem redeploy.

## Fora do lote 1

- **Lote 2:** tokens Nvoip em `company_config` e fallback SIP; opt-out do WhatsApp editável por staff; corrida no retry e teto diário de template pago.
- **Lote 3:** limites do webhook Gmail; cota de IA no extrator via vision; validação do número discado.
