import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import { PriceDataProvider } from './PriceContext'
import { Layout } from './Layout'
import { PoolsPage } from './PoolsPage'
import { RoundTripsPage } from './RoundTripsPage'

import { TriangularPage } from './TriangularPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PriceDataProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<PoolsPage />} />
            <Route path="/round-trips" element={<RoundTripsPage />} />
            <Route path="/triangular" element={<TriangularPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PriceDataProvider>
  </StrictMode>,
)
