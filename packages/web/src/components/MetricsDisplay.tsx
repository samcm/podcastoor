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
  // Handle cases where costs might be undefined or empty
  const safeCosts = costs || [];
  
  // Calculate total cost from the costs array
  const totalCost = safeCosts.reduce((sum, cost) => sum + cost.cost, 0);
  
  const costByModel = safeCosts.reduce((acc, cost) => {
    if (!acc[cost.model]) acc[cost.model] = 0;
    acc[cost.model] += cost.cost;
    return acc;
  }, {} as Record<string, number>);
  
  // Calculate total processing time
  const totalDurationMs = safeCosts.reduce((sum, c) => sum + c.durationMs, 0);
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Processing Cost */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Cost</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          ${totalCost.toFixed(4)}
        </p>
        {Object.keys(costByModel).length > 0 && (
          <div className="mt-2 space-y-1">
            {Object.entries(costByModel).map(([model, cost]) => (
              <p key={model} className="text-xs text-gray-600">
                {model}: ${cost.toFixed(4)}
              </p>
            ))}
          </div>
        )}
      </div>
      
      {/* Processing Time */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Time</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          {totalDurationMs > 0 ? formatDuration(totalDurationMs) : '0s'}
        </p>
        {safeCosts.length > 0 && (
          <div className="mt-2 space-y-1">
            {safeCosts.map((cost, i) => (
              <p key={i} className="text-xs text-gray-600">
                {cost.operation}: {formatDuration(cost.durationMs)}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}