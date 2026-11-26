import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type NtpsLocale = 'en' | 'ar';

interface LocaleContextValue {
  locale: NtpsLocale;
  dir: 'ltr' | 'rtl';
  isRtl: boolean;
  setLocale: (next: NtpsLocale) => void;
  toggleLocale: () => void;
  tr: (en: string, ar: string) => string;
}

const STORAGE_KEY = 'ntps_ui_locale';

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  dir: 'ltr',
  isRtl: false,
  setLocale: () => {},
  toggleLocale: () => {},
  tr: (en) => en,
});

function readInitialLocale(): NtpsLocale {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    // Ignore storage access errors
  }
  return 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<NtpsLocale>(readInitialLocale);

  const dir: 'ltr' | 'rtl' = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = dir;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Ignore storage write errors
    }
  }, [locale, dir]);

  const setLocale = useCallback((next: NtpsLocale) => {
    setLocaleState(next);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => (prev === 'en' ? 'ar' : 'en'));
  }, []);

  const tr = useCallback(
    (en: string, ar: string) => (locale === 'ar' ? ar : en),
    [locale]
  );

  const value = useMemo(
    () => ({
      locale,
      dir,
      isRtl: locale === 'ar',
      setLocale,
      toggleLocale,
      tr,
    }),
    [locale, dir, setLocale, toggleLocale, tr]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
