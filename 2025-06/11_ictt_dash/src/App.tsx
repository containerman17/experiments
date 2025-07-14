import { Routes, Route, Link } from 'react-router-dom'
import Home from './Home'
import Sync from './Sync'

function App() {
  return (
    <div className="min-h-screen">
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/sync" element={<Sync />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
