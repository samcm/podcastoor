import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { EpisodeDetails } from '@podcastoor/shared';
import { api } from '../api/client';
import { JobStatus } from '../components/JobStatus';
import { MetricsDisplay } from '../components/MetricsDisplay';
import { ChaptersList } from '../components/ChaptersList';
import { formatTime, formatDuration } from '@podcastoor/shared';

export default function EpisodeDetailPage() {
  const { podcastId, episodeGuid } = useParams<{ podcastId: string; episodeGuid: string }>();
  const [episode, setEpisode] = useState<EpisodeDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  
  useEffect(() => {
    if (episodeGuid) {
      loadEpisode();
    }
  }, [episodeGuid]);
  
  const loadEpisode = async () => {
    try {
      setLoading(true);
      const data = await api.getEpisode(episodeGuid!, podcastId);
      setEpisode(data);
    } catch (error) {
      console.error('Failed to load episode:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const handleProcessEpisode = async () => {
    if (!episode?.upstream) return;
    
    try {
      const { jobId } = await api.createJob(episode.upstream.episodeGuid);
      // Reload to show new job
      await loadEpisode();
    } catch (error) {
      console.error('Failed to create job:', error);
    }
  };
  
  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }
  
  if (!episode?.upstream) {
    return <div className="text-center py-8">Episode not found</div>;
  }
  
  const { upstream, job, result, chapters, adRemovals, llmCosts } = episode;
  
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <Link to={`/shows/${podcastId}`} className="text-blue-600 hover:text-blue-800 mb-4 inline-block">
          ← Back to show
        </Link>
        
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{upstream.title}</h1>
        
        <div className="flex items-center space-x-4 text-sm text-gray-600">
          <span>{new Date(upstream.publishDate).toLocaleDateString()}</span>
          <span>•</span>
          <span>{formatTime(upstream.duration)}</span>
          <span>•</span>
          <span>{(upstream.fileSize / 1024 / 1024).toFixed(1)} MB</span>
        </div>
      </div>
      
      {/* Job Status or Process Button */}
      {job ? (
        <JobStatus job={job} />
      ) : (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
          <h3 className="text-lg font-medium text-blue-900 mb-2">Process this episode</h3>
          <p className="text-blue-700 mb-4">
            This episode hasn't been processed yet. Click below to remove ads and generate chapters.
          </p>
          <button
            onClick={handleProcessEpisode}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            Process Episode
          </button>
        </div>
      )}
      
      {/* Metrics (if processed) */}
      {result && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Processing Metrics</h2>
          <MetricsDisplay result={result} costs={llmCosts} />
        </div>
      )}
      
      {/* Audio Player */}
      <div className="bg-gray-100 rounded-lg p-6 mb-8">
        <h2 className="text-lg font-medium mb-4">
          {result ? 'Processed Audio' : 'Original Audio'}
        </h2>
        <audio 
          controls 
          className="w-full"
          src={api.getAudioUrl(upstream.episodeGuid)}
        >
          Your browser does not support the audio element.
        </audio>
      </div>
      
      {/* Tabs for details */}
      {result && (
        <div>
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
              {['overview', 'chapters', 'ads', 'costs'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`py-2 px-1 border-b-2 font-medium text-sm ${
                    activeTab === tab
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </nav>
          </div>
          
          <div className="py-6">
            {activeTab === 'overview' && (
              <div className="prose max-w-none">
                <h3>Description</h3>
                <div dangerouslySetInnerHTML={{ __html: upstream.description }} />
              </div>
            )}
            
            {activeTab === 'chapters' && (
              <div>
                <h3 className="text-lg font-medium mb-4">
                  {chapters.length} Chapters Generated
                </h3>
                <ChaptersList chapters={chapters} />
              </div>
            )}
            
            {activeTab === 'ads' && (
              <div>
                <h3 className="text-lg font-medium mb-4">
                  {adRemovals.length} Ads Removed
                </h3>
                <div className="space-y-2">
                  {adRemovals.map((ad) => (
                    <div key={ad.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <span className="font-mono text-sm">
                          {formatTime(ad.startTime)} - {formatTime(ad.endTime)}
                        </span>
                        <span className="ml-3 text-sm text-gray-600">
                          {ad.category}
                        </span>
                      </div>
                      <span className="text-sm text-gray-500">
                        {(ad.confidence * 100).toFixed(0)}% confidence
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {activeTab === 'costs' && (
              <div>
                <h3 className="text-lg font-medium mb-4">LLM Cost Breakdown</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead>
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Operation</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tokens</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {llmCosts.map((cost) => (
                        <tr key={cost.id}>
                          <td className="px-6 py-4 text-sm">{cost.operation}</td>
                          <td className="px-6 py-4 text-sm">{cost.model}</td>
                          <td className="px-6 py-4 text-sm">{cost.totalTokens.toLocaleString()}</td>
                          <td className="px-6 py-4 text-sm">{formatDuration(cost.durationMs)}</td>
                          <td className="px-6 py-4 text-sm">${cost.cost.toFixed(4)}</td>
                        </tr>
                      ))}
                      <tr className="bg-gray-50 font-medium">
                        <td colSpan={4} className="px-6 py-4 text-sm">Total</td>
                        <td className="px-6 py-4 text-sm">
                          ${llmCosts.reduce((sum, c) => sum + c.cost, 0).toFixed(4)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}