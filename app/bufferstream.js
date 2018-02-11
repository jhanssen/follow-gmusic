/*global process,module,require*/

const { Readable, Writable } = require("stream");
const request = require("request");

class BufferWriteStream extends Writable
{
    constructor(options) {
        super(options);

        this._done = false;
        this._read = [options.readStream];
        this._chunks = [];
    }

    _write(chunk, encoding, done) {
        this._chunks.push(chunk);
        process.nextTick(done);

        for (let i = 0; i < this._read.length; ++i) {
            this._read[i]._process();
        }
    }

    _append(read) {
        this._read.push(read);
    }

    _notifyEnd() {
        this._done = true;
        for (let i = 0; i < this._read.length; ++i) {
            this._read[i]._notifyEnd();
        }
    }
}

class BufferReadStream extends Readable
{
    constructor(options) {
        super(options);

        this._url = options.url;
        this._pendingRead = false;
        this._index = 0;

        if (options.clone)
            return;

        this._write = new BufferWriteStream({ readStream: this });

        request
            .get(this._url)
            .on("error", err => {
                console.error("buffer read stream error", err);
            })
            .on("end", () => {
                this._write._notifyEnd();
            })
            .pipe(this._write);
    }

    clone() {
        let buf = new BufferWriteStream({ url: this._url, clone: true });
        buf._write = this._write;
        buf._write._append(buf);
        return buf;
    }

    setOffset(offset) {
        this._index = offset;
        this._pendingRead = false;
    }

    _notifyEnd() {
        if (this._atEnd()) {
            this.push(null);
        }
    }

    _atEnd() {
        return this._index >= this._write._chunks.length;
    }

    _read(size) {
        if (!this._write) {
            this.push(null);
            return;
        }
        this._pendingRead = true;
        this._process();
    }

    _process() {
        if (!this._pendingRead)
            return;
        while (!this._atEnd()) {
            const chunk = this._write._chunks[this._index++];
            if (!this.push(chunk)) {
                this._pendingRead = false;
                if (this._atEnd() && this._write._done) {
                    this.push(null);
                }
                return;
            }
        }
        if (this._atEnd() && this._write._done) {
            this.push(null);
        }
    }
}

module.exports = {
    BufferReadStream: BufferReadStream
};
