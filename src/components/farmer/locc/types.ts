// Tipos da tela FarmerLOCC (Laboratório de Otimização Comercial Contínuo).
// Extraídos verbatim de src/pages/FarmerLOCC.tsx (god-component split).

export type TabKey = 'overview' | 'experiments' | 'capacity' | 'adaptive';

export interface ScoringSummary {
  totalClients: number;
  avgHealth: number;
  avgPriority: number;
  saudavel: number;
  estavel: number;
  atencao: number;
  critico: number;
}

export interface NewExperimentInput {
  title: string;
  hypothesis: string;
  primary_metric: string;
  min_duration_days: number;
  min_sample_size: number;
  min_significance: number;
  control_description: string;
  test_description: string;
}
