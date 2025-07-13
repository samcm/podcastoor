interface StatsCardProps {
  title: string
  value: number | string
  subtitle?: string
}

export default function StatsCard({ title, value, subtitle }: StatsCardProps) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h3 className="text-sm font-medium text-gray-500">{title}</h3>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
    </div>
  )
}