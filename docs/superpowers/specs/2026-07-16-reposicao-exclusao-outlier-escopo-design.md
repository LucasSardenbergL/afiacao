# Exclusão de outlier — decisão de escopo (money-path, reposição)

> **Decisão: retirar a capacidade de excluir outliers.** Não ligar a exclusão ao motor, não manter a
> promessa na tela, não construir quarentena/replay. Convergência Claude + Codex (`gpt-5.6-sol`,
> xhigh, 2 rodadas — a 2ª reverteu o veredito da 1ª diante da medição).
>
> Contexto: `docs/agent/money-path.md`, `docs/agent/reposicao.md`. Antecedente direto: #1357
> (stack de outliers passa a ler por NFe), cujo cabeçalho registrou esta lacuna como fora de escopo.

## 1. O problema

A tela de Alertas de Outlier (`/admin/reposicao/alertas`) oferece "Excluir" e afirma, literalmente,
*"one-off, remove da estatística"*, exibindo um painel "Impacto se excluir: σ atual → sem outlier".
Nada disso acontece. `resolver_outlier` marca o evento e grava `observacoes_excluidas`, mas essa
tabela **não entra em nenhum ponto** da cadeia que alimenta o motor:

```
LEADTIME  v_sku_leadtime_efetivo → v_sku_leadtime_estatisticas ─┐
VENDA     v_sku_demanda_efetiva  → v_sku_demanda_estatisticas  ─┴→ v_sku_parametros_sugeridos
          → atualizar_parametros_numericos_skus → sku_parametros → gerar_pedidos_sugeridos_ciclo
```

`observacoes_excluidas` é lida por exatamente duas funções — `detectar_outliers_empresa` (só no
anti-reflag, para não re-emitir o mesmo evento) e `resolver_outlier` (o writer). Nenhuma view, nenhuma
matview. A CTE de estatística do próprio detector não a subtrai. A tela ainda chama
`atualizar_parametros_numericos_skus` após a decisão, reforçando a expectativa: o recálculo roda, sobre
a mesma base.

**Vale para os dois tipos**, não só leadtime: `venda_atipica` tem a mesma lacuna pelo caminho paralelo.

## 2. O que a medição em prod mostrou (read-only, antes de decidir)

A fórmula real do motor (`v_sku_parametros_sugeridos`, conferida via `pg_get_viewdef`):

```
sigma_lt_d = sqrt( LT·σ_d²  +  d²·σ_LT² )
ss = ceil( z_aplicado · sigma_lt_d )
pp = ceil( d·LT + z_aplicado · sigma_lt_d )
```

**(a) No leadtime, excluir não move NADA.** Nos SKUs que a fonte deduplicada ainda flagra e que estão
habilitados no motor, excluir o outlier derruba o desvio do leadtime pela metade ou mais (e baixa
também o LT médio) — e **nem `ss` nem `pp` mudam**. Motivo: o termo do leadtime é `d²·σ_LT²`, e nesses
SKUs `d` é da ordem de 0,1 un/dia; ao quadrado, esmaga o termo. O ruído que domina é o da **demanda**
(CV entre 3 e 5). A queda efetiva em `sigma_lt_d` fica abaixo de 4%, e o `ceil()` absorve o resto.
Corolário: **mexer no leadtime não move a compra; quem manda é o σ da demanda.**

**(b) Na venda, excluir move demais.** Quase todos os eventos pendentes de `venda_atipica` são de SKUs
habilitados no motor, e excluir derruba `d` — que entra em `pp = d·LT + …` e em tudo mais — em média
mais de 10%, e no pior caso em mais de 80%. É uma alavanca real de "comprar menos", sem gate nem
medição.

**(c) A cascata (outlier chasing) não acontece.** Simulado em prod: excluir o pior outlier de cada SKU
não faz nenhuma outra observação cruzar 2σ, e nenhum SKU cai abaixo do gate de 3 observações. Há um
teto matemático (Codex): com desvio amostral e z calculado incluindo o próprio ponto,
`z_max = (n−1)/√n` — nada cruza 2σ com menos de 6 observações, nem 3σ com menos de 11.
**A tese da recursão era falsa; foi a medição que mostrou, não o raciocínio.**

