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
      className="group block bg-white rounded-xl shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden border border-gray-100 hover:border-gray-200"
    >
      {/* Podcast Cover Art */}
      <div className="relative">
        {podcast.imageUrl ? (
          <div className="aspect-video relative overflow-hidden">
            <img 
              src={podcast.imageUrl} 
              alt={podcast.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
          </div>
        ) : (
          <div className="aspect-video bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 flex items-center justify-center">
            <svg className="w-16 h-16 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zm12-3c0 1.105-.895 2-2 2s-2-.895-2-2 .895-2 2-2 2 .895 2 2zM9 10l12-3" />
            </svg>
          </div>
        )}
        
        {/* Progress Indicator Overlay */}
        <div className="absolute bottom-0 left-0 right-0 h-1">
          <div 
            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <div className="mb-3">
          <h3 className="text-lg font-bold text-gray-900 group-hover:text-blue-600 transition-colors duration-200 line-clamp-1">
            {podcast.title}
          </h3>
          {podcast.author && (
            <p className="mt-1 text-sm font-medium text-gray-600">{podcast.author}</p>
          )}
        </div>

        <p className="text-sm text-gray-500 line-clamp-2 leading-relaxed mb-4">
          {podcast.description}
        </p>
        
        {/* Stats */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center text-gray-600">
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span>{podcast.processedEpisodeCount || 0} / {podcast.episodeCount || 0} episodes</span>
          </div>
          
          <div className="flex items-center">
            <span className="text-xs font-medium text-gray-500 mr-2">{Math.round(progress)}%</span>
            <div className="w-16 bg-gray-200 rounded-full h-1.5">
              <div 
                className="bg-gradient-to-r from-blue-500 to-purple-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </Link>
  )
}