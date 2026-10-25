/*
 * tests/verify.js
 * Node tests for src/receptionEngine.js, the same file the page loads.
 * Run:  node tests/verify.js      (expects "0 failed" on the last line)
 */
'use strict';
const E = require('../src/receptionEngine.js');
const raw = require('../data/company.json');
const { data, problems } = E.prepare(raw);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const TUE = '2026-10-27T13:05';      // Tuesday, office open, 108°F
function call(now, callerId, cfg) { return E.startCall(data, { now: now || TUE, callerId: callerId || '(602) 555-0187', config: cfg }); }
function say(c, lines, ctx) { let r; for (const l of lines) r = E.respond(c, l, data, ctx || { extraBusy: [] }); return r; }
function lastAgent(c) { return c.turns.filter(t => t.who === 'agent').slice(-1)[0].text; }

console.log('1. Data check and time helpers');
check('sample data loads with no problems', problems.length === 0, problems);
const bad = E.prepare(Object.assign({}, raw, {
  technicians: raw.technicians.concat([{ id: 'tx', name: 'No Shift', trades: ['hvac'] }]),
  busy: raw.busy.concat([{ tech: 'nobody', day: 0, start: '09:00', end: '10:00' }, { tech: 't1', day: 0, start: '11:00', end: '10:00' }]),
  services: raw.services.concat([{ id: 'x', label: 'Bad', trade: 'roofing', minutes: 60, keywords: [] }])
}));
check('bad rows are skipped and reported, not crashed on', bad.problems.length === 4 && bad.data.technicians.length === 3 && bad.data.busy.length === raw.busy.length, bad.problems);
check('clock formats 14:30 as 2:30 PM and noon as 12 PM', E.clock(870) === '2:30 PM' && E.clock(720) === '12 PM' && E.clock(480) === '8 AM');
check('span merges AM/PM: "2 to 4 PM", "10 AM to 12 PM"', E.span(840, 960) === '2 to 4 PM' && E.span(600, 720) === '10 AM to 12 PM');
check('hours are read from the data', E.hoursText(data) === 'Monday to Friday 7 AM to 6 PM, and Saturday 8 AM to 2 PM', E.hoursText(data));
check('a bad call time is refused with a reason', (() => { try { E.startCall(data, { now: '27/10/2026 1pm' }); return false; } catch (e) { return /2026-10-27T13:05/.test(e.message); } })());

console.log('2. Understanding the caller');
check('phone numbers in any format', ['+1 (602) 555-0187', '602.555.0187', '6025550187', 'call me at 602 555 0187'].every(p => E.extractPhone(p) && E.extractPhone(p).text === '(602) 555-0187'));
check('a ZIP code is not read as a phone number', E.extractPhone('4127 East Copper Ridge Lane, 85018') === null);
check('street address with direction and suffix', E.extractAddress('it is 4127 e copper ridge ln in phoenix').text === '4127 E Copper Ridge Ln');
check('numbered streets keep their number: "1500 N 32nd St"', E.extractAddress('1500 N 32nd St, 85008').text === '1500 N 32nd St');
check('"2 kids in my way" is not an address', E.extractAddress('I have 2 kids in my way') === null);
const zipU = E.understand('4127 East Copper Ridge Lane, Phoenix, 85018', call(), data);
check('ZIP is the 5-digit number after the street, not the house number', zipU.entities.zip === '85018' && zipU.entities.street === '4127 East Copper Ridge Lane');
check('names: "my name is maria lopez" -> Maria Lopez', E.extractName('my name is maria lopez', false) === 'Maria Lopez');
check('names: "I\'m calling about my AC" is not a name', E.extractName("I'm calling about my AC", false) === null);
check('names: a bare reply counts only when the name was asked for', E.extractName('Maria Lopez.', true) === 'Maria Lopez' && E.extractName('Maria Lopez.', false) === null);
check('names: "this is urgent" is not a name', E.extractName('this is urgent', true) === null);
check('yes/no: "No texts, please" is a no, "no problem" is a yes, "not sure" is unsure', E.yesNo(E.norm('No texts, please')) === 'no' && E.yesNo('no problem') === 'yes' && E.yesNo('not sure') === 'unsure');

