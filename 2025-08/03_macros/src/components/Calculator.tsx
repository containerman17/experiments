import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { PlateItem, Product } from '../types'
import { formatNumber, scaleMacros, sumTotals } from '../utils'

export function Calculator() {
    const products = useStore((s) => s.products)
    const plate = useStore((s) => s.plate)
    const addToPlate = useStore((s) => s.addToPlate)
    const removeFromPlate = useStore((s) => s.removeFromPlate)
    const clearPlate = useStore((s) => s.clearPlate)

    const [selectedId, setSelectedId] = useState<string>('')
    const selected = products.find((p) => p.id === selectedId)
    const [amount, setAmount] = useState<string>('')

    const productsById = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p])), [products]) as Record<string, Product>
    const totals = useMemo(() => {
        const list = plate.map((pi) => scaleMacros(productsById[pi.productId], pi.amount))
        return sumTotals(list)
    }, [plate, productsById])

    function add() {
        const n = Number(amount)
        if (!selected) return
        if (Number.isNaN(n) || n <= 0) return
        addToPlate(selected.id, n)
        setAmount('')
    }

    return (
        <div className="flex flex-col h-full">
            <div className="p-3 border-b">
                <h2 className="text-lg font-bold mb-3">Калькулятор</h2>

                <div className="space-y-2">
                    <select
                        className="w-full px-2 py-1.5 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        value={selectedId}
                        onChange={(e) => setSelectedId(e.target.value)}
                    >
                        <option value="">Выберите продукт</option>
                        {products.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name} {formatNumber(p.macros.protein)}/{formatNumber(p.macros.fat)}/{formatNumber(p.macros.carbs)}
                            </option>
                        ))}
                    </select>

                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <input
                                className="w-full px-2 py-1.5 pr-10 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                placeholder={selected ? (selected.mode === 'per100g' ? 'Граммы' : 'Порции') : 'Количество'}
                                value={amount}
                                onChange={(e) => setAmount(e.target.value.replace(/,/g, '.'))}
                                onKeyDown={(e) => e.key === 'Enter' && add()}
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                                {selected?.mode === 'per100g' ? 'г' : 'пор.'}
                            </span>
                        </div>
                        <button
                            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            onClick={add}
                            disabled={!selected || !amount}
                        >
                            Добавить
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto" style={{ minHeight: '100px' }}>
                {plate.map((pi) => (
                    <PlateRow
                        key={pi.id}
                        plateItem={pi}
                        product={productsById[pi.productId]}
                        onRemove={() => {
                            if (confirm('Удалить из тарелки?')) removeFromPlate(pi.id)
                        }}
                    />
                ))}
                {plate.length === 0 && (
                    <div className="text-center py-8 text-gray-500 text-sm">
                        Тарелка пустая
                    </div>
                )}
            </div>

            <div className="border-t bg-gray-50 p-4">
                <div className="grid grid-cols-4 gap-2">
                    <div className="text-center">
                        <div className="text-2xl font-bold">{formatNumber(totals.protein)}</div>
                        <div className="text-xs text-gray-600">белки</div>
                    </div>
                    <div className="text-center">
                        <div className="text-2xl font-bold">{formatNumber(totals.fat)}</div>
                        <div className="text-xs text-gray-600">жиры</div>
                    </div>
                    <div className="text-center">
                        <div className="text-2xl font-bold">{formatNumber(totals.carbs)}</div>
                        <div className="text-xs text-gray-600">углеводы</div>
                    </div>
                    <div className="text-center">
                        <div className="text-2xl font-bold">{formatNumber(totals.kcal)}</div>
                        <div className="text-xs text-gray-600">ккал</div>
                    </div>
                </div>
                {plate.length > 0 && (
                    <div className="mt-4 text-center">
                        <button
                            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors text-sm"
                            onClick={() => {
                                if (confirm('Очистить всю тарелку?')) clearPlate()
                            }}
                        >
                            Очистить
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}

function PlateRow({ plateItem, product, onRemove }: { plateItem: PlateItem; product: Product; onRemove: () => void }) {
    const scaled = scaleMacros(product, plateItem.amount)
    const unit = product.mode === 'per100g' ? 'г' : 'пор.'

    return (
        <div className="px-3 py-2 border-b hover:bg-gray-50 transition-colors group">
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{product.name}</div>
                    <div className="text-xs text-gray-600">
                        Б: {formatNumber(scaled.protein)}
                        <span className="mx-1">•</span>
                        Ж: {formatNumber(scaled.fat)}
                        <span className="mx-1">•</span>
                        У: {formatNumber(scaled.carbs)}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="text-sm font-medium text-gray-700">
                        {formatNumber(plateItem.amount)} {unit}
                    </div>
                    <button
                        className="px-2 py-1 text-xs bg-gray-100 border border-red-300 text-red-600 rounded hover:bg-red-50 transition-colors"
                        onClick={onRemove}
                    >
                        ✕
                    </button>
                </div>
            </div>
        </div>
    )
}

export default Calculator
