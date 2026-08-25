// GERADO por `bun scripts/sonda-fingerprint.ts --write` — NÃO editar à mão.
//
// Fingerprint da FONTE de cada edge instrumentada: SHA-256 sobre o fecho transitivo dos imports
// LOCAIS a partir do `index.ts`, incluindo `_shared/`. É a metade que o gate `sonda:bump` não
// alcança: ele cobre mudança dentro da pasta da edge, e `_shared/` ficou fora dele de propósito
// (~12 bumps à mão por PR). Aqui o fan-out é de graça porque o CI REGENERA.
//
// Servido por `criarRespostaSonda` no campo `fonte` — é isso que torna a identidade função do
// CONTEÚDO, e não da disciplina de quem bumpa. Regravar este arquivo à mão para calar o gate
// derrota o mecanismo inteiro: rode o `--write`.
//
// ⚠️ Fingerprint da FONTE, não hash do BUNDLE — não há `deno.lock` versionado e há range aberto
// (`npm:@supabase/supabase-js@2`), então a mesma fonte pode resolver dependência externa diferente.

export const FONTE_SHA256: Record<string, string> = {
  "ai-ops-agent": "e99f44ce40dc938f4f3d832096151c8ad3c8084baa378f408ad1eb302ea9acfa",
  "algorithm-a-audit": "5154d12e9b869e5c56b33a775a68accc18e2f675466bec50c7132d2f4997a24b",
  "analyze-unified-order": "51560d34ee92ebddc17ce8bb949c15ec87ad26ec6b848982372d594323f79171",
  "calculate-scores": "2c908fd2fe753c6d1e4d37998baa25c8999a895837363fa53cdbec408b1db963",
  "carteira-positivacao-snapshot": "5c6e6bfb423e86de7ecfb69e7e4046fbcfd7d378ba814b37f3a03e7ea11a0fab",
  "conciliar-pedido-portal": "c5e8f0f688486a6dcedfdc459e675e8827db712668d26c14dd197ad8db49ee6d",
  "disparar-pedidos-aprovados": "1885293ff4d579fa780172689fef32cd079aa68eb02a4d3adcb2d96af83be487",
  "enviar-pedido-portal-sayerlack": "2160ab355211325f25ec53240941ce084d11de14bfd11a55ebbd814a16d6b170",
  "fin-cashflow-engine": "d28b84dd46e39d582a0bf4d5b2d6298cf729c97d00a220762cfa1ec853c3c5d9",
  "fin-funding": "0bd5ac7ca9b4f97422b5117f1c07ff5bd91b9c791395f331fdb8b4fc499afeb5",
  "fin-valor-cockpit": "aaf36c80dd0f48da239ab61a3ff4f68484bc680ca4ef26f1a305f4fb71c837ee",
  "generate-bundle-argument": "67ed07a97c2bac1dc129a5110f5706be5f5508d53d76e7d6cd1717c3b461c80f",
  "generate-tactical-plan": "5a538e47802433f15a6f9e03ec1d05265592e346326be0c509a54cb1de895c6f",
  "gerar-pedidos-diario": "445e8028fe4f6fa01dcdd65774e0a51121905fe1fd1c0596047c34a04aa36411",
  "monthly-report": "696cbc63b3a72fccca4574c3d04cc30832068aed97e60796255dd531a6b53066",
  "omie-analytics-sync": "ffcf6dba506e05d495967d04530f862d978f3e7988a76f84aa4617e7c00f880d",
  "omie-cliente": "ccba61f0caef5c18af6ebba7c39167bc36aaed0511f235c3e9dad754fe1ba769",
  "omie-financeiro": "bb48e15bf8c0537b39774948e58e5eb35bdeeff24a5de535e68522aab6607f16",
  "omie-nfe-recebimento": "035279dacb799470cdd32a7143a6e48d5de9ba4dc5d21909d4a7635551cd2681",
  "omie-nfe-webhook": "c2267dae835b18c9f4214a6c9621f530a384e150e345cbbcecb7b2eca0e5d319",
  "omie-sync-estoque": "e3ac1da492d7470c6b6019df127b560a91ff70e9399ca72bcb3abd45af1b2bfb",
  "omie-sync-nfes-recebidas": "12c222a035c780569edefae4456ba4c5457ec020890f07acd0e142ef50d4dae3",
  "omie-sync-status-produtos": "2767f1dfa0f1caadf823e7a8f6cca8364b4359ba97938c3cf40b4d0bed8124a3",
  "pedido-programado-enviar": "c4e2a9ed647e5fc0096b55ddcce3e20668d0f88363eeda82e1909962d3b178a0",
  "process-nfe": "e00a9048f96b00d79b8270460ccc47cef00a3b35ab3218988324df355b35f80f",
  "recommend": "d557f77ac5ad8d56f6f1a71afacb365c9a0736c51219c77d8362a4c7b5bbafa3",
  "reposicao-depara-sayerlack-auto": "c737bd1bac8dda29828fd109433db88f5e70f67fcc72e735058c6ac28305c1ae",
  "sayerlack-captura-precos": "067de5a255cf9b09e7d73995f2f6986d14cf1869dbfaf7242317866b3a263e1c",
  "scoring-recalc-batch": "31400ba3636bfcfb1cf37f22bc0c0fce8f85f7c701a8c3b64fbed40c63b88aa2",
  "sync-reprocess": "7ec0dcc6f80ed8606976afc57d1c3fbd7b424a79f0d6afbafda686055913941b",
  "tactical-plans-batch": "d8dc319ca9e2a7b1e97390514dbf8cc821432665666c3c744293d40db4406973",
  "visit-score-recalc-batch": "873b13d7085b7086305e3397aedc1d000b197141f8eba40e3a09139a3ba3eb36",
};
