# Calendário de operação no motor de compra — design

> Status: **aprovado pelo founder em 2026-11-18** (abordagem "B revista em duas etapas"). Money-path.
> Revisões adversariais: Fable 5.2 (com medições psql-ro, 2026-11-18) e Codex `gpt-6-astra`/max (279 s, 118.838 tokens, 2026-11-18). Ambos: **B-com-mudanças**. Resumo dos pareceres na §9.

## 1. Intenção

A empresa tem ≥ 30 dias/ano sem venda (recesso de fim de ano, feriados, emendas) e períodos com meia equipe (Carnaval e Semana Santa). O motor de reposição conta **dias corridos**: no 1º trimestre a janela de 90 dias engole o recesso como "venda zero" e subestima a demanda (compra a menos → ruptura); em dezembro ele não sabe que ninguém recebe mercadoria nem que fornecedores fecham (risco de recompra e de estoque parado). O sistema precisa **saber quando a empresa e cada fornecedor operam**, num calendário que o founder edita, e o motor precisa usá-lo sem fabricar número.

O calendário é também a base futura da gestão de férias por funcionário (fora deste escopo).

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- E1 (prazo: em produção até ~01/12/2026): calendário editável + importação; chegada prevista nunca cai em janela fechada sem alerta; pedido em trânsito não é recomprado durante o recesso; LT de fornecedor soma os dias fechados dele.
- E2 (prazo: valendo até 05/01/2027; em sombra durante dezembro): demanda média ignora dias fechados declarados, neutra por construção fora deles; TSB/replay congela em dia fechado.

**Não-objetivos (desta entrega)**
- Corrigir a mistura dia corrido × dia útil no PP/SS/EOQ (débito registrado; entrega própria com replay).
- Pesos fracionários (0 < peso < 1) no cálculo — a coluna existe, o cálculo usa só 0/1.
- Mexer em `v_sku_sigma_demanda` / `v_sku_demanda_rajada`.
- Férias por funcionário; ligação peso ↔ vendedora ausente.
- Mudar `dias_uteis_entre` e seus espelhos TS (paridade testada; LT histórico).
- Orçamento de compra e Raio-X (efeito ~5 %, conservador; ficam como estão).

**Anti-objetivos (falha mesmo que "funcione")**
- Cortar compra de dezembro automaticamente (recria a ruptura de janeiro — o estoque de 17/12 cobre até a 1ª chegada pós-recesso, ~15–25/01).
- Fabricar demanda: dividir por peso chutado, extrapolar janela quase toda fechada, transformar ausência em zero ou em valor.
- Qualquer mudança de `d`, PP ou máximo em janela **sem** dia declarado fechado (neutralidade quebrada).
- Inferir fechamento a partir do histórico (20/11/2025 era feriado e teve 12 NFs).

## 3. Restrições e fatos medidos

- Histórico de venda: só OBEN, desde 2025-10-21; **0 NFs em sábado/domingo em 13 meses**. Dias úteis sem NF e sem explicação: 08/12/2025 e 11, 15, 18, 19, 20, 22, 29/05 e 01/06/2026 (maio R$ 238 mil vs R$ 350–390 mil normal).
- Recesso 2025: 22/12–02/01 zero. Carnaval 2026: 16–18/02 **zero**, 13/02 4 NFs, 19–20/02 8–9 NFs. Semana Santa 2026 sem queda visível.
- Compras registradas (`v_sku_leadtime_efetivo`): 997 obs., todas desde 06/01/2026 → **não há replay possível de dezembro**.
- 354 SKUs com parâmetro: `lt_p95` (dias úteis) p50 10,4 · p90 14,9 · máx 23,8; `cobertura_alvo_dias` p50 30 · p90 91 · p99 136 · máx 286.
- `sku_parametros` é recalculado diariamente (atualizador grava demanda mesmo quando segura PP/máximo — `20261101014150_descricao_segue_catalogo_omie.sql:118`).
- Já existe `sku_parametros.demanda_multiplicador_override` + `override_validade_ate` (verificar consumo antes de citar ao founder como alavanca).
- Migrations: nunca editar existente; nova via ENVELOPE (psql-rw) ou SQL Editor (`docs/agent/database.md`, skill `lovable-db-operator`). `CREATE OR REPLACE VIEW` só acrescenta coluna no fim; pré-voo `pg_get_viewdef` da produção; repetir `security_invoker`. Tabela nova com RLS.
- Arquivo novo em `src/` precisa de dono em `src/lib/modulos/manifesto.ts` (módulo reposição, `/admin/reposicao`).

