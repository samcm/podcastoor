import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, EpisodeDetails } from '../api/client';
import { JobStatus } from '../components/JobStatus';
// import { MetricsDisplay } from '../components/MetricsDisplay';
import { ChaptersList } from '../components/ChaptersList';
// import { AdSegmentPlayer } from '../components/AdSegmentPlayer';
import ErrorBoundary from '../components/ErrorBoundary';
import { formatTime, formatDuration } from '../utils/format';

export default function EpisodeDetailPage() {
  const { showId, episodeId } = useParams<{ showId: string; episodeId: string }>();
  const [episode, setEpisode] = useState<EpisodeDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  
  useEffect(() => {
    if (episodeId) {
      loadEpisode();
    }
  }, [episodeId]);
  
  const loadEpisode = async () => {
    try {
      setLoading(true);
      console.log('Loading episode with params:', { episodeId, showId });
      const data = await api.getEpisode(episodeId!);
      console.log('Episode data loaded:', data);
      setEpisode(data);
    } catch (error) {
      console.error('Failed to load episode:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const handleProcessEpisode = async () => {
    if (!episode?.episode) return;
    
    try {
      const { jobId } = await api.createJob(episode.episode.guid);
      // Reload to show new job
      await loadEpisode();
    } catch (error) {
      console.error('Failed to create job:', error);
    }
  };
  
  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }
  
  if (!episode?.episode) {
    return <div className="text-center py-8">Episode not found</div>;
  }
  
  const { episode: ep, job, processedEpisode, chapters, ads } = episode;
  
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-start gap-6">
          <div className="flex-1">
            <Link 
              to={`/shows/${showId}`}
              className="inline-flex items-center text-blue-600 hover:text-blue-800 mb-4"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Show
            </Link>
            
            <div className="mb-6">
              <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-3 leading-tight">
                {ep.title}
              </h1>
              
              <div className="flex flex-wrap gap-4 text-sm text-gray-600 mb-4">
                <span className="flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {new Date(ep.publishDate).toLocaleDateString()}
                </span>
                <span className="flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {formatDuration(ep.duration)}
                </span>
              </div>
              
              {/* Episode Description Preview */}
              {ep.description && (
                <div className="prose prose-gray max-w-none">
                  <p className="text-gray-600 leading-relaxed line-clamp-3">
                    {ep.description.replace(/<[^>]*>/g, '').substring(0, 300)}
                    {ep.description.length > 300 && '...'}
                  </p>
                </div>
              )}
            </div>
            
            {/* Job Status */}
            {job && (
              <div className="border-t pt-4">
                <JobStatus job={job} onRetry={loadEpisode} />
              </div>
            )}
            
            {/* Process Button or Status */}
            {!job ? (
              <button
                onClick={handleProcessEpisode}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Process Episode
              </button>
            ) : (
              <div className="text-sm text-gray-500">
                {job.status === 'pending' && 'Episode is queued for processing...'}
                {job.status === 'processing' && 'Episode is being processed...'}
                {job.status === 'completed' && 'Episode has been processed'}
                {job.status === 'failed' && 'Processing failed'}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Processing Results */}
      {processedEpisode && (
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Processing Complete
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <div className="text-sm text-blue-700 font-medium">Original Duration</div>
              <div className="text-2xl font-bold text-blue-900">{formatDuration(processedEpisode.originalDuration)}</div>
            </div>
            <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
              <div className="text-sm text-purple-700 font-medium">Processed Duration</div>
              <div className="text-2xl font-bold text-purple-900">{formatDuration(processedEpisode.processedDuration)}</div>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <div className="text-sm text-green-700 font-medium">Time Saved</div>
              <div className="text-2xl font-bold text-green-900">
                {formatDuration(processedEpisode.originalDuration - processedEpisode.processedDuration)}
              </div>
              <div className="text-xs text-green-600 mt-1">
                {Math.round(((processedEpisode.originalDuration - processedEpisode.processedDuration) / processedEpisode.originalDuration) * 100)}% reduction
              </div>
            </div>
          </div>
          {processedEpisode.processingCost && (
            <div className="mt-4 text-sm text-gray-600">
              Processing cost: ${processedEpisode.processingCost.toFixed(4)}
            </div>
          )}
        </div>
      )}
      
      {/* Audio Player */}
      {ep.audioUrl && (
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              {processedEpisode ? (
                <>
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Ad-Free Audio
                </>
              ) : (
                <>
                  <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                  Original Audio
                </>
              )}
            </h2>
            {processedEpisode && (
              <span className="text-sm text-green-600 font-medium">
                {ads.length} ads removed
              </span>
            )}
          </div>
          <audio
            controls
            className="w-full h-12 rounded-lg"
            src={processedEpisode ? processedEpisode.processedUrl : ep.audioUrl}
          >
            Your browser does not support the audio element.
          </audio>
          {processedEpisode && (
            <div className="mt-3 flex items-center gap-4 text-sm text-gray-600">
              <a 
                href={processedEpisode.processedUrl}
                download
                className="flex items-center gap-1 hover:text-blue-600"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                </svg>
                Download
              </a>
              <a 
                href={ep.audioUrl}
                className="flex items-center gap-1 hover:text-blue-600"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Original
              </a>
            </div>
          )}
        </div>
      )}
      
      {/* Tabs */}
      {(chapters.length > 0 || ads.length > 0) && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="border-b">
            <div className="flex space-x-8 px-6">
              <button
                onClick={() => setActiveTab('overview')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'overview'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Overview
              </button>
              {chapters.length > 0 && (
                <button
                  onClick={() => setActiveTab('chapters')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'chapters'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Chapters ({chapters.length})
                </button>
              )}
              {ads.length > 0 && (
                <button
                  onClick={() => setActiveTab('ads')}
                  className={`py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === 'ads'
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Ads Detected ({ads.length})
                </button>
              )}
            </div>
          </div>
          
          <div className="p-6">
            {activeTab === 'overview' && (
              <div className="prose prose-gray max-w-none">
                <h3 className="text-lg font-semibold mb-2">Description</h3>
                <p className="text-gray-700 whitespace-pre-wrap">{ep.description}</p>
              </div>
            )}
            
            {activeTab === 'chapters' && chapters.length > 0 && (
              <ChaptersList chapters={chapters} />
            )}
            
            {activeTab === 'ads' && ads.length > 0 && (
              <div>
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                  {ads.length} Ads Detected and Removed
                </h3>
                <div className="space-y-3">
                  {ads.map((ad, index) => (
                    <div key={index} className="flex items-center justify-between p-4 bg-red-50 rounded-lg border border-red-200">
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium text-red-900">
                            {formatTime(ad.startTime)} - {formatTime(ad.endTime)}
                          </span>
                          <span className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-full">
                            {formatDuration(ad.endTime - ad.startTime)}
                          </span>
                          {ad.adType && (
                            <span className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded-full capitalize">
                              {ad.adType}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-sm text-gray-600">
                          {Math.round(ad.confidence * 100)}%
                        </div>
                        <div className="w-16 bg-gray-200 rounded-full h-2">
                          <div 
                            className="bg-red-600 h-2 rounded-full"
                            style={{ width: `${ad.confidence * 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
                    <p className="text-sm text-green-800">
                      <strong>Total time saved:</strong> {formatDuration(ads.reduce((sum, ad) => sum + (ad.endTime - ad.startTime), 0))}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}