console.log('3. Which job it is');
const svc = t => (E.detectService(E.norm(t), data) || {}).id;
check('"water heater" beats "heater"', svc('my water heater is making noise') === 'water_heater');
check('"my AC is leaking water" goes to heating and cooling, not plumbing', svc('my AC is leaking water') === 'ac_repair');
check('"a whole new AC unit" is a new-system estimate', svc('roughly how much is a whole new AC unit') === 'estimate');
check('"the pipe under my sink is leaking" is a leak', svc('the pipe under my sink is leaking') === 'leak');
check('"I need a plumber" is a plumbing job with details to come', svc('I need a plumber') === 'plumbing_repair');
check('"the heat is unbearable" (weather) is not a heating repair', svc('the heat is unbearable today') === undefined);

console.log('4. Emergencies');
const em = t => E.detectEmergency(E.norm(t), data);
check('gas smell is danger', em('I think I smell gas near my water heater').level === 'danger');
check('"I don\'t smell gas" is NOT an emergency', em("I don't smell gas, but my heater won't light") === null);
check('"there\'s no gas smell" is NOT an emergency', em("there's no gas smell, it just won't turn on") === null);
check('carbon monoxide alarm is danger', em('the carbon monoxide alarm is going off').id === 'co');
check('burst pipe is urgent, not danger', em('a pipe burst in the garage').level === 'urgent');
check('danger outranks urgent when both are said', em('water everywhere and I smell gas').level === 'danger');

console.log('5. Calendar: real times only');
const c5 = call(TUE); c5.slots.service = 'ac_repair'; c5.slots.zone = 'phx';
const w5 = E.findWindows(data, c5, {}, { extraBusy: [] });
check('1:05 PM AC call in Phoenix: first windows are today 2-4 and 4-6 PM', w5.length === 2 && w5[0].label === 'today between 2 and 4 PM' && w5[1].label === 'today between 4 and 6 PM', w5.map(w => w.label));
check('Marco arrives 3 PM, not 2:30: his 2:30 PM job ends in Scottsdale and drive time is kept free', w5[0].techName === 'Marco' && w5[0].arrive === 900, w5[0]);
check('the noon window is skipped: Marco is busy and Luis cannot fit before his 3 PM job', !w5.some(w => w.start === 720));
const c5b = call(TUE); c5b.slots.service = 'ac_repair'; c5b.slots.zone = 'phx'; c5b.urgency = 'priority';
check('priority calls use the shorter lead time (30 min) but never a fake slot', E.findWindows(data, c5b, {}, { extraBusy: [] })[0].arrive === 900);
const ctx5 = { extraBusy: [{ tech: 't1', day: 0, start: '15:00', end: '16:30', zone: 'phx' }] };
const w5c = E.findWindows(data, c5, {}, ctx5);
check('a job booked on an earlier call blocks that time (no double-booking): the rest of today cannot fit a 90-minute job plus drive time, so the next offers are tomorrow', !w5c.some(w => w.day === 0) && w5c[0].day === 1, w5c.map(w => [w.label, w.arrive]));
const sat = call('2026-10-31T21:40'); sat.slots.service = 'drain'; sat.slots.zone = 'mesa';
const wsat = E.findWindows(data, sat, {}, { extraBusy: [] });
check('Saturday 9:40 PM: nothing tonight, nothing Sunday (closed), first times Monday', wsat[0].dayLabel === 'Monday', wsat.map(w => w.label));
const satAm = call('2026-10-31T07:30'); satAm.slots.service = 'leak'; satAm.slots.zone = 'phx';
check('Saturday hours end at 2 PM, so no Saturday window runs past it', E.findWindows(data, satAm, { count: 6 }, { extraBusy: [] }).filter(w => w.day === 0).every(w => w.end <= 840));
const satDay = E.busyOn(data, satAm, 0, { extraBusy: [] });
check('Saturday calendar only holds jobs inside Saturday hours (8 AM to 2 PM)', satDay.length > 0 && satDay.every(b => b.end <= '14:00'), satDay.map(b => b.start + '-' + b.end));
const plumb = call(TUE); plumb.slots.service = 'drain'; plumb.slots.zone = 'tempe';
check('plumbing jobs only go to technicians with the plumbing trade', E.findWindows(data, plumb, { count: 4 }, { extraBusy: [] }).every(w => w.techName !== 'Marco'));

