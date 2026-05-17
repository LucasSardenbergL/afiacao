export type RagSource = 'customer_processes' | 'standard_processes' | 'kb_documents';

export interface RagSearchResult {
  source_table: RagSource;
  source_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface RagSearchOptions {
  top_k?: number;
  sources?: RagSource[];
  filters?: {
    segmento?: string;
    customer_user_id_in?: string[];
    exclude_customer_user_id?: string;
  };
}
