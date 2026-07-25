// en.js — English. Register: the vocabulary of Anglophone divination and
// contemplative practice — "reading" rather than "analysis", "draw" rather than
// "select", "sit with" rather than "consider". Not a literal gloss of the Chinese.
export default {
  code: 'en',
  htmlLang: 'en',
  name: 'English',
  meta: { title: 'Intuitive Notes' },

  listSep: ', ',

  menu: {
    home: 'Home',
    history: 'My readings',
    dialogue: 'Intuitive dialogue (1-to-1 session)',
    cards: 'Your own oracle deck',
    support: 'Support this work 🍰',
    close: 'Close menu',
    open: 'Open menu',
    lang: 'Language',
  },

  intake: {
    label: 'What would you like to explore today?',
    placeholder: 'e.g. where my work is heading',
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
    lede: 'let your intuition give three single digits (1–9).',
    done: 'These three numbers',
    random: 'Choose for me',
    byTime: 'Let this moment decide',
    chosen: (nums) => `Drawn for you at this moment — ${nums.join(' · ')}`,
  },

  astro: {
    lede: 'share your birth details, and your natal chart will be calculated from astronomical ephemerides.',
    cityPh: 'Search by city name, e.g. London',
    countryPh: 'Search the country list, e.g. United Kingdom',
    note: 'Birth details are used for the chart calculation and recorded anonymously to improve the experience. They are never shown publicly.',
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

  weaving: { label: 'Reading the signs' },

  result: {
    titleFallback: 'Your reading',
    about: (topic) => `On “${topic}”`,
    sponsorAsk: 'Did this reading speak to you?',
    sponsorBtn: '🍰 Buy me a slice of cake',
    sponsorSoon: 'The support link is opening soon — thank you for the thought ☕',
    copy: 'Copy this reading',
    copyFull: 'Copy the full reading',
    copied: 'Copied ✓',
    copyFail: 'Copy failed',
    home: 'Back to home',
    continueTitle: 'Want to keep going with this reading?',
    continueHint: 'Pick the AI you already use — this reading is carried over for you, so you can ask your next question straight away. (It’s also on your clipboard, in case it doesn’t come through.)',
    advanced: 'Intuitive dialogue',
    advancedHint: 'One-to-one voice session',
    advancedSoon: 'One-to-one voice sessions are still being built — opening soon.',
    myTopic: (topic) => `What I’m exploring: ${topic}`,
    signature: '— Intuitive Notes',
    handoffPrefix: 'Below is a reading I just completed on “Intuitive Notes”. Please read it through first:',
    handoffSuffix: 'Please be a warm, honest guide: working from the theme and the reading above, help me go deeper — I’ll ask about specific parts of it next.',
    aiPrefilled: 'Your reading has been carried over — just ask your question.',
    aiPrefilledCopied: 'Your reading has been carried over — just ask your question. (Also copied, as a backup.)',
    aiGemini: 'Gemini can’t be pre-filled, so the reading is on your clipboard — paste it into the new tab.',
    aiFallback: 'The tab is open. If nothing came through, come back and press “Copy this reading”, then paste.',
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

  groups: {
    past: 'Past', present: 'Present', future: 'Emerging',
    conscious: 'Conscious', material: 'Material', subconscious: 'Subconscious',
    heart: 'Heart', cross: 'Cross', corners: 'Corners',
  },

  offline: {
    bridge: 'Held together, these threads point to a few things:',
    invite: 'A sense of direction rarely arrives all at once, so it’s more useful not to force an answer yet. You’ve already noticed this theme — that itself is movement. Over the next few days, watch for when it surfaces again and what makes it clearer. That’s usually where the answer starts.',
    astroOnline: 'A full chart reading needs the online mode. For now, here’s what the other practices offer.',
    lenormandIntro: 'Together, these cards point to a few things:',
    closings: [
      'Answers tend to arrive when you stop reaching for them.',
      'Set the question down, keep living — the threads will surface on their own.',
      'You’ve started paying attention. That is the first step.',
    ],
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
