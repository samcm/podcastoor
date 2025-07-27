import { useState, useRef } from 'react';
import { AdSegment, formatTime } from '@podcastoor/shared';

interface AdSegmentPlayerProps {
  adSegments: AdSegment[];
}

export function AdSegmentPlayer({ adSegments }: AdSegmentPlayerProps) {
  const [selectedAdIndex, setSelectedAdIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const handleAdSelect = (index: number) => {
    setSelectedAdIndex(index);
    setIsPlaying(false);
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const selectedAd = selectedAdIndex !== null ? adSegments[selectedAdIndex] : null;

  if (adSegments.length === 0) {
    return (
      <div className="text-gray-500 text-center py-8">
        No ad segments were detected in this episode.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium mb-4">
        {adSegments.length} Ad Segments Detected
      </h3>
      
      {/* Ad Segments List */}
      <div className="space-y-2">
        {adSegments.map((ad, index) => (
          <div
            key={index}
            className={`p-4 rounded-lg border cursor-pointer transition-colors ${
              selectedAdIndex === index
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
            onClick={() => handleAdSelect(index)}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h4 className="font-medium text-gray-900">
                  {ad.title || `${ad.adType} Ad ${index + 1}`}
                </h4>
                {ad.description && (
                  <p className="text-sm text-gray-600 mt-1">{ad.description}</p>
                )}
                <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                  <span className="font-mono">
                    {formatTime(ad.startTime)} - {formatTime(ad.endTime)}
                  </span>
                  <span className="bg-gray-100 px-2 py-1 rounded">
                    {ad.adType}
                  </span>
                  <span>
                    {ad.duration.toFixed(1)}s
                  </span>
                  <span className="text-gray-400">
                    {(ad.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>
              </div>
              {selectedAdIndex === index && (
                <div className="ml-4">
                  <svg
                    className="w-5 h-5 text-blue-500"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Audio Player for Selected Ad */}
      {selectedAd && (
        <div className="mt-6 p-4 bg-gray-100 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-medium">
              Playing: {selectedAd.title || `${selectedAd.adType} Ad ${selectedAdIndex! + 1}`}
            </h4>
            <button
              onClick={togglePlayPause}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 flex items-center gap-2"
            >
              {isPlaying ? (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                  </svg>
                  Play
                </>
              )}
            </button>
          </div>
          
          <audio
            ref={audioRef}
            controls
            className="w-full"
            src={selectedAd.audioUrl}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      )}
    </div>
  );
}