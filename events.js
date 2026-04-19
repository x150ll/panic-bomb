/**
 * PANIC BOMB — events.js
 * Central Event Bus.
 * All inter-module communication goes through here.
 * No module imports another module directly.
 */

const EventBus = (() => {

  // ── Internal registry ──────────────────────────────────────────
  // Map<eventName, Set<{ callback, once }>>
  const _listeners = new Map();

  // ── Debug mode (set to true during development) ────────────────
  let _debug = false;

  // ── Event history (last N events for debugging) ────────────────
  const _history = [];
  const _historyMax = 50;

  // ── Private helpers ────────────────────────────────────────────

  function _ensureKey(eventName) {
    if (!_listeners.has(eventName)) {
      _listeners.set(eventName, new Set());
    }
  }

  function _log(action, eventName, data) {
    if (!_debug) return;
    const entry = { action, eventName, data, ts: Date.now() };
    _history.push(entry);
    if (_history.length > _historyMax) _history.shift();
    console.log(`[EventBus] ${action} → ${eventName}`, data ?? '');
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Register a persistent listener.
   * @param {string}   eventName
   * @param {Function} callback   Called with (data) when event fires.
   * @returns {Function}          Unsubscribe function.
   */
  function on(eventName, callback) {
    if (typeof callback !== 'function') {
      console.warn(`[EventBus] on("${eventName}"): callback must be a function`);
      return () => {};
    }
    _ensureKey(eventName);
    const entry = { callback, once: false };
    _listeners.get(eventName).add(entry);
    _log('SUBSCRIBE', eventName);

    // Return unsubscribe helper
    return () => off(eventName, callback);
  }

  /**
   * Register a one-time listener (auto-removes after first fire).
   * @param {string}   eventName
   * @param {Function} callback
   * @returns {Function}  Unsubscribe function.
   */
  function once(eventName, callback) {
    if (typeof callback !== 'function') {
      console.warn(`[EventBus] once("${eventName}"): callback must be a function`);
      return () => {};
    }
    _ensureKey(eventName);
    const entry = { callback, once: true };
    _listeners.get(eventName).add(entry);
    _log('SUBSCRIBE_ONCE', eventName);
    return () => _listeners.get(eventName)?.delete(entry);
  }

  /**
   * Remove a specific listener.
   * @param {string}   eventName
   * @param {Function} callback  Must be the same reference passed to on().
   */
  function off(eventName, callback) {
    const set = _listeners.get(eventName);
    if (!set) return;
    for (const entry of set) {
      if (entry.callback === callback) {
        set.delete(entry);
        _log('UNSUBSCRIBE', eventName);
        break;
      }
    }
  }

  /**
   * Remove ALL listeners for an event (or all events if no name given).
   * @param {string} [eventName]
   */
  function offAll(eventName) {
    if (eventName) {
      _listeners.delete(eventName);
    } else {
      _listeners.clear();
    }
    _log('CLEAR', eventName ?? 'ALL');
  }

  /**
   * Fire an event synchronously.
   * @param {string} eventName
   * @param {*}      [data]
   */
  function emit(eventName, data) {
    _log('EMIT', eventName, data);

    const set = _listeners.get(eventName);
    if (!set || set.size === 0) return;

    // Snapshot to allow safe mutation during iteration
    const entries = [...set];
    for (const entry of entries) {
      try {
        entry.callback(data);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${eventName}":`, err);
      }
      if (entry.once) {
        set.delete(entry);
      }
    }
  }

  /**
   * Fire an event asynchronously (next microtask).
   * Use for events that should not block the current call stack.
   * @param {string} eventName
   * @param {*}      [data]
   */
  function emitAsync(eventName, data) {
    Promise.resolve().then(() => emit(eventName, data));
  }

  /**
   * Enable / disable debug logging.
   * @param {boolean} enabled
   */
  function setDebug(enabled) {
    _debug = !!enabled;
  }

  /**
   * Return a snapshot of the recent event history.
   * @returns {Array}
   */
  function getHistory() {
    return [..._history];
  }

  /**
   * Return count of registered listeners for an event.
   * @param {string} eventName
   * @returns {number}
   */
  function listenerCount(eventName) {
    return _listeners.get(eventName)?.size ?? 0;
  }

  // ── Public surface ─────────────────────────────────────────────
  return Object.freeze({ on, once, off, offAll, emit, emitAsync, setDebug, getHistory, listenerCount });

})();
window.EventBus = EventBus;
