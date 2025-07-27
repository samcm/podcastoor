import React from 'react';
import { formatTime } from '../utils/format';

interface Chapter {
  id: number;
  jobId: number;
  title: string;
  startTime: number;
  endTime: number;
  summary?: string;
}

export function ChaptersList({ chapters }: { chapters: Chapter[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
        <h3 className="text-lg font-medium">Chapter Navigation</h3>
      </div>
      {chapters.map((chapter, index) => (
        <div key={chapter.id} className="group flex items-start gap-4 p-4 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-200">
          <div className="flex flex-col items-center">
            <span className="text-2xl font-bold text-gray-300 group-hover:text-blue-400">
              {(index + 1).toString().padStart(2, '0')}
            </span>
            <span className="text-xs font-mono text-gray-500 mt-1">
              {formatTime(chapter.startTime)}
            </span>
          </div>
          <div className="flex-1">
            <h4 className="text-base font-semibold text-gray-900 group-hover:text-blue-700">
              {chapter.title}
            </h4>
            {chapter.summary && (
              <p className="text-sm text-gray-600 mt-1 line-clamp-2">{chapter.summary}</p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-gray-500">
                Duration: {formatTime(chapter.endTime - chapter.startTime)}
              </span>
              <span className="text-gray-300">•</span>
              <span className="text-xs text-gray-500">
                Ends at {formatTime(chapter.endTime)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}