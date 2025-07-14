import React from 'react';
import { ProcessingResult, LLMCost } from '@podcastoor/shared';
import { formatDuration, formatTime } from '@podcastoor/shared';

export function MetricsDisplay({ 
  result, 
  costs 
}: { 
  result: ProcessingResult;
  costs: LLMCost[];
}) {
  const costByModel = costs.reduce((acc, cost) => {
    if (!acc[cost.model]) acc[cost.model] = 0;
    acc[cost.model] += cost.cost;
    return acc;
  }, {} as Record<string, number>);
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Time Saved */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Time Saved</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          {formatTime(result.timeSaved)}
        </p>
        <p className="mt-1 text-sm text-gray-600">
          {((result.timeSaved / result.originalDuration) * 100).toFixed(1)}% reduction
        </p>
      </div>
      
      {/* Processing Cost */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Cost</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          ${result.totalCost.toFixed(4)}
        </p>
        <div className="mt-2 space-y-1">
          {Object.entries(costByModel).map(([model, cost]) => (
            <p key={model} className="text-xs text-gray-600">
              {model}: ${cost.toFixed(4)}
            </p>
          ))}
        </div>
      </div>
      
      {/* Processing Time */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Time</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          {formatDuration(
            costs.reduce((sum, c) => sum + c.durationMs, 0)
          )}
        </p>
        <div className="mt-2 space-y-1">
          {costs.map((cost, i) => (
            <p key={i} className="text-xs text-gray-600">
              {cost.operation}: {formatDuration(cost.durationMs)}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}