## 4. Decisões do founder (fechadas)

- Calendário **100 % declarado e editável** em tela; nada inferido. Datas explícitas, sem regra recorrente; alerta quando restarem < 12 meses cadastrados.
- Recesso 2026: **18/12/2026–03/01/2027** fechado (volta 04/01).
- Escala 2027–2030 (PDF `escala-ferias-2027-2030.pdf`), importada inteira:
  - Fim de ano 100 % fechado: 22/12/2027–04/01/2028 · 19/12/2028–01/01/2029 · 19/12/2029–01/01/2030 · 19/12/2030–01/01/2031.
  - Meia equipe (registrar como `meia_equipe`, peso de cálculo 1 por ora): Carnaval 2027 01–11/02 e 15–25/02; Semana Santa 2027 22–26/03 e 15–19/03; 2028 21/02–02/03, 06–16/03, 10–14/04, 03–07/04; 2029 05–15/02, 19/02–01/03, 26–30/03, 19–23/03; 2030 25/02–07/03, 11–21/03, 15–19/04, 08–12/04. Grupos: ver PDF (vendedora A/B alternam).
- Feriados nacionais 2027–2030 fechados; **emendas** (ponte fechada) em todos os feriados de terça/quinta: 2027 28/05, 06/09, 11/10, 01/11 · 2028 16/06, 08/09, 13/10, 03/11 · 2029 30/04, 01/06, 16/11, 19/11 · 2030 21/06. Carnaval seg/ter e Cinzas = meia equipe (loja aberta), não feriado fechado.
- Emendas decididas até fevereiro de cada ano; alerta 90 dias antes de feriado sem decisão **e** lista de pendências além desse prazo (cobertura chega a 286 dias).
- Fornecedores: Sayerlack fecha só 25/12 e 01/01; demais fecham 21/12–03/01 (anual — cadastrar 2026–2030). A empresa não recebe mercadoria nos seus dias fechados.

### 4.1 Decisões de construção (chamadas do Claude, revisáveis pelo founder)

- **Passado (2025–2026) é declarado como FATO observado, `origem='historico'`:** recesso 2025 22/12/2025–02/01/2026 `fechado`; Carnaval 2026 16–18/02 `fechado` (nesse ano a empresa parou; a regra `meia_equipe` vale de 2027 em diante); feriados nacionais 2025–2026 `fechado`, **exceto 20/11/2025 `aberto`** (12 NFs); pontes 21/11/2025, 20/04/2026, 05/06/2026 `fechado`. Os 9 dias úteis sem NF inexplicados dependem do founder (§4.2). Sem isso os replays da §7 não se reproduzem.
- **Data ao Omie (`dDtPrevisao`):** continua a promessa do fornecedor (cálculo atual). A data de recebimento ajustada pelo calendário é gravada do nosso lado (coluna nova no pedido aprovado/tracking) e exibida com alerta. O LT que entra no PP **não muda** na E1: a E1 muda a data exibida/recebimento e o sinal de antecipação (§6.3.4), não o gatilho do motor.
- **Guarda `W/U < 0,6`:** cai no `d` cru do legado (`S90/90`) + flag `baixa_confianca` — sem memória, nunca fabrica, nunca `null`. Com o calendário real (recesso ≈ 10 dias úteis em 64) a guarda é inalcançável; existe contra edição errada.
- **COLACOR:** calendário cadastrável e usado na E1 (recebimento); **detecção de dia sem NF e E2 só para OBEN** (único histórico de venda). Sem histórico, a empresa não entra na E2.
- **`calendario_feriados`:** recebe só feriados nacionais 2027–2030 (semântica atual do módulo de tarefas preservada); emendas e recesso **não** entram nela.

