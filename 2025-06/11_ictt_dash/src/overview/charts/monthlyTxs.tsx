import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { getApiGlobalOverviewMonthlyTxsByChainCompact } from "../../client/sdk.gen"

interface CompactData {
    dates: string[]; // e.g. ["2020-09", "2020-10", ...]
    chains: Array<{
        evmChainId: number;
        name: string;
        values: number[];
    }>;
}

interface RechartsDataPoint {
    date: string; // YYYY-MM
    [key: string]: string | number;
}

// Generate colors for chains - using HSL for better distribution
const generateChainColors = (numChains: number): string[] => {
    const colors: string[] = [];
    const hueStep = 360 / numChains;

    for (let i = 0; i < numChains; i++) {
        const hue = (i * hueStep) % 360;
        const saturation = 65 + (i % 3) * 15;
        const lightness = 45 + (i % 4) * 10;
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
    label?: string; // YYYY-MM
    chains: CompactData['chains'];
}

const CustomTooltip = ({ active, payload, label, chains }: CustomTooltipProps) => {
    if (!active || !payload || !payload.length || !label) return null;

    const [yearStr, monthStr] = label.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;
    const labelDate = new Date(Date.UTC(year, monthIndex, 1));

    const sortedPayload = [...payload].sort((a, b) => b.value - a.value);

    return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 max-h-80 overflow-y-auto">
            <p className="font-medium text-gray-900 mb-2">
                {labelDate.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long'
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

export default function MonthlyTxs() {
    const { data, isError, isLoading } = useQuery<CompactData>({
        queryKey: ['monthlyTxsByChainCompact'],
        queryFn: async () => {
            const response = await getApiGlobalOverviewMonthlyTxsByChainCompact();

            if (!response.data) {
                throw new Error('Failed to fetch monthly transaction data');
            }

            return response.data;
        }
    });

    if (isLoading) {
        return (
            <div className="bg-white border border-gray-200 rounded-xl p-6">
                <div className="mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Monthly Transaction Count - All Indexed L1s</h3>
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
                    <h3 className="text-lg font-semibold text-gray-900">Monthly Transaction Count - All Indexed L1s</h3>
                </div>
                <div className="h-96 flex items-center justify-center bg-gray-50 rounded-lg">
                    <div className="text-red-500">Error loading chart data</div>
                </div>
            </div>
        );
    }

    const chartData = transformToRechartsFormat(data);
    const colors = generateChainColors(data.chains.length);

    const activeChainsOnly = data.chains.filter(chain =>
        chain.values.some(val => val > 0)
    );

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Monthly Transaction Count - All Indexed L1s</h3>
                <p className="text-sm text-gray-600">
                    Showing {activeChainsOnly.length} active chains over the last {data.dates.length} months
                </p>
            </div>
            <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis
                            dataKey="date"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(date) => {
                                const [yearStr, monthStr] = String(date).split('-');
                                const year = Number(yearStr);
                                const monthIndex = Number(monthStr) - 1;
                                return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString('en-US', {
                                    month: 'short',
                                    year: 'numeric'
                                });
                            }}
                        />
                        <YAxis
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => {
                                if (value >= 1000000) return `${(Number(value) / 1000000).toFixed(1)}M`;
                                if (value >= 1000) return `${(Number(value) / 1000).toFixed(1)}K`;
                                return String(value);
                            }}
                        />
                        <Tooltip content={<CustomTooltip chains={data.chains} />} />
                        {activeChainsOnly.map((chain, index) => (
                            <Bar
                                key={`chain_${chain.evmChainId}`}
                                dataKey={`chain_${chain.evmChainId}`}
                                stackId="a"
                                fill={colors[index]}
                                isAnimationActive={false}
                            />
                        ))}
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}


