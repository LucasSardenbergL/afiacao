# Radar — o `abriu` passa a dizer QUAL ficha foi aberta (2026-11-06)

Passo 1 de 3 do plano "Radar sucessor" (sensor → aviso de crédito → CPF mascarado dos sócios), aprovado pelo founder.

## O sintoma e a causa (medidos)

`psql-ro`, 2026-11-06: em `radar_eventos`, `abriu/humano` = 4 eventos, `count(cnpj)` = 0. Os `contato` têm cnpj
(64.299 automáticos e 5 humanos, todos preenchidos).

O CNPJ **não se perdia no outbox nem na cópia: ele nunca existiu na origem.** O trigger
`trg_radar_evento_abertura` (em `analytics_outbox`) só dispara para `navegacao.rota_servida` com rota `/radar`, ou
seja, a **tela** servida, 1 por titular e dia (`PageViewTracker` → `registrarNavegacaoNoLedger`). Abrir a ficha
(`RadarDetailSheet`, estado local de `RadarClientes`) não emitia nada ao ledger. Dois pareceres
(`radar-sucessor-viabilidade-2026-11-04.md` e `radar-vinculo-na-lista-2026-11-06.md`) afirmavam que "abrir a ficha
já grava `abriu` com o CNPJ". Estava errado, e a medição de "fichas com vínculo" seria sempre zero.

## O conserto (o mesmo `abriu`, sem sensor novo)

- **Front:** `RadarDetailSheet` chama `registrarNoLedger('radar.ficha_aberta', cnpj, { cnpj })` 1x por CNPJ aberto
  (efeito por `cnpj`, não por objeto: refetch não repete). A lente "Ver como" fica fora na fonte (`isLensActive`
  dentro de `registrarNoLedger`).
- **Migration `20261106132259_radar_abriu_ficha_com_cnpj.sql`** (TRAVA → PRE → CREATE → PÓS; os 3 corpos de partida
  foram lidos da PROD e batem com o repo):
  1. `analytics_ledger_registrar`: a allowlist ganha `radar.ficha_aberta`. Dedup do ledger = 1 por titular, CNPJ e dia.
  2. `private.radar_evento_abertura` e o trigger: a ficha vira `abriu` **com** cnpj; a tela segue com cnpj NULL.
     Ficha sem CNPJ válido (`^[0-9A-Z]{12}[0-9]{2}$`) não grava (WARNING), para não fabricar cnpj nem contar como tela.
  3. `radar_placar_uso`: `aberturas` segue contando só a tela (`cnpj IS NULL`), porque cada ficha inflaria o número;
     `abriram` (titulares distintos) conta as duas; `aberturas_outbox_sem_evento` cobre as duas fontes.
- Regra de leitura (também no `COMMENT ON COLUMN radar_eventos.cnpj`): em `abriu`, **cnpj NULL = tela, preenchido = ficha**.

## Prova

- PG17: `db/test-radar-placar.sh`, fase B (B1–B6), passando pelo ledger REAL como `authenticated` + JWT. Com
  `--falsificar`, o controle fica verde e as 6 sabotagens da fase B ficam vermelhas no assert delas (cnpj NULL na
  cópia, validação desligada, placar contando ficha, reconciliação só da tela, trigger sem ficha e allowlist sem o
  evento, os dois últimos pegos pela PÓS). A 1ª rodada do `--falsificar` pegou um defeito do próprio teste: o
  cegamento de md5 casava `IF v_` genérico (pegava o gate de auth do ledger) e `false AND a OR b` ainda avaliava `b`.
- Vitest: `RadarDetailSheet.sensor.test.tsx` (4 casos). Falsificado à mão: efeito por objeto, props sem cnpj e lente
  sem gate ficam vermelhos.

## Quando medir

As queries estão em [radar-sucessor-viabilidade-2026-11-04.md](radar-sucessor-viabilidade-2026-11-04.md)
§"Quando medir de novo". O denominador é `abriu` com `cnpj IS NOT NULL`, e só existe a partir do apply desta
migration e do Publish do front. Antes disso, zero ficha significa ausência de dado, não falta de uso.
