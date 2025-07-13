import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import ShowsPage from './pages/ShowsPage'
import ShowDetailPage from './pages/ShowDetailPage'
import EpisodeDetailPage from './pages/EpisodeDetailPage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="shows" element={<ShowsPage />} />
        <Route path="shows/:showId" element={<ShowDetailPage />} />
        <Route path="shows/:showId/episodes/:episodeId" element={<EpisodeDetailPage />} />
      </Route>
    </Routes>
  )
}

export default App