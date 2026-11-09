# Mission: spike-rayban

**What this repo is, in two sentences.** An iPhone app on Meta's Wearables Device Access Toolkit 1.0.1 that draws a
small conversation on Meta Ray-Ban Display glasses and takes its button presses from the Neural Band, alone, so the
glasses can be tried without Infrared, a Mac or a planning session, and on a simulator. It exists to learn what the
glasses' interface can be before Infrared depends on it; Infrared's own use of them is localred's iPhone app.

**What we are doing next.** Seeking a UWB beacon away from the Mac, with the glasses on: the beacon on a power bank,
the alert past 10 m, "moving away" while you stand still, Lost out of range, and the distance at a measured 1 m and 3 m,
from the app's log. Then correct the distance. The glasses demo still waits on presses from the Neural Band arriving on
the phone (the Presses list says "glasses").

**How we know it worked.** A person finds the beacon with the lens and the voice alone, and the log shows the distance
within ten centimetres of a measured one, written down in `README.md` and `PROGRESS.md`.

## The loop

Read `PROGRESS.md`, change one thing, run `make verify`, and `make sim` when the screen changes. A run on a real pair
is a person's, with the glasses on. Append to `PROGRESS.md`, commit.
