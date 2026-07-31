// en.js — English. Register: the vocabulary of Anglophone divination and
// contemplative practice — "reading" rather than "analysis", "draw" rather than
// "select", "sit with" rather than "consider". Not a literal gloss of the Chinese.
export default {
  code: 'en',
  htmlLang: 'en',
  name: 'English',
  meta: { title: 'Intuitive Notes' },

  listSep: ', ',
  labelSep: ': ',       // separator after a label, as in "Past: 1, 4, 7"
  secLabel: (name) => `[${name}]`,

  menu: {
    home: 'Home',
    history: 'My readings',
    guide: 'About the practices',
    dialogue: 'Intuitive dialogue (1-to-1 session)',
    cards: 'Your own oracle deck',
    support: 'Support this work 🍰',
    close: 'Close menu',
    open: 'Open menu',
    lang: 'Language',
  },

  intake: {
    label: 'What would you like to explore today?',
    placeholder: 'A question, a thought, an inspiration you’re after, or something you want to get clear on.',
    toolPick: 'Choose one practice',
    soon: 'Coming Soon',
    start: 'Begin the reading',
    fineprint: 'This is a space for self-reflection — not medical, legal, or financial advice. Sessions are recorded anonymously to improve the experience.',
  },

  tools: {
    lenormand: 'Lenormand · Nine-Card Grid',
    meihua: 'Plum Blossom I Ching',
    astro: 'Natal Astrology',
    bazi: 'BaZi · Four Pillars',
    ziwei: 'Zi Wei Dou Shu',
    tarot: 'Tarot',
    synthesis: 'Where the readings meet',
  },

  // Sub-labels inside the tool boxes on the home page — what each practice is good at
  toolSub: {
    lenormand: 'Situations',
    meihua: 'Decisions',
    astro: 'Self-discovery',
  },

  // The hexagram figures at the top of the I Ching section
  meihuaGrid: {
    ben: 'Primary',
    hu: 'Inner',
    bian: 'Changed',
    moving: 'Moving line',
    aria: 'Hexagrams: primary, inner, changed',
  },

  // The practices guide (menu page): the differences at a glance, then the detail
  guide: {
    title: 'About the practices',
    overviewLede: 'Each practice answers a different layer of a question.',
    cards: [
      { name: 'Lenormand · Nine-Card Grid', line: 'Best for how a situation is unfolding, and the whole picture.' },
      { name: 'Plum Blossom I Ching', line: 'Best for timing, decisions, and which way things are shifting.' },
      { name: 'Natal Astrology', line: 'Best for your own nature, your gifts, and your life’s themes.' },
    ],
    sections: [
      {
        name: 'Lenormand · Nine-Card Grid',
        lede: 'Nine cards read as one combination, opening up the past, present and future of a situation — the threads running through it, what is shaping it, and where it could go from here.',
        metaLabel: 'Origins',
        meta: 'Lenormand cards come out of 19th-century France and carry the name of the celebrated French cartomancer <b>Marie Anne Lenormand</b>. A modern deck holds 36 cards, and the reading rests on how the cards combine rather than on single meanings — which is what makes it strong on concrete situations and the way they develop.',
        asksLabel: 'Questions to try',
        asks: [
          'If I take the next step now, what should I be watching for?',
          'Give me some inspiration for a new project.',
          'How might my work / relationship / partnership develop from here?',
        ],
      },
      {
        name: 'Plum Blossom I Ching',
        lede: 'A method of casting drawn from the I Ching: the hexagram shows how a situation moves and changes — its timing, its trend, and the next step.',
        metaLabel: 'Origins',
        meta: 'The Plum Blossom method is traditionally attributed to the Northern Song philosopher <b>Shao Yong</b> (Shao Kangjie), and rests on the image, number and principle of the I Ching. A hexagram can be cast from the moment itself, from numbers, or from whatever is at hand — no tools required — and read for the state a situation is in and how it will change.',
        asksLabel: 'Questions to try',
        asks: [
          'If I take the next step now, what should I be watching for?',
          'Is this a good moment to begin this project?',
          'How might this develop from here?',
        ],
      },
      {
        name: 'Natal Astrology',
        lede: 'Working from your birth chart to open up your gifts, your temperament, the themes your life keeps returning to, and where there is room to grow — a way of knowing yourself more closely.',
        metaLabel: 'The system used',
        meta: 'This site works in <b>modern Western astrology</b>: the tropical zodiac, Placidus houses and the True Node, read together with the major planets, the houses, the aspects and the significant asteroids.',
        asksLabel: 'Questions to try',
        asks: [
          'If I set aside what other people expect of me, what do I actually want to do?',
          'I have been anxious for a while and I cannot name what is really stuck.',
          'How do I build work that genuinely fits me?',
          'There is so much I want to do — why do I never start?',
          'Suggest a direction for the way I run my social channels.',
        ],
      },
    ],
    chooseTitle: 'Not sure which to choose?',
    chooseBody: [
      'There is no wrong choice here.',
      'Put the same question to two practices and you get two angles on it. They complement each other rather than replace each other.',
    ],
    exampleLabel: 'For example:',
    exampleQ: 'How do I build work that genuinely fits me?',
    exampleRows: [
      { name: 'Natal Astrology', line: 'your gifts, your nature, and the directions that suit them.' },
      { name: 'Lenormand · Nine-Card Grid', line: 'where your work stands now, and how it could develop.' },
      { name: 'Plum Blossom I Ching', line: 'whether this is the moment to act, and what the next step is.' },
    ],
    focusLabel: 'Each one looks at a different layer:',
    focusRows: [
      { name: 'Natal Astrology', line: 'Who am I? What suits me?' },
      { name: 'Lenormand · Nine-Card Grid', line: 'How is this unfolding?' },
      { name: 'Plum Blossom I Ching', line: 'What is worth doing now?' },
    ],
    closing: 'Or simply follow your intuition. Taking one question through more than one practice gives you a fuller picture of it.',
    cta: 'Start exploring',
  },

  care: {
    title: 'Let’s pause here — someone cares',
    body: 'Thank you for putting something this heavy into words. This space isn’t able to hold what you’re carrying right now, and you deserve real company and real support.',
    lines: 'US: <b>988</b>｜UK & Ireland: <b>116 123</b>｜Worldwide directory: <b>findahelpline.com</b>',
    other: 'Wherever you are, please reach a local crisis line — or talk to one person you trust.',
    back: 'Back to the start',
  },

  step: { first: 'First, ', then: 'Now, ' },

  spread: {
    lede: 'let your intuition choose nine cards.',
    picked: (n) => `${n} of 9 chosen`,
    done: 'These nine — continue',
    reset: 'Start over',
    cardBack: 'A card, face down',
    gridAria: 'Lenormand nine-card grid',
    stripAria: 'Cards for this passage',
  },

  numbers: {
    lede: 'let your intuition swipe to three single digits (1–9).',
    done: 'These three numbers',
    random: 'Choose for me',
    byTime: 'Let this moment decide',
    chosen: (nums) => `Drawn for you at this moment — ${nums.join(' · ')}`,
    digitAria: (n) => `Digit ${n} — swipe up or down to choose`,
    blank: 'not chosen yet',
  },

  astro: {
    cityPh: 'Search by city name, e.g. London',
    countryPh: 'Search the country list, e.g. United Kingdom',
    savedHint: 'Your birth details from last time have been filled in',
    savedReset: 'Use different details',
    date: 'Date of birth',
    time: 'Time of birth',
    unknown: 'Time unknown (the Ascendant and houses will be skipped; planetary signs only)',
    city: 'Birth city (type, then choose from the list)',
    country: 'Country or region (optional — narrows the city search)',
    submit: 'Calculate the chart, continue',
    calculating: 'Casting your chart…',
    picked: (name) => `Chosen: ${name}`,
    searching: 'Searching…',
    searchFailed: 'The city search service isn’t responding right now — try again shortly, or type the city name and continue (it will be resolved when the chart is calculated).',
    emptyCity: 'No matching city — try another spelling.',
    emptyCountry: 'No matching country or region',
    err: {
      geocode: 'That city wasn’t found — type it, then pick one from the list that appears.',
      date: 'Birth year must fall between 1800 and 2399.',
      tz: 'The local time zone couldn’t be resolved. Please try again shortly.',
      generic: 'Chart calculation is briefly unavailable. Please try again shortly.',
    },
  },

  // Natal chart wheel, at the top of the astrology section
  chartWheel: {
    aria: 'Natal chart wheel: zodiac signs, houses, planetary degrees and aspects',
    approxNote: 'You didn’t give a birth time, so this wheel is calculated for noon that day: planetary positions are broadly usable, but the Moon may be off by several degrees and a sign boundary could fall either way. The Ascendant and houses can’t be determined, so no house lines are drawn.',
    // Keyed by exact angle: the backend returns Chinese aspect names, so each
    // locale translates from the number instead of matching strings.
    aspect: {
      0: 'Conjunction', 60: 'Sextile', 90: 'Square', 120: 'Trine', 180: 'Opposition',
      30: 'Semisextile', 45: 'Semisquare', 72: 'Quintile',
      135: 'Sesquiquadrate', 144: 'Biquintile', 150: 'Quincunx',
    },
    showMinor: 'Show minor aspects too',
    zoomOpen: 'Tap the wheel to zoom in on degrees and glyphs',
    zoomTitle: 'Natal chart',
    zoomHint: 'Pinch to zoom · drag to move · double-tap to enlarge',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Reset',
    zoomClose: 'Close',
  },

  weaving: {
    label: 'Reading the signs',
    // Elapsed-time stages — there's no real progress signal from the model,
    // so these only say what's happening, never a percentage or "almost done".
    stage: {
      prep: (tools) => `Gathering your ${tools} material`,
      sent: 'Sent — the reading has begun',
      reading: 'Writing your reading, section by section',
      longer: 'This one is taking longer than usual',
    },
    sub: {
      reading: 'This is the slow part — usually another 30–45 seconds.',
      longer: 'Hold on a little longer; it’s still being written.',
    },
    tips: [
      { label: 'Lenormand grid', text: 'Best for how a situation is unfolding — how it got here, and where it may go next.' },
      { label: 'Meihua Yishu', text: 'Best for timing and decisions — is now the moment to act, and in which direction.' },
      { label: 'Western astrology', text: 'Best for your own nature, gifts and life themes — who you are, what suits you.' },
      { label: 'Not sure which to pick?', text: 'There’s no wrong choice. The same question read through different tools gives you different angles — they complement each other rather than compete.' },
      { label: 'Good to know', text: 'The menu at top left keeps every reading you’ve done under "My readings" — you can go back and reread any of them.' },
      { label: 'Good to know', text: 'The menu also switches language, and opens the guide to all three tools.' },
      { label: 'About this site', text: 'If this reading helped, there’s a way to buy the author a slice of cake at the end.' },
    ],
  },

  // When the reading fails — there is no offline template, so we invite a retry
  analysisError: {
    title: 'This reading didn’t come through',
    body: 'Something broke while the reading was being written. It’s usually temporary — try again.',
    timeout: 'That took too long. A reading can take up to a minute; trying again usually does it.',
    unavailable: 'The reading service isn’t responding right now. Please try again shortly.',
    retry: 'Try again',
    home: 'Back to home',
    keep: 'Your cards and details are still here — trying again won’t make you start over.',
  },

  result: {
    titleFallback: 'Your reading',
    about: (topic) => `On “${topic}”`,
    sponsorBtn: '🍰 Buy me a slice of cake',
    sponsorSoon: 'The support link is opening soon — thank you for the thought ☕',
    copy: 'Copy this reading',
    copyFull: 'Copy the full reading',
    copied: 'Copied ✓',
    copyFail: 'Copy failed',
    // Shares the site itself — never the user's topic or reading
    share: 'Share with a friend',
    shareTitle: 'Intuitive Notes',
    shareText: 'Put whatever you want to explore into Intuitive Notes, and see what a new angle the cards, hexagrams or birth chart bring 👀🌟',
    shareCopied: 'Link copied ✓',
    shareFail: 'Could not share',
    // Following runs the other way from sharing: it brings the reader back
    followTitle: 'Follow along',
    followHint: 'This site is still growing. New tools and features get announced here first.',
    followBtn: 'Follow on Threads',
    home: 'Back to home',
    continueTitle: 'Keep going?',
    continueHint: 'Pick the AI you use — the reading carries over.',
    advanced: 'Intuitive dialogue',
    advancedHint: 'One-to-one voice session',
    advancedSoon: 'One-to-one voice sessions are still being built — opening soon.',
    myTopic: (topic) => `What I’m exploring: ${topic}`,
    signature: '— Intuitive Notes',
    cardsTitle: '[The nine cards I drew]',
    gridLegend: '[What the grid positions map to]',
    gridLayout: 'The nine cards sit in a 3×3 grid: positions 1, 2, 3 are the top row, 4, 5, 6 the middle row, 7, 8, 9 the bottom row. Each way of reading looks at these positions:',
    // Text form of the hexagram / chart, for copying and handing to an AI
    hexTitle: '[The hexagram I cast]',
    yaoOrder: 'lines, bottom to top',
    movingNth: (n) => `line ${n}`,
    chartTitle: '[My natal chart (computed with Swiss Ephemeris)]',
    bornAt: 'Birth data',
    timeUnknown: '(birth time unknown — calculated for local noon)',
    nthHouse: (n) => `house ${n}`,
    retro: 'retrograde',
    aspTitle: '[Major aspects (tightest first)]',
    handoffPrefix: 'Below is a reading I just completed on “Intuitive Notes”. Please read it through first:',
    handoffSuffix: 'Please be a warm, honest guide: working from the theme and the reading above, help me go deeper — I’ll ask about specific parts of it next.',
    aiPrefilled: 'Your reading has been carried over — just ask your question.',
    aiPrefilledCopied: 'Your reading has been carried over — just ask your question. (Also copied, as a backup.)',
    aiGemini: 'Gemini can’t be pre-filled, so the reading is on your clipboard — paste it into the new tab.',
    aiFallback: 'The tab is open. If nothing came through, come back and press “Copy this reading”, then paste.',
  },

  // Feedback on the result page (rating + optional note, sent anonymously)
  feedback: {
    title: 'Did this reading land for you?',
    hint: 'Only the developer sees this. It’s what makes the readings sharper.',
    scale: (n) => ['', 'Way off', 'A little off', 'Somewhat', 'Pretty close', 'Spot on'][n] || '',
    textPh: 'Anything you’d like to add? (optional)',
    send: 'Send feedback',
    sending: 'Sending…',
    done: 'Got it — thank you ✓',
    failed: 'Couldn’t send — please try again',
    already: (n) => `You rated this reading ${n} star${n === 1 ? '' : 's'} — thank you ✓`,
    starAria: (n) => `${n} star${n === 1 ? '' : 's'}`,
  },

  history: {
    title: 'My readings',
    sub: 'The readings you’ve left here',
    empty: 'Nothing here yet.<br>Your first reading will appear once it’s done.',
    count: (n) => (n === 1 ? '1 reading' : `${n} readings`),
    clearAll: 'Clear all',
    clearConfirm: 'Clear everything?',
    del: 'Delete',
    delConfirm: 'Delete this?',
    delAria: 'Delete this reading',
  },

  // The eight headings of the nine-card reading. First three are the columns
  // (time), next three the rows (the three forces), last two the closing
  // passages (no fixed card positions, so no card strip).
  // ⚠ These strings double as the anchors the front end uses to place the card
  // strips — change the wording and the cards stop matching.
  groups: {
    past: 'Past', present: 'Present', future: 'Emerging',
    outer: 'Around you', event: 'The situation', inner: 'Where you stand',
    combos: 'Combinations worth noting', overall: 'What it adds up to',
  },


  cards: {
    1: 'Rider', 2: 'Clover', 3: 'Ship', 4: 'House', 5: 'Tree', 6: 'Clouds',
    7: 'Snake', 8: 'Coffin', 9: 'Bouquet', 10: 'Scythe', 11: 'Whip', 12: 'Birds',
    13: 'Child', 14: 'Fox', 15: 'Bear', 16: 'Stars', 17: 'Stork', 18: 'Dog',
    19: 'Tower', 20: 'Garden', 21: 'Mountain', 22: 'Crossroads', 23: 'Mice', 24: 'Heart',
    25: 'Ring', 26: 'Book', 27: 'Letter', 28: 'Man', 29: 'Woman', 30: 'Lily',
    31: 'Sun', 32: 'Moon', 33: 'Key', 34: 'Fish', 35: 'Anchor', 36: 'Cross',
  },
};
