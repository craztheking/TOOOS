// ── The Odd One Out — Game Server ─────────────────────────────────────────────
// Node.js WebSocket server. Deploy to Railway.
// Required: npm install ws
//
// Message protocol (all JSON):
//   Client → Server: { type, roomCode, payload }
//   Server → Client: { type, payload }
//
// Room lifecycle:
//   create_room → join_room → start_game → answer_submit → discussion →
//   vote_cast / accuse → reveal → next_round / end_game

const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3001;
const wss = new WebSocketServer({ port: PORT });

// ── State ──────────────────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode → Room
const clientRoom = new Map(); // ws → roomCode

// ── Room structure ─────────────────────────────────────────────────────────────
// {
//   code, name, password, hostId,
//   players: Map(id → { id, name, color, score, ws, connected }),
//   settings: { mode, totalRounds, discussionTime, category },
//   state: { phase, round, roundData, votes, timer },
//   timerInterval
// }

const PLAYER_COLORS = [
  "#E05C5C","#5C9FE0","#5CCE8A","#E0C15C",
  "#A05CE0","#E07A5C","#5CCEC8","#E05CB0"
];

const PHASES = {
  LOBBY:"lobby", ROLE_REVEAL:"role_reveal", ANSWERING:"answering",
  DISCUSSION:"discussion", ACCUSE:"accuse", VOTING:"voting",
  REVEAL:"reveal", SCOREBOARD:"scoreboard",
};

const MODES = { QUESTIONER:"questioner", VOTE:"vote" };

// ── Helpers ────────────────────────────────────────────────────────────────────
function randCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}
function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}
function uid() {
  return Math.random().toString(36).substring(2,10);
}

function send(ws, type, payload={}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(room, type, payload={}, excludeId=null) {
  for (const [id, player] of room.players) {
    if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({ type, payload }));
    }
  }
}

function broadcastAll(room, type, payload={}) {
  broadcast(room, type, payload, null);
}

// Send different payloads to each player (for role reveals)
function broadcastPersonal(room, buildPayload) {
  for (const [id, player] of room.players) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      const payload = buildPayload(id, player);
      player.ws.send(JSON.stringify(payload));
    }
  }
}

function roomPublicState(room) {
  return {
    code: room.code,
    name: room.name,
    hasPassword: !!room.password,
    playerCount: room.players.size,
    settings: room.settings,
    phase: room.state.phase,
  };
}

function playerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
  }));
}

// ── Timer ──────────────────────────────────────────────────────────────────────
function startDiscussionTimer(room) {
  clearInterval(room.timerInterval);
  let seconds = room.settings.discussionTime;
  room.state.timerSeconds = seconds;

  room.timerInterval = setInterval(() => {
    seconds--;
    room.state.timerSeconds = seconds;
    broadcastAll(room, "timer_tick", { seconds });

    if (seconds <= 0) {
      clearInterval(room.timerInterval);
      const nextPhase = room.settings.mode === MODES.VOTE ? PHASES.VOTING : PHASES.ACCUSE;
      room.state.phase = nextPhase;
      broadcastAll(room, "phase_change", { phase: nextPhase });
    }
  }, 1000);
}

