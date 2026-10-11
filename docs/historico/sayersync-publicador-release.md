# Publicador de release do SayerSync pelo app (2026-10-11)

**Entrega:** bucket `releases` (`db/2026-10-11-bucket-releases-sayersync.sql`, aplicado via `db:aplicar`,
recibos #343 e #347) + aba master-only **Releases do conector** em Tintométrico → Integração
(`src/components/tint/PublicadorReleaseSayersync.tsx`, lógica em `src/lib/tint/release-sayersync.ts`).
Motivo: o auto-update do conector nunca foi ativado — o bucket não existia e o founder não tem painel
do Supabase (Lovable Cloud). Opção B (CI + edge) descartada: o conector muda poucas vezes por mês.

**Desenho:** leitura pública (rota `/object/public` não passa por RLS); INSERT/UPDATE/SELECT só master
em `storage.objects`; sem DELETE (binário publicado é imutável). A tela sobe o `.exe` com
`upsert=false` e SÓ DEPOIS grava o manifest (`upsert=true`, `cacheControl 60`), relendo-o para
conferir. Se o `.exe` já está no ar com o MESMO sha256, retoma (publicação que caiu entre os passos);
com sha diferente, recusa.

## Lições (medidas na prova `db/test-bucket-releases.sh`)

- **Upsert num nome existente não testa a policy de INSERT.** `INSERT … ON CONFLICT DO UPDATE` que
  colide cai no ramo UPDATE e é julgado pelas policies de UPDATE/SELECT. A 1ª versão da prova só
  fazia upsert do manifest — a sabotagem "INSERT aberto a todos" ficou VERDE. Corrigido com um
  INSERT de `.exe` NOVO por papel. É o caminho perigoso de verdade (publicar binário malicioso).
- **SELECT e UPDATE master-only são redundantes entre si na escrita:** UPDATE sob RLS só enxerga a
  linha que a SELECT mostra. Abrir só uma das duas fica verde; a sabotagem do ramo UPDATE tem de
  abrir as duas.
- **Sabotagem que quebra o texto que a postcondição procura prova a POSTCONDIÇÃO, não a RLS.**
  Trocar `'master'` por `'employee'` deixava vermelho pela postcondição (`LIKE '%has_role%master%'`).
  `… OR true` preserva o texto e abre a policy — aí o vermelho vem dos asserts.
- **Storage responde objeto ausente com HTTP 400 + `{"statusCode":"404"}`** (não 404). Bucket
  ausente também é 400, com `"Bucket not found"` — a tela só trata o 1º como "nenhum publicado".
- **Falha ao BUSCAR o manifest conta para o crash-loop guard** do conector (`update.go`
  `CheckAndApplyUpdate`): `update_manifest_url` só entra no `config.json` depois do manifest no ar.
