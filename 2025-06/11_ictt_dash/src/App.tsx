import { Routes, Route, Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import Sync from './Sync'
import RpcExamples from './RpcExamples'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ICMGasUsage from './ICMGasUsage'
import TPSOverTime from './TPSOverTime'
import CumulativeTxs from './CumulativeTxs'
import DailyMessageVolume from './DailyMessageVolume'


function App() {
  const queryClient = new QueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-100">
        <div className="px-4">
          <nav className="mb-6">
            <div className="py-3 flex gap-6">
              <Link to="/" className="text-blue-700 hover:underline">Sync Status</Link>
              <Link to="/rpc" className="text-blue-700 hover:underline">RPC Demo</Link>
              <Link to="/icm-gas-usage" className="text-blue-700 hover:underline">ICM Gas Usage</Link>
              <Link to="/tps-over-time" className="text-blue-700 hover:underline">TPS Over Time</Link>
              <Link to="/cumulative-txs" className="text-blue-700 hover:underline">Cumulative Txs</Link>
              <Link to="/daily-message-volume" className="text-blue-700 hover:underline">Daily Messages</Link>
              <a href="/api/docs" className="text-blue-700 hover:underline flex items-center gap-1" target="api">
                API Docs
                <ExternalLink size={16} />
              </a>
            </div>
          </nav>
          <main>
            <Routes>
              <Route path="/" element={<Sync />} />
              <Route path="/rpc" element={<RpcExamples />} />
              <Route path="/icm-gas-usage" element={<ICMGasUsage />} />
              <Route path="/tps-over-time" element={<TPSOverTime />} />
              <Route path="/cumulative-txs" element={<CumulativeTxs />} />
              <Route path="/daily-message-volume" element={<DailyMessageVolume />} />
            </Routes>
          </main>
        </div>
      </div>
    </QueryClientProvider>
  )
}

export default App
