#!/usr/bin/env node

/*global require,process*/

"use strict";

const mqtt = require("mqtt");
const argv = require("minimist")(process.argv.slice(2));
const ConfigStore = require("configstore");
const PlayMusic = require("playmusic");
const options = require("@jhanssen/options")("gmusic", argv);

const conf = new ConfigStore("follow-gmusic");
const pm = new PlayMusic();

const gmusic = require("./app/gmusic");
const updatePresence = require("./app/update-presence");
const updateDevices = require("./app/update-devices");

const state = {
    pm: pm,
    conf: conf,
    options: options,
    playing: {},
    presence: {},
    casts: {}
};

function login()
{
    return new Promise((resolve, reject) => {
        if (!("gmusic-username" in argv)) {
            reject("no gmusic-username");
            return;
        }
        if (!("gmusic-password" in argv)) {
            reject("no gmusic-password");
            return;
        }
        pm.login({ email: argv["gmusic-username"], password: argv["gmusic-password"] }, (err, resp) => {
            if (err) {
                reject(err.message);
                return;
            }
            conf.set("androidId", resp.androidId);
            conf.set("masterToken", resp.masterToken);
            resolve("ok");
        });
    });
}

function start()
{
    const url = options("url");
    const opts = options.json("options", {});
    const addOption = name => {
        const v = options(name);
        if (v)
            opts[name] = v;
    };
    addOption("username");
    addOption("password");
    if (!url) {
        console.error("need a mqtt url");
        return;
    }

    const client = mqtt.connect(url, opts);

    state.client = client;

    client.once("connect", function () {
        console.log("mqtt connected");
        client.subscribe("follow/gmusic");
        client.subscribe("follow/presence");
        client.subscribe("follow/devices");
        client.publish("follow/presence/command", '{"command": "request"}');
        client.publish("follow/devices/command", '{"command": "request"}');
    });
    client.once("close", () => {
        console.log("mqtt closed");
        client.end();
    });
    client.on("error", err => {
        console.log("mqtt error", err.message);
        client.end();
    });

    client.on("message", (topic, message) => {
        let json;
        try {
            json = JSON.parse(message);
        } catch (e) {
            return;
        }
        switch (topic) {
        case "follow/gmusic":
            if (!("command" in json))
                return;
            if (json.command in gmusic) {
                const func = gmusic[json.command];
                if (typeof func === "function") {
                    func.call(gmusic, json, state);
                }
            }
            break;
        case "follow/presence":
            updatePresence(json, state);
            break;
        case "follow/devices":
            updateDevices(json, state);
            break;
        }
    });
}

if ("login" in argv) {
    login().then(ret => {
        console.log(ret);
        process.exit(0);
    }).catch(err => {
        console.error(err);
        console.error("Use an application password if two-factor authentication is enabled.");
        process.exit(1);
    });
} else {
    if (!conf.has("androidId") || !conf.has("masterToken")) {
        console.error("please login");
        process.exit(1);
    }
    pm.init({ androidId: conf.get("androidId"), masterToken: conf.get("masterToken") }, err => {
        if (err) {
            console.error("gmusic error initing", err);
            process.exit(1);
        }
        console.log("gmusic initialized");
        start();
    });
}
