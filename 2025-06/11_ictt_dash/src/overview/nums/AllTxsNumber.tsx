import { useQuery } from '@tanstack/react-query'
import { getApiGlobalOverviewLastWeekTxs } from "../../client/sdk.gen"


interface LastWeekTxsResponse {
    totalTxs: number
}

export default function AllTxsNumber() {
    const { data, isError, isLoading } = useQuery<LastWeekTxsResponse>({
        queryKey: ['lastWeekTxs'],
        queryFn: async () => {
            const response = await getApiGlobalOverviewLastWeekTxs()

            if (!response.data) {
                throw new Error('Failed to fetch last week transactions')
            }

            return response.data
        }
    })

    const displayValue = isLoading ?
        "..." :
        isError ?
            "Error" :
            (data?.totalTxs || 0).toLocaleString()

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="text-center">
                <div className="text-5xl font-bold text-gray-900 mb-2">
                    {displayValue}
                </div>
                <div className="text-sm text-gray-600">Transactions in the last 7 days</div>
            </div>
        </div>
    )
}
