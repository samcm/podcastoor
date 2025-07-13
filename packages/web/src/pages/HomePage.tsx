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
      const [healthData, episodesData] = await Promise.all([
        api.getHealth(),
        api.getRecentEpisodes()
      ])
      setHealth(healthData)
      setRecentEpisodes(episodesData.episodes)
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Welcome to Podcastoor</h1>
        <p className="mt-2 text-gray-600">Process and manage your podcasts</p>
      </div>

      {health?.stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatsCard title="Total Podcasts" value={health.stats.totalPodcasts} />
          <StatsCard title="Total Episodes" value={health.stats.totalEpisodes} />
          <StatsCard title="Processed" value={health.stats.processedEpisodes} />
          <StatsCard title="Failed" value={health.stats.failedEpisodes} />
        </div>
      )}

      <div>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Recently Processed</h2>
          <Link to="/shows" className="text-blue-600 hover:text-blue-800">
            View all shows →
          </Link>
        </div>

        {recentEpisodes.length === 0 ? (
          <div className="text-center py-12 bg-gray-100 rounded-lg">
            <p className="text-gray-500">No episodes processed yet</p>
          </div>
        ) : (
          <div className="space-y-4">
            {recentEpisodes.map(episode => (
              <EpisodeCard key={`${episode.podcastId}-${episode.episodeGuid}`} episode={episode} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}