### 4.2 Respostas do founder à checagem do construtor (2026-11-18)

- **Sede em Divinópolis/MG** (não SC). Feriados municipais (Lei municipal 744/1967, conforme listas de feriados locais do TRT-MG): **01/06** (São Firmino / aniversário da cidade), **Corpus Christi** e **08/12** (Imaculada Conceição) — a empresa fecha. Isso explica 2 dos 9 dias sem NF (08/12/2025 e 01/06/2026) → passam a `fechado`, `origem='historico'`.
- Novas emendas pela regra terça/quinta: **seg 07/12/2026** (08/12 terça), **seg 31/05/2027** (01/06 terça), **sex 02/06/2028** (01/06 quinta). 01/06/2029 coincide com a ponte do Corpus; 08/12 de 2027 (qua), 2028 (sex), 2029 (sáb), 2030 (dom) sem ponte.
- **20/11/2026 (sexta): fechado.**
- **Os 7 dias restantes sem NF** (11, 15, 18, 19, 20, 22, 29/05/2026): o founder não se recorda → `pendente_dado` (saem de U e W) até decisão na tela.
- Fonte dos feriados municipais a reconfirmar no SAPL da Câmara de Divinópolis antes da carga 2027–2030 (as fontes da web divergem).

## 5. Abordagens consideradas

| | Abordagem | Troca | Decisão |
|---|---|---|---|
| A | Refazer a régua na fonte (tudo em dias de venda, corrige corrido×útil junto) | Modelo certo; muda PP/SS/máx de todos os SKUs de uma vez, ~20 pontos de toque, não cabe com segurança antes de dezembro | Descartada agora |
| **B revista** | Calendário como ajuste, neutro fora de dias fechados; duas etapas; sem corte de quantidade em dezembro; pesos 0/1 | Entra no prazo; débito corrido×útil fica | **Escolhida** |
| C | Multiplicador manual por mês | Rápido; não usa a escala, não corrige previsão, chute anual | Descartada |

A versão original de B ("dezembro compra menos por soma de pesos", peso 0,8, ajustar sigma) foi derrubada pelos dois revisores (§9).

## 6. Design

### 6.1 Dados (migration nova)

- `calendario_operacao_empresa(data date, empresa text, status text check in ('aberto','fechado','meia_equipe','pendente_dado'), peso numeric(3,2) check 0..1, motivo text, origem text check in ('escala','feriado','emenda','manual','deteccao'), decidido_por uuid, atualizado_em timestamptz, PK(data, empresa))`. Só exceções são gravadas; dia ausente = regra base (seg–sex aberto, sáb/dom fechado). Empresas: OBEN, COLACOR.
- `calendario_operacao_fornecedor(data, fornecedor_id, status 'fechado', motivo, origem, PK)`. Chave do fornecedor: a mesma usada por `fornecedor_calendario_operacao` (builder confirma).
- Histórico de alterações (auditoria/versão): tabela de log ou trigger que grava antes/depois. Builder escolhe; obrigatório que `d` recalculado seja reproduzível para uma versão do calendário.
- RLS: leitura staff; escrita master/admin. Funções SECURITY DEFINER com gate na fronteira e `REVOKE` em `PUBLIC` e `anon`.
- `calendario_feriados` permanece (módulo de tarefas); a importação também insere os feriados 2027–2030 nela, sem quebrar tarefas.
- Funções SQL: `peso_base(data)` (seg–sex 1, sáb/dom 0); `peso_efetivo(empresa, data)` (exceção ou base; `meia_equipe` → 1 nesta entrega; `pendente_dado` → excluído); `fornecedor_aberto(fornecedor, data)`; `proximo_dia_recebimento(empresa, fornecedor, data)`.

