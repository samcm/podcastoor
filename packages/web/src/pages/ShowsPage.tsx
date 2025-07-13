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
      const data = await api.getPodcasts()
      setPodcasts(data.podcasts)
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Shows</h1>
        <p className="mt-2 text-gray-600">All tracked podcasts</p>
      </div>

      {podcasts.length === 0 ? (
        <div className="text-center py-12 bg-gray-100 rounded-lg">
          <p className="text-gray-500">No podcasts configured yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {podcasts.map(podcast => (
            <ShowCard key={podcast.id} podcast={podcast} />
          ))}
        </div>
      )}
    </div>
  )
}