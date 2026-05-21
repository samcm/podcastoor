import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import "./styles.css";
import { Shell } from "./components/Shell";
import { Home } from "./views/Home";
import { Podcasts } from "./views/Podcasts";
import { Podcast } from "./views/Podcast";
import { Episode } from "./views/Episode";
import { Queue } from "./views/Queue";
import { Cost } from "./views/Cost";
import { Tuning } from "./views/Tuning";
import { Logs } from "./views/Logs";

function Layout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}

const router = createBrowserRouter([
  { path: "/", element: <Layout><Home /></Layout> },
  { path: "/podcasts", element: <Layout><Podcasts /></Layout> },
  { path: "/podcasts/:slug", element: <Layout><Podcast /></Layout> },
  { path: "/podcasts/:slug/episodes/:key", element: <Layout><Episode /></Layout> },
  { path: "/queue", element: <Layout><Queue /></Layout> },
  { path: "/costs", element: <Layout><Cost /></Layout> },
  { path: "/tuning", element: <Layout><Tuning /></Layout> },
  { path: "/logs", element: <Layout><Logs /></Layout> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
