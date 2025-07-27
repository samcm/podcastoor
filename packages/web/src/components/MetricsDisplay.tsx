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
  
  // Calculate total cost from the costs array with safe number handling
  const totalCost = safeCosts.reduce((sum, cost) => {
    const costValue = cost?.cost;
    return sum + (typeof costValue === 'number' && !isNaN(costValue) ? costValue : 0);
  }, 0);
  
  const costByModel = safeCosts.reduce((acc, cost) => {
    if (!cost?.model) return acc;
    if (!acc[cost.model]) acc[cost.model] = 0;
    const costValue = cost?.cost;
    if (typeof costValue === 'number' && !isNaN(costValue)) {
      acc[cost.model] += costValue;
    }
    return acc;
  }, {} as Record<string, number>);
  
  // Calculate total processing time with safe handling
  const totalDurationMs = safeCosts.reduce((sum, c) => {
    const duration = c?.durationMs;
    return sum + (typeof duration === 'number' && !isNaN(duration) ? duration : 0);
  }, 0);
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Processing Cost */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Cost</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          ${(totalCost || 0).toFixed(4)}
        </p>
        {Object.keys(costByModel).length > 0 && (
          <div className="mt-2 space-y-1">
            {Object.entries(costByModel).map(([model, cost]) => (
              <p key={model} className="text-xs text-gray-600">
                {model}: ${(cost || 0).toFixed(4)}
              </p>
            ))}
          </div>
        )}
      </div>
      
      {/* Processing Time */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-medium text-gray-500">Processing Time</h3>
        <p className="mt-2 text-3xl font-semibold text-gray-900">
          {(totalDurationMs && totalDurationMs > 0) ? formatDuration(totalDurationMs) : '0s'}
        </p>
        {safeCosts.length > 0 && (
          <div className="mt-2 space-y-1">
            {safeCosts.map((cost, i) => (
              <p key={i} className="text-xs text-gray-600">
                {cost?.operation || 'Unknown'}: {formatDuration(cost?.durationMs || 0)}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}