### 6.2 Tela (`/admin/reposicao`, aba "Calendário de operação")

- Grade mensal por empresa: status do dia, motivo, origem; editar/incluir/remover; filtro por ano.
- Fornecedores: lista de períodos fechados por fornecedor.
- Painel de **pendências**: (a) feriado terça/quinta sem decisão de emenda (alerta 90 dias + lista total); (b) **dia útil aberto sem nenhuma NF na empresa** (detecção diária, `origem='deteccao'`, status `pendente_dado`) → founder marca "fechado" ou "dado faltante"; (c) calendário com < 12 meses à frente.
- Convenções do DS (useUrlState, EmptyState, sonner, `track('reposicao.calendario_*')`). Ação de importar via `useMutationComRegistro`.

### 6.3 Etapa 1 — dezembro (motor e chegada)

1. **Data de chegada** (`supabase/functions/disparar-pedidos-aprovados/previsao.ts`): o LT em dias úteis passa a pular dias fechados do fornecedor; se a chegada cair em dia fechado da empresa, avançar para `proximo_dia_recebimento` e emitir alerta visível no pedido sugerido/aprovado. Não reagenda promessa do portal: preservar a data original e registrar a de recebimento (Codex P0-3).
2. **"A caminho"** (`gerar_pedidos_sugeridos_ciclo`, `20261101090000_reposicao_compra_suspensa.sql:464`): provar com teste executando que pedido disparado em 10–17/12 ainda desconta em 04/01; se não, trocar o corte de 7 dias corridos por saldo documental pendente (pedido aberto, não recebido, não cancelado). Trocar por "7 úteis" **não** resolve (Codex P0-5).
3. **Sem redução automática de quantidade.** O motor não pondera o alvo por pesos futuros.
4. Sinal no ciclo: itens de fornecedor que fecha 21/12–03/01 com cobertura projetada que não alcança a 1ª chegada pós-recesso → destacar para antecipação (informativo; decisão humana).

### 6.4 Etapa 2 — demanda (sombra em dezembro, valendo até 05/01/2027)

- Fórmula (convergente Fable/Codex), por empresa e SKU, sobre a mesma janela e numerador do legado:
  `U = Σ peso_base` (dias seg–sex da janela), `W = Σ peso_efetivo` nos mesmos dias, `fator = U / W`, **`d_ajust = round(S90/90 × fator, 4)`**.
  Sem exceção na janela: `W = U` ⇒ `d_ajust = d` **bit a bit** (critério de aceite). Feriado isolado fechado sobe `d` ~1,6 % no ano todo — esperado e documentado.
- Guardas: `W/U < 0,6` → não extrapolar: manter o `d` anterior, marcar `baixa_confianca`; `fator` com teto 1,35; nunca `null → 0`; dia `pendente_dado` sai de U e W.
- Ponto único de aplicação: CTE `base` de `v_sku_parametros_sugeridos` (`20260930230623_…classe_ii.sql` ~1085). `v_sku_demanda_estatisticas` fica crua e ganha `fator_calendario` como coluna no fim. Antes: `pg_get_viewdef('v_sku_classificacao_abc_xyz')` da produção — se a classe ABC/XYZ consumir o `d` ajustado, decidir explicitamente.
- Sombra: em dezembro, gravar `d_ajust`/`fator` lado a lado sem alimentar PP/máximo; virar a chave por flag após as provas (§7). Flag com reversão imediata.
- Sigma, rajada, EOQ, LT: intactos.
- Replay/TSB (`scripts/reposicao-replay/`): usar o mesmo calendário (TS lendo export do banco ou fixture versionada); congelar atualização TSB em dia fechado declarado; zeros em dia aberto continuam zeros; ADI/CV² semanais (`parados.ts:51`) também mascarados. Corrigir a divergência sábado→segunda (`calendario.ts:12` vs `db/test-recompute-leadtime-derivado.sh:135`) **somente** no replay se necessário, sem tocar SQL.

