import { useState } from 'react'
import { useStore } from '../store'
import type { AppState } from '../types'

type Modal = { open: false } | { open: true; json: string; error: string }

export function ExportImport() {
    const getState = useStore((s) => s.getState)
    const replaceState = useStore((s) => s.replaceState)
    const [modal, setModal] = useState<Modal>({ open: false })

    function openModal() {
        const state = getState()
        setModal({ open: true, json: JSON.stringify(state, null, 2), error: '' })
    }

    function close() {
        setModal({ open: false })
    }

    function load() {
        if (!modal.open) return
        try {
            const parsed = JSON.parse(modal.json)
            if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON structure')
            if (!Array.isArray(parsed.products)) throw new Error('products must be an array')
            if (!Array.isArray(parsed.plate)) throw new Error('plate must be an array')
            const newState: AppState = {
                products: parsed.products,
                plate: parsed.plate,
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            replaceState(newState)
            setModal({ open: false })
        } catch (e) {
            setModal({ ...modal, error: e instanceof Error ? e.message : 'Failed to parse JSON' })
        }
    }

    return (
        <>
            <div className="p-4 border-t mt-8 text-center">
                <button
                    className="px-4 py-2 text-sm text-gray-600 border rounded hover:bg-gray-50 transition-colors"
                    onClick={openModal}
                >
                    Экспорт / Импорт
                </button>
            </div>

            {modal.open && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] flex flex-col">
                        <div className="p-4 border-b font-bold">Экспорт / Импорт данных</div>
                        <div className="p-4 flex-1 overflow-auto">
                            <textarea
                                className="w-full h-64 p-2 border rounded font-mono text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                value={modal.json}
                                onChange={(e) => setModal({ ...modal, json: e.target.value, error: '' })}
                            />
                            {modal.error && (
                                <div className="mt-2 text-red-600 text-sm">{modal.error}</div>
                            )}
                        </div>
                        <div className="p-4 border-t flex gap-2 justify-end">
                            <button
                                className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                                onClick={close}
                            >
                                Закрыть
                            </button>
                            <button
                                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                                onClick={load}
                            >
                                Загрузить
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}

export default ExportImport
