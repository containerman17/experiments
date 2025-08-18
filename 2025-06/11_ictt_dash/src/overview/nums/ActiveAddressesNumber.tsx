import { useQuery } from '@tanstack/react-query'
import { getApiGlobalOverviewLastWeekActiveAddresses } from "../../client/sdk.gen"


interface ActiveAddressesResponse {
    uniqueAddresses: number
}

export default function ActiveAddressesNumber() {
    const { data, isError, isLoading } = useQuery<ActiveAddressesResponse>({
        queryKey: ['lastWeekActiveAddresses'],
        queryFn: async () => {
            const response = await getApiGlobalOverviewLastWeekActiveAddresses()

            if (!response.data) {
                throw new Error('Failed to fetch active addresses')
            }

            return response.data
        }
    })

    const displayValue = isLoading ?
        "..." :
        isError ?
            "Error" :
            (data?.uniqueAddresses || 0).toLocaleString()

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="text-center">
                <div className="text-5xl font-bold text-gray-900 mb-2">
                    {displayValue}
                </div>
                <div className="text-sm text-gray-600">Active addresses in the last 7 days</div>
            </div>
        </div>
    )
}
