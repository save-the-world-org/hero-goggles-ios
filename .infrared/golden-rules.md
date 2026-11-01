# Golden rules

The rules a reviewer checks first, each with its source. The full rules are in
`CLAUDE.md` and the workspace's `CLAUDE.md`; where this list and they disagree,
they win and this list is wrong.

1. **No account at Meta without the owner's word.** `MetaAppID` and
   `ClientToken` stay unset; an app in Meta's Wearables Developer Center is an
   account, with an `accounts/` entry in the workspace first. *(CLAUDE.md; the
   workspace's `CLAUDE.md`, Accounts and secrets)*
2. **Nothing personal or secret in a committed file.** A team ID, Meta's IDs and
   a client token live only in the git-ignored `Config/Signing.local.xcconfig`.
   *(CLAUDE.md; .gitignore)*
3. **The toolkit's analytics and crash reports stay opted out.**
   *(Config/Info.plist)*
4. **Say which half is proven.** A run on the simulator proves the drawing and
   the demo, never a press from the glasses; that needs a real pair and the
   person wearing it. *(.infrared/DECISIONS.md, 2026-11-01)*
5. **A fix to the toolkit's handling goes to localred too**
   (`app/Mobile/Glasses`), where Infrared's own use of the glasses lives.
   *(CLAUDE.md)*
