# Silent panel agents — real Teams test in the Yavar organisation

The first test of `docs/silent-panel-agent-plan.md` S0–S3 on a real Microsoft
Teams call, on the local stack: port 9000 (`ATSAgent-desk`, branch
`dev/combined`) and **one** `scripts/dev-agent-tick.ts` started from that same
folder (it fetches transcripts and runs the agents; restart it after any code
change).

Check where you are at any point:

```bash
cd /Users/yavar/Documents/CoE/ATSAgent-desk && bun --env-file=.env.local scripts/panel-teams-readiness.ts 88bc4140-f8d7-4a5e-8bcd-5343556d3cdf 1
```

## Where it stood (2026-10-31)

| Needed                                                              | State                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft sign-in app on the server                                 | set                                                                                                                               |
| Teams connected (madhu.r@yavar.ai) and the token refreshes          | yes                                                                                                                               |
| Teams can create meetings (`OnlineMeetings.ReadWrite`)              | yes                                                                                                                               |
| **Teams can read transcripts** (`OnlineMeetingTranscript.Read.All`) | **no** — step 1–3                                                                                                                 |
| **Teams switched on** in Integrations                               | **no** — step 3                                                                                                                   |
| **Silent panel agent on for L1** (Organisation)                     | **no** — step 2                                                                                                                   |
| **L1 panel agent on** (Agent settings)                              | **no** — step 4                                                                                                                   |
| AI model (Integrations → AI model)                                  | set                                                                                                                               |
| SMTP for the panel's summary                                        | set                                                                                                                               |
| Scheduler                                                           | restarted on the port-9000 code; the two old ticks from 29 Oct (run from `ATSAgent`, old code, silent for 14 h) should be stopped |

## Steps

1. **Microsoft admin (Entra).** On the platform's app registration (the one
   whose id is `MICROSOFT_OAUTH_CLIENT_ID`): _API permissions → Add → Microsoft
   Graph → Delegated → `OnlineMeetingTranscript.Read.All`_, then **Grant admin
   consent for Yavar**. In the _Teams admin centre → Meetings → Meeting
   policies_ (the policy that applies to madhu.r@yavar.ai): **Transcription on**
   (and Cloud recording on).
2. **Switch the agent on first.** As Madhu at `http://localhost:9000/organisation`
   → _Silent panel agent_ → on, tick **L1**, save. (The Teams sign-in asks for
   the transcript permission only while this is on.)
3. **Reconnect Teams.** _Integrations → Microsoft Teams_ → disconnect, connect
   again, accept the permissions (the transcript one included), switch Teams
   **on**, press _Test_. The Silent panel agent card should no longer say
   Teams "cannot read transcripts yet".
4. **Switch the L1 panel agent on.** _Agent settings → L1 panel agent_ → on,
   autonomy **Act and notify**, tick **Interview call summary (to the panel)**.
5. Re-run the readiness check: everything `yes` apart from the two `check`
   rows (the meeting policy, which it cannot see, and the scheduler line).
6. **Book an L1.** Use a test candidate whose e-mail is a plus-address of
   yours (e.g. `madhu.r+cand1@yavar.ai`) on a test role. _Interviews →
   Schedule_ L1, interviewer **madhu.r@yavar.ai**, add one panellist (e.g.
   `madhu.r+ml@yavar.ai`), mode **online**, provider **Microsoft Teams**, a
   time 10 minutes away, 15 minutes long.
   - Under the round: **Transcribed ·** with no warning when you hover. A
     warning (e.g. "could not be switched on automatically") is the first
     finding — note it.
   - The candidate's invite (your inbox) carries the transcription paragraph.
7. **Hold the call.** Join from two devices (one as the "candidate"). If Teams
   did not start recording/transcription by itself, start **transcription** from
   the meeting's _More_ menu — and note that it had to be started by hand. Talk
   for 5–10 minutes with real interview questions on the role's L1 competencies;
   for the protected-ground check, the panellist may ask one off-limits
   question ("are you planning a family?"). End the meeting.
8. **The transcript.** Within ~10–30 minutes of the end the round shows
   **Transcript in ·**. If it does not, ask Teams directly:

   ```bash
   bun --env-file=.env.local scripts/spike-transcripts.ts --interview <interview id>
   ```

   It prints pending / unavailable with Microsoft's reason, or the speakers and
   segment count. Hover the round for the stored reason; after 6 h it becomes
   **No transcript** and the health rule `panel.transcript_missing` fires.

9. **The agent.** Within a minute of the transcript: _Agent activity_ shows an
   **L1 panel agent** run (round read → assessed → summary sent) that never
   mentions a score; both panellists get the **Summary** e-mail (factual, no
   score).
10. **The panel scores**, from _My interviews_, each as themselves — choose the
    scores to test a case (the agent's view is hidden; ask the HR head to look
    after step 11 to see what it was):
    - **agree:** score as the call deserved — the candidate moves to L2 as
      always, no card;
    - **partial:** both select but 2 points below what you think the agent
      gave — the candidate moves to L2 _and_ a **Panel review** card appears;
    - **disagree:** the opposite verdict — the move is **held**, the desk
      thread says so, and the card appears.
11. **The HR head's card** (_Waiting for you_): both views side by side, how
    the round was run (coverage, talk time, any protected-ground question,
    quoted). Decide: go with the panel / put on hold / reject (with a reason).
    The stage changes as decided; _Audit_ shows `panel_review.decided`.

Repeat 6–11 for the other cases (a new candidate each time), then for L2 and
L3 (switch those rounds and agents on). Zoom and Meet follow the same steps
once their transcript access is in place (Zoom: the app's cloud-recording
scope and audio transcripts on the account; Meet: a Workspace edition with
transcripts and a reconnect).

## What to write down

- Did transcription start by itself (step 6–7), or by hand?
- Minutes from the call's end to _Transcript in_.
- Were the speakers labelled with names (talk time needs the candidate's name)?
- The agent's view against what you thought of the call (HR head, step 11).
- Anything in the summary e-mail that reads as a judgement.