console.log('6. The six sample calls (the same scripts the page plays)');
for (const s of data.samples) {
  const r = E.runScript(data, s, { extraBusy: [] });
  check('sample "' + s.id + '" ends as ' + s.expect.outcome + ' / ' + s.expect.urgency, r.summary.outcome === s.expect.outcome && r.summary.urgency === s.expect.urgency, [r.summary.outcome, r.summary.urgency, lastAgent(r.call)]);
}
const heat = E.runScript(data, data.samples[0], { extraBusy: [] });
check('heat call: asks about vulnerable people because it is 108°F', /elderly, an infant, or unwell/.test(heat.call.turns[2].text));
check('heat call: books Marco today 2 to 4 PM and texts only after a yes', heat.summary.appointment.tech === 'Marco' && heat.summary.appointment.label === 'today, 2 to 4 PM' && /Reply STOP/.test(heat.summary.sms));
check('heat call: owner alert carries the address, indoor temperature and booking', /HEAT PRIORITY/.test(heat.summary.ownerAlert) && /85018/.test(heat.summary.ownerAlert) && /90°F inside/.test(heat.summary.ownerAlert));
const gas = E.runScript(data, data.samples[1], { extraBusy: [] });
check('gas call: safety steps come before anything else, then a live transfer', /^Please leave the house right now/.test(lastAgent(gas.call)) && gas.call.transfer.to === 'oncall' && gas.call.turns.length === 3);
const price = E.runScript(data, data.samples[2], { extraBusy: [] });
check('price call: the $89 answer comes from the price list', /\$89/.test(price.call.turns[2].text));
check('price call: no guessed price for a new system', /I can't give a price for a new system/.test(price.call.turns[4].text) && !/\$\d/.test(price.call.turns[4].text.replace('$', '')) );
check('price call: "tomorrow morning" finds the one real morning opening', /Tomorrow morning I have one time: between 10 AM and 12 PM/.test(price.call.turns[14].text), price.call.turns[14].text);
check('price call: "No texts, please" means no SMS is prepared', price.summary.sms === null && price.summary.consent === false);
const pipe = E.runScript(data, data.samples[3], { extraBusy: [] });
check('burst pipe after hours: shut-off steps, then the on-call page with name, address and number', /shut off the main valve/.test(pipe.call.turns[2].text) && /ON-CALL PAGE/.test(pipe.summary.ownerAlert) && /85209/.test(pipe.summary.ownerAlert));
const spam = E.runScript(data, data.samples[4], { extraBusy: [] });
check('sales call: ended politely with no owner alert', spam.summary.outcome === 'spam' && spam.summary.ownerAlert === null);
const human = E.runScript(data, data.samples[5], { extraBusy: [] });
check('"am I talking to a robot?" gets an honest yes', /^Yes, I'm Copper Mesa's AI assistant/.test(human.call.turns[2].text));

console.log('7. Interruptions and guardrails');
const c7 = call(TUE);
say(c7, ['My water heater stopped working', 'Do you offer financing?']);
check('a question in the middle is answered, then the open question is asked again', /financing is available/.test(lastAgent(c7)) && /Can I get your name\?$/.test(lastAgent(c7)), lastAgent(c7));
const c7b = call(TUE);
say(c7b, ['my drain is clogged', 'Dana Price']);
check('a caller named "Price" is a name, not a price question', c7b.slots.name === 'Dana Price' && /address/.test(lastAgent(c7b)), lastAgent(c7b));
const c7c = call(TUE);
say(c7c, ['my toilet is clogged', 'Ana Ruiz', '1200 West Elm Street, Goodyear, 85338']);
check('outside the service area: says so and books nothing', /85338 is outside our service area/.test(lastAgent(c7c)) && c7c.pending === 'address_retry' && !c7c.offers.length);
say(c7c, ['no']);
check('...and ends as "outside service area" when there is no other address', c7c.ended && c7c.outcome === 'out_of_area');
const c7d = call(TUE);
say(c7d, ['blah', 'hmm', 'qwerty']);
check('three misunderstood replies hand the call to a person during hours', c7d.ended && c7d.outcome === 'transferred' && c7d.transfer.why === 'clarify');
const c7e = call('2026-10-27T20:15');
say(c7e, ['can I speak to a real person', 'Tom Baker', 'yes']);
check('a person after hours: callback from the office at opening time instead of a dead end', c7e.outcome === 'callback' && /tomorrow at 7 AM/.test(c7e.callback.when), c7e.callback);
const c7f = call(TUE);
const r7f = E.respond(c7f, '   ', data, {});
check('an empty reply is refused with a reason and not counted', r7f.ok === false && /Say or type/.test(r7f.error) && c7f.turns.length === 1);
const c7g = call(TUE);
const r7g = E.respond(c7g, 'my AC is broken ' + 'please help '.repeat(60), data, { extraBusy: [] });
check('a very long reply is trimmed and noted', r7g.ok && r7g.guardrails.some(g => /Very long input/.test(g)));
const r7h = E.respond(spam.call, 'hello?', data, {});
check('a call that has ended refuses more input', r7h.ok === false && /ended/.test(r7h.error));
const c7i = call(TUE);
say(c7i, ['my AC is out', 'no', 'Lee Chan', '300 South Mill Avenue, Tempe 85281', 'yes', 'the second one', 'STOP']);
check('STOP at the consent question records the opt-out', c7i.slots.consent === false && E.summarize(c7i, data).sms === null);
const c7j = call(TUE);
say(c7j, ['my AC is out', 'no', 'Lee Chan', '300 South Mill Avenue, Tempe 85281', 'yes']);
const before = c7j.offers.map(o => o.key).join();
say(c7j, ['neither of those work']);
check('"neither" offers the next real times instead of repeating', c7j.offers.length && c7j.offers.map(o => o.key).join() !== before, [before, c7j.offers.map(o => o.key)]);
const c7k = call(TUE);
say(c7k, ['my AC is out', 'no', 'Lee Chan', '300 South Mill Avenue, Tempe 85281', 'yes', "the 4 o'clock one"]);
check('"the 4 o\'clock one" picks the 4 to 6 PM window', c7k.booked && c7k.booked.start === 960, c7k.booked);
const c7l = call(TUE);
say(c7l, ['my AC is out', 'wait, is this a robot?']);
check('"is this a robot?" mid-call: honest answer, then back to the question', /AI assistant/.test(lastAgent(c7l)) && /elderly, an infant, or unwell\?$/.test(lastAgent(c7l)), lastAgent(c7l));

console.log('8. Tunable rules (the paid build is set up the way you work)');
const cool = call(TUE, null, { heatPriorityF: 110 });
say(cool, ['my AC is out']);
check('raise the heat threshold to 110°F: no heat triage question at 108°F', /Can I get your name\?/.test(lastAgent(cool)) && !/elderly/.test(lastAgent(cool)));
const noText = call(TUE, null, { offerTexts: false });
say(noText, ['my drain is clogged', 'Ana Ruiz', '1200 West Elm Street, Tempe 85282', 'yes', 'the first one']);
check('turn texts off: no consent question and no SMS', !/text you/.test(noText.turns.map(t => t.text).join(' ')) && noText.confirmed && E.summarize(noText, data).sms === null);
const three = call('2026-10-28T08:00', null, { offerCount: 3 });
say(three, ['I need an AC tune-up', 'Rob Diaz', '77 East Oak Street, Phoenix 85004', 'yes']);
check('offer three times instead of two', three.offers.length === 3, three.offers.map(o => o.label));
const noXfer = call(TUE, null, { transferDuringHours: false });
say(noXfer, ['I want to talk to a human']);
check('live transfer off: a callback within the hour instead', noXfer.mode === 'callback' && /within the hour/.test(lastAgent(noXfer)));
const noRec = call(TUE, null, { recordingNotice: false });
check('recording notice can be switched off', !/recorded/.test(noRec.turns[0].text) && /AI assistant/.test(noRec.turns[0].text));

console.log('9. After the call');
const log = E.callLog(data.samples.map(s => E.runScript(data, s, { extraBusy: [] }).summary));
check('call log counts outcomes', log.calls === 6 && log.booked === 2 && log.emergencies === 2 && log.spam === 1 && log.afterHours === 2, log);
check('booked rate leaves spam out (2 of 5 real calls = 40%)', log.bookedRate === 40, log.bookedRate);
check('CRM record has the contact, job, consent and tags', heat.summary.crm.contact.name === 'Maria Lopez' && heat.summary.crm.job.technician === 'Marco' && heat.summary.crm.contact.smsConsent === true && heat.summary.crm.tags.indexOf('heat-priority') >= 0);
check('speech version reads phone numbers and ZIP codes digit by digit', E.toSpeech('Is (602) 555-0187 right? ZIP 85018, $89.') === 'Is 6 0 2, 5 5 5, 0 1 8 7 right? ZIP 8 5 0 1 8, 89 dollars.', E.toSpeech('Is (602) 555-0187 right? ZIP 85018, $89.'));
check('every reply in the samples is free of em dashes', data.samples.every(s => E.runScript(data, s, { extraBusy: [] }).call.turns.every(t => !/—/.test(t.text))));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
