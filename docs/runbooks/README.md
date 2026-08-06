# docs/runbooks/ — procedimentos operacionais (movido do CLAUDE.md em 2026-06-14)

Passo-a-passo estável pra tocar áreas sensíveis. **Leia o runbook relevante ANTES de agir.** As REGRAS-chave estão destiladas no CLAUDE.md (§0 Armadilhas + §5 "Banco & deploy"); aqui fica o detalhe operacional completo.

> 🚦 **A tabela abaixo é GATEADA** (`scripts/docs-indice-gate-check.ts`, dentro do `bun run test`): runbook sem linha aqui — ou linha apontando para arquivo que não existe — deixa o CI **vermelho**. O `tint-sync-corte-csv.md` viveu fora do índice **sem um único link no repo inteiro**: existia e era inalcançável.

| Runbook | Quando ler |
| --- | --- |
| [lovable-supabase.md](lovable-supabase.md) | tocar **banco, migration, edge function, deploy do frontend, cron, schema** no Lovable/Supabase |
| [tint-sync-corte-csv.md](tint-sync-corte-csv.md) | **aposentar o CSV manual** do catálogo tintométrico e ligar o sync SayerSystem em tempo real (faxina → re-scan → reconciliação → flip). ⚠️ money-path: o **flip** é a operação de risco — só depois da reconciliação provar divergência ~zero |
