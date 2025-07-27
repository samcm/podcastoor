import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Podcast } from '../api/client'
import ShowCard from '../components/ShowCard'

export default function ShowsPage() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadPodcasts()
  }, [])

  async function loadPodcasts() {
    try {
      const shows = await api.getShows()
      setPodcasts(shows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load podcasts')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-10">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Podcast Shows</h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Discover and manage your podcast collection with AI-enhanced listening experience
          </p>
        </div>
        
        {/* Stats bar */}
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-2xl p-6 border border-gray-100">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-6 mb-4 md:mb-0">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">{podcasts.length}</div>
                <div className="text-sm text-gray-600">Total Shows</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {podcasts.reduce((sum, p) => sum + (p.episodeCount || 0), 0)}
                </div>
                <div className="text-sm text-gray-600">Total Episodes</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {podcasts.reduce((sum, p) => sum + (p.processedEpisodeCount || 0), 0)}
                </div>
                <div className="text-sm text-gray-600">Processed</div>
              </div>
            </div>
            
            <Link 
              to="/" 
              className="inline-flex items-center text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>

      {podcasts.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-24 h-24 bg-gradient-to-br from-gray-100 to-gray-200 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h3 className="text-2xl font-bold text-gray-900 mb-3">No podcasts configured yet</h3>
          <p className="text-gray-600 mb-8 max-w-md mx-auto">
            Add your first podcast RSS feed to start enjoying ad-free episodes with enhanced chapters
          </p>
          <button className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all duration-200 shadow-lg hover:shadow-xl">
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Podcast Feed
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
          {podcasts.map(podcast => (
            <ShowCard key={podcast.id} podcast={podcast} />
          ))}
        </div>
      )}
    </div>
  )
}