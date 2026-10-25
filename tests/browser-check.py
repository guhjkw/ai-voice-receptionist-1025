"""
tests/browser-check.py
Playwright checks that drive the real page (index.html), which loads the same src/receptionEngine.js
that tests/verify.js tests. Voice is switched off (?voice=0) and sample playback is sped up (?fast=1).
Run:  python3 tests/browser-check.py      (expects "0 failed" on the last line)
"""
import functools, http.server, pathlib, threading
from html.parser import HTMLParser
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
passed = failed = 0
def check(name, cond, detail=None):
    global passed, failed
    if cond: passed += 1; print(f"PASS: {name}")
    else: failed += 1; print(f"FAIL: {name}" + (f"  -> {detail}" if detail is not None else ""))

class Balance(HTMLParser):
    VOID = {"meta", "link", "br", "input", "img", "hr", "source", "wbr", "col", "path", "rect", "circle", "stop", "polyline", "line"}
    def __init__(self): super().__init__(); self.stack, self.errors = [], []
    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID: self.stack.append(tag)
    def handle_startendtag(self, tag, attrs): pass
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack or self.stack[-1] != tag: self.errors.append(f"unexpected </{tag}> open {self.stack[-3:]}")
        else: self.stack.pop()

print("0. HTML tag balance")
b = Balance(); b.feed((ROOT / "index.html").read_text())
check("all tags closed and nested", not b.errors and not b.stack, b.errors[:3] or b.stack[-3:])

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)); handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/index.html?voice=0&fast=1"
problems = []

def last_agent(pg):
    return pg.locator("#transcript .msg.agent .b").last.text_content().strip()
def say(pg, text, wait=160):
    pg.fill("#input", text); pg.press("#input", "Enter"); pg.wait_for_timeout(wait)
def field(pg, k):
    return pg.locator(f'#fields .f[data-f="{k}"] .v').text_content().strip()

