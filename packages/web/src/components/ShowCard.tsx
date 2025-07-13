import { Link } from 'react-router-dom'
import { Podcast } from '../api/client'

interface ShowCardProps {
  podcast: Podcast
}

export default function ShowCard({ podcast }: ShowCardProps) {
  const progress = podcast.processingProgress || 0

  return (
    <Link 
      to={`/shows/${podcast.id}`}
      className="block bg-white rounded-lg shadow hover:shadow-md transition-shadow overflow-hidden"
    >
      <div className="p-6">
        <div className="flex items-start">
          {podcast.imageUrl && (
            <img 
              src={podcast.imageUrl} 
              alt={podcast.title}
              className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
            />
          )}
          <div className={podcast.imageUrl ? 'ml-4' : ''}>
            <h3 className="text-lg font-semibold text-gray-900">{podcast.title}</h3>
            <p className="mt-1 text-sm text-gray-600">{podcast.author}</p>
            <p className="mt-2 text-sm text-gray-500 line-clamp-2">{podcast.description}</p>
          </div>
        </div>
        
        <div className="mt-4">
          <div className="flex justify-between text-sm text-gray-600 mb-1">
            <span>{podcast.processedEpisodeCount || 0} / {podcast.episodeCount || 0} episodes</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </Link>
  )
}