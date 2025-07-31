
import { useEffect } from 'react'
import { create } from 'zustand'

declare global {
  interface Window {
    ethereum?: any
  }
}

// Zustand store for wallet state
interface WalletState {
  address: string | null
  setAddress: (address: string | null) => void
}

const useWalletStore = create<WalletState>((set) => ({
  address: null,
  setAddress: (address) => set({ address }),
}))

function App() {
  return (
    <>
      <Wallet>
        <h1 className='text-3xl font-bold underline'>Hello World</h1>
      </Wallet>
    </>
  )
}

function Wallet({ children }: { children: React.ReactNode }) {
  const { address, setAddress } = useWalletStore()

  const connectWallet = async () => {
    if (!window.ethereum) {
      alert('MetaMask is not installed!')
      return
    }

    try {
      // Request accounts
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts'
      })

      if (accounts.length > 0) {
        setAddress(accounts[0])
      }
    } catch (error) {
      console.error('Failed to connect wallet:', error)
    }
  }

  useEffect(() => {
    // Check if wallet is already connected
    if (window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            setAddress(accounts[0])
          }
        })
        .catch(console.error)
    }
  }, [setAddress])

  if (address) {
    return (
      <div className="p-4">
        <div className="mb-4">
          <p className="text-gray-600">Connected: <span className="font-mono text-sm">{address}</span></p>
          <button
            onClick={() => setAddress(null)}
            className="mt-2 bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600"
          >
            Disconnect
          </button>
        </div>
        {children}
      </div>
    )
  }

  return (
    <div className="p-4">
      <button
        onClick={connectWallet}
        className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600"
      >
        Connect Wallet
      </button>
    </div>
  )
}

export default App
