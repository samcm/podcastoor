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

  const formatDate = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleDateString('en-US', {
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
    <div className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow p-4 sm:p-6">
      <div className="flex">
        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg">
            <Link 
              to={`/shows/${episode.showId}/episodes/${encodeURIComponent(episode.guid)}`}
              className="text-lg font-semibold text-gray-900 hover:text-blue-600 transition-colors block truncate"
            >
              {episode.title}
            </Link>
          </h3>
          <p className="mt-2 text-sm text-gray-600 line-clamp-3 leading-relaxed">{episode.description}</p>
          
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs sm:text-sm text-gray-500">
            <span className="flex items-center">
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {formatDate(episode.publishDate)}
            </span>
            <span className="flex items-center">
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {formatDuration(episode.duration)}
            </span>
            {episode.showTitle && (
              <span className="flex items-center">
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                {episode.showTitle}
              </span>
            )}
          </div>
        </div>
        {episode.jobStatus && (
          <div className="ml-4 flex-shrink-0">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${statusColors[episode.jobStatus as keyof typeof statusColors] || 'bg-gray-100 text-gray-800'}`}>
              {episode.jobStatus}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}