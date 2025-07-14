import { Routes, Route, Link } from 'react-router-dom'
import Home from './Home'
import About from './About'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center space-x-8">
              <Link
                to="/"
                className="text-gray-900 hover:text-blue-600 px-3 py-2 font-medium transition-colors"
              >
                Home
              </Link>
              <Link
                to="/about"
                className="text-gray-900 hover:text-blue-600 px-3 py-2 font-medium transition-colors"
              >
                About
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
