import { test, expect, navigateTo } from "../fixtures";

/**
 * The audio viewer, driven against a REAL tagged MP3 (tests/fixtures/
 * sample-track.mp3, served by the mock with Range support).
 *
 * This exists because a typecheck and a build both pass on a player that
 * renders nothing: the desktop components were restyled from web's shadcn
 * utilities onto desktop's --color-* vocabulary by hand, and a wrong variable
 * name produces a grey waveform, not a compile error. The parsing, decoding
 * and canvas paths are only real here.
 */
test.describe("Audio viewer", () => {
  test("plays a tagged mp3: artwork, tags, waveform and queue", async ({ appPage }) => {
    await navigateTo(appPage, "/files");
    await appPage.getByText("03 Midnight Ferry.mp3").first().dblclick();

    // Tags come off the file's own ID3 header, so the title is NOT the filename.
    const heading = appPage.locator("h2", { hasText: "Midnight Ferry" });
    await expect(heading).toBeVisible({ timeout: 15000 });
    await expect(appPage.getByText("Neon Aviary")).toBeVisible();
    await expect(appPage.getByText("Signal Hills")).toBeVisible();

    // Read out of the first MP3 frame header, not guessed from the extension.
    await expect(appPage.getByText("320 kbps")).toBeVisible();
    await expect(appPage.getByText("44.1 kHz")).toBeVisible();

    // Embedded cover art, decoded to a blob URL.
    const art = appPage.locator("img[alt^='Cover art']");
    await expect(art).toBeVisible();
    expect(await art.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // The queue is the audio siblings, and only those.
    await expect(appPage.locator("button[data-track]")).toHaveCount(2);
    await expect(appPage.locator("button[data-track]", { hasText: "Project Report" })).toHaveCount(0);
    await expect(appPage.locator("button[data-track]", { hasText: "Harbour Static" })).toHaveCount(1);
  });

  test("draws a waveform that follows the audio, not noise", async ({ appPage }) => {
    await navigateTo(appPage, "/files");
    await appPage.getByText("03 Midnight Ferry.mp3").first().dblclick();
    await expect(appPage.locator("canvas")).toBeVisible({ timeout: 20000 });
    // The canvas mounts as the bars start rising (620ms grow). Measuring
    // mid-animation reads partial heights and the ratio has not settled yet.
    await appPage.waitForTimeout(1200);

    // The fixture is deliberately quiet-loud-quiet. If the decode silently
    // failed and something drew a placeholder, these would be equal.
    const bars = await appPage.locator("canvas").evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const tallest = (xFrac: number) => {
        let best = 0;
        const start = Math.floor(c.width * xFrac);
        for (let x = start; x < Math.min(c.width, start + 20); x++) {
          let top = -1, bot = -1;
          for (let y = 0; y < c.height; y++) {
            if (d[(y * c.width + x) * 4 + 3] > 8) { if (top === -1) top = y; bot = y; }
          }
          if (top !== -1 && bot - top > best) best = bot - top;
        }
        return best;
      };
      return { intro: tallest(0.12), middle: tallest(0.5) };
    });

    expect(bars.intro).toBeGreaterThan(0);
    expect(bars.middle).toBeGreaterThan(bars.intro * 3);
  });

  test("plays, seeks and reports position", async ({ appPage }) => {
    await navigateTo(appPage, "/files");
    await appPage.getByText("03 Midnight Ferry.mp3").first().dblclick();
    await expect(appPage.locator("canvas")).toBeVisible({ timeout: 20000 });

    await appPage.getByRole("button", { name: "Play", exact: true }).click();
    await appPage.waitForTimeout(1500);
    await expect(appPage.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

    const playing = await appPage.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(playing).toBeGreaterThan(0.4);

    // Click three quarters along the waveform.
    const box = (await appPage.locator("canvas").boundingBox())!;
    await appPage.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    await appPage.waitForTimeout(400);

    const seeked = await appPage.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime);
    expect(seeked).toBeGreaterThan(7);
    await expect(appPage.locator("[role='slider'][aria-label='Seek']")).toHaveAttribute(
      "aria-valuetext",
      /0:0[789]|0:1[012] of 0:12/,
    );
  });

  test("shows the file's own lyrics, and follows them", async ({ appPage }) => {
    await navigateTo(appPage, "/files");
    await appPage.getByText("03 Midnight Ferry.mp3").first().dblclick();
    await expect(appPage.locator("h2", { hasText: "Midnight Ferry" })).toBeVisible({ timeout: 15000 });

    await appPage.getByRole("tab", { name: /lyrics/i }).click();
    await expect(appPage.getByText("Harbour lights come up in threes")).toBeVisible();
    await expect(appPage.locator("ol li")).toHaveCount(4);
  });

  test("takes its colour from the theme, never from the artwork", async ({ appPage }) => {
    await navigateTo(appPage, "/files");
    await appPage.getByText("03 Midnight Ferry.mp3").first().dblclick();
    await expect(appPage.locator("canvas")).toBeVisible({ timeout: 20000 });

    // Nothing is drawn in the played colour until the playhead has moved.
    await appPage.getByRole("button", { name: "Play", exact: true }).click();
    await appPage.waitForTimeout(2500);

    // The played portion must be the theme's primary. A restyle that lost the
    // variable renders grey here while every other check still passes.
    const { primary, drawn } = await appPage.locator("canvas").evaluate((c: HTMLCanvasElement) => {
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.fillStyle = getComputedStyle(c).getPropertyValue("--color-primary");
      const resolved = probe.fillStyle;

      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const counts = new Map<string, number>();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      return { primary: resolved, drawn: top };
    });

    // Resolve the token to the same rgb space the canvas reports.
    const [pr, pg, pb] = await appPage.evaluate((css: string) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    }, primary);

    const [dr, dg, db] = drawn.split(",").map(Number);
    const distance = Math.abs(dr - pr) + Math.abs(dg - pg) + Math.abs(db - pb);
    expect(distance).toBeLessThan(60);
  });
});
