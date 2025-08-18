import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { getApiGlobalOverviewDailyTxsByChainCompact } from "../../client/sdk.gen"

interface CompactData {
    dates: string[];
    chains: Array<{
        evmChainId: number;
        name: string;
        values: number[];
    }>;
}

interface RechartsDataPoint {
    date: string;
    [key: string]: string | number;
}

// Generate colors for chains - using HSL for better distribution
const generateChainColors = (numChains: number): string[] => {
    const colors: string[] = [];
    const hueStep = 360 / numChains;

    for (let i = 0; i < numChains; i++) {
        const hue = (i * hueStep) % 360;
        // Use varying saturation and lightness for better distinction
        const saturation = 65 + (i % 3) * 15; // 65%, 80%, 95%
        const lightness = 45 + (i % 4) * 10;  // 45%, 55%, 65%, 75%
        colors.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`);
    }

    return colors;
};

// Custom tooltip component that sorts chains by count
interface CustomTooltipProps {
    active?: boolean;
    payload?: Array<{
        dataKey: string;
        value: number;
        color: string;
    }>;
    label?: string;
    chains: CompactData['chains'];
}

const CustomTooltip = ({ active, payload, label, chains }: CustomTooltipProps) => {
    if (!active || !payload || !payload.length) return null;

    // Sort payload by value in descending order
    const sortedPayload = [...payload].sort((a, b) => b.value - a.value);

    return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 max-h-80 overflow-y-auto">
            <p className="font-medium text-gray-900 mb-2">
                {new Date(label + 'T00:00:00Z').toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                })}
            </p>
            <div className="space-y-1">
                {sortedPayload.map((entry) => {
                    const chainName = chains.find(c => `chain_${c.evmChainId}` === entry.dataKey)?.name || entry.dataKey;
                    const value = entry.value;

                    if (value === 0) return null;

                    return (
                        <div key={entry.dataKey} className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                                <div
                                    className="w-3 h-3 rounded-sm"
                                    style={{ backgroundColor: entry.color }}
                                />
                                <span className="text-gray-700">{chainName}</span>
                            </div>
                            <span className="font-medium text-gray-900">
                                {value.toLocaleString()}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

function transformToRechartsFormat(compactData: CompactData): RechartsDataPoint[] {
    return compactData.dates.map((date, dateIndex) => {
        const dataPoint: RechartsDataPoint = { date };
        compactData.chains.forEach(chain => {
            dataPoint[`chain_${chain.evmChainId}`] = chain.values[dateIndex];
        });
        return dataPoint;
    });
}

export default function DailyTxs() {
    const { data, isError, isLoading } = useQuery<CompactData>({
        queryKey: ['dailyTxsByChainCompact'],
        queryFn: async () => {
            const response = await getApiGlobalOverviewDailyTxsByChainCompact();

            if (!response.data) {
                throw new Error('Failed to fetch daily transaction data');
            }

            return response.data;
        }
    });

    if (isLoading) {
        return (
            <div className="bg-white border border-gray-200 rounded-xl p-6">
                <div className="mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Daily Transaction Count - All Indexed L1s</h3>
                </div>
                <div className="h-96 flex items-center justify-center bg-gray-50 rounded-lg">
                    <div className="text-gray-500">Loading chart...</div>
                </div>
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="bg-white border border-gray-200 rounded-xl p-6">
                <div className="mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Daily Transaction Count - All Indexed L1s</h3>
                </div>
                <div className="h-96 flex items-center justify-center bg-gray-50 rounded-lg">
                    <div className="text-red-500">Error loading chart data</div>
                </div>
            </div>
        );
    }

    const chartData = transformToRechartsFormat(data);
    const colors = generateChainColors(data.chains.length);

    // Filter chains with at least some activity for cleaner display
    const activeChainsOnly = data.chains.filter(chain =>
        chain.values.some(val => val > 0)
    );

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Daily Transaction Count - All Indexed L1s</h3>
                <p className="text-sm text-gray-600">
                    Showing {activeChainsOnly.length} active chains over the last {data.dates.length} days
                </p>
            </div>
            <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis
                            dataKey="date"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(date) => {
                                return new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric'
                                });
                            }}
                        />
                        <YAxis
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => {
                                if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
                                if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
                                return value.toString();
                            }}
                        />
                        <Tooltip content={<CustomTooltip chains={data.chains} />} />
                        {activeChainsOnly.map((chain, index) => (
                            <Area
                                key={`chain_${chain.evmChainId}`}
                                type="monotone"
                                dataKey={`chain_${chain.evmChainId}`}
                                stackId="1"
                                stroke={colors[index]}
                                fill={colors[index]}
                                fillOpacity={0.7}
                                strokeWidth={1}
                                isAnimationActive={false}
                            />
                        ))}
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