**(d) A preferência do operador já está revelada — e não é censurada.** Toda decisão humana já
registrada nesta tela foi `aceitar`; **nenhuma exclusão jamais foi feita**, e a maioria das de venda
traz a justificativa literal *"Vendas normais"*. Isso **não** é silêncio por feature quebrada: o bug
42703 afetava só o ramo de leadtime — no de venda o painel de impacto **funcionava**, e mesmo vendo
"σ atual → sem outlier" e o delta em unidades, o operador escolheu "aceitar" todas as vezes. Faz
sentido para o negócio: em B2B industrial, pedido grande esporádico não é anomalia, é o negócio.
`'ignorar'` também nunca foi usado.

## 3. Decisão e razões

**Retirar a capacidade de excluir outliers.**

- **(A)/(A′) — ligar a exclusão ao motor: rejeitado.** No leadtime não há efeito para ligar. Na venda,
  o efeito grande **aumenta o risco, não a legitimidade** (Codex): um pedido que responde por grande
  parte da demanda pode ser estatisticamente atípico e, ao mesmo tempo, o dado comercial mais
  importante da série. E (A′) — motor lê filtrado, detector lê base cheia — cria **split-brain**: o
  detector deixa de vigiar o modelo que efetivamente compra.
- **(B) cosmético (só mexer no texto): rejeitado.** Continuar gravando `observacoes_excluidas` sob
  semântica cosmética acumula **ordens latentes**: um (A) futuro passaria a aplicar retroativamente
  decisões que o operador tomou achando que eram triagem.
- **(D) quarentena/shadow-mode com replay: rejeitado.** Sua justificativa é gerar sinal de demanda —
  mas o sinal já existe (item 2d), e um replay honesto no leadtime exibiria o **mesmo `ss` antes e
  depois**, **auto-refutando-se**. Infraestrutura para proteger um atuador que não merece ser ligado.
- **Alavanca pela porta dos fundos.** Ligar a exclusão seria recalibrar a fórmula sem medição e sem
  fusível, um SKU por vez — a frente que `reposicao.md` já registra como **fechada** após 4 tentativas
  medidas ("recalibrar a fórmula global arrisca ruptura em tudo").

Reabrir só com **os dois fatos ao mesmo tempo**: exclusões humanas reais e repetidas, com semântica
inequívoca, **e** impacto downstream material. Hoje temos o oposto dos dois.

## 4. Escopo

### 4.1 SQL — uma migration, raio mínimo

Alterar **somente** `resolver_outlier`:
- `p_decisao` passa a aceitar apenas `'aceitar'` (ver 4.2); `'excluir'` e `'ignorar'` passam a ser
  rejeitados com erro explícito. Nenhum evento com status `ignorado` existe no histórico, então nada a
  migrar; e a rejeição é fail-closed (não grava).
- remover o bloco `INSERT INTO observacoes_excluidas` (+ o `ON CONFLICT`).

Isso **desarma a bomba por completo**, e a prova é de schema: `observacoes_excluidas` **não tem grant
algum** para `anon`/`authenticated`/`service_role` — é inalcançável via PostgREST. O `resolver_outlier`
(SECURITY DEFINER, que bypassa) é o **único** caminho de escrita que existe. Sem o INSERT, a tabela
fica permanentemente vazia e sem writer; um (A) futuro terá de introduzir semântica nova por migration
deliberada, em vez de herdar decisões velhas.

**Deliberadamente FORA:**
- **Não** dropar `observacoes_excluidas` — tem consumidor legítimo (o anti-reflag do detector), e o
  `NOT EXISTS` sobre tabela vazia é inócuo.
- **Não** tocar `detectar_outliers_empresa` — função quente do money-path, recém-aplicada pelo #1357.
  Raio menor, risco menor.
