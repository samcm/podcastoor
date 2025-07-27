import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Episode, HealthStatus } from '../api/client'
import EpisodeCard from '../components/EpisodeCard'
import StatsCard from '../components/StatsCard'

export default function HomePage() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [recentEpisodes, setRecentEpisodes] = useState<Episode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      const healthData = await api.getHealth()
      setHealth(healthData)
      
      // Try to load recent episodes, but don't fail if it doesn't work
      try {
        const episodesData = await api.getRecentEpisodes()
        setRecentEpisodes(episodesData.episodes)
      } catch (episodesErr) {
        console.error('Failed to load recent episodes:', episodesErr)
        setRecentEpisodes([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
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
      {/* Hero Section */}
      <div className="mb-12">
        <div className="relative bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 rounded-3xl p-12 text-white overflow-hidden">
          <div className="absolute inset-0 bg-black/10"></div>
          <div className="relative z-10">
            <h1 className="text-4xl md:text-5xl font-bold mb-4 leading-tight">
              Welcome to Podcastoor
            </h1>
            <p className="text-xl text-blue-100 mb-8 max-w-2xl">
              Transform your podcast listening experience with AI-powered ad removal and smart chapter generation
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                to="/shows" 
                className="inline-flex items-center px-6 py-3 bg-white text-blue-600 font-semibold rounded-lg hover:bg-blue-50 transition-colors"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Browse Shows
              </Link>
              <button className="inline-flex items-center px-6 py-3 bg-white/10 text-white font-semibold rounded-lg hover:bg-white/20 transition-colors backdrop-blur-sm">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Learn More
              </button>
            </div>
          </div>
          
          {/* Decorative elements */}
          <div className="absolute -top-24 -right-24 w-48 h-48 bg-white/10 rounded-full"></div>
          <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-white/5 rounded-full"></div>
        </div>
      </div>

      {/* Stats Section */}
      {health?.stats && (
        <div className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">Platform Overview</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <StatsCard 
              title="Total Podcasts" 
              value={health.stats.totalPodcasts}
              className="card-hover"
            />
            <StatsCard 
              title="Total Episodes" 
              value={health.stats.totalEpisodes}
              className="card-hover"
            />
            <StatsCard 
              title="Processed" 
              value={health.stats.processedEpisodes}
              className="card-hover"
            />
            <StatsCard 
              title="Failed" 
              value={health.stats.failedEpisodes}
              className="card-hover"
            />
          </div>
        </div>
      )}

      {/* Recent Episodes Section */}
      <div>
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-3xl font-bold text-gray-900 mb-2">Recently Processed</h2>
            <p className="text-gray-600">Latest episodes enhanced with Podcastoor</p>
          </div>
          <Link 
            to="/shows" 
            className="inline-flex items-center text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            View all shows
            <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>

        {recentEpisodes.length === 0 ? (
          <div className="text-center py-16 bg-gradient-to-br from-gray-50 to-blue-50 rounded-2xl border border-gray-100">
            <div className="w-16 h-16 bg-gray-200 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zm12-3c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zM9 10l12-3" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No episodes processed yet</h3>
            <p className="text-gray-500 mb-6">Start by adding a podcast feed to begin processing episodes</p>
            <Link 
              to="/shows" 
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Get Started
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {recentEpisodes.map(episode => (
              <EpisodeCard key={`${episode.podcastId}-${episode.episodeGuid}`} episode={episode} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}