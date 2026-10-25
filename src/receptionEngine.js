/*
 * src/receptionEngine.js
 * The logic behind the AI voice receptionist demo: what the caller said, emergency triage,
 * booking from the technician calendar, guardrails, and the record written after the call.
 * The page (index.html) and the tests (tests/verify.js) load this same file.
 *
 * Rule-based on purpose, so the demo runs with no API key. A delivered build puts a voice
 * platform (Vapi or Retell) and a language model (Claude) behind these same rules.
 *
 * Times are wall-clock times for the business, computed in UTC so the results never depend
 * on the visitor's own time zone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReceptionEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tunable rules. data.config overrides these; the page's Rules panel overrides data.config.
  var DEFAULTS = {
    heatPriorityF: 100,      // heat triage starts at this outdoor high (°F)
    offerCount: 2,           // appointment windows offered at once
    offerTexts: true,        // ask for consent to text a confirmation (never texts without it)
    transferDuringHours: true,
    recordingNotice: true,
    maxClarify: 2,           // misunderstood replies before a person takes over
    leadMinutes: 60,         // earliest same-day arrival, normal calls
    priorityLeadMinutes: 30, // earliest same-day arrival, heat priority and urgent calls
    onCallCallbackMinutes: 15,
    stepMinutes: 15,
    daysAhead: 7,
    maxInput: 400
  };

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var OUTCOMES = {
    booked: 'Booked',
    emergency_transfer: 'Emergency, transferred',
    oncall_dispatch: 'On-call dispatched',
    transferred: 'Transferred to a person',
    callback: 'Callback set',
    out_of_area: 'Outside service area',
    spam: 'Spam ended',
    info: 'Questions answered',
    abandoned: 'Ended early'
  };

  // ---------------------------------------------------------------- data check
  // Skips bad rows and reports them instead of crashing.
  function prepare(raw) {
    var problems = [];
    var d = JSON.parse(JSON.stringify(raw || {}));
    function okTime(t) { return /^\d{2}:\d{2}$/.test(String(t)); }
    d.services = (d.services || []).filter(function (s, i) {
      var ok = s && s.id && s.label && (s.trade === 'hvac' || s.trade === 'plumbing') && s.minutes > 0 && Array.isArray(s.keywords);
      if (!ok) problems.push('Service row ' + (i + 1) + ' skipped: needs id, label, trade (hvac or plumbing), minutes and keywords');
      return ok;
    });
    d.technicians = (d.technicians || []).filter(function (t, i) {
      var ok = t && t.id && t.name && Array.isArray(t.trades) && t.trades.length && t.shift && okTime(t.shift[0]) && okTime(t.shift[1]);
      if (!ok) problems.push('Technician row ' + (i + 1) + ' skipped: needs id, name, trades and a shift like ["08:00","18:00"]');
      return ok;
    });
    var techIds = d.technicians.map(function (t) { return t.id; });
    d.busy = (d.busy || []).filter(function (b, i) {
      var ok = b && techIds.indexOf(b.tech) >= 0 && b.day >= 0 && okTime(b.start) && okTime(b.end) && hm(b.end) > hm(b.start);
      if (!ok) problems.push('Calendar row ' + (i + 1) + ' skipped: unknown technician or bad times');
      return ok;
    });
    d.zones = (d.zones || []).filter(function (z, i) {
      var ok = z && z.id && z.name && z.travel >= 0 && (Array.isArray(z.zips) || Array.isArray(z.prefixes));
      if (!ok) problems.push('Zone row ' + (i + 1) + ' skipped: needs id, name, travel and zips or prefixes');
      return ok;
    });
    d.emergencies = (d.emergencies || []).filter(function (e, i) {
      var ok = e && e.id && (e.level === 'danger' || e.level === 'urgent') && Array.isArray(e.keywords) && e.script;
      if (!ok) problems.push('Emergency row ' + (i + 1) + ' skipped: needs id, level (danger or urgent), keywords and a script');
      return ok;
    });
    d.faq = (d.faq || []).filter(function (f, i) {
      var ok = f && Array.isArray(f.keywords) && f.answer;
      if (!ok) problems.push('FAQ row ' + (i + 1) + ' skipped: needs keywords and an answer');
      return ok;
    });
    d.windowStarts = (d.windowStarts || []).filter(okTime);
    d.windowMinutes = d.windowMinutes > 0 ? d.windowMinutes : 120;
    d.hours = d.hours || {};
    d.weather = d.weather || { todayHighF: 0 };
    d.prices = d.prices || {};
    d.company = d.company || {};
    return { data: d, problems: problems };
  }

  // ---------------------------------------------------------------- time
  function hm(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function parseNow(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(dt.getTime()) || +m[4] > 23 || +m[5] > 59) return null;
    return { iso: iso, weekday: dt.getUTCDay(), minutes: (+m[4]) * 60 + (+m[5]), date: m[1] + '-' + m[2] + '-' + m[3], dateMs: dt.getTime() };
  }
  function clock(min) {
    var h = Math.floor(min / 60) % 24, m = min % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ap;
  }
  function span(a, b) {
    var A = clock(a), B = clock(b);
    return A.slice(-2) === B.slice(-2) ? A.slice(0, -3) + ' to ' + B : A + ' to ' + B;
  }
  function hoursFor(data, weekday) {
    var h = data.hours[String(weekday)];
    return h && h.length === 2 ? [hm(h[0]), hm(h[1])] : null;
  }
  function isOpen(data, when) {
    var h = hoursFor(data, when.weekday);
    return !!h && when.minutes >= h[0] && when.minutes < h[1];
  }
  function dayName(call, d) { return d === 0 ? 'today' : d === 1 ? 'tomorrow' : DAYS[(call.when.weekday + d) % 7]; }
  function dateFor(call, d) { return new Date(call.when.dateMs + d * 86400000).toISOString().slice(0, 10); }
  function partOf(min) { return min < 720 ? 'morning' : min < 1020 ? 'afternoon' : 'evening'; }
  function hoursText(data) {
    var groups = [], i, h, key;
    for (i = 1; i <= 7; i++) {
      var wd = i % 7; h = data.hours[String(wd)];
      key = h ? h.join('-') : 'closed';
      var last = groups[groups.length - 1];
      if (last && last.key === key) last.to = wd; else groups.push({ key: key, from: wd, to: wd, h: h });
    }
    return groups.filter(function (g) { return g.h; }).map(function (g) {
      var days = g.from === g.to ? DAYS[g.from] : DAYS[g.from] + ' to ' + DAYS[g.to];
      return days + ' ' + clock(hm(g.h[0])) + ' to ' + clock(hm(g.h[1]));
    }).join(', and ');
  }
  function nextOpening(data, call) {
    for (var d = 0; d <= 7; d++) {
      var h = hoursFor(data, (call.when.weekday + d) % 7);
      if (!h) continue;
      if (d === 0 && call.when.minutes >= h[0]) continue;
      return { day: d, minutes: h[0], label: (d === 0 ? 'this morning' : dayName(call, d)) + ' at ' + clock(h[0]) };
    }
    return null;
  }

  // ---------------------------------------------------------------- text helpers
  function norm(t) {
    return String(t == null ? '' : t).toLowerCase()
      .replace(/[‘’ʼ`]/g, "'")
      .replace(/[^a-z0-9'\/ ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  function findKw(n, kw) {
    var re = new RegExp('(^|[^a-z0-9])' + esc(kw) + '(?=$|[^a-z0-9])');
    var m = re.exec(n);
    return m ? m.index + m[1].length : -1;
  }
  function anyKw(n, list) { for (var i = 0; i < list.length; i++) if (findKw(n, list[i]) >= 0) return list[i]; return null; }
  function countKw(n, list) { var c = 0; for (var i = 0; i < list.length; i++) if (findKw(n, list[i]) >= 0) c++; return c; }
  // a keyword that is not negated just before it ("I don't smell gas" is not a gas emergency)
  var NEG_TAIL = /\b(no|not|don't|dont|doesn't|doesnt|didn't|didnt|never|without|isn't|isnt|aren't|arent|nothing like)\s+(?:[a-z']+\s+){0,3}$/;
  function hasPos(n, kw) {
    var i = findKw(n, kw);
    if (i < 0) return false;
    return !NEG_TAIL.test(n.slice(Math.max(0, i - 40), i));
  }
  function title(s) {
    return String(s).toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); }).replace(/\b(Ii|Iii|Iv)\b/g, function (w) { return w.toUpperCase(); });
  }
  function stripCompany(raw, data) {
    var short = (data.company && data.company.short) || '';
    if (!short) return raw;
    var re = new RegExp(esc(short).replace(/\\? /g, '\\s+') + '(?:\\s+air)?(?:\\s+(?:and|&)\\s+plumbing)?', 'gi');
    return String(raw).replace(re, ' ');
  }
  function digits(s) { return String(s).split('').join(' '); }
  // A version of a reply that text-to-speech reads naturally (phone numbers and ZIP codes digit by digit).
  function toSpeech(t) {
    return String(t || '')
      .replace(/\((\d{3})\)\s?(\d{3})-(\d{4})/g, function (_, a, b, c) { return digits(a) + ', ' + digits(b) + ', ' + digits(c); })
      .replace(/\$(\d+)/g, '$1 dollars')
      .replace(/\b(\d{5})\b/g, function (_, z) { return digits(z); })
      .replace(/\b(\d{2})(\d{2})(?= (?:North|South|East|West|N|S|E|W)\b)/g, '$1 $2')
      .replace(/°F/g, ' degrees');
  }

  // ---------------------------------------------------------------- entities
  var PHONE_RE = /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]*([2-9]\d{2})[\s.\-]*(\d{4})(?!\d)/;
  function extractPhone(raw) {
    var m = PHONE_RE.exec(String(raw || ''));
    if (!m) return null;
    return { text: '(' + m[1] + ') ' + m[2] + '-' + m[3], index: m.index, length: m[0].length };
  }
  function normalisePhone(p) { var x = extractPhone(p); return x ? x.text : null; }

  var SUFFIX = 'street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|place|pl|circle|cir|parkway|pkwy|trail|trl|terrace|ter|loop|run|path|highway|hwy';
  var ADDR_RE = new RegExp('\\b(\\d{2,6})\\s+((?:[A-Za-z0-9\'.]+\\s+){1,5}?)(' + SUFFIX + ')\\b\\.?', 'i');
  function extractAddress(raw) {
    var m = ADDR_RE.exec(String(raw || ''));
    if (!m) return null;
    var words = m[2].trim().split(/\s+/).map(function (w) { return /^\d/.test(w) ? w.toLowerCase() : title(w); });
    return { text: m[1] + ' ' + words.join(' ') + ' ' + title(m[3]), match: m[0] };
  }

  var NAME_STOP = ('calling about with from at in on the a an and my your our just not so very really also still here there ' +
    'having looking trying wondering sure okay ok fine good great well yes yeah yep no nope hi hello hey sorry afraid worried ' +
    'interested home out done ready glad happy thinking going getting call phone number address zip ac water gas ' +
    'heater pipe leak drain toilet urgent emergency available free busy that this it is was be been already actually ' +
    'only gonna wanting need needing pretty kind sort hot cold right wrong correct').split(' ');
  function cleanNameWords(str) {
    var out = [];
    var words = String(str).replace(/[^A-Za-z'\- ]+/g, ' ').trim().split(/\s+/);
    for (var i = 0; i < words.length && out.length < 3; i++) {
      var w = words[i];
      if (!w) continue;
      if (NAME_STOP.indexOf(w.toLowerCase()) >= 0) break;
      if (w.length < 2) break;
      out.push(title(w));
    }
    return out.length ? out.join(' ') : null;
  }
  function extractName(raw, expecting) {
    var s = String(raw || '').trim();
    var m = /\b(?:my name is|my name's|name is|call me)\s+([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,2})/i.exec(s);
    if (m) { var a = cleanNameWords(m[1]); if (a) return a; }
    m = /\b(?:this is|it's|it is|i'm|i am)\s+([A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,2})/i.exec(s);
    if (m && (expecting || /^[A-Z]/.test(m[1]))) { var b = cleanNameWords(m[1]); if (b) return b; }
    if (expecting) {
      var bare = s.replace(/^(?:um+|uh+|sure|yes|yeah|ok(?:ay)?|it's|its|this is)[,.\s]+/i, '').replace(/[.!?]+$/, '').trim();
      if (/^[A-Za-z][A-Za-z'\-]*(?:\s+[A-Za-z][A-Za-z'\-]*){0,2}$/.test(bare)) return cleanNameWords(bare);
    }
    return null;
  }

  var YES_RE = /\b(yes|yeah|yea|yep|yup|sure|correct|right|ok|okay|please do|go ahead|sounds good|perfect|absolutely|of course|that works|works for me|that's fine|fine|definitely|no problem|this number|this one|same number|the one i'm calling from)\b/;
  var NO_RE = /\b(no|nope|nah|not really|don't|do not|never mind|nevermind|wrong|different number|another number|other number)\b/;
  function yesNo(n) {
    if (/\b(not sure|don't know|dont know|no idea|maybe)\b/.test(n)) return 'unsure';
    var y = YES_RE.exec(n), no = NO_RE.exec(n);
    if (y && y[1] === 'no problem') no = null;
    if (y && no) return y.index <= no.index ? 'yes' : 'no';
    return y ? 'yes' : no ? 'no' : null;
  }

  var VULN_RE = /\b(elderly|older|senior|grandma|grandmother|grandpa|grandfather|my mom|my mother|my dad|my father|baby|infant|newborn|toddler|pregnant|sick|unwell|ill|medical|oxygen|disabled|disability|heart condition|asthma)\b/;
  function vulnerable(n) {
    var age = /\b(?:she's|he's|she is|he is|they're|they are|who is|who's)\s+(\d{2,3})\b|\b(\d{2,3})\s+years?\s+old\b/.exec(n);
    var old = age && +(age[1] || age[2]) >= 65;
    var yn = yesNo(n);
    if (yn === 'no' && !old && !VULN_RE.test(n.replace(/^no\b/, ''))) return false;
    if (old || VULN_RE.test(n)) return true;
    if (yn === 'yes') return true;
    if (yn === 'no') return false;
    return null;
  }

  function detectService(n, data) {
    var best = null;
    data.services.forEach(function (s) {
      s.keywords.forEach(function (k) {
        if (findKw(n, k) >= 0) {
          var score = k.length * (s.generic ? 0.5 : 1);
          if (!best || score > best.score) best = { id: s.id, score: score, keyword: k };
        }
      });
    });
    return best;
  }
  function detectEmergency(n, data) {
    var best = null;
    data.emergencies.forEach(function (e) {
      e.keywords.forEach(function (k) {
        if (hasPos(n, k)) {
          var rank = e.level === 'danger' ? 2 : 1;
          if (!best || rank > best.rank) best = { id: e.id, level: e.level, label: e.label, keyword: k, rank: rank, script: e.script };
        }
      });
    });
    return best;
  }

  var INTENTS = {
    spam: ['google listing', 'google business', 'business listing', 'seo', 'search engine', 'first page of google', 'rank higher', 'merchant services', 'credit card processing', 'business loan', 'business funding', 'extended warranty', 'lower your rates', 'marketing services', 'more customers', 'courtesy call', 'press one', 'press 1'],
    optout: ['stop texting', 'stop texts', 'stop text', "don't text", 'dont text', 'do not text', 'no texts', 'no text', 'no text messages', 'unsubscribe', 'opt out'],
    human: ['real person', 'a person', 'live person', 'human', 'representative', 'operator', 'talk to someone', 'speak to someone', 'speak with someone', 'talk to somebody', 'speak to somebody', 'customer service', 'a manager', 'the manager', 'the owner', 'dispatcher', 'someone real', 'somebody real'],
    ai: ['are you a robot', 'is this a robot', 'talking to a robot', 'a robot', 'are you real', 'are you a bot', 'is this a bot', 'are you ai', 'are you an ai', 'is this ai', 'is this an ai', 'talking to a computer', 'talking to a machine', 'are you human', 'is this a real person', 'is this a recording'],
    office: ['bill', 'billing', 'invoice', 'charged me', 'refund', 'complaint', 'complain', 'reschedule', 'cancel', 'change my appointment', 'move my appointment', 'my appointment', 'warranty claim'],
    price: ['how much', 'price', 'prices', 'pricing', 'cost', 'costs', 'charge', 'charges', 'fee', 'fees', 'rate', 'rates', 'expensive', 'cheap', 'ballpark'],
    hours: ['hours', 'are you open', 'open today', 'open tomorrow', 'open on', 'open on weekends', 'what time do you', 'when do you open', 'when do you close', 'closing time', 'weekends'],
    area: ['service area', 'do you serve', 'do you service', 'do you come to', 'do you go to', 'do you cover', 'come out to', 'do you work in', 'what areas', 'cover my area'],
    wait: ['hold on', 'hang on', 'one sec', 'one second', 'just a sec', 'give me a second', 'let me check', 'let me see', 'bear with me'],
    bye: ['bye', 'goodbye', "that's all", 'thats all', "that's everything", 'thats everything', 'nothing else', "that's it", 'thats it', 'no thanks', 'no thank you', 'all set', "i'm good", 'im good', 'never mind', 'nevermind'],
    book: ['book', 'schedule', 'appointment', 'come out', 'send someone', 'send a tech', 'technician', 'someone out', 'get someone', 'set up a visit'],
    thanks: ['thank you', 'thanks']
  };
  var PRICE_FOLLOW = /\b(what about|how about|and for|roughly|ballpark|approximately)\b/;

  function faqMatch(n, data) {
    var best = null;
    data.faq.forEach(function (f) {
      var c = countKw(n, f.keywords);
      if (c && (!best || c > best.count)) best = { id: f.id, answer: f.answer, count: c };
    });
    return best;
  }
  function cityIn(n, data) {
    var i, z;
    for (i = 0; i < data.zones.length; i++) { z = data.zones[i]; if (findKw(n, z.name.toLowerCase()) >= 0) return { name: z.name, inside: true, zone: z.id }; }
    for (i = 0; i < (data.outsideCities || []).length; i++) if (findKw(n, data.outsideCities[i].toLowerCase()) >= 0) return { name: data.outsideCities[i], inside: false };
    return null;
  }
  function zoneFor(zip, data) {
    zip = String(zip || '');
    if (!/^\d{5}$/.test(zip)) return null;
    var i, z;
    for (i = 0; i < data.zones.length; i++) { z = data.zones[i]; if ((z.zips || []).indexOf(zip) >= 0) return z; }       // exact ZIP wins
    for (i = 0; i < data.zones.length; i++) { z = data.zones[i]; if ((z.prefixes || []).some(function (p) { return zip.indexOf(p) === 0; })) return z; }
    return null;
  }
  function zoneById(data, id) { return data.zones.filter(function (z) { return z.id === id; })[0] || null; }
  function serviceById(data, id) { return data.services.filter(function (s) { return s.id === id; })[0] || null; }
  function techById(data, id) { return data.technicians.filter(function (t) { return t.id === id; })[0] || null; }

  function understand(raw, call, data) {
    var stripped = stripCompany(raw, data);
    var n = norm(stripped);
    var ent = {};
    var ph = extractPhone(stripped);
    var rest = stripped;
    if (ph) { ent.phone = ph.text; rest = stripped.slice(0, ph.index) + ' ' + stripped.slice(ph.index + ph.length); }
    var ad = extractAddress(rest);
    if (ad) { ent.street = ad.text; rest = rest.replace(ad.match, ' '); }
    var zips = rest.match(/\b\d{5}\b/g);
    if (zips) ent.zip = zips[zips.length - 1];
    var nm = extractName(stripped, call && /name$/.test(call.pending || ''));
    if (nm) ent.name = nm;
    var yn = yesNo(n);
    if (yn) ent.yesNo = yn;
    var ind = /\b(\d{2,3}) degrees\b[^.]*?\b(inside|in the house|indoors|in here)\b|\b(inside|in the house|indoors|in here)\b[^.]*?\b(\d{2,3}) degrees\b/.exec(n);
    if (ind) ent.indoorF = +(ind[1] || ind[4]);
    var svc = detectService(n, data);
    var em = detectEmergency(n, data);
    var has = {};
    Object.keys(INTENTS).forEach(function (k) { if (anyKw(n, INTENTS[k])) has[k] = true; });
    if (n === 'stop' || n === 'stop stop') has.optout = true;
    if (call && call.lastIntent === 'price' && PRICE_FOLLOW.test(n)) has.price = true;
    if (has.office && has.price && !/\b(bill|billing|invoice|charged me|refund)\b/.test(n)) delete has.office;
    var faq = faqMatch(n, data);
    var city = cityIn(n, data);

    var intent = 'unknown', label = 'Not understood yet', conf = 0.2;
    function set(i, l, c) { if (intent === 'unknown') { intent = i; label = l; conf = c; } }
    if (em) set('emergency', 'Emergency: ' + em.label, 0.97);
    if (has.spam) set('spam', 'Sales call', 0.9);
    if (has.human) set('human', 'Wants a person', 0.9);
    if (has.office) set('office', 'Office matter', 0.85);
    if (has.ai) set('ai', 'Asked if this is AI', 0.92);
    if (has.optout) set('optout', 'Text opt-out', 0.95);
    if (has.price) set('price', 'Price question', 0.88);
    if (has.hours) set('hours', 'Hours question', 0.86);
    if (has.area) set('area', 'Service-area question', 0.86);
    if (faq && !svc) set('faq', 'FAQ: ' + faq.id, 0.8);
    var pend = call && call.pending;
    if (pend && (ent.name && /name$/.test(pend) || (ent.street || ent.zip) && /address|zip|street/.test(pend) || ent.phone && /phone/.test(pend) || yn && /phone|consent|offer|anything|heat|window|retry/.test(pend))) {
      set('answer', 'Answer: ' + pend.replace(/_/g, ' '), ent.name && !/(my name|this is|it's|i'm)/i.test(stripped) ? 0.72 : 0.95);
    }
    if (svc) set('service', 'Service request: ' + serviceById(data, svc.id).label, Math.min(0.95, 0.6 + svc.score / 40));
    if (has.book) set('book', 'Wants a visit', 0.75);
    if (faq) set('faq', 'FAQ: ' + faq.id, 0.75);
    if (has.bye) set('bye', 'Wrapping up', 0.8);
    if (has.thanks) set('thanks', 'Thanks', 0.7);
    if (has.wait) set('wait', 'Needs a moment', 0.8);

    return {
      raw: raw, n: n, intent: intent, label: label, confidence: Math.round(conf * 100) / 100,
      entities: ent, service: svc ? svc.id : null, serviceKeyword: svc ? svc.keyword : null,
      emergency: em, has: has, faq: faq, city: city
    };
  }

  // ---------------------------------------------------------------- calendar
  // Jobs that exist on a given day: calendar rows inside that day's opening hours (techs may start up to an hour early),
  // plus jobs booked on earlier calls. The page draws the calendar from this same list.
  function busyOn(data, call, day, ctx) {
    var hrs = hoursFor(data, (call.when.weekday + day) % 7);
    if (!hrs) return [];
    return (data.busy || []).filter(function (b) { return b.day === day && hm(b.start) >= hrs[0] - 60 && hm(b.end) <= hrs[1]; })
      .concat(((ctx && ctx.extraBusy) || []).filter(function (b) { return b.day === day; }));
  }
  function busyClash(list, data, tech, day, x0, x1) {
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.tech !== tech || b.day !== day) continue;
      var z = zoneById(data, b.zone);
      var b0 = hm(b.start) - (z ? z.travel : 30), b1 = hm(b.end);
      if (x0 < b1 && b0 < x1) return true;
    }
    return false;
  }
  function jobsOn(list, tech, day) { return list.filter(function (b) { return b.tech === tech && b.day === day; }).length; }

  // Arrival windows a technician can really make: right trade, inside the shift and business hours,
  // drive time kept free before the job and after the previous one, never on top of another job.
  function findWindows(data, call, opts, ctx) {
    opts = opts || {};
    var cfg = call.cfg, S = call.slots;
    var svc = serviceById(data, S.service) || serviceById(data, 'hvac_repair');
    var zone = zoneById(data, S.zone);
    var travel = zone ? zone.travel : 30, minutes = svc ? svc.minutes : 90, trade = svc ? svc.trade : 'hvac';
    var lead = call.urgency === 'normal' ? cfg.leadMinutes : cfg.priorityLeadMinutes;
    var count = opts.count || cfg.offerCount, step = cfg.stepMinutes;
    var skip = opts.skip || {}, res = [];
    for (var d = 0; d <= cfg.daysAhead && res.length < count; d++) {
      if (opts.day != null && d !== opts.day) continue;
      var hrs = hoursFor(data, (call.when.weekday + d) % 7);
      if (!hrs) continue;
      var earliest = d === 0 ? Math.ceil((call.when.minutes + lead) / step) * step : 0;
      var busy = busyOn(data, call, d, ctx);
      for (var w = 0; w < data.windowStarts.length && res.length < count; w++) {
        var ws = hm(data.windowStarts[w]), we = ws + data.windowMinutes;
        var key = d + '@' + data.windowStarts[w];
        if (ws < hrs[0] || we > hrs[1] || skip[key]) continue;
        if (opts.part && partOf(ws) !== opts.part && !(opts.part === 'evening' && ws >= 960)) continue;
        if (opts.hour != null && !(opts.hour * 60 >= ws && opts.hour * 60 < we)) continue;
        if (opts.after != null && d * 1440 + ws <= opts.after) continue;
        var best = null;
        data.technicians.forEach(function (t) {
          if (t.trades.indexOf(trade) < 0) return;
          var s0 = Math.max(hm(t.shift[0]), hrs[0]), s1 = Math.min(hm(t.shift[1]), hrs[1]);
          for (var a = Math.max(ws, earliest); a <= we - step; a += step) {
            if (a - travel < s0 || a + minutes > s1) continue;
            if (busyClash(busy, data, t.id, d, a - travel, a + minutes)) continue;
            if (!best || a < best.arrive || (a === best.arrive && jobsOn(busy, t.id, d) < jobsOn(busy, best.tech, d))) best = { tech: t.id, techName: t.name, arrive: a };
            break;
          }
        });
        if (best) res.push({
          key: key, day: d, date: dateFor(call, d), start: ws, end: we, tech: best.tech, techName: best.techName,
          arrive: best.arrive, minutes: minutes, travel: travel, zone: zone ? zone.id : null,
          dayLabel: dayName(call, d), spanLabel: span(ws, we), label: dayName(call, d) + ' between ' + span(ws, we).replace(' to ', ' and ')
        });
      }
    }
    return res;
  }

  function sayOffers(call, prefix) {
    var o = call.offers;
    if (!o.length) return '';
    if (o.length === 1) return (prefix || 'The earliest I have is') + ' ' + o[0].dayLabel + ' between ' + o[0].spanLabel.replace(' to ', ' and ') + '. Does that work?';
    var sameDay = o.every(function (x) { return x.day === o[0].day; });
    var parts = o.map(function (x) { return (sameDay ? '' : x.dayLabel + ' ') + 'between ' + x.spanLabel.replace(' to ', ' and '); });
    var list = parts.length === 2 ? parts[0] + ', or ' + parts[1] : parts.slice(0, -1).join(', ') + ', or ' + parts[parts.length - 1];
    return (sameDay ? 'I have ' + (o.length === 2 ? 'two' : 'three') + ' times ' + o[0].dayLabel + ': ' : 'I have ') + list + '. Which works better?';
  }

  function parsePref(n, call) {
    var p = {};
    if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(n)) p.day = 0;
    else if (/\btomorrow\b/.test(n)) p.day = 1;
    else {
      for (var i = 0; i < 7; i++) if (new RegExp('\\b' + DAYS[i].toLowerCase() + '\\b').test(n)) p.day = (i - call.when.weekday + 7) % 7;
    }
    if (/\b(morning|early|first thing|before noon|before lunch)\b/.test(n)) p.part = 'morning';
    else if (/\b(afternoon|after lunch)\b/.test(n)) p.part = 'afternoon';
    else if (/\b(evening|after work|late)\b/.test(n)) p.part = 'evening';
    var h = /\b(\d{1,2})(?::\d{2})?\s*(am|pm|a m|p m|o'clock|oclock)?\b/.exec(n);
    if (h && +h[1] >= 1 && +h[1] <= 12) {
      var hr = +h[1], ap = (h[2] || '').replace(/\s/g, '');
      if (ap === 'pm' && hr < 12) hr += 12; else if (ap === 'am' && hr === 12) hr = 0; else if (!/am|pm/.test(ap) && hr <= 7) hr += 12;
      p.hour = hr;
    }
    if (/\b(first|1st|earlier|earliest|sooner|soonest)\b/.test(n)) p.ordinal = 0;
    else if (/\b(second|2nd|later one|latter|last one|the other one|other one)\b/.test(n)) p.ordinal = 1;
    else if (/\b(third|3rd)\b/.test(n)) p.ordinal = 2;
    if (/\b(either|whichever|any of them|doesn't matter|dont care|don't care|either one)\b/.test(n)) p.any = true;
    if (/\b(neither|none of (those|them)|something else|other times|anything else|anything later|later in the week|different time|those don't work|that doesn't work|doesn't work)\b/.test(n)) p.more = true;
    return p;
  }

  // ---------------------------------------------------------------- the call
  function cfgFor(data, over) {
    var c = {}, k;
    for (k in DEFAULTS) c[k] = DEFAULTS[k];
    for (k in (data.config || {})) c[k] = data.config[k];
    for (k in (over || {})) c[k] = over[k];
    return c;
  }

  function startCall(data, opts) {
    opts = opts || {};
    var when = parseNow(opts.now);
    if (!when) throw new Error('startCall needs a time like 2026-10-27T13:05');
    var call = {
      id: opts.id || 'call-' + when.iso, when: when, callerId: normalisePhone(opts.callerId),
      open: isOpen(data, when), cfg: cfgFor(data, opts.config),
      mode: 'booking', pending: 'reason', urgency: 'normal', emergency: null,
      slots: { service: null, problem: null, vulnerable: null, name: null, street: null, zip: null, zone: null, phone: null, consent: null, indoorF: null },
      offers: [], offered: {}, booked: null, confirmed: false, outcome: null, transfer: null, callback: null,
      clarify: 0, lastIntent: null, guardrails: [], notes: [], alerts: [], turns: [], ended: false
    };
    if (data.weather && data.weather.todayHighF != null) call.highF = data.weather.todayHighF;
    var c = data.company;
    var g = 'Thanks for calling ' + c.spoken + '. This is ' + c.agent + ', the AI assistant.';
    if (!call.open) g += ' The office is closed right now, but I can book a visit or get help to you in an emergency.';
    if (call.cfg.recordingNotice) g += ' This call may be recorded.';
    g += call.open ? ' How can I help you today?' : ' How can I help?';
    call.guardrails.push('Said it is an AI assistant in the greeting');
    call.turns.push({ who: 'agent', text: g });
    call.greeting = g;
    return call;
  }

  function respond(call, input, data, ctx) {
    if (!call || call.ended) return { ok: false, error: 'This call has ended. Start a new call to keep going.', reply: null };
    var raw = String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
    if (!raw || !/[a-z0-9]/i.test(raw)) return { ok: false, error: 'Nothing to answer yet. Say or type what the caller says.', reply: null };
    var guard = [];
    if (raw.length > call.cfg.maxInput) { raw = raw.slice(0, call.cfg.maxInput); guard.push('Very long input: read the first ' + call.cfg.maxInput + ' characters'); }
    call.turns.push({ who: 'caller', text: raw });
    var before = JSON.stringify(call.slots);
    var u = understand(raw, call, data);
    var out = { parts: [], actions: [], guard: guard, skipAsk: false };
    route(call, u, out, data, ctx || {});
    call.lastIntent = u.intent === 'price' || (u.has.price && u.intent !== 'emergency') ? 'price' : u.intent;
    var reply = out.parts.join(' ').replace(/\s+/g, ' ').replace(/\s([,.?!])/g, '$1').trim();
    call.turns.push({ who: 'agent', text: reply });
    out.guard.forEach(function (g) { if (call.guardrails.indexOf(g) < 0) call.guardrails.push(g); });
    return {
      ok: true, reply: reply, speech: toSpeech(reply), understood: u, filled: before !== JSON.stringify(call.slots),
      actions: out.actions, guardrails: out.guard, pending: call.ended ? null : call.pending, ended: call.ended,
      offers: call.offers.slice(), slots: JSON.parse(JSON.stringify(call.slots)), urgency: call.urgency,
      booked: call.booked, outcome: call.outcome
    };
  }

  function end(call, outcome, out, action) {
    call.ended = true; call.pending = null;
    if (!call.outcome) call.outcome = outcome;
    if (action) out.actions.push(action);
    out.actions.push({ type: 'end', outcome: call.outcome });
  }

  function route(call, u, out, data, ctx) {
    var S = call.slots, cfg = call.cfg, c = data.company;

    // 1. Danger comes first, whatever else was said.
    if (u.emergency && u.emergency.level === 'danger') {
      call.urgency = 'danger'; call.emergency = u.emergency;
      var onCallName = techById(data, data.onCall.tech).name;
      var who = call.open && cfg.transferDuringHours ? c.dispatcher + ' in dispatch' : 'our on-call technician, ' + onCallName + ',';
      out.parts.push(u.emergency.script + ' I\'m connecting you to ' + who + ' right now.');
      who = call.open && cfg.transferDuringHours ? c.dispatcher + ' (dispatch)' : onCallName + ' (on call)';
      out.guard.push('Danger (' + u.emergency.label.toLowerCase() + '): safety steps read first, then a live transfer');
      call.transfer = { to: call.open && cfg.transferDuringHours ? 'dispatcher' : 'oncall', name: who };
      call.alerts.push('EMERGENCY: ' + u.emergency.label + '. Caller ' + (call.callerId || 'unknown number') + ' transferred to ' + who + '.');
      end(call, 'emergency_transfer', out, { type: 'transfer', to: call.transfer.to, name: who });
      return;
    }
    // 2. Sales calls end politely, with no alert.
    if (u.has.spam && !S.service && !S.name) {
      out.parts.push('Thanks, but we\'re not interested. Please remove this number from your list. Goodbye.');
      out.guard.push('Sales call spotted: ended politely, no alert sent');
      end(call, 'spam', out);
      return;
    }

    var info = !!(u.has.price || u.has.hours || u.has.area);
    absorb(call, u, out, data, info);

    // 3. Urgent problems (burst pipe, sewage) switch to urgent handling.
    if (u.emergency && u.emergency.level === 'urgent' && call.urgency !== 'urgent') {
      call.urgency = 'urgent'; call.emergency = u.emergency;
      if (!S.service) S.service = u.emergency.id === 'sewage' ? 'drain' : 'leak';
      if (!S.problem) S.problem = u.raw;
      out.parts.push(u.emergency.script.replace('the fixture', /sink/.test(u.n) ? 'the sink' : /toilet/.test(u.n) ? 'the toilet' : 'the fixture'));
      if (!call.open) {
        call.mode = 'oncall';
        out.parts.push('I\'m paging our on-call technician now.');
        out.guard.push('Urgent after hours (' + u.emergency.label.toLowerCase() + '): on-call technician paged');
      } else {
        out.guard.push('Urgent (' + u.emergency.label.toLowerCase() + '): earliest same-day times first');
      }
    }

    // 4. Text opt-out works at any point.
    if (u.has.optout) {
      S.consent = false;
      out.parts.push('Got it, no text messages.');
      out.guard.push('Text opt-out recorded: no texts will be sent');
      if (call.pending === 'consent') call.pending = null;
    }

    // 5. A person on request, honest about being AI.
    if (u.has.human || u.has.office) {
      if (u.has.ai) out.parts.push('Yes, I\'m ' + c.short + '\'s AI assistant.');
      toPerson(call, out, data, u.has.office ? 'office' : 'request');
      return;
    }
    if (u.has.ai) {
      out.parts.push('Yes, I\'m ' + c.short + '\'s AI assistant. I can book a visit, answer questions about prices and hours, or connect you with a person.');
      out.guard.push('Asked if it is AI: answered honestly');
      if (!S.service && !call.booked) { out.parts.push('What would you like to do?'); call.pending = 'reason'; out.skipAsk = true; }
    }

    // 6. The answer to the question that was just asked.
    var answered = answerPending(call, u, out, data, ctx);
    if (call.ended) return;

    // 7. Questions asked along the way are answered, then the call carries on.
    var answeredInfo = false;
    if (u.has.price) { out.parts.push(priceAnswer(call, u, out, data)); answeredInfo = true; }
    if (u.has.hours) { out.parts.push('We\'re open ' + hoursText(data) + '. Emergency help is available around the clock.'); answeredInfo = true; }
    if (u.has.area) { out.parts.push(areaAnswer(call, u, data, out)); answeredInfo = true; }
    if (u.faq && !u.has.price && !answered && (!u.service || !S.service || u.intent === 'faq')) { out.parts.push(u.faq.answer); answeredInfo = true; }
    if (answeredInfo && !S.service && !call.booked && call.mode === 'booking') {
      var est = u.service === 'estimate' && u.has.price;
      call.pending = est ? 'estimate_offer' : 'book_offer';
      out.parts.push(est ? 'Would you like a free estimate?' : 'Would you like me to book a visit?');
      out.skipAsk = true;
    }

    if (u.has.wait && !answered && !answeredInfo && !out.filled) { out.parts.push('Of course, take your time.'); return; }

    // 8. Wrapping up.
    var inProgress = call.mode !== 'booking' || (S.service && !call.booked) || (call.booked && !call.confirmed);
    if (u.has.bye && !answeredInfo && (call.pending === 'anything_else' || !inProgress)) { close(call, out, data); return; }
    if (u.has.bye && inProgress && !answered && !out.filled && call.pending !== 'anything_else') {
      out.parts.push('No problem. If you need us, just call back. Goodbye.');
      end(call, call.booked ? 'booked' : 'abandoned', out);
      return;
    }
    if (u.has.thanks && !answered && !answeredInfo && !out.filled && !u.has.bye) { out.parts.push('You\'re welcome.'); answered = true; }

    // 9. Nothing understood: ask again, then hand over to a person.
    if (!answered && !answeredInfo && !out.filled && !u.has.ai && !u.has.optout && !(u.emergency)) {
      call.clarify++;
      if (call.clarify > cfg.maxClarify) {
        out.parts.push('I\'m sorry, I\'m not understanding.');
        out.guard.push('Not understood ' + call.clarify + ' times: handed to a person');
        toPerson(call, out, data, 'clarify');
        return;
      }
      out.parts.push(call.pending === 'reason' ? 'Sorry, I didn\'t catch that. Is this for heating and cooling, or plumbing?' : 'Sorry, I didn\'t catch that.');
      if (call.pending === 'reason') { out.skipAsk = true; }
      else out.reask = true;
    } else if (answered || out.filled) call.clarify = 0;

    if (!call.ended && !out.skipAsk) next(call, out, data, ctx);
  }

  // Volunteered details are kept whenever they are said, not only when asked.
  function absorb(call, u, out, data, info) {
    var S = call.slots, e = u.entities;
    out.filled = false;
    if (u.service && !S.service && !info && !u.has.spam) {
      S.service = u.service; S.problem = u.service === 'estimate' ? 'Wants a free estimate for a new system' : u.raw; out.filled = true;
      var svc = serviceById(data, u.service);
      if (!(u.emergency && u.emergency.level === 'urgent')) out.parts.push(svc.heatCheck && !(call.highF >= call.cfg.heatPriorityF) && svc.ackMild ? svc.ackMild : svc.ack);
      if (svc.generic) out.guard.push('Only the trade is known so far: the technician will ask for details');
    } else if (u.service && S.service && u.service !== S.service && call.booked) {
      call.notes.push('Also mentioned: ' + serviceById(data, u.service).label.toLowerCase() + ' ("' + u.raw + '")');
    }
    if (e.indoorF && !S.indoorF) { S.indoorF = e.indoorF; out.filled = true; }
    if (e.name && (!S.name || /name$/.test(call.pending || ''))) {
      if (S.name !== e.name) { S.name = e.name; out.filled = true; if (/name$/.test(call.pending || '')) out.parts.push('Thanks, ' + e.name.split(' ')[0] + '.'); }
    }
    if (e.phone && (!S.phone || /phone/.test(call.pending || ''))) {
      S.phone = e.phone; out.filled = true;
      if (/phone/.test(call.pending || '')) out.parts.push('Thanks, I\'ll use ' + e.phone + '.');
    }
    if ((e.street || e.zip) && !u.has.area) {
      if (e.street) { S.street = e.street; out.filled = true; }
      if (e.zip) {
        S.zip = e.zip; out.filled = true;
        var z = zoneFor(e.zip, data);
        S.zone = z ? z.id : null;
        if (!z) {
          out.parts.push('I\'m sorry, ' + e.zip + ' is outside our service area. We cover ' + data.company.areaText + '.');
          out.guard.push('Outside the service area (' + e.zip + '): not booked');
          call.offers = [];
        } else if (S.street) {
          out.parts.push('Got it, ' + S.street + ', ' + S.zip + '.');
        }
      } else if (S.street && !S.zip && call.pending !== 'street') {
        out.parts.push('Got it, ' + S.street + '.');
      }
      if (S.zip && S.zone && e.street && !e.zip && call.pending === 'street') out.parts.push('Got it, ' + S.street + ', ' + S.zip + '.');
    }
  }

  function answerPending(call, u, out, data, ctx) {
    var S = call.slots, p = call.pending, yn = u.entities.yesNo;
    switch (p) {
      case 'heat': {
        var v = vulnerable(u.n);
        if (v === null) return false;
        S.vulnerable = v;
        if (v) {
          call.urgency = 'priority';
          out.parts.push('Thank you for telling me. I\'m marking this as a heat priority.');
          out.guard.push('Heat priority: ' + call.highF + '°F today and someone vulnerable at home');
        } else out.parts.push('Okay, thank you.');
        out.filled = true;
        return true;
      }
      case 'phone':
        if (u.entities.phone) return true;
        if (yn === 'yes' && call.callerId) { S.phone = call.callerId; out.filled = true; return true; }
        if (yn === 'no') { call.pending = 'phone_new'; out.parts.push('No problem. What\'s the best number to reach you?'); out.skipAsk = true; return true; }
        return false;
      case 'phone_new':
        return !!u.entities.phone;
      case 'consent':
        if (yn === 'yes' || /\btext me\b/.test(u.n)) { S.consent = true; out.parts.push('Great.'); out.filled = true; out.guard.push('Text consent given on the call'); return true; }
        if (yn === 'no') { S.consent = false; out.parts.push('No problem, no texts.'); out.filled = true; out.guard.push('No text consent: no texts will be sent'); return true; }
        return S.consent === false;
      case 'window':
        return pickWindow(call, u, out, data, ctx);
      case 'book_offer':
      case 'estimate_offer':
        if (u.has.price && yn !== 'yes') return false;
        if (yn === 'yes' || u.has.book || u.service) {
          if (!S.service && (p === 'estimate_offer' || u.service === 'estimate')) { S.service = 'estimate'; S.problem = 'Wants a free estimate for a new system'; out.parts.push(serviceById(data, 'estimate').ack); }
          out.filled = true;
          return true;
        }
        if (yn === 'no') { out.parts.push('No problem.'); call.pending = 'anything_else'; out.parts.push('Is there anything else I can help with?'); out.skipAsk = true; return true; }
        return false;
      case 'anything_else':
        if (yn === 'no' || u.has.bye) { close(call, out, data); return true; }
        if (yn === 'yes' && !u.has.price && !u.has.hours && !u.faq && !u.service) { out.parts.push('Sure, what else can I help with?'); out.skipAsk = true; return true; }
        if (u.service && call.booked) { out.parts.push('I\'ll add that to the notes for the technician.'); return true; }
        return false;
      case 'address_retry':
        if (u.entities.zip) return true;
        if (yn === 'no' || u.has.bye) {
          out.parts.push('Sorry we couldn\'t help this time. Thanks for calling ' + data.company.short + '.');
          end(call, 'out_of_area', out);
          return true;
        }
        return false;
      case 'name':
        return !!u.entities.name;
      case 'address': case 'zip': case 'street':
        return !!(u.entities.street || u.entities.zip);
      case 'reason':
        return !!(u.service || u.has.book);
      default:
        return false;
    }
  }

  function pickWindow(call, u, out, data, ctx) {
    var o = call.offers, pref = parsePref(u.n, call), pick = null;
    if (!o.length) return false;
    if (pref.ordinal != null && o[pref.ordinal]) pick = o[pref.ordinal];
    else if (pref.any) pick = o[0];
    else if (pref.day != null || pref.part || pref.hour != null) {
      var m = o.filter(function (w) {
        return (pref.day == null || w.day === pref.day) && (!pref.part || partOf(w.start) === pref.part || (pref.part === 'evening' && w.start >= 960)) && (pref.hour == null || (pref.hour * 60 >= w.start && pref.hour * 60 < w.end));
      });
      if (m.length) pick = m[0];
      else {
        var found = findWindows(data, call, { day: pref.day, part: pref.part, hour: pref.hour }, ctx);
        var what = (pref.day != null ? dayName(call, pref.day) + ' ' : '') + (pref.part || (pref.hour != null ? 'at ' + clock(pref.hour * 60) : ''));
        what = what.trim();
        if (found.length) {
          call.offers = found;
          out.parts.push(found.length === 1 ? cap1(what) + ' I have one time: between ' + found[0].spanLabel.replace(' to ', ' and ') + '. Does that work?'
            : sayOffers(call));
        } else {
          var nextUp = findWindows(data, call, { after: (pref.day || 0) * 1440 + (pref.part === 'afternoon' ? 720 : pref.part === 'evening' ? 960 : 0) }, ctx);
          if (nextUp.length) { call.offers = nextUp; out.parts.push('Nothing is open ' + (what || 'then') + '. ' + sayOffers(call, 'The next opening is')); }
          else { out.parts.push('I don\'t have anything open then.'); toPerson(call, out, data, 'noslot'); return true; }
        }
        out.skipAsk = true;
        return true;
      }
    } else if (pref.more) {
      var last = o[o.length - 1];
      o.forEach(function (w) { call.offered[w.key] = true; });
      var more = findWindows(data, call, { after: last.day * 1440 + last.start, skip: call.offered }, ctx);
      if (more.length) { call.offers = more; out.parts.push(sayOffers(call, 'The next opening is')); out.skipAsk = true; return true; }
      out.parts.push('That\'s everything I have this week.'); toPerson(call, out, data, 'noslot'); return true;
    } else if (u.entities.yesNo === 'yes') {
      if (o.length === 1) pick = o[0];
      else { out.parts.push('Which one works: ' + o.map(function (w) { return w.dayLabel + ' between ' + w.spanLabel.replace(' to ', ' and '); }).join(', or ') + '?'); out.skipAsk = true; return true; }
    }
    if (!pick) return false;
    book(call, pick, out, data, ctx);
    return true;
  }
  function lowerFirst(s) { return String(s).replace(/^([A-Z])([a-z])/, function (m, a, b) { return a.toLowerCase() + b; }); }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  function book(call, w, out, data, ctx) {
    var S = call.slots, svc = serviceById(data, S.service);
    call.booked = {
      key: w.key, day: w.day, date: w.date, start: w.start, end: w.end, tech: w.tech, techName: w.techName, arrive: w.arrive,
      dayLabel: w.dayLabel, spanLabel: w.spanLabel, service: svc ? svc.label : 'Service visit', zone: w.zone
    };
    if (ctx && ctx.extraBusy) ctx.extraBusy.push({ tech: w.tech, day: w.day, start: hhmm(w.arrive), end: hhmm(w.arrive + w.minutes), zone: w.zone || 'phx', label: (svc ? svc.label : 'Visit') + (S.name ? ' (' + S.name + ')' : ''), who: S.name ? S.name.split(' ')[0] + (S.name.split(' ')[1] ? ' ' + S.name.split(' ')[1].charAt(0) + '.' : '') : null, booked: true, callId: call.id });
    out.parts.push('Done, you\'re booked for ' + w.dayLabel + ' between ' + w.spanLabel.replace(' to ', ' and ') + '.');
    out.actions.push({ type: 'book', tech: w.techName, window: w.dayLabel + ' ' + w.spanLabel, date: w.date });
    out.guard.push('Booked from the live calendar: drive time kept free, no double-booking');
    if (call.urgency === 'priority' && w.day > 0) call.alerts.push('No same-day opening for a heat priority. Booked ' + w.dayLabel + '; dispatcher to look for a sooner slot.');
    out.filled = true;
    call.offers = [];
  }
  function hhmm(min) { var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }

  function confirmBooking(call, out, data) {
    var S = call.slots, b = call.booked, svc = serviceById(data, S.service), P = data.prices;
    var contact = S.consent ? 'will text you when on the way' : 'will call you when on the way';
    out.parts.push(b.techName + ' will be there ' + b.dayLabel + ' between ' + b.spanLabel.replace(' to ', ' and ') + ' and ' + contact + '.');
    var price = svc && P[svc.price] ? P[svc.price].text : P.diagnostic && P.diagnostic.text;
    if (price) out.parts.push(price.replace(/^Our diagnostic visit/, 'The diagnostic visit'));
    call.confirmed = true;
    call.pending = 'anything_else';
    out.parts.push('Is there anything else I can help with?');
    if (call.urgency === 'priority') call.alerts.push('HEAT PRIORITY: ' + (S.name || 'Caller') + ', ' + (S.phone || call.callerId) + ', ' + S.street + ' ' + S.zip + '. ' + (svc ? svc.label : '') + (S.indoorF ? ', ' + S.indoorF + '°F inside' : '') + ', vulnerable person at home. Booked ' + b.techName + ' ' + b.dayLabel + ' ' + b.spanLabel + '.');
    if (call.urgency === 'urgent') call.alerts.push('URGENT (' + call.emergency.label.toLowerCase() + '): ' + (S.name || 'Caller') + ', ' + S.street + ' ' + S.zip + '. Booked ' + b.techName + ' ' + b.dayLabel + ' ' + b.spanLabel + '.');
  }

  function close(call, out, data) {
    var S = call.slots, first = S.name ? ', ' + S.name.split(' ')[0] : '';
    if (call.booked) {
      out.parts.push(call.urgency === 'priority' ? 'You\'re welcome' + first + '. Help is on the way. Stay cool!' : 'You\'re welcome' + first + '. We\'ll see you ' + call.booked.dayLabel + '.');
      end(call, 'booked', out);
    } else {
      out.parts.push('Thanks for calling ' + data.company.short + first + '. Have a good day.');
      end(call, call.outcome || (call.turns.length > 3 ? 'info' : 'abandoned'), out);
    }
  }

  function toPerson(call, out, data, why) {
    var c = data.company, S = call.slots;
    if (call.open && call.cfg.transferDuringHours) {
      out.parts.push(why === 'office' ? c.dispatcher + ' in the office can help with that. I\'m transferring you now, and I\'ll pass along what you\'ve told me.'
        : (why === 'request' ? 'Of course. ' : '') + 'I\'m transferring you to ' + c.dispatcher + ' in dispatch now, and I\'ll pass along what you\'ve told me so far.');
      call.transfer = { to: 'dispatcher', name: c.dispatcher, why: why };
      out.guard.push('Handed to a person (' + (why === 'request' ? 'caller asked' : why === 'office' ? 'office matter' : why === 'clarify' ? 'not understood' : 'no opening') + ') with the details so far');
      end(call, 'transferred', out, { type: 'transfer', to: 'dispatcher', name: c.dispatcher });
      return;
    }
    var op = nextOpening(data, call);
    call.mode = 'callback';
    call.callback = { by: c.dispatcher, when: op ? op.label : 'when we open', why: why };
    out.parts.push((call.open ? 'Our team is with customers right now' : 'The office is closed right now') + ', so I\'ll set up a call back from ' + c.dispatcher + (op && !call.open ? ' ' + op.label : call.open ? ' within the hour' : '') + '.');
    out.guard.push('No live transfer available: callback set instead');
    if (call.open) call.callback.when = 'within the hour';
    next(call, out, data);
  }

  function next(call, out, data, ctx) {
    var S = call.slots, cfg = call.cfg;
    if (call.ended) return;
    if (call.mode === 'oncall') {
      if (!S.name) return ask(call, out, 'name');
      if (!S.zip || !S.zone) return ask(call, out, S.zip && !S.zone ? 'address_retry' : S.street ? 'zip' : 'address');
      if (!S.street) return ask(call, out, 'street');
      if (!S.phone) return ask(call, out, 'phone');
      var tech = techById(data, data.onCall.tech);
      out.parts.push(tech.name + ', our on-call technician, has your details and will call you back within ' + cfg.onCallCallbackMinutes + ' minutes. ' + data.prices.afterHours.text + ' Keep the water off until then. Help is on the way' + (S.name ? ', ' + S.name.split(' ')[0] : '') + '.');
      call.alerts.push('ON-CALL PAGE: ' + call.emergency.label + '. ' + (S.name || 'Caller') + ', ' + S.phone + ', ' + S.street + ' ' + S.zip + '. Call back within ' + cfg.onCallCallbackMinutes + ' minutes.');
      out.guard.push('On-call technician paged with name, address and callback number');
      end(call, 'oncall_dispatch', out, { type: 'page', to: 'oncall', name: tech.name });
      return;
    }
    if (call.mode === 'callback') {
      if (!S.name) return ask(call, out, 'name');
      if (!S.phone) return ask(call, out, 'phone');
      out.parts.push('Thanks' + (S.name ? ', ' + S.name.split(' ')[0] : '') + '. ' + call.callback.by + ' will call you at ' + S.phone + ' ' + call.callback.when + '. Goodbye for now.');
      call.alerts.push('CALLBACK: ' + (S.name || 'Caller') + ', ' + S.phone + ', ' + call.callback.when + '.');
      end(call, 'callback', out, { type: 'callback', by: call.callback.by, when: call.callback.when });
      return;
    }
    if (call.booked) {
      if (cfg.offerTexts && S.consent === null) return ask(call, out, 'consent');
      if (!call.confirmed) return confirmBooking(call, out, data);
      return ask(call, out, 'anything_else');
    }
    if (!S.service) return ask(call, out, call.pending === 'book_offer' || call.pending === 'estimate_offer' ? call.pending : 'reason');
    var svc = serviceById(data, S.service);
    if (svc && svc.heatCheck && call.urgency === 'normal' && S.vulnerable === null && call.highF >= cfg.heatPriorityF) return ask(call, out, 'heat');
    if (!S.name) return ask(call, out, 'name');
    if (!S.zip) return ask(call, out, S.street ? 'zip' : 'address');
    if (!S.zone) return ask(call, out, 'address_retry');
    if (!S.street) return ask(call, out, 'street');
    if (!S.phone) return ask(call, out, call.callerId ? 'phone' : 'phone_new');
    if (!call.offers.length) {
      var w = findWindows(data, call, {}, ctx);
      if (!w.length) { out.parts.push('I\'m not finding an opening this week.'); toPerson(call, out, data, 'noslot'); return; }
      call.offers = w;
      var lead = call.urgency === 'priority' ? 'Since this is a heat priority, I\'m looking at today first.' : call.urgency === 'urgent' ? 'Since this is urgent, here\'s the earliest I have.' : '';
      if (lead) out.parts.push(lead);
      if ((call.urgency !== 'normal') && w[0].day > 0) {
        call.alerts.push('No same-day opening for a ' + (call.urgency === 'priority' ? 'heat priority' : 'urgent') + ' call. Dispatcher to look for a sooner slot.');
        out.parts.push('Nothing is open today, so I\'ve also flagged this for our dispatcher to find a sooner time.');
      }
    }
    return ask(call, out, 'window');
  }

  function ask(call, out, key) {
    var again = out.reask && call.pending === key;
    call.pending = key;
    var Q = {
      reason: 'How can I help you today?',
      heat: 'With ' + call.highF + ' degrees out today, I want to get you the earliest time. Is anyone in the home elderly, an infant, or unwell?',
      name: 'Can I get your name?',
      address: 'What\'s the address there, including the ZIP code?',
      zip: 'And the ZIP code?',
      street: 'And the street address?',
      phone: 'Is ' + call.callerId + ' the best number to reach you?',
      phone_new: 'What\'s the best number to reach you?',
      consent: 'Can I text you a confirmation and a reminder? You can reply STOP at any time.',
      anything_else: 'Is there anything else I can help with?',
      book_offer: 'Would you like me to book a visit?',
      estimate_offer: 'Would you like a free estimate?',
      address_retry: 'Is there another address I can help with?'
    };
    if (key === 'window') { out.parts.push(sayOffers(call)); return; }
    if (key === 'phone' && !call.callerId) { call.pending = 'phone_new'; key = 'phone_new'; }
    var q = Q[key] || 'How can I help?';
    if (again && key === 'name') q = 'Could you tell me your name again?';
    out.parts.push(q);
  }

  function priceAnswer(call, u, out, data) {
    var n = u.n, P = data.prices;
    if (/\b(compressor|capacitor|coil|motor|repipe|re pipe|duct|ducts|ductwork|replace the water heater|new water heater)\b/.test(n) && u.service !== 'estimate') {
      out.guard.push('Price not on the price list: no guess, diagnostic explained');
      return 'That price depends on what the technician finds, so I won\'t guess. ' + P.diagnostic.text;
    }
    if (u.service === 'estimate' || (call.slots.service === 'estimate' && !u.service)) {
      out.guard.push('System price not on the price list: no guess, free estimate offered');
      return 'I can\'t give a price for a new system over the phone, because it depends on the home and the equipment. ' + P.estimate.text;
    }
    if (/\b(after hours|after-hours|weekend|weekends|night|tonight|emergency|holiday)\b/.test(n) || call.mode === 'oncall') return P.afterHours.text;
    if (u.service === 'tune_up' || /\btune/.test(n)) return P.tuneUp.text;
    if (u.service === 'drain') return P.drain.text;
    out.guard.push('Price given from the price list only');
    return P.diagnostic.text;
  }

  function areaAnswer(call, u, data, out) {
    var e = u.entities;
    if (e.zip) {
      var z = zoneFor(e.zip, data);
      if (!z) out.guard.push('Outside the service area (' + e.zip + ')');
      return z ? 'Yes, we cover ' + e.zip + ' in ' + z.name + '.' : 'Sorry, ' + e.zip + ' is outside our service area. We cover ' + data.company.areaText + '.';
    }
    if (u.city) return u.city.inside ? 'Yes, we cover ' + u.city.name + '.' : 'Sorry, we don\'t cover ' + u.city.name + ' yet. We cover ' + data.company.areaText + '.';
    return 'We cover ' + data.company.areaText + '.';
  }

  // ---------------------------------------------------------------- after the call
  function summarize(call, data) {
    var S = call.slots, svc = serviceById(data, S.service), zone = zoneById(data, S.zone), b = call.booked;
    var outcome = call.outcome || (b ? 'booked' : 'abandoned');
    var first = S.name ? S.name.split(' ')[0] : null;
    var words = call.turns.reduce(function (a, t) { return a + String(t.text).split(/\s+/).length; }, 0);
    var smsOk = call.cfg.offerTexts && S.consent === true;
    var sms = null;
    if (smsOk && b) sms = data.company.short + ': Hi' + (first ? ' ' + first : '') + ', you\'re booked for ' + lowerFirst(b.service) + ' ' + b.dayLabel + ', ' + b.spanLabel + '. ' + b.techName + ' will text when on the way. Reply STOP to opt out.';
    var urgencyLabel = { danger: 'Danger', urgent: 'Urgent', priority: 'Heat priority', normal: 'Normal' }[call.urgency];
    var headline = {
      booked: 'Booked: ' + (b ? b.service + ', ' + b.dayLabel + ' ' + b.spanLabel : ''),
      emergency_transfer: 'Emergency: ' + (call.emergency ? call.emergency.label.toLowerCase() : '') + '. Transferred to ' + (call.transfer ? call.transfer.name : 'a person'),
      oncall_dispatch: 'On-call paged: ' + (call.emergency ? call.emergency.label.toLowerCase() : '') + (zone ? ' in ' + zone.name : ''),
      transferred: 'Transferred to ' + (call.transfer ? call.transfer.name : 'a person'),
      callback: 'Callback: ' + (call.callback ? call.callback.by + ', ' + call.callback.when : ''),
      out_of_area: 'Outside the service area' + (S.zip ? ' (' + S.zip + ')' : ''),
      spam: 'Sales call ended',
      info: 'Questions answered',
      abandoned: 'Caller ended early'
    }[outcome] + (outcome === 'booked' && call.urgency === 'priority' ? ' (heat priority)' : '');
    var tags = ['phone-ai', outcome.replace(/_/g, '-')];
    if (call.urgency !== 'normal') tags.push(call.urgency === 'priority' ? 'heat-priority' : call.urgency);
    if (!call.open) tags.push('after-hours');
    if (S.consent === true) tags.push('sms-consent'); else if (S.consent === false) tags.push('no-sms');
    var notes = [];
    if (S.problem) notes.push('Caller said: "' + S.problem + '"');
    if (S.indoorF) notes.push('Indoor temperature: ' + S.indoorF + '°F (caller)');
    if (S.vulnerable) notes.push('Vulnerable person at home');
    notes = notes.concat(call.notes);
    return {
      id: call.id, date: call.when.date, time: clock(call.when.minutes), weekday: DAYS[call.when.weekday], afterHours: !call.open,
      outcome: outcome, outcomeLabel: OUTCOMES[outcome], headline: headline, urgency: call.urgency, urgencyLabel: urgencyLabel,
      emergency: call.emergency ? call.emergency.label : null,
      name: S.name, phone: S.phone || call.callerId, callerId: call.callerId, street: S.street, zip: S.zip, area: zone ? zone.name : null,
      service: svc ? svc.label : null, problem: S.problem, indoorF: S.indoorF, vulnerable: S.vulnerable,
      appointment: b ? { label: b.dayLabel + ', ' + b.spanLabel, date: b.date, window: hhmm(b.start) + '-' + hhmm(b.end), tech: b.techName, plannedArrival: clock(b.arrive) } : null,
      transfer: call.transfer, callback: call.callback, consent: S.consent,
      sms: sms, ownerAlert: call.alerts.length ? call.alerts.join(' ') : null,
      guardrails: call.guardrails.slice(), notes: notes,
      turns: call.turns.length, durationSec: Math.round(words / 2.6 + call.turns.length * 0.8),
      crm: {
        contact: { name: S.name, phone: S.phone || call.callerId, address: S.street, zip: S.zip, smsConsent: S.consent === true },
        job: b ? { type: b.service, date: b.date, window: hhmm(b.start) + '-' + hhmm(b.end), technician: b.techName, priority: urgencyLabel } : null,
        source: 'Phone (AI receptionist)', outcome: outcome, tags: tags, notes: notes
      }
    };
  }

  function callLog(records) {
    var m = { calls: 0, booked: 0, emergencies: 0, transfers: 0, afterHours: 0, spam: 0, callbacks: 0 };
    (records || []).forEach(function (r) {
      m.calls++;
      if (r.outcome === 'booked') m.booked++;
      if (r.outcome === 'emergency_transfer' || r.outcome === 'oncall_dispatch') m.emergencies++;
      if (r.outcome === 'transferred' || r.outcome === 'emergency_transfer') m.transfers++;
      if (r.afterHours) m.afterHours++;
      if (r.outcome === 'spam') m.spam++;
      if (r.outcome === 'callback') m.callbacks++;
    });
    var real = m.calls - m.spam;
    m.bookedRate = real ? Math.round(m.booked / real * 100) : 0;
    return m;
  }

  // Plays a sample call's caller lines through the engine (used by the page and the tests).
  function runScript(data, sample, ctx, cfgOver) {
    var call = startCall(data, { now: sample.now, callerId: sample.callerId, id: 'sample-' + sample.id, config: cfgOver });
    var results = [];
    for (var i = 0; i < sample.lines.length && !call.ended; i++) results.push(respond(call, sample.lines[i], data, ctx));
    return { call: call, results: results, summary: summarize(call, data) };
  }

  return {
    DEFAULTS: DEFAULTS, OUTCOMES: OUTCOMES,
    prepare: prepare, startCall: startCall, respond: respond, summarize: summarize, callLog: callLog, runScript: runScript,
    findWindows: findWindows, busyOn: busyOn, understand: understand, zoneFor: zoneFor, hoursText: hoursText, isOpen: isOpen,
    parseNow: parseNow, clock: clock, span: span, toSpeech: toSpeech, norm: norm,
    extractPhone: extractPhone, extractAddress: extractAddress, extractName: extractName, yesNo: yesNo,
    detectService: detectService, detectEmergency: detectEmergency, vulnerable: vulnerable, parsePref: parsePref
  };
});
