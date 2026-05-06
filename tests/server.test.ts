import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { defaultConfig } from "../src/config.js";

describe("server", () => {
  it("serves audio byte ranges for browser seeking", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "podcastoor-server-"));
    const episodeDir = path.join(dataDir, "podcasts", "show", "episodes", "episode");
    await mkdir(episodeDir, { recursive: true });
    await writeFile(path.join(episodeDir, "episode.mp3"), "abcdefghij");

    const app = buildServer({
      ...defaultConfig,
      storage: { dataDir },
      podcasts: {
        show: { name: "Show", feedUrl: "https://example.com/feed.xml" }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/audio/show/episode/episode.mp3",
      headers: { range: "bytes=2-5" }
    });
    await app.close();

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.body).toBe("cdef");
  });
});