// ── Question bank (server picks questions) ─────────────────────────────────────
// Condensed set — full set can be added. Server just needs enough variety.
const QUESTIONS = {
  food: [
    {real:"Describe the perfect pizza.",imposter:"Describe the perfect burger."},
    {real:"What makes a great breakfast?",imposter:"What makes a great dinner?"},
    {real:"Describe your ideal coffee order.",imposter:"Describe your ideal tea order."},
    {real:"What is the best thing about street food?",imposter:"What is the best thing about fine dining?"},
    {real:"What makes pasta great?",imposter:"What makes rice great?"},
    {real:"Describe the perfect steak.",imposter:"Describe the perfect roast chicken."},
    {real:"What makes a great curry?",imposter:"What makes a great stew?"},
    {real:"Describe the perfect brunch.",imposter:"Describe the perfect late-night meal."},
    {real:"What is the best hangover food?",imposter:"What is the best food to eat after exercise?"},
    {real:"Describe eating something you have grown yourself.",imposter:"Describe eating something you have caught yourself."},
    {real:"What is the best drink on a hot day?",imposter:"What is the best drink on a cold day?"},
    {real:"Describe the perfect omelette.",imposter:"Describe the perfect pancake."},
    {real:"What is the best thing about Japanese food?",imposter:"What is the best thing about Korean food?"},
    {real:"Describe the perfect hot chocolate.",imposter:"Describe the perfect cup of tea."},
    {real:"What would your death row meal be?",imposter:"What would your birthday meal be?"},
    {real:"What is the ultimate comfort food on a rainy day?",imposter:"What is the ultimate refreshing food on a hot day?"},
    {real:"Describe a perfect cheese board.",imposter:"Describe a perfect charcuterie board."},
    {real:"What makes a great taco?",imposter:"What makes a great burrito?"},
    {real:"Describe your ideal breakfast in bed.",imposter:"Describe your ideal midnight snack."},
    {real:"What is the best thing about baking?",imposter:"What is the best thing about cooking?"},
  ],
  popculture: [
    {real:"Describe the best superhero movie.",imposter:"Describe the best villain movie."},
    {real:"What makes a great TV show?",imposter:"What makes a great podcast?"},
    {real:"Describe the best concert experience.",imposter:"Describe the best festival experience."},
    {real:"What is overrated about social media?",imposter:"What is overrated about reality TV?"},
    {real:"What makes a horror movie actually scary?",imposter:"What makes a comedy movie actually funny?"},
    {real:"Describe the best animated movie.",imposter:"Describe the best animated series."},
    {real:"What is the future of television?",imposter:"What is the future of cinema?"},
    {real:"What is the best thing about fan culture?",imposter:"What is the worst thing about fan culture?"},
    {real:"Describe the best decade for music.",imposter:"Describe the best decade for movies."},
    {real:"Describe binge-watching a TV series.",imposter:"Describe reading a book series back to back."},
    {real:"What is the best thing about vinyl records?",imposter:"What is the best thing about digital music?"},
    {real:"What is the most overrated movie of all time?",imposter:"What is the most underrated movie of all time?"},
    {real:"What is the greatest TV finale of all time?",imposter:"What is the worst TV finale of all time?"},
    {real:"Describe the golden age of television.",imposter:"Describe the golden age of cinema."},
    {real:"What is the best sitcom of all time?",imposter:"What is the best drama series of all time?"},
    {real:"What is the best plot twist in TV history?",imposter:"What is the best plot twist in movie history?"},
    {real:"Describe the appeal of reality dating shows.",imposter:"Describe the appeal of competition cooking shows."},
    {real:"What is the best thing about the Marvel universe?",imposter:"What is the best thing about the DC universe?"},
    {real:"What made Friends so iconic?",imposter:"What made The Office so iconic?"},
    {real:"Describe the perfect road trip playlist.",imposter:"Describe the perfect gym playlist."},
  ],
  travel: [
    {real:"Describe your ideal beach holiday.",imposter:"Describe your ideal mountain holiday."},
    {real:"What is the worst part about flying?",imposter:"What is the worst part about long car journeys?"},
    {real:"Describe the best city in the world.",imposter:"Describe the best country in the world."},
    {real:"Describe travelling solo.",imposter:"Describe travelling with friends."},
    {real:"What is the best thing about budget travel?",imposter:"What is the best thing about luxury travel?"},
    {real:"Describe the most underrated travel destination.",imposter:"Describe the most overrated travel destination."},
    {real:"Describe a perfect road trip.",imposter:"Describe a perfect rail journey."},
    {real:"What do you always forget to pack?",imposter:"What do you always overpack?"},
    {real:"Describe a safari.",imposter:"Describe a cruise."},
    {real:"Describe the airport experience.",imposter:"Describe the train station experience."},
    {real:"What is the best souvenir you could bring home?",imposter:"What is the worst souvenir you could bring home?"},
    {real:"Describe the best type of holiday weather.",imposter:"Describe the worst type of holiday weather."},
    {real:"Describe backpacking through Southeast Asia.",imposter:"Describe backpacking through South America."},
    {real:"What makes a city worth visiting?",imposter:"What makes a country worth visiting?"},
    {real:"Describe the experience of getting lost abroad.",imposter:"Describe the experience of missing a flight."},
    {real:"What is the weirdest thing you have eaten abroad?",imposter:"What is the weirdest thing you have seen abroad?"},
    {real:"Describe visiting Machu Picchu.",imposter:"Describe visiting Angkor Wat."},
    {real:"Describe island-hopping in Greece.",imposter:"Describe hiking the Camino de Santiago."},
    {real:"What is the most romantic travel destination?",imposter:"What is the most adventure-focused travel destination?"},
    {real:"Describe the feeling of arriving somewhere new for the first time.",imposter:"Describe the feeling of returning somewhere you love."},
  ],
  history: [
    {real:"Describe the most important invention in history.",imposter:"Describe the most destructive invention in history."},
    {real:"What was the best era to live in?",imposter:"What was the worst era to live in?"},
    {real:"Describe what life was like in ancient Rome.",imposter:"Describe what life was like in ancient Egypt."},
    {real:"Describe the French Revolution in one sentence.",imposter:"Describe the American Revolution in one sentence."},
    {real:"What was the most significant battle in history?",imposter:"What was the most pointless war in history?"},
    {real:"Describe life during World War II.",imposter:"Describe life during the Cold War."},
    {real:"Describe the space race.",imposter:"Describe the arms race."},
    {real:"Describe the Renaissance.",imposter:"Describe the Industrial Revolution."},
    {real:"Who was the greatest leader in history?",imposter:"Who was the most dangerous leader in history?"},
    {real:"Describe the Viking Age.",imposter:"Describe the Age of Exploration."},
    {real:"Describe the fall of the Berlin Wall.",imposter:"Describe the fall of the Soviet Union."},
    {real:"What was the biggest mistake of the 20th century?",imposter:"What was the greatest achievement of the 20th century?"},
    {real:"Describe a day in the life of a Roman soldier.",imposter:"Describe a day in the life of a medieval knight."},
    {real:"Describe the causes of World War I.",imposter:"Describe the causes of World War II."},
    {real:"Who was the most influential philosopher in history?",imposter:"Who was the most influential scientist in history?"},
    {real:"Describe ancient Greek democracy.",imposter:"Describe ancient Roman law."},
    {real:"What was the most pivotal year in the 20th century?",imposter:"What was the most pivotal year in the 19th century?"},
    {real:"Describe the building of the Great Wall of China.",imposter:"Describe the building of the Egyptian pyramids."},
    {real:"What historical figure would you most want to have dinner with?",imposter:"What historical figure would you least want to meet?"},
    {real:"Describe the impact of the moon landing.",imposter:"Describe the impact of splitting the atom."},
  ],
  science: [
    {real:"Describe how black holes work.",imposter:"Describe how neutron stars work."},
    {real:"What is the most impressive thing about the human brain?",imposter:"What is the most impressive thing about the human immune system?"},
    {real:"What is the biggest unsolved problem in physics?",imposter:"What is the biggest unsolved problem in biology?"},
    {real:"What makes artificial intelligence dangerous?",imposter:"What makes artificial intelligence exciting?"},
    {real:"What would happen if we found alien life?",imposter:"What would happen if we found a second Earth?"},
    {real:"Describe quantum mechanics to a five-year-old.",imposter:"Describe relativity to a five-year-old."},
    {real:"Describe the Big Bang.",imposter:"Describe the heat death of the universe."},
    {real:"What is the future of space exploration?",imposter:"What is the future of deep sea exploration?"},
    {real:"Describe how vaccines work.",imposter:"Describe how antibiotics work."},
    {real:"What would a world without gravity be like?",imposter:"What would a world without oxygen be like?"},
    {real:"Describe how a star is born.",imposter:"Describe how a star dies."},
    {real:"Describe the science of sleep.",imposter:"Describe the science of dreams."},
    {real:"What would happen if we could stop ageing?",imposter:"What would happen if we could download the human brain?"},
    {real:"Describe the science behind earthquakes.",imposter:"Describe the science behind hurricanes."},
    {real:"What would happen if we colonised Mars?",imposter:"What would happen if we colonised the Moon?"},
    {real:"Describe how coral reefs work.",imposter:"Describe how rainforests work."},
    {real:"Describe the science of consciousness.",imposter:"Describe the science of self-awareness."},
    {real:"What is the most terrifying fact about the sun?",imposter:"What is the most terrifying fact about black holes?"},
    {real:"Describe how CRISPR could cure diseases.",imposter:"Describe how AI could revolutionise medicine."},
    {real:"What would a world with two suns be like?",imposter:"What would a world with two moons be like?"},
  ],
  mystery: [
    {real:"Describe the perfect murder mystery.",imposter:"Describe the perfect heist story."},
    {real:"What makes a great detective?",imposter:"What makes a great criminal mastermind?"},
    {real:"Describe the most famous unsolved crime.",imposter:"Describe the most famous wrongful conviction."},
    {real:"Describe the Zodiac Killer case.",imposter:"Describe the Jack the Ripper case."},
    {real:"What would you do if you witnessed a crime?",imposter:"What would you do if you were accused of a crime?"},
    {real:"Describe the perfect alibi.",imposter:"Describe the perfect getaway."},
    {real:"What makes forensic science so powerful?",imposter:"What makes eyewitness testimony so unreliable?"},
    {real:"What is the scariest conspiracy theory?",imposter:"What is the most believable conspiracy theory?"},
    {real:"Describe the most audacious bank robbery.",imposter:"Describe the most audacious art theft."},
    {real:"What makes a cold case impossible to solve?",imposter:"What makes a cold case suddenly solvable?"},
    {real:"What drives someone to commit murder?",imposter:"What drives someone to commit fraud?"},
    {real:"Describe the best Agatha Christie novel.",imposter:"Describe the best Sherlock Holmes story."},
    {real:"Describe how the Mafia operates.",imposter:"Describe how a drug cartel operates."},
    {real:"What is the most chilling unsolved murder?",imposter:"What is the most chilling unsolved robbery?"},
    {real:"Describe the experience of being an undercover police officer.",imposter:"Describe the experience of being in witness protection."},
    {real:"What would your perfect crime be?",imposter:"What would your perfect escape plan be?"},
    {real:"Describe the most incredible heist in history.",imposter:"Describe the most incredible con in history."},
    {real:"What is the best fictional detective of all time?",imposter:"What is the best fictional criminal of all time?"},
    {real:"Describe how money laundering works.",imposter:"Describe how identity theft works."},
    {real:"What makes someone a con artist?",imposter:"What makes someone a fraudster?"},
  ],
  gaming: [
    {real:"Describe your all-time favourite video game.",imposter:"Describe your all-time favourite board game."},
    {real:"What makes a great open world game?",imposter:"What makes a great linear story game?"},
    {real:"What is the best gaming console ever made?",imposter:"What is the best gaming handheld ever made?"},
    {real:"What makes a great RPG?",imposter:"What makes a great strategy game?"},
    {real:"What is overrated about battle royale games?",imposter:"What is overrated about first-person shooters?"},
    {real:"What is the most overrated game of all time?",imposter:"What is the most underrated game of all time?"},
    {real:"Describe the appeal of esports.",imposter:"Describe the appeal of speedrunning."},
    {real:"What makes a great horror game?",imposter:"What makes a great survival game?"},
    {real:"What is the best game franchise of all time?",imposter:"What is the best indie game ever made?"},
    {real:"What is the best thing about Nintendo?",imposter:"What is the best thing about PlayStation?"},
    {real:"Describe the most satisfying moment in gaming.",imposter:"Describe the most frustrating moment in gaming."},
    {real:"Describe the appeal of farming and simulation games.",imposter:"Describe the appeal of city builder games."},
    {real:"What is the biggest gaming controversy of all time?",imposter:"What is the biggest gaming disappointment of all time?"},
    {real:"What makes a great puzzle game?",imposter:"What makes a great platformer?"},
    {real:"Describe the appeal of Pokemon.",imposter:"Describe the appeal of Zelda."},
    {real:"What is the most satisfying ending in gaming history?",imposter:"What is the most disappointing ending in gaming history?"},
    {real:"What is the best thing about retro gaming?",imposter:"What is the best thing about modern gaming?"},
    {real:"Describe what made GTA San Andreas so iconic.",imposter:"Describe what made Skyrim so iconic."},
    {real:"What is the best thing about the Dark Souls series?",imposter:"What is the best thing about the Witcher series?"},
    {real:"Describe the most iconic video game character ever created.",imposter:"Describe the most iconic video game level ever designed."},
  ],
  sport: [
    {real:"Describe the perfect football match.",imposter:"Describe the perfect rugby match."},
    {real:"What makes a great athlete?",imposter:"What makes a great coach?"},
    {real:"Describe the best Olympic moment of all time.",imposter:"Describe the best World Cup moment of all time."},
    {real:"Describe the most impressive comeback in sports history.",imposter:"Describe the most heartbreaking defeat in sports history."},
    {real:"What makes a great sports rivalry?",imposter:"What makes a great sports partnership?"},
    {real:"What is the most gruelling sport in the world?",imposter:"What is the most technical sport in the world?"},
    {real:"Describe the appeal of extreme sports.",imposter:"Describe the appeal of endurance sports."},
    {real:"What is the biggest scandal in sports history?",imposter:"What is the biggest upset in sports history?"},
    {real:"Describe the appeal of cricket.",imposter:"Describe the appeal of baseball."},
    {real:"What is the best thing about the Premier League?",imposter:"What is the best thing about the Champions League?"},
    {real:"Describe the appeal of golf.",imposter:"Describe the appeal of snooker."},
    {real:"What is the best thing about the Olympics?",imposter:"What is the best thing about the Paralympic Games?"},
    {real:"Describe the most dramatic penalty shootout ever.",imposter:"Describe the most dramatic last-minute winner ever."},
    {real:"What is the best underdog story in sports history?",imposter:"What is the best dynasty story in sports history?"},
    {real:"Describe the impact of Usain Bolt on athletics.",imposter:"Describe the impact of Michael Jordan on basketball."},
    {real:"What makes a great sports documentary?",imposter:"What makes a great sports biography?"},
    {real:"What is the most impressive athletic feat ever achieved?",imposter:"What is the most impressive sports record ever broken?"},
    {real:"What is the best sport to play casually?",imposter:"What is the best sport to watch casually?"},
    {real:"Describe what separates a good player from a great one.",imposter:"Describe what separates a great player from a legend."},
    {real:"What is the best thing about mixed martial arts?",imposter:"What is the best thing about boxing?"},
  ],
  spicy: [
    {real:"Describe your worst date ever.",imposter:"Describe your most awkward date ever."},
    {real:"What is the most embarrassing thing you have done sober?",imposter:"What is the most embarrassing thing you have done drunk?"},
    {real:"What is the biggest lie you have ever told?",imposter:"What is the biggest secret you have kept?"},
    {real:"What would your ex say about you?",imposter:"What would your best friend say about you?"},
    {real:"Describe your most controversial opinion.",imposter:"Describe your most unpopular opinion."},
    {real:"Describe ghosting someone.",imposter:"Describe being ghosted."},
    {real:"What is the pettiest thing you have ever done?",imposter:"What is the most passive-aggressive thing you have ever done?"},
    {real:"Describe the most dramatic breakup you have witnessed.",imposter:"Describe the most dramatic argument you have witnessed."},
    {real:"Describe your most toxic trait.",imposter:"Describe your most annoying habit."},
    {real:"What is something you pretend to like but secretly hate?",imposter:"What is something you pretend to hate but secretly like?"},
    {real:"What would your search history reveal about you?",imposter:"What would your messages reveal about you?"},
    {real:"What is the most irresponsible thing you have done?",imposter:"What is the most impulsive thing you have done?"},
    {real:"Describe the moment you knew a relationship was over.",imposter:"Describe the moment you knew a friendship was over."},
    {real:"What is something you have never admitted to anyone?",imposter:"What is something you have never admitted to yourself?"},
    {real:"Describe being rejected by someone you liked.",imposter:"Describe rejecting someone who liked you."},
    {real:"Describe your worst ever hangover.",imposter:"Describe the worst night out that ended badly."},
    {real:"What is your most irrational fear?",imposter:"What is your most irrational habit?"},
    {real:"Describe catching someone in a lie.",imposter:"Describe being caught in a lie."},
    {real:"What is the most money you have wasted on something stupid?",imposter:"What is the most time you have wasted on something stupid?"},
    {real:"Describe your social media persona versus your real self.",imposter:"Describe your work persona versus your real self."},
  ],
};
QUESTIONS.all = Object.values(QUESTIONS).flat();

