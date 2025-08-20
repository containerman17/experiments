import AllTxsNumber from "./nums/AllTxsNumber";
import MaxTpsNumber from "./nums/MaxTpsNumber";
// import ActiveAddressesNumber from "./nums/ActiveAddressesNumber";
import DailyTxs from "./charts/dailyTxs";
import MonthlyTxs from "./charts/monthlyTxs";
import MonthlyICTTOperations from "./charts/monthlyICTTOperations";
import MonthlyICMMessages from "./charts/monthlyICMMessages";

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

                {/* <ActiveAddressesNumber /> */}
            </div>

            {/* Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Daily Transaction Count Chart */}
                <DailyTxs />

                {/* Monthly Transaction Count Chart */}
                <MonthlyTxs />


                {/* Monthly Outgoing ICM Messages Chart */}
                <MonthlyICMMessages direction="outgoing" />

                {/* Monthly Incoming ICM Messages Chart */}
                <MonthlyICMMessages direction="incoming" />

                {/* Monthly ICTT Operations Chart */}
                <MonthlyICTTOperations />

            </div>
        </div>
    )
}
