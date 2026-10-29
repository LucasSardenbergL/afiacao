# Radar: backtest do score, nota no contato e placar de uso (frente 3, 2026-10-29)

> Frente 3 das 5 frentes paralelas do Radar. Antecedentes: [radar-score-lead.md](radar-score-lead.md) (o score v3)
> e [radar-uso-e-recorte-cnae-2026-10-28.md](radar-uso-e-recorte-cnae-2026-10-28.md) (o Radar não tem uso; 1
> autorizado; o PostHog é cego para ele). A frente 2 troca o gate do Radar para `private.cap_radar_prospectar`.
> Por isso esta frente não recria nenhuma RPC dela.

## Resumo

1. **Backtest:** o score v3 separa cliente de lead (AUC 0,98; sem o fator de proximidade, 0,77). Os fatores que
   não dependem de exposição ordenam como os pesos mandam. **Os pesos não mudam.** Não há evidência que
   justifique alterar; a v3 fica como referência para a validação prospectiva.
2. **Nota no contato:** cada contato humano grava a nota, a versão da fórmula e o instante da nota, lidos da linha
   do lead no momento do registro. São colunas dedicadas com um escritor (trigger). A versão passa a ser gravada
   com o score (`radar_empresas.score_versao`, escrita só pelo recálculo).
3. **Coortes de controle:** no mesmo instante, ficam registrados o topo (score ≥ 70, todos) e uma amostra
   fora do topo (50 leads entre 40 e 69, sorteados por md5). O denominador é fixo, para comparar conversão.
4. **Placar no ledger:** `radar_eventos` registra abriu, contato, contato desfeito e cadastrou, separa humano de
   automático e reconcilia a perda. A lente "Ver como" fica de fora por construção do cliente.

## 1. Backtest (só leitura, psql-ro, lote 2026-10)

**Método.** Reimplementei a v3 numa query e exportei uma linha por empresa da foto vigente, em 10 fatias pelo
último dígito do CNPJ (uma fatia só estourava o `statement_timeout` de 30 s). A análise foi em duckdb. Para quem
já é cliente, a proximidade **exclui a própria empresa** (n − 1).

**Controle positivo:** o recálculo bate com o `score` gravado pelo cron em **501.243 de 501.243** leads.

Os ~12 mil clientes de fora do recorte de CNAE não têm linha no Radar, então ficam sem score por construção.
O backtest cobre os **2.686** clientes que estão na foto vigente.

| Grupo | n | p10 | p50 | p90 | ≥ 60 | ≥ 70 (sugeridos) | % do faturamento 12m ≥ 70 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Leads | 501.243 | 27 | 41 | 53 | 2,5 % (12.511) | 0,2 % (779) | — |
| Clientes | 2.476 | 57 | 67 | 72 | 83,4 % | 24,8 % | — |
| Compradores 12m | 210 | 59 | 69 | 78 | 89,0 % | 41,0 % | 58,0 % (≥ 60: 98,4 %) |

| AUC cliente × lead | Todos | MG |
| --- | ---: | ---: |
| v3 inteira | 0,980 | 0,947 |
| v3 sem proximidade | 0,767 | 0,793 |
| Só proximidade | — | 0,926 |
| Só CNAE (+ secundário) | — | 0,767 |
| Municípios com ≥ 31 clientes (proximidade 20 para todos) | — | **0,882** (compradores 0,908) |

O corte de 31 clientes (e não 30) segue o Codex: com n − 1, um município de exatamente 30 daria 29 ao cliente.

**Penetração por fator, em MG** (`ja_cliente` ÷ total na foto):

| Fator | Leitura |
| --- | --- |
| CNAE tier 1/2/3 | 9,6 % / 2,0 % / 0,55 %. Acompanha os pesos 25/15/8 |
| Secundário tier 1 (principal tier 2/3) | 8,1 % e 5,3 % contra 1,3 % e 0,35 % sem ele. Acompanha +10/+7 |
| Capital | monotônico, de 3,5 % (sem ponto) a 8,1 % (≥ R$ 1 mi) |
| Telefone / e-mail | **sem discriminação** (98 % e 93 % dos leads têm) |
| Porte | EPP 6,5 % > demais 4,9 % (n = 658), contra os pontos 8 < 10 |
| Idade < 1 ano / inédito | 0,25 % e 0,41 % contra 4,4 %: **viés de exposição** (empresa nova ainda não teve tempo de virar cliente) |
| Proximidade | **circular**: o fator conta clientes, e o rótulo é "ser cliente" |