// ── Game logic ─────────────────────────────────────────────────────────────────
function beginRound(room) {
  clearInterval(room.timerInterval);
  const { settings } = room;
  const pool = QUESTIONS[settings.category] || QUESTIONS.all;
  const pair = rand(pool);
  const playerIds = shuffle([...room.players.keys()]);

  const isVoteMode = settings.mode === MODES.VOTE;
  const questionerId = isVoteMode ? null : playerIds[0];
  const imposterId   = isVoteMode ? playerIds[0] : playerIds[1];

  room.state.round++;
  room.state.roundData = {
    questionerId,
    imposterId,
    pair,
    answers: {},      // playerId → answer string
    accusedId: null,
    votes: {},        // voterId → targetId
    voteTally: {},
  };
  room.state.phase = PHASES.ROLE_REVEAL;

  // Send each player their personal role info
  broadcastPersonal(room, (id, player) => {
    const isQ   = id === questionerId;
    const isImp = id === imposterId;
    let role, topic;
    if (isQ)        { role = "questioner"; topic = pair.real; }
    else if (isImp) { role = "impostor";   topic = pair.imposter; }
    else            { role = "player";     topic = pair.real; }

    return {
      type: "round_start",
      payload: {
        round: room.state.round,
        totalRounds: settings.totalRounds,
        role,
        topic,
        realQuestion: pair.real,
        players: playerList(room),
      }
    };
  });
}

