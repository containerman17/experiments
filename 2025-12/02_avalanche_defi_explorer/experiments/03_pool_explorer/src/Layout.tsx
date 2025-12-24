import { NavLink, Outlet } from 'react-router-dom'

export function Layout() {
    return (
        <div className="min-h-screen bg-slate-900 text-slate-100 font-sans">
            <nav className="border-b border-slate-800 px-8 py-4 flex items-center gap-6">
                <span className="text-xl font-black tracking-tight text-white">Pool Explorer</span>
                <div className="flex gap-4 ml-8">
                    <NavLink
                        to="/"
                        className={({ isActive }) =>
                            `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isActive
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                            }`
                        }
                    >
                        Pools
                    </NavLink>
                    <NavLink
                        to="/round-trips"
                        className={({ isActive }) =>
                            `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isActive
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                            }`
                        }
                    >
                        Round Trips
                    </NavLink>
                    <NavLink
                        to="/triangular"
                        className={({ isActive }) =>
                            `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isActive
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                            }`
                        }
                    >
                        Triangular
                    </NavLink>
                </div>
            </nav>
            <main className="p-8">
                <Outlet />
            </main>
        </div>
    )
}
