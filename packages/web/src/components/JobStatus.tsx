import React from 'react';

interface Job {
  id: number;
  episodeGuid: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  priority: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface JobStatusProps {
  job: Job;
  onRetry?: () => void;
}

export function JobStatus({ job, onRetry }: JobStatusProps) {
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-medium">Processing Status</span>
        <span className={`px-2 py-1 text-xs rounded-full ${
          job.status === 'completed' ? 'bg-green-100 text-green-800' :
          job.status === 'failed' ? 'bg-red-100 text-red-800' :
          job.status === 'processing' ? 'bg-blue-100 text-blue-800' :
          'bg-gray-100 text-gray-800'
        }`}>
          {job.status}
        </span>
      </div>
      
      {job.status === 'processing' && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className="bg-blue-600 h-2 rounded-full animate-pulse"
            style={{ width: '50%' }}
          />
        </div>
      )}
      
      {job.status === 'failed' && job.error && (
        <div className="mt-2">
          <p className="text-sm text-red-600">{job.error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              Retry
            </button>
          )}
        </div>
      )}
      
      {job.completedAt && (
        <p className="text-xs text-gray-500 mt-2">
          Completed: {new Date(job.completedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}