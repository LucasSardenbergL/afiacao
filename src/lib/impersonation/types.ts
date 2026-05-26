export interface ImpersonationTarget {
  id: string;
  nome: string;
  grupo: 'hunter' | 'farmer' | 'closer' | null;
}
