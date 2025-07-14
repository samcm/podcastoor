import React, { useEffect, useState } from 'react';
import { ProcessingJob } from '@podcastoor/shared';
import { api } from '../api/client';

export function JobStatus({ job }: { job: ProcessingJob }) {
  const [status, setStatus] = useState(job);
  
  useEffect(() => {
    if (job.status === 'running') {
      const interval = setInterval(async () => {
        try {
          const updated = await api.getJobStatus(job.id);
          setStatus(updated.job);
          if (updated.job.status !== 'running') {
            clearInterval(interval);
          }
        } catch (error) {
          console.error('Failed to update job status:', error);
        }
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [job.id, job.status]);
  
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-medium">Processing Status</span>
        <span className={`px-2 py-1 text-xs rounded-full ${
          status.status === 'completed' ? 'bg-green-100 text-green-800' :
          status.status === 'failed' ? 'bg-red-100 text-red-800' :
          status.status === 'running' ? 'bg-blue-100 text-blue-800' :
          'bg-gray-100 text-gray-800'
        }`}>
          {status.status}
        </span>
      </div>
      {status.status === 'running' && (
        <div className="space-y-2">
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${status.progress}%` }}
            />
          </div>
          {status.processingSteps && (
            <p className="text-xs text-gray-600">
              {JSON.parse(status.processingSteps).slice(-1)[0]?.name || 'Processing...'}
            </p>
          )}
        </div>
      )}
      {status.status === 'failed' && status.lastError && (
        <p className="text-sm text-red-600 mt-2">{status.lastError}</p>
      )}
    </div>
  );
}