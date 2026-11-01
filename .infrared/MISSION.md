# Mission: spike-rayban

**What this repo is, in two sentences.** An iPhone app on Meta's Wearables Device Access Toolkit 1.0.1 that draws a
small conversation on Meta Ray-Ban Display glasses and takes its button presses from the Neural Band, alone, so the
glasses can be tried without Infrared, a Mac or a planning session, and on a simulator. It exists to learn what the
glasses' interface can be before Infrared depends on it; Infrared's own use of them is localred's iPhone app.

**What we are doing next.** The first run on a real pair: Developer Mode on in Meta AI, the app registered, the
display opened, and presses from the Neural Band arriving on the phone (the Presses list says "glasses").

**How we know it worked.** On a real pair, every screen of the demo drawn and pressed through from the Neural Band
alone, and the draw time the app reports written down in `README.md` and `PROGRESS.md`.

## The loop

Read `PROGRESS.md`, change one thing, run `make verify`, and `make sim` when the screen changes. A run on a real pair
is a person's, with the glasses on. Append to `PROGRESS.md`, commit.
