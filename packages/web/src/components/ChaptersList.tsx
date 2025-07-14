import React from 'react';
import { Chapter } from '@podcastoor/shared';
import { formatTime } from '@podcastoor/shared';

export function ChaptersList({ chapters }: { chapters: Chapter[] }) {
  return (
    <div className="space-y-2">
      {chapters.map((chapter) => (
        <div key={chapter.id} className="flex items-start space-x-3 p-3 hover:bg-gray-50 rounded-lg">
          <span className="text-sm font-mono text-gray-500">
            {formatTime(chapter.startTime)}
          </span>
          <div className="flex-1">
            <h4 className="text-sm font-medium text-gray-900">{chapter.title}</h4>
            {chapter.summary && (
              <p className="text-sm text-gray-600 mt-1">{chapter.summary}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}