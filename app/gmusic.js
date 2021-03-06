/*global module,process,require,Buffer*/

"use strict";

const url = require("url");
const http = require("http");
const https = require("https");
const os = require("os");
const mdns = require("mdns");
const Mp3Parser = require("@jhanssen/mp3parser");
const { Client, DefaultMediaReceiver } = require("castv2-client");
const { BufferReadStream } = require("./bufferstream");

function findOffset(elapsedMS, stream) {
    return new Promise((resolve, reject) => {
        const parser = new Mp3Parser();
        const elapsed = elapsedMS / 1000;
        let seconds = 0;
        let resolved = false;
        parser.on("streamHeader", header => {
            if (resolved)
                return;
            seconds += header.seconds;
            if (seconds >= elapsed) {
                // will resume at header.stream_offset
                console.log("resuming at", seconds, header.stream_offset);
                resolved = true;
                resolve(header.stream_offset);
                stream.unpipe(parser);
                parser.removeAllListeners("streamHeader");
                parser.removeAllListeners("streamEnd");
            }
            //console.log("header", header);
        });
        parser.on("streamEnd", () => {
            if (!resolved) {
                reject("unable to find suitable offset");
                stream.unpipe(parser);
                parser.removeAllListeners("streamHeader");
                parser.removeAllListeners("streamEnd");
            }
        });
        stream.pipe(parser);
    });
}

function firstIPv4() {
    const ifaces = os.networkInterfaces();
    for (let k in ifaces) {
        const ifaceArray = ifaces[k];
        for (let i = 0; i < ifaceArray.length; ++i) {
            const iface = ifaceArray[i];
            if (iface.family === "IPv4") {
                if (iface.address.substr(0, 4) != "127.")
                    return iface.address;
            }
        }
    }
    return undefined;
}

function castIP(name) {
    return new Promise((resolve, reject) => {
        const browser = mdns.createBrowser(mdns.tcp("googlecast"));
        browser.on("serviceUp", service => {
            if (service.name === name) {
                resolve(service.addresses[0]);
                browser.stop();
            }
        });
        browser.start();
    });
}

const State = {
    Playing: 1,
    Stopped: 2
};

class Play {
    constructor(uuid, cast, query, state) {
        this.uuid = uuid;
        this.cast = cast;
        this.query = query;
        this.status = State.Stopped;
        this.state = state;
        this._current = 0;
        this._gstreamOffset = 0;
        this._castState = "";
        this._started = undefined;
    }

    play() {
        if (this.status == State.Playing)
            return;
        this.state.pm.search(this.query, 10, (err, data) => {
            if (err) {
                console.error("gmusic search failure", err.message);
                return;
            }
            const results = data.entries.filter(item => {
                return item.type == "1" || item.type == "3";
            });
            this._process(results).then(items => {
                this.status = State.Playing;

                this._items = items;
                this._current = 0;

                const serverAddr = firstIPv4();
                if (!serverAddr) {
                    console.error("no suitable address to listen to");
                    return;
                }

                if (this._server && this._cast && this._player) {
                    this._next();
                    return;
                }

                // make a new http server for the cast client to connect to
                const server = http.createServer((req, res) => {
                    //console.log("wanted to grab data", req);
                    this._gstream.pipe(res);
                });
                server.listen(0, serverAddr, () => {
                    console.log(`listening on ${serverAddr}`);

                    this._server = server;
                    this._castConnect().then(() => {
                        console.log(`connected to cast at ${this.cast}`);
                        this._playerSetup();
                        this._next();
                    }).catch(err => {
                        console.error("error connecting to cast", err.message);
                    });
                });
            }).catch(err => {
                console.error("unable to process?", err);
            });
        });
    }

    get playing() {
        if (!this._items)
            return undefined;
        if (this._current < this._items.length) {
            const item = this._items[this._current];
            return {
                artist: item.artist,
                albumartist: item.albumArtist,
                album: item.album,
                title: item.title
            };
        }
        return undefined;
    }

    stop() {
        this._cleanup();
    }

    next() {
        if (!this._player) {
            console.log("not playing");
        }
        if (this._current + 1 < this._items.length) {
            ++this._current;
            // to prevent our idle handler from playing the next next track
            this._castState = "";
            this._next();
        } else {
            console.log("at end");
        }
    }

    previous() {
        if (!this._player || !this._started) {
            console.log("not playing");
        }
        const elapsed = Date.now() - this._started;
        if (elapsed <= 5000) {
            if (this._current > 0) {
                --this._current;
                // to prevent our idle handler from playing the next track
                this._castState = "";
                this._next();
                return;
            } else {
                console.log("at start");
            }
        }
        // to prevent our idle handler from playing the next track
        this._castState = "";
        this._next();
    }

    updatePresence(presence) {
        if (!this._started) {
            console.log("presence updating, not started?");
            return;
        }

        const elapsed = Date.now() - this._started;
        let started = this._started;

        this.stop();

        // figure out where to continue
        findOffset(elapsed, this._gstream.clone()).then(offset => {
            this._gstreamOffset = offset;
            // this._gstream.setOffset(offset);

            const room = this.state.presence[this.uuid];
            console.log(`updating gmusic presence to ${room}`);
            if (!(room in this.state.casts)) {
                started = undefined;
                console.error(`no cast for room ${room}`);
                return;
            }
            this.cast = this.state.casts[room];
            this._castConnect().then(() => {
                console.log(`connected to cast at ${this.cast}`);
                this._playerSetup(started);
                this._next();

                started = undefined;
            }).catch(err => {
                started = undefined;
                console.error("error connecting to cast", err.message);
            });
        }).catch(err => {
            console.error("unable to find offset", err);
        });
    }

