/*
  @engine9/core-gauge

  Measurement for engine9: web and app activity as timeline entries, reconciled
  to person_id when known. Standalone: core never imports this package.

  Browser code imports '@engine9/core-gauge/client'; servers that send hits
  import '@engine9/core-gauge/server'. This entry is for the collector, the
  loader and tools.
*/
export { GAUGE_ENTRY_TYPES, REUSED_ENTRY_TYPES, resolveEntryType, DEFAULT_TIMELINE_ENTRY_TYPES, PLATFORMS } from './entryTypes.js';
export { createCollector, serverKeyVerifier, SEND_SCOPE } from './collector.js';
export { createDiskLog, listSegments, readSegment } from './diskLog.js';
export { loadRecords, loadFromDisk, resetFrom, pruneLog } from './loader.js';
export {
  GAUGE_PLUGIN_PATH,
  parseSettings,
  defaultSettings,
  readSettings,
  writeSetting,
  createSettingsSource,
  findGaugePlugin
} from './settings.js';
export { startGauge, openWorker } from './node.js';
export { PROTOCOL_VERSION, LIMITS } from './protocol.js';
