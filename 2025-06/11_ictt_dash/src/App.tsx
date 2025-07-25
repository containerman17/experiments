import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import Sync from './Sync'
import RpcExamples from './RpcExamples'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ICMGasUsage from './ICMGasUsage'
import TPS from './TPS'
import CumulativeTxs from './CumulativeTxs'
import DailyMessageVolume from './DailyMessageVolume'
import Leaderboard from './Leaderboard'
import NotFound from './NotFound'


function App() {
  const queryClient = new QueryClient()
  const location = useLocation()
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-100">
        <div className="px-4">
          <nav className="mb-6">
            <div className="py-3 flex gap-6">
              <Link to="/leaderboard" className={`${location.pathname === '/leaderboard' || location.pathname === '/' ? 'font-bold' : ''} text-blue-700 hover:underline`}>Leaderboard</Link>
              <Link to="/sync-status" className={`${location.pathname === '/sync-status' ? 'font-bold' : ''} text-blue-700 hover:underline`}>Sync Status</Link>
              <Link to="/rpc" className={`${location.pathname === '/rpc' ? 'font-bold' : ''} text-blue-700 hover:underline`}>RPC Demo</Link>
              <Link to="/icm-gas-usage" className={`${location.pathname === '/icm-gas-usage' ? 'font-bold' : ''} text-blue-700 hover:underline`}>ICM Gas Usage</Link>
              <Link to="/tps" className={`${location.pathname === '/tps' ? 'font-bold' : ''} text-blue-700 hover:underline`}>TPS</Link>
              <Link to="/cumulative-txs" className={`${location.pathname === '/cumulative-txs' ? 'font-bold' : ''} text-blue-700 hover:underline`}>Cumulative Txs</Link>
              <Link to="/daily-message-volume" className={`${location.pathname === '/daily-message-volume' ? 'font-bold' : ''} text-blue-700 hover:underline`}>Daily Messages</Link>
              <a href="/api/docs" className="text-blue-700 hover:underline flex items-center gap-1" target="api">
                API Docs
                <ExternalLink size={16} />
              </a>
            </div>
          </nav>
          <main>
            <Routes>
              <Route path="/" element={<Navigate to="/leaderboard" replace />} />
              <Route path="/sync-status" element={<Sync />} />
              <Route path="/rpc" element={<RpcExamples />} />
              <Route path="/icm-gas-usage" element={<ICMGasUsage />} />
              <Route path="/tps" element={<TPS />} />
              <Route path="/cumulative-txs" element={<CumulativeTxs />} />
              <Route path="/daily-message-volume" element={<DailyMessageVolume />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </div>
    </QueryClientProvider>
  )
}

export default App
