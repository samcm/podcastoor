import { Link, Outlet } from 'react-router-dom'

export default function Layout() {
  return (
    <div className="min-h-screen">
      <nav className="glass-effect shadow-lg border-b border-white/20 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <Link to="/" className="flex items-center">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zm12-3c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zM9 10l12-3" />
                    </svg>
                  </div>
                  <h1 className="text-xl font-bold gradient-text">Podcastoor</h1>
                </div>
              </Link>
              <div className="ml-10 flex items-center space-x-1">
                <Link to="/" className="text-gray-700 hover:text-blue-600 hover:bg-blue-50 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200">
                  Home
                </Link>
                <Link to="/shows" className="text-gray-700 hover:text-blue-600 hover:bg-blue-50 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200">
                  Shows
                </Link>
              </div>
            </div>
            
            {/* Optional: Add a search or action area */}
            <div className="flex items-center">
              <div className="hidden md:block text-sm text-gray-500">
                Ad-free podcast experience
              </div>
            </div>
          </div>
        </div>
      </nav>
      
      <main className="relative">
        <Outlet />
      </main>
    </div>
  )
}