with sync_playwright() as pw:
    br = pw.chromium.launch()
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    pg.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: problems.append(str(e)))
    pg.goto(url); pg.wait_for_function("document.querySelectorAll('#samples .sbtn').length === 6")

    print("1. Page loads")
    check("six sample calls are listed", pg.locator("#samples .sbtn").count() == 6)
    check("calendar shows three technicians with today's jobs", pg.locator("#cal .trow").count() == 3 and pg.locator("#cal .blk").count() >= 6)
    check("call log is seeded with today's earlier calls", pg.locator("#logBody tr").count() == 5)
    check("input is locked until a call starts", pg.locator("#input").is_disabled())
    check("data check reports 0 skipped rows", "0 rows skipped" in pg.locator("#dataCheck").text_content())
    pg.screenshot(path=str(TESTS / "screenshot-hero.png"))

    print("2. A full call typed by the visitor")
    pg.click("#startBtn"); pg.wait_for_timeout(150)
    check("greeting says it is an AI assistant", "the AI assistant" in last_agent(pg))
    check("status shows the call is live", pg.locator("#status").text_content().strip() == "Live")
    say(pg, "My AC stopped working and it's blowing warm air")
    check("job is understood as AC repair", field(pg, "service") == "AC repair")
    check("intent chip shows a service request", "Service request" in pg.locator("#intent").text_content())
    check("heat triage question is asked at 108°F", "elderly, an infant, or unwell" in last_agent(pg))
    say(pg, "no, it's just me")
    say(pg, "Maria Lopez")
    check("name field fills in", field(pg, "name") == "Maria Lopez")
    say(pg, "4127 East Copper Ridge Lane, Phoenix 85018")
    check("address and area fill in", field(pg, "street") == "4127 East Copper Ridge Lane" and field(pg, "zip") == "85018 · Phoenix")
    say(pg, "yes")
    check("two real windows are offered and drawn on the calendar", pg.locator("#cal .offer").count() == 2 and "Which works better?" in last_agent(pg), last_agent(pg))
    pg.locator("#brain").screenshot(path=str(TESTS / "screenshot-understood.png"))
    before = pg.locator("#cal .blk.booked").count()
    say(pg, "the second one")
    check("choosing a window books it on the calendar", pg.locator("#cal .blk.booked").count() == before + 1 and field(pg, "appt").startswith("Today 4 to 6 PM"), field(pg, "appt"))
    check("guardrail list explains the booking", "no double-booking" in pg.locator("#guards").text_content())
    say(pg, "sure")
    check("consent is recorded before any text", field(pg, "consent") == "Yes")
    say(pg, "no that's everything", 400)
    check("call ends with a summary card", pg.locator("#summary.show").count() == 1 and pg.locator("#sumHead").text_content().startswith("Booked: AC repair"))
    check("text to the customer is prepared because they said yes", "Reply STOP" in pg.locator("#smsOut").text_content())
    check("CRM record is attached", '"source": "Phone (AI receptionist)"' in pg.locator("#crmOut").text_content())
    pg.locator("#phone").screenshot(path=str(TESTS / "screenshot-summary.png"))
    check("call log gains a new row at the top", pg.locator("#logBody tr").count() == 6 and "from this page" in pg.locator("#logBody tr").first.text_content())
    check("metrics count the new call", pg.locator("#metrics .metric b").first.text_content() == "6")
    check("input locks after the call ends", pg.locator("#input").is_disabled())

    print("3. Invalid input is refused with a reason")
    pg.click("#summary [data-start]"); pg.wait_for_timeout(120)
    n = pg.locator("#transcript .msg").count()
    pg.fill("#input", "   "); pg.press("#input", "Enter"); pg.wait_for_timeout(100)
    check("an empty reply shows a reason and adds nothing", "Say or type" in pg.locator("#err").text_content() and pg.locator("#transcript .msg").count() == n)

    print("4. Guardrails")
    say(pg, "my drain is clogged"); say(pg, "Ana Ruiz"); say(pg, "1200 West Elm Street, Goodyear 85338")
    check("outside ZIP: area field turns red and nothing is offered", "outside area" in field(pg, "zip") and pg.locator("#cal .offer").count() == 0)
    check("outside ZIP: guardrail is listed", "Outside the service area" in pg.locator("#guards").text_content())
    pg.click("[data-start] >> nth=0"); pg.wait_for_timeout(100)
    say(pg, "I don't smell gas but my heater won't light")
    check("'I don't smell gas' is not treated as a gas emergency", field(pg, "service") == "Heating repair" and "leave the house" not in last_agent(pg))
    say(pg, "how much is a new compressor?")
    check("no made-up price for a compressor", "so I won't guess" in last_agent(pg))
    say(pg, "are you a robot?")
    check("honest answer when asked if it is AI", "AI assistant" in last_agent(pg))

    print("5. Sample calls play through the same engine")
    pg.click('#samples [data-sample="gas"]')
    pg.wait_for_function("document.querySelector('#summary.show') !== null", timeout=8000)
    check("gas sample: safety steps first", last_agent(pg).startswith("Please leave the house right now"))
    check("gas sample: ends as an emergency transfer", "Emergency, transferred" in pg.locator("#summary .badge").first.text_content())
    check("gas sample: owner alert is raised", "EMERGENCY" in pg.locator("#alertOut").text_content())
    pg.click('#samples [data-sample="price"]')
    pg.wait_for_function("document.querySelector('#summary.show') !== null", timeout=12000)
    txt = pg.locator("#transcript").text_content()
    check("price sample: never guesses a system price", "I can't give a price for a new system" in txt)
    check("price sample: books the real tomorrow-morning opening", "Tomorrow morning I have one time" in txt and pg.locator("#sumHead").text_content().startswith("Booked: New system estimate"))
    check("price sample: the call-time menu shows the sample's own time (Tue 10:20 AM)", pg.locator('#callTime option:checked').text_content().strip() == 'Tue 10:20 AM')
    check("price sample: 'No texts, please' means no text is prepared", "the caller said no" in pg.locator("#smsOut").text_content())
    pg.click('#samples [data-sample="pipe"]')
    pg.wait_for_function("document.querySelector('#summary.show') !== null", timeout=8000)
    check("burst pipe sample: on-call page after hours", "On-call dispatched" in pg.locator("#summary .badge").first.text_content())

    print("6. Rules change the behaviour")
    pg.locator("#rHeat").fill("110"); pg.locator("#rHeat").dispatch_event("input")
    pg.click("#startBtn"); pg.wait_for_timeout(100)
    say(pg, "my AC is out")
    check("heat rule at 110°F: no heat triage question at 108°F", "Can I get your name?" in last_agent(pg) and "elderly" not in last_agent(pg), last_agent(pg))
    pg.locator("#rHeat").fill("100"); pg.locator("#rHeat").dispatch_event("input")
    pg.select_option("#callTime", "2026-10-31T21:40")
    pg.click("#startBtn"); pg.wait_for_timeout(100)
    check("Saturday 9:40 PM: greeting says the office is closed", "office is closed" in last_agent(pg))
    say(pg, "can I talk to a real person")
    check("a person after hours becomes a callback, not a dead end", "call back" in last_agent(pg))

    print("7. Phone layout")
    mob = br.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    mob.on("pageerror", lambda e: problems.append(str(e)))
    mob.goto(url); mob.wait_for_function("document.querySelectorAll('#samples .sbtn').length === 6")
    check("no sideways scrolling on a phone", mob.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1)
    fits = mob.evaluate("Math.max(...[...document.querySelectorAll('#phone, #brain, #calendar, .sbtn, .tier, .metric')].map(e => e.getBoundingClientRect().right)) <= window.innerWidth + 1")
    check("phone, panels, samples and prices fit the screen", fits)
    mob.click("#startBtn"); mob.wait_for_timeout(100)
    mob.fill("#input", "my water heater is leaking"); mob.press("#input", "Enter"); mob.wait_for_timeout(200)
    check("a call works on a phone", "Can I get your name?" in mob.locator("#transcript .msg.agent .b").last.text_content())
    mob.locator("#phone").screenshot(path=str(TESTS / "screenshot-mobile.png"))
    pg.screenshot(path=str(TESTS / "screenshot-full.png"), full_page=True)
    br.close()

check("no console or page errors", not problems, problems[:5])
print(f"\n{passed} passed, {failed} failed")
