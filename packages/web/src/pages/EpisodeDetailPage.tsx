import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, Episode, ProcessingArtifact } from '../api/client'

export default function EpisodeDetailPage() {
  const { showId, episodeId } = useParams<{ showId: string, episodeId: string }>()
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [artifacts, setArtifacts] = useState<ProcessingArtifact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'details' | 'transcript' | 'ads' | 'chapters'>('details')

  useEffect(() => {
    if (showId && episodeId) {
      loadData()
    }
  }, [showId, episodeId])

  async function loadData() {
    if (!showId || !episodeId) return
    
    try {
      const episodeData = await api.getEpisode(showId, episodeId)
      setEpisode(episodeData)
      
      if (episodeData.status === 'completed') {
        try {
          const artifactsData = await api.getEpisodeArtifacts(showId, episodeId)
          setArtifacts(artifactsData)
        } catch (err) {
          console.error('Failed to load artifacts:', err)
        }
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

  if (error || !episode) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error || 'Episode not found'}</div>
      </div>
    )
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return hours > 0 ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}` : `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const statusColors = {
    pending: 'bg-gray-100 text-gray-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800'
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <Link to={`/shows/${showId}`} className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to show
        </Link>
        
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{episode.title}</h1>
              <p className="mt-2 text-gray-600">{episode.description}</p>
              
              <div className="mt-4 flex items-center space-x-4 text-sm text-gray-500">
                <span>{formatDate(episode.publishedAt)}</span>
                <span>•</span>
                <span>{formatDuration(episode.duration)}</span>
                {episode.fileSize && (
                  <>
                    <span>•</span>
                    <span>{(episode.fileSize / 1024 / 1024).toFixed(1)} MB</span>
                  </>
                )}
              </div>
            </div>
            
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusColors[episode.status]}`}>
              {episode.status}
            </span>
          </div>
          
          <div className="mt-6 space-y-2 text-sm">
            <p><span className="font-medium">Original URL:</span> <a href={episode.originalUrl} className="text-blue-600 hover:text-blue-800 break-all">{episode.originalUrl}</a></p>
            {episode.processedUrl && (
              <p><span className="font-medium">Processed URL:</span> <a href={episode.processedUrl} className="text-blue-600 hover:text-blue-800 break-all">{episode.processedUrl}</a></p>
            )}
            {episode.error && (
              <p className="text-red-600"><span className="font-medium">Error:</span> {episode.error}</p>
            )}
          </div>
        </div>
      </div>

      {episode.status === 'completed' && artifacts && (
        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex">
              <button
                onClick={() => setActiveTab('details')}
                className={`py-2 px-6 border-b-2 font-medium text-sm ${
                  activeTab === 'details' 
                    ? 'border-blue-500 text-blue-600' 
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Details
              </button>
              {artifacts.transcript && (
                <button
                  onClick={() => setActiveTab('transcript')}
                  className={`py-2 px-6 border-b-2 font-medium text-sm ${
                    activeTab === 'transcript' 
                      ? 'border-blue-500 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Transcript
                </button>
              )}
              {artifacts.adsRemoved && artifacts.adsRemoved.length > 0 && (
                <button
                  onClick={() => setActiveTab('ads')}
                  className={`py-2 px-6 border-b-2 font-medium text-sm ${
                    activeTab === 'ads' 
                      ? 'border-blue-500 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Ads Removed ({artifacts.adsRemoved.length})
                </button>
              )}
              {artifacts.chapters && artifacts.chapters.length > 0 && (
                <button
                  onClick={() => setActiveTab('chapters')}
                  className={`py-2 px-6 border-b-2 font-medium text-sm ${
                    activeTab === 'chapters' 
                      ? 'border-blue-500 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Chapters ({artifacts.chapters.length})
                </button>
              )}
            </nav>
          </div>
          
          <div className="p-6">
            {activeTab === 'details' && (
              <div className="space-y-4">
                {artifacts.summary && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Summary</h3>
                    <p className="text-gray-600">{artifacts.summary}</p>
                  </div>
                )}
                
                {artifacts.keyTopics && artifacts.keyTopics.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Key Topics</h3>
                    <div className="flex flex-wrap gap-2">
                      {artifacts.keyTopics.map((topic, index) => (
                        <span key={index} className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">
                          {topic}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                <div className="grid grid-cols-2 gap-4 pt-4">
                  <div>
                    <h4 className="font-medium text-gray-700">Ads Removed</h4>
                    <p className="text-2xl font-bold text-gray-900">{artifacts.adsRemoved?.length || 0}</p>
                  </div>
                  <div>
                    <h4 className="font-medium text-gray-700">Chapters</h4>
                    <p className="text-2xl font-bold text-gray-900">{artifacts.chapters?.length || 0}</p>
                  </div>
                </div>
              </div>
            )}
            
            {activeTab === 'transcript' && artifacts.transcript && (
              <div className="prose max-w-none">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 p-4 rounded-lg overflow-auto max-h-96">
                  {artifacts.transcript}
                </pre>
              </div>
            )}
            
            {activeTab === 'ads' && artifacts.adsRemoved && (
              <div className="space-y-4">
                {artifacts.adsRemoved.map((ad, index) => (
                  <div key={index} className="border rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium text-gray-900">
                        {formatTime(ad.start)} - {formatTime(ad.end)}
                      </span>
                      <span className="text-sm text-gray-500">
                        Confidence: {Math.round(ad.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">{ad.content}</p>
                  </div>
                ))}
              </div>
            )}
            
            {activeTab === 'chapters' && artifacts.chapters && (
              <div className="space-y-4">
                {artifacts.chapters.map((chapter, index) => (
                  <div key={index} className="border rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-medium text-gray-900">{chapter.title}</h4>
                      <span className="text-sm text-gray-500">
                        {formatTime(chapter.start)} - {formatTime(chapter.end)}
                      </span>
                    </div>
                    {chapter.description && (
                      <p className="text-sm text-gray-600">{chapter.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}