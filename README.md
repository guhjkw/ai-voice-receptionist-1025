# AI voice receptionist (portfolio demo)

An AI phone receptionist for an invented Phoenix heating, cooling and plumbing company, **Copper Mesa Air & Plumbing**. You can talk to it (microphone) or type to it. Every reply is computed live from what you say, so this is not a recording. It triages emergencies, books real times from the technician calendar, hands calls to a person when it should, and writes the call record.

**Live:** not deployed yet (deploy needs Taiwo's yes).

## What it does
| Piece | What the visitor sees | How it works (`src/receptionEngine.js`) |
|---|---|---|
| Greeting | Ava says she is an AI assistant, plus a recording notice | After-hours greeting when the office is closed; the recording notice is a setting |
| Understanding | "What Ava understood": intent, match strength, filled fields | Phone, ZIP, street address and name extraction (ZIP is never the house number, "this is urgent" is not a name), yes/no with "no problem" and "not sure", job type by longest keyword ("water heater" beats "heater", "AC is leaking" is not plumbing) |
| Emergencies | Safety steps first, then a person | Danger (gas, CO, smoke) is checked before anything else and ends in a live transfer. Negation is respected ("I don't smell gas" is not a gas call). Burst pipes and sewage are urgent: shut-off steps, then same-day times or the on-call page after hours |
| Heat triage | "Is anyone elderly, an infant, or unwell?" | Asked only for AC calls when today's high is at or above the heat rule. A yes makes it a heat priority: shorter lead time, owner alert, dispatcher flag if nothing is open today |
| Booking | Real windows drawn on the calendar, then the booked job | Trade match, shift and opening hours, drive time kept free before each job, Saturday short hours, Sunday closed, lead time; a job booked on an earlier call blocks the slot (no double-booking). "The earlier one", "the 4 o'clock", "tomorrow morning" and "neither" all work |
| Prices | Answers only from the price list | Diagnostic, after-hours, tune-up, drain and free estimates. Anything not on the list ("a new compressor", "a whole new AC unit") gets no guessed number |
| Hand-offs | Live transfer, on-call page or callback | Transfer to dispatch during hours (a setting); after hours a callback at the next opening; three misunderstood replies hand over to a person |
| After the call | Summary, text to the customer, owner alert, CRM record | Texts only with consent and only if text confirmations are on; STOP at any point is recorded; the CRM record carries contact, job, tags and notes |
| Call log | Today's calls with outcomes and metrics | Booked rate leaves sales calls out |

## Try it
Open the live link, or open `index.html` directly (it works off disk). Press **Start a call** and type what a caller would say, or play one of the six sample calls. Things to try:
- `I don't smell gas, but my heater won't light`
- a ZIP outside the area, like `85338`
- `how much is a new compressor?`
- `are you a robot?`
- `neither` when it offers two times
- the Sunday call time, or the heat rule in Rules

## Files
```
index.html               the page (built from index.src.html with the sample data embedded)
index.src.html           the page source
build.py                 builds index.html
src/receptionEngine.js   all the logic, loaded by the page and the tests
data/company.json        invented prices, area, crew, calendar, emergencies, FAQ, sample calls
tests/verify.js          engine checks (node)
tests/browser-check.py   Playwright checks that drive the real page
```

## Tests
```
node tests/verify.js            # 78 passed, 0 failed
python3 build.py && python3 tests/browser-check.py   # 44 passed, 0 failed
```
Saved runs: `tests/test-output.txt`, `tests/browser-output.txt`. Screenshots in `tests/`.

What the tests caught during the build:
- A hidden summary panel was covering the Start button, so a visitor could not start a call. It was a real page bug, now fixed.
- The calendar was stretching the page sideways on phones. It was a real layout bug; the calendar now scrolls inside its card.
- A second price question was being read as "yes, book me". It was a logic bug, now fixed.
- One test expected a 4 to 6 PM opening after a 3 PM booking. The test was wrong, not the engine: a 90-minute job plus 20 minutes of driving can't finish by 6 PM.

## Extend it
Prices, hours, zones, technicians, calendar, emergency wording and the FAQ all live in `data/company.json`. The rules (heat threshold, times offered, texts, live transfer, recording notice) are settings in the engine and in the page's Rules panel.

The delivered version:
- runs on a voice platform (Vapi or Retell) with a natural voice and a language model (Claude) behind the same rules;
- answers the client's own number;
- reads and writes their real calendar or field-service software and their CRM (HighLevel, HubSpot or theirs, through its API);
- sends texts through an A2P-registered number.

## Honest scope
- **Invented:** the company, prices, technicians, calendar, phone numbers and callers.
- **Not connected:** no real calls, texts or pages go out.
- **No API key needed:** Ava uses rules rather than a language model, and her voice is the browser's built-in voice.
- **Microphone:** the browser turns speech into text (Chrome uses Google's speech service); the page stores nothing.
- **Real:** the engine and the tests.
- **No client build** is shown or claimed.

Built by Taiwo, Pathfinder Automation Solutions.
