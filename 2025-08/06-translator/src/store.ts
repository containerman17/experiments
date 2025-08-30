import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type LanguagePair = 'ja-en' | 'en-ru' | 'ru-ja'

interface HistoryItem {
    id: number
    transcription: string
    translation: string
    sourceLang: string
    targetLang: string
}

interface AppState {
    // Settings
    apiKey: string
    languagePair: LanguagePair
    model: 'gemini-2.5-flash' | 'gemini-2.5-pro'
    showSettings: boolean

    // History (max 10 items)
    history: HistoryItem[]

    // UI State
    error: string

    // Actions
    setApiKey: (key: string) => void
    setLanguagePair: (pair: LanguagePair) => void
    setModel: (model: 'gemini-2.5-flash' | 'gemini-2.5-pro') => void
    setShowSettings: (show: boolean) => void
      setError: (error: string) => void
  addHistoryItem: (item: Omit<HistoryItem, 'id'>) => void
  clearHistory: () => void
}

export const useAppStore = create<AppState>()(
    persist(
        (set, _) => ({
            // Initial state
            apiKey: '',
            languagePair: 'ja-en',
            model: 'gemini-2.5-pro',
            showSettings: false,
            history: [],
            error: '',

            // Actions
            setApiKey: (key: string) => set({ apiKey: key }),

            setLanguagePair: (pair: LanguagePair) => set({ languagePair: pair }),

            setModel: (model: 'gemini-2.5-flash' | 'gemini-2.5-pro') => set({ model }),

            setShowSettings: (show: boolean) => set({ showSettings: show }),

            setError: (error: string) => set({ error }),

                  addHistoryItem: (item: Omit<HistoryItem, 'id'>) => set((state) => {
        const newItem = { ...item, id: Date.now() }
        const newHistory = [...state.history, newItem]
        // Keep only last 10 items
        const trimmedHistory = newHistory.slice(-10)
        return { history: trimmedHistory }
      }),
      
      clearHistory: () => set({ history: [] }),
        }),
        {
            name: 'translator-storage',
            // Only persist certain fields
            partialize: (state) => ({
                apiKey: state.apiKey,
                languagePair: state.languagePair,
                model: state.model,
                history: state.history,
            }),
        }
    )
)
