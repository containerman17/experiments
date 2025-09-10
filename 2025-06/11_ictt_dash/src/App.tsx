import { Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import Sidebar from './components/Sidebar'
import Sync from './Sync'
import RpcExamples from './RpcExamples'
import ICMGasUsage from './ICMGasUsage'
import ICMGasUsageChart from './ICMGasUsageChart'
import TPS from './TPS'
import CumulativeTxs from './CumulativeTxs'
import DailyMessageVolume from './DailyMessageVolume'
import Leaderboard from './Leaderboard'
import ICTTTransfers from './ICTTTransfers'
import ICTTTvl from './ICTTTvl'
import ICTTByToken from './ICTTByToken'
import ICTTTransfersList from './ICTTTransfersList'
import MessagingComparison from './MessagingComparison'
import ChainComparison from './ChainComparison'
import DailyActiveAddresses from './DailyActiveAddresses'
import ContractStats from './ContractStats'
import Overview from './overview/Overview'
import NotFound from './NotFound'


function App() {
  const queryClient = new QueryClient()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-100">
        <Sidebar isMobileMenuOpen={isMobileMenuOpen} setIsMobileMenuOpen={setIsMobileMenuOpen} />
        {/* Main content area with margin to account for sidebar */}
        <div className={`
          lg:ml-64 transition-transform duration-300 ease-in-out
          ${isMobileMenuOpen ? 'translate-x-64' : 'translate-x-0'}
        `}>
          <main className="p-4 pt-16 lg:pt-4">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/overview" element={<Overview />} />
              <Route path="/sync-status" element={<Sync />} />
              <Route path="/rpc" element={<RpcExamples />} />
              <Route path="/icm-gas-usage" element={<ICMGasUsage />} />
              <Route path="/icm-gas-usage-chart" element={<ICMGasUsageChart />} />
              <Route path="/tps" element={<TPS />} />
              <Route path="/cumulative-txs" element={<CumulativeTxs />} />
              <Route path="/daily-message-volume" element={<DailyMessageVolume />} />
              <Route path="/messaging-comparison" element={<MessagingComparison />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="/ictt-transfers" element={<ICTTTransfers />} />
              <Route path="/ictt-tvl" element={<ICTTTvl />} />
              <Route path="/ictt-by-token" element={<ICTTByToken />} />
              <Route path="/ictt-transfers-list" element={<ICTTTransfersList />} />
              <Route path="/chain-comparison" element={<ChainComparison />} />
              <Route path="/daily-active-addresses" element={<DailyActiveAddresses />} />
              <Route path="/contract-stats" element={<ContractStats />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </div>
    </QueryClientProvider>
  )
}

export default App
