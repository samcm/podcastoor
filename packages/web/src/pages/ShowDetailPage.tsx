import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, Podcast, PodcastStats, Episode } from '../api/client'
import EpisodeCard from '../components/EpisodeCard'
import StatsCard from '../components/StatsCard'

export default function ShowDetailPage() {
  const { showId } = useParams<{ showId: string }>()
  const [podcast, setPodcast] = useState<Podcast | null>(null)
  const [stats, setStats] = useState<PodcastStats | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    if (showId) {
      loadData()
    }
  }, [showId])

  async function loadData() {
    if (!showId) return
    
    try {
      const [podcastData, statsData, episodesData] = await Promise.all([
        api.getPodcast(showId),
        api.getPodcastStats(showId),
        api.getPodcastEpisodes(showId)
      ])
      setPodcast(podcastData)
      setStats(statsData)
      setEpisodes(episodesData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  async function handleProcess() {
    if (!showId) return
    
    setProcessing(true)
    try {
      await api.processPodcast(showId)
      // Reload data after processing starts
      await loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start processing')
    } finally {
      setProcessing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (error || !podcast) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error || 'Podcast not found'}</div>
      </div>
    )
  }

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }

  const formatMoney = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <Link to="/shows" className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to shows
        </Link>
        
        <div className="flex items-start justify-between">
          <div className="flex items-start">
            {podcast.imageUrl && (
              <img 
                src={podcast.imageUrl} 
                alt={podcast.title}
                className="w-32 h-32 rounded-lg object-cover"
              />
            )}
            <div className={podcast.imageUrl ? 'ml-6' : ''}>
              <h1 className="text-3xl font-bold text-gray-900">{podcast.title}</h1>
              <p className="mt-1 text-lg text-gray-600">{podcast.author}</p>
              <p className="mt-2 text-gray-500">{podcast.description}</p>
              
              <div className="mt-4 space-y-1 text-sm text-gray-600">
                <p>RSS Feed: <a href={podcast.rssFeedUrl} className="text-blue-600 hover:text-blue-800">{podcast.rssFeedUrl}</a></p>
                <p>Original Feed: <a href={podcast.feedUrl} className="text-blue-600 hover:text-blue-800">{podcast.feedUrl}</a></p>
              </div>
            </div>
          </div>
          
          <button
            onClick={handleProcess}
            disabled={processing}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {processing ? 'Processing...' : 'Process Now'}
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatsCard 
            title="Episodes" 
            value={stats.episodeCount} 
            subtitle={`${stats.processedCount} processed`}
          />
          <StatsCard 
            title="Ads Removed" 
            value={stats.totalAdsRemoved} 
          />
          <StatsCard 
            title="Time Saved" 
            value={formatTime(stats.totalTimeSaved)} 
          />
          <StatsCard 
            title="Money Saved" 
            value={formatMoney(stats.estimatedMoneySaved)} 
            subtitle="Estimated"
          />
        </div>
      )}

      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Episodes</h2>
        
        {episodes.length === 0 ? (
          <div className="text-center py-12 bg-gray-100 rounded-lg">
            <p className="text-gray-500">No episodes found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {episodes.map(episode => (
              <EpisodeCard key={episode.episodeGuid} episode={episode} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}