import { Link } from 'react-router-dom'
import { Episode } from '../api/client'

interface EpisodeCardProps {
  episode: Episode
}

export default function EpisodeCard({ episode }: EpisodeCardProps) {
  const statusColors = {
    pending: 'bg-gray-100 text-gray-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800'
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
  }

  return (
    <div className="bg-white p-6 rounded-lg shadow hover:shadow-md transition-shadow">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <Link 
            to={`/shows/${episode.podcastId}/episodes/${encodeURIComponent(episode.episodeGuid)}`}
            className="text-lg font-semibold text-gray-900 hover:text-blue-600"
          >
            {episode.title}
          </Link>
          <p className="mt-1 text-sm text-gray-600 line-clamp-2">{episode.description}</p>
          <div className="mt-3 flex items-center space-x-4 text-sm text-gray-500">
            <span>{formatDate(episode.publishDate)}</span>
            <span>•</span>
            <span>{formatDuration(episode.duration)}</span>
            {episode.adsRemoved !== undefined && (
              <>
                <span>•</span>
                <span>{episode.adsRemoved} ads removed</span>
              </>
            )}
          </div>
        </div>
        <div className="ml-4">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[episode.status]}`}>
            {episode.status}
          </span>
        </div>
      </div>
    </div>
  )
}