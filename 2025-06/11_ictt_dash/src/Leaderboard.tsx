import { getApiLeaderboardDay, getApiLeaderboardWeek } from "./client/sdk.gen"
import { type GetApiLeaderboardDayResponses, type GetApiLeaderboardWeekResponses } from "./client/types.gen"
import { useQuery } from '@tanstack/react-query'
import ExampleCard from "./components/ExampleCard"
import ErrorComponent from "./components/ErrorComponent"
import SankeyChart from "./components/SankeyChart"
type DailyLeaderboardData = GetApiLeaderboardDayResponses[200]
type WeeklyLeaderboardData = GetApiLeaderboardWeekResponses[200]

function DailyLeaderboard() {
    const { data, error, isError, isLoading } = useQuery<DailyLeaderboardData>({
        queryKey: ['leaderboardDay'],
        queryFn: async () => {
            const res = await getApiLeaderboardDay()
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch daily leaderboard data')
        }
    })

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load daily message flows'} />
    }

    if (isLoading || !data) {
        return <div className="text-center py-8">Loading daily message flows...</div>
    }

    if (data.length === 0) {
        return <div className="text-center py-8 text-gray-500">No message flows in the last 24 hours</div>
    }

    return <SankeyChart data={data} />
}

function WeeklyLeaderboard() {
    const { data, error, isError, isLoading } = useQuery<WeeklyLeaderboardData>({
        queryKey: ['leaderboardWeek'],
        queryFn: async () => {
            const res = await getApiLeaderboardWeek()
            if (res.data) {
                return res.data
            }
            throw new Error('Failed to fetch weekly leaderboard data')
        }
    })

    if (isError) {
        return <ErrorComponent message={error?.message || 'Failed to load weekly message flows'} />
    }

    if (isLoading || !data) {
        return <div className="text-center py-8">Loading weekly message flows...</div>
    }

    if (data.length === 0) {
        return <div className="text-center py-8 text-gray-500">No message flows in the last 7 days</div>
    }

    return <SankeyChart data={data} />
}

export default function Leaderboard() {
    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">🔄 Message Flow Leaderboard</h1>

                <div className="border border-gray-200 rounded-xl bg-white p-6">
                    <div className="mb-3 text-base">Inter-Chain Message Flows</div>
                    <p className="text-sm mb-3">
                        Track message flows between chains in the network:
                    </p>
                    <ul className="space-y-1">
                        <li><span className="font-semibold">Message Paths:</span> Shows source → destination chain flows</li>
                        <li><span className="font-semibold">Daily:</span> Message flows from the last 24 hours</li>
                        <li><span className="font-semibold">Weekly:</span> Message flows from the last 7 days</li>
                        <li><span className="font-semibold">Activity Summary:</span> Total messages sent and received per chain</li>
                    </ul>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-8">
                <ExampleCard
                    name="Daily Message Flows"
                    curlString={`curl -X GET "${window.location.origin}/api/leaderboard/day"`}
                >
                    <DailyLeaderboard />
                </ExampleCard>

                <ExampleCard
                    name="Weekly Message Flows"
                    curlString={`curl -X GET "${window.location.origin}/api/leaderboard/week"`}
                >
                    <WeeklyLeaderboard />
                </ExampleCard>
            </div>
        </div>
    )
}