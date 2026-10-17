// The first script of the built page: until page.js installs the in-page host, any WebSocket the page opens
// fails here instead of reaching the network. If the engine or the host fails to load, game.js stops on this.
(function (global) {
  "use strict";
  global.WebSocket = function WebSocket() {
    throw new Error("GameOfAILife: the in-page city did not start");
  };
})(typeof window !== "undefined" ? window : globalThis);
