// A stand-in for https://www.youtube.com/iframe_api used by the browser tests, so they run
// offline and on CI servers (where YouTube often refuses to play). It mimics the parts of
// YT.Player that Vinyl uses: loading, cueing, play/pause/seek, time, end of video, playlists.
// Tests can set window.__fakeDur = { videoId: seconds } and window.__fakeSpeed = 4 (faster clock).
(function () {
  var PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  function Player(el, opts) {
    var self = this;
    this.opts = opts || {};
    this.state = -1; this.vid = null; this.pos = 0; this.t0 = 0; this.vol = 100; this.muted = false; this.list = [];
    var node = typeof el === 'string' ? document.getElementById(el) : el;
    var box = document.createElement('div');
    box.className = 'fake-yt';
    if (node) node.replaceWith(box);
    setTimeout(function () { self._emit('onReady'); }, 30);
    this._timer = setInterval(function () { self._tick(); }, 50);
  }
  Player.prototype._emit = function (name, data) {
    var fn = this.opts.events && this.opts.events[name];
    if (fn) fn({ target: this, data: data });
  };
  Player.prototype._set = function (st) { this.state = st; this._emit('onStateChange', st); };
  Player.prototype._speed = function () { return window.__fakeSpeed || 1; };
  Player.prototype._now = function () {
    return this.state === PS.PLAYING ? this.pos + ((performance.now() - this.t0) / 1000) * this._speed() : this.pos;
  };
  Player.prototype._tick = function () {
    if (this.state === PS.PLAYING && this._now() >= this.getDuration()) { this.pos = this.getDuration(); this._set(PS.ENDED); }
  };
  Player.prototype._start = function (id) {
    var self = this;
    this._set(PS.BUFFERING);
    setTimeout(function () { if (self.vid === id && self.state === PS.BUFFERING) { self.t0 = performance.now(); self._set(PS.PLAYING); } }, 120);
  };
  Player.prototype.loadVideoById = function (o) {
    var id = typeof o === 'string' ? o : o.videoId;
    this.vid = id; this.pos = (o && o.startSeconds) || 0;
    this._set(PS.UNSTARTED);
    this._start(id);
  };
  Player.prototype.cueVideoById = function (o) {
    var id = typeof o === 'string' ? o : o.videoId;
    this.vid = id; this.pos = (o && o.startSeconds) || 0;
    this._set(PS.CUED);
  };
  Player.prototype.playVideo = function () {
    if (!this.vid || this.state === PS.PLAYING) return;
    if (this.state === PS.ENDED) this.pos = 0;
    this._start(this.vid);
  };
  Player.prototype.pauseVideo = function () {
    if (this.state === PS.PLAYING) this.pos = this._now();
    if (this.vid) this._set(PS.PAUSED);
  };
  Player.prototype.stopVideo = function () { this.pos = 0; if (this.vid) this._set(PS.CUED); };
  Player.prototype.seekTo = function (s) {
    this.pos = Math.max(0, Math.min(s, this.getDuration()));
    this.t0 = performance.now();
  };
  Player.prototype.getCurrentTime = function () { return Math.min(this._now(), this.getDuration()); };
  Player.prototype.getDuration = function () { return this.vid ? ((window.__fakeDur || {})[this.vid] || 180) : 0; };
  Player.prototype.getPlayerState = function () { return this.state; };
  Player.prototype.getVideoData = function () { return { video_id: this.vid, title: 'Song ' + this.vid, author: 'Fake Artist - Topic' }; };
  Player.prototype.getVideoUrl = function () { return 'https://www.youtube.com/watch?v=' + this.vid; };
  Player.prototype.setVolume = function (v) { this.vol = v; };
  Player.prototype.getVolume = function () { return this.vol; };
  Player.prototype.mute = function () { this.muted = true; };
  Player.prototype.unMute = function () { this.muted = false; };
  Player.prototype.isMuted = function () { return this.muted; };
  Player.prototype.cuePlaylist = function (o) {
    var list = String(o.list || o), ids = [];
    for (var i = 0; i < 5; i++) ids.push((list.replace(/[^\w-]/g, '').slice(-8) + 'pl' + i).padEnd(11, 'x').slice(0, 11));
    var self = this;
    this.list = [];
    this._set(PS.UNSTARTED);
    setTimeout(function () { self.list = ids; self._set(PS.CUED); }, 80);
  };
  Player.prototype.getPlaylist = function () { return this.list; };
  Player.prototype.destroy = function () { clearInterval(this._timer); };

  window.YT = { Player: Player, PlayerState: PS };
  setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 0);
})();