function endRound(room) {
  clearInterval(room.timerInterval);
  const { roundData } = room.state;

  // Calculate scores
  const isVote = room.settings.mode === MODES.VOTE;
  if (isVote) {
    // tally votes
    const tally = {};
    Object.values(roundData.votes).forEach(t => { tally[t] = (tally[t]||0)+1; });
    roundData.voteTally = tally;
    const maxV = Math.max(...Object.values(tally), 0);
    const winners = Object.keys(tally).filter(k => tally[k]===maxV);
    const accused = winners[Math.floor(Math.random()*winners.length)];
    roundData.accusedId = accused;
    const caught = accused === roundData.imposterId;
    for (const [id, player] of room.players) {
      if (id === roundData.imposterId) {
        if (!caught) player.score += 3;
      } else {
        if (roundData.votes[id] === roundData.imposterId) player.score += 1;
      }
    }
  } else {
    const caught = roundData.accusedId === roundData.imposterId;
    for (const [id, player] of room.players) {
      if (id === roundData.questionerId && caught)    player.score += 2;
      if (id === roundData.imposterId  && !caught)   player.score += 3;
    }
  }

  room.state.phase = PHASES.REVEAL;

  broadcastAll(room, "round_reveal", {
    round: room.state.round,
    totalRounds: room.settings.totalRounds,
    pair: roundData.pair,
    answers: roundData.answers,
    imposterId: roundData.imposterId,
    questionerId: roundData.questionerId,
    accusedId: roundData.accusedId,
    voteTally: roundData.voteTally || {},
    mode: room.settings.mode,
    players: playerList(room),
  });
}

