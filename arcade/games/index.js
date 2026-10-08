'use strict';
// Game catalog. The lobby is generated from this list.
// To add a game:
//   1. create games/<id>.js exporting function start(wss) { ... }
//   2. create public/games/<id>/index.html (connect to  /ws/<id>)
//   3. add one entry below with status: 'live'
module.exports = [
  {
    id: 'slither',
    title: 'Slither',
    emoji: '🐍',
    description: 'Eat, grow and outlive everyone else in the arena.',
    status: 'live',
    module: './slither',
  },
  {
    id: 'chess',
    title: 'Chess',
    emoji: '♟️',
    description: 'Challenge anyone who is online to a game of chess.',
    status: 'live',
    module: './chess',
  },
  { id: 'soon2', title: 'Coming soon', emoji: '🎯', description: 'Another one is being planned.', status: 'soon' },
];
