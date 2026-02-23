import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type Company = 'colacor' | 'oben';

interface CompanyInfo {
  id: Company;
  name: string;
  shortName: string;
}

export const COMPANIES: Record<Company, CompanyInfo> = {
  colacor: { id: 'colacor', name: 'Afiação Colacor', shortName: 'Colacor' },
  oben: { id: 'oben', name: 'Oben Comercial', shortName: 'Oben' },
};

interface CompanyContextType {
  activeCompany: Company;
  setActiveCompany: (company: Company) => void;
  companyInfo: CompanyInfo;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export const useCompany = () => {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
};

export const CompanyProvider = ({ children }: { children: ReactNode }) => {
  const [activeCompany, setActiveCompanyState] = useState<Company>(() => {
    const stored = localStorage.getItem('activeCompany');
    return (stored === 'colacor' || stored === 'oben') ? stored : 'colacor';
  });

  const setActiveCompany = (company: Company) => {
    setActiveCompanyState(company);
    localStorage.setItem('activeCompany', company);
  };

  return (
    <CompanyContext.Provider value={{
      activeCompany,
      setActiveCompany,
      companyInfo: COMPANIES[activeCompany],
    }}>
      {children}
    </CompanyContext.Provider>
  );
};
