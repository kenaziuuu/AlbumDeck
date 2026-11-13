/* 大曲库只在变化时传输；进度包使用 ID，在渲染进程内还原引用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function baseOf(s) {
    return { albums: s.albums, folders: s.folders, settings: s.settings, playModes: s.playModes, queueItems: s.queue.items };
  }
  class StatePublisher {
    constructor() { this.seen = new WeakMap(); this.version = 0; this.signature = ''; }
    packet(s, revision, target) {
      if (revision == null || this.revision !== revision || !this.data) {
        const data = baseOf(s), signature = JSON.stringify(data);
        if (signature !== this.signature) { this.signature = signature; this.data = data; this.version++; }
        this.revision = revision;
      }
      const { albums, folders, settings, playModes, queue, current, playing, ...runtime } = s;
      const { album: currentAlbum, track: currentTrack, ...selection } = current;
      const { album: playingAlbum, track: playingTrack, ...progress } = playing;
      const { items, ...queueProgress } = queue;
      const packet = { kind: 'deck-state', ...runtime, dataRevision: revision || 0, version: this.version,
        current: { ...selection, viewAlbumId: currentAlbum && currentAlbum.id },
        playing: { ...progress, albumId: playingAlbum && playingAlbum.id,
          hasTrack: !!playingTrack, track: playingAlbum ? null : playingTrack }, queue: queueProgress };
      if (this.seen.get(target) !== this.version) { packet.data = this.data; this.seen.set(target, this.version); }
      return packet;
    }
  }
  function createDecoder() {
    let base, albumMap, latest, revision = -1;
    const setBase = data => { base = data; albumMap = new Map((data.albums || []).map(a => [a.id, a])); };
    return function decode(packet) {
      const nextRevision = packet.dataRevision || 0;
      if (nextRevision < revision) return latest;
      if (packet.kind !== 'deck-state') {
        setBase(baseOf(packet)); latest = packet; revision = nextRevision;
        return latest;
      }
      // state() 已带来同一版本的数据时，不再重建索引和列表。
      if (packet.data && (!base || nextRevision !== revision)) setBase(packet.data);
      if (!base) return null;
      const { kind, data, version, current, playing, queue, ...runtime } = packet;
      const { viewAlbumId, ...selection } = current;
      const { albumId, hasTrack, track, ...progress } = playing;
      const selected = albumMap.get(viewAlbumId) || null;
      const active = albumMap.get(albumId) || null;
      latest = { ...runtime, ...base, queue: { ...queue, items: base.queueItems },
        current: { ...selection, album: selected, track: selected && selected.tracks[Math.min(selection.trackIndex, selected.tracks.length - 1)] || null },
        playing: { ...progress, album: active, track: active ? (hasTrack && active.tracks[progress.trackIndex] || null) : track } };
      delete latest.queueItems;
      revision = nextRevision;
      return latest;
    };
  }
  return { StatePublisher, createDecoder };
});
