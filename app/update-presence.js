/*global module*/

module.exports = function(json, state) {
    console.log("got presence", json);
    state.presence[json.uuid] = json.cur;
    if (json.uuid in state.playing) {
        state.playing[json.uuid].updatePresence(json);
    }
};