**Decisão: nada muda.** A proximidade não pode ser validada contra o próprio rótulo. Idade e inédito confundem
propensão com tempo de exposição. A inversão de porte tem n pequeno e não é controlada por composição. Telefone e
e-mail não discriminam, mas medem se o lead é contatável (custo operacional), não a propensão a comprar. O que
sobra (CNAE, secundário, capital) confirma a **direção** dos pesos, não que eles sejam ótimos. O corte 70 também
não foi validado: qualidade da ordenação e escolha do corte são decisões diferentes. A validação real é
**conversão por contato**, e por isso as entregas 2 e 3 existem.

## 2. O que entrou

| Migration | O quê |
| --- | --- |
| `20261029150000_radar_score_versao.sql` | Coluna `radar_empresas.score_versao`. `radar_score_recalcular()` = corpo v3 + constante `c_versao = 'v3'`. A versão entra nas **três** comparações (UPDATE, `a_alterar`, `pulados`), e o resumo ganha `versao_formula`. Molde TRAVA → PRE (aceita a v3 viva `b8dd36f7…` ou esta) → CREATE → PÓS (md5 `c31dfcac…`, ACL, cron). A 1ª rodada do cron reescreve as ~500 mil linhas com score (~110 s, como a 1ª da v3); as seguintes voltam a 0 |
| `20261029150100_radar_eventos_placar.sql` | Ledger `radar_eventos`, 3 funções de trigger em `private`, coortes (`radar_coorte_controle` + `radar_coorte_sortear`), leituras (`radar_placar_uso`, `radar_coorte_resultado`, `radar_conversao_por_faixa`), backfill retroativo |

**Escritores do ledger (um por fato, todos trigger):**

| Evento | Fonte | Origem / titular |
| --- | --- | --- |
| `abriu` | INSERT em `analytics_outbox` com `navegacao.rota_servida` e rota `/radar` (1 por titular e dia) | humano / `user_id` do outbox |
| `contato` | AFTER INSERT em `radar_contatos` (qualquer escritor) | pela **fonte**: `criado_por` = UUID de sistema `…ad0f` ⇒ automática; senão humano |
| `contato_desfeito` | AFTER DELETE em `radar_contatos` | igual ao contato; `ocorrido_em` = instante da exclusão |
| `cadastrou` | `radar_empresas.omie_cadastrado_em` NULL → preenchido | `auth.uid()` da RPC; `acao` = `incluir` (cliente novo) ou `lookup` (já existia), pela confirmação do servidor (`omie_cliente_confirmacoes`) |

- **Por que trigger e não a RPC:** o gate de `registrar_contato_radar` é da frente 2. Recriar a função aqui
  seria uma corrida de `CREATE OR REPLACE`. E o trigger pega **todo** escritor de `radar_contatos`: a RPC
  protege a porta, o trigger fecha a classe.
- **A nota é a "nota no registro do contato":** o score da linha no instante do INSERT. A RPC já travou a linha
  com `FOR UPDATE`, e o UPDATE de status que vem depois não mexe no score. É o score que o cron das 03:30 gravou,
  o mesmo que a fila mostra. O cache da tela (até 10 min) pode cruzar uma faixa. Não gravamos o score enviado pelo
  cliente: seria uma declaração, não um fato do banco.
- **Caminho barato:** o contato automático (o finalize do lote grava ~64 mil descartes de uma vez) não lê a nota.
- **Fail-open com reconciliação:** um erro no trigger vira `WARNING` e o contato passa. O placar expõe a perda:
  `contatos_sem_evento`, `apagados_sem_desfeito` (DELETE que o ledger não viu) e `aberturas_outbox_sem_evento`
  (enquanto o outbox ainda retém). Cancelamento por `statement_timeout` não é capturado de propósito.
- **Contato válido** = a linha ainda existe em `radar_contatos`. Desfeito, ou apagado sem evento, não conta.
- **Vocabulário do placar:** *toque* = `contatado_sem_resposta` ou `em_conversa`. `virou_cliente` é desfecho
  (o cadastro no Omie também o grava, e isso não é tentativa). `descartado` é decisão. `a_contatar` é devolver à fila.
- **Lente "Ver como":** é excluída **no cliente**. O write-guard bloqueia RPC de escrita sob a lente, e o ledger de
  navegação não grava sob ela. O banco não distingue a lente.
- **Autorizados** = `private.cap_radar_prospectar(uuid)` da frente 2, resolvida tarde. Enquanto ela não existir,
  sai NULL com motivo, nunca 0. É o número de **agora**, não uma reconstrução histórica.
