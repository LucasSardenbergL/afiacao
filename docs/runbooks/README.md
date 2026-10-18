# docs/runbooks/ — procedimentos operacionais (movido do CLAUDE.md em 2026-06-14)

Passo-a-passo estável pra tocar áreas sensíveis. **Leia o runbook relevante ANTES de agir.** As REGRAS-chave estão destiladas no CLAUDE.md (§0 Armadilhas + §5 "Banco & deploy"); aqui fica o detalhe operacional completo.

> 🚦 **A tabela abaixo é GATEADA** (`scripts/docs-indice-gate-check.ts`, dentro do `bun run test`): o que vale é a **1ª coluna** — ser citado dentro do resumo de outra entrada **não** conta como estar indexado. Deixam o CI **vermelho**: runbook sem linha própria · linha apontando para arquivo que não existe · o mesmo doc em duas linhas · `[a.md](b.md)` (texto ≠ destino) · resumo com menos de 30 chars. O `tint-sync-corte-csv.md` viveu fora do índice **sem um único link no repo inteiro**: existia e era inalcançável. Detalhe em [gate-indice-docs.md](../historico/gate-indice-docs.md).

| Runbook | Quando ler |
| --- | --- |
| [lovable-supabase.md](lovable-supabase.md) | tocar **banco, migration, edge function, deploy do frontend, cron, schema** no Lovable/Supabase |
| [datawedge-picking.md](datawedge-picking.md) | configurar o **leitor Zebra (DataWedge)** para o picking v2: perfil KEYSTROKE com prefixo `~~` + AIM id + ENTER, e o teste do aparelho |
| [tint-sync-corte-csv.md](tint-sync-corte-csv.md) | **aposentar o CSV manual** do catálogo tintométrico e ligar o sync SayerSystem em tempo real (faxina → re-scan → reconciliação → flip). ⚠️ money-path: o **flip** é a operação de risco — só depois da reconciliação provar divergência ~zero |
| [importar-nfe-recebimento-rpc.md](importar-nfe-recebimento-rpc.md) | aplicar a **RPC transacional de recebimento de NF-e** (`db/2026-10-18-importar-nfe-recebimento-rpc.sql`) e as edges `omie-nfe-webhook` v1.4 / `omie-nfe-recebimento-sync` v1.5 NA ORDEM certa (migration → validação → `NOTIFY pgrst` → as 2 edges na mesma leva → validação ponta a ponta com denominador). ⚠️ money-path: edge sem a migration responde 500 nomeando-a; a janela de versões mistas e o passivo (52 efetivado sem itens) estão descritos |
