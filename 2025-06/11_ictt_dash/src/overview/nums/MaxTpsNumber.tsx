import { useQuery } from '@tanstack/react-query'
import { getApiGlobalOverviewMaxTpsObserved } from "../../client/sdk.gen"


interface MaxTpsObservedResponse {
    maxTps: number
    timestamp: number
    totalTxsInMinute: number
}

export default function MaxTpsNumber() {
    const { data, isError, isLoading } = useQuery<MaxTpsObservedResponse>({
        queryKey: ['maxTpsObserved'],
        queryFn: async () => {
            const response = await getApiGlobalOverviewMaxTpsObserved()

            if (!response.data) {
                throw new Error('Failed to fetch max TPS observed')
            }

            return response.data
        }
    })

    const displayValue = isLoading ?
        "..." :
        isError ?
            "Error" :
            (data?.maxTps || 0).toFixed(2)

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="text-center">
                <div className="text-5xl font-bold text-gray-900 mb-2">
                    {displayValue}
                </div>
                <div className="text-sm text-gray-600">Max TPS observed in the last 7 days</div>
            </div>
        </div>
    )
}