// ── WebSocket handler ──────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  ws.id = uid();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    switch (type) {

      // ── LIST PUBLIC ROOMS ────────────────────────────────────────────────────
      case "list_rooms": {
        const publicRooms = [...rooms.values()]
          .filter(r => !r.password && r.state.phase === PHASES.LOBBY)
          .map(roomPublicState);
        send(ws, "rooms_list", { rooms: publicRooms });
        break;
      }

      // ── CREATE ROOM ──────────────────────────────────────────────────────────
      case "create_room": {
        const { playerName, roomName, password, settings } = payload;
        if (!playerName?.trim()) return send(ws, "error", { message: "Name required" });

        let code;
        do { code = randCode(); } while (rooms.has(code));

        const playerId = ws.id;
        const color = PLAYER_COLORS[0];
        const player = { id: playerId, name: playerName.trim(), color, score: 0, ws, connected: true };

        const room = {
          code,
          name: roomName?.trim() || `${playerName.trim()}'s Room`,
          password: password?.trim() || null,
          hostId: playerId,
          players: new Map([[playerId, player]]),
          settings: {
            mode: settings?.mode || MODES.QUESTIONER,
            totalRounds: Math.min(30, Math.max(6, settings?.totalRounds || 6)),
            discussionTime: settings?.discussionTime || 90,
            category: settings?.category || "all",
          },
          state: { phase: PHASES.LOBBY, round: 0, roundData: null, timerSeconds: 0 },
          timerInterval: null,
        };

        rooms.set(code, room);
        clientRoom.set(ws, code);

        send(ws, "room_created", {
          code,
          roomName: room.name,
          playerId,
          players: playerList(room),
          settings: room.settings,
          isHost: true,
        });
        break;
      }

      // ── JOIN ROOM ────────────────────────────────────────────────────────────
      case "join_room": {
        const { playerName, roomCode, password } = payload;
        const code = roomCode?.toUpperCase().trim();
        const room = rooms.get(code);

        if (!room)                      return send(ws, "error", { message: "Room not found" });
        if (room.state.phase !== PHASES.LOBBY) return send(ws, "error", { message: "Game already in progress" });
        if (room.players.size >= 8)     return send(ws, "error", { message: "Room is full (max 8)" });
        if (room.password && room.password !== password?.trim())
          return send(ws, "error", { message: "Wrong password" });
        if (!playerName?.trim())        return send(ws, "error", { message: "Name required" });

        const nameConflict = [...room.players.values()].find(
          p => p.name.toLowerCase() === playerName.trim().toLowerCase()
        );
        if (nameConflict) return send(ws, "error", { message: "Name already taken in this room" });

        const playerId = ws.id;
        const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
        const player = { id: playerId, name: playerName.trim(), color, score: 0, ws, connected: true };

        room.players.set(playerId, player);
        clientRoom.set(ws, code);

        // Tell the joiner their info
        send(ws, "room_joined", {
          code,
          roomName: room.name,
          playerId,
          players: playerList(room),
          settings: room.settings,
          isHost: false,
        });

        // Tell everyone else someone joined
        broadcast(room, "player_joined", {
          players: playerList(room),
          newPlayer: { id: playerId, name: player.name, color: player.color },
        }, playerId);
        break;
      }

      // ── UPDATE SETTINGS (host only) ──────────────────────────────────────────
      case "update_settings": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;
        const { settings } = payload;
        room.settings = {
          mode: settings.mode || room.settings.mode,
          totalRounds: Math.min(30, Math.max(6, settings.totalRounds || room.settings.totalRounds)),
          discussionTime: settings.discussionTime || room.settings.discussionTime,
          category: settings.category || room.settings.category,
        };
        broadcastAll(room, "settings_updated", { settings: room.settings });
        break;
      }

      // ── START GAME (host only) ───────────────────────────────────────────────
      case "start_game": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;
        if (room.players.size < 3) return send(ws, "error", { message: "Need at least 3 players" });
        if (room.state.phase !== PHASES.LOBBY) return;

        room.state.round = 0;
        for (const p of room.players.values()) p.score = 0;
        beginRound(room);
        break;
      }

      // ── SUBMIT ANSWER ────────────────────────────────────────────────────────
      case "submit_answer": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || room.state.phase !== PHASES.ANSWERING) return;
        const { answer } = payload;
        if (!answer?.trim()) return;

        const rd = room.state.roundData;
        // questioner doesn't answer
        if (ws.id === rd.questionerId) return;
        rd.answers[ws.id] = answer.trim();

        // Notify everyone of progress (not content)
        broadcastAll(room, "answer_progress", {
          answeredIds: Object.keys(rd.answers),
          totalNeeded: room.players.size - (rd.questionerId ? 1 : 0),
        });

        // Check if all non-questioners have answered
        const needed = rd.questionerId
          ? [...room.players.keys()].filter(id => id !== rd.questionerId)
          : [...room.players.keys()];
        const allAnswered = needed.every(id => rd.answers[id]);

        if (allAnswered) {
          room.state.phase = PHASES.DISCUSSION;
          broadcastAll(room, "discussion_start", {
            answers: rd.answers,
            realQuestion: rd.pair.real,
            discussionTime: room.settings.discussionTime,
            players: playerList(room),
          });
          startDiscussionTimer(room);
        }
        break;
      }

      // ── READY TO ANSWER (move from role_reveal to answering) ─────────────────
      case "player_ready": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || room.state.phase !== PHASES.ROLE_REVEAL) return;

        if (!room.state.readyPlayers) room.state.readyPlayers = new Set();
        room.state.readyPlayers.add(ws.id);

        broadcastAll(room, "ready_progress", {
          readyCount: room.state.readyPlayers.size,
          totalCount: room.players.size,
        });

        if (room.state.readyPlayers.size >= room.players.size) {
          room.state.readyPlayers = new Set();
          room.state.phase = PHASES.ANSWERING;
          broadcastAll(room, "answering_start", {
            questionerId: room.state.roundData.questionerId,
          });
        }
        break;
      }

      // ── ACCUSE (questioner mode) ─────────────────────────────────────────────
      case "accuse": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || room.state.phase !== PHASES.ACCUSE) return;
        if (ws.id !== room.state.roundData.questionerId) return;

        room.state.roundData.accusedId = payload.accusedId;
        clearInterval(room.timerInterval);
        endRound(room);
        break;
      }

      // ── VOTE ─────────────────────────────────────────────────────────────────
      case "cast_vote": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || room.state.phase !== PHASES.VOTING) return;

        const rd = room.state.roundData;
        if (rd.votes[ws.id] !== undefined) return; // already voted
        rd.votes[ws.id] = payload.targetId;

        broadcastAll(room, "vote_progress", {
          votedCount: Object.keys(rd.votes).length,
          totalVoters: room.players.size,
        });

        if (Object.keys(rd.votes).length >= room.players.size) {
          endRound(room);
        }
        break;
      }

      // ── NEXT ROUND (host only) ───────────────────────────────────────────────
      case "next_round": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;

        if (room.state.round >= room.settings.totalRounds) {
          room.state.phase = PHASES.SCOREBOARD;
          broadcastAll(room, "game_over", { players: playerList(room) });
        } else {
          beginRound(room);
        }
        break;
      }

      // ── STOP TIMER early (host only) ─────────────────────────────────────────
      case "stop_timer": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;
        clearInterval(room.timerInterval);
        const nextPhase = room.settings.mode === MODES.VOTE ? PHASES.VOTING : PHASES.ACCUSE;
        room.state.phase = nextPhase;
        broadcastAll(room, "phase_change", { phase: nextPhase });
        break;
      }

      // ── KICK PLAYER (host only) ──────────────────────────────────────────────
      case "kick_player": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;
        const { playerId } = payload;
        const target = room.players.get(playerId);
        if (!target || playerId === room.hostId) return;
        send(target.ws, "kicked", {});
        room.players.delete(playerId);
        clientRoom.delete(target.ws);
        broadcastAll(room, "player_left", { players: playerList(room), leftId: playerId });
        break;
      }

      // ── RETURN TO LOBBY (host, after game over) ──────────────────────────────
      case "return_to_lobby": {
        const code = clientRoom.get(ws);
        const room = rooms.get(code);
        if (!room || ws.id !== room.hostId) return;
        clearInterval(room.timerInterval);
        room.state = { phase: PHASES.LOBBY, round: 0, roundData: null, timerSeconds: 0 };
        for (const p of room.players.values()) p.score = 0;
        broadcastAll(room, "returned_to_lobby", { players: playerList(room) });
        break;
      }

        
    }ws.on("close", () => {
    const code = clientRoom.get(ws);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(ws.id);
    if (player) {
      player.connected = false;
      player.ws = null;
    }

    clientRoom.delete(ws);

    // If host left, assign new host
    if (room.hostId === ws.id) {
      const nextHost = [...room.players.values()].find(p => p.connected && p.ws);
      if (nextHost) {
        room.hostId = nextHost.id;
        broadcastAll(room, "host_changed", { newHostId: nextHost.id, players: playerList(room) });
      } else {
        // Everyone left — clean up room after a delay
        setTimeout(() => {
          const still = [...room.players.values()].some(p => p.connected);
          if (!still) {
            clearInterval(room.timerInterval);
            rooms.delete(code);
          }
        }, 30000);
      }
    } else {
      broadcastAll(room, "player_disconnected", {
        playerId: ws.id,
        players: playerList(room),
      });
    }
  });
});

console.log(`The Odd One Out server running on port ${PORT}`);
  });

