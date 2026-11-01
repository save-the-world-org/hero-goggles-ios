# spike-rayban

The Meta Ray-Ban Display spike: an iPhone app on Meta's Wearables Device Access Toolkit 1.0.1 that draws on the
glasses' display and takes Neural Band presses, with nothing of Infrared in it. Infrared's own use of the glasses is in
darkshiftio/localred's iPhone app (`app/Mobile/Glasses`, `docs/app.md`, "Glasses"). darkshiftio/workspace's
`CLAUDE.md` applies here too.

- **Meta's side is Developer Mode, not an account.** `MetaAppID` and `ClientToken` stay unset (`Config/Info.plist`),
  which Meta AI's Developer Mode allows. An app in Meta's Wearables Developer Center, which the experimental
  capabilities (Neural Band events, speech on the glasses, "Hey Meta, start ...") need, is an account: the owner's
  decision, and an `accounts/` entry in the workspace first. Its IDs go only in the git-ignored
  `Config/Signing.local.xcconfig`, never in a committed file.
- **Nothing goes to Meta that need not.** The toolkit's analytics and crash reports stay opted out (`Config/Info.plist`).
- **Signing is each person's own.** Their Apple Developer team goes in `Config/Signing.local.xcconfig`, which git
  ignores; never commit it. The first signed build registers `io.darkshift.rayban-spike` with that person's team, so
  `make device` is theirs to run.
- **The glasses are a person's.** Evidence from a real pair needs the person wearing them; a simulator run uses Meta's
  simulated glasses (`make sim`), whose own inputs do not press the display's buttons at 1.0.1 (`docs/findings.md`).
- **A change worth keeping goes to localred too.** `App/Glasses.swift` and `App/GlassesCard.swift` are adapted from
  localred's `app/Mobile/Glasses`; a fix to the toolkit's handling belongs in both.
- Gate: `make verify`. Conventional commits, no AI attribution.

The agent harness for this repo, its map, gate and logs (ADR 0019): @AGENTS.md