- **Coortes:** o universo é o mesmo para os dois grupos: foto vigente, a contatar, com telefone, em município que
  já tem cliente. `radar_coorte_sortear()` trava por sorteio **antes** de olhar se já existe. Ela recusa linha
  elegível sem `score_versao` (não congela a ausência) e recusa coorte vazia. Re-chamar não re-sorteia.
  `radar_coorte_resultado()` parte do **registro**: os sorteados com zero contato continuam no denominador. Os
  dois grupos nascem no mesmo instante, então têm o mesmo tempo de acompanhamento. Com n = 50 é um **piloto**:
  0 conversões em 50 ainda permite até ~5,8 % (limite superior a 95 %).
- **Backfill:** contatos e aberturas existentes entram `retroativo`, **sem nota** (o score daquele instante não é
  conhecido, e não é reconstruído pelo score atual). A origem vem da linha histórica, nunca do `auth.uid()` da
  migration.
- **ACL:** as tabelas novas têm RLS ligada, sem policy, e `REVOKE ALL` de PUBLIC/anon/authenticated/service_role,
  o que inclui TRUNCATE (a RLS não o cobre). `service_role` fica só com SELECT. As funções novas não executam
  para PUBLIC/anon/authenticated. `claude_ro` recebe SELECT/EXECUTE sob `IF EXISTS`.

## 3. Provas

`db/test-radar-placar.sh` (no `nucleo-ci.txt`, **22 asserts**). Aplica score v1 → v2 → v3 → as duas migrations
(cada uma 2×, por idempotência). Executa os **corpos reais** de `registrar_contato_radar` e
`desfazer_contato_radar` sob `SET ROLE authenticated` + GUC de JWT. Os default privileges imitam prod (anon e
authenticated com tudo), para os REVOKE terem o que revogar.

- `--falsificar`: **15/15** sabotagens vermelhas no assert declarado, com controle verde, em `LC_ALL=C` **e**
  `pt_BR.UTF-8`:
  - na M1: versão fora do UPDATE e versão fora do resumo;
  - na leitura: origem pela sessão no backfill, nota relida do score atual, apagado contado como toque, cadastro
    virando toque;
  - na captura: contato automático lendo nota, outbox sem filtro de rota, trigger fail-closed;
  - na coorte: sorteio sem a guarda de versão, sorteio não determinístico, sorteio sem trava, denominador por contato;
  - no ACL: anon lendo o ledger, anon executando o placar.
- Pontos que a prova cobre por cenário: nota congelada quando o lead cruza 70 depois do toque (A5); sorteio
  concorrente em duas sessões reais (A17); falha do ledger que não derruba o contato (A12).

## 4. Codex

- **Desenho:** gpt-6-astra · max · 717 s · 127.397 tokens. Nenhum P0. Os P1 e o que mudou:
  - origem pela identidade da fonte, não por `auth.uid()` (o backfill sem JWT classificaria humanos como automáticos);
  - sorteio só depois da rodada com versão;
  - versão nas três comparações do recálculo;
  - coorte identificada e com denominador vindo do registro;
  - reconciliação do DELETE perdido;
  - `virou_cliente` do cadastro fora dos toques, e cadastro novo × vínculo existente;
  - caminho barato para os 64 mil descartes;
  - ordem dos `CREATE TRIGGER` (o do outbox, tabela quente, por último).

  O P2 do corte de 30 clientes foi refeito com 31 (AUC igual, 0,882).
- **Código:** (preenchido no PR).

## 5. Camadas de deploy

| Camada | Quem | Quando |
| --- | --- | --- |
| Migration `20261029150000` (versão da fórmula) | sessão, no envelope (ensaio → apply → psql-ro) | fora da janela 03:30 BRT |
| 1ª rodada do cron com versão | cron 225 | 03:30 BRT seguinte; conferir que `pulados` = 0 e que toda linha com score tem `v3` |
| Migration `20261029150100` (ledger, coortes, placar) | sessão, no envelope | depois da 1ª; pode ser no mesmo dia |
| `SELECT public.radar_coorte_sortear(50);` | sessão (MCP) ou founder (SQL Editor) | **só depois** da 1ª rodada com versão (a função recusa antes) |
| Publish do Lovable | — | nenhum: não há front nesta entrega |
| Mostrar a amostra na fila | **frente 1** (contrato na nota da pasta compartilhada) | sem isso a coorte fica registrada e nunca é contatada |

## Follow-ups (fora desta frente)

- A frente 1 mostra a amostra na fila (1 a cada 10 posições, sem o filtro ≥ 70 eliminá-la). A coorte só mede algo
  depois disso.
- `src/lib/analytics-ledger.ts`: a marca local de rota servida é `dia|rota`, sem titular. Trocar de usuário na
  mesma aba pode suprimir a abertura do 2º titular (Codex P2). Não é arquivo desta frente.
- Rever os pesos (v4) só com conversão por contato medida em `radar_conversao_por_faixa()` e nas coortes, nunca
  pelo backtest retrospectivo.
