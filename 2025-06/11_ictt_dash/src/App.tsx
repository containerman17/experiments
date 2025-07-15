import { Routes, Route, Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import Sync from './Sync'


function App() {
  return (
    <div className="min-h-screen bg-gray-100">
      <div className="px-4">
        <nav className="mb-6">
          <div className="py-3 flex gap-6">
            <Link to="/" className="text-blue-700 hover:underline">Sync Status</Link>
            <a href="/api/docs" className="text-blue-700 hover:underline flex items-center gap-1">
              API Docs
              <ExternalLink size={16} />
            </a>
          </div>
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<Sync />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

export default App