## 7. Provas antes de cada deploy

- **E1:** teste SQL executando (PG17 `db/test-*.sh`, skill `prove-sql-money-path`) da chegada com fornecedor fechado (Sayerlack 25/12 e 01/01; demais 21/12–03/01) e do "a caminho" atravessando o recesso; negativo com SQLSTATE e falsificação (sabotar e exigir vermelho, com controle verde na mesma invocação). Testes TS da edge (`test:edges`, `edges:typecheck`, `edges:sintaxe`, sonda bump/fingerprint).
- **E2:** (a) neutralidade — datas-base 06/04/2026 e 01/09/2026: igualdade exata de `d`, PP e máximo nos SKUs com PP; (b) replay 19/01, 02/03, 16/03/2026: viés agregado, rupturas evitadas, capital adicional (ΔPP × custo) por SKU; (c) replay 02/02/2026: mostrar o excesso pré-Carnaval e registrar a decisão; (d) guardas falsificadas: janela toda fechada não gera `d` explodido nem zero; (e) efeito na fila de aprovação de parâmetros (`reposicao_param_fila_sensor`/param-auto).
- Números por psql-ro com `-v ON_ERROR_STOP=1` + marcador `fim|ok`. Parecer Codex final no PR.
- Deploy: migration (ENVELOPE ou SQL Editor) · edge `disparar-pedidos-aprovados` (ledger `pendencias:deploy`) · Publish da tela. Merge ≠ produção.

## 8. Deixado ao construtor

Nomes finais de tabelas/funções/colunas; forma do log de auditoria; layout fino da tela; como o replay TS obtém o calendário; chave do fornecedor; local exato da flag de sombra; formato do alerta de chegada.

## 9. Pareceres (resumo)

**Codex (gpt-6-astra, max):** B-com-mudanças. P0: neutralidade exige calendário base explícito (fórmula `S·B/(90·E)`); calendário não prova completude do histórico — guardas e normalização em simulação até qualificada; "dezembro compra menos" não é invariante segura (estoque cobre até a 1ª chegada; fechamento de fornecedor pode exigir antecipar); ajuste coerente, versionado, reversível; "a caminho" de 7 dias recompra no recesso. P1: "idem sigma" é falso; "PP 30 % baixo" não decorre da mistura; paridade TS×SQL diverge sábado→segunda; ADI/CV² semanais. P2: peso 0,8 sem prova; versionar decisões; alerta de 90 dias não cobre horizonte de 286.

**Fable 5.2 (medições psql-ro):** B-com-mudanças. P0: sem histórico de compra de dezembro; reduzir alvo baixa o estoque de 17/12; 9 dias úteis sem NF inexplicados (≈ tamanho do recesso) → pendência na tela; Semana Santa sem queda, Carnaval 16–18/02 zero → pesos binários. P1: fórmula `(S/90)·U/W`, guardas `W/U<0,6` e teto 1,35; mascarar recesso sobe σ só 4 % → não tocar sigma; backtest (viés sem→com máscara): 19/01 0,87→1,03 · 02/02 1,29→1,52 · 02/03 0,84→1,00 · 16/03 0,79→0,93 · controles 06/04 e 01/09 iguais; WAPE por SKU não melhora. Ponto único na CTE `base`; EOQ usa `d×252` (mesmo débito). P2: "a caminho" 7 dias; espelhos de dias úteis — não tocar.

## 10. Débitos registrados

- Mistura dia corrido × dia útil em PP/SS e EOQ (`d×252`).
- Pesos fracionários calibrados por venda real × esperada (sensor por dia `meia_equipe`).
- Antecipação pré-Carnaval (janela 02/02 piora com a máscara).
- LT histórico cruzando o recesso (jan/2027): mascarar na medição vs somar no futuro = dupla contagem.
- Férias por funcionário sobre o mesmo calendário.
