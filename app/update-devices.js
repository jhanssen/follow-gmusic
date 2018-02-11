/*global module*/

module.exports = function(json, state) {
    if (!("room" in json))
        return;
    console.log("updated device", json);
    state.casts[json.room] = json.cast;
};