    _next() {
        console.log("go next");

        if (!this._items) {
            this._gstreamOffset = 0;
            console.error("missing items");
            return;
        }
        if (!this._server || !this._player) {
            this._gstreamOffset = 0;
            console.error("missing server or cast");
            return;
        }
        if (this._current >= this._items.length) {
            this._gstreamOffset = 0;
            console.error("at end");
            return;
        }

        const item = this._items[this._current];
        this.state.pm.getStreamUrl(item.storeId, (err, url) => {
            if (err) {
                this._gstreamOffset = 0;
                console.error("unable to fetch stream url");
                return;
            }
            console.log("got stream url");

            this._gstream = new BufferReadStream({ url: url });
            if (this._gstreamOffset > 0) {
                this._gstream.setOffset(this._gstreamOffset);
                this._gstreamOffset = 0;
            }

            const serverAddr = this._server.address();
            const media = {
                contentId: `http://${serverAddr.address}:${serverAddr.port}/file.mp3`,
                contentType: "audio/mp3",
                streamType: "BUFFERED",
                metadata: {
                    type: 0,
                    metadataType: 0,
                    title: item.title
                }
            };

            this._player.load(media, { autoplay: true }).then(status => {
                console.log("media loaded", status);
                console.log("playing", this.playing);
            }).catch(err => {
                console.error("media load error", err);
            });
        });
    }

    _process(results) {
        return new Promise((resolve, reject) => {
            let seen = new Set();
            let remaining = 0;
            let items = [];
            const maybeAdd = (item) => {
                const title = item.title.toLowerCase().replace(/\s+/g,' ');
                if (!seen.has(title)) {
                    items.push(item);
                    seen.add(title);
                }
            };
            const maybeResolve = () => {
                if (!remaining)
                    resolve(items);
            };
            for (let i = 0; i < results.length; ++i) {
                const item = results[i];
                switch (item.type) {
                case "1":
                    maybeAdd(item.track);
                    break;
                case "3":
                    ++remaining;
                    this.state.pm.getAlbum(item.album.albumId, true, (err, album) => {
                        if (album && !err) {
                            for (let i = 0; i < album.tracks.length; ++i) {
                                maybeAdd(album.tracks[i]);
                            }
                        }
                        process.nextTick(() => {
                            --remaining;
                            maybeResolve();
                        });
                    });
                }
            }
            maybeResolve();
        });
    }

    _playerSetup(started) {
        this._player.on("status", status => {
            console.log("player status change", status);
            if (this._castState === "PLAYING" && status.playerState === "IDLE") {
                ++this._current;
                this._next();
            } else if (status.playerState === "PLAYING") {
                // playing, record the current timestamp
                const now = started ? started : Date.now();
                started = undefined;
                this._started = now;
            }
            this._castState = status.playerState;
        });
    }

    _castConnect() {
        return new Promise((resolve, reject) => {
            castIP(this.cast).then(castAddr => {
                //console.log(`will cast to ${castAddr} from ${serverAddr}`);
                const castClient = new Client();
                castClient.connect(castAddr).then(() => {
                    castClient.launch(DefaultMediaReceiver).then(player => {
                        this._cast = castClient;
                        this._player = player;
                        resolve();
                    });
                    castClient.on("error", err => {
                        // throw our client away
                        console.log("cast client error", err.message || err);
                        this._cleanup();
                    });
                }).catch(err => {
                    reject(err);
                });
            }).catch(err => {
                reject(err);
            });
        });
    }

    _cleanup() {
        if (this._player) {
            this._player.removeAllListeners("status");
            this._player.stop();
            this._player = undefined;
        }
        if (this._cast) {
            this._cast.removeAllListeners("error");
            this._cast = undefined;
            this._castState = "";
        }
        this._started = undefined;
    }
}

module.exports = {
    play: function(json, state) {
        if (!("uuid" in json)) {
            console.error("no uuid for play");
            return;
        }
        if (!("query" in json)) {
            console.error("no query for play");
            return;
        }
        if (!(json.uuid in state.presence)) {
            console.error(`uuid ${json.uuid} not known`);
            return;
        }
        const room = state.presence[json.uuid];
        if (!(room in state.casts)) {
            console.error(`no cast for room ${room}`);
            return;
        }
        if (json.uuid in state.playing) {
            console.log(`stopping current play for uuid ${json.uuid}`);
            state.playing[json.uuid].stop();
        }
        const cast = state.casts[room];
        state.playing[json.uuid] = new Play(json.uuid, cast, json.query, state);
        state.playing[json.uuid].play();
    },
    stop: function(json, state) {
        if (!("uuid" in json)) {
            console.error("no uuid for play");
            return;
        }
        if (!(json.uuid in state.playing)) {
            console.error(`no play for uuid ${json.uuid}`);
            return;
        }
        state.playing[json.uuid].stop();
        delete state.playing[json.uuid];
    },
    next: function(json, state) {
        if (!("uuid" in json)) {
            console.error("no uuid for play");
            return;
        }
        if (!(json.uuid in state.playing)) {
            console.error(`no play for uuid ${json.uuid}`);
            return;
        }
        state.playing[json.uuid].next();
    },
    previous: function(json, state) {
        if (!("uuid" in json)) {
            console.error("no uuid for play");
            return;
        }
        if (!(json.uuid in state.playing)) {
            console.error(`no play for uuid ${json.uuid}`);
            return;
        }
        state.playing[json.uuid].previous();
    }
};
