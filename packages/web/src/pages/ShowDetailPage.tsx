import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, Podcast, PodcastStats, Episode } from '../api/client'
import EpisodeCard from '../components/EpisodeCard'
import StatsCard from '../components/StatsCard'
import ErrorBoundary from '../components/ErrorBoundary'

// Helper function to safely get numeric values with defaults
const safeNumber = (value: number | undefined | null, defaultValue: number = 0): number => {
  return (value != null && !isNaN(value)) ? value : defaultValue
}

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
        api.getShow(showId),
        api.getShowStats(showId),
        api.getShowEpisodes(showId)
      ])
      setPodcast(podcastData)
      // Ensure stats has safe defaults
      setStats({
        episodeCount: safeNumber(statsData?.episodeCount),
        processedCount: safeNumber(statsData?.processedCount),
        totalAdsRemoved: safeNumber(statsData?.totalAdsRemoved),
        totalTimeSaved: safeNumber(statsData?.totalTimeSaved),
        estimatedMoneySaved: safeNumber(statsData?.estimatedMoneySaved),
        averageAdsPerEpisode: safeNumber(statsData?.averageAdsPerEpisode)
      } as PodcastStats)
      setEpisodes(episodesData)
    } catch (err) {
      console.error('Error loading podcast data:', err)
      setError(err instanceof Error ? err.message : 'Failed to load data')
      // Set empty stats as fallback
      setStats({
        episodeCount: 0,
        processedCount: 0,
        totalAdsRemoved: 0,
        totalTimeSaved: 0,
        estimatedMoneySaved: 0,
        averageAdsPerEpisode: 0
      } as PodcastStats)
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

  const formatTime = (seconds: number | undefined | null) => {
    if (!seconds || isNaN(seconds)) return '0h 0m'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }

  const formatMoney = (cents: number | undefined | null) => {
    if (!cents || isNaN(cents)) return '$0.00'
    return `$${(cents / 100).toFixed(2)}`
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero Section */}
      <div className="mb-8">
        <Link to="/shows" className="inline-flex items-center text-blue-600 hover:text-blue-800 mb-6 transition-colors">
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to shows
        </Link>
        
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-2xl p-8 border border-gray-100">
          <div className="flex flex-col lg:flex-row items-start justify-between gap-8">
            <div className="flex flex-col md:flex-row items-start gap-6 flex-1">
              {/* Podcast Artwork */}
              <div className="flex-shrink-0">
                {podcast.imageUrl ? (
                  <img 
                    src={podcast.imageUrl} 
                    alt={podcast.title}
                    className="w-40 h-40 lg:w-48 lg:h-48 rounded-2xl object-cover shadow-lg border-4 border-white"
                  />
                ) : (
                  <div className="w-40 h-40 lg:w-48 lg:h-48 rounded-2xl bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 shadow-lg border-4 border-white flex items-center justify-center">
                    <svg className="w-20 h-20 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zm12-3c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zM9 10l12-3" />
                    </svg>
                  </div>
                )}
              </div>

              {/* Podcast Info */}
              <div className="flex-1 min-w-0">
                <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-3 leading-tight">
                  {podcast.title}
                </h1>
                {podcast.author && (
                  <p className="text-xl text-gray-600 mb-4 font-medium">{podcast.author}</p>
                )}
                
                {podcast.description && (
                  <div className="prose prose-gray max-w-none mb-6">
                    <p className="text-gray-600 leading-relaxed">{podcast.description}</p>
                  </div>
                )}
                
                {/* Feed Links */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center text-gray-600">
                    <svg className="w-4 h-4 mr-2 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
                    </svg>
                    <span className="font-medium mr-2">Processed RSS:</span>
                    <a href={`${import.meta.env.VITE_API_URL || ''}/rss/${podcast.id}.rss`} className="text-blue-600 hover:text-blue-800 transition-colors break-all">
                      {`${window.location.origin}${import.meta.env.VITE_API_URL || ''}/rss/${podcast.id}.rss`}
                    </a>
                  </div>
                  <div className="flex items-center text-gray-600">
                    <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="font-medium mr-2">Original Feed:</span>
                    <a href={podcast.feedUrl} className="text-blue-600 hover:text-blue-800 transition-colors break-all">
                      {podcast.feedUrl}
                    </a>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Action Button */}
            <div className="flex-shrink-0">
              <button
                onClick={handleProcess}
                disabled={processing}
                className="px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium rounded-lg hover:from-blue-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl"
              >
                {processing ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </span>
                ) : (
                  'Process Now'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ErrorBoundary fallback={
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-8">
          <p className="text-yellow-800">Unable to load podcast statistics</p>
        </div>
      }>
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <StatsCard 
              title="Episodes" 
              value={safeNumber(stats.episodeCount)} 
              subtitle={`${safeNumber(stats.processedCount)} processed`}
            />
            <StatsCard 
              title="Ads Removed" 
              value={safeNumber(stats.totalAdsRemoved)} 
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
      </ErrorBoundary>

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