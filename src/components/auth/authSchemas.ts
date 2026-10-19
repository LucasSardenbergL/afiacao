import { z } from 'zod';
import { ehCnpjAlfanumerico, normalizarDocumento } from '@/lib/omie/cnpj-alfanumerico';

export const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
});

export const documentSchema = z.object({
  document: z.string().min(11, 'Informe um CPF ou CNPJ válido').max(18, 'Documento inválido')
    // Letra no documento só passa como CNPJ alfanumérico VÁLIDO (RFB jul/2026, DV mod-11). Numérico
    // segue sem conferência de DV, como sempre. `normalizarDocumento` devolve só-dígitos para um
    // alfanumérico inválido — e "sobram 11 dígitos" NÃO pode virar o CPF de outra pessoa (fail-closed).
    .refine((v) => !/[a-z]/i.test(v) || ehCnpjAlfanumerico(normalizarDocumento(v)), 'CNPJ alfanumérico inválido'),
});

export const signupSchema = z.object({
  name: z.string().min(2, 'O nome deve ter pelo menos 2 caracteres'),
  tradeName: z.string().optional(),
  email: z.string().email('E-mail inválido'),
  phone: z.string().min(10, 'Telefone inválido'),
  password: z.string().min(6, 'A senha deve ter pelo menos 6 caracteres'),
  confirmPassword: z.string(),
  street: z.string().min(3, 'Endereço é obrigatório'),
  number: z.string().min(1, 'Número é obrigatório'),
  complement: z.string().optional(),
  neighborhood: z.string().min(2, 'Bairro é obrigatório'),
  city: z.string().min(2, 'Cidade é obrigatória'),
  state: z.string().length(2, 'UF deve ter 2 letras'),
  zipCode: z.string().min(8, 'CEP inválido'),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'As senhas não coincidem',
  path: ['confirmPassword'],
});

export type AuthMode = 'login' | 'signup';
export type SignupStep = 'document' | 'form' | 'tools';

export interface OmieClienteData {
  codigo_cliente?: number;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone?: string;
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pessoa_fisica?: string;
}

export interface ToolCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  usage_type: string;
  suggested_interval_days: number;
}

export interface AuthFormData {
  document: string;
  name: string;
  tradeName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

export const INITIAL_FORM_DATA: AuthFormData = {
  document: '', name: '', tradeName: '', email: '', phone: '',
  password: '', confirmPassword: '', street: '', number: '', complement: '',
  neighborhood: '', city: '', state: '', zipCode: '',
};

export const BRAZILIAN_STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
  'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
];

// CNPJ alfanumérico (RFB jul/2026): 12 posições [0-9A-Z] + 2 DVs numéricos. Só entra aqui se o
// usuário digitou letra — o caminho numérico abaixo é byte-idêntico ao de sempre (oráculo no teste).
const formatCnpjAlfanumerico = (value: string): string => {
  const chars = value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const corpo = chars.slice(0, 12);
  const dv = chars.slice(12).replace(/\D/g, '').slice(0, 2);
  return (corpo + dv)
    .replace(/^([0-9A-Z]{2})([0-9A-Z])/, '$1.$2')
    .replace(/^([0-9A-Z]{2}\.[0-9A-Z]{3})([0-9A-Z])/, '$1.$2')
    .replace(/^([0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3})([0-9A-Z])/, '$1/$2')
    .replace(/^([0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4})(\d{1,2})$/, '$1-$2');
};

const formatDocument = (value: string): string => {
  if (/[a-z]/i.test(value)) return formatCnpjAlfanumerico(value);
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 11) {
    return numbers
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

export const formatPhone = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 10) {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{5})(\d)/, '$1-$2');
  }
};

export const formatZipCode = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  return numbers.replace(/(\d{5})(\d)/, '$1-$2');
};

export const handleInputFormat = (field: string, value: string): string => {
  if (field === 'document') return formatDocument(value);
  if (field === 'phone') return formatPhone(value);
  if (field === 'zipCode') return formatZipCode(value);
  if (field === 'state') return value.toUpperCase().slice(0, 2);
  return value;
};