- **Não** dropar `estimar_impacto_exclusao_outlier` (fica órfã, sem chamador no banco): ganha `COMMENT`
  de deprecada. Motivo: migration e Publish do Lovable são manuais e independentes. Com `COMMENT`,
  qualquer ordem de apply é segura; com `DROP`, a ordem errada quebra o card em produção. O `DROP` (e
  os 3 bugs que moram nela — fórmula divergente do motor, `COALESCE(σ,0)` fabricando zero, ramo
  inexistente para `sku_*_omie`) vira faxina própria, após o Publish confirmado.

### 4.2 Frontend

- Remover o botão **Excluir** e o **excluir em lote** (`onExcluirLote`).
- Remover o card **"4. Impacto se excluir"**. Com ele morrem três defeitos de uma vez: fórmula
  divergente da do motor (`z` fixo 1,65 · σ por-venda × σ diário · 180d × 90d), `COALESCE(σ,0)`
  fabricando zero (viola *ausente ≠ zero*), e o **"Calculando…" eterno** — que hoje é o estado normal
  dos alertas `sku_inativado_omie`/`sku_reativado_omie`, tipos que a RPC sequer trata.
- Resta **um** botão: "Marcar como revisado" (grava `aceitar`). `'ignorar'` sai: se arquiva, não é
  ignorar — é decidir em silêncio; e nunca foi usado. A justificativa em texto livre continua
  registrando o porquê.
- Texto honesto: esta tela é de **revisão**, não altera parâmetros. A observação permanece no cálculo.
- **Ficam** o badge, o filtro e o contador `Excluído`: `detectar_skus_sem_grupo` continua gravando esse
  status por sistema (auto-resolve), e o histórico precisa renderizar.
- Remover a chamada de `atualizar_parametros_numericos_skus` no ramo da exclusão (teatro + custo).

### 4.3 Resíduo durável

`docs/agent/reposicao.md` ganha a lição medida, para a frente não ser reaberta:
> Excluir outlier de leadtime tem efeito **zero** em `ss`/`pp`: o termo `d²·σ_LT²` é esmagado por
> `LT·σ_d²` nos intermitentes caros (`d`≈0,1; CV 3–5) e o `ceil()` come o resíduo. Quem domina a
> compra é o σ da **demanda**. Ligar exclusão ao motor foi avaliado e rejeitado (este spec).

## 5. Ordem de deploy (Lovable — 2 das 3 camadas)

Qualquer ordem é segura (fail-closed nos dois sentidos), mas a preferida é:
1. **Migration** no SQL Editor → na tela velha, "Excluir" e "Ignorar" passam a falhar fechado
   ("decisão inválida"), sem gravar nada; "Aceitar" — a única ação que o operador de fato usa —
   continua funcionando normalmente na janela entre os dois passos.
2. **Publish** do frontend → os botões somem e o texto passa a dizer a verdade.

Não há edge function envolvida.

## 6. Prova

Money-path + função SQL alterada ⇒ `prove-sql-money-path` (PG17 + falsificação) antes de entregar:
- **positivo:** `resolver_outlier(...,'aceitar')` marca o evento e **não** grava `observacoes_excluidas`;
- **negativo:** `resolver_outlier(...,'excluir')` levanta a SQLSTATE esperada, re-lançando o resto
  (nada de `WHEN OTHERS THEN 'OK'`);
- **invariante:** após o fluxo completo, `observacoes_excluidas` continua vazia;
- **gate preservado:** não-staff segue barrado (`42501`), provado trocando a GUC `test.uid` (uid sem
  role, e `auth.uid()` nulo). Aqui **não** cabe `SET ROLE authenticated`: o gate é interno à função
  (`has_role`), não uma policy RLS — `SET ROLE` provaria outra coisa;
- **falsificação:** sabotar a migration (reintroduzir o INSERT) e exigir vermelho.

Pré-flight obrigatório: `pg_get_functiondef('resolver_outlier')` da PROD antes do `CREATE OR REPLACE`
— o #1357 foi aplicado manualmente hoje e o repo pode divergir; a última a recriar vence.
