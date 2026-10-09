# Ordem não é impedimento — a fila do `db:aplicar` deixava os mesmos bytes executarem duas vezes (2026-10-08)

**Arquivos:** `db/claude-rw-bootstrap.sql` (o re-check), `db/aplicar-porta-recheck.sql` (o delta v2→v3),
`db/test-db-aplicar.sh` (A15–A19b, S3, S14/S15), `db/test-pre-anti-deriva-concorrencia.sh` (âncora
`MD5_V2_FILA`), `db/fixtures/db-aplicar-dupla.sql`.

## O defeito

`public.aplicar_sql` travava a tentativa com `WHERE id = p_id … FOR UPDATE` — por `id`, e `id` não é o
eixo da decisão. O executor grava a tentativa FORA da transação, então dois `db:aplicar` simultâneos do
mesmo arquivo nascem com ids diferentes, passam os dois pela etapa 3 (o ledger ainda não tem recibo) e
chegam os dois à porta. Estava registrado como limite em
`docs/superpowers/specs/2026-09-09-atomicidade-migration-db-aplicar-design.md`.

A fila de 2026-09-27 (advisory `(20260909, 1)`) nasceu por OUTRO motivo — a corrida PRE→CREATE entre
migrations *diferentes* — e pôs os dois applies em ORDEM. Ordem não é impedimento: o 2º esperava a vez,
entrava com uma tentativa válida e executava o corpo de novo. Nenhum teste cobria os MESMOS bytes: as
fixtures de corrida (`db-aplicar-corrida-a/-b`) têm corpos diferentes.

## O dano — medido, não suposto

O brief falava em "dupla aplicação em produção". Medido em PG17 contra a porta da main (A15, vermelho
antes da correção): **execuções = 2, dado = 1, recibos = 1**, e o 2º saindo 4 com
`duplicate key … "db_aplicacoes_sha_aplicada_uniq"`. O índice único do recibo reverte a transação
inteira do 2º — **o dado se salva, a execução não**. Não voltam: o que não é transacional
(sequência/IDENTITY consumidas), a carga e os locks de rodar a migration duas vezes, e uma falha de
unicidade confusa no lugar de uma recusa com nome. Em prod a única extensão de efeito externo é `pg_net`,
assíncrona e transacional (a fila dela é tabela), então também revertida.

**Contar o dado aprovaria o defeito.** A fixture conta as duas coisas separadas: `nextval` mede
EXECUÇÕES (não-transacional: avança à vista das outras sessões antes do commit e sobrevive ao rollback);
a tabela mede o DADO. A diferença entre as duas contagens é o dano.

## A correção

Depois da fila e antes do `EXECUTE`, a porta procura recibo `aplicada` do mesmo sha e recusa com
`RECUSA_SHA_JA_APLICADO` sem executar. A posição importa: antes da fila a leitura seria a de um 1º que
ainda não commitou — ausência de recibo lida como "inédito" (é a S15). E só vale porque a fila exige
READ COMMITTED: o comando seguinte tira snapshot novo e enxerga o commit de quem segurava a vez.
Só no apply real: o `--ensaio` grava `'ensaio:'||sha` e segue livre, por desenho.

A pós-condição do bootstrap passou a exigir o re-check ENTRE a fila e o `EXECUTE` (ordem, não presença),
ancorada em `\n  EXECUTE ` e não na linha inteira — a S9 troca o argumento do `EXECUTE` e precisa
continuar instalando.

## A prova

- **A15:** dois applies; o 1º para num PORTÃO dentro do corpo, segurando a vez, até a prova ver o 2º no
  ponto de decisão (`pg_stat_activity`: `PgSleep` / `advisory`). A sobreposição é medida, não torcida:
  em série o re-check sozinho bastaria e a S15 ficaria verde sem a fila ser exercitada. O portão abre
  com `pg_cancel_backend` — na lista do `SELECT`, não no `WHERE`, onde o planner poderia avaliá-lo antes
  do filtro e cancelar também quem espera a vez.
- **S14 (sem re-check) e S15 (sem fila):** cada camada sozinha deixa o corpo rodar 2×, por caminho
  diferente. O mesmo cenário entrou no CONTROLE de entrada e de saída das 3 combinações.
- **S3 mudou de marca.** Com o guard "já aplicada" do executor removido, quem barra o re-apply agora é a
  porta, ANTES de executar — e a ausência da marca do índice passou a ser exigida. O cabeçalho da prova
  dizia que a S3 "não aplica duas vezes"; até o re-check isso era falso.

## O delta, e a sonda que pulava o caminho que mudou

O molde do delta da fila sonda a porta nova com uma tentativa de ENSAIO — e o ensaio PULA o re-check.
Copiar o molde deixaria um re-check quebrado (PL/pgSQL é late-bound) passar pela PÓS e explodir no
primeiro apply real: uma porta que nem o próprio conserto atravessa. A PÓS do novo delta percorre o
caminho real — aplica, e depois exige a recusa dos mesmos bytes. **A19** prova que ela barra um re-check
quebrado (42703, a v2 fica); **A19b**, o controle, que com a sonda só de ensaio o mesmo quebrado APLICA.

## A âncora que confundia "o delta X" com "a porta atual"

`test-pre-anti-deriva-concorrencia.sh` usava `MD5_BOOT` para dizer "o que o delta da fila deixa".
Enquanto os dois coincidiam nada aparecia; ao mudar o bootstrap, E3/E12/E14/E14b caíram juntos. O delta
da fila virou história e ganhou âncora congelada (`MD5_V2_FILA`, conferida por `psql-ro`), como já
tinha a v1.

## Lições

1. **Trava sem re-check sob a trava ORDENA, não impede.** A trava é metade do padrão; a outra metade é
   reler o estado depois de obtê-la.
2. **Recibo transacional protege o dado, não a execução.** Para medir aplicação dupla, conte por um
   canal que o rollback não apaga.
3. **A sonda da pós-condição tem de percorrer o caminho que mudou.** Se o código novo só roda no modo
   real, sondar pelo ensaio é teatro — e o controle (A19b) é o que mostra isso.
4. **Brief de base velha não vale.** Escrito em 09/09, ele pedia a trava por sha; 396 commits depois a
   main já tinha a fila. Reimplementar a trava teria revertido a entrega de outra sessão — o que faltava
   era só o re-check.
