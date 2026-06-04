// src/lib/route/painel/types.ts

/** Linha de route_queue_snapshot (snake_case, como vem do banco). */
export interface SnapshotRow {
  data_rota: string;
  farmer_id: string;
  customer_user_id: string;
  cidade: string | null;
  bucket: string | null;
  valor_da_ligacao: number | null;
  rank: number | null;
  cliente_nome?: string | null;
}

/** Linha de route_contact_log relevante ao painel. */
export interface ContatoRow {
  data_rota: string;
  farmer_id: string | null;
  customer_user_id: string | null;
  canal: string;                 // 'ligacao' | 'whatsapp'
  status: string | null;         // enviado/respondido/convertido/sem_resposta/opt_out
  valor_da_ligacao: number | null;
  bucket: string | null;
}

/** Taxa com freio de baixo volume (codex P3.7). */
export interface TaxaGated {
  valor: number | null;          // fração 0..1, null se não exibível
  exibivel: boolean;             // n >= min
  fracao: string;                // "3/12"
  n: number;                     // denominador
}

export interface GrupoEficacia {
  chave: string;                 // farmer_id / bucket / canal
  contatos: number;
  resposta: TaxaGated;
  conversao: TaxaGated;
  optout: TaxaGated;
  valor_capturado: number;       // Σ valor das convertidas (score esperado, NÃO R$)
}

/** Cliente de alto valor que ficou sem contato na janela analisada. */
export interface GapCliente {
  customer_user_id: string;
  cliente_nome: string | null;
  cidade: string | null;
  farmer_id: string;
  valor: number;
  data_rota: string;
}

export interface PainelAgregado {
  // cobertura (ligação): elegíveis = snapshot; contatados = elegíveis com contato
  elegiveis_n: number;
  contatados_n: number;
  cobertura_count: TaxaGated;
  elegiveis_valor: number;
  contatados_valor: number;
  gap_valor: number;             // Σ valor dos elegíveis NÃO contatados (headline)
  // gap acionável: quem não foi contatado (top por valor)
  gap_clientes: GapCliente[];
  gap_clientes_total: number;    // total de elegíveis sem contato (antes do top 15)
  // capacidade
  contatos_total: number;
  dias_com_dado: number;
  contatos_por_dia: number;      // contatos_total / dias_com_dado (0 se sem dado)
  dias_sem_denominador: number;  // dias com contato de ligação mas sem snapshot
  // eficácia global (sobre contatos de ligação)
  global: GrupoEficacia;
  // cortes
  por_vendedora: GrupoEficacia[];
  por_bucket: GrupoEficacia[];
  por_canal: GrupoEficacia[];    // aqui contatos de TODOS os canais
}
