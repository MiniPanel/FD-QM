CDAX Follow-up Bot v1.12.0 - update from v1.11.0
================================================
INSTALL ONE STEP AT A TIME (keeps existing cases, follow-up counts, history and settings)
1. Dashboard -> "Export backup". Keep the JSON file.
2. Open the CURRENT extension folder already loaded in Chrome. Do not create or load a different folder.
3. Copy all 6 files from this package into that folder, replacing files with the same names:
   background.js, cdax.js, dashboard.js, dashboard.html, dashboard.css, manifest.json
4. chrome://extensions -> "Reload" on CDAX Follow-up Bot. Do NOT click Remove.
5. Refresh the CDAX tab (F5), open the dashboard, confirm the header shows v1.12.0.
6. Confirm your cases, History and settings are still there.

WHAT CHANGED
1. TWO follow-ups instead of three
   - Email 1 = the standard first follow-up (unchanged).
   - Email 2 = the closing notice (the wording that used to be email 3: "...we will temporarily close
     your support case"). The old second email ("please reply within 24 hours") is no longer sent.
   - Subject tag is now [Follow-up 1/2] / [Follow-up 2/2]. Progress shows 1/2 and 2/2.
   - Chat-disconnected emails (non-WhatsApp channels) are also sent twice.
   - The moment email 2 is sent the case becomes READY FOR CLOSURE (no extra 24-hour wait).
   - Edit email templates now has 2 emails. If custom templates were saved earlier (3 emails), the bot keeps
     your email 1 and your final email.
2. Ready-for-closure cases keep being watched for a customer reply until the case is closed in CDAX
   - A customer email reply, a new chat/call, or a WhatsApp message moves the case to Customer responded /
     New chat-call (the case is not removed from the queue a second time).
   - Checked at most every 2 minutes per case. Stops when the case is closed/cancelled in CDAX.
   - A temporary connection error on a Ready case never turns it into an Error.
   - If email 2 itself fails to deliver in CDAX the case shows Error instead of Ready for closure.
3. Cases already running when you install
   - Still being followed up at 1 of 3 -> become 1 of 2; their next email is the closing notice at the due
     time they already have, then Ready for closure.
   - Already sent 2 or 3 emails (and were still active) -> Ready for closure now, no extra email, and removed
     from the queue (if "Remove finished cases from the queue" is ticked).
   - Paused cases stay paused; when resumed with all emails already sent they become Ready for closure.
   - Cases that had already finished (responded, new chat/call, ready, removed, stopped) keep their old
     progress (for example 1/3) and are not touched. Legacy "Ready for closure" cases are now also watched.
4. "In queue" shows only cases still being followed up (active, paused, conversation active, waiting, no email,
   error). Finished cases appear only under their own button.
5. New "Removed from queue" status and button (grey) for cases an agent takes out of the queue; they used to
   show as a red "Stopped". "Stopped / error" now counts only real stops (agent stop, case closed) and errors.
   Existing "Stopped - removed from queue" cases are converted automatically, also in History.
6. Number badges on the status buttons: a red number = cases that joined that group since you last looked.
   It clears when you open that button's list (while this page is visible) and returns when newer cases
   arrive. Remembered per queue on this computer; not shared between people. No badge on "All cases".
   Nothing shows as new the first time you open this version.

UNCHANGED
   WhatsApp 24-hour handling, new chat/call stop, email reply detection, history, backup/restore,
   queue removal of finished cases, Dynamic Notes, per-case timing, case-owner signature.
