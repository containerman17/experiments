import AllTxsNumber from "./nums/AllTxsNumber";
import MaxTpsNumber from "./nums/MaxTpsNumber";
import ActiveAddressesNumber from "./nums/ActiveAddressesNumber";
import DailyTxs from "./charts/dailyTxs";
import MonthlyTxs from "./charts/monthlyTxs";

export default function Overview() {
    return (
        <div className="py-8 px-4 md:px-8">
            <div className="flex flex-col gap-4 mb-8">
                <h1 className="text-3xl font-bold">📊 Avalanche L1s Overview</h1>
            </div>

            {/* Key Metrics Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <AllTxsNumber />

                <MaxTpsNumber />

                <ActiveAddressesNumber />
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Daily Transaction Count Chart */}
                <DailyTxs />

                {/* Monthly Transaction Count Chart */}
                <MonthlyTxs />

                {/* Daily Active Addresses Chart */}
                <div className="bg-white border border-gray-200 rounded-xl p-6">
                    <div className="mb-4">
                        <h3 className="text-lg font-semibold text-gray-900">Daily Active Addresses - All Indexed L1s</h3>
                    </div>
                    <div className="h-96 flex items-center justify-center bg-gray-50 rounded-lg">
                        <div className="w-0 h-0 border-l-[50px] border-r-[50px] border-b-[87px] border-l-transparent border-r-transparent border-b-gray-400"></div>
                    </div>
                </div>

                {/* Monthly Active Addresses Chart */}
                <div className="bg-white border border-gray-200 rounded-xl p-6">
                    <div className="mb-4">
                        <h3 className="text-lg font-semibold text-gray-900">Monthly Active Addresses - All Indexed L1s</h3>
                    </div>
                    <div className="h-96 flex items-center justify-center bg-gray-50 rounded-lg">
                        <div className="w-0 h-0 border-l-[50px] border-r-[50px] border-b-[87px] border-l-transparent border-r-transparent border-b-gray-400"></div>
                    </div>
                </div>
            </div>
        </div>
    )
}
